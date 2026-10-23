package com.tesis.dronepatrol.drone

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Vinculacion
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sign
import kotlin.math.sin
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Dron simulado: reproduce el comportamiento del Mini 4 Pro que le importa a la
 * lógica de patrullaje (despegue, vuelo por waypoints, órbita, RTH, aterrizaje,
 * drenaje de batería, failsafe por pérdida de enlace RC) sin necesitar hardware.
 *
 * Arranca **en el suelo con los motores apagados**, igual que el dron real, y
 * solo "Comenzar patrullaje" lo despega: así la pantalla de operación se puede
 * probar entera en el emulador. Las pruebas del vuelo lo crean con
 * [arrancaEnElAire] para no pagar el despegue en cada caso.
 *
 * Para los relevos, el desvío y la última ubicación (docs/RELEVOS.md) simula
 * además lo que el propio DJI decide por su cuenta: gasta batería según
 * [modelo] e informa su autonomía como lo hace el real con
 * `KeyLowBatteryRTHInfo`; arranca su regreso inteligente cuando la batería ya
 * solo alcanza para volver (salvo que la app se lo haya negado con
 * [permitirRthPropioPorBateria]), y aterriza donde esté al llegar a su umbral
 * crítico. Las pruebas pueden además provocar una toma del control a mano
 * ([simularTomaDelDron]) o un control que no cede el mando virtual
 * ([rechazarElMandoVirtual]).
 *
 * Las órdenes y el tick de vuelo pasan de a uno por [cerrojo]: la patrulla
 * comanda desde sus corrutinas y el lazo de vuelo corre en [despachador], y
 * entrelazados una orden podía quedar pisada por la mitad de un tick (ver
 * [tomarElControl]). Los eventos salen con el estado ya escrito, así quien los
 * recibe puede contestar en el acto.
 *
 * @param despachador dónde corren los lazos de vuelo y de video. Las pruebas
 *   pasan uno con reloj virtual y, junto con [reloj], hacen pasar minutos de
 *   vuelo sin dormir.
 * @param reloj la hora que ve el dron (telemetría, failsafe, extrapolación).
 */
