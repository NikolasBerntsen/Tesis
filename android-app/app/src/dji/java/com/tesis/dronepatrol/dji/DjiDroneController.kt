package com.tesis.dronepatrol.dji

import android.util.Log
import com.tesis.dronepatrol.drone.AutonomiaInformada
import com.tesis.dronepatrol.drone.ConfirmacionDelAterrizaje
import com.tesis.dronepatrol.drone.CuadroDeVideo
import com.tesis.dronepatrol.drone.DestinoActualizable
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.drone.EsperaCreciente
import com.tesis.dronepatrol.drone.FilaDelGimbal
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.Georreferencia
import com.tesis.dronepatrol.drone.LimitadorDeRitmo
import com.tesis.dronepatrol.drone.MandoVirtual
import com.tesis.dronepatrol.drone.Navegacion
import com.tesis.dronepatrol.drone.OrdenVirtualStick
import com.tesis.dronepatrol.drone.RecuerdoDelFailsafe
import com.tesis.dronepatrol.drone.SeguidorDelRegreso
import com.tesis.dronepatrol.drone.SupervisorDelAterrizaje
import com.tesis.dronepatrol.drone.TomaDelDron
import com.tesis.dronepatrol.drone.UltimoPedido
import com.tesis.dronepatrol.drone.UmbralesDelDji
import com.tesis.dronepatrol.drone.VigiaDelRthPorBateria
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Vinculacion
import com.tesis.dronepatrol.patrol.PatrolManager
import dji.sdk.keyvalue.key.AirLinkKey
import dji.sdk.keyvalue.key.RemoteControllerKey
import dji.sdk.keyvalue.value.remotecontroller.PairingState
import dji.sdk.keyvalue.key.BatteryKey
import dji.sdk.keyvalue.key.DJIActionKeyInfo
import dji.sdk.keyvalue.key.DJIKeyInfo
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.GimbalKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.key.ProductKey
import com.tesis.dronepatrol.drone.Persecucion
import dji.sdk.keyvalue.value.common.ComponentIndexType
import dji.sdk.keyvalue.value.common.EmptyMsg
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.sdk.keyvalue.value.gimbal.GimbalAngleRotation
import dji.sdk.keyvalue.value.gimbal.GimbalAngleRotationMode
import dji.sdk.keyvalue.value.flightcontroller.FailsafeAction
import dji.sdk.keyvalue.value.flightcontroller.FlightControlAuthorityChangeReason
import dji.sdk.keyvalue.value.flightcontroller.FlightCoordinateSystem
import dji.sdk.keyvalue.value.flightcontroller.GoHomeState
import dji.sdk.keyvalue.value.flightcontroller.LowBatteryRTHInfo
import dji.sdk.keyvalue.value.flightcontroller.RollPitchControlMode
import dji.sdk.keyvalue.value.flightcontroller.VerticalControlMode
import dji.sdk.keyvalue.value.flightcontroller.VirtualStickFlightControlParam
import dji.sdk.keyvalue.value.flightcontroller.YawControlMode
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.KeyManager
import dji.v5.manager.aircraft.virtualstick.VirtualStickManager
import dji.v5.manager.aircraft.virtualstick.VirtualStickState
import dji.v5.manager.aircraft.virtualstick.VirtualStickStateListener
import dji.v5.manager.datacenter.MediaDataCenter
import dji.v5.manager.interfaces.ICameraStreamManager
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Integración real con el DJI Mini 4 Pro vía MSDK v5 (teléfono enganchado a un
 * RC-N2/RC-N3).
 *
 * Importante (limitación del producto, no de este código): el Mini 4 Pro NO
 * soporta las misiones de waypoints nativas del MSDK (WaypointMissionManager es
 * solo Enterprise). El patrullaje autónomo se implementa con Virtual Stick: un
 * lazo a 10 Hz que manda velocidades hacia el objetivo, con la cuenta en
 * [Navegacion] y la traducción a los campos del SDK en [OrdenVirtualStick],
 * las dos en `main` y con pruebas, porque este archivo solo compila bajo el
 * flavor "dji" y no se puede probar sin dron. Acá queda el pegamento con el SDK
 * y la secuencia de vuelo.
 *
 * Secuencia de un patrullaje desde el suelo (ver [startRoute]):
 *  1. despegue automático del SDK (KeyStartTakeoff: motores y salto a 1,2 m),
 *  2. subida vertical, sin moverse en el plano, hasta la altura del primer
 *     waypoint (para no salir disparado a 8 m/s a un metro del suelo), y
 *  3. la ruta, con la altura de cada waypoint corregida en el mismo lazo.
 *
 * Requisitos en el campo: el control en modo **N** (Normal) —en S o C la
 * aeronave no cede el mando al SDK—, GPS con punto de retorno fijado, y el
 * teléfono con internet la primera vez que la app se registra contra DJI.
 *
 * Relevos, desvío a otra base y última ubicación (docs/RELEVOS.md): la
 * autonomía sale de `KeyLowBatteryRTHInfo`; el estado del regreso
 * (`KeyGoHomeStatus`), los cambios de autoridad del Virtual Stick y la batería
 * crítica dicen cuándo el propio DJI se quedó con el vuelo, y entonces la app
 * deja de comandarlo en vez de pelearle (ver [SeguidorDelRegreso] y
 * [TomaDelDron], que deciden y se prueban sin dron). Todas las llaves están
 * comprobadas contra el MSDK 5.18.0 (javap sobre `dji-sdk-v5-aircraft-provided`).
 * Lo que solo se sabe en el banco o en el campo está en RELEVOS §8.
 */
class DjiDroneController : DroneController {

    override val estado: StateFlow<EstadoDelDron> get() = _estado
    private val _estado = MutableStateFlow(EstadoDelDron.DESCONOCIDO)
    override val telemetry = MutableSharedFlow<Telemetry>(replay = 1, extraBufferCapacity = 8)
    override val videoFrames = MutableSharedFlow<ByteArray>(extraBufferCapacity = 4)
    override val cuadrosParaDeteccion = MutableSharedFlow<ByteArray>(extraBufferCapacity = 2)
    override val flightEvents = MutableSharedFlow<FlightEvent>(extraBufferCapacity = 8)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * Serializa el relevo del lazo de comandos. Cortar el anterior y publicar el
     * nuevo tiene que ser UN solo paso indivisible: los pedidos llegan por hilos
     * distintos —`manualStick` corre en el hilo lector de OkHttp y el resto en
     * corrutinas de Dispatchers.Default— y entrelazados dejaban un lazo vivo al
     * que ya nadie referenciaba, mandándole velocidades contradictorias al dron
     * a 10 Hz sin forma de matarlo. El monitor es reentrante, así que
     * [manualStick] puede llamar a [relevarLazo] sin soltarlo.
     */
    private val relevoDeLazo = Any()

    /** Lazo de comandos en curso. Se lee y se escribe SIEMPRE con [relevoDeLazo] tomado. */
    private var navigationJob: Job? = null

    /** Qué lazo es [navigationJob]. Mismo lock. */
    private var lazoActual = Lazo.NINGUNO

    /**
     * Los lazos de comando. Saber cuál corre sirve para no relanzar el que ya
     * está andando: el mando manual llega diez veces por segundo, y la órbita y
     * el seguimiento se actualizan con cada detección sin cortar el movimiento.
     */
    private enum class Lazo {
        NINGUNO, RUTA, ESTACIONARIO, GOTO, ORBITA, SEGUIMIENTO, MANDO,

        /** El despegue en el lugar, para el mando manual. */
        DESPEGUE,

        /** El despegue de un relevo hasta una altura ([despegarHasta]). */
        DESPEGUE_A_ALTURA,
        VUELO, GIRO,

        /** Sube o baja en vertical ([cambiarAltura]). */
        ALTURA,

        /**
         * La secuencia de un aterrizaje de la app ([sostenerElAterrizaje]): la
         * orden, la confirmación y, si el dron pide confirmar un aterrizaje que
         * no se confirma solo, el corrimiento de 10 m.
         */
        ATERRIZAJE,

        /** Un despegue cancelado cuando la orden ya le había llegado al dron: aterriza apenas sube. */
        ATERRIZAJE_DEL_DESPEGUE,
    }

    /**
     * En qué anda un despegue que pidió la app mientras el dron todavía no está
     * en el aire (ver [cancelarDespegueEnElSuelo]). Se escribe con [relevoDeLazo]
     * tomado, junto con el lazo al que pertenece.
     */
    private enum class Despegue {
        NINGUNO,

        /** Habilitando el Virtual Stick o esperando los motores: cortar el lazo alcanza para que no despegue. */
        PREPARANDO,

        /** KeyStartTakeoff ya salió (o está saliendo): cortar el lazo ya no alcanza, hay que aterrizarlo. */
        ORDENADO,
    }

    @Volatile
    private var despegue = Despegue.NINGUNO

    /**
     * La altura que pidieron [despegarHasta] o [cambiarAltura] y que releen los
     * lazos de [volarHacia], [girarEnElLugar] y el de la propia altura; null si
     * ninguna (ver DroneController.cambiarAltura). Se escribe con
     * [relevoDeLazo] tomado; cualquier otro lazo la olvida.
     */
    @Volatile
    private var alturaPedida: Double? = null

    /** Corrutina que convierte los cuadros del SDK, una por vez (ver [convertirCuadros]). */
    private var conversionJob: Job? = null

    /** Corrutina que sigue el estado del SDK ([DjiSdk]) para armar [estado]. */
    private var sdkJob: Job? = null

    /**
     * TODAS las órdenes al gimbal, camino del SDK: las inclinaciones pedidas
     * desde la consola ([inclinarCamara]) y la cámara que apuntan la ruta, la
     * órbita y el seguimiento ([apuntarCamara]). Las de la consola llegan hasta
     * diez por segundo mientras el operador arrastra, y cada una es una acción
     * del SDK que interrumpe el recorrido de la anterior: la fila espera a que el
     * gimbal conteste cada orden (y deja al menos [ENTRE_ORDENES_GIMBAL_MS] entre
     * una y otra), y mientras tanto se queda solo con la última.
     *
     * La cámara autónoma va por la MISMA fila a propósito: cuando iba directo al
     * SDK, una inclinación de la consola que seguía esperando le llegaba al
     * gimbal después de la de patrulla y la dejaba mirando al horizonte (ver
     * [FilaDelGimbal]).
     */
    private val filaDelGimbal = FilaDelGimbal(
        intervaloMs = ENTRE_ORDENES_GIMBAL_MS,
        topeMs = ESPERA_GIMBAL_MS,
        girar = { orden ->
            if (orden.deLaConsola) {
                girarGimbalYEsperar(orden.pitchGrados, DURACION_GIMBAL_MANUAL_S) { motivo ->
                    "el gimbal no aceptó la inclinación pedida desde la consola ($motivo)"
                }
            } else {
                girarGimbalYEsperar(orden.pitchGrados, DURACION_GIMBAL_AUTONOMO_S) { motivo ->
                    "el gimbal no aceptó apuntar la cámara a ${orden.pitchGrados.toInt()}° ($motivo)"
                }
            }
        },
        // Sin el valor en el texto: avisar() repite solo cuando el motivo
        // cambia, y con el gimbal trabado cada inclinación nueva sería un aviso.
        alVencerse = { orden ->
            avisar(
                if (orden.deLaConsola) {
                    "el gimbal no contestó a tiempo una inclinación pedida desde la consola"
                } else {
                    "el gimbal no contestó a tiempo cuando la app apuntó la cámara"
                },
            )
        },
    )

    /** Corrutina que le pasa al gimbal las órdenes de [filaDelGimbal], una por vez y en orden. */
    private var camaraJob: Job? = null

    // Lo que sigue lo escriben los listeners del SDK, cada uno en su hilo, y lo
    // leen los lazos de navegación y el que arma la telemetría, que corren en
    // otros: volátil para que no quede pegado. Sin esto un lazo podía quedarse
    // sin ver la posición para siempre —el dron reportándola y la ruta sin
    // comandar una sola velocidad— sin que nada lo avise.
    /**
     * La posición tal como la entrega KeyAircraftLocation3D, latitud y
     * longitud JUNTAS (un par y no dos campos sueltos: leídas por separado, un
     * lazo podía tomar la latitud de una lectura y la longitud de otra). La que
     * usa el resto del controlador es [posicion], que la valida.
     */
    @Volatile
    private var posicionCruda: Pair<Double, Double>? = null

    /**
     * Si el GPS tiene fix según el propio controlador de vuelo (KeyGPSIsValid);
     * null mientras no lo informe. Sin fix el SDK no entrega posición o entrega
     * 0,0, y volar hacia una coordenada con eso es mandar al dron a cualquier
     * lado (comprobado en el Mini 4 Pro: frente a una ventana el fix va y viene).
     */
    @Volatile
    private var gpsValido: Boolean? = null

    /** Rumbo absoluto del gimbal según el SDK (KeyGimbalAttitude.yaw), en -180..180. */
    @Volatile
    private var lastGimbalYaw = Double.NaN

    /** Modo de vuelo que informa la aeronave (P-GPS, ATTI, APAS, …). */
    @Volatile
    private var modoDeVuelo = ""

    /** Punto de retorno según KeyIsHomeLocationSet; null si el SDK no lo informa. */
    @Volatile
    private var baseFijadaSegunSdk: Boolean? = null

    /** El punto de retorno que informa KeyHomeLocation es distinto de 0,0. */
    @Volatile
    private var baseDistintaDeCero = false

    /** Centro y radio de la órbita en curso: el lazo los relee en cada vuelta (ver [startOrbit]). */
    private class Orbita(val lat: Double, val lon: Double, val radioM: Double)

    @Volatile
    private var orbita: Orbita? = null

    /** Objetivo que se sigue y desde cuándo vale esa estimación (ver [seguirObjetivo]). */
    private class Seguido(val lat: Double, val lon: Double, val vNorteMs: Double, val vEsteMs: Double, val desdeMs: Long)

    @Volatile
    private var seguido: Seguido? = null

    /** Altura sobre el punto de despegue (barómetro), en metros. */
    @Volatile
    private var lastAlt = 0.0

    @Volatile
    private var lastBattery = 0.0

    @Volatile
    private var lastHeading = 0.0

    @Volatile
    private var lastSignal = 100

    /**
     * Inclinación real del gimbal (0 horizonte, −90 nadir): con ella se ubica en
     * el terreno lo que ve la cámara, y es la que el status le muestra a la
     * consola. NaN hasta que el SDK la informa (KeyGimbalAttitude): arrancar con
     * la de patrulla le hacía creer a la consola que la cámara estaba a −70°
     * sin que nadie lo hubiera medido. PatrolManager proyecta con la de patrulla
     * mientras tanto, y el status sale sin el campo.
     */
    @Volatile
    private var lastGimbalPitch = Double.NaN

    /** Enlace con la aeronave según el controlador de vuelo (KeyConnection). */
    @Volatile
    private var enlaceVivo = false

    @Volatile
    private var enVuelo = false

    @Volatile
    private var satelites = 0

    @Volatile
    private var baseFijada = false

    @Volatile
    private var modelo = ""

    @Volatile
    private var serie = ""

    /** Vínculo por radio control↔aeronave según el control (KeyPairingStatus). */
    @Volatile
    private var vinculacion = Vinculacion.DESCONOCIDA

    @Volatile
    private var serieControl = ""

    /** true entre [connect] y [disconnect]: conectar dos veces registraría dos veces cada oyente. */
    @Volatile
    private var escuchando = false

    /** Qué aterrizaje se está esperando, para avisar el evento que corresponde al tocar el suelo. */
    private enum class Aterrizaje { NINGUNO, EN_BASE, AQUI }

    @Volatile
    private var aterrizajeEsperado = Aterrizaje.NINGUNO

    /**
     * Hay un aterrizaje de la app en curso ([land], un despegue cancelado que
     * ya subía, el corrimiento de un aterrizaje sin revisar), desde la orden
     * hasta el suelo. Es el arreglo de la prueba de campo: después de land()
     * nada marcaba que el dron estaba aterrizando, y el próximo mando —el cero
     * que la consola manda al soltar la palanca, que viaja por otra conexión que
     * el /land y puede llegar después—, el watchdog del mando, el vuelo
     * estacionario de tomar o soltar el control o el de la señal perdida
     * volvían a habilitar el Virtual Stick y a mandar velocidades a 10 Hz, que
     * le cancelan al DJI su aterrizaje automático.
     *
     * Mientras está prendida [asegurarVirtualStick] no habilita nada (salvo el
     * corrimiento), [hold] y [manualStick] no hacen nada, las órdenes de
     * navegación se rechazan y [relevarLazo] no releva a la secuencia. La
     * apagan tocar el suelo, [connect], otra orden de vuelo de una persona
     * ([returnHome], [startRoute], [cancelarAterrizaje], un despegue), una toma
     * del propio DJI ([bloquearPorLaToma]) y el fracaso definitivo de la
     * secuencia. Se escribe con [relevoDeLazo] tomado, junto con el lazo.
     */
    @Volatile
    private var aterrizando = false

    /** El corrimiento de un aterrizaje está en curso: es lo único que habilita el Virtual Stick aterrizando. */
    @Volatile
    private var corriendoseParaAterrizar = false

    /** Lo que ya se anotó como descartado en este aterrizaje: el mando llega a 10 Hz y el logcat no es para eso. */
    private val descartadasAterrizando: MutableSet<String> = ConcurrentHashMap.newKeySet()

    // ---- Lo que decide el propio DJI (docs/RELEVOS.md §0, §4 y §5) ----

    /** Regreso a base, descenso en la base y tomas del control (ver [SeguidorDelRegreso]). */
    private val seguidorDelRegreso = SeguidorDelRegreso()

    /** Estado del regreso según KeyGoHomeStatus; null hasta que el SDK lo informa. */
    private val estadoDelRegreso = MutableStateFlow<GoHomeState?>(null)

    /** El regreso inteligente por batería del DJI y la respuesta de la app a su cuenta regresiva. */
    private val vigiaDelRth = VigiaDelRthPorBateria()

    /**
     * El failsafe que tenía el dron antes de que la app lo pusiera en aterrizar,
     * guardado también en el teléfono ([AlmacenDelFailsafe]): un controlador
     * nuevo —la pantalla se cerró en pleno desvío— lo sigue teniendo pendiente
     * y lo devuelve apenas el dron está en el suelo.
     */
    private val recuerdoDelFailsafe = RecuerdoDelFailsafe(FailsafeAction.LANDING, FailsafeAction.GOHOME, AlmacenDelFailsafe)

    /**
     * La app tiene al dron en un desvío o en el protocolo de última ubicación
     * ([fijarFailsafeAterrizar] en true): el aterrizaje que el dron pida
     * confirmar no se confirma solo (ver [confirmacionDelAterrizaje]). Es lo que
     * la app PIDIÓ, se haya aceptado o no el failsafe.
     */
    @Volatile
    private var fueraDeBase = false

    /** Qué contestarle al dron cuando pide confirmar el aterrizaje (RELEVOS §4). */
    private val confirmacionDelAterrizaje = ConfirmacionDelAterrizaje()

