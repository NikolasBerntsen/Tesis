package com.tesis.dronepatrol.patrol

import android.util.Base64
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.AnotadorDeCuadros
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.Georreferencia
import com.tesis.dronepatrol.drone.LimitadorDeRitmo
import com.tesis.dronepatrol.drone.MandoVirtual
import com.tesis.dronepatrol.drone.RastreadorDeObjetivo
import com.tesis.dronepatrol.drone.ZonasDescartadas
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.ObjetivoReportado
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Telemetry
import java.util.UUID
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Máquina de estados del patrullaje. Toda la lógica de la entrega vive acá:
 *
 *   IDLE → PATROLLING → (detección) → ORBITING ⇄ FOLLOWING → (decisión/reanudar) → PATROLLING
 *                     → (señal perdida) → RETURNING_HOME_SIGNAL → (señal vuelve) → PATROLLING
 *                     → (batería baja)  → RETURNING_HOME_BATTERY → LANDED
 *
 * El seguimiento de un objetivo (docs/PROTOCOLS.md §4, "Qué hace la app con
 * una detección") vive entre ORBITING —el objetivo está quieto y el dron lo
 * orbita— y FOLLOWING —se mueve y el dron lo sigue—; el operador puede tomar el
 * control en el medio (MANUAL) y al soltarlo el dron vuelve al objetivo.
 */
class PatrolManager(
    private val controller: DroneController,
    private val commandCenter: CommandCenterClient,
    private val detection: DetectionClient,
    private val scope: CoroutineScope,
    /** Modo elegido tras iniciar sesión: "TEST" o "DEPLOY" (viaja en cada status). */
    private val mode: String,
    /**
     * Reloj del seguimiento del objetivo. Es un parámetro para que el banco de
     * pruebas pueda adelantarlo: "se perdió hace 10 s" o "se detuvo hace 6 s"
     * no se prueban durmiendo el test.
     */
    private val reloj: () -> Long = System::currentTimeMillis,
) {
    // internal y no private: el banco de pruebas necesita los límites exactos
    // —el del watchdog del mando, el del reparto de cuadros y el de la repetición
    // de un aviso—, que adentro de un lazo con reloj propio no hay forma de
    // pararse a mirar.
    internal companion object {
        // Sin telemetría durante este tiempo => consideramos perdido el enlace RC
        const val SIGNAL_TIMEOUT_MS = 4_000L
        // Umbral de batería para ordenar el regreso a base
        const val LOW_BATTERY_PCT = 25.0
        const val ORBIT_RADIUS_M = 30.0
        const val METERS_PER_DEG_LAT = 111_320.0

        /**
         * Cuánto siguen dibujándose las cajas de la última detección sobre el
         * video de la consola. El detector contesta cada 500 ms como mucho; con
         * esto las cajas no parpadean entre una respuesta y la siguiente, y
         * desaparecen solas cuando el detector deja de ver algo.
         */
        const val VIGENCIA_CAJAS_MS = 1_500L
        // Techo del flujo hacia el software de detección: uno cada tanto, o sea
        // dos por segundo como máximo (contrato §1). Al Comando Central le va
        // todo lo que emite el controlador (ver repartirVideo(), que explica por
        // qué el techo se mide con reloj y no contando cuadros).
        const val INTERVALO_DETECCION_MS = 500L
        // Estando en MANUAL, sin órdenes de mando por más de este tiempo la app
        // manda ceros por su cuenta (ver mandoWatchdog()).
        const val MANDO_TIMEOUT_MS = 1_500L
        const val REVISION_MANDO_MS = 250L

        /**
         * Rango de la inclinación de la cámara que acepta `manual_gimbal`
         * (docs/PROTOCOLS.md §3.b): del nadir a un poco por arriba del horizonte.
         * El hub ya la recorta; se vuelve a recortar acá porque es la app la que
         * le habla al gimbal y no puede depender de que cada hub lo haga.
         */
        const val INCLINACION_MINIMA = -90.0
        const val INCLINACION_MAXIMA = 30.0

        /**
         * Cada cuánto, como mucho, se vuelve a avisar un problema del dron que
         * sigue siendo el MISMO (ver hayQueAvisarElProblema()).
         */
        const val REPETIR_PROBLEMA_MS = 60_000L

        /**
         * Cuántos avisos, como mucho, pueden salir dentro de una misma ventana de
         * [REPETIR_PROBLEMA_MS] (ver hayQueAvisarElProblema()). Es el techo que
         * sostiene el filtro cuando los motivos ALTERNAN en vez de repetirse, que
         * es por donde se colaba la inundación: deduplicar por igualdad de motivo
         * no alcanza porque el motivo lleva adentro la descripción del error del
         * SDK, y esa no es una sola.
         */
        const val MAX_PROBLEMAS_POR_VENTANA = 5

        /**
         * Confirmación antes de alertar: una segunda detección de la misma clase
         * dentro de esta ventana y a menos de esta distancia de la primera. Un
         * solo cuadro no alerta: el detector se equivoca de a un cuadro (una
         * sombra, un reflejo) mucho más que de a dos seguidos.
         */
        const val CONFIRMACION_VENTANA_MS = 2_500L
        const val CONFIRMACION_DISTANCIA_M = 25.0

        /** Después de retomar la ruta por un descarte, este tiempo sin alertar. */
        const val SILENCIO_TRAS_DESCARTE_MS = 10_000L

        /**
         * Por debajo de esta altura no se orbita ni se sigue al objetivo: la
         * proyección al terreno no sirve y una órbita de 30 m a ras del suelo es
         * meterse entre los árboles. Se alerta igual, sin seguimiento.
         */
        const val ALTURA_MINIMA_PARA_ALERTAR_M = 8.0

        /**
         * Entre dos alertas SIN seguimiento (dron en el suelo, a baja altura o
         * sin GPS), al menos esto: sin seguimiento no hay "objetivo en curso"
         * que impida volver a alertar por lo mismo, y con el dron quieto el
         * detector ve lo mismo dos veces por segundo.
         */
        const val ENTRE_ALERTAS_SIN_SEGUIMIENTO_MS = 60_000L

        /**
         * Estados desde los que una detección arranca el seguimiento del
         * objetivo (con el dron en el aire, a la altura de trabajo y con GPS). En
         * MANUAL el seguimiento arranca pero el dron no se mueve solo: sigue
         * siendo del operador, y al soltarlo va al objetivo.
         */
        val ESTADOS_QUE_SIGUEN = setOf(PatrolState.PATROLLING, PatrolState.PAUSED, PatrolState.FORCED, PatrolState.MANUAL)

        /**
         * Volviendo a base (por batería, señal u orden) no se alerta: el dron no
         * puede quedarse, y la alerta pediría algo que no va a hacer.
         */
        val ESTADOS_SIN_ALERTAS = setOf(
            PatrolState.RETURNING_HOME,
            PatrolState.RETURNING_HOME_BATTERY,
            PatrolState.RETURNING_HOME_SIGNAL,
        )

        /** Si la estimación del objetivo quieto se corre más que esto, la órbita la acompaña. */
        const val DERIVA_DE_ORBITA_M = 6.0

        /** Cuánta telemetría se guarda para buscar la pose del instante de cada cuadro. */
        const val HISTORIA_DE_POSES_MS = 3_000L

        /** Cada cuánto se reevalúa el seguimiento aunque no lleguen detecciones (para notar que se perdió). */
        const val INTERVALO_SEGUIMIENTO_MS = 500L

        // PAUSED/MANUAL/FORCED también son vuelo: batería baja y pérdida de
        // señal disparan el RTH igual que patrullando
        val ESTADOS_EN_VUELO = setOf(
            PatrolState.PATROLLING,
            PatrolState.ORBITING,
            PatrolState.FOLLOWING,
            PatrolState.PAUSED,
            PatrolState.MANUAL,
            PatrolState.FORCED,
        )
        // Estados desde los que un resume_patrol retoma la ruta activa
        val ESTADOS_REANUDABLES = setOf(
            PatrolState.ORBITING,
            PatrolState.FOLLOWING,
            PatrolState.RETURNING_HOME_SIGNAL,
            PatrolState.PAUSED,
            PatrolState.MANUAL,
            PatrolState.FORCED,
        )

        /** Los dos estados en los que el dron está ocupándose del objetivo por su cuenta. */
        val ESTADOS_DE_SEGUIMIENTO = setOf(PatrolState.ORBITING, PatrolState.FOLLOWING)

        /**
         * Decide si el watchdog del mando tiene que mandar ceros. Es una función
         * aparte, sin reloj propio, para poder probar el límite exacto de los
         * [MANDO_TIMEOUT_MS]: adentro del lazo el tiempo lo pone
         * System.currentTimeMillis() y no hay forma de pararse en el borde.
         *
         * [ultimoMandoMs] en 0 significa "todavía no llegó ningún mando desde
         * que se tomó el control": no hay velocidad que cortar, y sin esta
         * guarda la resta contra el epoch daría un número enorme y el watchdog
         * saltaría de prepo apenas alguien toma el control. Y si el último mando
         * ya dejaba al dron quieto ([estacionario]) tampoco hay nada que
         * corregir.
         */
        internal fun hayQueCortarElMando(ahoraMs: Long, ultimoMandoMs: Long, estacionario: Boolean): Boolean {
            if (ultimoMandoMs == 0L || estacionario) return false
            return ahoraMs - ultimoMandoMs > MANDO_TIMEOUT_MS
        }

        /**
         * Decide si un problema del dron se reporta al Comando Central. El aviso
         * es por TRANSICIÓN —cuando cambia el motivo— y no por intento: el
         * controlador reintenta habilitar el mando virtual en cada vuelta de su
         * lazo de comandos (10 Hz), así que el MISMO rechazo llega diez veces por
         * segundo, y cada reporte es una fila en la tabla `events` del Comando
         * Central más un broadcast a cada consola abierta. El propio contrato lo
         * prohíbe: a 10 Hz inunda el registro y tapa todo lo demás, justo cuando
         * hay un problema real que mirar.
         *
         * Un problema que sigue ahí igual no puede quedar mudo para siempre, así
         * que el mismo motivo se repite a lo sumo cada [REPETIR_PROBLEMA_MS].
         *
         * Va aparte y sin reloj propio, como [hayQueCortarElMando], para poder
         * probar el borde exacto sin dormir el test.
         */
        internal fun hayQueAvisarElProblema(
            motivo: String,
            ultimoMotivo: String?,
            ahoraMs: Long,
            ultimoAvisoMs: Long,
            avisosEnLaVentana: Int,
        ): Boolean {
            // Un transcurrido negativo es el reloj del celular acomodándose hacia
            // atrás (NTP, cambio de hora): se avisa y se vuelve a anclar, igual
            // que en LimitadorDeRitmo, en vez de quedar mudo hasta que el reloj
            // recupere la diferencia. Y el primer aviso de todos entra por acá:
            // sin avisos previos el transcurrido es el reloj entero.
            val transcurrido = ahoraMs - ultimoAvisoMs
            if (transcurrido !in 0 until REPETIR_PROBLEMA_MS) return true
            // El mismo motivo no vuelve hasta cumplido el minuto: el controlador
            // reintenta en cada vuelta de su lazo de 10 Hz y el rechazo idéntico
            // llega diez veces por segundo.
            if (motivo == ultimoMotivo) return false
            // Un problema NUEVO avisa enseguida —esperar sería tragarse justo la
            // novedad que importa— pero contra un presupuesto por ventana: si la
            // aeronave alterna entre dos rechazos, ninguno es igual al anterior y
            // sin el presupuesto los dos atravesarían el filtro a 10 Hz.
            return avisosEnLaVentana < MAX_PROBLEMAS_POR_VENTANA
        }
    }

    private val _state = MutableStateFlow(PatrolState.IDLE)
    val state: StateFlow<PatrolState> = _state

    private val _signalOk = MutableStateFlow(true)
    val signalOk: StateFlow<Boolean> = _signalOk

    /** Intensidad del enlace RC 0..100; 0 mientras la señal está perdida. */
    private val _signalPct = MutableStateFlow(100)
    val signalPct: StateFlow<Int> = _signalPct

    private val _localLog = MutableSharedFlow<String>(replay = 20, extraBufferCapacity = 16)
    val localLog: SharedFlow<String> = _localLog

    /**
     * Las cajas de la última detección, para dibujarlas sobre el video: en la
     * consola (ver [repartirVideo]) y en la pantalla de la app. Vacías cuando
     * pasó su vigencia.
     */
    private val _cajasRecientes = MutableStateFlow<List<Caja>>(emptyList())
    val cajasRecientes: StateFlow<List<Caja>> = _cajasRecientes

    @Volatile
    private var cajasHastaMs = 0L

    /** Rutas descargadas del Comando Central (para resolver start_route/force_goto por id). */
    var availableRoutes: List<PatrolRoute> = emptyList()

    private var route: PatrolRoute? = null

    /** Hay una ruta cargada a la que volver con "Reanudar". */
    val tieneRuta: Boolean get() = route != null
    private var lastReachedWaypoint = 0

    /**
     * El nodo HACIA el que vuela la ruta: el próximo, no el último alcanzado.
     * Es al que se vuelve al retomar después de una alerta descartada, de un
     * control manual o de una pérdida de señal: retomar desde el último
     * ALCANZADO hacía que el dron diera la vuelta y repitiera el tramo entero.
     */
    private var proximoWaypoint = 0
    private var resumeWaypoint = 0
    /** Nodo del desvío forzado en curso (solo para el mensaje de llegada). */
    private var forcedIndex = 0
    private var lastTelemetry: Telemetry? = null
    private var lastTelemetryAt = 0L
    private var lastFrame: ByteArray? = null

    /**
     * Los últimos segundos de telemetría, para georreferenciar cada detección
     * con la pose del dron en el instante de SU cuadro (`frameTs`): la
     * respuesta llega de 0,3 a 1 s después, con el dron ya movido y girado.
     */
    private val poses = ArrayDeque<Telemetry>()

    /**
     * El objetivo en seguimiento: existe desde la detección que disparó la
     * alerta hasta que el seguimiento termina (ver [terminarSeguimiento]).
     */
    private class Seguimiento(
        val rastreador: RastreadorDeObjetivo,
        /** El `ref` del alert_request: con él se reconoce el alert_ack de ESTA alerta. */
        val ref: String,
        /** Dónde se lo detectó primero: también se marca como zona descartada si es un falso positivo. */
        val origenLat: Double,
        val origenLon: Double,
    ) {
        /** Id de la alerta, cuando llega el alert_ack. */
        var alertId: Long? = null
        var decision = "PENDING"
        /** Ya se avisó TARGET_LOST y no se volvió a ver. */
        var perdidoAvisado = false
        /** Centro de la órbita que se le pidió al dron por última vez. */
        var centroLat = origenLat
        var centroLon = origenLon
    }

    private var seguimiento: Seguimiento? = null

    /** El objetivo en seguimiento tal como va en el status; null si no hay. */
    val objetivo: ObjetivoReportado? get() = seguimiento?.let(::reportarObjetivo)

    /** Primera detección de un objetivo posible, a la espera de su confirmación. */
    private class Candidato(val clase: String, val lat: Double, val lon: Double, val ms: Long)

    private var candidato: Candidato? = null

    private val zonasDescartadas = ZonasDescartadas()

    /** Hasta cuándo no se alerta, después de retomar la ruta por un descarte. */
    private var silencioHastaMs = 0L

    /** Cuándo salió la última alerta sin seguimiento (ver [ENTRE_ALERTAS_SIN_SEGUIMIENTO_MS]). */
    private var ultimaAlertaSinSeguimientoMs = Long.MIN_VALUE / 2

    /**
     * false desde que empieza un despegue hasta que el dron llega a la altura de
     * trabajo: en ese lapso el detector ve al equipo de tierra al lado del dron
     * y una alerta haría orbitarlos a pocos metros de altura.
     */
    @Volatile
    private var enAlturaDeTrabajo = true

    /**
     * Momento del último `manual_stick`; 0 = ninguno desde que se tomó el
     * control. Lo escribe el hilo del WebSocket y lo lee el watchdog del mando,
     * que corre en otra corrutina: de ahí el volátil. Ojo: el volátil solo evita
     * que el valor quede pegado en un núcleo; lo que hace segura la marca contra
     * las transiciones es [cerrojoDelMando].
     */
    @Volatile
    private var ultimoMandoMs = 0L

    /** Si el último mando recibido ya dejaba al dron quieto, no hay nada que cortar. */
    @Volatile
    private var ultimoMandoEstacionario = true

    /**
     * true desde que el operador toma el control manual hasta que lo suelta,
     * pase lo que pase con el estado en el medio. Es lo que arma el watchdog del
     * mando: atarlo a `_state == MANUAL` lo apagaba justo en la transición que
     * lo necesita (ver mandoWatchdog()).
     *
     * Lo escriben el hilo del WebSocket y las corrutinas de los watchdogs: de
     * ahí el volátil.
     */
    @Volatile
    private var controlTomado = false

    /**
     * true mientras corre un desplazamiento puntual pedido con `manual_move`.
     * Se apaga sola al llegar (FlightEvent.GotoArrived) y la usa onManualStick()
     * para no dejar que el mensaje de cierre de la palanca aborte el salto.
     */
    @Volatile
    private var saltoManualEnCurso = false

    /**
     * Serializa las tres cosas que deciden sobre el mando manual: [onManualStick],
     * [pasarA] y el corte de [mandoWatchdog]. Hace falta porque `onManualStick`
     * corre en el hilo lector de OkHttp —llegan diez por segundo y no se abre una
     * corrutina por mensaje— mientras las transiciones corren en corrutinas, y
     * los `@Volatile` sueltos no dan exclusión entre "leo el estado" y "escribo
     * las marcas y le hablo al dron".
     *
     * Lo que arreglaba: con la batería al 25 % y el operador sosteniendo la
     * palanca, un mando que ya había pasado la puerta del estado le llegaba al
     * controlador DESPUÉS del regreso a base y se lo relevaba (en el DJI,
     * `manualStick` cancela el lazo de navegación), con el dron yéndose a 5 m/s.
     * Al revés, las marcas escritas después de que [pasarA] las limpió dejaban al
     * watchdog cortándole el regreso un segundo y medio más tarde.
     *
     * De acá sale la invariante que hace segura la red de seguridad: las marcas
     * del mando solo pueden quedar escritas con el estado en MANUAL (ver
     * [mandoWatchdog]).
     *
     * Las órdenes al dron que NO son del mando se mandan con el cerrojo ya
     * soltado: para esas alcanza con que el estado esté pisado, que es la puerta
     * que mira [onManualStick].
     */
    private val cerrojoDelMando = Any()

    /**
     * Último motivo de problema reportado y cuándo (ver [hayQueAvisarElProblema]).
     * Sin volátil ni cerrojo a propósito: los toca solo [onFlightEvent], que corre
     * en la única corrutina que colecta `controller.flightEvents`.
     */
    private var ultimoProblemaAvisado: String? = null
    private var ultimoProblemaAvisadoMs = 0L

    /**
     * Avisos que ya salieron dentro de la ventana en curso. Se pone en cero cuando
     * arranca una ventana nueva, que es cada vez que se avisa después de un
     * silencio de [REPETIR_PROBLEMA_MS] (ver [hayQueAvisarElProblema]).
     */
    private var problemasEnLaVentana = 0

    private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch { controller.telemetry.collect { onTelemetry(it) } }
        scope.launch { controller.flightEvents.collect { onFlightEvent(it) } }
        // Los dos destinos van por nombre: si alguna vez se dan vuelta, el
        // cambio se ve acá y no queda escondido adentro del reparto.
        scope.launch {
            repartirVideo(
                alComandoCentral = { cuadro -> commandCenter.sendVideoFrame(cuadro) },
                aLaDeteccion = { cuadro -> detection.sendFrame(cuadro) },
            )
        }
        detection.onDetection = { deteccion -> scope.launch { onDetection(deteccion) } }
        commandCenter.onAlertDecision = { alertId, decision, decidedBy, reenvio ->
            scope.launch { onAlertDecision(alertId, decision, decidedBy, reenvio) }
        }
        commandCenter.onAlertAck = { ref, alertId -> scope.launch { onAlertAck(ref, alertId) } }
        commandCenter.onTakeoff = { by -> scope.launch { onTakeoff(by) } }
        commandCenter.onLand = { by -> scope.launch { onLand(by) } }
        commandCenter.onResumePatrol = { fromIndex ->
            scope.launch { resumePatrol("orden del operador", fromIndex) }
        }
        commandCenter.onStartRoute = { routeId, fromIndex, orderedBy ->
            scope.launch { onStartRoute(routeId, fromIndex, orderedBy) }
        }
        commandCenter.onStopPatrol = { orderedBy -> scope.launch { onStopPatrol(orderedBy) } }
        commandCenter.onForceGoto = { routeId, index, orderedBy ->
            scope.launch { onForceGoto(routeId, index, orderedBy) }
        }
        commandCenter.onControlTaken = { by -> scope.launch { onControlTaken(by) } }
        commandCenter.onManualMove = { bearing, distanceM, by ->
            scope.launch { onManualMove(bearing, distanceM, by) }
        }
        // A diferencia del resto de las órdenes, esta no se lanza en una
        // corrutina: llegan diez por segundo y no hace nada que pueda bloquear,
        // así que abrir una corrutina por mensaje sería puro costo.
        commandCenter.onManualStick = { pitch, roll, yaw, throttle, _ ->
            onManualStick(pitch, roll, yaw, throttle)
        }
        // Igual que el mando y por lo mismo: hasta diez por segundo mientras el
        // operador arrastra la cámara. Además, en el mismo hilo lector del socket
        // llegan en orden, y con una corrutina por mensaje la inclinación vieja
        // podría pisar a la nueva.
        commandCenter.onManualGimbal = { pitch, _ -> onManualGimbal(pitch) }
        commandCenter.onControlReleased = { by -> scope.launch { onControlReleased(by) } }
        scope.launch { signalWatchdog() }
        scope.launch { mandoWatchdog() }
        scope.launch { statusTicker() }
        scope.launch { seguimientoTicker() }
    }

    /**
     * Reparto del video. Son dos flujos distintos del controlador, con destinos
     * distintos:
     *
     *  - [DroneController.videoFrames] va ENTERO al Comando Central —5 por
     *    segundo a 640 px, tanto con el dron real como con el simulado
     *    ([com.tesis.dronepatrol.drone.CuadroDeVideo.INTERVALO_CUADRO_MS])—: es
     *    el video que mira el operador y con el que decide, y de acá sale la
     *    captura que se adjunta a cada alerta.
     *  - [DroneController.cuadrosParaDeteccion] va al software de detección: más
     *    grande (1280 px, porque desde 50 m una persona a 640 px son diez
     *    pixeles) y con un techo de uno cada [INTERVALO_DETECCION_MS] —**dos por
     *    segundo**, lo que fija el contrato §1—: el enlace con la laptop es el
     *    más flojo de los tres y detectar no necesita más.
     *
     * El techo se vuelve a medir acá con RELOJ aunque el controlador ya emita
     * raleado: es la garantía del contrato y no puede depender de que cada
     * controlador la cumpla. Si mañana uno emitiera el doble, la detección NO
     * recibe el doble.
     *
     * Los dos destinos llegan por parámetro para poder probar el reparto sin
     * sockets: quién recibe qué es justamente lo que hay que verificar. El reloj
     * también, para medir el techo sin dormir el test.
     */
    internal suspend fun repartirVideo(
        alComandoCentral: (String) -> Unit,
        aLaDeteccion: (String) -> Unit,
        ahoraMs: () -> Long = System::currentTimeMillis,
    ) = coroutineScope {
        launch {
            controller.videoFrames.collect { frame ->
                lastFrame = frame
                // Mientras el detector ve algo, la consola lo ve marcado: es la
                // anotación en vivo de lo que disparó (o va a disparar) la alerta.
                val cajas = cajasVigentes(ahoraMs())
                // Decodificar, dibujar, recomprimir y pasar a base64 cinco veces
                // por segundo no va en el hilo principal: por ahí entran los
                // avisos del SDK de DJI (posición, rumbo) y atrasarlos es
                // georreferenciar con una pose vieja.
                val base64 = withContext(Dispatchers.Default) {
                    val cuadro = if (cajas.isEmpty()) frame else AnotadorDeCuadros.anotar(frame, cajas)
                    Base64.encodeToString(cuadro, Base64.NO_WRAP)
                }
                alComandoCentral(base64)
            }
        }
        launch {
            val techoDeLaDeteccion = LimitadorDeRitmo(INTERVALO_DETECCION_MS)
            controller.cuadrosParaDeteccion.collect { frame ->
                if (techoDeLaDeteccion.aceptar(ahoraMs())) {
                    aLaDeteccion(withContext(Dispatchers.Default) { Base64.encodeToString(frame, Base64.NO_WRAP) })
                }
            }
        }
    }

    fun startPatrol(route: PatrolRoute) {
        // En el suelo, el controlador despega solo (ver DroneController.startRoute),
        // pero solo si el dron está en condiciones: sin GPS o sin punto de retorno
        // un despegue automático es un dron que no sabe volver.
        val dron = controller.estado.value
        if (!dron.enVuelo && !dron.listoParaDespegar) {
            report("DRONE_PROBLEM", "No se puede despegar: ${dron.detalle.ifBlank { "el dron no está listo" }}")
            return
        }
        terminarSeguimiento("empezó otro patrullaje")
        this.route = route
        lastReachedWaypoint = 0
        proximoWaypoint = 0
        resumeWaypoint = 0
        // Primero el estado y después la orden, como manda pasarA(): si no, un
        // mando que viene en camino se cuela entre las dos, pasa la puerta de
        // onManualStick() y le releva el lazo de la ruta recién ordenada.
        pasarA(PatrolState.PATROLLING)
        controller.startRoute(route, 0)
        report("PATROL_STARTED", "Patrullaje iniciado en ruta \"${route.name}\"")
    }

    // ---- Órdenes del operador de campo, desde la propia app ----
    // Son las mismas que manda el Comando Central, pero desde el teléfono que
    // está al lado del dron: en el campo hay que poder frenarlo sin pedirle a
    // nadie en la consola que lo haga.

    /** Interrumpe el patrullaje: el dron queda en vuelo estacionario. */
    fun detenerPatrullaje() = onStopPatrol("el operador de campo")

    /** Retoma la ruta desde el último nodo alcanzado. */
    fun reanudarPatrullaje() {
        scope.launch { resumePatrol("orden del operador de campo") }
    }

    /**
     * Regreso a base ordenado desde el campo. Pisa cualquier otra orden, incluido
     * el control manual de la consola: el que está al lado del dron manda.
     */
    fun volverABase() {
        if (!controller.estado.value.enVuelo) {
            log("El dron está en el suelo: no hay a dónde volver")
            return
        }
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
        controlTomado = false
        terminarSeguimiento("el operador de campo ordenó volver a la base")
        // Sin frenar: el regreso a base es la orden que manda (ver checkLowBattery()).
        pasarA(PatrolState.RETURNING_HOME)
        controller.returnHome()
        report("RTH_MANUAL", "El operador de campo ordenó volver a la base")
    }

    /** Aterriza donde está. Al tocar el suelo (FlightEvent.Aterrizado) queda en base. */
    fun aterrizar() {
        if (!controller.estado.value.enVuelo) {
            log("El dron ya está en el suelo")
            return
        }
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
        controlTomado = false
        terminarSeguimiento("el operador de campo ordenó aterrizar")
        pasarA(PatrolState.PAUSED)
        controller.land()
        report("LANDING", "El operador de campo ordenó aterrizar: el dron desciende donde está")
    }

    // ---- Órdenes del Comando Central ----

    /** Busca la ruta entre las descargadas; si no está, re-consulta al Comando Central. */
    private suspend fun buscarRuta(routeId: Int): PatrolRoute? {
        availableRoutes.firstOrNull { it.id == routeId }?.let { return it }
        runCatching { commandCenter.fetchRoutes() }.getOrNull()?.let { availableRoutes = it }
        return availableRoutes.firstOrNull { it.id == routeId }
    }

    private suspend fun onStartRoute(routeId: Int, fromIndex: Int, orderedBy: String) {
        val r = buscarRuta(routeId) ?: run {
            log("Se ordenó patrullar la ruta $routeId pero no existe: se ignora")
            return
        }
        val desde = fromIndex.coerceIn(0, r.waypoints.size - 1)
        terminarSeguimiento("se ordenó patrullar otra ruta")
        route = r
        lastReachedWaypoint = desde
        proximoWaypoint = desde
        resumeWaypoint = desde
        // El estado antes que la orden (ver pasarA()): esta transición es
        // alcanzable desde MANUAL —el operador puede pedir otra ruta sin soltar
        // el control— y al revés un mando en camino le relevaba la ruta.
        pasarA(PatrolState.PATROLLING)
        controller.startRoute(r, desde)
        report("PATROL_STARTED", "Patrullaje iniciado en ruta \"${r.name}\" desde el nodo ${desde + 1} (orden de $orderedBy)")
    }

    private fun onStopPatrol(orderedBy: String) {
        if (_state.value !in ESTADOS_EN_VUELO || _state.value == PatrolState.PAUSED) return
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
        terminarSeguimiento("se interrumpió el patrullaje (orden de $orderedBy)")
        // Primero el estado y después la orden, como en pasarA(): si no, un
        // mando que viene en camino se cuela entre las dos y lo vuelve a mover.
        pasarA(PatrolState.PAUSED)
        controller.hold()
        report("PATROL_STOPPED", "Patrullaje interrumpido por $orderedBy: el dron queda en vuelo estacionario")
    }

    private suspend fun onForceGoto(routeId: Int, index: Int, orderedBy: String) {
        val wp = buscarRuta(routeId)?.waypoints?.getOrNull(index) ?: run {
            log("Se ordenó desviar al nodo ${index + 1} de la ruta $routeId pero no existe: se ignora")
            return
        }
        // Ojo: no se pisa resumeWaypoint, así un resume posterior retoma el
        // patrullaje normal hacia el nodo que tenía por delante
        terminarSeguimiento("desvío forzado a un nodo (orden de $orderedBy)")
        forcedIndex = index
        // El estado antes que la orden (ver pasarA()): también se llega acá desde
        // MANUAL, y un mando colado en el medio abandona el desvío recién pedido.
        pasarA(PatrolState.FORCED)
        controller.gotoPoint(wp.lat, wp.lon)
        report("FORCED_GOTO", "Desvío forzado hacia el nodo ${index + 1} (orden de $orderedBy)")
    }

    private fun onControlTaken(by: String) {
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
        // Acá el orden es el inverso del resto de las transiciones a propósito: esta
        // ABRE la puerta del mando en vez de cerrarla, así que el vuelo estacionario
        // tiene que quedar ordenado ANTES, o el primer mando del operador se lo come.
        controller.hold()
        // Arranca sin mando previo: el watchdog no tiene que arrastrar lo que
        // haya quedado de la vez anterior que alguien tomó el control.
        ultimoMandoMs = 0L
        ultimoMandoEstacionario = true
        saltoManualEnCurso = false
        controlTomado = true
        pasarA(PatrolState.MANUAL)
        // Solo log local: el Comando Central ya registra su propio CONTROL_TAKEN
        log("$by tomó el control manual del dron")
    }

    /**
     * Salto puntual de 25 m del pad de la consola. Va adentro de
     * [cerrojoDelMando] y con la marca ANTES de la orden, igual que el resto de
     * los caminos que le hablan al dron: el pad y las palancas viven en el mismo
     * panel de la consola y llegan por hilos distintos —este handler corre en el
     * hilo principal y [onManualStick] en el lector de OkHttp—, así que suelto se
     * perdía una actualización. Un mando que caía entre la orden y la marca
     * dejaba `saltoManualEnCurso` en false, relevaba el salto, y la línea
     * siguiente lo volvía a poner en true con el salto ya relevado. Con esa marca
     * espuria, el mensaje de cierre de la palanca —los cuatro ejes en cero— se
     * descartaba y nunca llegaba al controlador: el dron se quedaba repitiendo la
     * última velocidad a 10 Hz, sin nadie al mando y con el watchdog desarmado,
     * porque la marca decía "estacionario".
     */
    private fun onManualMove(bearing: Double, distanceM: Double, by: String) {
        val t = lastTelemetry ?: return
        // El salto es hacia una coordenada: sin GPS no hay desde dónde medirlo.
        if (!t.tienePosicion) {
            log("Movimiento manual de $by ignorado: el dron no tiene posición GPS")
            return
        }
        val rad = Math.toRadians(bearing)
        val dLat = distanceM * cos(rad) / METERS_PER_DEG_LAT
        val dLon = distanceM * sin(rad) / (METERS_PER_DEG_LAT * cos(Math.toRadians(t.lat)))
        synchronized(cerrojoDelMando) {
            if (_state.value != PatrolState.MANUAL) return
            // Queda marcado hasta que llegue (FlightEvent.GotoArrived): mientras
            // tanto, el mensaje de cierre de la palanca no lo puede abandonar a
            // mitad de camino (ver onManualStick()).
            saltoManualEnCurso = true
            controller.gotoPoint(t.lat + dLat, t.lon + dLon)
        }
        log("Movimiento manual de $by: ${distanceM.toInt()} m con rumbo ${bearing.toInt()}°")
    }

    /**
     * Mando virtual del operador. Solo se aplica en [PatrolState.MANUAL]: en
     * cualquier otro estado el dron está patrullando, orbitando o volviendo a
     * base y nadie tiene el control tomado, así que el mando se descarta.
     *
     * No se registra nada: a diez mensajes por segundo, el log local sería
     * ilegible. Lo que sí queda registrado es tomar y soltar el control.
     *
     * El cuerpo entero va adentro de [cerrojoDelMando]: leer el estado, marcar el
     * mando y comandarle velocidad al dron tienen que ser UN solo paso contra las
     * transiciones, que corren en corrutinas. Suelto, un mando que ya había
     * pasado la puerta le llegaba al controlador después de un regreso a base y
     * se lo relevaba.
     */
    private fun onManualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) {
        synchronized(cerrojoDelMando) {
            if (_state.value != PatrolState.MANUAL) return@synchronized
            // En el suelo el mando no hace nada (el Virtual Stick no despega:
            // para eso está la orden `takeoff`). Se descarta acá, en silencio,
            // y no en el controlador, que lo avisaría como un rechazo: la
            // consola ya muestra "despegalo primero" mirando `flying`.
            if (!controller.estado.value.enVuelo) return@synchronized
            // Se mira el mando ya traducido: una palanca apenas movida cae en la
            // zona muerta y es vuelo estacionario, no una velocidad que cortar.
            val v = MandoVirtual.velocidades(pitch, roll, yaw, throttle)
            ultimoMandoMs = System.currentTimeMillis()
            ultimoMandoEstacionario = v.estacionario
            // Regla: manda el último comando DELIBERADO. Un mensaje con los cuatro
            // ejes en cero es el que la consola manda al SOLTAR la palanca —el
            // cierre del gesto, no una orden de frenar—, así que no puede abortar un
            // `manual_move` que está a mitad de camino: el pad y las palancas viven
            // en el mismo panel de la consola y rozar una palanca dejaba el salto de
            // 25 m tirado en cualquier lado, en silencio. Cualquier eje fuera de la
            // zona muerta, en cambio, es el operador agarrando la palanca a
            // propósito: ahí sí el salto se abandona y manda la palanca.
            if (v.estacionario && saltoManualEnCurso) return@synchronized
            saltoManualEnCurso = false
            controller.manualStick(pitch, roll, yaw, throttle)
        }
    }

    /**
     * Inclinación de la cámara pedida por el titular del control (`manual_gimbal`).
     * Se aplica solo con el control TOMADO y el estado en MANUAL: patrullando,
     * orbitando o siguiendo al objetivo la cámara la apunta la app, y una orden
     * de la consola ahí se la desacomodaría a la detección. El hub ya exige el
     * lock; acá se vuelve a mirar porque el control se puede haber soltado (o el
     * estado salido de MANUAL por batería o señal) con el mensaje en camino.
     *
     * A diferencia del mando, vale también en el suelo: inclinar la cámara no
     * mueve al dron, y es justo lo que el operador quiere probar antes de
     * despegar. No se registra nada, por el mismo motivo que el mando.
     *
     * Va adentro de [cerrojoDelMando] por lo mismo que [onManualStick]: mirar el
     * estado y darle la orden al dron son un solo paso contra las transiciones,
     * así que una inclinación que pasó la puerta le llega al controlador ANTES
     * que la orden del estado siguiente (la ruta, la órbita), que vuelve a
     * apuntar la cámara, y nunca después.
     */
    private fun onManualGimbal(pitch: Double) {
        if (!pitch.isFinite()) return
        val inclinacion = pitch.coerceIn(INCLINACION_MINIMA, INCLINACION_MAXIMA)
        synchronized(cerrojoDelMando) {
            if (!controlTomado || _state.value != PatrolState.MANUAL) return@synchronized
            controller.inclinarCamara(inclinacion)
        }
    }

    /**
     * ÚNICO lugar donde cambia el estado del patrullaje, y por eso el único que
     * puede garantizar que salir de MANUAL suelte el mando. Hace falta porque el
     * dron sostiene la última velocidad comandada hasta que le llegue otra: si el
     * estado se va de MANUAL y nadie le habla al controlador, el dron sigue
     * andando con nadie al mando (y el watchdog sigue armado, listo para cortarle
     * la orden nueva a los 1,5 s). Repartido por cada transición, la próxima que
     * se agregue se iba a olvidar.
     *
     * El estado se pisa ANTES de frenar, nunca después: el estado es la puerta
     * que mira [onManualStick] desde el hilo del WebSocket, y frenar con la
     * puerta abierta deja que un mando en camino vuelva a darle velocidad.
     *
     * [frenar] es para las transiciones que NO le dan otra orden al dron; con una
     * ruta, un desvío o un regreso a base en camino, un vuelo estacionario acá se
     * la comería, así que por defecto no frena. Cuando se pide, frena SIEMPRE y
     * no solo viniendo de MANUAL: el dron sostiene la última velocidad comandada
     * sin importar quién se la dio, y en el DJI el lazo de la ruta o de la órbita
     * sigue vivo mandándole velocidades a 10 Hz hasta que otra orden lo releve.
     * Con el frenar colgado de la salida de MANUAL, perder la señal patrullando
     * dejaba la ruta corriendo mientras el Comando Central mostraba "volviendo a
     * base", y el dron retomaba la marcha en cuanto el enlace se reenganchaba.
     *
     * El estado y las marcas se pisan adentro de [cerrojoDelMando]; el freno se
     * manda con el cerrojo ya soltado, porque para eso alcanza con que la puerta
     * del estado esté cerrada.
     */
    private fun pasarA(nuevo: PatrolState, frenar: Boolean = false) {
        synchronized(cerrojoDelMando) {
            val salimosDeManual = _state.value == PatrolState.MANUAL && nuevo != PatrolState.MANUAL
            _state.value = nuevo
            if (salimosDeManual) {
                ultimoMandoMs = 0L
                ultimoMandoEstacionario = true
                saltoManualEnCurso = false
            }
        }
        if (frenar) controller.hold()
    }

    /**
     * Watchdog del mando manual. El dron sostiene la última velocidad que le
     * mandaron hasta que le llegue otra: si el celular se queda sin internet en
     * medio de un movimiento, el dron seguiría andando con nadie al mando. Por
     * eso, cuando el mando se calla más de [MANDO_TIMEOUT_MS], la app manda los
     * ejes en cero por su cuenta.
     *
     * Vigila mientras el control esté TOMADO y no mientras el estado sea MANUAL.
     * Atarlo al estado apagaba la red de seguridad justo en el momento que la
     * necesita: al perderse la señal el estado pasa a RETURNING_HOME_SIGNAL y el
     * watchdog hacía `continue` para siempre, con el dron todavía comandado a la
     * última velocidad. Toda salida de MANUAL ya suelta el mando por su cuenta
     * —frenando cuando nadie más le habla al dron, o entregándole la orden nueva
     * cuando hay una (ver [pasarA])—; esto cubre el mando que alcanzó a cruzarse
     * con la transición.
     *
     * Que el corte NO pueda caerle encima a un regreso a base —donde el dron
     * tiene su propia orden y un `manualStick(0,0,0,0)` no la frena, se la releva—
     * no lo decide este guard: lo decide [cerrojoDelMando]. Las marcas del mando
     * se escriben con el estado en MANUAL y [pasarA] las limpia al salir, las dos
     * cosas con el cerrojo tomado, así que fuera de MANUAL no hay marca viva y
     * [hayQueCortarElMando] contesta que no. Por eso el corte va adentro del
     * mismo cerrojo que la decisión: entre "hay que cortar" y cortar tampoco
     * puede meterse una transición.
     *
     * Eso cubre las transiciones de estado, pero hay una orden que le da al dron
     * una navegación propia SIN salir de MANUAL: el salto de 25 m del pad. Si el
     * operador lo dispara y suelta la palanca, el mando se calla y el watchdog
     * cortaría —con los ejes en cero— un salto que está a mitad de camino, que es
     * exactamente lo que el criterio del "último comando deliberado" no quiere.
     * Por eso el corte respeta [saltoManualEnCurso]: mientras el salto vive, el
     * dron ya tiene orden y no está corriendo sin nadie al mando. La marca la
     * levanta la llegada (FlightEvent.GotoArrived) o el primer mando deliberado.
     *
     * Queda solo en el registro local y no se reporta como evento: el enlace con
     * el Comando Central es justamente el que se sospecha caído.
     */
    private suspend fun mandoWatchdog() {
        while (true) {
            delay(REVISION_MANDO_MS)
            synchronized(cerrojoDelMando) {
                if (!controlTomado) return@synchronized
                // El salto de 25 m es navegación propia del dron: no hay nadie
                // corriendo sin mando y cortarlo lo abandonaría a mitad de camino.
                if (saltoManualEnCurso) return@synchronized
                if (!hayQueCortarElMando(System.currentTimeMillis(), ultimoMandoMs, ultimoMandoEstacionario)) {
                    return@synchronized
                }
                ultimoMandoMs = 0L
                ultimoMandoEstacionario = true
                saltoManualEnCurso = false
                controller.manualStick(0.0, 0.0, 0.0, 0.0)
                log(
                    "Hace más de ${MANDO_TIMEOUT_MS / 1_000.0} s que no llegan órdenes de mando: " +
                        "el dron queda en vuelo estacionario",
                )
            }
        }
    }

    private fun onControlReleased(by: String) {
        // El guard es el control y ya no el estado: se puede haber salido de
        // MANUAL por pérdida de señal o batería baja con el control todavía
        // tomado, y soltarlo ahí igual tiene que dejar al dron quieto y desarmar
        // el watchdog. Sin control tomado esto no es nuestro: tocar el dron
        // sería pisarle la orden a otro (una patrulla, un regreso a base).
        if (!controlTomado) return
        controlTomado = false
        log("$by liberó el control manual del dron")
        // Si el dron ya salió de MANUAL (pérdida de señal, batería baja) el mando
        // ya quedó soltado ahí y hay otra orden en curso que no se pisa.
        if (_state.value != PatrolState.MANUAL) return
        // En el suelo (aterrizó con el control tomado) no hay órbita posible.
        if (!controller.estado.value.enVuelo) {
            terminarSeguimiento("el dron está en el suelo")
            pasarA(PatrolState.IDLE)
            return
        }
        val s = seguimiento
        // Con un objetivo en seguimiento, el dron vuelve a él: es lo que el
        // operador espera al soltar el control después de mirar de cerca.
        if (s != null) {
            volverAlObjetivo(s, "$by soltó el control: el dron vuelve al objetivo")
            return
        }
        // Si a continuación llega un resume_patrol, ese handler lo pone a patrullar.
        pasarA(PatrolState.PAUSED, frenar = true)
    }

    /**
     * Despegue en el lugar pedido desde la consola. Solo con el control tomado
     * (el hub ya lo exige; acá se vuelve a mirar porque es la app la que
     * enciende los motores) y con el dron en el suelo. No exige GPS: es la
     * prueba de mandos en interior, despegar, girar y aterrizar.
     */
    private fun onTakeoff(by: String) {
        if (!controlTomado || _state.value != PatrolState.MANUAL) {
            log("$by pidió despegar sin el control manual tomado: se ignora")
            return
        }
        val dron = controller.estado.value
        if (dron.enVuelo) {
            log("$by pidió despegar pero el dron ya está en el aire")
            return
        }
        if (!dron.conectado) {
            report("DRONE_PROBLEM", "No se puede despegar: ${dron.detalle.ifBlank { "sin enlace con la aeronave" }}")
            return
        }
        val sinGps = lastTelemetry?.tienePosicion != true
        controller.despegarEnElLugar()
        report(
            "TAKEOFF",
            "Despegue en el lugar ordenado por $by desde el Comando Central: el dron queda suspendido a ~1 m" +
                if (sinGps) " (sin GPS: se sostiene con los sensores de visión)" else "",
        )
    }

    /** Aterrizaje pedido desde la consola por el titular del control. */
    private fun onLand(by: String) {
        if (!controlTomado || _state.value != PatrolState.MANUAL) {
            log("$by pidió aterrizar sin el control manual tomado: se ignora")
            return
        }
        if (!controller.estado.value.enVuelo) {
            log("$by pidió aterrizar pero el dron ya está en el suelo")
            return
        }
        terminarSeguimiento("$by ordenó aterrizar")
        controller.land()
        report("LANDING", "Aterrizaje ordenado por $by desde el Comando Central: el dron desciende donde está")
    }

    // ---- Detección de pérdida de señal ----
    // El enlace dron↔RC se considera perdido cuando la telemetría deja de llegar
    // por más de SIGNAL_TIMEOUT_MS. El dron real inicia su RTH failsafe por su
    // cuenta; acá reflejamos ese estado y avisamos al Comando Central (el celular
    // sigue online: lo que se cortó es el enlace de radio con el dron).
    private suspend fun signalWatchdog() {
        while (true) {
            delay(1_000)
            val flying = _state.value in ESTADOS_EN_VUELO
            val silent = lastTelemetryAt > 0 && System.currentTimeMillis() - lastTelemetryAt > SIGNAL_TIMEOUT_MS
            if (flying && silent) {
                _signalOk.value = false
                _signalPct.value = 0
                if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
                terminarSeguimiento("se perdió la señal con el dron")
                // Frena: acá nadie más le habla al dron. Sin esto quedaba con la
                // última velocidad del operador (hasta 5 m/s) y el lazo de
                // Virtual Stick repitiéndosela a 10 Hz, así que apenas el enlace
                // se reenganchaba retomaba la marcha con nadie al mando.
                pasarA(PatrolState.RETURNING_HOME_SIGNAL, frenar = true)
                report("SIGNAL_LOST", "Se perdió la señal con el dron (sin telemetría hace ${SIGNAL_TIMEOUT_MS / 1000} s)")
                report("RTH_SIGNAL_LOSS", "El dron vuelve a la base por pérdida de señal (failsafe RTH)")
            }
        }
    }

    private suspend fun onTelemetry(t: Telemetry) {
        val recovering = _state.value == PatrolState.RETURNING_HOME_SIGNAL
        lastTelemetry = t
        lastTelemetryAt = System.currentTimeMillis()
        poses.addLast(t)
        while (poses.isNotEmpty() && t.ts - poses.first().ts > HISTORIA_DE_POSES_MS) poses.removeFirst()
        _signalOk.value = true
        _signalPct.value = t.signalPct

        if (recovering) {
            report("SIGNAL_RECOVERED", "Señal con el dron recuperada")
            alRecuperarLaSenial()
            return
        }
        checkLowBattery(t)
    }

    /**
     * Qué hacer cuando vuelve la señal. Tiene tres salidas porque a
     * RETURNING_HOME_SIGNAL se llega desde cualquier estado en vuelo y antes
     * había una sola, la de la ruta: si el dron llegaba ahí SIN ruta cargada
     * —el caso normal de "lo quiero volar a mano", que se toma desde IDLE—,
     * [resumePatrol] se iba en el primer renglón y el estado quedaba clavado en
     * RETURNING_HOME_SIGNAL para siempre, sin un solo camino de vuelta.
     */
    private suspend fun alRecuperarLaSenial() {
        when {
            // El operador nunca soltó el control: sigue siendo suyo. El dron ya
            // quedó estacionario al perderse la señal, así que vuelve a la
            // palanca sin arrancar nada por su cuenta.
            controlTomado -> {
                pasarA(PatrolState.MANUAL)
                report("CONTROL_RESUMED", "Vuelve la señal con el control manual todavía tomado: el dron espera órdenes del operador")
            }
            // Requisito: al recuperar la señal, el patrullaje continúa donde quedó
            route != null -> resumePatrol("señal recuperada")
            // Sin ruta y sin control tomado no hay nada que reanudar: queda en
            // vuelo estacionario y disponible, en vez de clavado.
            else -> {
                pasarA(PatrolState.PAUSED)
                controller.hold()
                report("PATROL_STOPPED", "Señal recuperada sin ruta cargada: el dron queda en vuelo estacionario")
            }
        }
    }

    // ---- Detección de batería baja ----
    // Si la batería cae del umbral en pleno vuelo, se ordena RTH y se avisa al
    // Comando Central. No hay reanudación automática: hace falta cambiar batería.
    private suspend fun checkLowBattery(t: Telemetry) {
        val flying = _state.value in ESTADOS_EN_VUELO
        if (flying && t.batteryPct <= LOW_BATTERY_PCT) {
            terminarSeguimiento("batería al ${t.batteryPct.toInt()}%: el dron vuelve a la base")
            // Sin frenar: el regreso a base de abajo ya es la orden que manda y
            // un vuelo estacionario acá se la comería. Lo que importa es soltar
            // el mando, para que el watchdog no le corte el RTH a los 1,5 s.
            pasarA(PatrolState.RETURNING_HOME_BATTERY)
            controller.returnHome()
            report("RTH_LOW_BATTERY", "Batería al ${t.batteryPct.toInt()}%: el dron vuelve a la base")
        }
    }

    /**
     * Se cambió/recargó la batería. Si el dron había aterrizado por batería baja,
     * vuelve a quedar disponible para arrancar un patrullaje.
     */
    fun onBatteryRecharged() {
        if (_state.value == PatrolState.LANDED) pasarA(PatrolState.IDLE)
        report("BATTERY_RECHARGED", "Batería recargada al 100%: el dron queda listo para volar")
    }

    private suspend fun onFlightEvent(e: FlightEvent) {
        when (e) {
            is FlightEvent.WaypointReached -> {
                lastReachedWaypoint = e.index
                proximoWaypoint = (e.index + 1) % (route?.waypoints?.size ?: 1).coerceAtLeast(1)
            }
            is FlightEvent.ArrivedHome -> when (_state.value) {
                PatrolState.RETURNING_HOME_BATTERY -> {
                    pasarA(PatrolState.LANDED)
                    report("LANDED", "Dron aterrizado en base (batería baja)")
                }
                PatrolState.RETURNING_HOME, PatrolState.RETURNING_HOME_SIGNAL -> {
                    pasarA(PatrolState.IDLE)
                    report("LANDED", "Dron aterrizado en la base")
                }
                else -> Unit
            }
            is FlightEvent.Despegando -> {
                enAlturaDeTrabajo = false
                // El despegue pedido desde la consola ya quedó registrado en onTakeoff().
                if (controlTomado) {
                    log("Despegando en el lugar")
                } else {
                    report("TAKEOFF", "Despegue automático: el dron sube a la altura de trabajo")
                }
            }
            is FlightEvent.EnElAire -> {
                enAlturaDeTrabajo = true
                log(
                    if (controlTomado) {
                        "El dron está en el aire, suspendido: listo para el mando"
                    } else {
                        "Despegue completado: el dron está a la altura de trabajo"
                    },
                )
            }
            is FlightEvent.Aterrizado -> {
                terminarSeguimiento("el dron aterrizó")
                // Con el control tomado sigue siendo del operador, en el suelo:
                // puede volver a despegar sin soltarlo y retomarlo.
                if (controlTomado) {
                    report("LANDED", "Dron aterrizado: el control manual sigue tomado")
                } else {
                    pasarA(PatrolState.IDLE)
                    report("LANDED", "Dron aterrizado por orden del operador de campo")
                }
            }
            is FlightEvent.GotoArrived -> {
                // El salto puntual terminó: desde acá el mando vuelve a mandar
                // sin condiciones (ver onManualStick()).
                saltoManualEnCurso = false
                if (_state.value == PatrolState.FORCED) {
                    report("GOTO_ARRIVED", "El dron llegó al nodo ${forcedIndex + 1} y queda en vuelo estacionario")
                }
            }
            // Un rechazo del dron no puede quedar mudo: el operador mueve la
            // palanca, el dron no se mueve y sin esto no hay ni una pista. Pero
            // se avisa por TRANSICIÓN y no por intento: el controlador reintenta
            // en cada vuelta de su lazo de 10 Hz y el mismo rechazo llegaba diez
            // veces por segundo, cada una una fila en `events` y un broadcast a
            // cada consola (ver hayQueAvisarElProblema()).
            is FlightEvent.Problema -> {
                val ahora = System.currentTimeMillis()
                if (hayQueAvisarElProblema(e.motivo, ultimoProblemaAvisado, ahora, ultimoProblemaAvisadoMs, problemasEnLaVentana)) {
                    // Si el aviso sale después de un silencio de un minuto, empieza
                    // una ventana nueva y el presupuesto vuelve a estar entero.
                    val ventanaNueva = (ahora - ultimoProblemaAvisadoMs) !in 0 until REPETIR_PROBLEMA_MS
                    problemasEnLaVentana = if (ventanaNueva) 1 else problemasEnLaVentana + 1
                    ultimoProblemaAvisado = e.motivo
                    ultimoProblemaAvisadoMs = ahora
                    report("DRONE_PROBLEM", "El dron rechazó una orden: ${e.motivo}")
                }
            }
        }
    }

    /** Las cajas de la última detección si todavía están vigentes; si no, ninguna. */
    internal fun cajasVigentes(ahoraMs: Long): List<Caja> {
        if (ahoraMs > cajasHastaMs) {
            if (_cajasRecientes.value.isNotEmpty()) _cajasRecientes.value = emptyList()
            return emptyList()
        }
        return _cajasRecientes.value
    }

    /**
     * Una detección (docs/PROTOCOLS.md §4, "Qué hace la app con una
     * detección"). Las cajas se guardan para dibujarlas sobre el video venga en
     * el estado que venga —el operador quiere ver marcado lo que el detector ve
     * también mientras orbita—. Después:
     *  - con un objetivo en seguimiento, la detección lo actualiza (si es él);
     *  - si no, una detección CONFIRMADA (dos seguidas) siempre avisa al
     *    Comando Central, salvo despegando o volviendo a base:
     *    - en el aire, a la altura de trabajo y con GPS, arranca el seguimiento
     *      del objetivo (órbita; en MANUAL solo la estimación);
     *    - en el suelo, a baja altura, sin GPS o sin poder ubicar al objetivo
     *      en el terreno (la cámara al horizonte), alerta sin seguimiento, con
     *      un techo de una por minuto.
     */
    private suspend fun onDetection(d: Deteccion) {
        _cajasRecientes.value = d.cajas
        val ahora = reloj()
        cajasHastaMs = ahora + VIGENCIA_CAJAS_MS
        // La pose del instante del cuadro, si el detector la devuelve; si no,
        // la última (con el error de la latencia, como antes).
        val pose = d.frameTs?.let(::poseEn) ?: lastTelemetry ?: return
        val s = seguimiento
        if (s != null) {
            actualizarSeguimiento(s, d, pose, ahora)
            return
        }
        val estado = _state.value
        if (estado in ESTADOS_SIN_ALERTAS) return
        // Despegando, lo que se ve es el equipo de tierra al lado del dron.
        if (!enAlturaDeTrabajo) return
        if (ahora < silencioHastaMs) return
        val mejor = puntosEnElTerreno(d, pose)
            .filter { it.sinPosicion || !zonasDescartadas.contiene(it.lat, it.lon, ahora) }
            .maxByOrNull { it.confianza } ?: return
        // Confirmación: la primera detección queda como candidata y alerta la
        // segunda, si es de la misma clase, llega a tiempo y cae cerca (sin
        // GPS no hay distancia que comparar: basta la clase y el tiempo).
        val c = candidato
        val confirma = c != null && c.clase == mejor.clase && ahora - c.ms <= CONFIRMACION_VENTANA_MS &&
            (c.lat.isNaN() || mejor.sinPosicion || Geo.distanciaM(c.lat, c.lon, mejor.lat, mejor.lon) <= CONFIRMACION_DISTANCIA_M)
        if (!confirma) {
            candidato = Candidato(mejor.clase, mejor.lat, mejor.lon, ahora)
            return
        }
        candidato = null
        val dron = controller.estado.value
        val conSeguimiento = dron.enVuelo && !mejor.sinPosicion && pose.altM >= ALTURA_MINIMA_PARA_ALERTAR_M &&
            estado in ESTADOS_QUE_SIGUEN
        if (conSeguimiento) {
            iniciarSeguimiento(mejor, d, pose, ahora)
        } else {
            alertarSinSeguimiento(mejor, d, pose, ahora, dron.enVuelo)
        }
    }

    /**
     * Una detección confirmada con la que no se puede (o no corresponde) seguir
     * al objetivo: el dron en el suelo, a baja altura, sin GPS o con el objetivo
     * fuera del terreno que la cámara puede ubicar (ver [puntosEnElTerreno]). El
     * Comando Central igual se entera —alerta con la captura y evento en el
     * registro—, que es lo que el operador necesita para decidir; el dron no se
     * mueve.
     */
    private fun alertarSinSeguimiento(p: Punto, d: Deteccion, pose: Telemetry, ahora: Long, enVuelo: Boolean) {
        if (ahora - ultimaAlertaSinSeguimientoMs < ENTRE_ALERTAS_SIN_SEGUIMIENTO_MS) return
        ultimaAlertaSinSeguimientoMs = ahora
        // Sin posición ya no quiere decir sin GPS: también es el objetivo que la
        // cámara ve por arriba de lo que se puede proyectar. La altura va antes
        // porque, por debajo de la de trabajo, es ella la que manda. Lo que queda
        // es un estado que no sigue objetivos (en el aire sin patrullar, por
        // ejemplo al abrir la app con el dron volando), que antes salía como
        // "a baja altura" a 45 m.
        val donde = when {
            !enVuelo -> "con el dron en el suelo"
            !pose.tienePosicion -> "sin GPS"
            pose.altM < ALTURA_MINIMA_PARA_ALERTAR_M -> "a baja altura (${pose.altM.toInt()} m)"
            p.sinPosicion -> "sin poder ubicarlo en el terreno (la cámara mira al horizonte o más arriba)"
            else -> "fuera de un patrullaje"
        }
        report(
            "DETECTION",
            "Detección de ${p.clase} (confianza ${"%.2f".format(p.confianza)}) $donde: se avisa al Comando Central, " +
                "sin seguimiento del objetivo",
            lat = p.lat.takeUnless { it.isNaN() },
            lon = p.lon.takeUnless { it.isNaN() },
        )
        val snapshot = d.snapshotBase64 ?: lastFrame?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
        commandCenter.sendAlertRequest(
            p.clase, p.lat, p.lon, snapshot, p.confianza, d.clases,
            ref = UUID.randomUUID().toString(), droneLat = pose.lat, droneLon = pose.lon, droneAlt = pose.altM,
        )
    }

    /** Un objetivo posible ya ubicado en el terreno; posición en NaN si el dron no tiene GPS. */
    private class Punto(val clase: String, val confianza: Double, val lat: Double, val lon: Double) {
        val sinPosicion: Boolean get() = lat.isNaN() || lon.isNaN()
    }

    /**
     * Cada caja proyectada al terreno con la pose del cuadro. Una caja que no se
     * puede proyectar —el rayo no baja lo suficiente para cortar el suelo, o el
     * dron está a ras del suelo— queda SIN posición (NaN), igual que sin GPS: no
     * se puede ubicar, pero la detección existe igual y se avisa sin seguimiento.
     * Antes se tomaba la posición del dron, que es justo donde el objetivo NO
     * está: con la cámara al horizonte o más arriba (el operador la puede subir
     * con `manual_gimbal`) eso armaba un seguimiento "a 0 m" y, al soltar el
     * control, el dron volvía a su propia posición en vez de ir al objetivo.
     *
     * Sin cajas (el detector de respaldo no las manda) no se sabe en qué parte
     * del cuadro está, y la detección entera cuenta como un punto en la posición
     * del dron: una aproximación gruesa, que vale solo si la cámara mira al
     * terreno de abajo. Si ni el centro del cuadro se puede proyectar (la cámara
     * al horizonte o más arriba, o el dron a ras del suelo), no hay cómo acotar
     * dónde está —con la cámara al horizonte, a cientos de metros— y también
     * queda sin posición.
     */
    private fun puntosEnElTerreno(d: Deteccion, pose: Telemetry): List<Punto> {
        if (!pose.tienePosicion) {
            if (d.cajas.isEmpty()) return listOf(Punto(d.tipoDeAlerta, d.confianza, Double.NaN, Double.NaN))
            return d.cajas.map { Punto(it.clase, it.confianza, Double.NaN, Double.NaN) }
        }
        // Si el dron todavía no informó su gimbal (NaN), se proyecta con la
        // inclinación de patrulla, que es donde la app lo deja: una suposición
        // razonable es mejor que tirar la detección. Al status, en cambio, no
        // se le inventa nada (ver statusTicker()).
        val inclinacion = pose.gimbalPitch.takeUnless { it.isNaN() } ?: Telemetry.GIMBAL_PATRULLA
        fun proyectar(x: Double, y: Double) =
            Georreferencia.proyectar(pose.lat, pose.lon, pose.altM, pose.rumboCamara, inclinacion, x, y)
        if (d.cajas.isEmpty()) {
            val alTerreno = proyectar(0.5, 0.5) != null
            return listOf(
                if (alTerreno) {
                    Punto(d.tipoDeAlerta, d.confianza, pose.lat, pose.lon)
                } else {
                    Punto(d.tipoDeAlerta, d.confianza, Double.NaN, Double.NaN)
                },
            )
        }
        return d.cajas.map { caja ->
            val o = proyectar(caja.x, caja.y)
            Punto(caja.clase, caja.confianza, o?.lat ?: Double.NaN, o?.lon ?: Double.NaN)
        }
    }

    /** La telemetría más cercana en el tiempo a [ms] (ver [poses]). */
    private fun poseEn(ms: Long): Telemetry? = poses.minByOrNull { abs(it.ts - ms) }

    /**
     * Arranca el seguimiento del objetivo [p]: orbitarlo, alertar al Comando
     * Central con la captura anotada y quedar a la espera del alert_ack y de
     * la decisión.
     */
    private fun iniciarSeguimiento(p: Punto, d: Deteccion, pose: Telemetry, ahora: Long) {
        val nuevo = Seguimiento(RastreadorDeObjetivo(p.clase, p.lat, p.lon, ahora), UUID.randomUUID().toString(), p.lat, p.lon)
        seguimiento = nuevo
        val distancia = Geo.distanciaM(pose.lat, pose.lon, p.lat, p.lon)
        val detectado = "Detección de ${p.clase} (confianza ${"%.2f".format(p.confianza)}) a ${distancia.toInt()} m"
        if (_state.value == PatrolState.MANUAL) {
            // El dron es del operador: no se le saca. La app sigue estimando
            // dónde está el objetivo y, al soltar el control, el dron va a él.
            report(
                "TARGET_DETECTED",
                "$detectado durante el control manual: se sigue su posición y al soltar el control el dron va al objetivo",
                lat = p.lat,
                lon = p.lon,
            )
        } else {
            if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
            // El estado antes que la orden, como en el resto de las transiciones
            // (ver pasarA()): desde PAUSED o FORCED también se llega acá.
            pasarA(PatrolState.ORBITING)
            controller.startOrbit(p.lat, p.lon, ORBIT_RADIUS_M)
            report("ORBIT_STARTED", "$detectado: el dron pasa a modo órbita sobre el objetivo", lat = p.lat, lon = p.lon)
        }
        // La captura es el cuadro anotado que disparó la detección; si el
        // detector no lo manda (el mock), el último cuadro que vio la consola.
        val snapshot = d.snapshotBase64 ?: lastFrame?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
        commandCenter.sendAlertRequest(
            p.clase, p.lat, p.lon, snapshot, p.confianza, d.clases,
            ref = nuevo.ref, droneLat = pose.lat, droneLon = pose.lon, droneAlt = pose.altM,
        )
    }

    /**
     * Una detección con un objetivo en seguimiento: si una de sus cajas es él
     * (misma clase, cerca de donde se lo espera), corrige la estimación. Sigue
     * también en MANUAL: el operador vuela y la app no pierde al objetivo.
     */
    private fun actualizarSeguimiento(s: Seguimiento, d: Deteccion, pose: Telemetry, ahora: Long) {
        val candidatos = puntosEnElTerreno(d, pose).filter { it.clase == s.rastreador.clase && !it.sinPosicion }
        val i = s.rastreador.indiceMasCercano(candidatos.map { it.lat to it.lon }, ahora) ?: return
        s.rastreador.actualizar(candidatos[i].lat, candidatos[i].lon, ahora)
        if (s.perdidoAvisado) {
            s.perdidoAvisado = false
            val e = s.rastreador.estimar(ahora)
            report("TARGET_REACQUIRED", "Se volvió a ver al objetivo", s.alertId, e.lat, e.lon)
        }
        evaluarSeguimiento(ahora)
    }

    /**
     * Decide qué hace el dron con el objetivo: seguir orbitándolo, pasar a
     * seguirlo porque se mueve, volver a orbitarlo porque se detuvo, o
     * buscarlo donde se lo vio por última vez. Corre con cada detección y,
     * por si dejan de llegar, cada [INTERVALO_SEGUIMIENTO_MS]. En MANUAL no
     * comanda nada: el dron es del operador.
     */
    private fun evaluarSeguimiento(ahora: Long) {
        val s = seguimiento ?: return
        val estado = _state.value
        if (estado !in ESTADOS_DE_SEGUIMIENTO) return
        val e = s.rastreador.estimar(ahora)
        when {
            e.perdido -> if (!s.perdidoAvisado) {
                s.perdidoAvisado = true
                if (estado == PatrolState.FOLLOWING) pasarA(PatrolState.ORBITING)
                orbitar(s, e.lat, e.lon)
                report(
                    "TARGET_LOST",
                    "Se perdió de vista al objetivo (${s.rastreador.clase}): el dron orbita su última posición " +
                        "conocida, ${coordenadas(e.lat, e.lon)}",
                    s.alertId, e.lat, e.lon,
                )
            }
            estado == PatrolState.ORBITING && e.enMovimiento -> {
                pasarA(PatrolState.FOLLOWING)
                controller.seguirObjetivo(e.lat, e.lon, e.vNorteMs, e.vEsteMs)
                report(
                    "TARGET_MOVING",
                    "El objetivo se mueve (${"%.1f".format(e.velocidadMs)} m/s, rumbo ${e.rumboGrados.toInt()}°): " +
                        "el dron deja la órbita y lo sigue",
                    s.alertId, e.lat, e.lon,
                )
            }
            estado == PatrolState.FOLLOWING && !e.enMovimiento -> {
                pasarA(PatrolState.ORBITING)
                orbitar(s, e.lat, e.lon)
                report("TARGET_STOPPED", "El objetivo se detuvo: el dron vuelve a orbitarlo donde quedó", s.alertId, e.lat, e.lon)
            }
            estado == PatrolState.FOLLOWING -> controller.seguirObjetivo(e.lat, e.lon, e.vNorteMs, e.vEsteMs)
            Geo.distanciaM(s.centroLat, s.centroLon, e.lat, e.lon) > DERIVA_DE_ORBITA_M -> orbitar(s, e.lat, e.lon)
        }
    }

    /** Centra la órbita en (lat, lon); si ya orbitaba, el controlador solo corre el centro. */
    private fun orbitar(s: Seguimiento, lat: Double, lon: Double) {
        s.centroLat = lat
        s.centroLon = lon
        controller.startOrbit(lat, lon, ORBIT_RADIUS_M)
    }

    /** Vuelve al objetivo después de un control manual: orbitarlo o seguirlo, según se mueva. */
    private fun volverAlObjetivo(s: Seguimiento, motivo: String) {
        val e = s.rastreador.estimar(reloj())
        if (e.enMovimiento && !e.perdido) {
            pasarA(PatrolState.FOLLOWING)
            controller.seguirObjetivo(e.lat, e.lon, e.vNorteMs, e.vEsteMs)
        } else {
            pasarA(PatrolState.ORBITING)
            orbitar(s, e.lat, e.lon)
        }
        report("TRACKING_RESUMED", motivo, s.alertId, e.lat, e.lon)
    }

    /**
     * Termina el seguimiento, si había uno, y deja en el registro la última
     * posición estimada del objetivo. No le da ninguna orden al dron: quien lo
     * llama es el que sabe qué sigue (retomar la ruta, volver a base…).
     */
    private fun terminarSeguimiento(motivo: String) {
        val s = seguimiento ?: return
        seguimiento = null
        candidato = null
        val e = s.rastreador.estimar(reloj())
        report(
            "TRACKING_ENDED",
            "Fin del seguimiento del objetivo: $motivo. Última posición estimada: ${coordenadas(e.lat, e.lon)}",
            s.alertId, e.lat, e.lon,
        )
    }

    private suspend fun seguimientoTicker() {
        while (true) {
            delay(INTERVALO_SEGUIMIENTO_MS)
            evaluarSeguimiento(reloj())
        }
    }

    private fun reportarObjetivo(s: Seguimiento): ObjetivoReportado {
        val e = s.rastreador.estimar(reloj())
        return ObjetivoReportado(
            alertId = s.alertId,
            tipo = s.rastreador.clase,
            lat = e.lat,
            lon = e.lon,
            velocidadMs = e.velocidadMs,
            rumboGrados = e.rumboGrados,
            enMovimiento = e.enMovimiento,
            perdido = e.perdido,
            vistoHaceMs = e.vistoHaceMs,
            decision = s.decision,
        )
    }

    private fun coordenadas(lat: Double, lon: Double) = "%.6f, %.6f".format(lat, lon)

    /** El hub registró la alerta: si es la del objetivo en curso, queda asociada. */
    private fun onAlertAck(ref: String, alertId: Long) {
        val s = seguimiento ?: return
        if (s.ref != ref) return
        s.alertId = alertId
        log("La alerta del objetivo quedó registrada como #$alertId")
    }

    /**
     * Decisión del operador. Se aplica solo a la alerta del objetivo en curso:
     * descartar una alerta vieja no puede hacer que el dron abandone el
     * objetivo nuevo. Si la app todavía no conoce el id de su alerta (el ack no
     * llegó), se aplica igual: es la única que puede estar decidiéndose. Salvo
     * que sea un REENVÍO del hub al reconectarse ([reenvio]): esas son
     * decisiones de los últimos minutos, de alertas que pueden ser viejas, y
     * solo se aplican si son exactamente la alerta del objetivo en curso.
     */
    private suspend fun onAlertDecision(alertId: Long?, decision: String, decidedBy: String, reenvio: Boolean = false) {
        val s = seguimiento
        if (s == null) {
            log("Llegó la decisión de una alerta pero el dron no está siguiendo ningún objetivo: no cambia nada")
            return
        }
        if (alertId != null && s.alertId != null && alertId != s.alertId) {
            log("La decisión es sobre la alerta #$alertId, que no es la del objetivo en curso (#${s.alertId}): se ignora")
            return
        }
        if (reenvio && (alertId == null || alertId != s.alertId)) {
            log("Decisión reenviada de la alerta #$alertId, que no es la del objetivo en curso: se ignora")
            return
        }
        if (decision == "DISMISSED") {
            val ahora = reloj()
            val e = s.rastreador.estimar(ahora)
            // Falso positivo: ni el lugar donde se lo vio primero ni donde quedó
            // la estimación vuelven a alertar por un rato (ver ZonasDescartadas).
            zonasDescartadas.agregar(e.lat, e.lon, ahora)
            zonasDescartadas.agregar(s.origenLat, s.origenLon, ahora)
            silencioHastaMs = ahora + SILENCIO_TRAS_DESCARTE_MS
            terminarSeguimiento("la alerta se descartó como falso positivo (por $decidedBy)")
            // Con el control tomado el dron sigue siendo del operador; si no,
            // retoma la ruta hacia el nodo que tenía por delante.
            if (_state.value in ESTADOS_DE_SEGUIMIENTO) resumePatrol("alerta descartada por $decidedBy")
        } else if (decision == "VALIDATED") {
            // Alerta real: el dron sigue sobre el objetivo hasta que el
            // operador ordene reanudar desde la consola
            s.decision = "VALIDATED"
            log("Alerta VALIDADA por $decidedBy: el dron sigue sobre el objetivo")
        }
    }

    private suspend fun resumePatrol(reason: String, fromIndex: Int? = null) {
        val r = route ?: return
        if (_state.value !in ESTADOS_REANUDABLES) return
        terminarSeguimiento("se reanudó el patrullaje ($reason)")
        val desde = (fromIndex ?: resumeWaypoint).coerceIn(0, r.waypoints.size - 1)
        resumeWaypoint = desde
        proximoWaypoint = desde
        // El estado antes que la orden (ver pasarA()): ESTADOS_REANUDABLES
        // incluye MANUAL y el operador puede apretar "Retomar ruta" sin soltar el
        // control, así que acá también hay un mando a 10 Hz golpeando la puerta.
        pasarA(PatrolState.PATROLLING)
        controller.startRoute(r, desde)
        report("PATROL_RESUMED", "Patrullaje reanudado hacia el nodo ${desde + 1} ($reason)")
    }

    private suspend fun statusTicker() {
        while (true) {
            delay(1_000)
            val t = lastTelemetry ?: continue
            val dron = controller.estado.value
            commandCenter.sendStatus(
                state = _state.value.name,
                battery = t.batteryPct,
                lat = t.lat,
                lon = t.lon,
                routeId = route?.id,
                waypointIndex = lastReachedWaypoint,
                waypointTotal = route?.waypoints?.size ?: 0,
                signalOk = _signalOk.value,
                signalPct = _signalPct.value,
                heading = t.heading,
                mode = mode,
                altM = t.altM,
                satellites = dron.satelites,
                flying = dron.enVuelo,
                flightMode = dron.modoDeVuelo,
                target = objetivo,
                // NaN mientras el dron real no la informó: así no sale, y la
                // consola supone su valor en vez de creerle a uno inventado.
                gimbalPitch = t.gimbalPitch,
            )
        }
    }

    /**
     * Registra en el log local y lo reporta como evento al Comando Central. Los
     * de seguimiento llevan la alerta del objetivo y su posición, que quedan en
     * el registro para el equipo de tierra.
     */
    private fun report(eventType: String, message: String, alertId: Long? = null, lat: Double? = null, lon: Double? = null) {
        log(message)
        commandCenter.sendEvent(eventType, message, alertId, lat, lon)
    }

    private fun log(message: String) {
        _localLog.tryEmit(message)
    }
}