class SimulatedDroneController(
    private val arrancaEnElAire: Boolean = false,
    private val modelo: ModeloDeBateria = ModeloDeBateria(),
    private val despachador: CoroutineDispatcher = Dispatchers.Default,
    private val reloj: () -> Long = System::currentTimeMillis,
) : DroneController {

    private companion object {
        // El Obelisco, sobre la 9 de Julio: el mismo punto en el que abren los
        // mapas de la consola y en el que están las bases de demostración.
        const val HOME_LAT = -34.6037
        const val HOME_LON = -58.3816
        const val TICK_MS = 500L
        // El video simulado sale al MISMO ritmo que el del dron real (5 cuadros
        // por segundo a la consola, uno cada 500 ms a la detección): así el
        // reparto de PatrolManager da los mismos números en el banco de pruebas
        // que en el campo, que es justamente para lo que está el simulador.
        const val FRAME_MS = CuadroDeVideo.INTERVALO_CUADRO_MS
        // Igual que el dron real: si pierde el enlace RC por más de este tiempo,
        // el propio dron inicia RTH (failsafe), sin intervención de la app.
        const val FAILSAFE_TIMEOUT_MS = 6_000L
        const val ARRIVE_THRESHOLD_M = 6.0
        const val METERS_PER_DEG_LAT = Geo.METROS_POR_GRADO_LAT
        // Altura a la que patrulla cuando la orden no trae una (ver altM)
        const val ALTURA_CRUCERO_M = 40.0
        // Techo del mando manual: 120 m es el límite legal de vuelo (ANAC).
        const val ALTURA_MAXIMA_M = 120.0
        // Piso de una altura pedida al despegar: menos es a ras del suelo.
        const val ALTURA_MINIMA_M = 2.0
        // Velocidad vertical del despegue: la del dron real en automático. El
        // aterrizaje y el final del regreso bajan a la del modelo de batería.
        // El mando manual va más despacio (MandoVirtual).
        const val VELOCIDAD_VERTICAL_AUTO_MS = 5.0
        // Alcance del enlace RC: a esta distancia de la base la señal ya está al mínimo
        const val SIGNAL_RANGE_M = 1_200.0
        const val SIGNAL_MIN_PCT = 10
        const val SATELITES_SIMULADOS = 14
        const val MODELO = "Simulado"
        const val SERIE = "SIM-0001"
        // Altura a la que deja al dron el despegue en el lugar: la del despegue
        // automático del SDK de DJI.
        const val ALTURA_DESPEGUE_EN_EL_LUGAR_M = 1.2
        // Velocidad tangencial de la órbita: la misma que el dron real.
        const val VELOCIDAD_ORBITA_MS = Navegacion.VELOCIDAD_ORBITA_MS
        // Más allá de esto la estimación del objetivo ya no se extrapola.
        const val EXTRAPOLACION_MAXIMA_MS = 3_000L
        // Hasta dónde llega el gimbal simulado: el rango del contrato
        // (manual_gimbal), del nadir a un poco por arriba del horizonte.
        const val INCLINACION_MINIMA = -90.0
        const val INCLINACION_MAXIMA = 30.0
        // Para un modo autónomo (apuntarCamara) por arriba del horizonte no
        // sirve: el real la recorta igual.
        const val INCLINACION_MAXIMA_DE_LA_APP = 0.0
        // Giro en el lugar: el Mini gira en modo ángulo a unos 90°/s; así una
        // panorámica de cuatro fotos no se come el tope de 20 s del protocolo
        // de última ubicación (RELEVOS §5) en giros.
        const val VELOCIDAD_GIRO_GRADOS_S = 90.0
        // Lo que dice el real cuando el control (en S o C) no cede el mando.
        const val RECHAZO_DEL_MANDO_VIRTUAL =
            "el dron no aceptó el mando virtual en el suelo: no despega. Revisá que el control esté en modo N"
        val HORA: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss", Locale.US)
    }

    /**
     * STICK es el mando virtual del operador; el resto los ordena la patrulla.
     * IDLE con altura cero es "en el suelo, motores apagados"; con altura es
     * vuelo estacionario sin orden (como queda el dron real después de despegar
     * a mano).
     */
    private enum class Mode { IDLE, TAKING_OFF, FLY_ROUTE, ORBIT, FOLLOW, RTH, HOLD, GOTO, STICK, LANDING }

    /**
     * Qué hace el dron al terminar el despegue: la ruta que lo pidió, quedar
     * suspendido obedeciendo al mando (despegue en el lugar) o quedar
     * estacionario a la altura pedida (el despegue de un relevo).
     */
    private enum class DespuesDelDespegue { RUTA, MANDO, ESTACIONARIO }

    /** Un punto, entero: el lazo nunca lee la latitud de uno y la longitud de otro. */
    private data class Punto(val lat: Double, val lon: Double)

    /** Por acá pasan las órdenes y el tick de vuelo, de a uno (ver la clase). */
    private val cerrojo = Any()

    override val estado: StateFlow<EstadoDelDron>
        get() = _estado
    private val _estado = MutableStateFlow(
        EstadoDelDron(
            sdkListo = true,
            conectado = false,
            modelo = MODELO,
            enVuelo = false,
            satelites = SATELITES_SIMULADOS,
            baseFijada = true,
            detalle = "Simulador sin conectar",
            vinculacion = Vinculacion.VINCULADA,
            puntoDeRetornoLat = HOME_LAT,
            puntoDeRetornoLon = HOME_LON,
            umbralCriticoPct = modelo.umbralCriticoPct,
        ),
    )
    override val telemetry = MutableSharedFlow<Telemetry>(replay = 1, extraBufferCapacity = 8)
    override val videoFrames = MutableSharedFlow<ByteArray>(extraBufferCapacity = 4)
    override val cuadrosParaDeteccion = MutableSharedFlow<ByteArray>(extraBufferCapacity = 2)
    override val flightEvents = MutableSharedFlow<FlightEvent>(extraBufferCapacity = 8)

    private val scope = CoroutineScope(SupervisorJob() + despachador)
    private var loops: Job? = null

    // El modo lo escribe el hilo que comanda (hold/gotoPoint/...) y lo lee el
    // lazo de vuelo: volátil para que el cambio se vea enseguida.
    @Volatile
    private var mode = Mode.IDLE
    private var homeLat = HOME_LAT
    private var homeLon = HOME_LON
    private var lat = HOME_LAT
    private var lon = HOME_LON
    // Altura sobre la base. Cero es el suelo. El mando manual es el único que
    // la mueve a gusto; los modos autónomos van a [alturaObjetivo].
    @Volatile
    private var altM = 0.0
    // A qué altura quiere estar la orden en curso: la del waypoint en ruta, la
    // de crucero en el resto. Sube o baja hacia ella en cada tick.
    @Volatile
    private var alturaObjetivo = ALTURA_CRUCERO_M

    /**
     * La altura que pidieron [despegarHasta] o [cambiarAltura] y que conservan
     * [volarHacia] y [girarEnElLugar]; null si ninguna la pidió o la olvidó otra
     * orden (ver DroneController.cambiarAltura).
     */
    @Volatile
    private var alturaPedida: Double? = null
    @Volatile
    private var battery = 100.0
    private var route: PatrolRoute? = null
    private var targetWaypoint = 0
    private var orbitCenterLat = 0.0
    private var orbitCenterLon = 0.0
    private var orbitRadiusM = 30.0
    private var orbitAngle = 0.0

    /** A dónde va en GOTO (gotoPoint o volarHacia). */
    @Volatile
    private var destino: Punto? = null

    /**
     * El GOTO en curso es de [volarHacia]: va a la altura pedida y el destino
     * se corrige sin relanzar nada. El de [gotoPoint] va a crucero.
     */
    @Volatile
    private var volandoHacia = false

    /** Último destino al que llegó y avisó: reenviarlo estando ahí no repite el aviso. */
    @Volatile
    private var destinoAlcanzado: Punto? = null

    // Objetivo que se sigue en FOLLOW: la última estimación que mandó la
    // patrulla y cuándo, para extrapolarla con su velocidad entre una y otra.
    // Se guarda el objeto entero para que el lazo nunca vea media estimación.
    private class ObjetivoSeguido(val lat: Double, val lon: Double, val vNorteMs: Double, val vEsteMs: Double, val desdeMs: Long)

    @Volatile
    private var objetivoSeguido: ObjetivoSeguido? = null

    @Volatile
    private var despuesDelDespegue = DespuesDelDespegue.RUTA

    // Rumbo hacia el objetivo mientras se mueve; estacionario conserva el último
    @Volatile
    private var heading = 0.0

    /** Rumbo al que gira en el lugar (girarEnElLugar); solo vale en HOLD. */
    @Volatile
    private var rumboPedido: Double? = null

    // Inclinación de la cámara: la de patrulla, salvo en órbita y siguiendo,
    // donde apunta al objetivo, y salvo que el operador la mueva desde la
    // consola (igual que el dron real).
    @Volatile
    private var gimbalPitch = Telemetry.GIMBAL_PATRULLA

    // Últimos ejes del mando virtual, ya convertidos a velocidades. Los escribe
    // el hilo del WebSocket y los lee el lazo de vuelo: se guarda el objeto
    // entero (y no cuatro campos sueltos) para que el lazo nunca vea media
    // orden aplicada.
    @Volatile
    private var ejesMando = MandoVirtual.NEUTRO

    /** Mientras es true no llega telemetría ni video a la app (enlace RC cortado). */
    @Volatile
    var signalLost = false
        private set
    @Volatile
    private var signalLostAt = 0L

    /** Último motivo rechazado, para avisar por transición y no por intento. */
    @Volatile
    private var ultimoRechazo: String? = null

    // ---- Lo que el propio DJI decide (docs/RELEVOS.md §4 y §5) ----

    /** Regreso, descenso y tomas del control: la misma cuenta que usa el dron real. */
    private val seguidor = SeguidorDelRegreso()

    /** El regreso en curso lo pidió la app (returnHome), no el propio dron. */
    @Volatile
    private var regresoDeLaApp = false

    /**
     * El dron se quedó con el vuelo y la app no lo comanda hasta que aterrice
     * (ver [TomaDelDron.bloqueaLaApp]); null si la app tiene el mando.
     */
    @Volatile
    private var tomaDelDron: MotivoDelDron? = null

    @Volatile
    private var rthPropioPermitido = true

    /** El DJI ya preguntó (y arrancó, o se le dijo que no) su regreso por batería en este vuelo. */
    @Volatile
    private var rthPorBateriaPreguntado = false

    @Volatile
    private var failsafeAterrizar = false

    @Volatile
    private var informaAutonomia = true

    /** El control simulado no cede el mando virtual (ver [rechazarElMandoVirtual]). */
    @Volatile
    private var mandoVirtualRechazado = false

    /** Fase del "objeto que deambula" del video: la comparten los cuadros y las fotos. */
    @Volatile
    private var faseDelVideo = 0.0

    fun setSignalLost(lost: Boolean) {
        synchronized(cerrojo) {
            signalLost = lost
            if (lost) signalLostAt = reloj()
        }
    }

    fun forceLowBattery() {
        fijarBateria(24.0)
    }

    fun rechargeBattery() {
        fijarBateria(100.0)
    }

    /** Pone la batería en [pct] (recortada a 0..100): para llegar a un umbral sin volar media hora. */
    fun fijarBateria(pct: Double) {
        synchronized(cerrojo) {
            if (pct.isFinite()) battery = pct.coerceIn(0.0, 100.0)
        }
    }

    /**
     * Con false, la telemetría sale con la autonomía en NaN, como un DJI que
     * todavía no la informó: sin autonomía informada la app no se desvía ni
     * estira el regreso (RELEVOS §0). El propio dron la sigue usando para su
     * regreso inteligente, igual que el real.
     */
    fun informarAutonomia(informa: Boolean) {
        informaAutonomia = informa
    }

    /**
     * Gancho de prueba: el control no cede el mando virtual, como el real con
     * el selector en S o C. [prepararDespegue] contesta que no y
     * [despegarHasta] no despega (RELEVOS §2.4: el relevo se rechaza sin haber
     * movido nada).
     */
    fun rechazarElMandoVirtual(rechaza: Boolean) {
        mandoVirtualRechazado = rechaza
    }

    /**
     * Gancho de prueba: el propio DJI toma el control como lo haría el real,
     * aunque la app le haya negado el regreso por batería (es justamente el caso
     * que el desvío tiene que aguantar, RELEVOS §4). En el suelo no pasa nada.
     *
     *  - [MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA]: aterriza donde está.
     *  - Los regresos: vuelve a casa por su cuenta; el de señal aterriza en vez
     *    de volver si la app fijó ese failsafe ([fijarFailsafeAterrizar]).
     *  - [MotivoDelDron.OTRO]: queda estacionario.
     *
     * Avisa [FlightEvent.ElDronTomoElControl] y, si el motivo lo pide
     * ([TomaDelDron.bloqueaLaApp]), rechaza las órdenes de vuelo hasta tocar el
     * suelo o hasta que la app corte el regreso ([cancelarRegreso]).
     */
    fun simularTomaDelDron(motivo: MotivoDelDron) {
        synchronized(cerrojo) { tomarElControl(motivo) }
    }

    /** Base real del dron que inició sesión (la simulación arranca y vuelve ahí). */
    fun setHome(lat: Double, lon: Double) {
        synchronized(cerrojo) {
            homeLat = lat
            homeLon = lon
            _estado.update { it.copy(puntoDeRetornoLat = lat, puntoDeRetornoLon = lon) }
            if (mode == Mode.IDLE && altM == 0.0) {
                this.lat = lat
                this.lon = lon
            }
        }
    }

    /** true con el dron en el suelo y los motores apagados. */
    private val enElSuelo: Boolean get() = mode == Mode.IDLE && altM <= 0.0

    override fun connect() {
        synchronized(cerrojo) {
            if (loops != null) return
            lat = homeLat
            lon = homeLon
            altM = if (arrancaEnElAire) ALTURA_CRUCERO_M else 0.0
            alturaObjetivo = ALTURA_CRUCERO_M
            battery = 100.0
            mode = Mode.IDLE
            ejesMando = MandoVirtual.NEUTRO
            ultimoRechazo = null
            olvidarElVuelo()
            publicarEstado()
            loops = scope.launch {
                launch { flightLoop() }
                launch { frameLoop() }
            }
        }
    }

    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) {
        synchronized(cerrojo) {
            if (rechazarSiElDronTieneElControl("seguir una ruta")) return
            despuesDelDespegue = DespuesDelDespegue.RUTA
            this.route = route
            targetWaypoint = fromWaypoint.coerceIn(0, route.waypoints.size - 1)
            gimbalPitch = Telemetry.GIMBAL_PATRULLA
            alturaPedida = null
            if (enElSuelo) {
                // Despegue automático: sube derecho a la altura del primer waypoint
                // y recién ahí arranca la ruta (ver DroneController.startRoute).
                alturaObjetivo = route.waypoints[targetWaypoint].alt.coerceIn(ALTURA_MINIMA_M, ALTURA_MAXIMA_M)
                arrancarDespegue()
                return
            }
            mode = Mode.FLY_ROUTE
        }
    }

    override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double) {
        synchronized(cerrojo) {
            if (rechazarEnElSuelo("orbitar")) return
            if (rechazarSiElDronTieneElControl("orbitar")) return
            orbitCenterLat = centerLat
            orbitCenterLon = centerLon
            orbitRadiusM = radiusM
            // Arranca (o sigue, si ya orbitaba y solo se corrió el centro) desde el
            // punto del círculo que tiene más cerca: con el ángulo fijo en cero el
            // dron cruzaba por encima del objetivo para ir al punto norte.
            orbitAngle = anguloDesdeElCentro(centerLat, centerLon)
            alturaObjetivo = ALTURA_CRUCERO_M
            alturaPedida = null
            gimbalPitch = Georreferencia.inclinacionParaOrbitar(altM, radiusM)
            mode = Mode.ORBIT
        }
    }

    override fun seguirObjetivo(lat: Double, lon: Double, vNorteMs: Double, vEsteMs: Double) {
        synchronized(cerrojo) {
            if (rechazarEnElSuelo("seguir al objetivo")) return
            if (rechazarSiElDronTieneElControl("seguir al objetivo")) return
            objetivoSeguido = ObjetivoSeguido(lat, lon, vNorteMs, vEsteMs, reloj())
            if (mode != Mode.FOLLOW) alturaObjetivo = ALTURA_CRUCERO_M
            alturaPedida = null
            mode = Mode.FOLLOW
        }
    }

    override fun despegarEnElLugar() {
        synchronized(cerrojo) {
            if (!enElSuelo) return
            alturaObjetivo = ALTURA_DESPEGUE_EN_EL_LUGAR_M
            alturaPedida = null
            despuesDelDespegue = DespuesDelDespegue.MANDO
            arrancarDespegue()
        }
    }

    /**
     * Estacionario. Con el despegue recién ordenado (todavía en el suelo) es no
     * despegar; a media subida se queda donde está, sin seguir subiendo, como el
     * real. Si no, va a la de crucero: así el operador no deja al dron a ras del
     * suelo al soltar el mando.
     */
    override fun hold() {
        synchronized(cerrojo) {
            if (enElSuelo || cancelarDespegueEnElSuelo(FlightEvent.Aterrizado)) return
            if (rechazarSiElDronTieneElControl("quedar estacionario")) return
            alturaObjetivo = if (mode == Mode.TAKING_OFF) altM else ALTURA_CRUCERO_M
            alturaPedida = null
            rumboPedido = null
            mode = Mode.HOLD
        }
    }

    override fun gotoPoint(lat: Double, lon: Double) {
        synchronized(cerrojo) {
            if (rechazarEnElSuelo("ir a un punto")) return
            if (rechazarSiElDronTieneElControl("ir a un punto")) return
            destino = Punto(lat, lon)
            volandoHacia = false
            alturaObjetivo = ALTURA_CRUCERO_M
            alturaPedida = null
            mode = Mode.GOTO
        }
    }

    override fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) {
        synchronized(cerrojo) {
            if (rechazarEnElSuelo("el mando manual")) return
            if (rechazarSiElDronTieneElControl("usar el mando manual")) return
            ejesMando = MandoVirtual.velocidades(pitch, roll, yaw, throttle)
            alturaPedida = null
            // Con los cuatro ejes en cero el modo igual pasa a STICK: el dron queda
            // en vuelo estacionario obedeciendo al mando, no volviendo a lo anterior.
            mode = Mode.STICK
        }
    }

    /**
     * La cámara queda en la inclinación pedida en el acto, en el suelo o en el
     * aire, y sale así en la próxima telemetría. El gimbal real tarda menos de
     * un segundo y la telemetría simulada sale cada medio: simular el recorrido
     * no le agregaría nada a lo que la consola ve. El modo no cambia; la órbita
     * y el seguimiento la vuelven a apuntar en su próximo tick, como el real.
     */
    override fun inclinarCamara(pitchGrados: Double) {
        if (!pitchGrados.isFinite()) return
        synchronized(cerrojo) { gimbalPitch = pitchGrados.coerceIn(INCLINACION_MINIMA, INCLINACION_MAXIMA) }
    }

    /**
     * Nada que tirar: acá la inclinación se aplica en el acto ([inclinarCamara]),
     * así que nunca queda una esperando que pueda llegar después de la orden
     * del modo siguiente. Tampoco se deshace la ya aplicada, igual que en el
     * real con la que el gimbal está cumpliendo.
     */
    override fun cancelarInclinacionManual() = Unit

    /**
     * Vuelve a la base a la altura de regreso y baja al llegar, avisando
     * [FlightEvent.DescendiendoEnBase] al empezar a bajar. Si el propio dron ya
     * estaba volviendo por su cuenta, la app lo adopta: el regreso sigue sin
     * cortes y el descenso se avisa igual (lo que necesita un relevo de
     * patrulla, RELEVOS §2.3). Un aterrizaje forzado por batería crítica no se
     * convierte en regreso. Con el despegue recién ordenado no despega: ya está
     * en su base.
     */
    override fun returnHome() {
        synchronized(cerrojo) {
            if (enElSuelo || cancelarDespegueEnElSuelo(FlightEvent.ArrivedHome)) return
            if (mode == Mode.LANDING && tomaDelDron == MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA) {
                rechazar("el dron está aterrizando por batería crítica: no puede volver a la base")
                return
            }
            // Ya vuelve por pedido de la app: pedirlo otra vez no es otro regreso
            // (y no puede volver a avisar el descenso).
            if (mode == Mode.RTH && regresoDeLaApp) return
            seguidor.alOrdenar(SeguidorDelRegreso.Orden.REGRESO)
            regresoDeLaApp = true
            alturaPedida = null
            if (mode == Mode.RTH) return
            alturaObjetivo = modelo.alturaDeRegresoM
            mode = Mode.RTH
        }
    }

    /** Aterriza donde está. Con el despegue recién ordenado no despega; a media subida, baja. */
    override fun land() {
        synchronized(cerrojo) {
            if (enElSuelo || cancelarDespegueEnElSuelo(FlightEvent.Aterrizado)) return
            regresoDeLaApp = false
            alturaPedida = null
            mode = Mode.LANDING
        }
    }

    /** El simulador no tiene control físico: nace vinculado y no hay nada que hacer. */
    override fun vincularControl() = Unit

    override fun cancelarVinculacion() = Unit

    override fun disconnect() {
        synchronized(cerrojo) {
            scope.coroutineContext.cancelChildren()
            loops = null
            mode = Mode.IDLE
            _estado.update { it.copy(conectado = false, controlConectado = false, enVuelo = false, detalle = "Simulador desconectado") }
        }
    }

    // ---- Relevos, desvío a otra base y última ubicación (docs/RELEVOS.md) ----

    /**
     * Sube derecho hasta [alturaM] (recortada a 2..120 m) a la velocidad del
     * despegue automático y queda estacionario ahí: no arranca ninguna ruta.
     * En el aire no hace nada, como el real; con el control que no cede el mando
     * virtual ([rechazarElMandoVirtual]) no despega.
     */
    override fun despegarHasta(alturaM: Double) {
        synchronized(cerrojo) {
            if (!enElSuelo || !alturaM.isFinite()) return
            if (mandoVirtualRechazado) {
                rechazar(RECHAZO_DEL_MANDO_VIRTUAL)
                return
            }
            alturaObjetivo = alturaM.coerceIn(ALTURA_MINIMA_M, ALTURA_MAXIMA_M)
            alturaPedida = alturaObjetivo
            despuesDelDespegue = DespuesDelDespegue.ESTACIONARIO
            arrancarDespegue()
        }
    }

    /**
     * Sube o baja hasta [alturaM] (recortada a 2..120 m) sin moverse en el
     * plano. Si estaba yendo hacia un punto ([volarHacia]), girando en el lugar
     * o subiendo en el despegue de un relevo, eso sigue y la altura cambia
     * mientras tanto; cualquier otra cosa se reemplaza por el estacionario.
     */
    override fun cambiarAltura(alturaM: Double) {
        synchronized(cerrojo) {
            if (!alturaM.isFinite()) return
            if (rechazarEnElSuelo("cambiar de altura")) return
            if (rechazarSiElDronTieneElControl("cambiar de altura")) return
            val altura = alturaM.coerceIn(ALTURA_MINIMA_M, ALTURA_MAXIMA_M)
            alturaPedida = altura
            alturaObjetivo = altura
            val sigueLoQueHacia = (mode == Mode.GOTO && volandoHacia) || mode == Mode.HOLD ||
                (mode == Mode.TAKING_OFF && despuesDelDespegue == DespuesDelDespegue.ESTACIONARIO)
            if (sigueLoQueHacia) return
            rumboPedido = null
            mode = Mode.HOLD
        }
    }

    /**
     * Va hacia el punto a la altura pedida ([cambiarAltura], [despegarHasta])
     * o, sin una, a la que tiene; no a la de crucero como [gotoPoint]. Llamarla
     * de nuevo en camino solo corrige el destino. Al llegar queda estacionario y
     * avisa [FlightEvent.GotoArrived], una vez por destino: reenviar el punto en
     * el que ya está no repite el aviso. Durante el despegue se rechaza: B sube
     * por su columna y recién arriba va a algún lado.
     */
    override fun volarHacia(lat: Double, lon: Double) {
        synchronized(cerrojo) {
            if (rechazarEnElSuelo("volar hacia un punto")) return
            if (mode == Mode.TAKING_OFF) {
                rechazar("el dron todavía está despegando: sube por su columna y recién arriba puede volar hacia un punto")
                return
            }
            if (rechazarSiElDronTieneElControl("volar hacia un punto")) return
            if (!Geo.esPosicionValida(lat, lon)) return
            val punto = Punto(lat, lon)
            if (mode == Mode.HOLD && destinoAlcanzado == punto && distanciaA(punto) < ARRIVE_THRESHOLD_M) return
            val yaVolandoHacia = mode == Mode.GOTO && volandoHacia
            destino = punto
            if (yaVolandoHacia) return
            volandoHacia = true
            val altura = alturaPedida ?: altM
            alturaPedida = altura
            alturaObjetivo = altura
            rumboPedido = null
            mode = Mode.GOTO
        }
    }

    /**
     * Gira la nariz hasta [rumboGrados] a [VELOCIDAD_GIRO_GRADOS_S] por el lado
     * más corto, sin moverse y a la altura pedida (o a la que tiene), y queda
     * estacionario. El rumbo nuevo se ve en [Telemetry.heading].
     */
    override fun girarEnElLugar(rumboGrados: Double) {
        synchronized(cerrojo) {
            if (!rumboGrados.isFinite()) return
            if (rechazarEnElSuelo("girar en el lugar")) return
            if (rechazarSiElDronTieneElControl("girar en el lugar")) return
            val altura = alturaPedida ?: altM
            alturaPedida = altura
            alturaObjetivo = altura
            rumboPedido = ((rumboGrados % 360.0) + 360.0) % 360.0
            mode = Mode.HOLD
        }
    }

    /** Como [inclinarCamara], pero para la app: nunca por arriba del horizonte. */
    override fun apuntarCamara(pitchGrados: Double) {
        if (!pitchGrados.isFinite()) return
        synchronized(cerrojo) { gimbalPitch = pitchGrados.coerceIn(INCLINACION_MINIMA, INCLINACION_MAXIMA_DE_LA_APP) }
    }

    /**
     * Corta el regreso en curso y queda estacionario donde está, a la altura en
     * la que está. Uno que arrancó el propio dron se corta una sola vez por
     * vuelo y el que pidió el botón del control, nunca (ver
     * [SeguidorDelRegreso.corte]): esos se dejan seguir, avisando con
     * [DroneController.NO_SE_CORTO_EL_REGRESO]. Cortarlo le devuelve el mando a
     * la app.
     */
    override fun cancelarRegreso() {
        synchronized(cerrojo) {
            if (mode != Mode.RTH) return
            val negativa = when (seguidor.corte()) {
                SeguidorDelRegreso.Corte.SE_PUEDE -> null
                SeguidorDelRegreso.Corte.YA_SE_CORTO ->
                    "el propio dron volvió a arrancar su regreso: se lo deja seguir (se corta una sola vez)"
                SeguidorDelRegreso.Corte.LO_PIDIO_EL_CONTROL ->
                    "lo pidió el botón de regreso del control y la app no se lo corta"
            }
            if (negativa != null) {
                // Es la respuesta a una orden: sale siempre, no por transición.
                emitEvent(FlightEvent.Problema("${DroneController.NO_SE_CORTO_EL_REGRESO}: $negativa"))
                return
            }
            seguidor.alCortar()
            seguidor.alCambiarFase(SeguidorDelRegreso.Fase.INACTIVO, SeguidorDelRegreso.Orden.NINGUNA, MotivoDelDron.OTRO)
            regresoDeLaApp = false
            tomaDelDron = null
            alturaObjetivo = altM
            alturaPedida = null
            rumboPedido = null
            mode = Mode.HOLD
        }
    }

    /** La base pasa a ser donde está ahora: cualquier regreso posterior vuelve acá. */
    override fun fijarPuntoDeRetornoAqui() {
        synchronized(cerrojo) {
            homeLat = lat
            homeLon = lon
            _estado.update { it.copy(puntoDeRetornoLat = homeLat, puntoDeRetornoLon = homeLon) }
        }
    }

    /**
     * Con false, cuando la batería pida su regreso inteligente el dron no vuelve
     * (se le contestó que no). Al tocar el suelo vuelve a quedar permitido.
     */
    override fun permitirRthPropioPorBateria(permitir: Boolean) {
        rthPropioPermitido = permitir
    }

    /**
     * Con true, la pérdida de señal lo hace aterrizar donde está en vez de
     * volver. Al tocar el suelo vuelve el de siempre (volver a casa).
     */
    override fun fijarFailsafeAterrizar(activo: Boolean) {
        failsafeAterrizar = activo
    }

    /**
     * El simulador no tiene Virtual Stick que habilitar: acepta en el suelo y
     * conectado, salvo que la prueba simule un control que no cede el mando
     * ([rechazarElMandoVirtual]). En el aire no hay despegue que preparar.
     */
    override suspend fun prepararDespegue(): Boolean = synchronized(cerrojo) {
        when {
            loops == null || !enElSuelo -> false
            mandoVirtualRechazado -> {
                rechazar(RECHAZO_DEL_MANDO_VIRTUAL)
                false
            }
            else -> true
        }
    }

    /** Nada que soltar: sin Virtual Stick, las palancas (que el simulador no tiene) nunca dejaron de mandar. */
    override fun soltarDespegue() = Unit

    /**
     * Un cuadro de detección (1280 px) dibujado en el acto con lo que la cámara
     * simulada ve ahora: el rumbo y la inclinación salen escritos en la foto.
     * Sin enlace —o sin conectar— no hay foto, como en el real: queda la espera
     * de siempre del próximo cuadro, que no llega.
     */
    override suspend fun capturarFoto(): ByteArray? {
        if (loops == null || signalLost) return super.capturarFoto()
        return withContext(despachador) {
            cuadro(CuadroDeVideo.ANCHO_DETECCION, faseDelVideo, nuevoPincel(), CuadroDeVideo.CALIDAD_JPEG_DETECCION)
        }
    }

    /**
     * Las órdenes que no despegan se rechazan con el dron en el suelo, igual que
     * hace el dron real: el aviso sale una vez por motivo, no una por intento
     * (el mando llega diez veces por segundo).
     */
    private fun rechazarEnElSuelo(que: String): Boolean {
        if (!enElSuelo) return false
        rechazar("el dron está en el suelo: no se puede $que hasta despegar (arrancá un patrullaje)")
        return true
    }

    /**
     * Con el vuelo tomado por el propio dron, las órdenes de vuelo se rechazan
     * (avisando una vez). Una orden que pasa con enlace es la app retomando el
     * mando: si el dron no está volviendo, la toma de antes terminó (ver
     * [SeguidorDelRegreso.alRetomarElMando]).
     */
    private fun rechazarSiElDronTieneElControl(que: String): Boolean {
        val motivo = tomaDelDron
        if (motivo == null) {
            if (!signalLost) seguidor.alRetomarElMando()
            return false
        }
        rechazar("el propio dron tomó el control (${motivo.descripcion}): no se puede $que hasta que aterrice")
        return true
    }

    private fun rechazar(motivo: String) {
        if (ultimoRechazo != motivo) {
            ultimoRechazo = motivo
            emitEvent(FlightEvent.Problema(motivo))
        }
    }

    /** Sube derecho desde el suelo; lo que sigue al llegar lo dice [despuesDelDespegue]. */
    private fun arrancarDespegue() {
        mode = Mode.TAKING_OFF
        publicarEstado()
        emitEvent(FlightEvent.Despegando)
    }

    /**
     * Un despegue recién ordenado que todavía no dejó el suelo (el primer tick
     * no lo subió) se cancela: no despega, y avisa cómo terminó. Es el lado del
     * simulador de "ante la duda en el suelo, el dron no despega": el real tiene
     * acá varios segundos (Virtual Stick, motores, KeyStartTakeoff).
     */
    private fun cancelarDespegueEnElSuelo(evento: FlightEvent): Boolean {
        if (mode != Mode.TAKING_OFF || altM > 0.0) return false
        tocarElSuelo(evento)
        return true
    }

    /**
     * Lo que el propio dron hace cuando se queda con el vuelo (ver
     * [simularTomaDelDron]). El bloqueo se escribe ANTES de avisar: la patrulla
     * puede contestar en el acto con su único corte ([cancelarRegreso]), y si el
     * bloqueo se escribía después, pisaba ese corte y el dron quedaba
     * estacionario con todas las órdenes rechazadas hasta el aterrizaje forzado.
     */
    private fun tomarElControl(motivo: MotivoDelDron) {
        if (enElSuelo) return
        // Un aterrizaje forzado ya no se convierte en otra cosa.
        if (mode == Mode.LANDING && tomaDelDron == MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA) return
        rumboPedido = null
        alturaPedida = null
        val aviso = when {
            motivo == MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA ||
                (motivo == MotivoDelDron.RTH_SENIAL && failsafeAterrizar) -> {
                regresoDeLaApp = false
                mode = Mode.LANDING
                seguidor.alTomarElControl(motivo)
            }
            motivo == MotivoDelDron.OTRO -> {
                alturaObjetivo = altM
                mode = Mode.HOLD
                seguidor.alTomarElControl(motivo)
            }
            else -> {
                regresoDeLaApp = false
                alturaObjetivo = modelo.alturaDeRegresoM
                mode = Mode.RTH
                seguidor.alArrancarRegresoPropio(motivo)
            }
        }
        tomaDelDron = TomaDelDron.bloqueoTrasLaToma(tomaDelDron, motivo)
        aviso?.let(::emitEvent)
    }

    /**
     * El regreso inteligente por batería y el aterrizaje por batería crítica,
     * que el propio dron decide en cada tick con su modelo de batería (y no con
     * la autonomía que informa, que puede estar apagada).
     */
    private fun reglasDelPropioDron(autonomia: AutonomiaInformada) {
        if (modelo.fuerzaAterrizaje(battery)) {
            if (mode != Mode.LANDING) tomarElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA)
            return
        }
        val yaBajando = mode == Mode.RTH || mode == Mode.LANDING || mode == Mode.TAKING_OFF
        if (rthPorBateriaPreguntado || yaBajando || !modelo.pideRegresoPropio(battery, autonomia)) return
        // Pregunta una vez por vuelo; si la app ya le dijo que no
        // (permitirRthPropioPorBateria(false)), no vuelve a preguntar.
        rthPorBateriaPreguntado = true
        if (rthPropioPermitido) tomarElControl(MotivoDelDron.RTH_BATERIA)
    }

    /**
     * Lo de un vuelo que terminó (o que no empezó): el siguiente arranca de
     * cero. También lo que la app le cambió para un desvío o una emergencia: el
     * regreso inteligente vuelve a estar permitido y el failsafe de señal vuelve
     * a ser volver a casa, aunque la app no lo haya pedido (RELEVOS §4: fuera de
     * un desvío el respaldo del DJI tiene que estar).
     */
    private fun olvidarElVuelo() {
        seguidor.alAterrizar()
        tomaDelDron = null
        regresoDeLaApp = false
        rthPorBateriaPreguntado = false
        rthPropioPermitido = true
        failsafeAterrizar = false
        rumboPedido = null
        alturaPedida = null
        destino = null
        destinoAlcanzado = null
        volandoHacia = false
        despuesDelDespegue = DespuesDelDespegue.RUTA
    }

    /** Tocó el suelo: queda apagado, avisa [evento] y el vuelo siguiente arranca de cero. */
    private fun tocarElSuelo(evento: FlightEvent) {
        mode = Mode.IDLE
        olvidarElVuelo()
        publicarEstado()
        emitEvent(evento)
    }

    private fun publicarEstado() {
        _estado.update {
            it.copy(
                conectado = true,
                controlConectado = true,
                serie = SERIE,
                enVuelo = !enElSuelo,
                puntoDeRetornoLat = homeLat,
                puntoDeRetornoLon = homeLon,
                umbralCriticoPct = modelo.umbralCriticoPct,
                detalle = when {
                    enElSuelo -> "En el suelo, listo para despegar"
                    mode == Mode.TAKING_OFF -> "Despegando"
                    mode == Mode.LANDING -> "Aterrizando"
                    else -> "En vuelo"
                },
            )
        }
    }

    private suspend fun flightLoop() {
        val lazo = currentCoroutineContext().job
        while (true) {
            delay(TICK_MS)
            synchronized(cerrojo) {
                // disconnect() corta los lazos con el cerrojo tomado: un tick que
                // lo estaba esperando no puede correr después y volver a publicar
                // al dron como conectado.
                lazo.ensureActive()
                avanzar(TICK_MS / 1000.0)
            }
        }
    }

    /** Un tick de vuelo de [dt] segundos. */
    private fun avanzar(dt: Double) {
        // Failsafe del propio dron ante pérdida prolongada del enlace RC
        if (signalLost && mode != Mode.RTH && mode != Mode.IDLE && mode != Mode.LANDING &&
            reloj() - signalLostAt > FAILSAFE_TIMEOUT_MS
        ) {
            tomarElControl(MotivoDelDron.RTH_SENIAL)
        }

        mover(dt)

        // El mando manual es el único que elige la altura; en cuanto el dron
        // vuelve a volar solo (ruta, órbita, goto o estacionario) sube o baja
        // a la de la orden, así el operador no lo deja a ras del suelo.
        if (mode == Mode.FLY_ROUTE || mode == Mode.ORBIT || mode == Mode.FOLLOW || mode == Mode.GOTO || mode == Mode.HOLD ||
            (mode == Mode.RTH && !llegoABase())
        ) {
            acercarAltura(alturaObjetivo, dt, MandoVirtual.MAX_VERTICAL_MS)
        }
        if (mode != Mode.HOLD) rumboPedido = null

        // En el aire gasta, haga lo que haga (también suspendido sin orden).
        val autonomia = modelo.estimar(battery, Geo.distanciaM(lat, lon, homeLat, homeLon), altM)
        if (!enElSuelo) {
            battery = (battery - modelo.gastoPct(dt)).coerceAtLeast(0.0)
            reglasDelPropioDron(autonomia)
        }

        publicarEstado()
        if (!signalLost) telemetry.tryEmit(telemetria())
    }

    /** Lo que hace el modo en curso en este tick. */
    private fun mover(dt: Double) {
        when (mode) {
            Mode.TAKING_OFF -> despegar(dt)
            Mode.FLY_ROUTE -> {
                val ruta = route ?: return
                val wp = ruta.waypoints.getOrNull(targetWaypoint) ?: return
                alturaObjetivo = wp.alt.coerceIn(ALTURA_MINIMA_M, ALTURA_MAXIMA_M)
                if (moveToward(wp.lat, wp.lon, dt)) {
                    emitEvent(FlightEvent.WaypointReached(targetWaypoint))
                    targetWaypoint = (targetWaypoint + 1) % ruta.waypoints.size
                }
            }
            Mode.ORBIT -> {
                // Círculo alrededor del objetivo a velocidad constante. El
                // dron va hacia el punto que sigue en el círculo (no salta a
                // él): si arranca lejos, primero se acerca.
                orbitAngle += (VELOCIDAD_ORBITA_MS / orbitRadiusM) * dt
                val tLat = orbitCenterLat + (orbitRadiusM * cos(orbitAngle)) / METERS_PER_DEG_LAT
                val tLon = orbitCenterLon + (orbitRadiusM * sin(orbitAngle)) / Geo.metrosPorGradoLon(orbitCenterLat)
                moveToward(tLat, tLon, dt)
                // En órbita la cámara mira al objetivo
                heading = bearingTo(orbitCenterLat, orbitCenterLon)
                gimbalPitch = Georreferencia.inclinacionParaOrbitar(
                    altM,
                    Geo.distanciaM(lat, lon, orbitCenterLat, orbitCenterLon),
                )
            }
            Mode.FOLLOW -> seguir(dt)
            Mode.GOTO -> {
                val d = destino ?: return
                if (moveToward(d.lat, d.lon, dt)) {
                    mode = Mode.HOLD
                    destinoAlcanzado = d
                    emitEvent(FlightEvent.GotoArrived)
                }
            }
            // Vuelo estacionario: quieto, salvo que esté girando en el lugar.
            Mode.HOLD -> rumboPedido?.let { pedido -> heading = girarHacia(heading, pedido, VELOCIDAD_GIRO_GRADOS_S * dt) }
            Mode.RTH -> volverABase(dt)
            Mode.LANDING -> {
                acercarAltura(0.0, dt, modelo.velocidadDescensoMs)
                if (altM <= 0.0) tocarElSuelo(FlightEvent.Aterrizado)
            }
            Mode.STICK -> {
                val v = ejesMando
                // El yaw es velocidad de giro: mueve la nariz y con ella el
                // "adelante" del propio mando.
                heading = (heading + v.giroGradosS * dt + 360.0) % 360.0
                val sobreTerreno = MandoVirtual.aTerreno(v, heading)
                lat += (sobreTerreno.norteMs * dt) / METERS_PER_DEG_LAT
                lon += (sobreTerreno.esteMs * dt) / metersPerDegLon()
                altM = (altM + v.subidaMs * dt).coerceIn(0.5, ALTURA_MAXIMA_M)
            }
            Mode.IDLE -> Unit
        }
    }

    /** Sube derecho, sin moverse en el plano, hasta la altura pedida; ahí sigue lo que pidió el despegue. */
    private fun despegar(dt: Double) {
        acercarAltura(alturaObjetivo, dt, VELOCIDAD_VERTICAL_AUTO_MS)
        if (!Navegacion.aLaAltura(altM, alturaObjetivo)) return
        when (despuesDelDespegue) {
            // El despegue del mando manual deja al dron suspendido obedeciendo
            // al mando (en cero = quieto).
            DespuesDelDespegue.MANDO -> {
                ejesMando = MandoVirtual.NEUTRO
                mode = Mode.STICK
            }
            // El de un relevo queda estacionario a la altura pedida.
            DespuesDelDespegue.ESTACIONARIO -> mode = Mode.HOLD
            DespuesDelDespegue.RUTA -> mode = Mode.FLY_ROUTE
        }
        despuesDelDespegue = DespuesDelDespegue.RUTA
        ultimoRechazo = null
        emitEvent(FlightEvent.EnElAire)
    }

    private fun seguir(dt: Double) {
        val o = objetivoSeguido ?: return
        // La estimación se extrapola con su velocidad hasta la próxima, como
        // hace el dron real.
        val edadS = (reloj() - o.desdeMs).coerceIn(0L, EXTRAPOLACION_MAXIMA_MS) / 1_000.0
        val oLat = o.lat + o.vNorteMs * edadS / METERS_PER_DEG_LAT
        val oLon = o.lon + o.vEsteMs * edadS / Geo.metrosPorGradoLon(o.lat)
        val orden = Persecucion.calcular(lat, lon, altM, oLat, oLon, o.vNorteMs, o.vEsteMs)
        lat += orden.vNorteMs * dt / METERS_PER_DEG_LAT
        lon += orden.vEsteMs * dt / metersPerDegLon()
        heading = orden.rumboGrados
        gimbalPitch = orden.gimbalPitch
    }

    /**
     * Llega a la base a la altura de regreso y recién ahí baja: el dron real
     * hace lo mismo. El comienzo del descenso es lo que avisa
     * [FlightEvent.DescendiendoEnBase] si el regreso es de la app (el real lo
     * saca de `KeyGoHomeStatus = LANDING`).
     */
    private fun volverABase(dt: Double) {
        if (!moveToward(homeLat, homeLon, dt)) return
        val orden = if (regresoDeLaApp) SeguidorDelRegreso.Orden.REGRESO else SeguidorDelRegreso.Orden.NINGUNA
        seguidor.alCambiarFase(SeguidorDelRegreso.Fase.DESCENDIENDO, orden, tomaDelDron ?: MotivoDelDron.OTRO)
            ?.let(::emitEvent)
        acercarAltura(0.0, dt, modelo.velocidadDescensoMs)
        if (altM <= 0.0) tocarElSuelo(FlightEvent.ArrivedHome)
    }

    private fun telemetria(): Telemetry {
        val autonomia = if (informaAutonomia) {
            modelo.estimar(battery, Geo.distanciaM(lat, lon, homeLat, homeLon), altM)
        } else {
            AutonomiaInformada.DESCONOCIDA
        }
        return Telemetry(
            lat, lon, altM, battery, signalPct(), heading, reloj(), gimbalPitch,
            pctParaVolver = autonomia.pctParaVolver,
            pctParaAterrizar = autonomia.pctParaAterrizar,
            alcanceM = autonomia.alcanceM,
            segundosParaVolver = autonomia.segundosParaVolver,
        )
    }

    /** Avanza hacia el punto dado; devuelve true si llegó. */
    private fun moveToward(tLat: Double, tLon: Double, dt: Double): Boolean {
        val dy = (tLat - lat) * METERS_PER_DEG_LAT
        val dx = (tLon - lon) * metersPerDegLon()
        val dist = hypot(dx, dy)
        if (dist < ARRIVE_THRESHOLD_M) return true
        heading = bearingTo(tLat, tLon)
        val step = (modelo.velocidadCruceroMs * dt).coerceAtMost(dist)
        lat += (dy / dist) * step / METERS_PER_DEG_LAT
        lon += (dx / dist) * step / metersPerDegLon()
        return false
    }

    private fun llegoABase(): Boolean = distanciaA(Punto(homeLat, homeLon)) < ARRIVE_THRESHOLD_M

    private fun distanciaA(p: Punto): Double = Geo.distanciaM(lat, lon, p.lat, p.lon)

    /** Sube o baja hacia [objetivoM] a [velocidadMs] como mucho. */
    private fun acercarAltura(objetivoM: Double, dt: Double, velocidadMs: Double) {
        val paso = velocidadMs * dt
        altM = when {
            altM < objetivoM -> (altM + paso).coerceAtMost(objetivoM)
            altM > objetivoM -> (altM - paso).coerceAtLeast(objetivoM)
            else -> altM
        }
    }

    /**
     * Ángulo de la posición actual vista desde el centro, en la convención de
     * la órbita (lat = centro + r·cos, lon = centro + r·sin).
     */
    private fun anguloDesdeElCentro(centroLat: Double, centroLon: Double): Double {
        val norte = (lat - centroLat) * METERS_PER_DEG_LAT
        val este = (lon - centroLon) * Geo.metrosPorGradoLon(centroLat)
        return kotlin.math.atan2(este, norte)
    }

    /** Rumbo 0..360° desde la posición actual hacia el punto dado (norte = 0, este = 90). */
    private fun bearingTo(tLat: Double, tLon: Double): Double =
        (Geo.rumboHacia(lat, lon, tLat, tLon) + 360.0) % 360.0

    /** Un paso de giro desde [actual] hacia [pedido] (0..360), por el lado más corto y de a [maxGrados] como mucho. */
    private fun girarHacia(actual: Double, pedido: Double, maxGrados: Double): Double {
        val falta = ((pedido - actual + 540.0) % 360.0) - 180.0
        if (abs(falta) <= maxGrados) return pedido
        return (actual + sign(falta) * maxGrados + 360.0) % 360.0
    }

    private fun metersPerDegLon() = Geo.metrosPorGradoLon(lat)

    /** La señal se degrada de forma lineal con la distancia a la base. */
    private fun signalPct(): Int {
        val dy = (lat - homeLat) * METERS_PER_DEG_LAT
        val dx = (lon - homeLon) * metersPerDegLon()
        val pct = 100 * (1 - hypot(dx, dy) / SIGNAL_RANGE_M)
        return pct.toInt().coerceIn(SIGNAL_MIN_PCT, 100)
    }

    private fun emitEvent(e: FlightEvent) {
        flightEvents.tryEmit(e)
    }

    // ---- Video simulado ----

    private val limitadorDeDeteccion = LimitadorDeRitmo(CuadroDeVideo.INTERVALO_DETECCION_MS)

    private fun nuevoPincel() = Paint().apply { isAntiAlias = true }

    private suspend fun frameLoop() {
        // El pincel se crea con el primer cuadro que alguien mira: sin nadie
        // suscripto el lazo no toca android.graphics (ver abajo).
        val paint by lazy { nuevoPincel() }
        while (true) {
            delay(FRAME_MS)
            if (signalLost) continue // el video también viaja por el enlace RC
            faseDelVideo += 0.35
            val t = faseDelVideo
            // Sin nadie mirando no se dibuja: un cuadro de 1280 px no es gratis,
            // y uno que nadie recibe se tira igual (los flujos no repiten).
            if (videoFrames.subscriptionCount.value > 0) {
                videoFrames.tryEmit(cuadro(CuadroDeVideo.ANCHO_MAXIMO, t, paint, CuadroDeVideo.CALIDAD_JPEG))
            }
            // El cuadro para la detección sale más grande y más espaciado, como
            // con el dron real (ver DroneController.cuadrosParaDeteccion).
            if (limitadorDeDeteccion.aceptar(reloj()) && cuadrosParaDeteccion.subscriptionCount.value > 0) {
                cuadrosParaDeteccion.tryEmit(
                    cuadro(CuadroDeVideo.ANCHO_DETECCION, t, paint, CuadroDeVideo.CALIDAD_JPEG_DETECCION),
                )
            }
        }
    }

    /** Un "campo" visto desde arriba con un objeto que deambula, a la escala pedida. */
    private fun cuadro(ancho: Int, t: Double, paint: Paint, calidad: Int): ByteArray {
        val escala = ancho / 640f
        val alto = (360 * escala).toInt()
        val bmp = Bitmap.createBitmap(ancho, alto, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.scale(escala, escala)
        c.drawColor(Color.rgb(24, 46, 32))
        paint.color = Color.rgb(40, 70, 50)
        paint.strokeWidth = 1f
        for (i in 0..8) c.drawLine(i * 80f, 0f, i * 80f, 360f, paint)
        for (i in 0..5) c.drawLine(0f, i * 72f, 640f, i * 72f, paint)
        // Un "objeto" que deambula, para que el software de detección tenga algo que mirar
        paint.color = Color.WHITE
        val ox = 320f + (220 * sin(t * 0.7)).toFloat()
        val oy = 180f + (120 * cos(t * 0.4)).toFloat()
        c.drawRect(ox, oy, ox + 14f, oy + 28f, paint)
        paint.textSize = 18f
        val hora = HORA.format(Instant.ofEpochMilli(reloj()).atZone(ZoneId.systemDefault()))
        c.drawText("DRONE SIM  $hora", 12f, 24f, paint)
        c.drawText("bat %.0f%%  %s  alt %.0f m".format(battery, mode.name, altM), 12f, 48f, paint)
        // Hacia dónde mira la cámara: es lo que distingue las fotos del
        // protocolo de última ubicación (oblicua, cenital, panorámica).
        c.drawText("rumbo %.0f°  camara %.0f°".format(heading, gimbalPitch), 12f, 72f, paint)
        c.drawText("pos %.5f, %.5f".format(lat, lon), 12f, 348f, paint)

        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, calidad, out)
        bmp.recycle()
        return out.toByteArray()
    }
}