    /**
     * Los cambios de failsafe salen de a uno y en el orden en que se pidieron:
     * prenderlo y apagarlo seguidos no se puede cruzar en el camino al dron.
     */
    private val filaDelFailsafe = Mutex()

    /**
     * El propio DJI se quedó con el vuelo (su regreso por batería, su aterrizaje
     * por batería crítica, el botón de regreso del control) y la app no lo
     * comanda hasta que aterrice: no relanza lazos ni vuelve a habilitar el
     * Virtual Stick (ver [TomaDelDron.bloqueaLaApp]). Null si la app tiene el
     * mando. Lo devuelve a la app [cancelarRegreso], con su único intento.
     */
    @Volatile
    private var tomaDelDron: MotivoDelDron? = null

    /** Lo último de KeyLowBatteryRTHInfo, crudo: la autonomía se arma al emitir la telemetría. */
    @Volatile
    private var lecturaDeAutonomia: LowBatteryRTHInfo? = null

    /** Punto de retorno según KeyHomeLocation (lat y lon de la MISMA lectura); null si no es válido. */
    @Volatile
    private var puntoDeRetorno: Pair<Double, Double>? = null

    /** KeySeriousLowBatteryWarningThreshold: debajo, el DJI aterriza donde esté. */
    @Volatile
    private var umbralCriticoPct = Double.NaN

    /** KeyLowBatteryWarningThreshold: el aviso de batería baja del DJI. */
    @Volatile
    private var umbralAvisoPct = Double.NaN

    /** Cuándo volvió el enlace con la aeronave por última vez (para el motivo de un regreso propio). */
    @Volatile
    private var enlaceVolvioMs = 0L

    /** Destino del lazo de [volarHacia], que el lazo relee. Mismo lock que [navigationJob]. */
    private var destinoDeVuelo: DestinoActualizable? = null

    /** Un cuadro para la detección y cuándo se capturó: con eso [capturarFoto] no entrega uno de antes de pedirla. */
    private class CuadroFechado(val capturadoMs: Long, val jpeg: ByteArray)

    private val cuadrosFechados = MutableSharedFlow<CuadroFechado>(extraBufferCapacity = 2)

    /** Último mando virtual recibido, ya convertido a velocidades del cuerpo. */
    @Volatile
    private var ejesMando = MandoVirtual.NEUTRO

    /**
     * Se prende en [disconnect] y no se apaga hasta el próximo [connect]. Es lo
     * que impide que una vuelta del lazo que venía en camino vuelva a habilitar
     * el Virtual Stick DESPUÉS de que se lo deshabilitó al cerrar la app: si eso
     * pasa, el operador no recupera el dron con las palancas del RC-N3.
     */
    @Volatile
    private var desconectado = false

    /**
     * Lo que el SDK dice del Virtual Stick. Lo pisan tanto [asegurarVirtualStick]
     * como el oyente de estado del propio SDK, que es el que avisa cuando la
     * aeronave revoca la autoridad de vuelo por su cuenta.
     */
    private val virtualStickListo = AtomicBoolean(false)

    /**
     * Último motivo avisado, para que el aviso sea por TRANSICIÓN y no por
     * intento (ver [avisar]). Es atómico y no `@Volatile` porque la comparación y
     * la escritura tienen que ser un solo paso: los avisos salen del hilo del SDK
     * y de los lazos de comando a la vez, y dos hilos con el mismo motivo no
     * pueden avisar los dos.
     */
    private val ultimoAviso = AtomicReference<String?>(null)

    /**
     * Espera del reintento de la habilitación del Virtual Stick. Sin esto, el
     * rechazo se reintentaba en cada vuelta del lazo de comandos: 10 veces por
     * segundo, para siempre (ver [asegurarVirtualStick]).
     */
    private val reintentoDelMandoVirtual = EsperaCreciente(REINTENTO_MANDO_INICIAL_MS, REINTENTO_MANDO_TOPE_MS)

    private val limitadorDeConsola = LimitadorDeRitmo(CuadroDeVideo.INTERVALO_CUADRO_MS)
    private val limitadorDeDeteccion = LimitadorDeRitmo(CuadroDeVideo.INTERVALO_DETECCION_MS)

    /** Un cuadro crudo del MSDK, ya copiado del buffer que el SDK reusa, y a quién va. */
    private class CuadroCrudo(
        val datos: ByteArray,
        val ancho: Int,
        val alto: Int,
        val paraConsola: Boolean,
        val paraDeteccion: Boolean,
        val capturadoMs: Long,
    )

    /**
     * Cola de UN solo lugar entre el hilo del decodificador y el que convierte.
     * Con un solo consumidor el orden se preserva, y con DROP_OLDEST el que se
     * pierde cuando el celular se atrasa es el viejo —que es lo que corresponde
     * en video en vivo— en vez de apilarse corrutinas.
     */
    private val cuadrosPorConvertir =
        Channel<CuadroCrudo>(capacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /**
     * Cuadros de la cámara principal. Ojo con este callback: lo llama el
     * decodificador del MSDK en SU hilo y con SU buffer, que reusa para el cuadro
     * siguiente. Por eso acá solo se copia lo justo y la conversión —hasta un
     * millón de pixeles— se hace en una corrutina aparte: frenar este hilo
     * sería frenar el video entero.
     */
    private val oyenteDeCuadros = object : ICameraStreamManager.CameraFrameListener {
        override fun onFrame(
            frameData: ByteArray,
            offset: Int,
            length: Int,
            width: Int,
            height: Int,
            format: ICameraStreamManager.FrameFormat,
        ) {
            if (format != ICameraStreamManager.FrameFormat.NV21) return
            // El stream llega a 30 cuadros por segundo; a la consola van 5 y a
            // la detección 2, que es lo que manda el contrato.
            val ahora = System.currentTimeMillis()
            val paraConsola = limitadorDeConsola.aceptar(ahora)
            val paraDeteccion = limitadorDeDeteccion.aceptar(ahora)
            if (!paraConsola && !paraDeteccion) return
            val hasta = minOf(offset + length, frameData.size)
            if (offset < 0 || hasta <= offset) return
            val copia = frameData.copyOfRange(offset, hasta)
            cuadrosPorConvertir.trySend(CuadroCrudo(copia, width, height, paraConsola, paraDeteccion, ahora))
        }
    }

    /**
     * Convierte los cuadros de a uno y en orden (ver [cuadrosPorConvertir]).
     *
     * El cuerpo va entero adentro de un runCatching: una excepción sin atrapar
     * en un `launch` no se descarta sola —el SupervisorJob salva al scope, pero
     * el hilo la propaga igual— y se llevaría puesta la app en pleno vuelo. El
     * caso concreto es un OutOfMemoryError reservando el bitmap con el celular
     * ocupado; perder un cuadro de treinta no se nota, perder la app sí.
     */
    private suspend fun convertirCuadros() {
        for (cuadro in cuadrosPorConvertir) {
            runCatching {
                if (cuadro.paraConsola) {
                    CuadroDeVideo.nv21AJpeg(cuadro.datos, 0, cuadro.ancho, cuadro.alto)?.let { videoFrames.tryEmit(it) }
                }
                if (cuadro.paraDeteccion) {
                    CuadroDeVideo.nv21AJpeg(
                        cuadro.datos, 0, cuadro.ancho, cuadro.alto,
                        CuadroDeVideo.ANCHO_DETECCION, CuadroDeVideo.CALIDAD_JPEG_DETECCION,
                    )?.let {
                        cuadrosParaDeteccion.tryEmit(it)
                        cuadrosFechados.tryEmit(CuadroFechado(cuadro.capturadoMs, it))
                    }
                }
            }.onFailure { falla -> Log.w(TAG, "Se descartó un cuadro de video", falla) }
        }
    }

    /**
     * Estado real del Virtual Stick según el SDK. [virtualStickListo] por sí
     * solo recuerda lo que la app PIDIÓ: si la aeronave revoca la autoridad de
     * vuelo por su cuenta —el RC-N3 cambió de modo, arrancó un regreso a base,
     * se cayó el enlace— la marca quedaba en true y nadie volvía a habilitarlo
     * nunca, con el dron ignorando la consola en silencio.
     */
    private val oyenteDeVirtualStick = object : VirtualStickStateListener {
        override fun onVirtualStickStateUpdate(estado: VirtualStickState) {
            virtualStickListo.set(estado.isVirtualStickEnable)
            // El modo avanzado es el único que acepta velocidades: si el dron lo
            // apagó, sendVirtualStickAdvancedParam se come el parámetro y vuelve
            // sin hacer nada, así que hay que reponerlo.
            if (!desconectado && estado.isVirtualStickEnable && !estado.isVirtualStickAdvancedModeEnabled) {
                VirtualStickManager.getInstance().setVirtualStickAdvancedModeEnabled(true)
            }
        }

        override fun onChangeReasonUpdate(motivo: FlightControlAuthorityChangeReason) {
            // MSDK_REQUEST somos nosotros pidiéndolo: eso no es noticia.
            if (motivo == FlightControlAuthorityChangeReason.MSDK_REQUEST) return
            // Batería, el botón de regreso del control o la señal: es el propio
            // DJI quedándose con el vuelo (RELEVOS §4), y se avisa como tal.
            // El resto (el selector de modo, la pausa del control) es el
            // operador con las palancas: el aviso de siempre.
            val toma = TomaDelDron.porCambioDeAutoridad(motivo.name)
            if (toma != null && enVuelo) {
                alTomarElControl(toma)
            } else {
                avisar("la aeronave le sacó la autoridad de vuelo a la app ($motivo)")
            }
        }
    }

    override fun connect() {
        // La pantalla de conexión enciende el controlador y la de operación lo
        // vuelve a pedir: la segunda vez no hay nada que hacer.
        if (escuchando) return
        escuchando = true
        desconectado = false
        aterrizajeEsperado = Aterrizaje.NINGUNO
        // Un aterrizaje de antes no es de este enlace: si el dron sigue bajando,
        // lo termina solo, y la app vuelve a tener el mando.
        aterrizando = false
        corriendoseParaAterrizar = false
        // Lo del vuelo anterior no vale para este enlace: los oyentes de abajo
        // traen el estado actual apenas se registran.
        seguidorDelRegreso.alAterrizar()
        confirmacionDelAterrizaje.reiniciar()
        tomaDelDron = null
        vigiaDelRth.reiniciar()
        estadoDelRegreso.value = null
        lecturaDeAutonomia = null
        // Un solo consumidor de cuadros, y se relanza por si se reconecta
        conversionJob?.cancel()
        conversionJob = scope.launch { convertirCuadros() }
        sdkJob?.cancel()
        sdkJob = scope.launch { DjiSdk.estado.collect { publicarEstado() } }
        // Un solo consumidor, como el de los cuadros: así las órdenes llegan al
        // gimbal en el orden en que se pidieron, sean del operador o de la app.
        // Lo que quedó esperando de antes de una desconexión (a lo sumo una) se
        // tira: era de un vuelo que ya terminó, y aplicarlo al reconectar movería
        // la cámara sin que nadie lo pida.
        camaraJob?.cancel()
        filaDelGimbal.descartarTodo()
        camaraJob = scope.launch { filaDelGimbal.atender() }
        VirtualStickManager.getInstance().setVirtualStickStateListener(oyenteDeVirtualStick)
        // El modo avanzado es una marca local del SDK (no habla con la aeronave):
        // sin ella sendVirtualStickAdvancedParam vuelve sin hacer nada. Se pone
        // acá, de entrada, además de reponerla al habilitar.
        VirtualStickManager.getInstance().setVirtualStickAdvancedModeEnabled(true)
        // La telemetría sale a ritmo fijo y no cuando cambia un valor: el SDK
        // avisa por cambio, y un dron quieto —o sin GPS— dejaba de emitir, la
        // web se quedaba sin estado y el watchdog de PatrolManager tomaba el
        // silencio por una pérdida de señal. Lo único que la corta es el enlace.
        scope.launch {
            while (true) {
                delay(INTERVALO_TELEMETRIA_MS)
                emitTelemetry()
            }
        }

        // Posición del dron (la valida [posicion] al usarla)
        escuchar(FlightControllerKey.KeyAircraftLocation3D) { location ->
            posicionCruda = location.latitude to location.longitude
        }
        escuchar(FlightControllerKey.KeyGPSIsValid) { valido ->
            gpsValido = valido
            publicarEstado()
        }
        escuchar(FlightControllerKey.KeyFlightModeString) { modo ->
            // Para el banco: es lo que dice si el aterrizaje automático arrancó o se cortó.
            if (modo != modoDeVuelo) Log.i(TAG, "Modo de vuelo: $modo (aterrizaje de la app en curso: $aterrizando)")
            modoDeVuelo = modo
            publicarEstado()
        }
        // Altura barométrica sobre el punto de despegue, que es la que entienden
        // las rutas (sus alturas son relativas a la base).
        escuchar(FlightControllerKey.KeyAltitude) { alt -> lastAlt = alt }
        // Con un pedido de confirmar el aterrizaje en pie, cada punto de batería
        // que baja puede ser el momento de confirmarlo (RELEVOS §4). Con un
        // aterrizaje de la app en curso lo mira su secuencia, que lee la batería
        // en cada vuelta: dos que deciden a la vez se pisarían el corrimiento.
        escuchar(BatteryKey.KeyChargeRemainingInPercent) { pct ->
            lastBattery = pct.toDouble()
            if (!aterrizando) atenderElAterrizaje(confirmacionDelAterrizaje.alActualizar(situacionDelAterrizaje()))
        }
        // Rumbo real de la brújula. El MSDK lo da en -180..180 y el resto del
        // sistema lo usa en 0..360 (norte = 0, este = 90).
        escuchar(FlightControllerKey.KeyCompassHeading) { rumbo -> lastHeading = (rumbo + 360.0) % 360.0 }
        // Intensidad del enlace de radio, que es lo que la consola pinta como
        // barritas de señal
        escuchar(AirLinkKey.KeySignalQuality) { calidad -> lastSignal = calidad.coerceIn(0, 100) }
        // Enlace con el dron. Cuando se cae hay que DEJAR de emitir telemetría:
        // el watchdog de PatrolManager detecta la pérdida por el silencio —igual
        // que con el dron simulado— y no por un campo del mensaje. Cuando el
        // enlace vuelve, el ticker reanuda la emisión solo.
        escuchar(FlightControllerKey.KeyConnection) { conectado ->
            Log.i(TAG, "Enlace con la aeronave: $conectado")
            if (conectado && !enlaceVivo) enlaceVolvioMs = System.currentTimeMillis()
            enlaceVivo = conectado
            publicarEstado()
        }
        // En el aire o en el suelo. La transición de true a false es el
        // aterrizaje: es lo que convierte un regreso a base o un "aterrizar acá"
        // en su evento (ver returnHome() y land()).
        escuchar(FlightControllerKey.KeyIsFlying) { volando ->
            val antes = enVuelo
            enVuelo = volando
            if (antes && !volando) alAterrizar()
            // En el suelo —recién aterrizado, o así lo encontró al conectar— se
            // devuelve lo que la app le cambió para un desvío o una emergencia.
            // Solo con esta lectura: con el dron en el aire (la app se recreó en
            // pleno desvío) el failsafe en aterrizar tiene que seguir.
            if (!volando) alQuedarEnElSuelo()
            publicarEstado()
        }
        escuchar(FlightControllerKey.KeyGPSSatelliteCount) { cantidad ->
            satelites = cantidad
            publicarEstado()
        }
        // Punto de retorno. Sin él el dron no sabe volver, y un despegue
        // automático sin punto de retorno es un dron perdido: por eso es parte de
        // listoParaDespegar.
        escuchar(FlightControllerKey.KeyHomeLocation) { casa ->
            baseDistintaDeCero = casa.latitude != 0.0 || casa.longitude != 0.0
            // Dónde quedó, para "fuera de base" y la distancia a casa de la
            // autonomía. Los dos campos son Double de Java: pueden venir null.
            val casaLat: Double? = casa.latitude
            val casaLon: Double? = casa.longitude
            puntoDeRetorno = if (casaLat != null && casaLon != null && Geo.esPosicionValida(casaLat, casaLon)) {
                casaLat to casaLon
            } else {
                null
            }
            publicarEstado()
        }
        // Lo que dice el controlador de vuelo manda sobre la cuenta de arriba:
        // KeyHomeLocation puede traer un punto viejo con el retorno sin fijar.
        escuchar(FlightControllerKey.KeyIsHomeLocationSet) { fijada ->
            baseFijadaSegunSdk = fijada
            publicarEstado()
        }
        escuchar(ProductKey.KeyProductType) { tipo ->
            Log.i(TAG, "Modelo según el SDK: $tipo")
            modelo = tipo.name.replace('_', ' ').replace("DJI ", "")
            publicarEstado()
        }
        // El número de serie de la aeronave: es lo que dice CUÁL dron está
        // enlazado, que es lo que la pantalla de conexión tiene que mostrar.
        escuchar(FlightControllerKey.KeySerialNumber) { numero ->
            Log.i(TAG, "Serie de la aeronave: $numero")
            serie = numero
            publicarEstado()
        }
        // El vínculo por radio entre el control y la aeronave. Con el control sin
        // aeronave vinculada el USB está perfecto y aun así no va a haber enlace
        // nunca. Ojo: el RC-N3 informa UNPAIRED también con el enlace andando, así
        // que solo se lo tiene en cuenta cuando no hay enlace (publicarEstado).
        escuchar(RemoteControllerKey.KeyPairingStatus) { estadoVinculo ->
            Log.i(TAG, "Vinculación del control: $estadoVinculo")
            vinculacion = when (estadoVinculo) {
                PairingState.UNPAIRED -> Vinculacion.SIN_VINCULAR
                PairingState.PAIRING -> Vinculacion.VINCULANDO
                PairingState.PAIRED -> Vinculacion.VINCULADA
                PairingState.UNKNOWN -> Vinculacion.DESCONOCIDA
                else -> Vinculacion.FALLIDA
            }
            publicarEstado()
        }
        escuchar(RemoteControllerKey.KeySerialNumber) { numero ->
            serieControl = numero
            publicarEstado()
        }
        // Inclinación del gimbal: va en la telemetría porque PatrolManager la
        // necesita para proyectar al terreno la caja de una detección.
        escuchar(GimbalKey.KeyGimbalAttitude) { actitud ->
            lastGimbalPitch = actitud.pitch
            lastGimbalYaw = actitud.yaw
        }
        // El Mini pide confirmar el aterrizaje cerca del suelo (por si abajo hay
        // agua o algo que no es suelo). Si la app lo ordenó en su base, la app lo
        // confirma; en un desvío o una emergencia, o forzado por batería crítica,
        // decide ConfirmacionDelAterrizaje (RELEVOS §4). Este oyente avisa por
        // CAMBIO: un pedido que ya estaba en pie cuando llegó la orden no vuelve
        // a contarse, y por eso con un aterrizaje de la app en curso lo contesta
        // su secuencia, que lo lee del dron cada medio segundo.
        escuchar(FlightControllerKey.KeyIsLandingConfirmationNeeded) { pide ->
            Log.i(TAG, "KeyIsLandingConfirmationNeeded=$pide (aterrizaje de la app en curso: $aterrizando)")
            if (!aterrizando) atenderElAterrizaje(confirmacionDelAterrizaje.alPedir(pide, situacionDelAterrizaje()))
        }
        // Autonomía y regreso inteligente por batería (RELEVOS §0 y §4). Llega
        // más o menos una vez por segundo; mientras el DJI cuenta para volver
        // solo, cada actualización trae la cuenta regresiva.
        escuchar(FlightControllerKey.KeyLowBatteryRTHInfo) { info -> alLeerElRthPorBateria(info) }
        // El regreso a base: su descenso (DescendiendoEnBase) y los regresos que
        // nadie pidió (ElDronTomoElControl).
        escuchar(FlightControllerKey.KeyGoHomeStatus) { estado -> alCambiarElRegreso(estado) }
        // Los umbrales de batería del propio DJI (RELEVOS §0): el crítico va al
        // estado y los dos se revisan, porque mal puestos le ganan a la app.
        escuchar(FlightControllerKey.KeySeriousLowBatteryWarningThreshold) { pct ->
            umbralCriticoPct = pct.toDouble()
            revisarUmbrales()
            publicarEstado()
        }
        escuchar(FlightControllerKey.KeyLowBatteryWarningThreshold) { pct ->
            umbralAvisoPct = pct.toDouble()
            revisarUmbrales()
        }
        // Con la batería crítica el Mini aterriza solo donde esté, tenga o no el
        // Virtual Stick habilitado: sin este oyente, un aterrizaje forzado con el
        // dron estacionario (sin lazo, sin cambio de autoridad que lo cuente)
        // pasaba mudo (a comprobar en el banco, RELEVOS §8).
        escuchar(FlightControllerKey.KeyIsSeriousLowBatteryWarning) { critica ->
            if (critica && enVuelo) alTomarElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA)
        }

        // Video real: los cuadros de la cámara principal (la del gimbal) en
        // NV21, que es el formato que sale del decodificador sin conversión.
        MediaDataCenter.getInstance().getCameraStreamManager().addFrameListener(
            ComponentIndexType.LEFT_OR_MAIN,
            ICameraStreamManager.FrameFormat.NV21,
            oyenteDeCuadros,
        )
        // Traza de campo: qué ve el SDK del control y de la aeronave (logcat)
        DiagnosticoDeEnlace.registrar(this)
        publicarEstado()
    }

