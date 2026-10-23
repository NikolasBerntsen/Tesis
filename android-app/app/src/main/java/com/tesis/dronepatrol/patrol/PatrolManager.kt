package com.tesis.dronepatrol.patrol

import android.util.Base64
import com.tesis.dronepatrol.comms.AutonomiaReportada
import com.tesis.dronepatrol.comms.BaseDelHub
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.comms.MensajeDelHub
import com.tesis.dronepatrol.comms.MensajesDeLaApp
import com.tesis.dronepatrol.comms.RelevoReportado
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
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.ObjetivoReportado
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Telemetry
import java.util.UUID
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

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
 *
 * Los relevos entre drones, el desvío a otra base y el protocolo de última
 * ubicación (docs/RELEVOS.md) se suman así:
 *
 *   IDLE (en espera) → orden de relevo → cuenta regresiva → PATROLLING (patrulla de A)
 *                                                       → RELEVANDO → ORBITING/FOLLOWING (seguimiento de A)
 *   ORBITING/FOLLOWING → batería bajo el umbral de relevo → relay_request → relay_done → PAUSED (se aleja) → regreso
 *   regreso por batería → regresar(): base propia | otra base (RETURNING_HOME_BATTERY) | ATERRIZAJE_EMERGENCIA
 *
 * **El regreso a tiempo manda** (RELEVOS, regla de oro): ninguna lógica de
 * relevo o de desvío puede dejar al dron sin batería para volver, y el dron
 * vuelve SIEMPRE a su propia base salvo que de verdad no llegue.
 *
 * Todo lo que cambia el estado entra por [enSerie]: los avisos del dron, los
 * mensajes del Comando Central y el lazo de los relevos llegan por corrutinas
 * distintas y, sin una sola puerta, una orden de relevo podía cruzarse con el
 * regreso por batería que la anulaba.
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
    /**
     * Reloj del vigía de la señal (ver signalWatchdog()): "sin telemetría hace
     * más de 4 s" tampoco se prueba durmiendo el test. Va aparte de [reloj]
     * porque las pruebas del seguimiento lo adelantan de a 10 s sin telemetría
     * de por medio, y con un solo reloj eso sería además una señal perdida que
     * les corta el seguimiento en el medio.
     */
    private val relojDeLaSenial: () -> Long = System::currentTimeMillis,
    /**
     * Dónde guarda la cola de la emergencia lo que tiene pendiente: tiene que
     * sobrevivir a un reinicio de la app (docs/PROTOCOLS.md §1.b). La pantalla
     * le pasa un archivo; las pruebas, memoria.
     */
    almacenDeEmergencias: AlmacenDeCola = AlmacenEnMemoria(),
    /**
     * Las esperas de la secuencia de última ubicación (los 1,5 s de asentar
     * cada foto). Es un parámetro por lo mismo que [reloj]: con una que
     * adelanta el reloj falso, la secuencia entera se prueba sin esperar sus
     * 20 segundos.
     */
    private val pausaDeEmergencia: suspend (Long) -> Unit = { delay(it) },
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
         * puede quedarse, y la alerta pediría algo que no va a hacer. Tampoco
         * relevando (B solo puede tomar el objetivo que vino a relevar) ni en el
         * aterrizaje de emergencia.
         */
        val ESTADOS_SIN_ALERTAS = setOf(
            PatrolState.RETURNING_HOME,
            PatrolState.RETURNING_HOME_BATTERY,
            PatrolState.RETURNING_HOME_SIGNAL,
            PatrolState.RELEVANDO,
            PatrolState.ATERRIZAJE_EMERGENCIA,
        )

        /** Si la estimación del objetivo quieto se corre más que esto, la órbita la acompaña. */
        const val DERIVA_DE_ORBITA_M = 6.0

        /** Cuánta telemetría se guarda para buscar la pose del instante de cada cuadro. */
        const val HISTORIA_DE_POSES_MS = 3_000L

        /** Cada cuánto se reevalúa el seguimiento aunque no lleguen detecciones (para notar que se perdió). */
        const val INTERVALO_SEGUIMIENTO_MS = 500L

        // PAUSED/MANUAL/FORCED también son vuelo: batería baja y pérdida de
        // señal disparan el RTH igual que patrullando. RELEVANDO también: B
        // yendo hacia el objetivo de otro vuelve igual si se le acaba la batería.
        val ESTADOS_EN_VUELO = setOf(
            PatrolState.PATROLLING,
            PatrolState.ORBITING,
            PatrolState.FOLLOWING,
            PatrolState.PAUSED,
            PatrolState.MANUAL,
            PatrolState.FORCED,
            PatrolState.RELEVANDO,
        )
        /**
         * Volviendo a base: ahí ya hay un regreso en curso y los failsafes no lo
         * pisan. El aterrizaje de emergencia también es un regreso: el que baja
         * donde está porque no alcanza ninguna base.
         */
        val ESTADOS_DE_REGRESO = setOf(
            PatrolState.RETURNING_HOME,
            PatrolState.RETURNING_HOME_BATTERY,
            PatrolState.RETURNING_HOME_SIGNAL,
            PatrolState.ATERRIZAJE_EMERGENCIA,
        )

        /** Cada cuánto corre el lazo de los relevos (reintentos, cuenta regresiva, tránsito, cola). */
        const val INTERVALO_RELEVOS_MS = 200L

        /** La cuenta regresiva audible de B antes de despegar, con «Cancelar» en el teléfono. */
        const val CUENTA_REGRESIVA_MS = 10_000L

        /** Si B no llega a la altura en este tiempo después de despegar, aterriza y aborta. */
        const val SUBIDA_MAXIMA_MS = 40_000L

        /**
         * B en tierra esperando `relay_go` más que esto: el hub ya lo dio por
         * fallido a los 120 s (`sin_despegue`); se olvida por si el aviso no llegó.
         */
        const val ESPERA_DEL_GO_MAXIMA_MS = 130_000L

        /**
         * B en el traspaso sin un solo `relay_target` durante esto: el relevo ya
         * terminó para el hub (los manda cada 5 s mientras dura), y no queda
         * nadie que pueda decirle dónde está A. Baja a seguir al objetivo.
         */
        const val SILENCIO_DEL_HUB_MS = 30_000L

        /** Después de un relevo de seguimiento que terminó sin traspaso, esto antes de volver a pedir otro. */
        const val REINTENTO_TRAS_FIN_MS = 30_000L

        /** Las órdenes de tránsito de B se renuevan una vez por segundo, no en cada vuelta del lazo. */
        const val INTERVALO_ORDEN_DE_TRANSITO_MS = 1_000L

        /**
         * REACQUIRE_GATE_M de docs/RELEVOS.md §3.4: una detección de la misma
         * clase a menos de esto de la estimación adelanta la toma. Es la puerta
         * con la que el rastreador reengancha un objetivo perdido.
         */
        const val PUERTA_DE_TOMA_M = RastreadorDeObjetivo.PUERTA_DE_REENGANCHE_M

        /** Llegar al punto de visitantes de un desvío: a menos de esto ya se fija el retorno y se aterriza. */
        const val LLEGADA_AL_DESVIO_M = 3.0

        /**
         * Con el aviso de llegada del controlador alcanza con estar a esto del
         * punto de visitantes: el GPS del dron y el del lazo de navegación no
         * miden igual.
         */
        const val LLEGADA_POR_AVISO_M = 15.0

        /**
         * A soltando el objetivo (después del `relay_done`) que no logra
         * alejarse en este tiempo vuelve igual: alejarse es para no juntarse con
         * B, pero no puede costar el regreso.
         */
        const val ALEJAMIENTO_MAXIMO_MS = 30_000L

        /** B bajando en el lugar a la altura de seguimiento, después del traspaso: si no llega en esto, sigue igual. */
        const val BAJADA_MAXIMA_MS = 20_000L

        /** Cuánto se corre el dron para reintentar un aterrizaje que pidió confirmación (RELEVOS §4). */
        const val CORRIMIENTO_PARA_ATERRIZAR_M = 10.0

        /** Hasta cuántas veces se corre y reintenta antes de esperar el crítico + 1. */
        const val REINTENTOS_DE_ATERRIZAJE = 2

        /** Con la batería en el crítico del DJI más esto, el aterrizaje se confirma donde esté. */
        const val CONFIRMAR_SOBRE_EL_CRITICO_PCT = 1.0

        /** Una lectura en el suelo que sube esto o más es otra batería. */
        const val SALTO_DE_BATERIA_PCT = 10.0

        /** Lo que dura un paso de la secuencia de última ubicación, para el consumo estimado. */
        const val DURACION_DE_UN_PASO_MS =
            SecuenciaDeUltimaUbicacion.ASENTAR_MS + SecuenciaDeUltimaUbicacion.CONFIRMACION_MAXIMA_MS

        /**
         * Con la batería por cambiar (aterrizó por batería baja), una lectura
         * en el suelo desde acá es una batería cambiada: una nueva marca casi
         * 100 %, y la que se descargó no se recupera sola del 25 % al 50 % por
         * estar quieta. En el dron real es la única forma de enterarse del
         * cambio: el botón "Recargar" es del simulador.
         */
        const val BATERIA_CAMBIADA_PCT = 50.0

        // Estados desde los que un resume_patrol retoma la ruta activa
        val ESTADOS_REANUDABLES = setOf(
            PatrolState.ORBITING,
            PatrolState.FOLLOWING,
            PatrolState.RETURNING_HOME_SIGNAL,
            PatrolState.PAUSED,
            PatrolState.MANUAL,
            PatrolState.FORCED,
        )

        /** Desde el regreso por batería, los únicos estados a los que se pasa sin abandonar un desvío. */
        val ESTADOS_QUE_CONSERVAN_EL_DESVIO = setOf(
            PatrolState.RETURNING_HOME_BATTERY,
            PatrolState.ATERRIZAJE_EMERGENCIA,
            PatrolState.LANDED,
            PatrolState.IDLE,
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
        /**
         * Lo adoptó por un relevo (B, docs/RELEVOS.md §3.7): el dron no tiene
         * ruta propia a la que volver, así que un descarte, un `resume_patrol` o
         * un `relay_cancel` lo mandan a su base y nunca a patrullar.
         */
        val adoptado: Boolean = false,
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
     * Hay en curso un despegue EN EL LUGAR (desde la consola o desde la propia
     * app), no el de una ruta: sus eventos de vuelo se anotan distinto, porque
     * el despegue ya quedó registrado con quién lo pidió y el dron no va a ir a
     * ninguna altura de trabajo.
     */
    @Volatile
    private var despegueEnElLugar = false

    /**
     * El dron aterrizó con la batería baja y todavía no se la cambiaron: hasta
     * entonces no despega por ningún camino (la app, la consola, una ruta). Va
     * aparte del estado a propósito. LANDED se perdía con solo tomar el
     * control —pasa a MANUAL— y un aterrizaje por batería con el control
     * tomado ni siquiera pasa por LANDED; atado al estado, una lectura que
     * rebotó por encima del 25 % volvía a dejar despegar la batería
     * descargada, y soltar el control en el suelo la daba por cambiada. Lo
     * baja la batería nueva (ver verSiSeCambioLaBateria()) o el "Recargar" del
     * simulador (onBatteryRecharged()).
     */
    @Volatile
    private var bateriaPorCambiar = false

    /**
     * Hay un patrullaje en curso: arrancó (o se retomó) una ruta y el dron
     * todavía no volvió a reposo. `route` no alcanza para saberlo: queda
     * cargada después de que el patrullaje terminó (para el status), y al
     * volver la señal retomarla mandaba al dron a volar una ruta vieja que
     * nadie le pidió en ese vuelo —el de un "Despegar aquí", por ejemplo— (ver
     * alRecuperarLaSenial()).
     */
    @Volatile
    private var patrullaEnCurso = false

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

    // ---- Relevos, desvío a otra base y última ubicación (docs/RELEVOS.md) ----

    /**
     * La puerta de todo lo que cambia el estado (ver [enSerie]). Es un monitor
     * y no un Mutex de corrutinas a propósito: es reentrante —un regreso por
     * batería que aborta un relevo que vuelve a pasar por el regreso no se
     * traba contra sí mismo— y nada de lo que corre adentro suspende. El mando
     * manual NO pasa por acá: tiene su propio cerrojo ([cerrojoDelMando]) y no
     * puede quedar esperando detrás de una transición.
     */
    private val cerrojoDeLaPatrulla = Any()

    /** Las bases del último `bases` (docs/PROTOCOLS.md §2.b); null hasta el primero, y sin lista no hay desvío. */
    @Volatile
    private var bases: MensajeDelHub.Bases? = null

    /** Lo que [Autonomia.decidirRegreso] recuerda entre una telemetría y la siguiente. */
    private var memoriaDelRegreso = Autonomia.Memoria()

    private val consumo = ConsumoMedido()

    private val espera = EsperaParaRelevos()

    /** El interruptor «En espera para relevos», para la pantalla. */
    val enEspera: StateFlow<Boolean> get() = espera.prendido

    /** Los pedidos de relevo de A, uno por motivo (`patrulla`, `seguimiento`). */
    private val pedidos = HashMap<String, PedidoDeRelevo>()

    /** Final de la ventana de gracia abierta; null si no hay ninguna (RELEVOS §3.5). */
    private var ventanaHastaMs: Long? = null

    /** La ventana de gracia se abre una sola vez por seguimiento. */
    private var ventanaUsada = false

    /** Cuándo terminó, sin traspaso, el último relevo de seguimiento pedido (para no repedir enseguida). */
    private var finDelUltimoPedidoDeSeguimientoMs = Long.MIN_VALUE / 2

    /** A soltando el objetivo después del `relay_done`. */
    private var soltando: Soltando? = null

    /** El relevo que este dron atiende como B; null si ninguno. */
    @Volatile
    private var relevo: RelevoAsignado? = null

    /** La habilitación del mando virtual de B en tierra. */
    private var tareaDelRelevo: Job? = null

    /**
     * La última respuesta mandada a cada orden de relevo: una orden repetida
     * (el hub reenvía la última al reconectar) se contesta igual sin volver a
     * empezar nada (docs/PROTOCOLS.md §2.b).
     */
    private val respuestas = object : LinkedHashMap<Long, JSONObject>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, JSONObject>?) = size > 16
    }

    /** Un desvío a otra base en curso (RELEVOS §4). */
    private class Desvio(val base: BaseDelHub) {
        /** Ya llegó al punto de visitantes y se le ordenó aterrizar. */
        var llego = false
    }

    private var desvio: Desvio? = null

    /** Ya se gastó el único intento de cortarle al DJI su regreso propio (RELEVOS §4: nunca se pelea en lazo). */
    private var regresoDelDjiCortado = false

    /**
     * Por qué el propio DJI tiene el vuelo ([FlightEvent.ElDronTomoElControl]);
     * null si lo tiene la app. Mientras tanto la app no le da ninguna orden de
     * vuelo por su cuenta —cada una volvería a habilitar el mando virtual y a
     * pelearle el control— hasta que aterrice o una persona dé una orden. El
     * motivo importa: su regreso por batería se puede cortar UNA vez para un
     * desvío o para el §5; el del botón del control es una persona pidiendo el
     * dron de vuelta, y ese no se corta nunca.
     */
    @Volatile
    private var tomaDelDron: MotivoDelDron? = null

    private val dronAlMando: Boolean get() = tomaDelDron != null

    /**
     * El aterrizaje en un lugar que nadie revisó (el de un desvío o el del §5)
     * no se confirma solo (RELEVOS §4): si el dron lo pide, se corre
     * [CORRIMIENTO_PARA_ATERRIZAR_M] y reintenta, hasta
     * [REINTENTOS_DE_ATERRIZAJE] veces; recién con la batería en el crítico + 1
     * se confirma. Cuántos reintentos van, si el dron está esperando la
     * confirmación y si se está corriendo para el próximo intento.
     */
    private var reintentosDeAterrizaje = 0
    private var confirmacionPendiente = false
    private var corriendoseParaAterrizar = false

    /** La app le pidió al controlador que no confirme solo (ver [confirmarAterrizajesALaMano]). */
    private var confirmacionManual = false

    /** Ya se anotó que el §5 tocaba pero el DJI tiene el vuelo (para no repetirlo en cada telemetría). */
    private var ultimaUbicacionPostergada = false

    /** B perdió la señal en un relevo: al recuperarla no lo retoma, vuelve a su base. */
    private var volverAlRecuperarLaSenial = false

    /** El protocolo de última ubicación en curso: el `ref` de la emergencia y si la app tiene el vuelo. */
    private class EmergenciaEnCurso(val ref: String, @Volatile var conControl: Boolean)

    /** La lee también la secuencia de fotos, que corre en su propia corrutina: de ahí el volátil. */
    @Volatile
    private var emergencia: EmergenciaEnCurso? = null

    /** El Job de la secuencia de fotos; [pasarA] lo cancela al salir de ATERRIZAJE_EMERGENCIA. */
    private var tareaDeEmergencia: Job? = null

    private val cola = ColaDeEmergencia(almacenDeEmergencias)

    /** `landing_at_base` y `landed_at_base` que no pudieron salir: salen al reconectar. */
    private val pendientesDeEnvio = ArrayDeque<JSONObject>()

    /** El `rth_diverted` del desvío o la emergencia en curso: se repite en cada reconexión mientras dure. */
    private var rthDivertedVigente: JSONObject? = null

    /** La última telemetría con una posición de verdad: es la que sale en `emergency_landed`. */
    private var ultimaPosicionValida: Telemetry? = null

    /** Batería de la lectura anterior en el suelo, para notar un cambio de batería. */
    private var bateriaAnteriorEnTierra = Double.NaN

    /** El Comando Central estaba conectado en el último aviso (para notar la reconexión). */
    private var conectadoAntes = false

    private val _ultimaUbicacion = MutableStateFlow<UbicacionFijada?>(
        cola.ultimaPosicion()?.let { UbicacionFijada(it.lat, it.lon, Double.NaN, it.aterrizada) },
    )

    /** La última posición de una emergencia, fija en la pantalla del teléfono (RELEVOS §5). */
    val ultimaUbicacion: StateFlow<UbicacionFijada?> = _ultimaUbicacion

    private val _cuentaRegresiva = MutableStateFlow<CuentaRegresiva?>(null)

    /** La cuenta regresiva de B antes de despegar para un relevo; null si no hay ninguna. */
    val cuentaRegresiva: StateFlow<CuentaRegresiva?> = _cuentaRegresiva

    private val _avisos = MutableSharedFlow<String>(extraBufferCapacity = 16)

    /** Avisos de los relevos para mostrar en la pantalla (además del registro local). */
    val avisos: SharedFlow<String> = _avisos

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
        commandCenter.onResumePatrol = { fromIndex -> scope.launch { onResumePatrol(fromIndex) } }
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
        // Los relevos, desvíos y emergencias (§2.b) llegan ya validados y con
        // tipo; uno inválido solo queda en el registro local.
        commandCenter.onMensajeDelHub = { mensaje -> scope.launch { alMensajeDelHub(mensaje) } }
        commandCenter.onMensajeInvalido = { motivo -> log("Mensaje del Comando Central ignorado por no cumplir el contrato: $motivo") }
        scope.launch { controller.estado.collect { alCambiarElDron(it) } }
        scope.launch { commandCenter.connected.collect { alCambiarLaConexion(it) } }
        scope.launch { signalWatchdog() }
        scope.launch { mandoWatchdog() }
        scope.launch { statusTicker() }
        scope.launch { seguimientoTicker() }
        scope.launch { relevosTicker() }
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

    fun startPatrol(route: PatrolRoute) = enSerie {
        ordenDeCampo("arrancó un patrullaje")
        // En el suelo, el controlador despega solo (ver DroneController.startRoute),
        // pero solo si el dron está en condiciones: sin GPS o sin punto de retorno
        // un despegue automático es un dron que no sabe volver.
        if (!puedeArrancarUnaRuta()) return@enSerie
        ordenDeUnaPersona()
        terminarSeguimiento("empezó otro patrullaje")
        this.route = route
        patrullaEnCurso = true
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
    fun detenerPatrullaje() = enSerie {
        ordenDeCampo("detuvo el patrullaje")
        detener("el operador de campo")
    }

    /** Retoma la ruta desde el último nodo alcanzado. */
    fun reanudarPatrullaje() {
        scope.launch {
            enSerie {
                ordenDeCampo("ordenó reanudar")
                if (!volverSiNoTieneRutaPropia("el operador de campo ordenó reanudar")) resumePatrol("orden del operador de campo")
            }
        }
    }

    /**
     * Regreso a base ordenado desde el campo. Pisa cualquier otra orden, incluido
     * el control manual de la consola: el que está al lado del dron manda.
     */
    fun volverABase() = enSerie {
        if (!controller.estado.value.enVuelo) {
            log("El dron está en el suelo: no hay a dónde volver")
            return@enSerie
        }
        ordenDeCampo("ordenó volver a la base")
        ordenDeUnaPersona()
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
        controlTomado = false
        terminarSeguimiento("el operador de campo ordenó volver a la base")
        // Sin frenar: el regreso a base es la orden que manda (ver checkLowBattery()).
        pasarA(PatrolState.RETURNING_HOME)
        controller.returnHome()
        report("RTH_MANUAL", "El operador de campo ordenó volver a la base")
    }

    /**
     * Despegue en el lugar ordenado desde la propia app: el dron sube a ~1,2 m
     * y queda suspendido, sin ruta y sin necesitar GPS. Es lo que evita tener
     * que despegar con las palancas del control para una prueba o para tomarlo
     * después desde la consola. Queda en IDLE en el aire: desde ahí se puede
     * comenzar un patrullaje sin volver a despegar.
     */
    fun despegarAqui() = enSerie {
        val dron = controller.estado.value
        if (dron.enVuelo) {
            log("El dron ya está en el aire")
            return@enSerie
        }
        if (!dron.conectado) {
            report("DRONE_PROBLEM", "No se puede despegar: ${dron.detalle.ifBlank { "sin enlace con la aeronave" }}")
            return@enSerie
        }
        ordenDeCampo("despegó en el lugar")
        if (laBateriaSiguePorCambiar()) return@enSerie
        bateriaParaDespegar()?.let { pct ->
            report("DRONE_PROBLEM", "No se despega con la batería al ${pct.toInt()}%: hace falta más del ${LOW_BATTERY_PCT.toInt()}%")
            return@enSerie
        }
        olvidarElUltimoProblema()
        val sinGps = lastTelemetry?.tienePosicion != true
        despegueEnElLugar = true
        controller.despegarEnElLugar()
        report(
            "TAKEOFF",
            "Despegue en el lugar ordenado por el operador de campo: el dron queda suspendido a ~1 m" +
                if (sinGps) " (sin GPS: se sostiene con los sensores de visión)" else "",
        )
    }

    /** Aterriza donde está. Al tocar el suelo (FlightEvent.Aterrizado) queda en base. */
    fun aterrizar() = enSerie {
        if (!controller.estado.value.enVuelo) {
            log("El dron ya está en el suelo")
            return@enSerie
        }
        ordenDeCampo("ordenó aterrizar")
        ordenDeUnaPersona()
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
            enSerie { ordenDelOperador() }
            return
        }
        enSerie { arrancarRuta(r, fromIndex, orderedBy) }
    }

    private fun arrancarRuta(r: PatrolRoute, fromIndex: Int, orderedBy: String) {
        ordenDelOperador()
        // Desde la consola también se puede ordenar con el dron en el suelo
        if (!puedeArrancarUnaRuta()) return
        ordenDeUnaPersona()
        val desde = fromIndex.coerceIn(0, r.waypoints.size - 1)
        terminarSeguimiento("se ordenó patrullar otra ruta")
        route = r
        patrullaEnCurso = true
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

    private fun onStopPatrol(orderedBy: String) = enSerie {
        ordenDelOperador()
        detener(orderedBy)
    }

    private fun detener(orderedBy: String) {
        if (_state.value !in ESTADOS_EN_VUELO || _state.value == PatrolState.PAUSED) return
        ordenDeUnaPersona()
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
        terminarSeguimiento("se interrumpió el patrullaje (orden de $orderedBy)")
        // Primero el estado y después la orden, como en pasarA(): si no, un
        // mando que viene en camino se cuela entre las dos y lo vuelve a mover.
        pasarA(PatrolState.PAUSED)
        controller.hold()
        report("PATROL_STOPPED", "Patrullaje interrumpido por $orderedBy: el dron queda en vuelo estacionario")
    }

    private suspend fun onForceGoto(routeId: Int, index: Int, orderedBy: String) {
        val wp = buscarRuta(routeId)?.waypoints?.getOrNull(index)
        enSerie {
            // La orden cancela el relevo en el hub aunque no se pueda cumplir.
            ordenDelOperador()
            if (wp == null) {
                log("Se ordenó desviar al nodo ${index + 1} de la ruta $routeId pero no existe: se ignora")
            } else {
                desviarAlNodo(wp.lat, wp.lon, index, orderedBy)
            }
        }
    }

    private fun desviarAlNodo(lat: Double, lon: Double, index: Int, orderedBy: String) {
        // Un resume posterior retoma el patrullaje normal hacia el nodo que tenía
        // por delante: si se sale de PATROLLING se anota ese nodo, como en todas
        // las demás salidas. Sin anotarlo, resumeWaypoint quedaba con un valor
        // viejo (el 0 del arranque) y "Reanudar" mandaba al dron de vuelta al
        // primer nodo a repetir la ruta entera. Desde otro estado (MANUAL, un
        // desvío anterior) el nodo ya quedó anotado al salir del patrullaje.
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
        ordenDeUnaPersona()
        terminarSeguimiento("desvío forzado a un nodo (orden de $orderedBy)")
        forcedIndex = index
        // El estado antes que la orden (ver pasarA()): también se llega acá desde
        // MANUAL, y un mando colado en el medio abandona el desvío recién pedido.
        pasarA(PatrolState.FORCED)
        controller.gotoPoint(lat, lon)
        report("FORCED_GOTO", "Desvío forzado hacia el nodo ${index + 1} (orden de $orderedBy)")
    }

    /**
     * Tomar el control no cancela ningún relevo (docs/RELEVOS.md §3.9): B en el
     * aire queda en MANUAL y, al soltarlo, retoma el relevo donde estaba. Sí le
     * devuelve el vuelo a la app si el propio DJI lo había tomado: es una
     * persona la que decide.
     */
    private fun onControlTaken(by: String) = enSerie {
        ordenDeUnaPersona()
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
     * así que una inclinación que pasó la puerta le llega al CONTROLADOR antes de
     * que el estado salga de MANUAL, nunca después.
     *
     * Eso no alcanza para el gimbal: el controlador real no se la pasa en el
     * acto, la deja esperando hasta que el gimbal termine la anterior (hasta
     * 300 ms, o 2 s con el SDK lento). Por eso [pasarA], al salir de MANUAL y en
     * el mismo paso que cierra la puerta, le pide que la tire
     * ([DroneController.cancelarInclinacionManual]). Lo que queda garantizado:
     * fuera de MANUAL, al gimbal solo puede llegarle la inclinación de la consola
     * que ya estaba cumpliendo, y la cámara que apunta el estado siguiente (la
     * ruta, la órbita, el seguimiento) sale después de esa, nunca antes.
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
     * Salir de MANUAL también suelta la cámara: la inclinación de la consola que
     * el controlador tenía esperando se tira (ver [onManualGimbal]). Va adentro
     * del cerrojo, en el mismo paso que cierra la puerta: así toda inclinación
     * que la pasó ya está en el controlador cuando se la tira, y el descarte sale
     * antes que la orden del estado siguiente, que quien llama da después.
     *
     * El estado y las marcas se pisan adentro de [cerrojoDelMando]; el freno se
     * manda con el cerrojo ya soltado, porque para eso alcanza con que la puerta
     * del estado esté cerrada.
     */
    private fun pasarA(nuevo: PatrolState, frenar: Boolean = false) {
        // La secuencia de última ubicación corre en un Job que se corta al salir
        // de su estado: una persona que toma el control o aterriza el dron manda
        // sobre las fotos que faltaban (docs/RELEVOS.md §1).
        if (_state.value == PatrolState.ATERRIZAJE_EMERGENCIA && nuevo != PatrolState.ATERRIZAJE_EMERGENCIA) {
            tareaDeEmergencia?.cancel()
            tareaDeEmergencia = null
        }
        // El desvío a otra base vive en el regreso por batería: salir de ahí
        // por cualquier cosa que no sea tocar tierra o bajar en emergencia es
        // una persona que dio otra orden, y la orden manda (RELEVOS §3.9).
        if (_state.value == PatrolState.RETURNING_HOME_BATTERY && nuevo !in ESTADOS_QUE_CONSERVAN_EL_DESVIO) {
            abandonarElDesvio("Otra orden")
        }
        synchronized(cerrojoDelMando) {
            val salimosDeManual = _state.value == PatrolState.MANUAL && nuevo != PatrolState.MANUAL
            _state.value = nuevo
            if (salimosDeManual) {
                ultimoMandoMs = 0L
                ultimoMandoEstacionario = true
                saltoManualEnCurso = false
                controller.cancelarInclinacionManual()
            }
        }
        // Volver a reposo termina el patrullaje: la ruta sigue cargada, pero ya
        // no es una que el dron esté volando (ver [patrullaEnCurso]).
        if (nuevo == PatrolState.IDLE || nuevo == PatrolState.LANDED) patrullaEnCurso = false
        if (frenar) controller.hold()
    }

    /**
     * Cómo queda el dron al tocar tierra sin el control tomado, cuando no venía
     * volviendo por batería baja: en reposo, salvo que la batería siga por
     * cambiar —lo despegaron con las palancas sin cambiarla—, que entonces la
     * sigue esperando.
     */
    private fun enReposo(): PatrolState = if (bateriaPorCambiar) PatrolState.LANDED else PatrolState.IDLE

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

    private fun onControlReleased(by: String) = enSerie { soltarElControl(by) }

    private fun soltarElControl(by: String) {
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
        // Con la batería baja o por cambiar queda en LANDED, como si hubiera
        // aterrizado sin el control tomado: hay que cambiarla antes de volver a
        // volar. Mirar solo la lectura daba por cambiada una batería que rebotó
        // por encima del 25 %.
        if (!controller.estado.value.enVuelo) {
            terminarSeguimiento("el dron está en el suelo")
            if (bateriaParaDespegar() != null) bateriaPorCambiar = true
            pasarA(enReposo())
            return
        }
        // B en un relevo: soltar el control lo devuelve al relevo donde estaba
        // (en el traspaso todavía no baja al objetivo: A puede estar encima).
        val r = relevo
        if (r != null && (r.fase == FaseDelRelevo.EN_CAMINO || r.fase == FaseDelRelevo.TRASPASO)) {
            r.ultimaOrdenMs = Long.MIN_VALUE / 2
            pasarA(PatrolState.RELEVANDO)
            log("$by soltó el control: el dron retoma el relevo de ${r.de.displayName}")
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
    private fun onTakeoff(by: String) = enSerie { despegarPorLaConsola(by) }

    private fun despegarPorLaConsola(by: String) {
        // Los rechazos van al Comando Central y no solo al log del teléfono: el
        // que apretó "Despegar" está en la consola y tiene que saber por qué no
        // pasa nada.
        if (!controlTomado || _state.value != PatrolState.MANUAL) {
            report("DRONE_PROBLEM", "No se despega: $by no tiene el control manual tomado en el dron (estado ${_state.value})")
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
        // Tomar el control de un dron en LANDED lo pasa a MANUAL: la batería
        // por cambiar se mira aparte, o el "Despegar" de la consola la volaba.
        if (laBateriaSiguePorCambiar()) return
        bateriaParaDespegar()?.let { pct ->
            report("DRONE_PROBLEM", "No se despega con la batería al ${pct.toInt()}%: hace falta más del ${LOW_BATTERY_PCT.toInt()}%")
            return
        }
        olvidarElUltimoProblema()
        val sinGps = lastTelemetry?.tienePosicion != true
        despegueEnElLugar = true
        controller.despegarEnElLugar()
        report(
            "TAKEOFF",
            "Despegue en el lugar ordenado por $by desde el Comando Central: el dron queda suspendido a ~1 m" +
                if (sinGps) " (sin GPS: se sostiene con los sensores de visión)" else "",
        )
    }

    /** Aterrizaje pedido desde la consola por el titular del control. */
    private fun onLand(by: String) = enSerie { aterrizarPorLaConsola(by) }

    private fun aterrizarPorLaConsola(by: String) {
        if (!controlTomado || _state.value != PatrolState.MANUAL) {
            log("$by pidió aterrizar sin el control manual tomado: se ignora")
            return
        }
        if (!controller.estado.value.enVuelo) {
            log("$by pidió aterrizar pero el dron ya está en el suelo")
            return
        }
        ordenDeUnaPersona()
        // Bajar a B en medio de un relevo lo termina; a A, es soltar el objetivo antes de tiempo.
        relevo?.let { abortarRelevo(it, "otro", "$by ordenó aterrizar desde la consola") }
        abandonarRelevoDeSeguimiento("orden_del_operador")
        terminarSeguimiento("$by ordenó aterrizar")
        controller.land()
        report("LANDING", "Aterrizaje ordenado por $by desde el Comando Central: el dron desciende donde está")
    }

    // ---- Detección de pérdida de señal ----
    // El enlace dron↔RC se considera perdido cuando la telemetría deja de llegar
    // por más de SIGNAL_TIMEOUT_MS. El dron real inicia su RTH failsafe por su
    // cuenta; acá reflejamos ese estado y avisamos al Comando Central (el celular
    // sigue online: lo que se cortó es el enlace de radio con el dron).
    /**
     * En el aire para los failsafes (batería baja, pérdida de señal): el dron
     * TIENE que estar en el aire —lo dice el propio dron— y no volviendo a
     * base, que ahí ya hay un regreso en curso y dispararlo de nuevo en cada
     * telemetría sería pisarlo. Vale en cualquier otro estado: en IDLE, que es
     * como queda después de un despegue en el lugar desde la app, y también en
     * LANDED, si alguien lo despega con las palancas del control sin haber
     * cambiado la batería.
     *
     * Mirar solo el estado no alcanzaba: con el control manual tomado y el dron
     * aterrizado el estado sigue en MANUAL, la batería baja al 25 % disparaba
     * el regreso a base de un dron en el suelo, el estado quedaba clavado en
     * RETURNING_HOME_BATTERY (nunca llega a una base de la que no salió) y desde
     * ahí la consola ya no podía volver a despegarlo. Pasó en la prueba en
     * interior.
     */
    private fun enVueloParaLosFailsafes(): Boolean =
        controller.estado.value.enVuelo && _state.value !in ESTADOS_DE_REGRESO

    /**
     * Arrancar o retomar una ruta con el dron en el suelo es despegar solo (ver
     * DroneController.startRoute), y eso pide un dron en condiciones: sin GPS
     * o sin punto de retorno es un dron que no sabe volver, y con la batería
     * en el umbral el regreso a base salta apenas despega; después de aterrizar
     * por batería baja, hasta que la cambien. En el aire no hay nada que
     * revisar. Si no se puede, avisa por qué y devuelve false.
     */
    private fun puedeArrancarUnaRuta(): Boolean {
        val dron = controller.estado.value
        if (dron.enVuelo) return true
        if (laBateriaSiguePorCambiar()) return false
        if (!dron.listoParaDespegar) {
            report("DRONE_PROBLEM", "No se puede despegar: ${dron.detalle.ifBlank { "el dron no está listo" }}")
            return false
        }
        bateriaParaDespegar()?.let { pct ->
            report("DRONE_PROBLEM", "No se despega con la batería al ${pct.toInt()}%: hace falta más del ${LOW_BATTERY_PCT.toInt()}%")
            return false
        }
        return true
    }

    /**
     * Un pedido explícito del operador (despegar): si el dron lo rechaza, el
     * motivo tiene que llegar aunque sea el mismo de la vez anterior. El filtro
     * de avisos repetidos (ver hayQueAvisarElProblema()) es para los rechazos
     * que se repiten solos a 10 Hz, no para el operador que vuelve a apretar.
     */
    private fun olvidarElUltimoProblema() {
        ultimoProblemaAvisado = null
        ultimoProblemaAvisadoMs = 0L
    }

    /**
     * La batería alcanza para despegar: más que el umbral del regreso a base,
     * que si no salta apenas el dron se despega del suelo. Sin dato de batería
     * (todavía no llegó telemetría) no se frena: decide el propio dron.
     */
    private fun bateriaParaDespegar(): Double? =
        lastTelemetry?.batteryPct?.takeIf { it <= LOW_BATTERY_PCT }

    /**
     * Si la batería sigue por cambiar (ver [bateriaPorCambiar]) lo avisa y
     * devuelve true: así no sale ningún despegue, aunque la lectura haya
     * rebotado por encima del umbral.
     */
    private fun laBateriaSiguePorCambiar(): Boolean {
        if (!bateriaPorCambiar) return false
        report("DRONE_PROBLEM", "No se despega: el dron aterrizó con la batería baja y hay que cambiarla")
        return true
    }

    private suspend fun signalWatchdog() {
        while (true) {
            delay(1_000)
            enSerie { vigilarLaSenial() }
        }
    }

    private fun vigilarLaSenial() {
        val silent = lastTelemetryAt > 0 && relojDeLaSenial() - lastTelemetryAt > SIGNAL_TIMEOUT_MS
        if (enVueloParaLosFailsafes() && silent) alPerderLaSenial("sin telemetría hace ${SIGNAL_TIMEOUT_MS / 1000} s")
    }

    /**
     * La señal con el dron se perdió: lo nota el vigía (la telemetría se calló)
     * o lo cuenta el propio DJI, que arrancó su regreso por pérdida de señal
     * (`ElDronTomoElControl(RTH_SENIAL)`, que llega recién cuando el enlace
     * vuelve). Las dos salen igual: el estado espera la señal y, al volver,
     * [alRecuperarLaSenial] decide con su regla de siempre.
     */
    private fun alPerderLaSenial(porque: String, frenar: Boolean = true) {
        _signalOk.value = false
        _signalPct.value = 0
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = proximoWaypoint
        // B sin señal en un relevo no lo retoma al recuperarla: vuelve a su
        // base (RELEVOS §3.10). A sin señal suelta el objetivo.
        relevo?.let { r ->
            if (r.fase == FaseDelRelevo.EN_CAMINO || r.fase == FaseDelRelevo.TRASPASO || r.fase == FaseDelRelevo.DESPEGANDO) {
                abortarRelevo(r, "senial", porque)
                volverAlRecuperarLaSenial = true
            }
        }
        if (seguimiento?.adoptado == true) volverAlRecuperarLaSenial = true
        abandonarRelevoDeSeguimiento("senial")
        terminarSeguimiento("se perdió la señal con el dron")
        // Frena: acá nadie más le habla al dron. Sin esto quedaba con la última
        // velocidad del operador (hasta 5 m/s) y el lazo de Virtual Stick
        // repitiéndosela a 10 Hz, así que apenas el enlace se reenganchaba
        // retomaba la marcha con nadie al mando. Si lo cuenta el DJI ya está en
        // su regreso, y frenarlo sería cortárselo.
        pasarA(PatrolState.RETURNING_HOME_SIGNAL, frenar = frenar)
        report("SIGNAL_LOST", "Se perdió la señal con el dron ($porque)")
        report("RTH_SIGNAL_LOSS", "El dron vuelve a la base por pérdida de señal (failsafe RTH)")
    }

    private fun onTelemetry(t: Telemetry) = enSerie {
        val recovering = _state.value == PatrolState.RETURNING_HOME_SIGNAL
        lastTelemetry = t
        lastTelemetryAt = relojDeLaSenial()
        poses.addLast(t)
        while (poses.isNotEmpty() && t.ts - poses.first().ts > HISTORIA_DE_POSES_MS) poses.removeFirst()
        _signalOk.value = true
        _signalPct.value = t.signalPct
        if (Geo.esPosicionValida(t.lat, t.lon)) ultimaPosicionValida = t
        val enVuelo = controller.estado.value.enVuelo
        consumo.registrar(t, enVuelo)
        verSiCambioLaBateriaEnTierra(t, enVuelo)

        if (recovering) {
            report("SIGNAL_RECOVERED", "Señal con el dron recuperada")
            alRecuperarLaSenial()
            return@enSerie
        }
        verSiSeCambioLaBateria(t)
        checkLowBattery(t)
        revisarSoltando(t)
        revisarRegreso(t)
        confirmarSiNoQuedaBateria(t)
    }

    /**
     * Una lectura en el suelo que salta [SALTO_DE_BATERIA_PCT] o más es otra
     * batería: el interruptor «En espera» se apaga, porque el operador revisó
     * el dron con la anterior (RELEVOS §0).
     */
    private fun verSiCambioLaBateriaEnTierra(t: Telemetry, enVuelo: Boolean) {
        if (enVuelo || !t.batteryPct.isFinite()) {
            bateriaAnteriorEnTierra = Double.NaN
            return
        }
        if (bateriaAnteriorEnTierra.isFinite() && t.batteryPct >= bateriaAnteriorEnTierra + SALTO_DE_BATERIA_PCT) {
            apagarEspera("se cambió la batería")
        }
        bateriaAnteriorEnTierra = t.batteryPct
    }

    /**
     * Con la batería por cambiar el dron espera una nueva. En el dron real
     * nadie aprieta "Recargar": se la cambia, se lo prende y la telemetría
     * vuelve con la carga nueva. Con esa lectura, en el suelo, queda listo para
     * volar. Vale también con el control tomado (MANUAL en el suelo): el
     * estado no cambia, sigue siendo del operador, pero ya puede despegar.
     */
    private fun verSiSeCambioLaBateria(t: Telemetry) {
        if (!bateriaPorCambiar || controller.estado.value.enVuelo) return
        // Sin dato de batería (NaN) no hay cambio que confirmar: sigue por cambiar
        if (t.batteryPct.isNaN() || t.batteryPct < BATERIA_CAMBIADA_PCT) return
        bateriaPorCambiar = false
        apagarEspera("se cambió la batería")
        if (_state.value == PatrolState.LANDED) pasarA(PatrolState.IDLE)
        report("BATTERY_RECHARGED", "Batería al ${t.batteryPct.toInt()}%: se cambió la batería y el dron queda listo para volar")
    }

    /**
     * Qué hacer cuando vuelve la señal. Tiene tres salidas porque a
     * RETURNING_HOME_SIGNAL se llega desde cualquier estado en vuelo y antes
     * había una sola, la de la ruta: si el dron llegaba ahí SIN ruta cargada
     * —el caso normal de "lo quiero volar a mano", que se toma desde IDLE—,
     * [resumePatrol] se iba en el primer renglón y el estado quedaba clavado en
     * RETURNING_HOME_SIGNAL para siempre, sin un solo camino de vuelta.
     *
     * La ruta se retoma solo si había un patrullaje en curso
     * ([patrullaEnCurso]), no con que haya una cargada: después de un
     * patrullaje que terminó la ruta queda, y la señal también se pierde desde
     * IDLE en el aire —un "Despegar aquí"— o desde LANDED. Retomarla ahí era
     * mandar al dron, que estaba suspendido al lado del operador, a volar una
     * ruta vieja que nadie le pidió.
     *
     * Con los relevos se suman tres guardas (docs/RELEVOS.md §1 y §3.10): nunca
     * se retoma una ruta con la batería en el umbral de regreso (el regreso
     * manda), un B que perdió la señal en un relevo no lo retoma (vuelve a su
     * base), y si el propio DJI tomó el control se lo deja terminar su regreso.
     */
    private fun alRecuperarLaSenial() {
        val t = lastTelemetry
        when {
            // El operador nunca soltó el control: sigue siendo suyo. El dron ya
            // quedó estacionario al perderse la señal, así que vuelve a la
            // palanca sin arrancar nada por su cuenta.
            controlTomado -> {
                pasarA(PatrolState.MANUAL)
                report("CONTROL_RESUMED", "Vuelve la señal con el control manual todavía tomado: el dron espera órdenes del operador")
            }
            // El DJI está en su propio regreso: no se le pelea el control. Sale
            // de RETURNING_HOME_SIGNAL para no tomar cada telemetría como otra
            // recuperación.
            dronAlMando -> {
                pasarA(PatrolState.RETURNING_HOME)
                log("Vuelve la señal con el propio dron volviendo a su base: la app no le da órdenes")
            }
            volverAlRecuperarLaSenial -> {
                volverAlRecuperarLaSenial = false
                regresar("Señal recuperada después de un relevo: el dron vuelve a su base", PatrolState.RETURNING_HOME)
            }
            route != null && patrullaEnCurso && t != null && t.batteryPct <= Autonomia.umbralDeRegreso(t.pctParaVolver) ->
                regresar("Señal recuperada con la batería al ${t.batteryPct.toInt()}%: el dron vuelve a la base en vez de retomar la ruta")
            // Requisito: al recuperar la señal, el patrullaje continúa donde quedó
            route != null && patrullaEnCurso -> resumePatrol("señal recuperada")
            // Sin patrullaje y sin control tomado no hay nada que reanudar:
            // queda en vuelo estacionario y disponible, en vez de clavado.
            else -> {
                pasarA(PatrolState.PAUSED)
                controller.hold()
                report("PATROL_STOPPED", "Señal recuperada sin un patrullaje en curso: el dron queda en vuelo estacionario")
            }
        }
    }

    // ---- Detección de batería baja ----
    // Si la batería cae del umbral en pleno vuelo, el dron vuelve y se avisa al
    // Comando Central. No hay reanudación automática: hace falta cambiar batería.
    // El umbral es el fijo o, con autonomía informada, lo que el propio DJI dice
    // que le cuesta volver más la reserva (docs/RELEVOS.md §1); adónde vuelve
    // lo decide regresar().
    private fun checkLowBattery(t: Telemetry) {
        if (!enVueloParaLosFailsafes()) return
        pedirRelevoDeSeguimientoSiHaceFalta(t)
        // NaN no es batería baja: sin dato no se dispara nada (decide el propio dron).
        if (!(t.batteryPct <= Autonomia.umbralDeRegreso(t.pctParaVolver))) return
        // Siguiendo un objetivo con el relevo en camino, A puede estirar un
        // poco (la ventana de gracia); si no, suelta y vuelve.
        if (sigueEnLaVentana(t)) return
        // B ya está en la toma (TRASPASO) y el relay_done viene en camino: A no
        // vuelve con el regreso del DJI, que subiría justo donde B espera, sino
        // que suelta y se aleja como si ya hubiera llegado.
        if (soltarSiYaLoTomaron()) return
        // A recién relevado se está alejando del objetivo, en dirección a su
        // base: ya es el comienzo del regreso, y la reserva se puede gastar en
        // él (RELEVOS §4). Volver desde ahí con el regreso del DJI lo haría
        // subir encima de B (RELEVOS §3.5), así que termina de alejarse salvo
        // que la batería baje 3 puntos del piso, que manda.
        if (alejandoseDelObjetivo() && t.batteryPct > pisoDelAlejamiento(t.pctParaVolver)) return
        val motivo = "Batería al ${t.batteryPct.toInt()}%: el dron vuelve a la base"
        relevo?.let { abortarRelevo(it, "bateria", "batería al ${t.batteryPct.toInt()} %") }
        abandonarRelevoDeSeguimiento("piso")
        terminarSeguimiento("batería al ${t.batteryPct.toInt()}%: el dron vuelve a la base")
        regresar(motivo)
    }

    /**
     * Tocó tierra con el control manual tomado: sigue siendo del operador, en
     * el suelo, y puede volver a despegar sin soltarlo (lo que la consola
     * espera, porque el Comando Central no suelta el control por un aterrizaje).
     * Si venía volviendo por batería baja, el aviso de cambiarla no se pierde, y
     * despegar queda frenado hasta que la cambien (ver [bateriaPorCambiar]).
     */
    private fun aterrizoConElControlTomado() {
        if (_state.value == PatrolState.RETURNING_HOME_BATTERY) bateriaPorCambiar = true
        if (_state.value != PatrolState.MANUAL) pasarA(PatrolState.MANUAL)
        report(
            "LANDED",
            if (bateriaPorCambiar) {
                "Dron aterrizado con la batería baja: hay que cambiarla antes de volver a volar " +
                    "(el control manual sigue tomado)"
            } else {
                "Dron aterrizado: el control manual sigue tomado"
            },
        )
    }

    /**
     * Se cambió/recargó la batería. Si el dron había aterrizado por batería baja,
     * vuelve a quedar disponible para arrancar un patrullaje.
     */
    fun onBatteryRecharged() = enSerie {
        bateriaPorCambiar = false
        apagarEspera("se cambió la batería")
        if (_state.value == PatrolState.LANDED) pasarA(PatrolState.IDLE)
        report("BATTERY_RECHARGED", "Batería recargada al 100%: el dron queda listo para volar")
    }

    private fun onFlightEvent(e: FlightEvent) = enSerie {
        // Al tocar tierra, lo que dependía del vuelo se cierra antes que nada:
        // la emergencia, el desvío, el aviso de aterrizaje al hub.
        val llegada = if (e is FlightEvent.Aterrizado || e is FlightEvent.ArrivedHome) alTocarTierra() else null
        when (e) {
            is FlightEvent.WaypointReached -> {
                lastReachedWaypoint = e.index
                proximoWaypoint = (e.index + 1) % (route?.waypoints?.size ?: 1).coerceAtLeast(1)
            }
            is FlightEvent.ArrivedHome -> when {
                // El failsafe de batería salta también con el control tomado y
                // termina acá (returnHome() → ArrivedHome), no en Aterrizado.
                controlTomado -> aterrizoConElControlTomado()
                llegada?.enEmergencia == true -> aterrizoEnEmergencia()
                _state.value == PatrolState.RETURNING_HOME_BATTERY -> {
                    bateriaPorCambiar = true
                    pasarA(PatrolState.LANDED)
                    report("LANDED", llegada?.desvio?.let { "Dron aterrizado en la base \"${it.nombre}\" (desvío por batería baja)" } ?: "Dron aterrizado en base (batería baja)")
                }
                _state.value == PatrolState.RETURNING_HOME || _state.value == PatrolState.RETURNING_HOME_SIGNAL -> {
                    pasarA(enReposo())
                    report("LANDED", "Dron aterrizado en la base")
                }
                else -> Unit
            }
            is FlightEvent.Despegando -> {
                enAlturaDeTrabajo = false
                // Un despegue es un vuelo nuevo: el interruptor de espera vale
                // una sola vez, y lo que el DJI hizo en el vuelo anterior ya no cuenta.
                apagarEspera("el dron despegó")
                tomaDelDron = null
                regresoDelDjiCortado = false
                val r = relevo
                // El despegue en el lugar ya quedó registrado con quién lo pidió
                // (onTakeoff() o despegarAqui()).
                when {
                    despegueEnElLugar -> log("Despegando en el lugar")
                    r != null && r.esSeguimiento && r.fase == FaseDelRelevo.DESPEGANDO -> report(
                        "TAKEOFF",
                        "Despegue de relevo: el dron sube a ${r.alturaDeTransito.toInt()} m para tomar el seguimiento de ${r.de.displayName}",
                    )
                    else -> report("TAKEOFF", "Despegue automático: el dron sube a la altura de trabajo")
                }
            }
            is FlightEvent.EnElAire -> {
                enAlturaDeTrabajo = true
                log(
                    if (despegueEnElLugar) {
                        "El dron está en el aire, suspendido en el lugar"
                    } else {
                        "Despegue completado: el dron está a la altura de trabajo"
                    },
                )
                despegueEnElLugar = false
                relevo?.let { if (it.fase == FaseDelRelevo.DESPEGANDO) alLlegarArriba(it) }
            }
            is FlightEvent.Aterrizado -> {
                terminarSeguimiento("el dron aterrizó")
                when {
                    // Con el control tomado sigue siendo del operador, en el
                    // suelo: puede volver a despegar sin soltarlo y retomarlo.
                    controlTomado -> aterrizoConElControlTomado()
                    llegada?.enEmergencia == true -> aterrizoEnEmergencia()
                    // Aterrizó volviendo por batería baja (el propio dron, o un
                    // regreso que terminó en otro lado): hay que cambiarla.
                    _state.value == PatrolState.RETURNING_HOME_BATTERY -> {
                        bateriaPorCambiar = true
                        pasarA(PatrolState.LANDED)
                        report(
                            "LANDED",
                            llegada?.desvio?.let {
                                "Dron aterrizado en la base \"${it.nombre}\" (desvío por batería baja): hay que cambiarle la batería"
                            } ?: "Dron aterrizado con la batería baja: hay que cambiarla antes de volver a volar",
                        )
                    }
                    else -> {
                        pasarA(enReposo())
                        report("LANDED", "Dron aterrizado")
                    }
                }
            }
            is FlightEvent.GotoArrived -> {
                // El salto puntual terminó: desde acá el mando vuelve a mandar
                // sin condiciones (ver onManualStick()).
                saltoManualEnCurso = false
                alLlegarAlPunto()
            }
            // Un rechazo del dron no puede quedar mudo: el operador mueve la
            // palanca, el dron no se mueve y sin esto no hay ni una pista. Pero
            // se avisa por TRANSICIÓN y no por intento: el controlador reintenta
            // en cada vuelta de su lazo de 10 Hz y el mismo rechazo llegaba diez
            // veces por segundo, cada una una fila en `events` y un broadcast a
            // cada consola (ver hayQueAvisarElProblema()).
            is FlightEvent.Problema -> {
                // B despegando para un relevo: un rechazo es la subida que falló.
                relevo?.let { if (it.fase == FaseDelRelevo.DESPEGANDO) fallaLaSubida(it, e.motivo) }
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
            // Avisos de los relevos y del desvío a otra base (docs/RELEVOS.md
            // §2.3 y §4).
            is FlightEvent.DescendiendoEnBase -> {
                log("El dron empezó a descender en la base")
                avisarQueBajaEnSuBase()
            }
            is FlightEvent.ElDronTomoElControl -> alTomarElControlElDron(e.motivo)
            is FlightEvent.AterrizajePideConfirmacion -> alPedirConfirmarElAterrizaje()
        }
    }

    /**
     * El dron llegó al punto de una orden de vuelo y quedó estacionario. Qué
     * orden era lo dice lo que está en curso: el corrimiento para reintentar un
     * aterrizaje, la bajada de B después del traspaso, un desvío forzado a un
     * nodo, o el punto de visitantes de la base de un desvío.
     */
    private fun alLlegarAlPunto() {
        val r = relevo
        when {
            corriendoseParaAterrizar -> {
                corriendoseParaAterrizar = false
                controller.land()
                log("Se corrió para aterrizar: lo vuelve a intentar")
            }
            r?.bajandoDesdeMs != null -> completarElRelevo(r, "${r.de.displayName} ya se alejó")
            _state.value == PatrolState.FORCED ->
                report("GOTO_ARRIVED", "El dron llegó al nodo ${forcedIndex + 1} y queda en vuelo estacionario")
            // Un aviso viejo de otra orden (el alejamiento de A, por ejemplo) no
            // puede aterrizarlo antes de llegar: se mira que de verdad esté ahí.
            _state.value == PatrolState.RETURNING_HOME_BATTERY ->
                desvio?.takeIf { cercaDelPuntoDeVisitantes(it, lastTelemetry, LLEGADA_POR_AVISO_M) }?.let { llegarAlDesvio() }
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
    private fun onDetection(d: Deteccion) = enSerie { detectar(d) }

    private fun detectar(d: Deteccion) {
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
        // B yendo a relevar: solo le importa el objetivo que viene a tomar
        // (una detección suya adelanta la toma); cualquier otra se descarta,
        // sin alerta (RELEVOS §3.4).
        if (estado == PatrolState.RELEVANDO) {
            tomarAntesSiLoVe(d, pose, ahora)
            return
        }
        if (estado in ESTADOS_SIN_ALERTAS) return
        // A alejándose del objetivo que acaba de soltar: no arranca otro seguimiento ahí mismo.
        if (soltando?.liberado == false && estado == PatrolState.PAUSED) return
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
        // Un objetivo nuevo tiene su propia ventana de gracia (RELEVOS §3.5).
        ventanaUsada = false
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
            enSerie { evaluarSeguimiento(reloj()) }
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
            // Con la velocidad en componentes, B siembra su rastreador sin
            // perder lo que A ya estimó (docs/PROTOCOLS.md §1, `target`).
            vNorteMs = e.vNorteMs,
            vEsteMs = e.vEsteMs,
        )
    }

    private fun coordenadas(lat: Double, lon: Double) = "%.6f, %.6f".format(lat, lon)

    /** El hub registró la alerta: si es la del objetivo en curso, queda asociada. */
    private fun onAlertAck(ref: String, alertId: Long) = enSerie {
        val s = seguimiento ?: return@enSerie
        if (s.ref != ref) return@enSerie
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
    private fun onAlertDecision(alertId: Long?, decision: String, decidedBy: String, reenvio: Boolean) =
        enSerie { decidirLaAlerta(alertId, decision, decidedBy, reenvio) }

    private fun decidirLaAlerta(alertId: Long?, decision: String, decidedBy: String, reenvio: Boolean) {
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
            // El hub cancela por su cuenta el relevo de una alerta descartada:
            // A solo lo olvida (no hay nada que abandonar).
            pedidos.remove(PedidoDeRelevo.SEGUIMIENTO)
            cerrarLaVentana()
            terminarSeguimiento("la alerta se descartó como falso positivo (por $decidedBy)")
            // Un seguimiento adoptado por un relevo no tiene ruta a la que
            // volver: el dron vuelve a su base (RELEVOS §3.7).
            if (s.adoptado) {
                relevo?.let { olvidarRelevo(it) }
                if (controller.estado.value.enVuelo && _state.value != PatrolState.MANUAL) {
                    regresar("Alerta descartada por $decidedBy: el dron vuelve a su base", PatrolState.RETURNING_HOME)
                }
                return
            }
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

    /**
     * `resume_patrol` de la consola. Hacia B cancela el relevo (el hub ya lo
     * hizo de su lado, sin `relay_cancel`), y si B adoptó un seguimiento no
     * tiene ruta propia: vuelve a su base. Hacia A en un relevo de seguimiento
     * es un abandono (RELEVOS §3.9).
     */
    private fun onResumePatrol(fromIndex: Int?) = enSerie {
        ordenDelOperador()
        if (!volverSiNoTieneRutaPropia("el operador ordenó reanudar")) resumePatrol("orden del operador", fromIndex)
    }

    /**
     * Un dron que adoptó un seguimiento por un relevo, o que estaba yendo a
     * tomarlo, no tiene una ruta propia que retomar: vuelve a su base. Devuelve
     * true si fue así.
     */
    private fun volverSiNoTieneRutaPropia(motivo: String): Boolean {
        val adoptado = seguimiento?.adoptado == true
        if (!adoptado && _state.value != PatrolState.RELEVANDO) return false
        if (!controller.estado.value.enVuelo) return false
        terminarSeguimiento("$motivo: el dron no tiene ruta propia y vuelve a su base")
        regresar("${motivo.replaceFirstChar { it.uppercase() }}: el dron no tiene ruta propia y vuelve a su base", PatrolState.RETURNING_HOME)
        return true
    }

    private fun resumePatrol(reason: String, fromIndex: Int? = null) {
        val r = route ?: return
        if (_state.value !in ESTADOS_REANUDABLES) return
        // Solo se retoma un patrullaje que estaba en curso: una ruta que quedó
        // cargada de un vuelo anterior no es una que nadie le pidió volar ahora
        // (docs/RELEVOS.md §1).
        if (!patrullaEnCurso) {
            log("No hay un patrullaje en curso que reanudar ($reason)")
            return
        }
        // MANUAL es reanudable y se puede estar en el suelo (aterrizó con el
        // control tomado): ahí retomar la ruta es despegar solo.
        if (!puedeArrancarUnaRuta()) return
        ordenDeUnaPersona()
        terminarSeguimiento("se reanudó el patrullaje ($reason)")
        val desde = (fromIndex ?: resumeWaypoint).coerceIn(0, r.waypoints.size - 1)
        resumeWaypoint = desde
        proximoWaypoint = desde
        // El estado antes que la orden (ver pasarA()): ESTADOS_REANUDABLES
        // incluye MANUAL y el operador puede apretar "Retomar ruta" sin soltar el
        // control, así que acá también hay un mando a 10 Hz golpeando la puerta.
        pasarA(PatrolState.PATROLLING)
        // Retomada a pedido (de una pausa, del control manual), la ruta vuelve
        // a ser la que el dron está volando.
        patrullaEnCurso = true
        controller.startRoute(r, desde)
        report("PATROL_RESUMED", "Patrullaje reanudado hacia el nodo ${desde + 1} ($reason)")
    }

    private suspend fun statusTicker() {
        while (true) {
            delay(1_000)
            enSerie { mandarStatus() }
        }
    }

    private fun mandarStatus() {
        run {
            val t = lastTelemetry ?: return
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
                relevo = relevoReportado(),
                autonomia = AutonomiaReportada(t.pctParaVolver, t.pctParaAterrizar, t.alcanceM, t.segundosParaVolver),
            )
        }
    }

    // ======================================================================
    // Relevos, desvío a otra base y protocolo de última ubicación
    // (docs/RELEVOS.md; los mensajes, docs/PROTOCOLS.md §1.b y §2.b)
    // ======================================================================

    /** Todo lo que cambia el estado pasa por acá (ver [cerrojoDeLaPatrulla]). */
    private fun <T> enSerie(bloque: () -> T): T = synchronized(cerrojoDeLaPatrulla, bloque)

    /** Hay una ruta en curso que "Reanudar" puede retomar (un seguimiento adoptado por un relevo no tiene). */
    val puedeReanudar: Boolean get() = route != null && patrullaEnCurso && seguimiento?.adoptado != true

    // ---- El interruptor «En espera para relevos» (RELEVOS §0) ----

    /**
     * El operador prende o apaga «En espera para relevos». Prenderlo pide el
     * dron en el suelo y enlazado, y el Comando Central conectado: es lo que el
     * operador acaba de revisar. Devuelve si quedó como se pidió.
     */
    fun ponerEnEspera(prender: Boolean): Boolean = enSerie {
        if (!prender) {
            if (espera.apagar()) log("El operador apagó «En espera para relevos»")
            return@enSerie true
        }
        val dron = controller.estado.value
        val motivo = when {
            dron.enVuelo -> "el dron está en el aire"
            !dron.conectado -> "sin enlace con la aeronave"
            !commandCenter.connected.value -> "sin enlace con el Comando Central"
            // Lo que el operador revisó es un dron en reposo: ni con una orden en curso ni con la batería por cambiar.
            _state.value != PatrolState.IDLE -> "el dron no está en reposo (${_state.value})"
            else -> null
        }
        if (motivo != null) {
            aviso("No se puede poner en espera para relevos: $motivo")
            return@enSerie false
        }
        if (espera.prender(reloj())) {
            log(
                "En espera para relevos: el dron puede despegar solo para relevar a otro " +
                    "(se apaga solo a los ${EsperaParaRelevos.VENCIMIENTO_MS / 60_000} minutos)",
            )
            Disponibilidad.motivoParaNo(condicionesParaRelevar())?.let { aviso("En espera, pero todavía no disponible: $it") }
        }
        true
    }

    /** La pantalla de operación se cierra: el interruptor no puede quedar prendido sin nadie mirando. */
    fun alCerrarLaPantalla() = enSerie { apagarEspera("se cerró la pantalla de operación") }

    private fun apagarEspera(motivo: String) {
        if (espera.apagar()) aviso("«En espera para relevos» se apagó: $motivo")
    }

    private fun condicionesParaRelevar(enUnRelevo: Boolean = relevo != null || participaComoOrigen()): Disponibilidad.Condiciones {
        val t = lastTelemetry
        return Disponibilidad.Condiciones(
            enEspera = espera.prendido.value,
            dron = controller.estado.value,
            estado = _state.value,
            controlTomado = controlTomado,
            bateriaPorCambiar = bateriaPorCambiar,
            bateriaPct = t?.batteryPct ?: Double.NaN,
            lat = t?.lat ?: Double.NaN,
            lon = t?.lon ?: Double.NaN,
            basePropia = bases?.propia,
            enUnRelevo = enUnRelevo,
        )
    }

    private fun participaComoOrigen(): Boolean = pedidos.isNotEmpty() || soltando?.liberado == false

    /** `status.relevo` (docs/PROTOCOLS.md §1): B primero; de A, el seguimiento antes que la patrulla. */
    private fun relevoReportado(): RelevoReportado {
        val enEspera = espera.prendido.value
        val disponible = enEspera && Disponibilidad.disponible(condicionesParaRelevar())
        val r = relevo
        val s = soltando
        val seguimientoPedido = pedidos[PedidoDeRelevo.SEGUIMIENTO]?.takeIf { it.relayId != null }
        val patrullaPedida = pedidos[PedidoDeRelevo.PATRULLA]?.takeIf { it.relayId != null }
        return when {
            r != null -> RelevoReportado(enEspera, disponible, r.relayId, "relevo", r.fase.texto)
            s != null && !s.liberado -> RelevoReportado(enEspera, disponible, s.relayId, "origen", FaseDelOrigen.SOLTANDO.texto)
            seguimientoPedido != null ->
                RelevoReportado(enEspera, disponible, seguimientoPedido.relayId, "origen", seguimientoPedido.fase.texto)
            patrullaPedida != null -> RelevoReportado(enEspera, disponible, patrullaPedida.relayId, "origen", patrullaPedida.fase.texto)
            else -> RelevoReportado(enEspera, disponible)
        }
    }

    // ---- Los enlaces ----

    /**
     * Perder el dron apaga «En espera para relevos». Los umbrales de batería
     * mal puestos del propio DJI (RELEVOS §0) no se revisan acá: los revisa el
     * controlador real, que los lee, y los avisa como un problema del dron.
     */
    private fun alCambiarElDron(d: EstadoDelDron) = enSerie {
        if (!d.conectado) apagarEspera("se perdió el enlace con el dron")
    }

    private fun alCambiarLaConexion(ok: Boolean) = enSerie {
        if (ok && !conectadoAntes) reconectado()
        if (!ok && conectadoAntes) apagarEspera("se perdió el enlace con el Comando Central")
        conectadoAntes = ok
    }

    /**
     * Volvió el Comando Central (docs/PROTOCOLS.md §1.b, "Reconexión"): sale lo
     * que quedó esperando, el desvío en curso se vuelve a avisar, los pedidos
     * sin contestar se repiten ya y la cola de la emergencia no espera su
     * próximo reintento.
     */
    private fun reconectado() {
        while (pendientesDeEnvio.isNotEmpty()) commandCenter.enviar(pendientesDeEnvio.removeFirst())
        rthDivertedVigente?.let { commandCenter.enviar(it) }
        pedidos.values.forEach { it.reenviarYa() }
        cola.reconectado()
    }

    /** Un aviso que no se puede perder (`landing_at_base`, `landed_at_base`): sin conexión, sale al reconectar. */
    private fun enviarOGuardar(mensaje: JSONObject) {
        if (commandCenter.connected.value) commandCenter.enviar(mensaje) else pendientesDeEnvio.addLast(mensaje)
    }

    // ---- Las órdenes de las personas durante un relevo (RELEVOS §3.9) ----

    /**
     * Una orden de una persona que se va a cumplir le devuelve el vuelo a la
     * app: si el propio DJI lo había tomado, ya no, y un aterrizaje que ordene
     * una persona se confirma como siempre. La llama cada orden recién cuando
     * pasó sus guardas: una que no se cumple (detener un regreso, por ejemplo)
     * no puede soltar al DJI. El desvío en curso lo abandona [pasarA] al salir
     * del regreso por batería.
     */
    private fun ordenDeUnaPersona() {
        tomaDelDron = null
        olvidarLaConfirmacion()
    }

    /** Fuera de un desvío o de una emergencia, el DJI conserva su regreso propio y su failsafe de fábrica. */
    private fun restaurarFailsafes() {
        controller.permitirRthPropioPorBateria(true)
        controller.fijarFailsafeAterrizar(false)
    }

    /**
     * Una orden del operador de campo desde el teléfono. A B en tierra le
     * cancela el relevo (como «Cancelar»); en el aire se lo aborta. A A con un
     * relevo de seguimiento pedido le hace soltar el objetivo.
     */
    private fun ordenDeCampo(que: String) {
        relevo?.let { r ->
            if (r.fase == FaseDelRelevo.CUENTA_REGRESIVA || r.fase == FaseDelRelevo.ESPERANDO_DESPEGUE) {
                rechazarAceptado(r, "cancelado_en_campo", "el operador de campo $que")
            } else {
                abortarRelevo(r, "orden_de_campo", "el operador de campo $que")
            }
        }
        abandonarRelevoDeSeguimiento("orden_de_campo")
    }

    /**
     * Una orden de la consola que cancela un relevo (`start_route`,
     * `stop_patrol`, `force_goto`, `resume_patrol`): hacia B el hub ya lo
     * canceló de su lado, sin `relay_cancel`, así que la app lo olvida y cumple
     * la orden; hacia A en un seguimiento es un `relay_abandon`.
     */
    private fun ordenDelOperador() {
        relevo?.let { r ->
            olvidarRelevo(r)
            log("La orden del operador cancela el relevo de ${r.de.displayName}")
        }
        abandonarRelevoDeSeguimiento("orden_del_operador")
    }

    // ---- Los mensajes del hub (docs/PROTOCOLS.md §2.b) ----

    private fun alMensajeDelHub(m: MensajeDelHub) = enSerie {
        when (m) {
            is MensajeDelHub.Bases -> {
                bases = m
                log("Bases del Comando Central: ${m.bases.size}" + (m.propia?.let { ", la propia es \"${it.nombre}\"" } ?: ", sin base propia"))
            }
            is MensajeDelHub.EstadoDelPedido -> alEstadoDelPedido(m)
            is MensajeDelHub.OrdenDePatrulla -> alOrdenDeRelevo(m.relayId) { RelevoAsignado.de(m, it) }
            is MensajeDelHub.OrdenDeSeguimiento -> alOrdenDeRelevo(m.relayId) { RelevoAsignado.de(m, it) }
            is MensajeDelHub.OrdenInvalida -> alOrdenInvalida(m)
            is MensajeDelHub.ObjetivoActualizado -> alObjetivoActualizado(m)
            is MensajeDelHub.Despegar -> alDespegar(m)
            is MensajeDelHub.Traspaso -> alTraspaso(m)
            is MensajeDelHub.Cancelacion -> alCancelacion(m)
            is MensajeDelHub.AcuseDeEmergencia -> if (cola.alAcuse(m)) enviarLaCola()
            is MensajeDelHub.AcuseDeFoto -> if (cola.alAcuseDeFoto(m)) enviarLaCola()
        }
    }

    // ---- A: el que pide el relevo ----

    /**
     * Al entrar en regreso por batería con un patrullaje en curso, A pide que
     * otro dron siga la ruta desde el nodo hacia el que volaba (RELEVOS §2.1).
     */
    private fun pedirRelevoDePatrullaSiHaceFalta() {
        if (!patrullaEnCurso || pedidos.containsKey(PedidoDeRelevo.PATRULLA)) return
        val r = route ?: return
        val desde = (if (_state.value == PatrolState.PATROLLING) proximoWaypoint else resumeWaypoint)
            .coerceIn(0, r.waypoints.size - 1)
        val p = PedidoDeRelevo(UUID.randomUUID().toString(), PedidoDeRelevo.PATRULLA, routeId = r.id, fromIndex = desde)
        pedidos[PedidoDeRelevo.PATRULLA] = p
        enviarPedido(p, reloj())
        log("Pidió un relevo para seguir la ruta \"${r.name}\" desde el nodo ${desde + 1}")
    }

    /**
     * Siguiendo un objetivo con la alerta ya acusada, por debajo del umbral de
     * relevo A pide que otro dron venga a tomarlo (RELEVOS §3.1).
     */
    private fun pedirRelevoDeSeguimientoSiHaceFalta(t: Telemetry) {
        if (_state.value !in ESTADOS_DE_SEGUIMIENTO) return
        val s = seguimiento ?: return
        val alertId = s.alertId ?: return
        if (s.decision != "PENDING" && s.decision != "VALIDATED") return
        if (pedidos.containsKey(PedidoDeRelevo.SEGUIMIENTO) || soltando?.liberado == false) return
        if (!(t.batteryPct < Autonomia.umbralDeRelevo(t.pctParaVolver))) return
        val ahora = reloj()
        if (ahora - finDelUltimoPedidoDeSeguimientoMs < REINTENTO_TRAS_FIN_MS) return
        val p = PedidoDeRelevo(UUID.randomUUID().toString(), PedidoDeRelevo.SEGUIMIENTO, alertId = alertId)
        pedidos[PedidoDeRelevo.SEGUIMIENTO] = p
        enviarPedido(p, ahora)
        aviso("Batería al ${t.batteryPct.toInt()}%: se pidió un relevo para el objetivo de la alerta #$alertId")
    }

    private fun enviarPedido(p: PedidoDeRelevo, ahora: Long) {
        val mensaje = if (p.motivo == PedidoDeRelevo.PATRULLA) {
            MensajesDeLaApp.relayRequestPatrulla(p.ref, p.routeId ?: return, p.fromIndex ?: 0)
        } else {
            val t = lastTelemetry
            p.segundosDisponibles = t?.let { Autonomia.segundosDisponibles(it.batteryPct, it.pctParaVolver, consumo.pctPorS) }
            MensajesDeLaApp.relayRequestSeguimiento(p.ref, p.alertId ?: return, p.segundosDisponibles)
        }
        p.enviado(ahora)
        commandCenter.enviar(mensaje)
    }

    /** `relay_status`: solo el que trae el `ref` de un pedido propio. Uno terminal hace olvidar el pedido. */
    private fun alEstadoDelPedido(m: MensajeDelHub.EstadoDelPedido) {
        val p = pedidos.values.firstOrNull { it.ref == m.ref } ?: run {
            log("relay_status de un pedido que no es el vigente: se ignora")
            return
        }
        val antes = p.estado
        p.aplicar(m, reloj())
        if (antes != m.estado) aviso(textoDelEstado(p, m))
        if (m.terminal) {
            pedidos.remove(p.motivo)
            if (p.motivo == PedidoDeRelevo.SEGUIMIENTO) {
                finDelUltimoPedidoDeSeguimientoMs = reloj()
                cerrarLaVentana()
            }
        }
    }

    private fun textoDelEstado(p: PedidoDeRelevo, m: MensajeDelHub.EstadoDelPedido): String {
        val que = if (p.motivo == PedidoDeRelevo.PATRULLA) "de patrulla" else "de seguimiento"
        val quien = m.relevo?.displayName ?: "otro dron"
        return when (m.estado) {
            "RESERVADO", "ORDENADO" -> "Relevo $que: $quien asignado"
            "EN_CAMINO" -> "Relevo $que en camino: $quien" + (m.etaS?.let { " (llega en unos ${it.toInt()} s)" } ?: "")
            "TRASPASO" -> "Relevo $que: $quien tomó el objetivo"
            "SIN_RELEVO" -> "Relevo $que: por ahora no hay ningún dron disponible"
            "COMPLETADO" -> "Relevo $que completado"
            else -> "Relevo $que terminado: ${m.estado.lowercase()}" + (m.motivoFin?.let { " ($it)" } ?: "")
        }
    }

    /**
     * La ventana de gracia (RELEVOS §3.5): con un relevo en camino que llega a
     * tiempo, A sigue sobre el objetivo hasta [VentanaDeGracia.DURACION_MS]
     * aunque haya llegado a su umbral de regreso. true si sigue.
     */
    private fun sigueEnLaVentana(t: Telemetry): Boolean {
        if (_state.value !in ESTADOS_DE_SEGUIMIENTO) return false
        val p = pedidos[PedidoDeRelevo.SEGUIMIENTO]
        val ahora = reloj()
        val abierta = ventanaHastaMs
        if (abierta == null && ventanaUsada) return false
        if (p == null || !VentanaDeGracia.puedeSeguir(p, ahora, t.batteryPct, t.pctParaVolver, consumo.pctPorS, abierta)) {
            if (abierta != null) log("Se cierra la ventana de gracia: el relevo no llegó a tiempo")
            cerrarLaVentana()
            return false
        }
        if (abierta == null) {
            ventanaHastaMs = ahora + VentanaDeGracia.DURACION_MS
            ventanaUsada = true
            p.fase = FaseDelOrigen.VENTANA
            aviso(
                "Batería al ${t.batteryPct.toInt()}%: espera a ${p.relevo?.displayName ?: "su relevo"} sobre el objetivo " +
                    "hasta ${VentanaDeGracia.DURACION_MS / 1000} s más",
            )
        }
        return true
    }

    private fun cerrarLaVentana() {
        ventanaHastaMs = null
        pedidos[PedidoDeRelevo.SEGUIMIENTO]?.let { if (it.fase == FaseDelOrigen.VENTANA) it.fase = FaseDelOrigen.PEDIDO }
    }

    /**
     * A deja el objetivo antes del traspaso (RELEVOS §3.8): llegó a su piso, el
     * DJI tomó el control, una orden lo sacó o perdió la señal. El hub le pasa
     * la alerta a B si viene en camino. Quien llama manda además el
     * TRACKING_ENDED con la última posición (terminarSeguimiento).
     */
    private fun abandonarRelevoDeSeguimiento(motivo: String) {
        val p = pedidos.remove(PedidoDeRelevo.SEGUIMIENTO) ?: return
        cerrarLaVentana()
        finDelUltimoPedidoDeSeguimientoMs = reloj()
        val relayId = p.relayId ?: return
        if (p.estado == "TRASPASO") return
        commandCenter.enviar(MensajesDeLaApp.relayAbandon(relayId, motivo))
        log("Suelta el objetivo antes del traspaso ($motivo): se avisa al Comando Central")
    }

    /**
     * `relay_done` (RELEVOS §3.5): B ya tomó el objetivo. A lo suelta SIN
     * TRACKING_ENDED de pérdida (el hub registra el traspaso), se aleja en
     * horizontal a su altura, hacia su base, y recién lejos arranca el regreso
     * y manda `relay_released` (ver [revisarSoltando]). Con el control tomado
     * el dron es del operador: solo suelta el objetivo.
     */
    private fun alTraspaso(m: MensajeDelHub.Traspaso) {
        val previo = soltando
        if (previo != null && previo.relayId == m.relayId) {
            // Ya atendido (el hub lo reenvía al reconectar): si ya se alejó, lo vuelve a confirmar.
            if (previo.alejado) commandCenter.enviar(MensajesDeLaApp.relayReleased(previo.relayId))
            return
        }
        val p = pedidos[PedidoDeRelevo.SEGUIMIENTO]
        val s = seguimiento
        if (p == null || p.relayId != m.relayId || s == null || s.alertId != m.alertId) {
            log("relay_done que no es del seguimiento en curso: se ignora")
            return
        }
        soltarElObjetivo(p, s, m.relevadoPor.displayName)
    }

    /**
     * A llegó a su umbral de regreso con B ya en la toma (el último
     * `relay_status` dice TRASPASO): suelta como con el `relay_done`, que está
     * por llegar. true si fue así.
     */
    private fun soltarSiYaLoTomaron(): Boolean {
        val p = pedidos[PedidoDeRelevo.SEGUIMIENTO]?.takeIf { it.estado == "TRASPASO" && it.relayId != null } ?: return false
        val s = seguimiento?.takeIf { _state.value in ESTADOS_DE_SEGUIMIENTO } ?: return false
        soltarElObjetivo(p, s, p.relevo?.displayName ?: "su relevo")
        return true
    }

    private fun soltarElObjetivo(p: PedidoDeRelevo, s: Seguimiento, relevadoPor: String) {
        val relayId = p.relayId ?: return
        val ahora = reloj()
        val e = s.rastreador.estimar(ahora)
        seguimiento = null
        candidato = null
        cerrarLaVentana()
        p.fase = FaseDelOrigen.SOLTANDO
        soltando = Soltando(relayId, e.lat, e.lon, ahora)
        aviso("Relevado por $relevadoPor: se aleja del objetivo y vuelve a la base")
        val t = lastTelemetry
        if (!controlTomado) {
            val dron = controller.estado.value
            val (lat, lon) = Alejamiento.punto(
                e.lat, e.lon, t?.lat ?: Double.NaN, t?.lon ?: Double.NaN, dron.puntoDeRetornoLat, dron.puntoDeRetornoLon,
            )
            pasarA(PatrolState.PAUSED)
            // En horizontal y a su altura: volarHacia no la cambia.
            if (!dronAlMando) controller.volarHacia(lat, lon)
        }
        t?.let(::revisarSoltando)
    }

    /** Hasta dónde puede bajar la batería mientras A termina de alejarse del objetivo. */
    private fun pisoDelAlejamiento(pctParaVolver: Double): Double =
        Autonomia.piso(pctParaVolver) - Autonomia.MARGEN_SOBRE_EL_PISO_PCT

    /** A se está alejando del objetivo que soltó (PAUSED, todavía sin liberarlo). */
    private fun alejandoseDelObjetivo(): Boolean = soltando?.liberado == false && _state.value == PatrolState.PAUSED

    /** A soltando: a [Alejamiento.DISTANCIA_M] del objetivo lo libera y, si seguía alejándose, vuelve. */
    private fun revisarSoltando(t: Telemetry) {
        val s = soltando ?: return
        if (s.liberado || !Alejamiento.seAlejo(s.objetivoLat, s.objetivoLon, t.lat, t.lon)) return
        s.liberado = true
        s.alejado = true
        pedidos.remove(PedidoDeRelevo.SEGUIMIENTO)
        commandCenter.enviar(MensajesDeLaApp.relayReleased(s.relayId))
        log("Ya está a más de ${Alejamiento.DISTANCIA_M.toInt()} m del objetivo: lo libera")
        if (_state.value == PatrolState.PAUSED && controller.estado.value.enVuelo) {
            regresar("Relevado: el dron se alejó del objetivo y vuelve a la base")
        }
    }

    /**
     * A que no logra alejarse en [ALEJAMIENTO_MAXIMO_MS] (el dron no avanza, la
     * orden no salió) vuelve igual, sin `relay_released`: no se alejó, y B no
     * puede bajar creyendo que sí. El hub lo completa solo a los 30 s.
     */
    private fun vencerElAlejamiento(ahora: Long) {
        val s = soltando ?: return
        if (!alejandoseDelObjetivo() || ahora - s.desdeMs < ALEJAMIENTO_MAXIMO_MS) return
        if (!controller.estado.value.enVuelo) return
        s.liberado = true
        pedidos.remove(PedidoDeRelevo.SEGUIMIENTO)
        regresar(
            "Relevado, pero no logró alejarse del objetivo en ${ALEJAMIENTO_MAXIMO_MS / 1000} s: el dron vuelve a la base",
        )
    }

    /**
     * `landing_at_base` (RELEVOS §2.3): A empezó a bajar en SU base al final de
     * un regreso por batería con un relevo de patrulla pedido. Sale una vez; sin
     * conexión, al reconectar. En otra base no: ese relevo ya salió con el
     * `rth_diverted`.
     */
    private fun avisarQueBajaEnSuBase() {
        if (_state.value != PatrolState.RETURNING_HOME_BATTERY || desvio != null || emergencia != null) return
        val p = pedidos[PedidoDeRelevo.PATRULLA] ?: return
        if (p.aterrizajeAvisado) return
        val routeId = p.routeId ?: return
        p.aterrizajeAvisado = true
        p.fase = FaseDelOrigen.ATERRIZANDO
        val (lat, lon) = posicionActual()
        enviarOGuardar(MensajesDeLaApp.landingAtBase(p.ref, p.relayId, bases?.propiaId, lat, lon, routeId, p.fromIndex ?: 0))
    }

    // ---- B: el que va a relevar ----

    /**
     * Una orden de relevo (`relay_start` o `relay_tracking`). La repetida se
     * contesta igual, sin volver a empezar la cuenta; otra con un relevo ya en
     * curso se rechaza (`ocupado`); si no, la disponibilidad se reevalúa ENTERA
     * y se acepta o se rechaza. Al aceptar, el mando virtual se habilita en el
     * suelo antes de arrancar la cuenta regresiva (RELEVOS §2.4).
     */
    private fun alOrdenDeRelevo(relayId: Long, crear: (Long) -> RelevoAsignado) {
        val activo = relevo
        if (activo?.relayId == relayId || (activo == null && respuestas.containsKey(relayId))) {
            respuestas[relayId]?.let { commandCenter.enviar(it) }
            log("Orden repetida del relevo #$relayId: se contesta igual que antes")
            return
        }
        if (activo != null || participaComoOrigen()) {
            val detalle = activo?.let { "ya está en el relevo #${it.relayId}" } ?: "es el origen de otro relevo"
            responder(relayId, MensajesDeLaApp.relayReject(relayId, "ocupado", detalle))
            return
        }
        val r = crear(reloj())
        val motivo = motivoParaNoDespegar()
        if (motivo != null) {
            responder(relayId, MensajesDeLaApp.relayReject(relayId, "no_disponible", motivo))
            aviso("Se rechazó el relevo de ${r.de.displayName}: $motivo")
            return
        }
        relevo = r
        responder(relayId, MensajesDeLaApp.relayAccept(relayId))
        publicarCuenta(r, reloj())
        aviso(
            if (r.esSeguimiento) {
                "Relevo: ${r.de.displayName} necesita que este dron tome el objetivo que sigue"
            } else {
                "Relevo: ${r.de.displayName} vuelve a base y este dron va a seguir su ruta"
            },
        )
        tareaDelRelevo = scope.launch { habilitarMandoVirtual(r) }
    }

    private fun responder(relayId: Long, mensaje: JSONObject) {
        respuestas[relayId] = mensaje
        commandCenter.enviar(mensaje)
    }

    /** Una orden inválida con un `relayId` válido: `relay_reject mensaje_invalido`, salvo que sea la que ya se cumple. */
    private fun alOrdenInvalida(m: MensajeDelHub.OrdenInvalida) {
        log("Orden de relevo #${m.relayId} que no cumple el contrato: ${m.detalle}")
        if (relevo?.relayId == m.relayId) return
        responder(m.relayId, MensajesDeLaApp.relayReject(m.relayId, "mensaje_invalido", m.detalle))
    }

    /**
     * Con el dron en el suelo, antes de encender los motores (RELEVOS §2.4): un
     * mando virtual que no se habilita se descubre acá y B contesta
     * `relay_reject` sin despegar.
     */
    private suspend fun habilitarMandoVirtual(r: RelevoAsignado) {
        val habilitado = try {
            controller.habilitarMandoVirtualEnTierra()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            log("El mando virtual no se pudo habilitar: ${e.message}")
            false
        }
        enSerie {
            if (relevo !== r) return@enSerie
            if (!habilitado) {
                rechazarAceptado(r, "virtual_stick", "la aeronave no habilitó el mando virtual en el suelo")
                return@enSerie
            }
            r.cuentaDesdeMs = reloj()
            publicarCuenta(r, reloj())
            log("Mando virtual habilitado en el suelo: arranca la cuenta regresiva de ${CUENTA_REGRESIVA_MS / 1000} s")
        }
    }

    private fun motivoParaNoDespegar(): String? = Disponibilidad.motivoParaNo(condicionesParaRelevar(enUnRelevo = false))

    /** Lo que hace B en cada vuelta del lazo, según la fase. */
    private fun avanzarRelevo(r: RelevoAsignado, ahora: Long) {
        when (r.fase) {
            FaseDelRelevo.CUENTA_REGRESIVA -> {
                val desde = r.cuentaDesdeMs ?: return
                // Mientras corre la cuenta todo se sigue mirando: el operador
                // pudo apagar el interruptor, tomar el control o cambiar la batería.
                motivoParaNoDespegar()?.let {
                    rechazarAceptado(r, "no_disponible", it)
                    return
                }
                publicarCuenta(r, ahora)
                if (ahora - desde < CUENTA_REGRESIVA_MS) return
                if (r.esSeguimiento) {
                    // A está en el aire sobre el objetivo: B no espera ninguna orden más.
                    despegarParaRelevar(r, ahora)
                } else {
                    r.fase = FaseDelRelevo.ESPERANDO_DESPEGUE
                    publicarCuenta(r, ahora)
                    if (r.goRecibido) despegarParaRelevar(r, ahora) else log("Cuenta terminada: espera que ${r.de.displayName} esté abajo para despegar")
                }
            }
            // El relay_go despega en el acto (ver alDespegar); acá solo se
            // sigue mirando que no haya dejado de estar disponible, y el tope.
            FaseDelRelevo.ESPERANDO_DESPEGUE -> {
                motivoParaNoDespegar()?.let {
                    rechazarAceptado(r, "no_disponible", it)
                    return
                }
                if (ahora - r.aceptadoMs > ESPERA_DEL_GO_MAXIMA_MS) {
                    olvidarRelevo(r)
                    aviso("El relevo de ${r.de.displayName} venció sin la orden de despegar: el dron no despega")
                }
            }
            FaseDelRelevo.DESPEGANDO -> if (ahora - (r.despegueDesdeMs ?: ahora) > SUBIDA_MAXIMA_MS) {
                fallaLaSubida(r, "no terminó de subir en ${SUBIDA_MAXIMA_MS / 1000} s")
            }
            FaseDelRelevo.EN_CAMINO -> if (_state.value == PatrolState.RELEVANDO && !dronAlMando) transitar(r, ahora)
            FaseDelRelevo.TRASPASO -> if (_state.value == PatrolState.RELEVANDO && !dronAlMando) sostenerLaToma(r, ahora)
        }
    }

    /**
     * El despegue de B: la única orden de un relevo que sale sin una persona que
     * la apriete en ese momento, así que antes se reevalúa la disponibilidad
     * ENTERA y el interruptor de espera se apaga (vale una sola vez). Patrulla:
     * la ruta de A desde su nodo, con el mismo camino que `start_route`.
     * Seguimiento: sube en vertical, por su propia columna, a la altura de tránsito.
     */
    private fun despegarParaRelevar(r: RelevoAsignado, ahora: Long) {
        motivoParaNoDespegar()?.let {
            rechazarAceptado(r, "no_disponible", it)
            return
        }
        apagarEspera("despegó para relevar a ${r.de.displayName}")
        r.fase = FaseDelRelevo.DESPEGANDO
        r.despegueDesdeMs = ahora
        _cuentaRegresiva.value = null
        olvidarElUltimoProblema()
        val ruta = r.ruta
        if (ruta != null) {
            route = ruta
            patrullaEnCurso = true
            lastReachedWaypoint = r.fromIndex
            proximoWaypoint = r.fromIndex
            resumeWaypoint = r.fromIndex
            pasarA(PatrolState.PATROLLING)
            controller.startRoute(ruta, r.fromIndex)
            report("PATROL_STARTED", "Relevo de ${r.de.displayName}: patrullaje de la ruta \"${ruta.name}\" desde el nodo ${r.fromIndex + 1}")
        } else {
            r.alturaDeTransito = Aproximacion.alturaDeTransito(r.aAlt)
            pasarA(PatrolState.RELEVANDO)
            controller.despegarHasta(r.alturaDeTransito)
            log("Despega para relevar a ${r.de.displayName}: sube a ${r.alturaDeTransito.toInt()} m")
        }
    }

    /** B llegó arriba: en patrulla ya está volando la ruta (`relay_ready`); en seguimiento arranca el tránsito. */
    private fun alLlegarArriba(r: RelevoAsignado) {
        if (r.esSeguimiento) {
            r.fase = FaseDelRelevo.EN_CAMINO
            r.ultimaOrdenMs = Long.MIN_VALUE / 2
            aviso("En el aire: va hacia el objetivo de ${r.de.displayName}")
            transitar(r, reloj())
        } else {
            commandCenter.enviar(MensajesDeLaApp.relayReady(r.relayId))
            olvidarRelevo(r)
            aviso("Relevo de ${r.de.displayName}: patrullando su ruta")
        }
    }

    /**
     * La subida de B falló (un rechazo del dron o el tiempo): nunca queda
     * suspendido a media altura. En el aire aterriza y avisa `relay_abort`; si
     * todavía no despegó, es un `relay_reject` (RELEVOS §2.6).
     */
    private fun fallaLaSubida(r: RelevoAsignado, detalle: String) {
        if (controller.estado.value.enVuelo) {
            abortarRelevo(r, "subida", detalle)
            pasarA(PatrolState.PAUSED)
            controller.land()
            report("LANDING", "Falló la subida del relevo ($detalle): el dron aterriza donde está")
        } else {
            rechazarAceptado(r, "no_disponible", detalle)
            pasarA(enReposo())
        }
    }

    /** B en tránsito: hacia el punto de toma de donde va a estar el objetivo; al llegar, lo toma. */
    private fun transitar(r: RelevoAsignado, ahora: Long) {
        val o = r.objetivo ?: return
        val t = lastTelemetry?.takeIf { it.tienePosicion } ?: return
        val (eLat, eLon) = Aproximacion.estimacion(o, r.objetivoRecibidoMs, ahora)
        if (Aproximacion.llegoALaToma(eLat, eLon, t.lat, t.lon)) {
            tomarElObjetivo(r, ahora, null)
            return
        }
        if (ahora - r.ultimaOrdenMs < INTERVALO_ORDEN_DE_TRANSITO_MS) return
        r.ultimaOrdenMs = ahora
        val (lat, lon) = Aproximacion.destinoDeTransito(o, r.objetivoRecibidoMs, ahora, t.lat, t.lon)
        controller.volarHacia(lat, lon)
    }

    /**
     * En RELEVANDO, una detección de la misma clase a menos de
     * [PUERTA_DE_TOMA_M] de la estimación adelanta la toma (RELEVOS §3.4).
     */
    private fun tomarAntesSiLoVe(d: Deteccion, pose: Telemetry, ahora: Long) {
        val r = relevo ?: return
        if (r.fase != FaseDelRelevo.EN_CAMINO) return
        val o = r.objetivo ?: return
        val (eLat, eLon) = Aproximacion.estimacion(o, r.objetivoRecibidoMs, ahora)
        val visto = puntosEnElTerreno(d, pose)
            .filter { it.clase == o.tipo && !it.sinPosicion }
            .minByOrNull { Geo.distanciaM(eLat, eLon, it.lat, it.lon) } ?: return
        if (Geo.distanciaM(eLat, eLon, visto.lat, visto.lon) > PUERTA_DE_TOMA_M) return
        log("Vio al objetivo de ${r.de.displayName} antes de llegar: adelanta la toma")
        tomarElObjetivo(r, ahora, visto)
    }

    /**
     * La toma (RELEVOS §3.5): B siembra su rastreador con la estimación de A
     * (más su propia detección, si la tiene), adopta el seguimiento de la misma
     * alerta y avisa `relay_ready`. Queda a la distancia de toma y por encima de
     * A hasta que A se aleje (ver [sostenerLaToma]).
     */
    private fun tomarElObjetivo(r: RelevoAsignado, ahora: Long, visto: Punto?) {
        val o = r.objetivo ?: return
        val rastreador = Aproximacion.sembrar(o, r.objetivoRecibidoMs, ahora)
        if (visto != null) rastreador.actualizar(visto.lat, visto.lon, ahora)
        val e = rastreador.estimar(ahora)
        seguimiento = Seguimiento(rastreador, "relevo-${r.relayId}", e.lat, e.lon, adoptado = true).also {
            it.alertId = r.alertId
            it.decision = r.decision
        }
        candidato = null
        r.fase = FaseDelRelevo.TRASPASO
        r.ultimaOrdenMs = Long.MIN_VALUE / 2
        // La altura a la que A lo venía siguiendo es a la que B baja después.
        r.alturaDeA = r.aAlt
        commandCenter.enviar(MensajesDeLaApp.relayReady(r.relayId))
        aviso("Llegó al objetivo de ${r.de.displayName}: espera que se aleje para bajar a seguirlo")
        sostenerLaToma(r, ahora)
    }

    /**
     * B en el traspaso: sostiene el punto de toma, por encima de A, y recién
     * con A lejos o retirado baja EN EL LUGAR a la altura de seguimiento y
     * empieza a orbitarlo o seguirlo (RELEVOS §3.5). Si el hub deja de mandar
     * `relay_target` ([SILENCIO_DEL_HUB_MS]) el relevo ya terminó de su lado y
     * no queda quién le diga dónde está A: baja igual.
     */
    private fun sostenerLaToma(r: RelevoAsignado, ahora: Long) {
        if (seguimiento == null) return
        if (r.bajandoDesdeMs != null) {
            revisarLaBajada(r, ahora)
            return
        }
        val silencio = ahora - r.ultimoTargetMs > SILENCIO_DEL_HUB_MS
        if (Aproximacion.puedeBajar(r) || silencio) {
            val porque = if (silencio) "sin noticias de ${r.de.displayName}" else "${r.de.displayName} ya se alejó"
            bajarASeguir(r, ahora, porque)
            return
        }
        if (ahora - r.ultimaOrdenMs < INTERVALO_ORDEN_DE_TRANSITO_MS) return
        val t = lastTelemetry?.takeIf { it.tienePosicion } ?: return
        r.ultimaOrdenMs = ahora
        val e = seguimiento?.rastreador?.estimar(ahora) ?: return
        val (lat, lon) = Aproximacion.puntoDeToma(e.lat, e.lon, t.lat, t.lon)
        controller.volarHacia(lat, lon)
    }

    /**
     * A ya no está encima: B baja en vertical, donde está, a la altura de
     * seguimiento. Sin posición o ya a esa altura, empieza a seguir en el acto.
     */
    private fun bajarASeguir(r: RelevoAsignado, ahora: Long, porque: String) {
        val t = lastTelemetry
        val h = Aproximacion.alturaDeSeguimiento(r.alturaDeA, r.alturaDeTransito)
        r.alturaDeBajada = h
        if (t == null || !t.tienePosicion || !t.altM.isFinite() || t.altM <= h + Aproximacion.TOLERANCIA_DE_ALTURA_M) {
            completarElRelevo(r, porque)
            return
        }
        r.bajandoDesdeMs = ahora
        controller.volarHaciaA(t.lat, t.lon, h)
        aviso("${porque.replaceFirstChar { it.uppercase() }}: el dron baja a ${h.toInt()} m para seguir al objetivo")
    }

    /** B bajando: llegó a la altura (o se venció la bajada) y empieza a seguir. */
    private fun revisarLaBajada(r: RelevoAsignado, ahora: Long) {
        val desde = r.bajandoDesdeMs ?: return
        val alt = lastTelemetry?.altM ?: Double.NaN
        val llego = alt.isFinite() && alt <= r.alturaDeBajada + Aproximacion.TOLERANCIA_DE_ALTURA_M
        if (llego || ahora - desde >= BAJADA_MAXIMA_MS) completarElRelevo(r, "${r.de.displayName} ya se alejó")
    }

    /** El relevo terminó para B: el seguimiento es suyo (adoptado, sin ruta) y lo orbita o lo sigue. */
    private fun completarElRelevo(r: RelevoAsignado, porque: String) {
        val s = seguimiento ?: return
        olvidarRelevo(r)
        volverAlObjetivo(s, "Relevo de ${r.de.displayName} completo ($porque): el dron sigue al objetivo")
    }

    /**
     * `relay_target`: la estimación nueva del objetivo y dónde está A. Uno con
     * un `ts` del hub que no es más nuevo que el último deja la estimación
     * anterior (nunca se compara con el reloj propio, docs/PROTOCOLS.md §2.b),
     * pero su `origen` se lee igual: `sin_enlace` y `retirado` llevan el `ts`
     * del último objetivo válido, y descartar un `retirado` por eso dejaría a B
     * esperando arriba a un A que ya se fue.
     */
    private fun alObjetivoActualizado(m: MensajeDelHub.ObjetivoActualizado) {
        val r = relevo
        if (r == null || r.relayId != m.relayId || m.alertId != r.alertId) {
            log("relay_target de un relevo que no es el activo: se ignora")
            return
        }
        val ahora = reloj()
        // El hub sigue hablando de este relevo, aunque sea con un objetivo viejo.
        r.ultimoTargetMs = ahora
        if (m.origen != "en_linea") {
            if (m.origen == "retirado" && !r.aRetirado) log("${r.de.displayName} ya no sigue al objetivo")
            r.anotarOrigen(m.origen)
        }
        if (m.ts <= r.ultimoTs) return
        r.ultimoTs = m.ts
        r.objetivo = m.objetivo
        r.objetivoRecibidoMs = ahora
        r.decision = m.decision
        r.anotarOrigen(m.origen)
        r.aLat = m.aLat
        r.aLon = m.aLon
        r.aAlt = m.aAlt
        val s = seguimiento
        if (s != null && s.adoptado) {
            s.decision = m.decision
            // Mientras B no lo vio con su cámara, la estimación de A es la mejor que hay.
            if (s.rastreador.detecciones == 0) {
                seguimiento = Seguimiento(Aproximacion.sembrar(m.objetivo, ahora, ahora), s.ref, s.origenLat, s.origenLon, adoptado = true)
                    .also {
                        it.alertId = s.alertId
                        it.decision = s.decision
                    }
            }
        }
    }

    /** `relay_go`: A ya está abajo. Si la cuenta terminó despega ya; si no, al terminarla. */
    private fun alDespegar(m: MensajeDelHub.Despegar) {
        val r = relevo
        if (r == null || r.relayId != m.relayId || r.esSeguimiento) {
            log("relay_go de un relevo que no es el activo: no despega")
            return
        }
        r.goRecibido = true
        log("${r.de.displayName} ya está abajo: el dron puede despegar")
        if (r.fase == FaseDelRelevo.ESPERANDO_DESPEGUE) despegarParaRelevar(r, reloj())
    }

    /** `relay_cancel`: a B le corta el relevo; a A (en una reconexión), le hace olvidar el pedido. */
    private fun alCancelacion(m: MensajeDelHub.Cancelacion) {
        val r = relevo
        if (r != null && r.relayId == m.relayId) {
            cancelarComoRelevo(r, m.motivo)
            return
        }
        val p = pedidos.values.firstOrNull { it.relayId == m.relayId }
        if (p != null) {
            pedidos.remove(p.motivo)
            if (p.motivo == PedidoDeRelevo.SEGUIMIENTO) cerrarLaVentana()
            log("El Comando Central dio por terminado el relevo #${m.relayId} (${m.motivo}): se olvida")
            return
        }
        log("relay_cancel de un relevo que no es el activo: se ignora")
    }

    /**
     * B ya no va: en tierra corta la cuenta o la espera y no despega; en el
     * aire vuelve a SU base, nunca a patrullar (docs/PROTOCOLS.md §2.b).
     */
    private fun cancelarComoRelevo(r: RelevoAsignado, motivo: String) {
        olvidarRelevo(r)
        val texto = "Se canceló el relevo de ${r.de.displayName} ($motivo)"
        if (r.fase == FaseDelRelevo.CUENTA_REGRESIVA || r.fase == FaseDelRelevo.ESPERANDO_DESPEGUE) {
            aviso("$texto: el dron no despega")
            return
        }
        if (seguimiento?.adoptado == true) terminarSeguimiento("se canceló el relevo ($motivo)")
        regresar("$texto: el dron vuelve a su base", PatrolState.RETURNING_HOME)
    }

    private fun olvidarRelevo(r: RelevoAsignado) {
        if (relevo !== r) return
        relevo = null
        _cuentaRegresiva.value = null
        tareaDelRelevo?.cancel()
        tareaDelRelevo = null
    }

    /** B todavía en tierra deja de ir: `relay_reject` (vale en ORDENADO o EN_CAMINO, siempre antes de despegar). */
    private fun rechazarAceptado(r: RelevoAsignado, motivo: String, detalle: String) {
        olvidarRelevo(r)
        responder(r.relayId, MensajesDeLaApp.relayReject(r.relayId, motivo, detalle))
        aviso("El dron no despega para el relevo de ${r.de.displayName}: $detalle")
    }

    /** B en el aire deja de ir: `relay_abort`. Qué hace el dron lo decide quien llama. */
    private fun abortarRelevo(r: RelevoAsignado, motivo: String, detalle: String?) {
        olvidarRelevo(r)
        commandCenter.enviar(MensajesDeLaApp.relayAbort(r.relayId, motivo, detalle))
        aviso("Se abortó el relevo de ${r.de.displayName}" + (detalle?.let { ": $it" } ?: ""))
    }

    private fun publicarCuenta(r: RelevoAsignado, ahora: Long) {
        val desde = r.cuentaDesdeMs
        val restanteMs = if (desde == null) CUENTA_REGRESIVA_MS else (CUENTA_REGRESIVA_MS - (ahora - desde)).coerceAtLeast(0L)
        _cuentaRegresiva.value = CuentaRegresiva(
            relayId = r.relayId,
            de = r.de.displayName,
            segundos = ceil(restanteMs / 1_000.0).toInt(),
            esSeguimiento = r.esSeguimiento,
            habilitando = desde == null,
            esperandoQueBajeA = r.fase == FaseDelRelevo.ESPERANDO_DESPEGUE,
        )
    }

    /** «Cancelar» en la cuenta regresiva del teléfono: el dron no despega (`relay_reject cancelado_en_campo`). */
    fun cancelarRelevoEnCampo() = enSerie {
        val r = relevo ?: return@enSerie
        if (r.fase != FaseDelRelevo.CUENTA_REGRESIVA && r.fase != FaseDelRelevo.ESPERANDO_DESPEGUE) return@enSerie
        rechazarAceptado(r, "cancelado_en_campo", "Cancelado desde el teléfono")
    }

    // ---- El regreso: base propia, otra base o última ubicación ----

    /**
     * Todo regreso pasa por acá (docs/RELEVOS.md §1): elige la base propia, otra
     * base o el protocolo de última ubicación según [Autonomia.decidirRegreso].
     * Por batería, además, pide el relevo de la patrulla que deja.
     *
     * Sin frenar: el regreso a base ya es la orden que manda y un vuelo
     * estacionario se la comería. Lo que importa es soltar el mando, para que el
     * watchdog no le corte el RTH a los 1,5 s.
     */
    private fun regresar(motivo: String, estado: PatrolState = PatrolState.RETURNING_HOME_BATTERY) {
        val porBateria = estado == PatrolState.RETURNING_HOME_BATTERY
        if (porBateria) pedirRelevoDePatrullaSiHaceFalta()
        val t = lastTelemetry
        val destino = if (porBateria && t != null) evaluarRegreso(t).destino else Autonomia.Destino.BasePropia
        // Si el desvío o el §5 no se pueden (el DJI tiene el vuelo y no se le
        // puede cortar), queda el regreso de siempre: el suyo.
        val resuelto = when (destino) {
            Autonomia.Destino.UltimaUbicacion -> dispararUltimaUbicacion()
            is Autonomia.Destino.OtraBase -> iniciarDesvio(destino.base, destino.alcanzable)
            Autonomia.Destino.BasePropia -> false
        }
        if (resuelto) return
        pasarA(estado)
        if (!dronAlMando) controller.returnHome()
        report(if (porBateria) "RTH_LOW_BATTERY" else "RTH_MANUAL", motivo)
    }

    private fun evaluarRegreso(t: Telemetry): Autonomia.Decision {
        val dron = controller.estado.value
        val b = bases
        val decision = Autonomia.decidirRegreso(
            Autonomia.Situacion.desde(
                reloj(), t, dron.umbralCriticoPct, dron.puntoDeRetornoLat, dron.puntoDeRetornoLon,
                b?.bases.orEmpty(), b?.propiaId, consumo.pctPorKm, consumo.pctPorS,
            ),
            memoriaDelRegreso,
        )
        memoriaDelRegreso = decision.memoria
        return decision
    }

    /**
     * Con cada telemetría de un regreso: ¿sigue llegando a su base? ¿llegó al
     * desvío? ¿hay que bajar ya? El regreso por batería se revisa siempre; el
     * que pidió una persona (o el de B al terminar un relevo), recién con la
     * batería en el umbral de regreso, que desde ahí es uno por batería como
     * cualquier otro: el regreso a tiempo manda.
     */
    private fun revisarRegreso(t: Telemetry) {
        if (emergencia != null || !controller.estado.value.enVuelo) return
        when (_state.value) {
            PatrolState.RETURNING_HOME_BATTERY -> Unit
            PatrolState.RETURNING_HOME -> if (!(t.batteryPct <= Autonomia.umbralDeRegreso(t.pctParaVolver))) return
            else -> return
        }
        val d = desvio
        // Bajando en la base del desvío: ya está en una base.
        if (d?.llego == true) return
        if (d != null && cercaDelPuntoDeVisitantes(d, t, LLEGADA_AL_DESVIO_M)) {
            llegarAlDesvio()
            return
        }
        when (val destino = evaluarRegreso(t).destino) {
            Autonomia.Destino.UltimaUbicacion -> dispararUltimaUbicacion()
            is Autonomia.Destino.OtraBase -> if (d?.base?.id != destino.base.id) iniciarDesvio(destino.base, destino.alcanzable)
            Autonomia.Destino.BasePropia -> Unit
        }
    }

    private fun cercaDelPuntoDeVisitantes(d: Desvio, t: Telemetry?, radioM: Double): Boolean {
        if (t == null || !Geo.esPosicionValida(t.lat, t.lon)) return false
        val (lat, lon) = Autonomia.puntoDeVisitantes(d.base)
        return Geo.distanciaM(t.lat, t.lon, lat, lon) <= radioM
    }

    /**
     * Si el propio DJI tiene el vuelo, el único intento de quitárselo para un
     * desvío o para el §5 (RELEVOS §4): solo a su regreso por batería —el del
     * botón del control es una persona pidiendo el dron, y el aterrizaje
     * crítico no se discute— y una sola vez por vuelo; si lo vuelve a arrancar,
     * se lo deja seguir. null si no se puede; true si se le acaba de cortar;
     * false si la app ya tenía el vuelo.
     */
    private fun tomarElVueloDelDji(): Boolean? {
        val toma = tomaDelDron ?: return false
        if (toma != MotivoDelDron.RTH_BATERIA || regresoDelDjiCortado) return null
        regresoDelDjiCortado = true
        tomaDelDron = null
        controller.cancelarRegreso()
        log("El dron venía en su propio regreso por batería: se lo corta, una sola vez, para elegir dónde bajar")
        return true
    }

    /**
     * Desvío a otra base (RELEVOS §4), el caso extremo: se apaga y se corta el
     * regreso propio del DJI (un solo intento), el failsafe pasa a "aterrizar"
     * (si se corta el enlace, mejor bajar donde está que volver a una casa que
     * no alcanza), el aterrizaje deja de confirmarse solo, se prueba fijar el
     * punto de retorno en la base destino, y el dron sube a la altura de
     * tránsito y vuela al punto de visitantes de [base]. Al llegar fija ahí el
     * punto de retorno y aterriza ([llegarAlDesvio]).
     *
     * Devuelve false si no se pudo: el DJI tiene el vuelo y no se le puede
     * cortar (se lo deja seguir y el §5 lo baja cuando corresponda).
     */
    private fun iniciarDesvio(base: BaseDelHub, alcanzable: Boolean): Boolean {
        val cortadoRecien = tomarElVueloDelDji() ?: return false
        val primero = desvio == null
        desvio = Desvio(base)
        if (primero) {
            controller.permitirRthPropioPorBateria(false)
            // El regreso que pidió la app (el del DJI, si hacía falta, ya se cortó).
            if (!cortadoRecien) controller.cancelarRegreso()
            controller.fijarFailsafeAterrizar(true)
            confirmarAterrizajesALaMano()
        }
        val (lat, lon) = Autonomia.puntoDeVisitantes(base)
        // El rechazo es lo esperado (el MSDK limita la distancia) y queda registrado.
        controller.fijarPuntoDeRetornoEn(lat, lon)
        if (_state.value != PatrolState.RETURNING_HOME_BATTERY) pasarA(PatrolState.RETURNING_HOME_BATTERY)
        // Sube a la altura de tránsito antes de ir: es un camino que nunca voló.
        controller.volarHaciaA(lat, lon, alturaDelDesvio())
        val p = pedidos[PedidoDeRelevo.PATRULLA]
        p?.fase = FaseDelOrigen.DESVIADO
        val (aquiLat, aquiLon) = posicionActual()
        val mensaje = MensajesDeLaApp.rthDiverted(p?.relayId, base.id, aquiLat, aquiLon, "otra_base")
        rthDivertedVigente = mensaje
        commandCenter.enviar(mensaje)
        report(
            "RTH_LOW_BATTERY",
            "La batería no alcanza para volver a su base: se desvía a la base \"${base.nombre}\"" +
                if (alcanzable) "" else " (la más cercana; si no llega, aterriza antes donde esté)",
        )
        _avisos.tryEmit("Desvío a la base \"${base.nombre}\": la batería no alcanza para volver a la propia")
        return true
    }

    /** Un desvío sube a la altura de tránsito, nunca baja: si ya viene más alto, sigue a esa. */
    private fun alturaDelDesvio(): Double = maxOf(alturaActual(), Autonomia.ALTURA_TRANSITO_M)

    /**
     * Dónde está el dron para los avisos al hub: la última posición GPS de
     * verdad (sin fix, la de antes de perderlo, que es la que sirve para ir a
     * buscarlo). NaN si nunca tuvo una: los mensajes la mandan como null.
     */
    private fun posicionActual(): Pair<Double, Double> {
        val t = ultimaPosicionValida ?: return Double.NaN to Double.NaN
        return t.lat to t.lon
    }

    /** La altura de la última telemetría; 0 si no hay o no es un número. */
    private fun alturaActual(): Double = lastTelemetry?.altM?.takeIf { it.isFinite() } ?: 0.0

    /** Llegó al punto de visitantes del desvío: fija ahí el punto de retorno y aterriza. */
    private fun llegarAlDesvio() {
        val d = desvio ?: return
        if (d.llego || dronAlMando) return
        d.llego = true
        controller.fijarPuntoDeRetornoAqui()
        controller.land()
        log("Llegó al punto de visitantes de la base \"${d.base.nombre}\": fija ahí el punto de retorno y aterriza")
    }

    /**
     * Una persona dio una orden, o apretó el regreso en el control: el desvío
     * en curso se abandona (manda la orden) y el DJI recupera su regreso propio
     * y su failsafe de fábrica.
     */
    private fun abandonarElDesvio(porque: String) {
        val d = desvio ?: return
        log("$porque: se abandona el desvío a la base \"${d.base.nombre}\"")
        desvio = null
        rthDivertedVigente = null
        memoriaDelRegreso = Autonomia.Memoria()
        restaurarFailsafes()
    }

    /** Las bases conocidas, incluida la del desvío aunque ya no esté en la lista. */
    private fun todasLasBases(): List<BaseDelHub> =
        (bases?.bases.orEmpty() + listOfNotNull(desvio?.base, memoriaDelRegreso.comprometida)).distinctBy { it.id }

    // ---- La confirmación del aterrizaje en un lugar sin revisar (RELEVOS §4) ----

    /** Desde acá el controlador no confirma solo: el pedido llega como [FlightEvent.AterrizajePideConfirmacion]. */
    private fun confirmarAterrizajesALaMano() {
        if (confirmacionManual) return
        confirmacionManual = true
        reintentosDeAterrizaje = 0
        controller.fijarConfirmacionDeAterrizaje(false)
    }

    /**
     * El dron pide confirmar el aterrizaje. En la base de un desvío o en el §5
     * —un lugar que nadie revisó— no se confirma solo: se corre
     * [CORRIMIENTO_PARA_ATERRIZAR_M] y reintenta, hasta
     * [REINTENTOS_DE_ATERRIZAJE] veces, y recién con la batería en el crítico +
     * [CONFIRMAR_SOBRE_EL_CRITICO_PCT] se confirma donde esté. Fuera de eso se
     * confirma como siempre.
     */
    private fun alPedirConfirmarElAterrizaje() {
        if (!confirmacionManual) {
            controller.confirmarAterrizaje()
            return
        }
        confirmacionPendiente = true
        if (confirmarSiNoQuedaBateria(lastTelemetry)) return
        val t = lastTelemetry?.takeIf { it.tienePosicion }
        if (reintentosDeAterrizaje >= REINTENTOS_DE_ATERRIZAJE || t == null || dronAlMando) {
            aviso(
                "El dron pide confirmar el aterrizaje en un lugar sin revisar: queda estacionario y se confirma " +
                    "recién con la batería en el crítico",
            )
            return
        }
        reintentosDeAterrizaje++
        confirmacionPendiente = false
        corriendoseParaAterrizar = true
        // Cada reintento hacia otro lado: primero al norte, después al este.
        val rumbo = if (reintentosDeAterrizaje == 1) 0.0 else 90.0
        val (lat, lon) = puntoA(t.lat, t.lon, rumbo, CORRIMIENTO_PARA_ATERRIZAR_M)
        controller.volarHacia(lat, lon)
        aviso(
            "El dron pidió confirmar el aterrizaje: se corre ${CORRIMIENTO_PARA_ATERRIZAR_M.toInt()} m y lo vuelve " +
                "a intentar ($reintentosDeAterrizaje de $REINTENTOS_DE_ATERRIZAJE)",
        )
    }

    /** Con la batería en el crítico + 1, el aterrizaje pendiente se confirma donde esté. true si lo confirmó. */
    private fun confirmarSiNoQuedaBateria(t: Telemetry?): Boolean {
        if (!confirmacionPendiente || t == null) return false
        val critico = controller.estado.value.umbralCriticoPct
        if (!critico.isFinite() || !(t.batteryPct <= critico + CONFIRMAR_SOBRE_EL_CRITICO_PCT)) return false
        confirmacionPendiente = false
        controller.confirmarAterrizaje()
        aviso("Batería al ${t.batteryPct.toInt()}%: se confirma el aterrizaje donde está")
        return true
    }

    /** Vuelve a que el controlador confirme solo, y olvida los reintentos (al tocar tierra o por una orden). */
    private fun olvidarLaConfirmacion() {
        reintentosDeAterrizaje = 0
        confirmacionPendiente = false
        corriendoseParaAterrizar = false
        if (!confirmacionManual) return
        confirmacionManual = false
        controller.fijarConfirmacionDeAterrizaje(true)
    }

    /** El punto a [distanciaM] de ([lat], [lon]) con rumbo [rumboGrados]. */
    private fun puntoA(lat: Double, lon: Double, rumboGrados: Double, distanciaM: Double): Pair<Double, Double> {
        val rad = Math.toRadians(rumboGrados)
        return (lat + distanciaM * cos(rad) / Geo.METROS_POR_GRADO_LAT) to
            (lon + distanciaM * sin(rad) / Geo.metrosPorGradoLon(lat))
    }

    // ---- El protocolo de última ubicación (RELEVOS §5) ----

    /**
     * El §5 por la cuenta de la app. false si el DJI tiene el vuelo y no se le
     * puede cortar: se lo deja seguir y, si fuerza el aterrizaje, corre la
     * variante que solo usa la cámara.
     */
    private fun dispararUltimaUbicacion(): Boolean {
        if (tomarElVueloDelDji() == null) {
            if (!ultimaUbicacionPostergada) {
                ultimaUbicacionPostergada = true
                log("La batería ya no alcanza para ninguna base, pero el propio dron tiene el vuelo: se lo deja seguir")
            }
            return false
        }
        iniciarUltimaUbicacion("autonomia", conControl = true)
        return true
    }

    /**
     * Protocolo de última ubicación (RELEVOS §5): ya no llega a ninguna base, o
     * el propio DJI fuerza el aterrizaje fuera de base. Avisa al hub
     * (`rth_diverted` con `emergencia`, y `emergency_landing` por la cola
     * persistente), fija la posición en la pantalla y corre la secuencia de
     * fotos: con el vuelo si la app lo tiene, solo la cámara si no.
     */
    private fun iniciarUltimaUbicacion(motivo: String, conControl: Boolean) {
        val actual = emergencia
        if (actual != null) {
            // Ya en curso: si el DJI tomó el vuelo, sigue solo con la cámara.
            if (!conControl && actual.conControl) {
                actual.conControl = false
                tareaDeEmergencia?.cancel()
                tareaDeEmergencia = lanzarSecuencia(actual)
            }
            return
        }
        val porAutonomia = motivo == "autonomia"
        val (lat, lon) = posicionActual()
        val alt = alturaActual()
        relevo?.let { abortarRelevo(it, if (porAutonomia) "bateria" else "dji", "aterrizaje de emergencia") }
        abandonarRelevoDeSeguimiento(if (porAutonomia) "piso" else "dji")
        terminarSeguimiento("aterrizaje de emergencia: la batería ya no alcanza para ninguna base")
        // El failsafe "aterrizar" del desvío queda: ahora es justo lo que se quiere.
        desvio = null
        if (conControl) confirmarAterrizajesALaMano()
        val p = pedidos[PedidoDeRelevo.PATRULLA]
        p?.fase = FaseDelOrigen.DESVIADO
        val desviado = MensajesDeLaApp.rthDiverted(p?.relayId, null, lat, lon, "emergencia")
        rthDivertedVigente = desviado
        commandCenter.enviar(desviado)
        val e = EmergenciaEnCurso(UUID.randomUUID().toString(), conControl)
        emergencia = e
        cola.abrir(
            MensajesDeLaApp.emergencyLanding(e.ref, motivo, lat, lon, alt, lastTelemetry?.batteryPct ?: 0.0, horaDelTelefono()),
        )
        enviarLaCola()
        val conPosicion = Geo.esPosicionValida(lat, lon)
        if (conPosicion) _ultimaUbicacion.value = UbicacionFijada(lat, lon, alt, aterrizado = false)
        pasarA(PatrolState.ATERRIZAJE_EMERGENCIA)
        report(
            "LANDING",
            (if (porAutonomia) "La batería ya no alcanza para ninguna base" else "El propio dron fuerza el aterrizaje por batería crítica") +
                ": aterrizaje de emergencia en ${if (conPosicion) coordenadas(lat, lon) else "una posición sin GPS"}, con fotos del lugar",
            lat = lat.takeIf { conPosicion },
            lon = lon.takeIf { conPosicion },
        )
        tareaDeEmergencia = lanzarSecuencia(e)
    }

    /**
     * La secuencia de fotos corre en su propio Job (que [pasarA] cancela al
     * salir del estado), pero cada orden al dron pasa por la puerta de la
     * patrulla y solo sale si el estado sigue en la emergencia: cancelar un Job
     * no frena una orden que ya estaba saliendo.
     */
    private fun lanzarSecuencia(e: EmergenciaEnCurso): Job = scope.launch {
        // El Job propio entra en la cuenta: uno reemplazado (el DJI tomó el
        // vuelo y sigue la variante de la cámara) no da ni una orden más.
        val yo = coroutineContext.job
        val sigue = { yo.isActive && emergencia === e && _state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        val secuencia = SecuenciaDeUltimaUbicacion(
            dron = controller,
            telemetria = { lastTelemetry },
            sigue = sigue,
            alcanzaParaOtroPaso = ::alcanzaParaOtroPaso,
            alFotografiar = { foto -> enSerie { alFotografiar(e, foto) } },
            reloj = reloj,
            pausa = pausaDeEmergencia,
            ordenar = { orden ->
                enSerie {
                    val puede = sigue()
                    if (puede) controller.orden()
                    puede
                }
            },
        )
        if (e.conControl) secuencia.conControl(puedeGirar = true) else secuencia.soloCamara()
    }

    /** Cada paso de la secuencia, solo si después queda batería ≥ disparo − 3 (RELEVOS §5). */
    private fun alcanzaParaOtroPaso(): Boolean {
        val t = lastTelemetry ?: return false
        val disparo = Autonomia.disparoDeUltimaUbicacion(t.pctParaAterrizar, controller.estado.value.umbralCriticoPct)
        if (!disparo.isFinite() || !t.batteryPct.isFinite()) return false
        val porSegundo = consumo.pctPorS.takeIf { it.isFinite() && it > 0.0 } ?: Autonomia.CONSUMO_POR_DEFECTO_PCT_POR_S
        val despues = t.batteryPct - porSegundo * DURACION_DE_UN_PASO_MS / 1_000.0
        return despues >= disparo - Autonomia.MARGEN_SOBRE_EL_CRITICO_PCT
    }

    private fun alFotografiar(e: EmergenciaEnCurso, foto: SecuenciaDeUltimaUbicacion.Foto) {
        val jpeg = FotoDeEmergencia.aBase64(foto.jpeg) ?: run {
            log("La foto ${foto.seq + 1} de la emergencia no es un JPEG que se pueda mandar: no sale")
            return
        }
        val t = foto.telemetria ?: lastTelemetry
        cola.agregarFoto(
            e.ref,
            MensajesDeLaApp.emergencyPhoto(
                e.ref, foto.seq, foto.tipo, foto.rumbo, foto.inclinacion,
                t?.lat ?: Double.NaN, t?.lon ?: Double.NaN, t?.altM ?: 0.0, jpeg, horaDelTelefono(),
            ),
        )
        log("Foto ${foto.tipo} (${foto.seq + 1}) del lugar del aterrizaje de emergencia")
        enviarLaCola()
    }

    /** La cola de la emergencia sale solo con el Comando Central conectado: sin él no se gastan los reintentos. */
    private fun enviarLaCola() {
        if (!commandCenter.connected.value) return
        cola.aEnviar(reloj()).forEach { commandCenter.enviar(it) }
    }

    private fun cerrarEmergencia(e: EmergenciaEnCurso) {
        val (lat, lon) = posicionActual()
        val alt = alturaActual()
        cola.agregarAterrizaje(e.ref, MensajesDeLaApp.emergencyLanded(e.ref, lat, lon, alt, horaDelTelefono()))
        enviarLaCola()
        if (Geo.esPosicionValida(lat, lon)) _ultimaUbicacion.value = UbicacionFijada(lat, lon, alt, aterrizado = true)
        emergencia = null
        tareaDeEmergencia?.cancel()
        tareaDeEmergencia = null
        bateriaPorCambiar = true
    }

    private fun aterrizoEnEmergencia() {
        pasarA(PatrolState.LANDED)
        val u = _ultimaUbicacion.value
        report(
            "LANDED",
            "Aterrizaje de emergencia: el dron quedó en ${u?.let { coordenadas(it.lat, it.lon) } ?: "una posición sin GPS"}. " +
                "Hay que ir a buscarlo y cambiarle la batería",
            lat = u?.lat,
            lon = u?.lon,
        )
    }

    /** Qué se cerró al tocar tierra (ver [alTocarTierra]). */
    private class Llegada(val enEmergencia: Boolean, val desvio: BaseDelHub?)

    /**
     * Lo que se cierra al tocar tierra: la emergencia (sale `emergency_landed`
     * con la última posición), el aviso `landed_at_base` al final de un regreso
     * a una base (nunca por un `land` de una persona), el desvío, los pedidos
     * de A y el interruptor de espera.
     */
    private fun alTocarTierra(): Llegada {
        val estado = _state.value
        val enEmergencia = emergencia
        val baseDelDesvio = desvio?.base
        apagarEspera("el dron aterrizó")
        relevo?.let { r ->
            if (r.fase != FaseDelRelevo.CUENTA_REGRESIVA && r.fase != FaseDelRelevo.ESPERANDO_DESPEGUE) {
                abortarRelevo(r, "otro", "el dron aterrizó")
            }
        }
        if (enEmergencia != null) {
            cerrarEmergencia(enEmergencia)
        } else if (estado in ESTADOS_DE_REGRESO) {
            val (lat, lon) = posicionActual()
            val base = baseDelDesvio?.id ?: bases?.propiaId
            enviarOGuardar(MensajesDeLaApp.landedAtBase(pedidos[PedidoDeRelevo.PATRULLA]?.relayId, base, lat, lon))
        }
        if (baseDelDesvio != null || enEmergencia != null) restaurarFailsafes()
        olvidarLaConfirmacion()
        desvio = null
        rthDivertedVigente = null
        memoriaDelRegreso = Autonomia.Memoria()
        pedidos.clear()
        cerrarLaVentana()
        soltando = null
        tomaDelDron = null
        regresoDelDjiCortado = false
        volverAlRecuperarLaSenial = false
        ultimaUbicacionPostergada = false
        return Llegada(enEmergencia != null, baseDelDesvio)
    }

    /**
     * El propio DJI le sacó el vuelo a la app ([FlightEvent.ElDronTomoElControl]).
     * Se corta todo lo que le daba órdenes (el relevo, el desvío, la secuencia
     * de fotos) y no se le vuelve a dar ninguna por cuenta propia —cada una
     * volvería a habilitar el mando virtual y a pelearle el control—; un
     * seguimiento termina con TRACKING_ENDED y, con relevo pedido,
     * `relay_abandon`. Si es su aterrizaje por batería crítica fuera de base,
     * corre la variante del §5 que solo usa la cámara.
     *
     * Dos excepciones: su regreso por pérdida de señal no le saca el vuelo a la
     * app para siempre (al volver el enlace decide la regla de siempre, ver
     * [alRecuperarLaSenial]); y durante un desvío, UN intento de cortar su
     * regreso por batería (RELEVOS §4); si lo vuelve a arrancar, se lo deja
     * seguir.
     */
    private fun alTomarElControlElDron(motivo: MotivoDelDron) {
        log("El propio dron tomó el control: ${motivo.descripcion}")
        if (motivo == MotivoDelDron.RTH_SENIAL) {
            if (controller.estado.value.enVuelo && _state.value !in ESTADOS_DE_REGRESO) {
                alPerderLaSenial("el propio dron arrancó su regreso por pérdida de señal", frenar = false)
            }
            return
        }
        val d = desvio
        if (motivo == MotivoDelDron.RTH_BATERIA && d != null && !d.llego && !regresoDelDjiCortado && !dronAlMando) {
            regresoDelDjiCortado = true
            controller.cancelarRegreso()
            val (lat, lon) = Autonomia.puntoDeVisitantes(d.base)
            controller.volarHaciaA(lat, lon, alturaDelDesvio())
            log("Durante el desvío el dron arrancó su propio regreso: se lo corta una sola vez y sigue hacia \"${d.base.nombre}\"")
            return
        }
        tomaDelDron = motivo
        val deCampo = motivo == MotivoDelDron.RTH_DEL_CONTROL
        relevo?.let { r ->
            if (r.fase == FaseDelRelevo.CUENTA_REGRESIVA || r.fase == FaseDelRelevo.ESPERANDO_DESPEGUE) {
                rechazarAceptado(r, "no_disponible", "el propio dron tomó el control (${motivo.descripcion})")
            } else {
                abortarRelevo(r, if (deCampo) "orden_de_campo" else "dji", motivo.descripcion)
            }
        }
        abandonarRelevoDeSeguimiento(if (deCampo) "orden_de_campo" else "dji")
        terminarSeguimiento("el propio dron tomó el control (${motivo.descripcion})")
        // El botón del control es una persona pidiendo el dron de vuelta: manda sobre el desvío.
        if (deCampo) abandonarElDesvio("Se apretó el regreso en el control")
        if (!controller.estado.value.enVuelo) return
        val estado = _state.value
        when (motivo) {
            MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA -> {
                val (lat, lon) = posicionActual()
                val dron = controller.estado.value
                val fuera = Autonomia.fueraDeBase(lat, lon, todasLasBases(), dron.puntoDeRetornoLat, dron.puntoDeRetornoLon)
                if (fuera) {
                    iniciarUltimaUbicacion("bateria_critica_dji", conControl = false)
                } else if (estado !in ESTADOS_DE_REGRESO) {
                    pasarA(PatrolState.RETURNING_HOME_BATTERY)
                }
                return
            }
            MotivoDelDron.RTH_BATERIA -> if (estado != PatrolState.RETURNING_HOME_BATTERY && emergencia == null) {
                pedirRelevoDePatrullaSiHaceFalta()
                pasarA(PatrolState.RETURNING_HOME_BATTERY)
                report("RTH_LOW_BATTERY", "El propio dron arrancó su regreso por batería baja")
            }
            MotivoDelDron.RTH_DEL_CONTROL -> if (estado != PatrolState.RETURNING_HOME && emergencia == null) {
                pasarA(PatrolState.RETURNING_HOME)
                report("RTH_MANUAL", "Se apretó el regreso a base en el control físico: el dron vuelve solo")
            }
            // Un regreso que el dron arrancó sin que se sepa por qué: se lo deja volver.
            else -> if (estado !in ESTADOS_DE_REGRESO) pasarA(PatrolState.RETURNING_HOME)
        }
        // Una emergencia que la app volaba sigue solo con la cámara.
        emergencia?.let { if (it.conControl) iniciarUltimaUbicacion("bateria_critica_dji", conControl = false) }
    }

    /** La hora del teléfono para los `ts` de la emergencia: dato para el registro, nunca para ordenar. */
    private fun horaDelTelefono(): Long = reloj()

    // ---- El lazo de los relevos ----

    private suspend fun relevosTicker() {
        while (true) {
            delay(INTERVALO_RELEVOS_MS)
            enSerie { avanzarLosRelevos(reloj()) }
        }
    }

    private fun avanzarLosRelevos(ahora: Long) {
        if (espera.vencido(ahora)) apagarEspera("pasaron ${EsperaParaRelevos.VENCIMIENTO_MS / 60_000} minutos")
        pedidos.values.toList().forEach { if (it.debeEnviar(ahora)) enviarPedido(it, ahora) }
        relevo?.let { avanzarRelevo(it, ahora) }
        vencerElAlejamiento(ahora)
        enviarLaCola()
    }

    /** Un aviso de los relevos: al registro local y a la pantalla. */
    private fun aviso(texto: String) {
        log(texto)
        _avisos.tryEmit(texto)
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