    /** Suscribe una llave del SDK, ignorando los nulos (que el SDK manda al perder el dato). */
    private fun <T> escuchar(llave: DJIKeyInfo<T>, alCambiar: (T) -> Unit) {
        val km = KeyManager.getInstance()
        val key = KeyTools.createKey(llave)
        // El valor que el SDK ya tiene en caché, para no esperar al próximo cambio
        km.getValue(key)?.let(alCambiar)
        km.listen(key, this) { _, nuevo -> if (nuevo != null) alCambiar(nuevo) }
    }

    /**
     * Arma el estado que ve la pantalla a partir del SDK y de las llaves. El
     * `detalle` dice qué FALTA, en orden de lo más básico a lo más fino: es lo
     * que el operador lee cuando no puede despegar.
     */
    private fun publicarEstado() {
        val sdk = DjiSdk.estado.value
        val conectado = sdk.productoConectado && enlaceVivo
        val casa = puntoDeRetorno
        baseFijada = baseFijadaSegunSdk ?: baseDistintaDeCero
        val detalle = when {
            sdk.ultimoError.isNotBlank() && !sdk.registrado -> sdk.ultimoError
            !sdk.registrado -> "Registrando la app ante DJI… (hace falta internet la primera vez)"
            !sdk.productoConectado -> "Conectá el control al teléfono por USB y encendé el dron"
            // La vinculación solo dice algo SIN enlace: con enlace, el RC-N3
            // informa UNPAIRED igual (ver Vinculacion.SIN_VINCULAR).
            !enlaceVivo && vinculacion == Vinculacion.VINCULANDO ->
                "Vinculando: mantené apretado el botón de encendido del dron unos 4 segundos, hasta que pite"
            !enlaceVivo && vinculacion == Vinculacion.FALLIDA ->
                "La vinculación no se completó: volvé a intentarla con el dron encendido y cerca del control"
            !enlaceVivo -> "Control conectado, sin enlace con la aeronave: encendela y esperá (puede tardar medio minuto)"
            !baseFijada -> "Esperando que el dron fije el punto de retorno (GPS: $satelites satélites)"
            satelites < EstadoDelDron.SATELITES_MINIMOS -> "GPS insuficiente: $satelites satélites (hacen falta ${EstadoDelDron.SATELITES_MINIMOS})"
            enVuelo -> "En vuelo"
            else -> "En el suelo, listo para despegar (control en modo N)"
        }
        _estado.value = EstadoDelDron(
            sdkListo = sdk.registrado,
            conectado = conectado,
            modelo = modelo,
            enVuelo = enVuelo,
            satelites = satelites,
            baseFijada = baseFijada,
            detalle = detalle,
            controlConectado = sdk.productoConectado,
            serie = serie,
            vinculacion = vinculacion,
            serieControl = serieControl,
            modoDeVuelo = modoDeVuelo,
            puntoDeRetornoLat = casa?.first ?: Double.NaN,
            puntoDeRetornoLon = casa?.second ?: Double.NaN,
            umbralCriticoPct = umbralCriticoPct,
        )
    }

    override fun vincularControl() {
        scope.launch { accion(RemoteControllerKey.KeyRequestPairing, "iniciar la vinculación con la aeronave") }
    }

    override fun cancelarVinculacion() {
        scope.launch { accion(RemoteControllerKey.KeyStopPairing, "cancelar la vinculación") }
    }

    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) {
        if (rechazarSiElDronTieneElControl("seguir una ruta")) return
        // Una ruta es otra orden de vuelo: corta un aterrizaje en curso.
        val cortoUnAterrizaje = synchronized(relevoDeLazo) {
            val corto = soltarElAterrizaje("se ordenó una ruta")
            lanzarRuta(route, fromWaypoint)
            // Desde el suelo, hasta dejarlo se puede abortar (ver cancelarDespegueEnElSuelo).
            if (!enVuelo) despegue = Despegue.PREPARANDO
            corto
        }
        if (cortoUnAterrizaje) detenerElAterrizajeAutomatico()
    }

    private fun lanzarRuta(route: PatrolRoute, fromWaypoint: Int) {
        relevarLazo(Lazo.RUTA) {
            var target = fromWaypoint.coerceIn(0, route.waypoints.size - 1)
            val alturaDeTrabajo = alturaDeVuelo(route.waypoints[target].alt)
            val arriba = try {
                if (!enVuelo) {
                    flightEvents.tryEmit(FlightEvent.Despegando)
                    if (!despegar()) return@relevarLazo
                }
                asegurarVirtualStick()
                // Primero la altura, después el plano: a un metro del suelo no se
                // sale a 8 m/s hacia ningún lado.
                subirA { alturaDeTrabajo }
            } finally {
                despegueTerminado()
            }
            if (!arriba) return@relevarLazo
            flightEvents.tryEmit(FlightEvent.EnElAire)
            // La cámara oblicua hacia abajo: la vista con la que se entrenó el
            // detector, y la que deja ver adelante sin perder lo que hay debajo.
            // Se apunta una sola vez, así que tiene que ser la ÚLTIMA orden que
            // le llega al gimbal: va por la misma fila que las de la consola y
            // sale cuando el gimbal terminó la inclinación que el operador haya
            // dejado en curso al soltar el control, pisando la que esperaba
            // (que, además, PatrolManager ya mandó tirar al salir de MANUAL).
            apuntarCamara(Telemetry.GIMBAL_PATRULLA)
            while (true) {
                delay(INTERVALO_MANDO_MS) // Virtual Stick requiere comandos a ~10 Hz
                // Sin posición válida (se perdió el fix) no se vuela hacia
                // ninguna coordenada: estacionario hasta que vuelva.
                val (lat, lon) = posicion() ?: run {
                    enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                    null
                } ?: continue
                val wp = route.waypoints[target]
                val paso = Navegacion.hacia(lat, lon, wp.lat, wp.lon)
                if (paso.llego) {
                    flightEvents.tryEmit(FlightEvent.WaypointReached(target))
                    target = (target + 1) % route.waypoints.size
                    continue
                }
                enviarVelocidadTerreno(
                    paso.vNorteMs,
                    paso.vEsteMs,
                    paso.rumboGrados,
                    Navegacion.vertical(lastAlt, alturaDeVuelo(wp.alt)),
                )
            }
        }
    }

    override fun hold() {
        if (!enVuelo) {
            // En el suelo ya está quieto; con un despegue pendiente, quedarse
            // donde está es no despegar.
            cancelarDespegueEnElSuelo(Aterrizaje.AQUI)
            return
        }
        // Aterrizando, quedarse quieto no es otra orden de vuelo (ver DroneController.land).
        if (descartarAterrizando("quedar estacionario")) return
        if (rechazarSiElDronTieneElControl("quedar estacionario")) return
        relevarLazo(Lazo.ESTACIONARIO) {
            asegurarVirtualStick()
            // Vuelo estacionario = velocidad cero SOSTENIDA. Si simplemente se
            // dejara de comandar, el dron saldría del Virtual Stick y volvería a
            // obedecer al palito físico del RC-N3, que nadie está tocando.
            while (true) {
                enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                delay(INTERVALO_MANDO_MS)
            }
        }
    }

    override fun gotoPoint(lat: Double, lon: Double) {
        if (rechazarEnElSuelo("ir a un punto")) return
        if (rechazarAterrizando("ir a un punto")) return
        if (rechazarSiElDronTieneElControl("ir a un punto")) return
        relevarLazo(Lazo.GOTO) {
            asegurarVirtualStick()
            val altura = lastAlt
            while (true) {
                delay(INTERVALO_MANDO_MS)
                val (aquiLat, aquiLon) = posicion() ?: run {
                    enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                    null
                } ?: continue
                val paso = Navegacion.hacia(aquiLat, aquiLon, lat, lon)
                if (paso.llego) {
                    flightEvents.tryEmit(FlightEvent.GotoArrived)
                    break
                }
                enviarVelocidadTerreno(paso.vNorteMs, paso.vEsteMs, paso.rumboGrados, Navegacion.vertical(lastAlt, altura))
            }
            // Llegó: queda en vuelo estacionario en el mismo lazo, sin cortar el
            // Virtual Stick (ver hold()).
            while (true) {
                enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                delay(INTERVALO_MANDO_MS)
            }
        }
    }

    override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double) {
        if (rechazarEnElSuelo("orbitar")) return
        if (rechazarAterrizando("orbitar")) return
        if (rechazarSiElDronTieneElControl("orbitar")) return
        // El lazo relee el centro en cada vuelta: si ya está orbitando, correr
        // el centro es solo esto, sin cortar el giro (el objetivo estimado se
        // corrige con cada detección y la órbita lo acompaña sin saltos).
        orbita = Orbita(centerLat, centerLon, radiusM)
        synchronized(relevoDeLazo) {
            if (lazoActual == Lazo.ORBITA && navigationJob?.isActive == true) return
            relevarLazo(Lazo.ORBITA) {
                asegurarVirtualStick()
                // Ni a ras del suelo: orbitar a 30 m de radio a 5 m de altura es
                // meterse entre los árboles (pasa al soltar el control manual).
                val altura = maxOf(lastAlt, ALTURA_MINIMA_SEGUIMIENTO_M)
                val gimbal = GimbalQueAcompania()
                while (true) {
                    delay(INTERVALO_MANDO_MS)
                    val o = orbita ?: continue
                    val (lat, lon) = posicion() ?: run {
                        enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                        null
                    } ?: continue
                    // Tangencial sobre el círculo con corrección radial, desde
                    // donde esté el dron (sin ir a un punto fijo del círculo) y
                    // con la nariz —y la cámara— apuntadas al centro.
                    val paso = Navegacion.orbitar(lat, lon, o.lat, o.lon, o.radioM)
                    enviarVelocidadTerreno(paso.vNorteMs, paso.vEsteMs, paso.rumboGrados, Navegacion.vertical(lastAlt, altura))
                    // El gimbal baja lo justo para tener al objetivo en el medio del cuadro.
                    gimbal.apuntar(Georreferencia.inclinacionParaOrbitar(lastAlt, paso.distanciaM))
                }
            }
        }
    }

    override fun seguirObjetivo(lat: Double, lon: Double, vNorteMs: Double, vEsteMs: Double) {
        if (rechazarEnElSuelo("seguir al objetivo")) return
        if (rechazarAterrizando("seguir al objetivo")) return
        if (rechazarSiElDronTieneElControl("seguir al objetivo")) return
        // Igual que la órbita: el lazo relee la estimación en cada vuelta, así
        // que actualizarla no corta el seguimiento.
        seguido = Seguido(lat, lon, vNorteMs, vEsteMs, System.currentTimeMillis())
        synchronized(relevoDeLazo) {
            if (lazoActual == Lazo.SEGUIMIENTO && navigationJob?.isActive == true) return
            relevarLazo(Lazo.SEGUIMIENTO) {
                asegurarVirtualStick()
                val altura = maxOf(lastAlt, ALTURA_MINIMA_SEGUIMIENTO_M)
                val gimbal = GimbalQueAcompania()
                while (true) {
                    delay(INTERVALO_MANDO_MS)
                    val o = seguido ?: continue
                    val (aquiLat, aquiLon) = posicion() ?: run {
                        enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                        null
                    } ?: continue
                    // Entre una estimación y la siguiente (llegan a ~2 Hz) el
                    // objetivo se adelanta con su velocidad, hasta un tope: más
                    // allá la velocidad vieja ya no dice nada.
                    val edadS = (System.currentTimeMillis() - o.desdeMs).coerceIn(0L, EXTRAPOLACION_MAXIMA_MS) / 1_000.0
                    val oLat = o.lat + o.vNorteMs * edadS / Geo.METROS_POR_GRADO_LAT
                    val oLon = o.lon + o.vEsteMs * edadS / Geo.metrosPorGradoLon(o.lat)
                    val orden = Persecucion.calcular(aquiLat, aquiLon, lastAlt, oLat, oLon, o.vNorteMs, o.vEsteMs)
                    enviarVelocidadTerreno(orden.vNorteMs, orden.vEsteMs, orden.rumboGrados, Navegacion.vertical(lastAlt, altura))
                    gimbal.apuntar(orden.gimbalPitch)
                }
            }
        }
    }

    /**
     * Inclina el gimbal hacia donde se le pide, pero solo si el cambio es de más
     * de [UMBRAL_GIMBAL_GRADOS] y como mucho una vez por segundo: cada orden al
     * gimbal es una acción del SDK con su ida y vuelta, y pedirla diez veces por
     * segundo (el ritmo del lazo) sería pelearse con él.
     *
     * Como solo vuelve a apuntar cuando lo que quiere se corre, la primera orden
     * de la órbita o del seguimiento no puede quedar pisada por una inclinación
     * de la consola que llegue después: por eso [apuntarCamara] va por
     * [filaDelGimbal], detrás de lo que el operador haya dejado en curso.
     */
    private inner class GimbalQueAcompania {
        private var ultimo = Double.NaN
        private var ultimoMs = 0L

        fun apuntar(pitch: Double) {
            val ahora = System.currentTimeMillis()
            if (!ultimo.isNaN() && abs(pitch - ultimo) < UMBRAL_GIMBAL_GRADOS) return
            if (ahora - ultimoMs < INTERVALO_GIMBAL_MS) return
            ultimo = pitch
            ultimoMs = ahora
            apuntarCamara(pitch)
        }
    }

    override fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) {
        // Aterrizando, el mando no le habla al dron: el cero que la consola manda
        // al soltar la palanca le cancelaba el aterrizaje (ver DroneController.land).
        if (descartarAterrizando("el mando manual")) return
        if (rechazarEnElSuelo("el mando manual")) return
        if (rechazarSiElDronTieneElControl("usar el mando manual")) return
        // El lazo lee estos ejes en cada vuelta: un mensaje nuevo solo los pisa.
        ejesMando = MandoVirtual.velocidades(pitch, roll, yaw, throttle)
        synchronized(relevoDeLazo) {
            // Mirar y relanzar van juntos, adentro del mismo lock: entre "el
            // lazo del mando ya está corriendo" y relanzarlo no puede meterse
            // otro hilo, que es como quedaban dos lazos vivos a la vez.
            if (lazoActual == Lazo.MANDO && navigationJob?.isActive == true) return
            relevarLazo(Lazo.MANDO) {
                asegurarVirtualStick()
                // El lazo sigue a 10 Hz aunque los ejes estén en cero, por lo
                // mismo que hold(): el Virtual Stick se sostiene comandando.
                while (true) {
                    enviarVelocidadCuerpo(ejesMando)
                    delay(INTERVALO_MANDO_MS)
                }
            }
        }
    }

    /**
     * La inclinación pedida desde la consola. No toca el lazo de comandos —el
     * gimbal es otro componente y mover la cámara no cambia el vuelo—, así que
     * vale en el suelo y en el aire. Llega desde el hilo lector del WebSocket:
     * acá solo se encola, y la llamada al SDK la hace [camaraJob] fuera de ese
     * hilo, como el resto de las acciones del SDK.
     *
     * Por arriba del horizonte el Mini sube solo si la aeronave tiene habilitada
     * la inclinación hacia arriba (un ajuste de DJI Fly que la app no toca): si
     * no, el gimbal la limita o la rechaza, y el rechazo se avisa.
     */
    override fun inclinarCamara(pitchGrados: Double) {
        if (!pitchGrados.isFinite()) return
        filaDelGimbal.inclinarDesdeLaConsola(pitchGrados.coerceIn(INCLINACION_MINIMA, INCLINACION_MAXIMA))
    }

    /**
     * Tira la inclinación de la consola que esperaba en [filaDelGimbal]; la que
     * el gimbal está cumpliendo termina (el SDK ya la tiene) y lo que la app
     * apunte después sale detrás de ella. Si esa no contesta, se la da por
     * perdida a los [ESPERA_GIMBAL_MS] y su respuesta tardía no toca nada (ver
     * [girarGimbalYEsperar]). La cámara que esté apuntando la app no se toca.
     */
    override fun cancelarInclinacionManual() {
        filaDelGimbal.descartarLaDeLaConsola()
    }

    override fun returnHome() {
        if (!enVuelo) {
            // Un despegue pendiente no sale: el dron ya está en su base.
            cancelarDespegueEnElSuelo(Aterrizaje.EN_BASE)
            return
        }
        // Ya vuelve porque la app lo pidió: pedirlo otra vez no es otro regreso.
        if (aterrizajeEsperado == Aterrizaje.EN_BASE && seguidorDelRegreso.volviendo) return
        // Volver a la base es otra orden de vuelo: corta un aterrizaje en curso,
        // y al DJI se le dice que deje de aterrizar ANTES de pedirle el regreso
        // (sale por el SDK antes que el KeyStartGoHome de abajo).
        if (synchronized(relevoDeLazo) { soltarElAterrizaje("se ordenó volver a la base") }) detenerElAterrizajeAutomatico()
        // Sin lazo nuevo: el regreso a base lo maneja el propio dron. Se le
        // devuelve antes la autoridad de vuelo, que es lo que el RTH necesita.
        cortarLazo()
        apagarVirtualStick()
        aterrizajeEsperado = Aterrizaje.EN_BASE
        seguidorDelRegreso.alOrdenar(SeguidorDelRegreso.Orden.REGRESO)
        if (seguidorDelRegreso.volviendo) {
            // El dron ya estaba volviendo por su cuenta: la app lo adopta en vez
            // de pedir otro regreso (que el SDK rechazaría). Si ya está bajando,
            // el descenso se avisa ahora: el oyente no vuelve a contar un estado
            // que no cambió, y un relevo de patrulla lo necesita (RELEVOS §2.3).
            estadoDelRegreso.value?.let(::alCambiarElRegreso)
            return
        }
        scope.launch {
            if (!accion(FlightControllerKey.KeyStartGoHome, "volver a la base")) aterrizajeEsperado = Aterrizaje.NINGUNO
        }
    }

    override fun land() {
        if (!enVuelo) {
            // Abortar un despegue que todavía no dejó el suelo (un relevo
            // cancelado con B en la plataforma): no despega.
            cancelarDespegueEnElSuelo(Aterrizaje.AQUI)
            return
        }
        iniciarElAterrizaje(Aterrizaje.AQUI)
    }

    /**
     * Corta el aterrizaje en curso porque una persona dio otra orden de vuelo
     * (ver DroneController.cancelarAterrizaje): la secuencia termina y el DJI
     * deja de aterrizar. Sin el Virtual Stick, queda suspendido donde está
     * hasta la orden que sigue.
     */
    override fun cancelarAterrizaje() {
        val cortado = synchronized(relevoDeLazo) {
            if (!aterrizando) return
            val enElAire = soltarElAterrizaje("una persona dio otra orden de vuelo")
            cortarLazo()
            aterrizajeEsperado = Aterrizaje.NINGUNO
            enElAire
        }
        if (cortado) detenerElAterrizajeAutomatico()
    }

    override fun despegarEnElLugar() {
        if (enVuelo) return
        synchronized(relevoDeLazo) {
            // Un despegue es otra orden: el aterrizaje de un despegue cancelado no sigue.
            soltarElAterrizaje("se ordenó despegar")
            relevarLazo(Lazo.DESPEGUE) {
                val arriba = try {
                    // Sin GPS se puede (en interior el Mini se sostiene con los
                    // sensores de visión); sin enlace con la aeronave, no.
                    val listo = _estado.value
                    if (!listo.conectado) {
                        avisar("no se puede despegar: ${listo.detalle}")
                        return@relevarLazo
                    }
                    flightEvents.tryEmit(FlightEvent.Despegando)
                    ordenarDespegue() && esperarDespegue()
                } finally {
                    despegueTerminado()
                }
                // Y nada más: el propio dron se sostiene suspendido donde quedó,
                // y el palito físico del RC-N3 sigue mandando hasta que llegue el
                // primer mando de la consola (que habilita el Virtual Stick).
                if (arriba) flightEvents.tryEmit(FlightEvent.EnElAire)
            }
            despegue = Despegue.PREPARANDO
        }
    }

    /**
     * El motivo de un error del SDK para el operador. El MSDK suele rechazar con
     * la descripción en null (en el campo: "el dron no aceptó despegar (null)"),
     * así que se cae a la pista y, si tampoco hay, al tipo y código del error,
     * que al menos se pueden buscar.
     */
    private fun describir(error: IDJIError): String =
        error.description()?.takeIf { it.isNotBlank() && it != "null" }
            ?: error.hint()?.takeIf { it.isNotBlank() && it != "null" }
            ?: listOfNotNull(error.errorType()?.name, error.errorCode(), error.innerCode())
                .filter { it.isNotBlank() && it != "null" }
                .joinToString(" / ")
                .ifBlank { "sin motivo del SDK" }

    /** Tocó el suelo: el evento depende de qué se había ordenado. */
    private fun alAterrizar() {
        Log.i(TAG, "Tocó el suelo (aterrizaje esperado: $aterrizajeEsperado, de la app en curso: $aterrizando)")
        when (aterrizajeEsperado) {
            Aterrizaje.EN_BASE -> flightEvents.tryEmit(FlightEvent.ArrivedHome)
            Aterrizaje.AQUI -> flightEvents.tryEmit(FlightEvent.Aterrizado)
            // Aterrizó sin que la app lo ordenara (el propio regreso a base del
            // dron por señal o batería, o las palancas del control): igual hay
            // que avisarlo, o la patrulla queda en un estado de vuelo con el dron
            // en el suelo.
            Aterrizaje.NINGUNO -> flightEvents.tryEmit(FlightEvent.Aterrizado)
        }
        aterrizajeEsperado = Aterrizaje.NINGUNO
        // El vuelo terminó: si el DJI se había quedado con el mando, el próximo
        // despegue vuelve a ser de la app, y la cuenta del regreso arranca de cero.
        tomaDelDron = null
        seguidorDelRegreso.alAterrizar()
        // En el suelo no se sostiene ningún lazo: el que hubiera manda ceros a
        // un dron apagado y lo peor, lo deja con el Virtual Stick tomado.
        cortarLazo()
        apagarVirtualStick()
    }

    /**
     * Cerrar la puerta ANTES de cortar es la mitad del arreglo. Antes se
     * deshabilitaba el Virtual Stick sin más: una vuelta del lazo que ya había
     * pasado el `delay` entraba a `enviarVelocidadCuerpo`, llamaba a
     * [asegurarVirtualStick] y lo volvía a habilitar DESPUÉS del disable. El
     * Virtual Stick quedaba prendido con la app cerrada y el operador no
     * recuperaba el dron con las palancas del RC-N3.
     *
     * No se ESPERA a que el lazo muera, y eso es a propósito. Esto lo llaman
     * `onDestroy()` y el botón de "Desconectar y volver al login", los dos en el
     * hilo principal de Android: esperar el corte —aunque sea con tope— congelaba
     * la pantalla hasta medio segundo cada vez que el lazo estaba en medio de una
     * llamada al SDK, incluida cada recreación por rotación.
     *
     * Lo que impide que una vuelta en camino vuelva a HABILITAR el Virtual Stick
     * es `desconectado`, que ya quedó en true y lo miran tanto
     * [asegurarVirtualStick] como el `onSuccess` de su callback. Ese `onSuccess`
     * tardío apaga por [mandarApagado] y no por [apagarVirtualStick], porque el
     * paso 4 de acá abajo ya consumió la marca: ruteado por la marca, el apagado
     * tardío no salía nunca.
     */
    override fun disconnect() {
        // 1) Se cierra la puerta: ningún lazo puede volver a habilitarlo.
        desconectado = true
        escuchando = false
        // 2) Se corta el lazo de comandos, sin esperarlo (ver arriba).
        cortarLazo()
        // En el suelo, el failsafe del operador vuelve ya (en el aire queda en
        // aterrizar: la casa puede no alcanzarse). Va directo al SDK porque lo
        // que sigue corta las corrutinas; si no se puede, queda guardado y lo
        // devuelve el próximo controlador.
        if (!enVuelo) restaurarFailsafeAlDespedirse()
        // 3) Se corta todo lo demás que sigue emitiendo: sin esto las
        //    conversiones ya lanzadas seguían publicando cuadros de un dron del
        //    que la app ya se despidió.
        scope.coroutineContext.cancelChildren()
        conversionJob = null
        sdkJob = null
        camaraJob = null
        MediaDataCenter.getInstance().getCameraStreamManager().removeFrameListener(oyenteDeCuadros)
        VirtualStickManager.getInstance().removeVirtualStickStateListener(oyenteDeVirtualStick)
        KeyManager.getInstance().cancelListen(this)
        // 4) Y recién ahora se le devuelve el mando al palito físico del RC-N3.
        apagarVirtualStick()
    }

    private fun emitTelemetry() {
        // Sin enlace no se emite nada: ese silencio es lo que le avisa al
        // watchdog de PatrolManager que se perdió el dron. Sin GPS SÍ se emite,
        // con la posición en NaN: batería, altura y rumbo valen igual.
        if (!enlaceVivo) return
        val p = posicion()
        val autonomia = autonomiaActual(p)
        telemetry.tryEmit(
            Telemetry(
                p?.first ?: Double.NaN, p?.second ?: Double.NaN, lastAlt, lastBattery, lastSignal, lastHeading,
                System.currentTimeMillis(), lastGimbalPitch, rumboDeLaCamara(),
                pctParaVolver = autonomia.pctParaVolver,
                pctParaAterrizar = autonomia.pctParaAterrizar,
                alcanceM = autonomia.alcanceM,
                segundosParaVolver = autonomia.segundosParaVolver,
            ),
        )
    }

    /**
     * La autonomía de la última lectura de KeyLowBatteryRTHInfo, con el dron
     * donde está AHORA: un cero de esa lectura vale o no según a cuánto de casa
     * esté (ver [AutonomiaInformada.delDji]).
     */
    private fun autonomiaActual(aqui: Pair<Double, Double>?): AutonomiaInformada {
        val info = lecturaDeAutonomia ?: return AutonomiaInformada.DESCONOCIDA
        val casa = puntoDeRetorno
        val distancia = if (aqui != null && casa != null) {
            Geo.distanciaM(aqui.first, aqui.second, casa.first, casa.second)
        } else {
            Double.NaN
        }
        return AutonomiaInformada.delDji(
            pctParaVolver = info.batteryPercentNeededToGoHome,
            pctParaAterrizar = info.batteryPercentNeededToLand,
            alcanceM = info.maxRadiusCanFlyAndGoHome,
            segundosParaVolver = info.timeNeededToGoHome,
            enVuelo = enVuelo,
            distanciaACasaM = distancia,
        )
    }

    /**
     * La posición del dron si es una posición GPS de verdad; null si no hay fix.
     * Lat y lon salen de la MISMA lectura.
     */
    private fun posicion(): Pair<Double, Double>? {
        if (gpsValido == false) return null
        val p = posicionCruda ?: return null
        return p.takeIf { Geo.esPosicionValida(it.first, it.second) }
    }

    /**
     * Hacia dónde mira la cámara, para georreferenciar lo que ve. El yaw del
     * gimbal que informa el SDK es absoluto (NED) según la documentación; por
     * las dudas solo se le cree si está cerca del rumbo de la nariz —en el Mini
     * el gimbal sigue a la nariz—, y si no se usa la brújula.
     */
    private fun rumboDeLaCamara(): Double {
        val yaw = lastGimbalYaw
        if (yaw.isNaN()) return lastHeading
        val rumbo = (yaw + 360.0) % 360.0
        val diferencia = abs(((rumbo - lastHeading + 540.0) % 360.0) - 180.0)
        return if (diferencia <= MAXIMA_DIFERENCIA_GIMBAL_GRADOS) rumbo else lastHeading
    }

    /**
     * Inclina el gimbal a [pitchGrados] (0 horizonte, −90 nadir) en ángulo
     * absoluto, para los modos autónomos: nunca por arriba del horizonte, que
     * para patrullar u orbitar no sirve. Un rechazo se avisa, pero no frena nada:
     * volar sin la cámara donde se quiere es peor que no volar solo si el
     * operador no se entera.
     *
     * No llama al SDK acá: la deja en [filaDelGimbal], detrás de lo que esté
     * cumpliendo el gimbal, para que ninguna inclinación de la consola le llegue
     * después. Tampoco espera: los lazos de vuelo no pueden frenarse por la
     * cámara.
     *
     * Es también la implementación real de [DroneController.apuntarCamara]
     * (las fotos del protocolo de última ubicación, docs/RELEVOS.md §5): por la
     * misma fila, así ninguna inclinación vieja la pisa.
     */
    override fun apuntarCamara(pitchGrados: Double) {
        filaDelGimbal.apuntarDesdeLaApp(pitchGrados.coerceIn(-90.0, 0.0))
    }

    /**
     * La orden al gimbal propiamente dicha (KeyRotateByAngle en ángulo ABSOLUTO,
     * solo el pitch). La llama nada más el consumidor de [filaDelGimbal], vía
     * [girarGimbalYEsperar], para que las órdenes salgan de a una y en orden.
     * [duracionS] es lo que tarda en llegar. [motivoDelRechazo] arma el aviso
     * con la descripción del error del SDK. [alTerminar] se llama una vez, cuando
     * el SDK contestó (true si la aceptó).
     *
     * No puede tirar nunca: una excepción del SDK (sin producto, sin registrar)
     * se llevaría puesto al consumidor de la fila y la cámara quedaría sorda el
     * resto de la sesión. Una excepción se avisa igual que un rechazo.
     */
    private fun girarGimbal(
        pitchGrados: Double,
        duracionS: Double,
        motivoDelRechazo: (String) -> String,
        alTerminar: (Boolean) -> Unit,
    ) {
        val giro = GimbalAngleRotation().apply {
            mode = GimbalAngleRotationMode.ABSOLUTE_ANGLE
            pitch = pitchGrados
            roll = 0.0
            yaw = 0.0
            pitchIgnored = false
            rollIgnored = true
            yawIgnored = true
            duration = duracionS
            jointReferenceUsed = false
            timeout = 10
        }
        runCatching {
            KeyManager.getInstance().performAction(
                KeyTools.createKey(GimbalKey.KeyRotateByAngle),
                giro,
                object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                    override fun onSuccess(resultado: EmptyMsg?) = alTerminar(true)

                    override fun onFailure(error: IDJIError) {
                        avisar(motivoDelRechazo(describir(error)))
                        alTerminar(false)
                    }
                },
            )
        }.onFailure { falla ->
            avisar(motivoDelRechazo(falla.message ?: falla.javaClass.simpleName))
            alTerminar(false)
        }
    }

    /**
     * [girarGimbal] esperando a que el SDK conteste: es lo que le da sentido a
     * [filaDelGimbal], que solo puede quedarse con la última orden si la
     * atención se detiene mientras el gimbal cumple la anterior, y lo que
     * garantiza que la cámara de la app no salga antes de que el gimbal haya
     * contestado la inclinación de la consola que estaba cumpliendo. El tope por
     * si el callback no llega nunca lo pone [UltimoPedido]; al vencer, la
     * continuación ya está cancelada y un callback tardío no la toca.
     */
    private suspend fun girarGimbalYEsperar(pitchGrados: Double, duracionS: Double, motivoDelRechazo: (String) -> String) {
        suspendCancellableCoroutine<Unit> { continuacion ->
            girarGimbal(pitchGrados, duracionS, motivoDelRechazo) {
                if (continuacion.isActive) continuacion.resume(Unit)
            }
        }
    }

    // ---- Relevos, desvío a otra base y última ubicación (docs/RELEVOS.md) ----

    /**
     * El despegue de B en un relevo (RELEVOS §2.4, §2.5 y §3.3), en este orden:
     *
     *  1. el Virtual Stick se habilita EN EL SUELO y se espera la confirmación:
     *     si el dron no lo acepta (el control en S o C, típicamente) no despega,
     *     y quien llama rechaza el relevo sin haber movido nada. Si ya se lo
     *     preparó al aceptar el relevo ([prepararDespegue]), sigue de largo;
     *  2. despegue automático del SDK (KeyStartTakeoff);
     *  3. subida vertical, sin componente horizontal, hasta la altura pedida
     *     ± 1,5 m (la de [alturaM], o la que [cambiarAltura] haya puesto en
     *     el camino): las plataformas están a 10 m una de otra y B sube por su
     *     columna;
     *  4. estacionario ahí, sosteniendo el Virtual Stick y la altura, hasta la
     *     orden que sigue.
     *
     * Hasta que deja el suelo, [land], [hold] y [returnHome] lo abortan (ver
     * [cancelarDespegueEnElSuelo]). Si el despegue o la subida fallan avisa
     * [FlightEvent.Problema] (y quien llama aterriza); si falla antes de estar
     * en el aire, le devuelve el mando al control físico. En el aire no hace
     * nada.
     */
    override fun despegarHasta(alturaM: Double) {
        if (enVuelo || !alturaM.isFinite()) return
        val altura = alturaDeVuelo(alturaM)
        synchronized(relevoDeLazo) {
            soltarElAterrizaje("se ordenó despegar para un relevo")
            alturaPedida = altura
            relevarLazo(Lazo.DESPEGUE_A_ALTURA) {
                val arriba = try {
                    val listo = _estado.value
                    if (!listo.listoParaDespegar) {
                        avisar("no se puede despegar: ${listo.detalle}")
                        return@relevarLazo
                    }
                    if (!habilitarVirtualStickEnElSuelo()) return@relevarLazo
                    flightEvents.tryEmit(FlightEvent.Despegando)
                    if (!ordenarDespegue() || !esperarDespegue()) {
                        // En el suelo con el Virtual Stick tomado el operador no
                        // recupera el dron con las palancas.
                        apagarVirtualStick()
                        return@relevarLazo
                    }
                    subirA { alturaPedida ?: altura }
                } finally {
                    despegueTerminado()
                }
                if (!arriba) return@relevarLazo
                flightEvents.tryEmit(FlightEvent.EnElAire)
                // Estacionario en el mismo lazo, sin soltar el Virtual Stick (ver hold()).
                sostenerAlturaPedida()
            }
            despegue = Despegue.PREPARANDO
        }
    }

    /**
     * Habilita el Virtual Stick y espera la respuesta del dron, con tope. Es la
     * versión que espera de [asegurarVirtualStick], para el despegue de un
     * relevo: ahí la respuesta decide si se despega o no.
     *
     * Si el dron no contesta a tiempo se le pide apagarlo igual, y lo mismo si
     * contesta después de que la espera se cortó (un despegue cancelado en el
     * suelo, la corrutina de quien preparaba el relevo): una habilitación que
     * llegara tarde dejaría al dron en el suelo con el mando tomado y sin nadie
     * que lo comande. La marca se pone en el mismo callback, antes de soltar la
     * espera, para que un corte que llegue en el medio la encuentre y lo apague.
     */
    private suspend fun habilitarVirtualStickEnElSuelo(): Boolean {
        if (desconectado || tomaDelDron != null) return false
        if (virtualStickListo.get()) return true
        val vs = VirtualStickManager.getInstance()
        val aceptado = withTimeoutOrNull(ESPERA_MANDO_VIRTUAL_MS) {
            suspendCancellableCoroutine<Boolean> { continuacion ->
                val respuesta = object : CommonCallbacks.CompletionCallback {
                    override fun onSuccess() {
                        virtualStickListo.set(true)
                        if (continuacion.isActive) continuacion.resume(true)
                        if (continuacion.isCancelled) apagarVirtualStick()
                    }

                    override fun onFailure(error: IDJIError) {
                        avisar(
                            "el dron no aceptó el mando virtual en el suelo (${describir(error)}): no despega. " +
                                "Revisá que el control esté en modo N",
                        )
                        if (continuacion.isActive) continuacion.resume(false)
                    }
                }
                runCatching { vs.enableVirtualStick(respuesta) }.onFailure { falla ->
                    avisar("no se pudo habilitar el mando virtual (${falla.message ?: falla.javaClass.simpleName}): no despega")
                    if (continuacion.isActive) continuacion.resume(false)
                }
            }
        }
        if (aceptado == null) {
            avisar("el dron no contestó la habilitación del mando virtual en ${ESPERA_MANDO_VIRTUAL_MS / 1000} s: no despega")
            mandarApagado("una habilitación en el suelo que no contestó")
        }
        if (aceptado != true) return false
        reintentoDelMandoVirtual.exito()
        vs.setVirtualStickAdvancedModeEnabled(true)
        // La app se cerró mientras el dron contestaba: se deshace (ver disconnect()).
        if (desconectado) {
            virtualStickListo.set(false)
            mandarApagado("la despedida")
            return false
        }
        return true
    }

    /**
     * Prepara el despegue de un relevo al aceptarlo: el Virtual Stick en el
     * suelo, esperando la respuesta (ver DroneController.prepararDespegue). Es
     * lo que descubre un control en S o C a tiempo de rechazar el relevo, y no
     * cuando A ya aterrizó.
     */
    override suspend fun prepararDespegue(): Boolean {
        if (enVuelo) return false
        val listo = _estado.value
        if (!listo.listoParaDespegar) {
            avisar("no se puede preparar el despegue: ${listo.detalle}")
            return false
        }
        return habilitarVirtualStickEnElSuelo()
    }

    /**
     * El relevo preparado no sigue: las palancas vuelven a mandar. Un despegue
     * que ya está en curso no se toca acá (lo abortan land, hold y returnHome).
     */
    override fun soltarDespegue() {
        if (enVuelo) return
        synchronized(relevoDeLazo) {
            if (despegue != Despegue.NINGUNO || navigationJob?.isActive == true) return
        }
        apagarVirtualStick()
    }

    /**
     * Aborta un despegue que todavía no dejó el suelo (RELEVOS §0: "ante la
     * duda en el suelo, el dron no despega"). Sin esto, land() y hold() volvían
     * sin hacer nada mientras el dron no estaba en vuelo, y el lazo del despegue
     * —hasta 5 s de Virtual Stick, 8 de motores y 25 de despegue— seguía y el
     * dron despegaba igual: un relay_cancel o un "Cancelar" en ese rato no
     * servía de nada.
     *
     *  - Si la orden de despegar todavía no salió (PREPARANDO), cortar el lazo
     *    alcanza: no despega, y se avisa como terminó ([comoTermina]).
     *  - Si ya salió (ORDENADO), el dron puede despegar igual: apenas está en
     *    el aire se lo aterriza ahí, y el evento sale al tocar el suelo. Si en
     *    el tope del despegue no subió, no despegó: se avisa igual.
     *
     * Sin un despegue pendiente no hace nada.
     */
    private fun cancelarDespegueEnElSuelo(comoTermina: Aterrizaje) {
        val fase = synchronized(relevoDeLazo) {
            val fase = despegue
            if (fase != Despegue.PREPARANDO && fase != Despegue.ORDENADO) return
            cortarLazo()
            fase
        }
        Log.i(TAG, "Despegue cancelado con el dron en el suelo ($fase)")
        apagarVirtualStick()
        if (fase == Despegue.ORDENADO) {
            // Ya es un aterrizaje de la app: lo que llegue mientras sube no lo corta.
            synchronized(relevoDeLazo) {
                marcarElAterrizaje(comoTermina)
                relevarLazo(Lazo.ATERRIZAJE_DEL_DESPEGUE) { aterrizarApenasDespegue(comoTermina) }
            }
        } else {
            avisarQueEstaEnElSuelo(comoTermina)
        }
    }

    /**
     * El despegue cancelado ya había salido: si el dron sube, baja ahí mismo,
     * con la misma secuencia que cualquier aterrizaje de la app.
     */
    private suspend fun aterrizarApenasDespegue(comoTermina: Aterrizaje) {
        val subio = withTimeoutOrNull(ESPERA_DESPEGUE_MS) {
            while (!enVuelo) delay(INTERVALO_DESPEGUE_MS)
        } != null
        if (!subio) {
            soltarEsteAterrizaje()
            avisarQueEstaEnElSuelo(comoTermina)
            return
        }
        sostenerElAterrizaje(anterior = null, conCorrimiento = false)
    }

    /** Un despegue cancelado que no dejó el suelo termina como la orden que lo canceló. */
    private fun avisarQueEstaEnElSuelo(comoTermina: Aterrizaje) {
        flightEvents.tryEmit(if (comoTermina == Aterrizaje.EN_BASE) FlightEvent.ArrivedHome else FlightEvent.Aterrizado)
    }

    /**
     * Sube o baja en vertical hasta [alturaM] y queda ahí (ver
     * DroneController.cambiarAltura). Si está en curso un lazo que relee la
     * altura pedida —el vuelo hacia un punto, el giro, el despegue de un relevo
     * o otro cambio de altura— no se corta: la próxima vuelta ya va hacia la
     * nueva. Si no, estacionario en el plano subiendo o bajando.
     */
    override fun cambiarAltura(alturaM: Double) {
        if (!alturaM.isFinite()) return
        if (rechazarEnElSuelo("cambiar de altura")) return
        if (rechazarAterrizando("cambiar de altura")) return
        if (rechazarSiElDronTieneElControl("cambiar de altura")) return
        synchronized(relevoDeLazo) {
            alturaPedida = alturaDeVuelo(alturaM)
            if (lazoActual in LAZOS_CON_ALTURA_PEDIDA && navigationJob?.isActive == true) return
            relevarLazo(Lazo.ALTURA) {
                asegurarVirtualStick()
                sostenerAlturaPedida()
            }
        }
    }

    /** Estacionario en el plano y en la altura pedida, sosteniendo el Virtual Stick, hasta la orden que sigue. */
    private suspend fun sostenerAlturaPedida(): Nothing {
        while (true) {
            quietoEnElPlano(alturaPedida)
            delay(INTERVALO_MANDO_MS)
        }
    }

    /**
     * Una vuelta de "quieto en el plano": velocidad horizontal cero y, con una
     * altura, subiendo o bajando hacia ella; sin altura, quieto también en
     * vertical (lo de hold()).
     */
    private fun quietoEnElPlano(altura: Double?) {
        if (altura == null) {
            enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
        } else {
            enviarVelocidadTerreno(0.0, 0.0, lastHeading, Navegacion.vertical(lastAlt, altura))
        }
    }

    /**
     * Vuela hacia el punto A LA ALTURA PEDIDA ([cambiarAltura], [despegarHasta])
     * o, sin una, a la que tiene al darla, y queda estacionario al llegar
     * (sosteniendo esa altura), avisando [FlightEvent.GotoArrived] una vez por
     * destino. Como el seguimiento, el lazo relee el destino y la altura en cada
     * vuelta: llamarla de nuevo en camino solo corrige el destino, y cambiar la
     * altura no lo frena (ver [DestinoActualizable]). Durante el despegue se
     * rechaza: B sube por su columna y recién arriba va a algún lado.
     */
    override fun volarHacia(lat: Double, lon: Double) {
        if (rechazarEnElSuelo("volar hacia un punto")) return
        if (rechazarAterrizando("volar hacia un punto")) return
        if (despegue != Despegue.NINGUNO) {
            avisar("el dron todavía está despegando: sube por su columna y recién arriba puede volar hacia un punto")
            return
        }
        if (rechazarSiElDronTieneElControl("volar hacia un punto")) return
        if (!Geo.esPosicionValida(lat, lon)) return
        synchronized(relevoDeLazo) {
            val enCurso = destinoDeVuelo
            if (enCurso != null && lazoActual == Lazo.VUELO && navigationJob?.isActive == true) {
                enCurso.cambiar(lat, lon)
                return
            }
            val destino = DestinoActualizable(lat, lon)
            destinoDeVuelo = destino
            val altura = alturaPedida ?: lastAlt
            alturaPedida = altura
            relevarLazo(Lazo.VUELO) {
                asegurarVirtualStick()
                while (true) {
                    delay(INTERVALO_MANDO_MS)
                    val (aquiLat, aquiLon) = posicion() ?: run {
                        enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                        null
                    } ?: continue
                    when (val paso = destino.siguiente(aquiLat, aquiLon)) {
                        is DestinoActualizable.Paso.Volar -> enviarVelocidadTerreno(
                            paso.paso.vNorteMs,
                            paso.paso.vEsteMs,
                            paso.paso.rumboGrados,
                            Navegacion.vertical(lastAlt, alturaPedida ?: altura),
                        )
                        DestinoActualizable.Paso.Llego -> {
                            quietoEnElPlano(alturaPedida ?: altura)
                            flightEvents.tryEmit(FlightEvent.GotoArrived)
                        }
                        DestinoActualizable.Paso.Quieto -> quietoEnElPlano(alturaPedida ?: altura)
                    }
                }
            }
        }
    }

    /**
     * Gira en el lugar hasta [rumboGrados] (la panorámica de RELEVOS §5): velocidad
     * cero en el plano y el rumbo en modo ÁNGULO, marco del terreno, así el dron
     * gira sobre sí mismo sin moverse y se queda ahí sosteniendo la altura
     * pedida (o la que tenía, si no hay una). Necesita el Virtual Stick: sin él
     * el giro no sale y quien llama lo ve en [Telemetry.heading].
     */
    override fun girarEnElLugar(rumboGrados: Double) {
        if (!rumboGrados.isFinite()) return
        if (rechazarEnElSuelo("girar en el lugar")) return
        if (rechazarAterrizando("girar en el lugar")) return
        if (rechazarSiElDronTieneElControl("girar en el lugar")) return
        synchronized(relevoDeLazo) {
            val altura = alturaPedida ?: lastAlt
            alturaPedida = altura
            relevarLazo(Lazo.GIRO) {
                asegurarVirtualStick()
                while (true) {
                    enviarVelocidadTerreno(0.0, 0.0, rumboGrados, Navegacion.vertical(lastAlt, alturaPedida ?: altura))
                    delay(INTERVALO_MANDO_MS)
                }
            }
        }
    }

    /**
     * Corta el regreso a base en curso (RELEVOS §4): KeyStopGoHome y esperar
     * que KeyGoHomeStatus vuelva a IDLE, con tope de [ESPERA_CORTE_REGRESO_MS].
     * La app retoma el mando EN EL ACTO —lo que ordene enseguida (subir, ir a
     * otra base) no puede rebotar contra la toma que está cortando— y, si el
     * dron no corta, se lo devuelve (ver [devolverElVuelo]).
     *
     * Un regreso que arrancó el propio DJI se corta una sola vez por vuelo; el
     * que pidió el botón del control y el aterrizaje forzado, nunca (ver
     * [SeguidorDelRegreso.corte]). Todo lo que no corta se avisa SIEMPRE con
     * [DroneController.NO_SE_CORTO_EL_REGRESO] adelante: es la respuesta a una
     * orden puntual, y quien la dio no puede seguir con el desvío.
     */
    override fun cancelarRegreso() {
        if (!enVuelo || !seguidorDelRegreso.volviendo) return
        val negativa = when {
            tomaDelDron == MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA -> "el dron está aterrizando por batería crítica"
            tomaDelDron == MotivoDelDron.RTH_DEL_CONTROL -> LO_PIDIO_EL_CONTROL
            else -> when (seguidorDelRegreso.corte()) {
                SeguidorDelRegreso.Corte.SE_PUEDE -> null
                SeguidorDelRegreso.Corte.YA_SE_CORTO ->
                    "el propio dron volvió a arrancar su regreso: se lo deja seguir (se corta una sola vez)"
                SeguidorDelRegreso.Corte.LO_PIDIO_EL_CONTROL -> LO_PIDIO_EL_CONTROL
            }
        }
        if (negativa != null) {
            avisarSiempre("${DroneController.NO_SE_CORTO_EL_REGRESO}: $negativa")
            return
        }
        seguidorDelRegreso.alCortar()
        val tomaAnterior = tomaDelDron
        val aterrizajeAnterior = aterrizajeEsperado
        tomaDelDron = null
        aterrizajeEsperado = Aterrizaje.NINGUNO
        scope.launch {
            val aceptado = accionCon(FlightControllerKey.KeyStopGoHome, EmptyMsg(), alFallar = { motivo ->
                avisarSiempre("${DroneController.NO_SE_CORTO_EL_REGRESO}: el dron no aceptó la orden ($motivo); sigue volviendo")
            })
            if (!aceptado) {
                devolverElVuelo(tomaAnterior, aterrizajeAnterior)
                return@launch
            }
            val cortado = withTimeoutOrNull(ESPERA_CORTE_REGRESO_MS) {
                estadoDelRegreso.first { it == GoHomeState.IDLE }
            }
            if (cortado == null) {
                avisarSiempre(
                    "${DroneController.NO_SE_CORTO_EL_REGRESO}: el dron no lo cortó en " +
                        "${ESPERA_CORTE_REGRESO_MS / 1000} s; sigue volviendo",
                )
                devolverElVuelo(tomaAnterior, aterrizajeAnterior)
            }
        }
    }

    /**
     * El corte del regreso no salió y el dron sigue volviendo: todo vuelve a
     * como estaba antes del corte. Lo que la app ordenó desde entonces (subir,
     * ir a otra base) se corta, porque el Virtual Stick contra un regreso
     * activo es pelearle el vuelo al DJI; si el vuelo era del DJI vuelve a
     * serlo; y si el regreso era el de la app, se lo vuelve a esperar como tal,
     * así su descenso se avisa ([FlightEvent.DescendiendoEnBase] y no una toma
     * falsa), el aterrizaje se confirma y al tocar el suelo sale
     * [FlightEvent.ArrivedHome].
     */
    private fun devolverElVuelo(toma: MotivoDelDron?, aterrizaje: Aterrizaje) {
        cortarLazo()
        apagarVirtualStick()
        if (aterrizajeEsperado == Aterrizaje.NINGUNO) aterrizajeEsperado = aterrizaje
        if (toma != null) tomaDelDron = TomaDelDron.bloqueoTrasLaToma(tomaDelDron, toma)
    }

    /**
     * Fija el punto de retorno donde está el dron (al llegar a la base de un
     * desvío, antes de aterrizar: RELEVOS §4). El MSDK 5.18 tiene dos acciones
     * para esto —KeySetHomeLocationUsingAircraftCurrentLocation y
     * KeyHomeLocationUsingCurrentAircraftLocation, las dos sin parámetro— y
     * además KeyHomeLocation se puede escribir; cuál acepta el Mini 4 Pro en
     * vuelo se ve en el banco (RELEVOS §8), así que se prueban en ese orden y
     * vale la primera que el dron acepte. Si ninguna, se avisa: el desvío sigue
     * igual, pero un regreso posterior volvería a la base de antes.
     */
    override fun fijarPuntoDeRetornoAqui() {
        scope.launch {
            val fijado = intentar(FlightControllerKey.KeySetHomeLocationUsingAircraftCurrentLocation) ||
                intentar(FlightControllerKey.KeyHomeLocationUsingCurrentAircraftLocation) ||
                escribirCasaDondeEsta()
            if (fijado) {
                Log.i(TAG, "Punto de retorno fijado donde está el dron")
            } else {
                avisar("el dron no aceptó fijar el punto de retorno donde está: un regreso posterior volvería a la base anterior")
            }
        }
    }

    /**
     * Intenta fijar el punto de retorno en ([lat], [lon]), lejos del dron: el
     * punto de visitantes de la base de un desvío (RELEVOS §4), escribiendo
     * KeyHomeLocation. El MSDK limita lo lejos que puede quedar, así que el
     * rechazo es lo esperado (RELEVOS §8 lo mide en el banco): va al log, no al
     * Comando Central, y al llegar [fijarPuntoDeRetornoAqui] lo fija de verdad.
     */
    override fun fijarPuntoDeRetornoEn(lat: Double, lon: Double) {
        if (!Geo.esPosicionValida(lat, lon)) return
        scope.launch {
            val fijado = fijar(
                FlightControllerKey.KeyHomeLocation,
                LocationCoordinate2D(lat, lon),
                alFallar = { motivo -> Log.i(TAG, "KeyHomeLocation en la base del desvío, rechazado como se esperaba: $motivo") },
            )
            if (fijado) Log.i(TAG, "Punto de retorno fijado en la base del desvío")
        }
    }

    /** Una acción sin parámetro cuyo rechazo es esperable: va al log, no al Comando Central. */
    private suspend fun intentar(llave: DJIActionKeyInfo<EmptyMsg, EmptyMsg>): Boolean =
        accionCon(llave, EmptyMsg(), alFallar = { motivo -> Log.i(TAG, "${llave.identifier}: $motivo") })

    /** La tercera vía de [fijarPuntoDeRetornoAqui]: escribir KeyHomeLocation con la posición actual. */
    private suspend fun escribirCasaDondeEsta(): Boolean {
        val (lat, lon) = posicion() ?: return false
        return fijar(
            FlightControllerKey.KeyHomeLocation,
            LocationCoordinate2D(lat, lon),
            alFallar = { motivo -> Log.i(TAG, "KeyHomeLocation: $motivo") },
        )
    }

    /**
     * Prende o apaga el regreso inteligente por batería del DJI: con false, la
     * cuenta regresiva se contesta con KeyLowBatteryRTHConfirm(false) mientras
     * dure (ver [VigiaDelRthPorBateria]); apagarlo con la cuenta en curso
     * contesta en el acto.
     */
    override fun permitirRthPropioPorBateria(permitir: Boolean) {
        if (vigiaDelRth.alPermitir(permitir)) negarElRthPorBateria()
    }

    /**
     * Failsafe de enlace en aterrizar (true) o el que tenía antes (false), con
     * KeyFailsafeAction. El original se guarda una sola vez (ver
     * [RecuerdoDelFailsafe]). Los pedidos salen en el orden en que llegan: la
     * corrutina arranca en el hilo que llama y toma su turno en
     * [filaDelFailsafe] antes de soltarlo, y el Mutex atiende por orden de
     * llegada.
     *
     * Lo que la app pidió queda además en [fueraDeBase] en el acto (de eso
     * depende cómo se contesta la protección de aterrizaje), y el original se
     * olvida recién cuando el dron aceptó que se lo devuelvan: si no, queda
     * pendiente para la próxima vez que esté en el suelo ([alQuedarEnElSuelo]).
     */
    override fun fijarFailsafeAterrizar(activo: Boolean) {
        fueraDeBase = activo
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            filaDelFailsafe.withLock {
                if (activo) {
                    val llave = KeyTools.createKey(FlightControllerKey.KeyFailsafeAction)
                    val actual = runCatching { KeyManager.getInstance().getValue(llave) }.getOrNull()
                        ?.takeUnless { it == FailsafeAction.UNKNOWN }
                    fijar(
                        FlightControllerKey.KeyFailsafeAction,
                        recuerdoDelFailsafe.alActivar(actual),
                        alFallar = { motivo -> avisar("el dron no aceptó aterrizar donde está si se corta el enlace ($motivo)") },
                    )
                } else {
                    val restaurar = recuerdoDelFailsafe.porRestaurar() ?: return@withLock
                    val devuelto = fijar(
                        FlightControllerKey.KeyFailsafeAction,
                        restaurar,
                        alFallar = { motivo ->
                            avisar(
                                "el dron no aceptó volver a su failsafe de antes, $restaurar ($motivo): " +
                                    "se reintenta la próxima vez que esté en el suelo",
                            )
                        },
                    )
                    if (devuelto) recuerdoDelFailsafe.alRestaurar()
                }
            }
        }
    }

    /**
     * El dron está en el suelo —recién aterrizado, o así lo encontró al
     * conectar—: el desvío o la emergencia terminaron, y lo que la app le
     * cambió para eso vuelve solo (RELEVOS §4: fuera de un desvío, el respaldo
     * del DJI tiene que estar). El regreso inteligente vuelve a estar permitido
     * y el failsafe del operador se le devuelve, también el que dejó pendiente
     * un controlador anterior (la pantalla se cerró en pleno desvío). Sin esto,
     * un solo `permitir(true)` o `fijarFailsafeAterrizar(false)` que no llegara
     * a mandarse dejaba al aparato así en los vuelos siguientes, también en los
     * de DJI Fly.
     */
    private fun alQuedarEnElSuelo() {
        vigiaDelRth.alTocarElSuelo()
        confirmacionDelAterrizaje.reiniciar()
        if (fueraDeBase || recuerdoDelFailsafe.activo) fijarFailsafeAterrizar(false)
    }

    /**
     * El failsafe del operador, de vuelta al cerrar con el dron en el suelo.
     * Directo al SDK y sin esperar: [disconnect] corta las corrutinas enseguida
     * y corre en el hilo principal. Si no sale, queda guardado en el teléfono.
     */
    private fun restaurarFailsafeAlDespedirse() {
        val restaurar = recuerdoDelFailsafe.porRestaurar() ?: return
        runCatching {
            KeyManager.getInstance().setValue(
                KeyTools.createKey(FlightControllerKey.KeyFailsafeAction),
                restaurar,
                object : CommonCallbacks.CompletionCallback {
                    override fun onSuccess() = recuerdoDelFailsafe.alRestaurar()

                    override fun onFailure(error: IDJIError) {
                        Log.w(TAG, "No se devolvió el failsafe $restaurar al cerrar (${describir(error)}): queda guardado")
                    }
                },
            )
        }.onFailure { falla -> Log.w(TAG, "No se devolvió el failsafe $restaurar al cerrar: queda guardado", falla) }
    }

    /** Lo que importa para contestar la protección de aterrizaje, leído ahora. */
    private fun situacionDelAterrizaje() = ConfirmacionDelAterrizaje.Situacion(
        ordenadoPorLaApp = aterrizajeEsperado != Aterrizaje.NINGUNO,
        fueraDeBase = fueraDeBase,
        forzadoPorBateria = tomaDelDron == MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA,
        bateriaPct = lastBattery,
        umbralCriticoPct = umbralCriticoPct,
    )

    /**
     * Lo que decidió [confirmacionDelAterrizaje] con el oyente del SDK, hecho.
     * Es el camino SIN un aterrizaje de la app en curso (el regreso a base que
     * baja en la base, el forzado por batería crítica); con uno, contesta su
     * secuencia ([contestarLaConfirmacion]).
     */
    private fun atenderElAterrizaje(que: ConfirmacionDelAterrizaje.Accion) {
        when (que) {
            ConfirmacionDelAterrizaje.Accion.NADA -> Unit
            ConfirmacionDelAterrizaje.Accion.CONFIRMAR -> scope.launch {
                if (!mandarLaConfirmacion()) avisar("el dron no aceptó la confirmación del aterrizaje")
            }
            // Correrse y volver a aterrizar es la secuencia de siempre, con el corrimiento primero.
            ConfirmacionDelAterrizaje.Accion.CORRERSE -> iniciarElAterrizaje(aterrizajeEsperado, conCorrimiento = true)
            ConfirmacionDelAterrizaje.Accion.ESPERAR -> avisar(ESPERA_DEL_CRITICO)
        }
    }

    // ---- El aterrizaje de la app: se sostiene hasta el suelo ----

    /**
     * Arranca la secuencia de un aterrizaje de la app ([sostenerElAterrizaje])
     * como el lazo vigente. Marcar el aterrizaje y relevar el lazo son un solo
     * paso con [relevoDeLazo]: desde acá ningún otro lazo puede arrancar (ver
     * [relevarLazo]) y la secuencia espera a que el anterior termine de verdad
     * antes de deshabilitar el Virtual Stick.
     */
    private fun iniciarElAterrizaje(comoTermina: Aterrizaje, conCorrimiento: Boolean = false) {
        synchronized(relevoDeLazo) {
            val anterior = navigationJob
            Log.i(
                TAG,
                "Aterrizaje pedido ($comoTermina${if (conCorrimiento) ", corriéndose primero" else ""}): " +
                    "corta el lazo $lazoActual con el Virtual Stick ${if (virtualStickListo.get()) "habilitado" else "deshabilitado"}",
            )
            marcarElAterrizaje(comoTermina)
            relevarLazo(Lazo.ATERRIZAJE) { sostenerElAterrizaje(anterior, conCorrimiento) }
        }
    }

    /** Con [relevoDeLazo] tomado: desde acá el aterrizaje es de la app (ver [aterrizando]). */
    private fun marcarElAterrizaje(comoTermina: Aterrizaje) {
        aterrizando = true
        descartadasAterrizando.clear()
        aterrizajeEsperado = comoTermina
    }

    /**
     * La secuencia del aterrizaje, en este orden:
     *  1. que el lazo anterior termine de verdad: cancelarlo no lo frena en
     *     el acto, y una vuelta que ya estaba adentro de `enviarVelocidad*`
     *     volvía a habilitar el Virtual Stick DESPUÉS de deshabilitarlo;
     *  2. el Virtual Stick deshabilitado, esperando la respuesta del SDK: con
     *     él tomado, el DJI no aterriza solo;
     *  3. si correspondía, el corrimiento (RELEVOS §4), y el pedido de confirmar
     *     que ya estaba en pie se contesta antes de ordenar nada;
     *  4. `KeyStartAutoLanding` con tope, y la vigilancia cada medio segundo
     *     hasta el suelo, con las reglas de [SupervisorDelAterrizaje]: el
     *     pedido de confirmar se lee y se contesta (y se repite mientras siga),
     *     y si el dron no entra en modo aterrizaje o no baja, la orden se
     *     vuelve a mandar.
     *
     * Termina en el suelo (el aviso lo da [alAterrizar]) o, si no se pudo,
     * soltando el aterrizaje con un aviso que sale siempre. Todo queda en el
     * logcat para el banco (`adb logcat -s DjiDroneController PatrolManager`).
     */
    private suspend fun sostenerElAterrizaje(anterior: Job?, conCorrimiento: Boolean) {
        val desde = System.currentTimeMillis()
        esperarElFinDe(anterior)
        apagarVirtualStickYEsperar("el aterrizaje")
        val supervisor = SupervisorDelAterrizaje()
        if (conCorrimiento) correrseParaAterrizar()
        var accion = if (contestarLaConfirmacion(leerElAterrizaje(), supervisor)) {
            correrseYEmpezar(supervisor)
        } else {
            supervisor.empezar()
        }
        while (accion == SupervisorDelAterrizaje.Accion.ORDENAR || accion == SupervisorDelAterrizaje.Accion.SEGUIR) {
            accion = if (accion == SupervisorDelAterrizaje.Accion.ORDENAR) {
                ordenarElAterrizaje(supervisor)
            } else {
                vigilarElAterrizaje(supervisor)
            }
        }
        terminarLaSecuencia(accion, supervisor, desde)
    }

    /** El paso 1 de [sostenerElAterrizaje], con tope: el lazo anterior ya está cancelado. */
    private suspend fun esperarElFinDe(anterior: Job?) {
        if (anterior == null) return
        val desde = System.currentTimeMillis()
        val termino = withTimeoutOrNull(ESPERA_FIN_DEL_LAZO_MS) { anterior.join() } != null
        Log.i(TAG, "Aterrizaje: el lazo anterior ${if (termino) "terminó" else "NO terminó"} en ${System.currentTimeMillis() - desde} ms")
    }

    /** `KeyStartAutoLanding` con tope; lo que contesta lo decide [SupervisorDelAterrizaje.alContestar]. */
    private suspend fun ordenarElAterrizaje(supervisor: SupervisorDelAterrizaje): SupervisorDelAterrizaje.Accion {
        if (supervisor.ordenes > 0) delay(SupervisorDelAterrizaje.ENTRE_ORDENES_MS)
        Log.i(TAG, "Aterrizaje: KeyStartAutoLanding, orden ${supervisor.ordenes + 1} de ${SupervisorDelAterrizaje.MAXIMO_DE_ORDENES}")
        val desde = System.currentTimeMillis()
        var motivo: String? = null
        val aceptada = withTimeoutOrNull(SupervisorDelAterrizaje.ESPERA_DE_LA_ORDEN_MS) {
            accionCon(FlightControllerKey.KeyStartAutoLanding, EmptyMsg(), alFallar = { motivo = it })
        }
        Log.i(TAG, "Aterrizaje: KeyStartAutoLanding ${resultado(aceptada, motivo)} en ${System.currentTimeMillis() - desde} ms")
        val yaAceptado = supervisor.aceptado
        val accion = supervisor.alContestar(aceptada, leerElAterrizaje(), motivo)
        if (!yaAceptado && supervisor.aceptado) avisarQueAceptoElAterrizaje()
        return accion
    }

    /** Una vuelta de la vigilancia: la confirmación primero, después si de verdad baja. */
    private suspend fun vigilarElAterrizaje(supervisor: SupervisorDelAterrizaje): SupervisorDelAterrizaje.Accion {
        delay(SupervisorDelAterrizaje.INTERVALO_MS)
        // Una habilitación que llegó tarde (de antes de la orden) no puede
        // quedar prendida: con ella el DJI deja de aterrizar.
        if (virtualStickListo.get()) apagarVirtualStickYEsperar("el aterrizaje (seguía habilitado)")
        val lectura = leerElAterrizaje()
        if (contestarLaConfirmacion(lectura, supervisor)) return correrseYEmpezar(supervisor)
        val accion = supervisor.alLeer(lectura)
        if (accion != SupervisorDelAterrizaje.Accion.SEGUIR) Log.i(TAG, "Aterrizaje: $accion")
        return accion
    }

    /**
     * El pedido de confirmar, LEÍDO (ver [ConfirmacionDelAterrizaje.alLeer]):
     * true si hay que correrse antes de seguir. Una confirmación que el dron no
     * toma se repite; a la quinta, la consola se entera.
     */
    private suspend fun contestarLaConfirmacion(
        lectura: SupervisorDelAterrizaje.Lectura,
        supervisor: SupervisorDelAterrizaje,
    ): Boolean {
        val que = confirmacionDelAterrizaje.alLeer(lectura.pideConfirmar, situacionDelAterrizaje())
        if (que != ConfirmacionDelAterrizaje.Accion.NADA) {
            Log.i(TAG, "Aterrizaje: KeyIsLandingConfirmationNeeded=${lectura.pideConfirmar}, se decide $que")
        }
        when (que) {
            ConfirmacionDelAterrizaje.Accion.CONFIRMAR -> {
                mandarLaConfirmacion()
                if (supervisor.alConfirmar()) {
                    avisar(
                        "el dron sigue pidiendo confirmar el aterrizaje después de ${supervisor.confirmaciones} " +
                            "confirmaciones: la app sigue confirmando (revisá el lugar en el video)",
                    )
                }
            }
            ConfirmacionDelAterrizaje.Accion.ESPERAR -> avisar(ESPERA_DEL_CRITICO)
            ConfirmacionDelAterrizaje.Accion.CORRERSE -> return true
            ConfirmacionDelAterrizaje.Accion.NADA -> Unit
        }
        return false
    }

    /** `KeyConfirmLanding` con tope, y su resultado en el logcat. */
    private suspend fun mandarLaConfirmacion(): Boolean {
        val desde = System.currentTimeMillis()
        var motivo: String? = null
        val aceptada = withTimeoutOrNull(SupervisorDelAterrizaje.ESPERA_DE_LA_ORDEN_MS) {
            accionCon(FlightControllerKey.KeyConfirmLanding, EmptyMsg(), alFallar = { motivo = it })
        }
        Log.i(TAG, "Aterrizaje: KeyConfirmLanding ${resultado(aceptada, motivo)} en ${System.currentTimeMillis() - desde} ms")
        return aceptada == true
    }

    private suspend fun correrseYEmpezar(supervisor: SupervisorDelAterrizaje): SupervisorDelAterrizaje.Accion {
        correrseParaAterrizar()
        return supervisor.empezar()
    }

    /**
     * El dron pidió confirmar un aterrizaje que no se confirma solo (RELEVOS
     * §4): deja de bajar, se corre [ConfirmacionDelAterrizaje.CORRIMIENTO_M]
     * hacia adelante y la secuencia lo vuelve a aterrizar, con sus órdenes de
     * nuevo. Es lo único que habilita el Virtual Stick con un aterrizaje en
     * curso. Una orden nueva lo corta como a cualquier lazo, y el corrimiento
     * igual se da por terminado.
     */
    private suspend fun correrseParaAterrizar() {
        Log.i(TAG, "Aterrizaje: se corre ${ConfirmacionDelAterrizaje.CORRIMIENTO_M.toInt()} m antes de volver a intentarlo")
        withTimeoutOrNull(SupervisorDelAterrizaje.ESPERA_DE_LA_ORDEN_MS) {
            accionCon(FlightControllerKey.KeyStopAutoLanding, EmptyMsg(), alFallar = { motivo ->
                Log.i(TAG, "KeyStopAutoLanding antes de correrse: $motivo")
            })
        }
        corriendoseParaAterrizar = true
        try {
            asegurarVirtualStick()
            correrse()
        } finally {
            corriendoseParaAterrizar = false
            confirmacionDelAterrizaje.alTerminarDeCorrerse()
        }
        apagarVirtualStickYEsperar("volver a aterrizar después de correrse")
    }

    /**
     * Lo que se lee del dron en cada vuelta: el pedido de confirmar
     * preguntándoselo ([leerDelDron]), el modo de vuelo y la altura. Cada
     * lectura queda en el logcat: es lo que el banco tiene que ver.
     */
    private suspend fun leerElAterrizaje(): SupervisorDelAterrizaje.Lectura {
        val pide = leerDelDron(FlightControllerKey.KeyIsLandingConfirmationNeeded) == true
        val km = KeyManager.getInstance()
        val modo = runCatching { km.getValue(KeyTools.createKey(FlightControllerKey.KeyFlightMode)) }.getOrNull()
        val enModo = runCatching { km.getValue(KeyTools.createKey(FlightControllerKey.KeyIsInLandingMode)) }.getOrNull()
        val alt = lastAlt
        Log.i(
            TAG,
            "Aterrizaje: modo=$modo ($modoDeVuelo) enModoDeAterrizaje=$enModo pideConfirmar=$pide " +
                "alt=${String.format(Locale.ROOT, "%.1f", alt)} m enVuelo=$enVuelo enlace=$enlaceVivo",
        )
        return SupervisorDelAterrizaje.Lectura(
            enVuelo = enVuelo,
            conEnlace = enlaceVivo,
            bajando = SupervisorDelAterrizaje.estaBajando(modo?.name, enModo),
            pideConfirmar = pide,
            alturaM = alt,
        )
    }

    /**
     * El valor de [llave] preguntándoselo al dron, con tope, y no el último que
     * el SDK avisó por cambio; si no contesta, el que el SDK tiene guardado.
     */
    private suspend fun <T> leerDelDron(llave: DJIKeyInfo<T>): T? {
        val km = KeyManager.getInstance()
        val key = KeyTools.createKey(llave)
        val leido = withTimeoutOrNull(ESPERA_LECTURA_MS) {
            suspendCancellableCoroutine<T?> { continuacion ->
                val respuesta = object : CommonCallbacks.CompletionCallbackWithParam<T> {
                    override fun onSuccess(valor: T?) {
                        if (continuacion.isActive) continuacion.resume(valor)
                    }

                    override fun onFailure(error: IDJIError) {
                        if (continuacion.isActive) continuacion.resume(null)
                    }
                }
                runCatching { km.getValue(key, respuesta) }.onFailure { if (continuacion.isActive) continuacion.resume(null) }
            }
        }
        return leido ?: runCatching { km.getValue(key) }.getOrNull()
    }

    /**
     * El dron aceptó el aterrizaje: [FlightEvent.AterrizajeAceptado], solo si
     * esta secuencia sigue siendo la vigente. Mirar y avisar van con
     * [relevoDeLazo]: un aterrizaje que una persona acaba de cortar no puede
     * anunciarse como aceptado después del corte.
     */
    private suspend fun avisarQueAceptoElAterrizaje() {
        val yo = currentCoroutineContext()[Job]
        synchronized(relevoDeLazo) {
            if (yo === navigationJob && aterrizando) flightEvents.tryEmit(FlightEvent.AterrizajeAceptado)
        }
    }

    /** La secuencia terminó: en el suelo, o soltando el aterrizaje con su aviso. */
    private suspend fun terminarLaSecuencia(
        accion: SupervisorDelAterrizaje.Accion,
        supervisor: SupervisorDelAterrizaje,
        desde: Long,
    ) {
        val segundos = (System.currentTimeMillis() - desde) / 1_000
        if (accion == SupervisorDelAterrizaje.Accion.EN_EL_SUELO) {
            Log.i(TAG, "Aterrizaje: en el suelo a los $segundos s")
            return
        }
        val motivo = if (accion == SupervisorDelAterrizaje.Accion.LO_SUBIERON) {
            supervisor.motivoDeLaSubida()
        } else {
            supervisor.motivoDelFallo()
        }
        Log.w(TAG, "Aterrizaje: se suelta a los $segundos s ($accion): $motivo")
        // Una respuesta definitiva a una orden de una persona: sale siempre.
        if (soltarEsteAterrizaje()) avisarSiempre("${DroneController.NO_SE_PUDO_ATERRIZAR}: $motivo")
    }

    /**
     * Suelta el aterrizaje de ESTA secuencia (o de este despegue cancelado), si
     * todavía es la vigente; false si otra orden ya la había reemplazado.
     */
    private suspend fun soltarEsteAterrizaje(): Boolean {
        val yo = currentCoroutineContext()[Job]
        synchronized(relevoDeLazo) {
            if (yo !== navigationJob) return false
            aterrizando = false
            aterrizajeEsperado = Aterrizaje.NINGUNO
            lazoActual = Lazo.NINGUNO
        }
        return true
    }

    /**
     * Con [relevoDeLazo] tomado: otra orden de vuelo de una persona corta el
     * aterrizaje en curso. true si el dron estaba aterrizando en el aire, y
     * entonces quien llama le dice al DJI que deje de aterrizar
     * ([detenerElAterrizajeAutomatico]) fuera del lock, antes de su orden.
     */
    private fun soltarElAterrizaje(porQue: String): Boolean {
        if (!aterrizando) return false
        aterrizando = false
        Log.i(TAG, "Aterrizaje cortado: $porQue")
        return enVuelo
    }

    /**
     * `KeyStopAutoLanding` en el acto, sin esperar la respuesta: así sale por el
     * SDK antes que la orden que la sigue (el regreso, la ruta). El resultado
     * queda en el logcat.
     */
    private fun detenerElAterrizajeAutomatico() {
        val desde = System.currentTimeMillis()
        runCatching {
            KeyManager.getInstance().performAction(
                KeyTools.createKey(FlightControllerKey.KeyStopAutoLanding),
                EmptyMsg(),
                object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                    override fun onSuccess(resultado: EmptyMsg?) {
                        Log.i(TAG, "KeyStopAutoLanding aceptada en ${System.currentTimeMillis() - desde} ms")
                    }

                    override fun onFailure(error: IDJIError) {
                        Log.i(TAG, "KeyStopAutoLanding rechazada en ${System.currentTimeMillis() - desde} ms: ${describir(error)}")
                    }
                },
            )
        }.onFailure { falla -> Log.w(TAG, "KeyStopAutoLanding no salió", falla) }
    }

    /**
     * Aterrizando, lo que solo deja quieto al dron no hace nada: el vuelo
     * estacionario (tomar o soltar el control, la señal perdida) y el mando
     * manual (el cero de soltar la palanca, el watchdog). Queda en el logcat una
     * vez por orden y por aterrizaje.
     */
    private fun descartarAterrizando(que: String): Boolean {
        if (!aterrizando) return false
        if (descartadasAterrizando.add(que)) Log.i(TAG, "Aterrizando: se descarta $que (no corta el aterrizaje)")
        return true
    }

    /** Aterrizando, una orden de navegación no sale: el aterrizaje lo corta una persona con otra orden de vuelo. */
    private fun rechazarAterrizando(que: String): Boolean {
        if (!aterrizando) return false
        avisar("el dron está aterrizando: no se puede $que (lo corta solo otra orden de vuelo de una persona)")
        return true
    }

    /** Lo que contestó una orden al SDK, para el logcat. */
    private fun resultado(aceptada: Boolean?, motivo: String?): String = when (aceptada) {
        true -> "aceptada"
        false -> "rechazada (${motivo ?: "sin motivo del SDK"})"
        null -> "sin respuesta"
    }

    /** Los metros del corrimiento, hacia la nariz, sin bajar de [ALTURA_MINIMA_CORRIMIENTO_M]; con tope de tiempo. */
    private suspend fun correrse() {
        val (lat, lon) = posicion() ?: return
        val (destinoLat, destinoLon) = ConfirmacionDelAterrizaje.puntoCorrido(lat, lon, lastHeading) ?: return
        val altura = maxOf(lastAlt, ALTURA_MINIMA_CORRIMIENTO_M)
        val limite = System.currentTimeMillis() + ESPERA_CORRIMIENTO_MS
        while (System.currentTimeMillis() < limite) {
            delay(INTERVALO_MANDO_MS)
            val (aquiLat, aquiLon) = posicion() ?: run {
                enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                null
            } ?: continue
            val paso = Navegacion.hacia(aquiLat, aquiLon, destinoLat, destinoLon)
            if (paso.llego) return
            enviarVelocidadTerreno(paso.vNorteMs, paso.vEsteMs, paso.rumboGrados, Navegacion.vertical(lastAlt, altura))
        }
    }

    /**
     * El primer cuadro para la detección (1280 px) CAPTURADO después de pedir la
     * foto, o null si no llega en [DroneController.ESPERA_FOTO_MS]. Se mira la
     * hora de captura y no la de salida: la conversión a JPEG tarda, y un cuadro
     * que estaba convirtiéndose al pedir la foto es de antes, con la cámara
     * apuntando a otro lado.
     */
    override suspend fun capturarFoto(): ByteArray? {
        val desde = System.currentTimeMillis()
        return withTimeoutOrNull(DroneController.ESPERA_FOTO_MS) {
            cuadrosFechados.first { it.capturadoMs >= desde }.jpeg
        }
    }

    /** Llegó KeyLowBatteryRTHInfo: la autonomía, la cuenta regresiva y si el DJI arrancó su regreso. */
    private fun alLeerElRthPorBateria(info: LowBatteryRTHInfo) {
        lecturaDeAutonomia = info
        val decision = vigiaDelRth.alCambiarEstado(info.lowBatteryRTHStatus?.name)
        if (decision.contestarQueNo) negarElRthPorBateria()
        if (decision.arrancoElRegreso && enVuelo) alTomarElControl(MotivoDelDron.RTH_BATERIA)
    }

    /** KeyLowBatteryRTHConfirm(false): el DJI no arranca el regreso que estaba contando. */
    private fun negarElRthPorBateria() {
        scope.launch {
            val contestado = accionCon(
                FlightControllerKey.KeyLowBatteryRTHConfirm,
                false,
                alFallar = { motivo -> avisar("el dron no aceptó que no vuelva solo por batería ($motivo)") },
            )
            if (contestado) {
                Log.i(TAG, "Se le negó al dron su regreso propio por batería")
            } else {
                vigiaDelRth.alFallarLaRespuesta()
            }
        }
    }

    /** Llegó KeyGoHomeStatus: el descenso en la base o un regreso que nadie pidió. */
    private fun alCambiarElRegreso(estado: GoHomeState) {
        estadoDelRegreso.value = estado
        val enlaceRecienRecuperado = !enlaceVivo || System.currentTimeMillis() - enlaceVolvioMs < ENLACE_RECIEN_RECUPERADO_MS
        val motivo = TomaDelDron.motivoProbable(vigiaDelRth.estado, enlaceRecienRecuperado)
        when (val aviso = seguidorDelRegreso.alCambiarFase(TomaDelDron.faseDelRegreso(estado.name), ordenActual(), motivo)) {
            null -> Unit
            is FlightEvent.ElDronTomoElControl -> {
                if (TomaDelDron.bloqueaLaApp(aviso.motivo)) bloquearPorLaToma(aviso.motivo)
                avisarToma(aviso)
            }
            else -> flightEvents.tryEmit(aviso)
        }
    }

    /**
     * El DJI avisó que se quedó con el vuelo (un cambio de autoridad, el
     * arranque de su regreso por batería, la batería crítica). El bloqueo va
     * aunque el aviso ya hubiera salido por otro camino: el primero pudo traer
     * un motivo que no bloquea.
     */
    private fun alTomarElControl(motivo: MotivoDelDron) {
        if (TomaDelDron.bloqueaLaApp(motivo)) bloquearPorLaToma(motivo)
        seguidorDelRegreso.alTomarElControl(motivo)?.let(::avisarToma)
    }

    /**
     * La app deja de comandar: corta el lazo y no vuelve a habilitar el Virtual
     * Stick hasta el suelo. Queda la toma que más pesa: un regreso por batería
     * que el DJI anuncia durante el que pidió el control no lo vuelve cortable.
     */
    private fun bloquearPorLaToma(motivo: MotivoDelDron) {
        tomaDelDron = TomaDelDron.bloqueoTrasLaToma(tomaDelDron, motivo)
        cortarLazo()
        apagarVirtualStick()
    }

    private fun avisarToma(aviso: FlightEvent.ElDronTomoElControl) {
        Log.w(TAG, "El propio dron tomó el control: ${aviso.motivo.descripcion}")
        flightEvents.tryEmit(aviso)
    }

    /** Lo que la app tiene pedido, en los términos de [SeguidorDelRegreso]. */
    private fun ordenActual(): SeguidorDelRegreso.Orden = when (aterrizajeEsperado) {
        Aterrizaje.EN_BASE -> SeguidorDelRegreso.Orden.REGRESO
        Aterrizaje.AQUI -> SeguidorDelRegreso.Orden.ATERRIZAJE
        Aterrizaje.NINGUNO -> SeguidorDelRegreso.Orden.NINGUNA
    }

    /** Revisa los umbrales de batería del DJI (ver [UmbralesDelDji]); mal puestos, se avisa. */
    private fun revisarUmbrales() {
        UmbralesDelDji.problema(umbralCriticoPct, umbralAvisoPct, PatrolManager.LOW_BATTERY_PCT)?.let(::avisar)
    }

    /** Con el vuelo tomado por el propio DJI, las órdenes de vuelo se rechazan avisando (una vez). */
    private fun rechazarSiElDronTieneElControl(que: String): Boolean {
        val motivo = tomaDelDron ?: return false
        avisar("el propio dron tomó el control (${motivo.descripcion}): no se puede $que hasta que aterrice")
        return true
    }

    /**
     * Las órdenes que no despegan se rechazan con el dron en el suelo, avisando
     * por transición (ver [avisar]): solo "Comenzar patrullaje" despega.
     */
    private fun rechazarEnElSuelo(que: String): Boolean {
        if (enVuelo) return false
        avisar("el dron está en el suelo: no se puede $que hasta despegar (arrancá un patrullaje)")
        return true
    }

    /** Altura de vuelo válida para una orden: la del waypoint, dentro de los límites. */
    private fun alturaDeVuelo(altM: Double): Double = altM.coerceIn(ALTURA_MINIMA_M, ALTURA_MAXIMA_M)

    /**
     * Despegue automático del SDK y espera a que el dron esté en el aire. Falla
     * —avisando— si el dron no está en condiciones, si rechaza la orden o si en
     * [ESPERA_DESPEGUE_MS] no llegó a despegar.
     */
    private suspend fun despegar(): Boolean {
        val listo = _estado.value
        if (!listo.listoParaDespegar) {
            avisar("no se puede despegar: ${listo.detalle}")
            return false
        }
        if (!ordenarDespegue()) return false
        return esperarDespegue()
    }

    /**
     * El despegue de este lazo pasa a ORDENADO justo antes de mandar
     * KeyStartTakeoff: desde ahí, cortar el lazo ya no alcanza para que no
     * despegue (ver [cancelarDespegueEnElSuelo]). Mirar si el lazo sigue siendo
     * el vigente y marcarlo es un solo paso con [relevoDeLazo]: un corte que
     * llegó antes encuentra PREPARANDO y la orden no sale; uno que llega después
     * encuentra ORDENADO y lo aterriza.
     *
     * @return false si a este lazo ya lo cortaron: la orden no tiene que salir.
     */
    private suspend fun despegueOrdenado(): Boolean {
        val lazo = currentCoroutineContext()[Job]
        return synchronized(relevoDeLazo) {
            val vigente = lazo != null && lazo === navigationJob && lazo.isActive
            if (vigente) despegue = Despegue.ORDENADO
            vigente
        }
    }

    /** El despegue de este lazo terminó (en el aire o fallido): ya no hay nada que abortar en el suelo. */
    private suspend fun despegueTerminado() {
        val lazo = currentCoroutineContext()[Job]
        synchronized(relevoDeLazo) {
            if (lazo === navigationJob) despegue = Despegue.NINGUNO
        }
    }

    /**
     * La orden de despegar, con lo que el campo enseñó:
     *  - Es un pedido explícito del operador: si el dron la rechaza se avisa
     *    SIEMPRE, aunque sea el mismo rechazo que la vez anterior. Con el aviso
     *    por transición (ver [avisar]) el segundo "Despegar" que fallaba igual
     *    quedaba mudo, y el operador apretaba sin saber por qué no pasaba nada.
     *  - Recién aterrizado, los motores siguen girando unos segundos y el dron
     *    rechaza el despegue: se espera a que se apaguen.
     *  - El SDK suele rechazar con la descripción en null: el motivo se arma con
     *    el código del error y con lo que el controlador de vuelo dice de por qué
     *    no arrancan los motores (KeyTakeoffFailureError / KeyMotorStartFailureError).
     */
    private suspend fun ordenarDespegue(): Boolean {
        seResolvioElProblema()
        esperarMotoresApagados()
        if (!despegueOrdenado()) return false
        return accion(FlightControllerKey.KeyStartTakeoff, "despegar") { motivoDelDronParaNoDespegar() }
    }

    /** Recién aterrizado: hasta [ESPERA_MOTORES_MS] a que los motores se apaguen. */
    private suspend fun esperarMotoresApagados() {
        val limite = System.currentTimeMillis() + ESPERA_MOTORES_MS
        val llave = KeyTools.createKey(FlightControllerKey.KeyAreMotorsOn)
        while (System.currentTimeMillis() < limite) {
            if (KeyManager.getInstance().getValue(llave) != true) return
            delay(200)
        }
    }

    /** Lo que el controlador de vuelo informa sobre por qué no despega (vacío si no informa nada). */
    private fun motivoDelDronParaNoDespegar(): String {
        val km = KeyManager.getInstance()
        val motivos = listOf(
            "despegue" to km.getValue(KeyTools.createKey(FlightControllerKey.KeyTakeoffFailureError)),
            "motores" to km.getValue(KeyTools.createKey(FlightControllerKey.KeyMotorStartFailureError)),
        ).mapNotNull { (que, valor) ->
            valor?.toString()?.takeUnless { it.isBlank() || it == "NONE" || it == "UNKNOWN" }?.let { "$que: $it" }
        }
        val avisos = listOfNotNull(
            "la IMU se está calentando".takeIf { km.getValue(KeyTools.createKey(FlightControllerKey.KeyIsIMUWarmingUp)) == true },
            "error de brújula".takeIf { km.getValue(KeyTools.createKey(FlightControllerKey.KeyCompassHasError)) == true },
            "el dron no permite arrancar los motores".takeIf {
                km.getValue(KeyTools.createKey(FlightControllerKey.KeyNotAllowMotorStart)) == true
            },
        )
        return (motivos + avisos).joinToString(", ")
    }

    /** Espera a que el despegue automático deje al dron en el aire, con tope. */
    private suspend fun esperarDespegue(): Boolean {
        val limite = System.currentTimeMillis() + ESPERA_DESPEGUE_MS
        while (!enVuelo || lastAlt < ALTURA_DESPEGUE_SDK_M) {
            if (System.currentTimeMillis() > limite) {
                avisar("el dron no despegó en ${ESPERA_DESPEGUE_MS / 1000} s: revisá el control (modo N) y la aeronave")
                return false
            }
            delay(INTERVALO_DESPEGUE_MS)
        }
        seResolvioElProblema()
        return true
    }

    /**
     * Sube (o baja) derecho hasta la altura que diga [alturaM], sosteniendo la
     * posición y el rumbo. La relee en cada vuelta: un [cambiarAltura] durante
     * el despegue de un relevo cambia hasta dónde sube.
     */
    private suspend fun subirA(alturaM: () -> Double): Boolean {
        val limite = System.currentTimeMillis() + ESPERA_SUBIDA_MS
        while (!Navegacion.aLaAltura(lastAlt, alturaM())) {
            if (System.currentTimeMillis() > limite) {
                avisar("el dron no llegó a los ${alturaM().toInt()} m de altura de trabajo (está en ${lastAlt.toInt()} m)")
                return false
            }
            enviarVelocidadTerreno(0.0, 0.0, lastHeading, Navegacion.vertical(lastAlt, alturaM()))
            delay(INTERVALO_MANDO_MS)
        }
        return true
    }

    /**
     * Ejecuta una acción del controlador de vuelo (despegar, aterrizar, volver a
     * base) y espera su resultado. Un rechazo se avisa con el motivo del SDK y,
     * si se da, con lo que agregue [masDetalle] (leído en el momento del rechazo).
     */
    private suspend fun accion(
        llave: DJIActionKeyInfo<EmptyMsg, EmptyMsg>,
        que: String,
        masDetalle: () -> String = { "" },
    ): Boolean =
        accionCon(llave, EmptyMsg(), alFallar = { motivo ->
            val extra = runCatching(masDetalle).getOrDefault("").takeIf { it.isNotBlank() }
            avisar("el dron no aceptó $que ($motivo${extra?.let { "; $it" } ?: ""})")
        })

    /**
     * Una acción del SDK con su parámetro, esperando el resultado. [alFallar]
     * recibe el motivo de un rechazo —o de una excepción del SDK, que acá no
     * puede escaparse: en una corrutina de este scope se llevaría puesta la app
     * en pleno vuelo— y decide qué hacer con él.
     */
    private suspend fun <P> accionCon(
        llave: DJIActionKeyInfo<P, EmptyMsg>,
        parametro: P,
        alFallar: (String) -> Unit,
    ): Boolean =
        suspendCancellableCoroutine { continuacion ->
            val respuesta = object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(resultado: EmptyMsg?) {
                    if (continuacion.isActive) continuacion.resume(true)
                }

                override fun onFailure(error: IDJIError) {
                    alFallar(describir(error))
                    if (continuacion.isActive) continuacion.resume(false)
                }
            }
            runCatching { KeyManager.getInstance().performAction(KeyTools.createKey(llave), parametro, respuesta) }
                .onFailure { falla ->
                    alFallar(falla.message ?: falla.javaClass.simpleName)
                    if (continuacion.isActive) continuacion.resume(false)
                }
        }

    /** Escribe una llave del SDK esperando el resultado; como [accionCon], nunca tira. */
    private suspend fun <T> fijar(llave: DJIKeyInfo<T>, valor: T, alFallar: (String) -> Unit): Boolean =
        suspendCancellableCoroutine { continuacion ->
            val respuesta = object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    if (continuacion.isActive) continuacion.resume(true)
                }

                override fun onFailure(error: IDJIError) {
                    alFallar(describir(error))
                    if (continuacion.isActive) continuacion.resume(false)
                }
            }
            runCatching { KeyManager.getInstance().setValue(KeyTools.createKey(llave), valor, respuesta) }
                .onFailure { falla ->
                    alFallar(falla.message ?: falla.javaClass.simpleName)
                    if (continuacion.isActive) continuacion.resume(false)
                }
        }

    /**
     * Releva el lazo de comandos: mata el que estaba y publica el nuevo, todo
     * bajo [relevoDeLazo]. Todos los modos pasan por acá —ruta, goto, órbita,
     * estacionario y mando manual— porque el par cortar+asignar es justamente lo
     * que no puede entrelazarse entre hilos.
     *
     * Con un aterrizaje de la app en curso solo lo releva otro aterrizaje: es
     * la red de seguridad de las órdenes que ya lo miran antes (ver
     * [aterrizando]), y el lugar donde una que se coló entre el "no aterriza" y
     * el relevo se encuentra con la puerta cerrada. false si no relevó.
     */
    private fun relevarLazo(tipo: Lazo, cuerpo: suspend CoroutineScope.() -> Unit): Boolean =
        synchronized(relevoDeLazo) {
            if (aterrizando && tipo !in LAZOS_DEL_ATERRIZAJE) {
                descartarAterrizando("el lazo $tipo")
                return false
            }
            navigationJob?.cancel()
            lazoActual = tipo
            // Una orden de vuelo nueva: la app ya no espera ningún aterrizaje. Si
            // quedara el de un regreso que esta orden reemplaza, un regreso que
            // después arranque el propio DJI parecería pedido por la app y nadie
            // se enteraría de la toma. Un aterrizaje nuevo trae el suyo.
            if (tipo !in LAZOS_DEL_ATERRIZAJE) aterrizajeEsperado = Aterrizaje.NINGUNO
            // El despegue que hubiera era del lazo anterior (quien despega lo
            // marca después de relevar), y la altura pedida solo la conservan
            // los lazos que la releen.
            despegue = Despegue.NINGUNO
            if (tipo !in LAZOS_CON_ALTURA_PEDIDA) alturaPedida = null
            navigationJob = scope.launch(block = cuerpo)
            true
        }

    /**
     * Corta el lazo en curso. Todos los que lo llaman terminan también un
     * aterrizaje de la app, si había: una orden de una persona (el regreso, el
     * corte del aterrizaje), el suelo, una toma del propio DJI o la despedida.
     */
    private fun cortarLazo() {
        synchronized(relevoDeLazo) {
            lazoActual = Lazo.NINGUNO
            despegue = Despegue.NINGUNO
            alturaPedida = null
            aterrizando = false
            navigationJob?.cancel()
            navigationJob = null
        }
    }

    /**
     * Como [avisar], pero sale aunque sea el mismo motivo que la vez anterior:
     * es la respuesta a una orden puntual (cortar el regreso), y quien la dio
     * tiene que enterarse de cada intento.
     */
    private fun avisarSiempre(motivo: String) {
        ultimoAviso.set(motivo)
        Log.w(TAG, motivo)
        flightEvents.tryEmit(FlightEvent.Problema(motivo))
    }

    /**
     * Deja constancia de un problema del dron. Va al log del dispositivo y, sobre
     * todo, al Comando Central por [flightEvents]: un rechazo mudo es lo peor que
     * puede pasar en vuelo —el operador mueve la palanca, el dron no se mueve y
     * no hay una sola pista de por qué—, y este archivo no tiene registro local
     * propio.
     *
     * Avisa por TRANSICIÓN: solo cuando el motivo cambia. Los llamadores están
     * adentro de lazos que corren a 10 Hz, así que el MISMO rechazo se repetía
     * diez veces por segundo, y cada `Problema` termina en una fila de la tabla
     * `events` del Comando Central más un broadcast a cada consola abierta.
     */
    private fun avisar(motivo: String) {
        // Comparar y recordar en un solo paso: si dos hilos traen el mismo motivo,
        // avisa uno.
        if (ultimoAviso.getAndSet(motivo) == motivo) return
        Log.w(TAG, motivo)
        flightEvents.tryEmit(FlightEvent.Problema(motivo))
    }

    /**
     * El problema se resolvió. Borra la memoria de [avisar] para que, si el mismo
     * motivo vuelve a aparecer más tarde, sea noticia otra vez en vez de quedar
     * tapado por el aviso viejo.
     */
    private fun seResolvioElProblema() {
        ultimoAviso.set(null)
    }

    /**
     * Habilita el Virtual Stick si hace falta. Es idempotente porque lo llaman
     * todos los caminos que comandan velocidades (ruta, goto, órbita,
     * estacionario y mando manual), y pedírselo de nuevo al SDK diez veces por
     * segundo sería pelearse con él.
     *
     * La habilitación es asíncrona: los primeros comandos pueden caer mientras
     * el dron todavía la está aceptando y se pierden, pero como se manda a 10 Hz
     * el siguiente llega enseguida.
     *
     * Si el dron la rechaza, el reintento NO sale en la vuelta siguiente: entra
     * por [reintentoDelMandoVirtual], que espera cada vez más. Un rechazo suele
     * ser una condición que dura —el control en modo S o C, un regreso a base en
     * curso— y preguntar diez veces por segundo no la cambia.
     */
    private fun asegurarVirtualStick() {
        // La app ya se despidió del dron: habilitarlo acá sería dejárselo
        // prendido al operador (ver disconnect()).
        if (desconectado) return
        // El propio DJI se quedó con el vuelo: volver a habilitarlo sería
        // pelearle el regreso o el aterrizaje (RELEVOS §4). Hasta el suelo.
        if (tomaDelDron != null) return
        // Aterrizando, tampoco: con el Virtual Stick tomado el DJI deja de
        // aterrizar. Es lo que frena a la vuelta del lazo que ya estaba adentro
        // de enviarVelocidad* cuando se lo cortó. Solo el corrimiento lo usa.
        if (aterrizando && !corriendoseParaAterrizar) return
        if (!reintentoDelMandoVirtual.sePuedeIntentar(System.currentTimeMillis())) return
        if (!virtualStickListo.compareAndSet(false, true)) return
        val vs = VirtualStickManager.getInstance()
        val lazo = lazoActual
        Log.i(TAG, "Virtual Stick: se habilita (lazo $lazo)")
        vs.enableVirtualStick(
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "Virtual Stick: habilitado (lo pidió el lazo $lazo)")
                    reintentoDelMandoVirtual.exito()
                    // El dron aceptó: si más adelante vuelve a rechazar, es un
                    // problema nuevo y tiene que volver a avisarse.
                    seResolvioElProblema()
                    // La app volvió a comandar: si el dron no está volviendo, la
                    // toma de antes (un estacionario, el failsafe de señal)
                    // terminó, y la próxima se avisa aunque sea por lo mismo.
                    seguidorDelRegreso.alRetomarElMando()
                    // El modo avanzado es el único que acepta velocidades y
                    // marco de coordenadas; sin esto sendVirtualStickAdvancedParam
                    // no tiene efecto.
                    vs.setVirtualStickAdvancedModeEnabled(true)
                    // Si la app se cerró mientras el dron todavía lo aceptaba,
                    // esta habilitación llegó tarde y hay que deshacerla (ver
                    // mandarApagado()). Lo mismo si en el medio arrancó un
                    // aterrizaje: le cancelaría el aterrizaje automático.
                    if (desconectado || (aterrizando && !corriendoseParaAterrizar)) {
                        virtualStickListo.set(false)
                        mandarApagado("una habilitación que llegó tarde")
                    }
                }

                override fun onFailure(error: IDJIError) {
                    Log.i(TAG, "Virtual Stick: el dron no lo habilitó (lazo $lazo): ${describir(error)}")
                    // Quedó sin habilitar: se libera la marca para que se pueda
                    // reintentar, en vez de comandar al vacío para siempre. El
                    // cuándo lo pone la espera creciente.
                    virtualStickListo.set(false)
                    reintentoDelMandoVirtual.fracaso(System.currentTimeMillis())
                    avisar(
                        "el dron no aceptó el mando virtual (${describir(error)}): " +
                            "revisá que el control esté en modo N. La app no lo va a poder mover",
                    )
                }
            },
        )
    }

    /**
     * Le devuelve el mando al palito físico del RC-N3, una sola vez: el
     * compareAndSet evita mandar un `disableVirtualStick` por cada lazo que
     * termina.
     */
    private fun apagarVirtualStick() {
        if (!virtualStickListo.compareAndSet(true, false)) return
        mandarApagado("el lazo $lazoActual")
    }

    /**
     * El apagado propiamente dicho, SIN pasar por la marca. Existe aparte porque
     * hay un camino donde la marca ya se consumió y el dron igual quedó con el
     * Virtual Stick habilitado: [disconnect] apaga mientras una habilitación
     * está en vuelo, y cuando la aeronave contesta ese `onSuccess` tardío el
     * Virtual Stick está prendido pero la marca ya dice false. [paraQue] es
     * quién lo pide, para el logcat.
     */
    private fun mandarApagado(paraQue: String) {
        Log.i(TAG, "Virtual Stick: se deshabilita por $paraQue")
        VirtualStickManager.getInstance().disableVirtualStick(
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "Virtual Stick: deshabilitado (lo pidió $paraQue)")
                }

                override fun onFailure(error: IDJIError) {
                    avisar(
                        "no se pudo devolver el mando al control (${describir(error)}): " +
                            "el Virtual Stick puede haber quedado habilitado",
                    )
                }
            },
        )
    }

    /**
     * Deshabilita el Virtual Stick ESPERANDO la respuesta del SDK, con tope: el
     * paso 2 de la secuencia del aterrizaje, que no puede mandar
     * `KeyStartAutoLanding` con el mando todavía tomado. Lo que pasó y cuánto
     * tardó queda en el logcat; si no se pudo, se avisa (la secuencia sigue: el
     * supervisor ve si el dron baja).
     */
    private suspend fun apagarVirtualStickYEsperar(paraQue: String) {
        if (!virtualStickListo.getAndSet(false)) {
            Log.i(TAG, "Virtual Stick: ya estaba deshabilitado para $paraQue")
            return
        }
        Log.i(TAG, "Virtual Stick: se deshabilita para $paraQue (lazo $lazoActual)")
        val desde = System.currentTimeMillis()
        var motivo: String? = null
        val apagado = withTimeoutOrNull(ESPERA_MANDO_VIRTUAL_MS) {
            suspendCancellableCoroutine<Boolean> { continuacion ->
                val respuesta = object : CommonCallbacks.CompletionCallback {
                    override fun onSuccess() {
                        if (continuacion.isActive) continuacion.resume(true)
                    }

                    override fun onFailure(error: IDJIError) {
                        motivo = describir(error)
                        if (continuacion.isActive) continuacion.resume(false)
                    }
                }
                runCatching { VirtualStickManager.getInstance().disableVirtualStick(respuesta) }.onFailure { falla ->
                    motivo = falla.message ?: falla.javaClass.simpleName
                    if (continuacion.isActive) continuacion.resume(false)
                }
            }
        }
        val como = resultado(apagado, motivo)
        Log.i(TAG, "Virtual Stick para $paraQue: deshabilitación $como en ${System.currentTimeMillis() - desde} ms")
        if (apagado != true) avisar("no se pudo devolver el mando al control para $paraQue ($como): el dron puede no aterrizar")
    }

    /**
     * Velocidades en el marco del terreno, con la nariz apuntando a
     * [rumboGrados]. Es lo que usan los modos autónomos: el objetivo está en
     * coordenadas, no relativo al dron. La traducción a pitch/roll —que en el
     * SDK están cruzados respecto de lo intuitivo— la hace [OrdenVirtualStick].
     */
    private fun enviarVelocidadTerreno(vNorteMs: Double, vEsteMs: Double, rumboGrados: Double, vSubidaMs: Double) {
        asegurarVirtualStick()
        val p = OrdenVirtualStick.terreno(vNorteMs, vEsteMs, rumboGrados, vSubidaMs)
        VirtualStickManager.getInstance().sendVirtualStickAdvancedParam(
            VirtualStickFlightControlParam(
                p.pitch,
                p.roll,
                p.yaw,
                p.verticalThrottle,
                VerticalControlMode.VELOCITY,
                RollPitchControlMode.VELOCITY,
                YawControlMode.ANGLE,
                FlightCoordinateSystem.GROUND,
            ),
        )
    }

    /**
     * Velocidades relativas al cuerpo del dron: lo que manda el mando virtual.
     * Con coordenadas BODY no hace falta rotar nada por el rumbo, de eso se
     * encarga el propio dron.
     */
    private fun enviarVelocidadCuerpo(v: MandoVirtual.VelocidadesCuerpo) {
        asegurarVirtualStick()
        val p = OrdenVirtualStick.cuerpo(v)
        VirtualStickManager.getInstance().sendVirtualStickAdvancedParam(
            VirtualStickFlightControlParam(
                p.pitch,
                p.roll,
                p.yaw,
                p.verticalThrottle,
                VerticalControlMode.VELOCITY,
                RollPitchControlMode.VELOCITY,
                YawControlMode.ANGULAR_VELOCITY,
                FlightCoordinateSystem.BODY,
            ),
        )
    }

    private companion object {
        /** El Virtual Stick se sostiene con comandos a 10 Hz. */
        const val INTERVALO_MANDO_MS = 100L

        /**
         * Ritmo de la telemetría: 5 por segundo. Más que los 2 que necesita la
         * web, porque PatrolManager guarda las últimas muestras para buscar la
         * pose del instante de cada cuadro analizado.
         */
        const val INTERVALO_TELEMETRIA_MS = 200L

        /** Órbita y seguimiento no bajan de esta altura (ver startOrbit). */
        const val ALTURA_MINIMA_SEGUIMIENTO_M = 15.0

        /** Hasta cuánto se extrapola la estimación del objetivo que se sigue. */
        const val EXTRAPOLACION_MAXIMA_MS = 3_000L

        /** El gimbal se reapunta solo si cambia más que esto, y como mucho una vez por segundo. */
        const val UMBRAL_GIMBAL_GRADOS = 3.0
        const val INTERVALO_GIMBAL_MS = 1_000L

        /** Lo que tarda el gimbal en llegar cuando lo apunta la app (ruta, órbita, seguimiento). */
        const val DURACION_GIMBAL_AUTONOMO_S = 1.0

        /**
         * Como mucho una orden al gimbal cada esto (ver [filaDelGimbal]): la
         * consola manda hasta diez por segundo mientras el operador arrastra, y
         * pasarlas todas era pelearse con el SDK. Las de la app ya salen más
         * espaciadas ([INTERVALO_GIMBAL_MS]): a ellas este espaciado no les
         * agrega espera.
         */
        const val ENTRE_ORDENES_GIMBAL_MS = 300L

        /**
         * Lo que tarda el gimbal en llegar cuando lo mueve el operador: lo mismo
         * que el espaciado entre órdenes. Si el SDK contesta al aceptar la orden,
         * la siguiente llega justo cuando la anterior terminó su recorrido; si
         * contesta al terminarla, no se pisan nunca. Con el segundo entero de los
         * modos autónomos la cámara quedaba visiblemente atrás del deslizador.
         */
        const val DURACION_GIMBAL_MANUAL_S = ENTRE_ORDENES_GIMBAL_MS / 1_000.0

        /**
         * Tope de espera a que el SDK conteste una orden al gimbal. Si no
         * contestó, se avisa y se pasa a la siguiente: un callback perdido no
         * puede dejar a la cámara sorda al resto de la sesión. Alcanza también
         * para las de la app, que tardan [DURACION_GIMBAL_AUTONOMO_S] en llegar.
         */
        const val ESPERA_GIMBAL_MS = 2_000L

        /** Rango de la inclinación pedida desde la consola (`manual_gimbal`, docs/PROTOCOLS.md §3.b). */
        const val INCLINACION_MINIMA = -90.0
        const val INCLINACION_MAXIMA = 30.0

        /** Si el yaw del gimbal se aleja más que esto de la nariz, no se le cree (ver rumboDeLaCamara). */
        const val MAXIMA_DIFERENCIA_GIMBAL_GRADOS = 30.0

        /** Por debajo de esto no se trabaja: es menos que la altura del despegue automático. */
        const val ALTURA_MINIMA_M = 3.0

        /** Techo del vuelo: 120 m es el límite legal (ANAC) y el del propio dron. */
        const val ALTURA_MAXIMA_M = 120.0

        /** El despegue automático del SDK deja al dron a 1,2 m; se da por despegado a partir de 1 m. */
        const val ALTURA_DESPEGUE_SDK_M = 1.0

        /** Recién aterrizado, cuánto se espera a que los motores se apaguen antes de volver a despegar. */
        const val ESPERA_MOTORES_MS = 8_000L

        /** Tope para que el dron despegue (motores + salto a 1,2 m). */
        const val ESPERA_DESPEGUE_MS = 25_000L

        /** Tope para la subida a la altura de trabajo: 120 m a 2,5 m/s más margen. */
        const val ESPERA_SUBIDA_MS = 90_000L

        /**
         * Espera del primer reintento de la habilitación del Virtual Stick y tope
         * al que llega duplicándose.
         */
        const val REINTENTO_MANDO_INICIAL_MS = 500L
        const val REINTENTO_MANDO_TOPE_MS = 5_000L

        /** Tope para que el dron conteste la habilitación del Virtual Stick en el suelo (despegue de un relevo). */
        const val ESPERA_MANDO_VIRTUAL_MS = 5_000L

        /** Tope para que KeyGoHomeStatus vuelva a IDLE después de KeyStopGoHome (RELEVOS §4). */
        const val ESPERA_CORTE_REGRESO_MS = 3_000L

        /** Cada cuánto se mira si el dron ya está en el aire durante un despegue. */
        const val INTERVALO_DESPEGUE_MS = 200L

        /** Tope del corrimiento antes de volver a aterrizar: 10 m se hacen en unos segundos. */
        const val ESPERA_CORRIMIENTO_MS = 10_000L

        /**
         * Tope para que termine el lazo que el aterrizaje cortó: una vuelta tarda
         * lo que una llamada al SDK, así que esto sobra; si no termina, se sigue
         * igual (la puerta de [asegurarVirtualStick] ya está cerrada).
         */
        const val ESPERA_FIN_DEL_LAZO_MS = 1_000L

        /** Tope para que el dron conteste una lectura durante el aterrizaje (se lee dos veces por segundo). */
        const val ESPERA_LECTURA_MS = 400L

        /** Lo que se avisa cuando el dron pide confirmar un aterrizaje que espera la batería crítica (RELEVOS §4). */
        const val ESPERA_DEL_CRITICO =
            "el dron pide confirmar un aterrizaje fuera de base: no se confirma hasta la batería crítica " +
                "(revisá el lugar en el video)"

        /** El corrimiento no va a ras del suelo: un cordón o un arbusto a medio metro se lo comen. */
        const val ALTURA_MINIMA_CORRIMIENTO_M = 2.0

        /** Por qué no se corta un regreso que pidió una persona con el control. */
        const val LO_PIDIO_EL_CONTROL = "lo pidió el botón de regreso del control y la app no se lo corta"

        /** Los lazos que releen [alturaPedida]: un [cambiarAltura] no los corta (ver DroneController.cambiarAltura). */
        val LAZOS_CON_ALTURA_PEDIDA = setOf(Lazo.DESPEGUE_A_ALTURA, Lazo.VUELO, Lazo.GIRO, Lazo.ALTURA)

        /** Los lazos de un aterrizaje de la app: los únicos que relevan con [aterrizando] prendido. */
        val LAZOS_DEL_ATERRIZAJE = setOf(Lazo.ATERRIZAJE, Lazo.ATERRIZAJE_DEL_DESPEGUE)

        /**
         * Un regreso propio que aparece hasta esto después de que volvió el
         * enlace arrancó con el enlace cortado: es el failsafe de señal.
         */
        const val ENLACE_RECIEN_RECUPERADO_MS = 30_000L

        const val TAG = "DjiDroneController"
    }
}
