package com.tesis.dronepatrol.dji

import android.util.Log
import com.tesis.dronepatrol.drone.AnclaDeRumbo
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
import com.tesis.dronepatrol.drone.SupervisorDelRegreso
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
import dji.sdk.keyvalue.value.flightcontroller.FlightMode
import dji.sdk.keyvalue.value.flightcontroller.GoHomeExitCode
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
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
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
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
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

    /**
     * Qué lazo es [navigationJob]. Se escribe con el mismo lock; es volátil
     * porque [asegurarVirtualStick] lo lee sin tomarlo, desde la vuelta de
     * cualquier lazo, para no habilitar el Virtual Stick con un regreso a base
     * de la app en curso.
     */
    @Volatile
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

        /**
         * El mando devuelto a las palancas del control ([devolverElMandoAlControl]):
         * espera el fin del lazo anterior, apaga el Virtual Stick y termina.
         */
        SUELTO,

        /**
         * La vigilancia de un objetivo desde donde está ([vigilar], la reacción
         * `detenerse` de docs/VUELO.md §5): velocidad cero, la nariz y la cámara
         * al objetivo, la altura sostenida.
         */
        VIGILIA,

        /**
         * La secuencia de un regreso a base de la app ([sostenerElRegreso],
         * docs/VUELO.md §7.2): espera el fin del lazo anterior, apaga el Virtual
         * Stick, manda `KeyStartGoHome` y comprueba que el regreso arranque.
         * Mientras es el lazo vigente nadie habilita el Virtual Stick (ver
         * [asegurarVirtualStick]).
         */
        REGRESO,
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

    /** Cuántas posiciones entregó el SDK, para que el logcat diga cada cuánto llegan (ver [lanzarRuta]). */
    private val posicionesRecibidas = AtomicInteger()

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

    /** Centro, radio y velocidad de la órbita en curso: el lazo los relee en cada vuelta (ver [startOrbit]). */
    private class Orbita(val lat: Double, val lon: Double, val radioM: Double, val velocidadMs: Double)

    @Volatile
    private var orbita: Orbita? = null

    /** Objetivo que se sigue y desde cuándo vale esa estimación (ver [seguirObjetivo]). */
    private class Seguido(val lat: Double, val lon: Double, val vNorteMs: Double, val vEsteMs: Double, val desdeMs: Long)

    @Volatile
    private var seguido: Seguido? = null

    /** Objetivo que se vigila desde donde está: el lazo lo relee en cada vuelta (ver [vigilar]). */
    private class Vigilado(val lat: Double, val lon: Double)

    @Volatile
    private var vigilado: Vigilado? = null

    /**
     * El `KeyStartGoHome` de la secuencia del regreso ya salió (o está
     * saliendo): desde ahí cortar el lazo no alcanza para que el dron no
     * vuelva, y [cancelarRegreso] tiene que parar el GoHome (ver
     * [marcarElRegresoOrdenado]), aunque la secuencia ya haya terminado; y una
     * orden de vuelo que lo reemplace, también ([relevarLazo]). Queda prendido
     * hasta que algo se hace cargo de ese GoHome: un corte, otra orden, el
     * suelo, o su final en el aire. Se escribe con [relevoDeLazo] tomado, junto
     * con el lazo al que pertenece.
     */
    @Volatile
    private var regresoOrdenado = false

    /**
     * El regreso de la app está en el aire y este controlador mira cómo termina
     * (ver [alDejarDeVolver]): salió su `KeyStartGoHome` (con
     * [regresoOrdenado]), se adoptó uno que ya estaba en curso, o volvió a serlo
     * porque su corte no salió ([devolverElVuelo]). Antes la vigilancia
     * terminaba al arrancar, y un GoHome que el DJI dejaba en el aire (OABT_STUCK,
     * VELOCITY_STUCK, GPS_NO_SIGNAL, las palancas del control) dejaba a la app
     * en RETURNING_HOME con el dron suspendido y sin un aviso. Mismo lock que
     * [regresoOrdenado]; volátil porque los oyentes del SDK lo leen sin él.
     */
    @Volatile
    private var regresoVigilado = false

    /**
     * El corte de un GoHome que está saliendo ([cortarElGoHome]): el de
     * [cancelarRegreso], o el que [relevarLazo] manda cuando una orden de vuelo
     * reemplaza a un regreso de la app. El lazo nuevo lo espera (con tope)
     * antes de habilitar el Virtual Stick, y la secuencia de un regreso nuevo
     * antes de adoptar o de ordenar nada: si no, adoptaría un regreso que está
     * por cortarse, o el corte le cortaría el que se acaba de pedir.
     */
    @Volatile
    private var corteDelRegreso: Job? = null

    /**
     * `KeyStartGoHome` y `KeyStopGoHome` no se cruzan en el camino al dron. La
     * secuencia lo toma desde que marca la orden ([marcarElRegresoOrdenado])
     * hasta que el dron la contesta —aunque a la secuencia la corten en el
     * medio—, y el corte lo toma antes de mandar el suyo. Sin esto el corte (que
     * sale de otra corrutina) podía llegarle al dron ANTES que la orden: lo
     * rechazaba porque todavía no había GoHome, y el GoHome arrancaba después,
     * con el control ya tomado.
     */
    private val ordenDelRegreso = Mutex()

    /**
     * El modo de vuelo según `KeyFlightMode`, el enumerado ([modoDeVuelo] es el
     * texto para el operador). Con `KeyGoHomeStatus` dice si el dron vuelve: el
     * GoHome se pone en GO_HOME antes de que su estado salga de IDLE.
     */
    private val modoDelSdk = AtomicReference<FlightMode?>(null)

    /** Altura sobre el punto de despegue (barómetro), en metros. */
    @Volatile
    private var lastAlt = 0.0

    @Volatile
    private var lastBattery = 0.0

    @Volatile
    private var lastHeading = 0.0

    /** La brújula ya informó: antes de eso [lastHeading] es un cero que no es el norte. */
    @Volatile
    private var brujulaInformada = false

    /** El rumbo al que se clava la nariz con la palanca de giro suelta (ver [enviarVelocidadCuerpo]). */
    private val anclaDeRumbo = AnclaDeRumbo()

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
        // traen el estado actual apenas se registran. Salvo el corte del regreso
        // propio, que es POR VUELO: con el dron en el aire (la pantalla se
        // recreó en pleno vuelo) el que ya se gastó sigue gastado. El SDK puede
        // saber que vuela antes de que el oyente de KeyIsFlying lo cuente.
        val enElAire = enVuelo ||
            runCatching { KeyManager.getInstance().getValue(KeyTools.createKey(FlightControllerKey.KeyIsFlying)) }.getOrNull() == true
        if (enElAire) Log.i(TAG, "Conexión con el dron en el aire: el corte del regreso propio de este vuelo se conserva")
        seguidorDelRegreso.alReconectar(enVuelo = enElAire)
        confirmacionDelAterrizaje.reiniciar()
        tomaDelDron = null
        vigiaDelRth.reiniciar()
        estadoDelRegreso.value = null
        modoDelSdk.set(null)
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
            posicionesRecibidas.incrementAndGet()
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
        // El mismo modo, como enumerado: con KeyGoHomeStatus dice si el dron
        // vuelve, y su salida de GO_HOME es el final de un regreso cuyo estado
        // no llegó a cambiar (ver alCambiarElModo).
        escuchar(FlightControllerKey.KeyFlightMode) { modo -> alCambiarElModo(modo) }
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
        escuchar(FlightControllerKey.KeyCompassHeading) { rumbo ->
            lastHeading = (rumbo + 360.0) % 360.0
            brujulaInformada = true
        }
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
            // Un nodo se alcanza entrando en su umbral o pasando al lado (el
            // retraso del dron y el GPS lo corren unos metros): sin esto el
            // Mini pasaba a 5 m del nodo y el lazo lo hacía dar la vuelta.
            val llegada = Navegacion.LlegadaAlNodo()
            // La velocidad en rampa, la nariz girando a su ritmo y el dron
            // volando hacia donde mira (ver Navegacion.Crucero): sin esto en
            // cada nodo la velocidad saltaba a 8 m/s hacia el siguiente con el
            // dron todavía andando hacia el anterior, y se pasaba y bandeaba.
            val crucero = Navegacion.Crucero()
            var anteriorNs = System.nanoTime()
            var posicionesAlSalir = posicionesRecibidas.get()
            var salidaMs = System.currentTimeMillis()
            Log.i(
                TAG,
                "Ruta de ${route.waypoints.size} nodos desde el ${target + 1}: crucero ${Navegacion.VELOCIDAD_CRUCERO_MS} m/s, " +
                    "aceleración ${Navegacion.ACELERACION_MS2} m/s², giro ${Navegacion.GIRO_CRUCERO_GRADOS_S}°/s",
            )
            while (true) {
                delay(INTERVALO_MANDO_MS) // Virtual Stick requiere comandos a ~10 Hz
                val ahoraNs = System.nanoTime()
                val dt = (ahoraNs - anteriorNs) / 1e9
                anteriorNs = ahoraNs
                // Sin posición válida (se perdió el fix) no se vuela hacia
                // ninguna coordenada: estacionario hasta que vuelva.
                val (lat, lon) = posicion() ?: run {
                    enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                    crucero.quieto()
                    null
                } ?: continue
                val wp = route.waypoints[target]
                val paso = crucero.paso(lat, lon, wp.lat, wp.lon, rumboDeLaBrujula(), dt)
                if (llegada.llego(paso.distanciaM)) {
                    // Para el banco de campo: a qué distancia y velocidad se dio
                    // por alcanzado, y cada cuánto llegó la posición del SDK.
                    val posiciones = posicionesRecibidas.get() - posicionesAlSalir
                    val ms = System.currentTimeMillis() - salidaMs
                    Log.i(
                        TAG,
                        "Nodo ${target + 1} alcanzado a ${"%.1f".format(paso.distanciaM)} m" +
                            (if (paso.llego) "" else " (pasado de largo)") +
                            " a ${"%.1f".format(crucero.velocidadMs)} m/s; el SDK dio $posiciones posiciones en $ms ms" +
                            (if (posiciones > 0) " (cada ${ms / posiciones} ms)" else ""),
                    )
                    flightEvents.tryEmit(FlightEvent.WaypointReached(target))
                    target = (target + 1) % route.waypoints.size
                    llegada.reiniciar()
                    posicionesAlSalir = posicionesRecibidas.get()
                    salidaMs = System.currentTimeMillis()
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

    /**
     * Le devuelve el mando a las palancas del RC-N3 (ver
     * DroneController.devolverElMandoAlControl). Va como un lazo más
     * ([Lazo.SUELTO]) y no como un apagado suelto, por lo mismo que la
     * secuencia del aterrizaje: el lazo que comandaba hay que esperarlo
     * —cancelarlo no lo frena en el acto, y una vuelta que ya estaba adentro de
     * `enviarVelocidad*` volvía a habilitar el Virtual Stick DESPUÉS de
     * apagarlo—, y si mientras tanto llega otra orden (alguien vuelve a tomar
     * el control desde la consola), esa orden releva a este lazo y el apagado
     * ya no sale.
     */
    override fun devolverElMandoAlControl() {
        // En el suelo es quedarse donde está: un despegue pendiente no sale.
        if (!enVuelo) return hold()
        // El propio DJI tiene el vuelo (su regreso, su aterrizaje): el Virtual
        // Stick ya está apagado y no hay nada que soltar.
        if (tomaDelDron != null) return
        synchronized(relevoDeLazo) {
            // Aterrizando, el Virtual Stick ya está apagado y el dron sigue bajando.
            if (descartarAterrizando("devolver el mando al control")) return
            val anterior = navigationJob
            Log.i(TAG, "Mando devuelto al control físico: corta el lazo $lazoActual")
            relevarLazo(Lazo.SUELTO) { soltarElMando(anterior) }
        }
    }

    /** El cuerpo de [Lazo.SUELTO]: sin velocidades, el DJI frena solo y obedece al control. */
    private suspend fun soltarElMando(anterior: Job?) {
        esperarElFinDe(anterior, "Mando devuelto al control")
        apagarVirtualStickYEsperar("devolver el mando al control", siNoSePudo = "el control físico puede no responder")
    }

    override fun gotoPoint(lat: Double, lon: Double) {
        if (rechazarEnElSuelo("ir a un punto")) return
        if (rechazarAterrizando("ir a un punto")) return
        if (rechazarSiElDronTieneElControl("ir a un punto")) return
        relevarLazo(Lazo.GOTO) {
            asegurarVirtualStick()
            val altura = lastAlt
            // Como en la ruta: llegar es entrar en el umbral o pasar al lado, y
            // se va en rampa, girando la nariz a su ritmo y mirando hacia donde se va.
            val llegada = Navegacion.LlegadaAlNodo()
            val crucero = Navegacion.Crucero()
            var anteriorNs = System.nanoTime()
            while (true) {
                delay(INTERVALO_MANDO_MS)
                val ahoraNs = System.nanoTime()
                val dt = (ahoraNs - anteriorNs) / 1e9
                anteriorNs = ahoraNs
                val (aquiLat, aquiLon) = posicion() ?: run {
                    enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                    crucero.quieto()
                    null
                } ?: continue
                val paso = crucero.paso(aquiLat, aquiLon, lat, lon, rumboDeLaBrujula(), dt)
                if (llegada.llego(paso.distanciaM)) {
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

    override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double, velocidadMs: Double) {
        if (rechazarEnElSuelo("orbitar")) return
        if (rechazarAterrizando("orbitar")) return
        if (rechazarSiElDronTieneElControl("orbitar")) return
        // El lazo relee el centro (y la velocidad) en cada vuelta: si ya está
        // orbitando, correr el centro o cambiar la velocidad es solo esto, sin
        // cortar el giro (el objetivo estimado se corrige con cada detección y
        // la órbita lo acompaña sin saltos).
        orbita = Orbita(centerLat, centerLon, radiusM, Navegacion.velocidadDeOrbita(velocidadMs))
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
                    val paso = Navegacion.orbitar(lat, lon, o.lat, o.lon, o.radioM, o.velocidadMs)
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
     * Vigila al objetivo desde donde está: la reacción `detenerse` de
     * docs/VUELO.md §5 (ver DroneController.vigilar). Un lazo propio
     * ([Lazo.VIGILIA]) con velocidad cero en el plano, la nariz al objetivo
     * (rumbo en modo ÁNGULO, marco del terreno, como en [girarEnElLugar]), la
     * altura que tenía al detenerse —sin bajar de [ALTURA_MINIMA_SEGUIMIENTO_M],
     * por lo mismo que la órbita— y el gimbal bajado lo justo para tenerlo en el
     * centro del cuadro. Como la órbita y el seguimiento, el lazo relee el
     * objetivo en cada vuelta: con cada estimación nueva solo se corre el punto
     * al que mira, sin cortar el estacionario.
     *
     * Encima del objetivo (a menos de [DISTANCIA_MINIMA_PARA_EL_RUMBO_M]) el
     * rumbo hacia él es ruido del GPS: la nariz se queda donde está y la cámara
     * va al nadir, en vez de girar sobre sí mismo persiguiendo cada lectura.
     */
    override fun vigilar(lat: Double, lon: Double) {
        if (rechazarEnElSuelo("vigilar al objetivo")) return
        if (rechazarAterrizando("vigilar al objetivo")) return
        if (rechazarSiElDronTieneElControl("vigilar al objetivo")) return
        if (!Geo.esPosicionValida(lat, lon)) return
        vigilado = Vigilado(lat, lon)
        synchronized(relevoDeLazo) {
            if (lazoActual == Lazo.VIGILIA && navigationJob?.isActive == true) return
            relevarLazo(Lazo.VIGILIA) {
                asegurarVirtualStick()
                val altura = maxOf(lastAlt, ALTURA_MINIMA_SEGUIMIENTO_M)
                val gimbal = GimbalQueAcompania()
                // Hasta tener posición, o encima del objetivo, la nariz se queda donde está.
                var rumbo = lastHeading
                Log.i(TAG, "Vigilancia: estacionario a ${altura.toInt()} m con la nariz y la cámara al objetivo")
                while (true) {
                    delay(INTERVALO_MANDO_MS)
                    val o = vigilado ?: continue
                    val (aquiLat, aquiLon) = posicion() ?: run {
                        enviarVelocidadCuerpo(MandoVirtual.NEUTRO)
                        null
                    } ?: continue
                    val distancia = Geo.distanciaM(aquiLat, aquiLon, o.lat, o.lon)
                    if (distancia >= DISTANCIA_MINIMA_PARA_EL_RUMBO_M) {
                        rumbo = (Geo.rumboHacia(aquiLat, aquiLon, o.lat, o.lon) + 360.0) % 360.0
                    }
                    enviarVelocidadTerreno(0.0, 0.0, rumbo, Navegacion.vertical(lastAlt, altura))
                    // El gimbal baja lo justo para tener al objetivo en el medio del cuadro.
                    gimbal.apuntar(Georreferencia.inclinacionParaOrbitar(lastAlt, distancia))
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

    /**
     * Vuelve a la base como una secuencia propia ([Lazo.REGRESO],
     * [sostenerElRegreso]), igual que el aterrizaje desde el PR #30 y por lo
     * mismo (docs/VUELO.md §7.2). Antes se cortaba el lazo, se apagaba el
     * Virtual Stick sin esperar y se mandaba `KeyStartGoHome` sin mirar qué
     * pasaba: en el campo una vuelta de la órbita que ya estaba adentro de
     * `enviarVelocidad*` volvía a habilitar el Virtual Stick DESPUÉS del
     * apagado, el GoHome quedaba pisado o rechazado, y la app decía que volvía
     * mientras el dron seguía orbitando. Ahora el lazo anterior se espera, el
     * apagado se espera, la secuencia comprueba que el regreso arranque y, si
     * no, avisa SIEMPRE ([DroneController.NO_SE_PUDO_VOLVER]).
     *
     * «Ya vuelve» es [dronVolviendo] (el estado del regreso O el modo GO_HOME),
     * el mismo criterio que la secuencia: con el estado solo, un GoHome que ya
     * estaba en GO_HOME con el estado todavía en IDLE se volvía a pedir.
     */
    override fun returnHome() {
        if (!enVuelo) {
            // Un despegue pendiente no sale: el dron ya está en su base.
            cancelarDespegueEnElSuelo(Aterrizaje.EN_BASE)
            return
        }
        // El propio DJI está aterrizando donde está por batería crítica: no hay
        // regreso que ordenar, y es una respuesta definitiva.
        if (tomaDelDron == MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA) {
            avisarSiempre("${DroneController.NO_SE_PUDO_VOLVER}: el propio dron está aterrizando por batería crítica")
            return
        }
        val corteDelAterrizaje = synchronized(relevoDeLazo) {
            // Ya vuelve porque la app lo pidió, o la secuencia que lo pide está
            // en curso: pedirlo otra vez no es otro regreso.
            val secuenciaEnCurso = lazoActual == Lazo.REGRESO && navigationJob?.isActive == true
            val volviendo = dronVolviendo()
            if (aterrizajeEsperado == Aterrizaje.EN_BASE && (volviendo || secuenciaEnCurso)) {
                Log.i(TAG, "Regreso pedido de nuevo: ${if (secuenciaEnCurso) "la secuencia ya está en curso" else "el dron ya vuelve"}, no se repite")
                return
            }
            // Volver a la base es otra orden de vuelo: corta un aterrizaje en
            // curso, y al DJI se le dice que deje de aterrizar ANTES de pedirle
            // el regreso: el KeyStopAutoLanding sale apenas se suelta el lock, y
            // la secuencia espera su respuesta antes de mirar si el dron vuelve
            // (ver esperarQueDejeDeAterrizar).
            val respuesta = if (soltarElAterrizaje("se ordenó volver a la base")) CompletableDeferred<Boolean>() else null
            val anterior = navigationJob
            Log.i(
                TAG,
                "Regreso pedido: corta el lazo $lazoActual con el Virtual Stick " +
                    (if (virtualStickListo.get()) "habilitado" else "deshabilitado") +
                    (if (volviendo) "; el dron ya vuelve por su cuenta (${estadoDelRegreso.value}, modo ${modoDelSdk.get()})" else "") +
                    (if (respuesta != null) "; corta un aterrizaje en curso" else ""),
            )
            // La secuencia arranca recién con todo anotado (CoroutineStart.LAZY):
            // en otro hilo podía mirar el regreso antes de que fuera de la app.
            if (!relevarLazo(Lazo.REGRESO, CoroutineStart.LAZY) { sostenerElRegreso(anterior, respuesta) }) return
            // Desde ya el regreso es de la app: lo que KeyGoHomeStatus diga de
            // acá en más es de este regreso y no una toma del dron. Va después
            // de relevar, que lo borra para los lazos que no son un aterrizaje;
            // lo vuelve a borrar el fracaso de la secuencia.
            aterrizajeEsperado = Aterrizaje.EN_BASE
            seguidorDelRegreso.alOrdenar(SeguidorDelRegreso.Orden.REGRESO)
            navigationJob?.start()
            respuesta
        }
        if (corteDelAterrizaje != null) detenerElAterrizajeAutomatico(corteDelAterrizaje)
    }

    override fun land() {
        if (!enVuelo) {
            // Abortar un despegue que todavía no dejó el suelo (un relevo
            // cancelado con B en la plataforma): no despega.
            cancelarDespegueEnElSuelo(Aterrizaje.AQUI)
            return
        }
        // Con un regreso de la app en curso, relevarLazo corta su GoHome antes
        // que nada, y la secuencia del aterrizaje espera ese corte antes de
        // ordenar: con el GoHome puesto el DJI no aterriza donde está.
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
     *
     * Hay GoHome que parar si el dron vuelve ([dronVolviendo]: el estado del
     * regreso O el modo GO_HOME) o si el `KeyStartGoHome` de la app salió
     * ([regresoOrdenado]), aunque la secuencia ya haya terminado y el dron
     * todavía no se vea volviendo. Antes solo se miraba el estado del regreso:
     * con la secuencia terminada en GO_HOME y el estado todavía en IDLE no salía
     * ningún KeyStopGoHome, y el estacionario de tomar el control rebotaba
     * contra el GoHome (la falla 3 del campo, VUELO §0).
     */
    override fun cancelarRegreso() {
        if (!enVuelo) return
        // La secuencia del regreso de la app ([sostenerElRegreso]) se corta
        // también, esté donde esté: si no, seguiría ordenando el GoHome detrás
        // de la orden que viene (el estacionario de tomar el control).
        val (secuenciaEnCurso, ordenEnviada) = synchronized(relevoDeLazo) {
            val enCurso = lazoActual == Lazo.REGRESO && navigationJob?.isActive == true
            val enviada = regresoOrdenado
            if (enCurso) {
                Log.i(TAG, "Corte del regreso: se corta la secuencia del regreso (KeyStartGoHome ${if (enviada) "ya salió" else "todavía no salió"})")
                cortarLazo()
            }
            enCurso to enviada
        }
        val volviendo = dronVolviendo()
        if (!volviendo && !ordenEnviada) {
            if (secuenciaEnCurso) {
                // Se cortó antes de pedirle nada al dron: no hay GoHome que parar.
                Log.i(TAG, "Corte del regreso: la secuencia se cortó antes del KeyStartGoHome, no hay GoHome que parar")
                aterrizajeEsperado = Aterrizaje.NINGUNO
            }
            return
        }
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
        synchronized(relevoDeLazo) {
            // El GoHome de la app lo para este corte: la orden de vuelo que sigue
            // no manda otro (ver relevarLazo), y su vuelta a IDLE no es un
            // regreso interrumpido (ver alDejarDeVolver).
            regresoOrdenado = false
            regresoVigilado = false
        }
        Log.i(
            TAG,
            "Corte del regreso: KeyStopGoHome (" +
                (if (volviendo) "el dron vuelve: ${estadoDelRegreso.value}, modo ${modoDelSdk.get()}" else "el dron todavía no se ve volviendo, pero el KeyStartGoHome salió") +
                ")",
        )
        // La orden que quien llama da enseguida no le gana: su lazo espera este
        // corte antes de habilitar el Virtual Stick (ver relevarLazo), y un
        // regreso nuevo, antes de ordenar o adoptar nada. Un corte que todavía
        // está saliendo va primero: dos KeyStopGoHome encimados se pisaban, y el
        // rechazo del segundo con el dron todavía en GO_HOME parecía un corte
        // fallido.
        val previo = corteDelRegreso?.takeIf { it.isActive }
        corteDelRegreso = scope.launch {
            if (previo != null) {
                Log.i(TAG, "Corte del regreso: espera el corte anterior, que todavía está saliendo")
                withTimeoutOrNull(ESPERA_DEL_CORTE_ENTERO_MS) { previo.join() }
                val vuelo = leerElVuelo()
                if (!ordenEnviada && vuelo.volviendo == false && vuelo.contesto) {
                    Log.i(TAG, "Corte del regreso: el corte anterior lo dejó sin volver ($vuelo), no hace falta otro")
                    return@launch
                }
            }
            val sigue = cortarElGoHome("Corte del regreso", ordenEnviada) ?: return@launch
            avisarSiempre("${DroneController.NO_SE_CORTO_EL_REGRESO}: $sigue")
            devolverElVuelo(tomaAnterior, aterrizajeAnterior)
        }
    }

    /**
     * `KeyStopGoHome` y la comprobación de que el dron dejó de volver, para
     * [cancelarRegreso] y para el corte de [relevarLazo]. [quien] encabeza las
     * líneas del logcat; [ordenEnviada] dice si salió un `KeyStartGoHome` de la
     * app que puede no haber entrado todavía. Null si el GoHome quedó cortado o
     * no había ninguno; si no, por qué sigue volviendo, para el aviso.
     *
     *  - El corte sale detrás de un `KeyStartGoHome` que todavía no contestó
     *    ([ordenDelRegreso]): si no, podían cruzarse en el camino al dron.
     *  - Aceptado, el dron tiene que dejar de volver con el MISMO criterio que la
     *    secuencia (el estado fuera del regreso y el modo fuera de GO_HOME),
     *    preguntado cada medio segundo ([esperarQueDejeDeVolver]). Antes se
     *    esperaba el primer IDLE del flujo del estado, que con un IDLE viejo
     *    volvía en el acto con el dron todavía en GO_HOME.
     *  - Rechazado o sin respuesta, cuenta como «no había regreso» solo una
     *    lectura que diga que el dron no vuelve, y si el corte no contestó, una
     *    lectura que el dron haya contestado: un IDLE guardado no prueba nada.
     *    Si el `KeyStartGoHome` de la app había salido, el GoHome puede no haber
     *    entrado todavía (por eso el dron rechazó el corte): se lo mira tres
     *    segundos y, si arranca, se lo vuelve a cortar ([vigilarQueNoArranque]).
     */
    private suspend fun cortarElGoHome(quien: String, ordenEnviada: Boolean): String? {
        val (aceptado, motivo) = mandarElCorte(quien)
        if (aceptado == true) {
            return if (esperarQueDejeDeVolver(quien)) null else "el dron no lo cortó en ${ESPERA_CORTE_REGRESO_MS / 1000} s; sigue volviendo"
        }
        val vuelo = leerElVuelo()
        Log.i(TAG, "$quien: con el KeyStopGoHome ${resultado(aceptado, motivo)}, $vuelo")
        val noVuelve = vuelo.volviendo == false && (vuelo.contesto || aceptado == false)
        if (!noVuelve) {
            return (if (aceptado == false) "el dron no aceptó la orden ($motivo)" else "el dron no contestó la orden en ${ESPERA_CORTE_REGRESO_MS / 1000} s") +
                "; sigue volviendo"
        }
        if (!ordenEnviada) {
            Log.i(TAG, "$quien: el dron no vuelve, no había regreso en curso que cortar")
            return null
        }
        return vigilarQueNoArranque(quien)
    }

    /** `KeyStopGoHome` con tope, detrás de un `KeyStartGoHome` que todavía no contestó (ver [ordenDelRegreso]). */
    private suspend fun mandarElCorte(quien: String): Pair<Boolean?, String?> {
        val desde = System.currentTimeMillis()
        var motivo: String? = null
        val esperando = ordenDelRegreso.isLocked
        if (esperando) Log.i(TAG, "$quien: el KeyStopGoHome espera la respuesta del KeyStartGoHome que está saliendo")
        val aceptado = ordenDelRegreso.withLock {
            if (esperando) Log.i(TAG, "$quien: el KeyStartGoHome contestó a los ${System.currentTimeMillis() - desde} ms, sale el KeyStopGoHome")
            withTimeoutOrNull(ESPERA_CORTE_REGRESO_MS) {
                accionCon(FlightControllerKey.KeyStopGoHome, EmptyMsg(), alFallar = { motivo = it })
            }
        }
        Log.i(TAG, "$quien: KeyStopGoHome ${resultado(aceptado, motivo)} en ${System.currentTimeMillis() - desde} ms")
        return aceptado to motivo
    }

    /**
     * Después de un `KeyStopGoHome` aceptado: que el dron deje de volver
     * ([VueloLeido.volviendo] en false, en una lectura que el dron contestó),
     * preguntándoselo cada medio segundo, con tope de [ESPERA_CORTE_REGRESO_MS].
     */
    private suspend fun esperarQueDejeDeVolver(quien: String): Boolean {
        val desde = System.currentTimeMillis()
        while (true) {
            val vuelo = leerElVuelo()
            val ms = System.currentTimeMillis() - desde
            if (vuelo.volviendo == false && vuelo.contesto) {
                Log.i(TAG, "$quien: el dron dejó de volver a los $ms ms ($vuelo)")
                return true
            }
            if (ms >= ESPERA_CORTE_REGRESO_MS) {
                Log.w(TAG, "$quien: a los $ms ms el dron sigue volviendo ($vuelo)")
                return false
            }
            delay(SupervisorDelRegreso.INTERVALO_MS)
        }
    }

    /**
     * El corte se rechazó con el dron sin volver, pero el `KeyStartGoHome` de la
     * app salió: el GoHome puede no haber entrado todavía. Se lo mira
     * [ESPERA_CORTE_REGRESO_MS], preguntando cada medio segundo, y si arranca se
     * lo vuelve a cortar, una vez. Null si quedó sin volver.
     */
    private suspend fun vigilarQueNoArranque(quien: String): String? {
        val desde = System.currentTimeMillis()
        Log.i(TAG, "$quien: el KeyStartGoHome salió y el dron todavía no vuelve; se mira ${ESPERA_CORTE_REGRESO_MS / 1000} s que no arranque")
        while (System.currentTimeMillis() - desde < ESPERA_CORTE_REGRESO_MS) {
            delay(SupervisorDelRegreso.INTERVALO_MS)
            val vuelo = leerElVuelo()
            if (vuelo.volviendo != true) continue
            Log.i(TAG, "$quien: el GoHome arrancó a los ${System.currentTimeMillis() - desde} ms del corte ($vuelo): KeyStopGoHome otra vez")
            val (aceptado, motivo) = mandarElCorte(quien)
            return when {
                aceptado == true && esperarQueDejeDeVolver(quien) -> null
                aceptado == true -> "el dron no lo cortó en ${ESPERA_CORTE_REGRESO_MS / 1000} s; sigue volviendo"
                aceptado == false -> "el dron no aceptó la orden ($motivo); sigue volviendo"
                else -> "el dron no contestó la orden en ${ESPERA_CORTE_REGRESO_MS / 1000} s; sigue volviendo"
            }
        }
        Log.i(TAG, "$quien: en ${ESPERA_CORTE_REGRESO_MS / 1000} s no arrancó ningún GoHome, no había regreso que cortar")
        return null
    }

    /**
     * El corte del regreso no salió y el dron sigue volviendo: todo vuelve a
     * como estaba antes del corte. Lo que la app ordenó desde entonces (subir,
     * ir a otra base) se corta, porque el Virtual Stick contra un regreso
     * activo es pelearle el vuelo al DJI; si el vuelo era del DJI vuelve a
     * serlo; y si el regreso era el de la app, se lo vuelve a esperar como tal,
     * así su descenso se avisa ([FlightEvent.DescendiendoEnBase] y no una toma
     * falsa), el aterrizaje se confirma, al tocar el suelo sale
     * [FlightEvent.ArrivedHome] y, si se interrumpe en el aire, se avisa
     * ([regresoVigilado]).
     *
     * Una orden de volver que llegó después del corte no se corta: el dron
     * vuelve igual, y su secuencia, que esperaba este corte, lo adopta.
     */
    private fun devolverElVuelo(toma: MotivoDelDron?, aterrizaje: Aterrizaje) {
        val regresoPedido = synchronized(relevoDeLazo) {
            val pedido = lazoActual == Lazo.REGRESO && navigationJob?.isActive == true
            if (!pedido) cortarLazo()
            pedido
        }
        apagarVirtualStick()
        if (aterrizajeEsperado == Aterrizaje.NINGUNO) aterrizajeEsperado = aterrizaje
        if (!regresoPedido && aterrizajeEsperado == Aterrizaje.EN_BASE) {
            synchronized(relevoDeLazo) { regresoVigilado = true }
        }
        Log.i(TAG, "Corte del regreso: el vuelo vuelve a como estaba (aterrizaje esperado $aterrizajeEsperado${if (regresoPedido) ", con un regreso pedido después del corte" else ""})")
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

    /**
     * El paso 1 de [sostenerElAterrizaje] (y de [soltarElMando]), con tope: el
     * lazo anterior ya está cancelado. [quien] encabeza la línea del logcat.
     */
    private suspend fun esperarElFinDe(anterior: Job?, quien: String = "Aterrizaje") {
        if (anterior == null) return
        val desde = System.currentTimeMillis()
        val termino = withTimeoutOrNull(ESPERA_FIN_DEL_LAZO_MS) { anterior.join() } != null
        Log.i(TAG, "$quien: el lazo anterior ${if (termino) "terminó" else "NO terminó"} en ${System.currentTimeMillis() - desde} ms")
    }

    /**
     * `KeyStartAutoLanding` con tope; lo que contesta lo decide
     * [SupervisorDelAterrizaje.alContestar]. Sin enlace la orden no sale: no le
     * llegaría al dron y gastaría los intentos (ver [esperarElEnlace]).
     */
    private suspend fun ordenarElAterrizaje(supervisor: SupervisorDelAterrizaje): SupervisorDelAterrizaje.Accion {
        if (supervisor.ordenes > 0) delay(SupervisorDelAterrizaje.ENTRE_ORDENES_MS)
        esperarElEnlace("Aterrizaje", SupervisorDelAterrizaje.INTERVALO_MS)
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
        val yaAceptado = supervisor.aceptado
        val accion = supervisor.alLeer(lectura)
        // Una orden que salió justo antes de cortarse el enlace se da por
        // aceptada recién cuando vuelve y el dron se ve bajando.
        if (!yaAceptado && supervisor.aceptado) {
            Log.i(TAG, "Aterrizaje: con el enlace de vuelta el dron se ve bajando, se da por aceptado")
            avisarQueAceptoElAterrizaje()
        }
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
    private suspend fun <T> leerDelDron(llave: DJIKeyInfo<T>): T? =
        preguntarAlDron(llave) ?: runCatching { KeyManager.getInstance().getValue(KeyTools.createKey(llave)) }.getOrNull()

    /**
     * El valor de [llave] preguntándoselo al dron, con tope de
     * [ESPERA_LECTURA_MS]; null si no contesta. A diferencia de [leerDelDron] no
     * cae al valor guardado: el corte del regreso necesita saber si lo que lee
     * lo dijo el dron ahora o es lo último que avisó (ver [cortarElGoHome]).
     */
    private suspend fun <T> preguntarAlDron(llave: DJIKeyInfo<T>): T? {
        val km = KeyManager.getInstance()
        val key = KeyTools.createKey(llave)
        return withTimeoutOrNull(ESPERA_LECTURA_MS) {
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
     * queda en el logcat y, si se da [respuesta], ahí: la secuencia del regreso
     * la espera antes de mirar si el dron vuelve (ver [esperarQueDejeDeAterrizar]).
     */
    private fun detenerElAterrizajeAutomatico(respuesta: CompletableDeferred<Boolean>? = null) {
        val desde = System.currentTimeMillis()
        runCatching {
            KeyManager.getInstance().performAction(
                KeyTools.createKey(FlightControllerKey.KeyStopAutoLanding),
                EmptyMsg(),
                object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                    override fun onSuccess(resultado: EmptyMsg?) {
                        Log.i(TAG, "KeyStopAutoLanding aceptada en ${System.currentTimeMillis() - desde} ms")
                        respuesta?.complete(true)
                    }

                    override fun onFailure(error: IDJIError) {
                        Log.i(TAG, "KeyStopAutoLanding rechazada en ${System.currentTimeMillis() - desde} ms: ${describir(error)}")
                        respuesta?.complete(false)
                    }
                },
            )
        }.onFailure { falla ->
            Log.w(TAG, "KeyStopAutoLanding no salió", falla)
            respuesta?.complete(false)
        }
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

    // ---- El regreso a base de la app: se comprueba que arranque (docs/VUELO.md §7.2) ----

    /**
     * La secuencia del regreso, en este orden:
     *  1. que el lazo anterior termine de verdad, como en el aterrizaje:
     *     cancelarlo no lo frena en el acto, y una vuelta que ya estaba adentro
     *     de `enviarVelocidad*` volvía a habilitar el Virtual Stick DESPUÉS de
     *     apagarlo (lo que pasó en el campo con la órbita);
     *  2. el Virtual Stick deshabilitado, esperando la respuesta del SDK: con
     *     él tomado el DJI rechaza el GoHome, o lo deja apenas le llega una
     *     velocidad (`GoHomeExitCode.JOYSTICK_*`);
     *  3. el corte de un GoHome que todavía esté saliendo ([corteDelRegreso]:
     *     tomaron el control y enseguida volvieron a pedir la base): si no, se
     *     adoptaría un regreso que está por cortarse, o el corte cortaría el que
     *     se pide ahora;
     *  4. si este regreso cortó un aterrizaje, la respuesta del
     *     `KeyStopAutoLanding` y una lectura sin el aterrizaje
     *     ([esperarQueDejeDeAterrizar]): el LANDING de ese aterrizaje no es un
     *     regreso;
     *  5. si el dron ya está volviendo por su cuenta (su regreso por batería,
     *     el botón del control), se lo adopta en vez de pedir otro regreso, que
     *     el SDK rechazaría. «Volviendo» es [VueloLeido.volviendo], el mismo
     *     criterio de [SupervisorDelRegreso.arranco];
     *  6. `KeyStartGoHome` con tope, y cada medio segundo la comprobación de que
     *     el regreso arrancó con las reglas de [SupervisorDelRegreso]: si en 3 s
     *     no arrancó se vuelve a ordenar, hasta tres órdenes; sin enlace la orden
     *     no sale y el reloj no corre, y bajando (cerca de la base el GoHome
     *     aterriza directo) se lo mira hasta el suelo.
     *
     * Termina cuando arrancó (el resto lo sigue el oyente de `KeyGoHomeStatus`:
     * el descenso en la base, al tocar el suelo [FlightEvent.ArrivedHome], y un
     * final en el aire se avisa, ver [alDejarDeVolver]), en el suelo, o
     * soltando el regreso con un aviso que sale SIEMPRE
     * ([DroneController.NO_SE_PUDO_VOLVER]). En ese caso el Virtual Stick queda
     * apagado y el dron estacionario por su cuenta (P-GPS), a la espera de la
     * orden que sigue: PatrolManager lo deja en pausa con hold(), que vuelve a
     * habilitarlo. Todo queda en el logcat para el banco
     * (`adb logcat -s DjiDroneController PatrolManager`).
     */
    private suspend fun sostenerElRegreso(anterior: Job?, corteDelAterrizaje: CompletableDeferred<Boolean>?) {
        val desde = System.currentTimeMillis()
        esperarElFinDe(anterior, "Regreso")
        apagarVirtualStickYEsperar("el regreso a base", siNoSePudo = "el dron puede no arrancar el regreso")
        esperarElCorteDelRegreso("Regreso", ESPERA_DEL_CORTE_ENTERO_MS, cortarAlVencer = true)
        val sinElAterrizaje = corteDelAterrizaje == null || esperarQueDejeDeAterrizar(corteDelAterrizaje)
        val vuelo = leerElVuelo()
        if (vuelo.volviendo == true) {
            // Un LANDING cerca de la base, recién cortado un aterrizaje que no se
            // vio terminar, puede ser ese aterrizaje: no se adopta. Volviendo
            // (RETURNING_TO_HOME, GO_HOME) es un regreso de verdad.
            val soloBajando = vuelo.estado == GoHomeState.LANDING && vuelo.modo != FlightMode.GO_HOME
            if (sinElAterrizaje || !soloBajando) {
                // Si ya está bajando, el descenso se avisa ahora: el oyente no
                // vuelve a contar un estado que no cambió, y un relevo de patrulla
                // lo necesita (RELEVOS §2.3). Solo un estado del regreso en curso:
                // adoptado por el modo GO_HOME con el estado todavía en IDLE,
                // volver a contar ese IDLE le borraba al seguidor el regreso
                // propio, y con él la regla del único corte.
                Log.i(TAG, "Regreso: el dron ya volvía por su cuenta ($vuelo), se lo adopta sin otra orden")
                if (marcarElRegresoAdoptado()) {
                    estadoDelRegreso.value
                        ?.takeIf { it.name in SupervisorDelRegreso.ESTADOS_DE_REGRESO_EN_CURSO }
                        ?.let(::alCambiarElRegreso)
                }
                return
            }
            Log.i(TAG, "Regreso: no se adopta el LANDING ($vuelo): el aterrizaje recién cortado no se vio terminar; se ordena el regreso")
        }
        val supervisor = SupervisorDelRegreso()
        var accion = supervisor.empezar()
        while (accion == SupervisorDelRegreso.Accion.ORDENAR || accion == SupervisorDelRegreso.Accion.SEGUIR) {
            accion = if (accion == SupervisorDelRegreso.Accion.ORDENAR) {
                ordenarElRegreso(supervisor) ?: return
            } else {
                vigilarElRegreso(supervisor)
            }
        }
        terminarElRegreso(accion, supervisor, desde)
    }

    /**
     * `KeyStartGoHome` con tope; lo que contesta lo decide
     * [SupervisorDelRegreso.alContestar]. Null si a esta secuencia ya la
     * cortaron: la orden no sale y la secuencia termina en silencio.
     *
     * Antes de la orden: el enlace ([esperarElEnlace]: sin él la orden no le
     * llega al dron, gastaba los tres intentos y terminaba en un «no se pudo
     * volver» con el dron quizás volviendo) y el Virtual Stick apagado (una
     * habilitación que llegó tarde, o un apagado que falló). Desde que se marca
     * hasta que el dron contesta, [ordenDelRegreso] queda tomado aunque corten
     * la secuencia: el corte sale detrás de la respuesta, nunca delante.
     */
    private suspend fun ordenarElRegreso(supervisor: SupervisorDelRegreso): SupervisorDelRegreso.Accion? {
        if (supervisor.ordenes > 0) delay(SupervisorDelRegreso.ENTRE_ORDENES_MS)
        esperarElEnlace("Regreso", SupervisorDelRegreso.INTERVALO_MS)
        if (virtualStickListo.get()) {
            apagarVirtualStickYEsperar("el regreso a base (antes de la orden)", siNoSePudo = "el dron puede no arrancar el regreso")
        }
        var desde = 0L
        var motivo: String? = null
        val aceptada = ordenDelRegreso.withLock {
            if (!marcarElRegresoOrdenado()) return null
            Log.i(TAG, "Regreso: KeyStartGoHome, orden ${supervisor.ordenes + 1} de ${SupervisorDelRegreso.MAXIMO_DE_ORDENES}")
            desde = System.currentTimeMillis()
            withContext(NonCancellable) {
                withTimeoutOrNull(SupervisorDelRegreso.ESPERA_DE_LA_ORDEN_MS) {
                    accionCon(FlightControllerKey.KeyStartGoHome, EmptyMsg(), alFallar = { motivo = it })
                }
            }
        }
        Log.i(TAG, "Regreso: KeyStartGoHome ${resultado(aceptada, motivo)} en ${System.currentTimeMillis() - desde} ms")
        return supervisor.alContestar(aceptada, leerElRegreso(), motivo)
    }

    /**
     * Marca que `KeyStartGoHome` sale, si esta secuencia sigue siendo la vigente
     * (un solo paso con [relevoDeLazo], como [despegueOrdenado]): un corte que
     * llegó antes la encuentra sin ordenar y no tiene GoHome que parar; uno que
     * llega después sabe que sí (ver [cancelarRegreso], [relevarLazo]). Desde acá
     * el final de este regreso se vigila ([regresoVigilado]). false si a esta
     * secuencia ya la cortaron: la orden no tiene que salir.
     */
    private suspend fun marcarElRegresoOrdenado(): Boolean {
        val lazo = currentCoroutineContext()[Job]
        return synchronized(relevoDeLazo) {
            val vigente = lazo != null && lazo === navigationJob && lazo.isActive
            if (vigente) {
                regresoOrdenado = true
                regresoVigilado = true
            }
            vigente
        }
    }

    /**
     * Este regreso adopta el que el dron ya tenía en curso, si la secuencia
     * sigue siendo la vigente: no sale ninguna orden ([regresoOrdenado] queda en
     * false, y una orden de vuelo que lo reemplace no lo corta: el del propio DJI
     * se corta con [cancelarRegreso] y su único intento), pero su final se vigila
     * igual ([regresoVigilado]).
     */
    private suspend fun marcarElRegresoAdoptado(): Boolean {
        val lazo = currentCoroutineContext()[Job]
        return synchronized(relevoDeLazo) {
            val vigente = lazo != null && lazo === navigationJob && lazo.isActive
            if (vigente) regresoVigilado = true
            vigente
        }
    }

    /** Una vuelta de la comprobación: el Virtual Stick que no puede quedar prendido, y si el regreso arrancó. */
    private suspend fun vigilarElRegreso(supervisor: SupervisorDelRegreso): SupervisorDelRegreso.Accion {
        delay(SupervisorDelRegreso.INTERVALO_MS)
        // Una habilitación que llegó tarde (de antes de la orden) no puede
        // quedar prendida: con ella el DJI no arranca el regreso, o lo deja.
        if (virtualStickListo.get()) {
            apagarVirtualStickYEsperar("el regreso a base (seguía habilitado)", siNoSePudo = "el dron puede no arrancar el regreso")
        }
        val accion = supervisor.alLeer(leerElRegreso())
        if (accion != SupervisorDelRegreso.Accion.SEGUIR) Log.i(TAG, "Regreso: $accion")
        return accion
    }

    /**
     * Lo que se lee del dron en cada vuelta ([leerElVuelo]) en los términos de
     * [SupervisorDelRegreso]: si arrancó, si baja (el modo de aterrizaje o el
     * pedido de confirmar: cerca de la base el GoHome aterriza directo) y por
     * qué salió del último GoHome. Cada lectura queda en el logcat: es lo que el
     * banco tiene que ver.
     */
    private suspend fun leerElRegreso(): SupervisorDelRegreso.Lectura {
        val vuelo = leerElVuelo()
        val pide = runCatching {
            KeyManager.getInstance().getValue(KeyTools.createKey(FlightControllerKey.KeyIsLandingConfirmationNeeded))
        }.getOrNull() == true
        Log.i(TAG, "Regreso: $vuelo ($modoDeVuelo) pideConfirmar=$pide enVuelo=$enVuelo enlace=$enlaceVivo")
        return SupervisorDelRegreso.Lectura(
            enVuelo = enVuelo,
            conEnlace = enlaceVivo,
            arranco = vuelo.volviendo,
            bajando = if (pide) true else vuelo.bajando,
            salida = vuelo.salida?.name,
        )
    }

    /** Lo que dice el dron de su regreso, leído de una vez (ver [leerElVuelo]). */
    private class VueloLeido(
        val estado: GoHomeState?,
        val modo: FlightMode?,
        val enModoDeAterrizaje: Boolean?,
        val salida: GoHomeExitCode?,
        /** `KeyGoHomeStatus` contestó la pregunta; si no, [estado] es el último que avisó el SDK. */
        val contesto: Boolean,
        val distanciaALaBaseM: Double,
    ) {
        /** El dron vuelve, con el criterio de [SupervisorDelRegreso.arranco]; null si no informa nada. */
        val volviendo: Boolean? get() = SupervisorDelRegreso.arranco(estado?.name, modo?.name, distanciaALaBaseM)

        /** El dron está aterrizando según el modo de vuelo o `KeyIsInLandingMode` ([SupervisorDelAterrizaje.estaBajando]). */
        val bajando: Boolean? get() = SupervisorDelAterrizaje.estaBajando(modo?.name, enModoDeAterrizaje)

        override fun toString(): String =
            "GoHomeState=$estado${if (contesto) "" else " (sin respuesta: el último avisado)"} modo=$modo " +
                "enModoDeAterrizaje=$enModoDeAterrizaje salidaDelGoHome=$salida " +
                "a ${if (distanciaALaBaseM.isNaN()) "?" else distanciaALaBaseM.toInt().toString()} m de la base"
    }

    /**
     * El regreso preguntado al dron: `KeyGoHomeStatus` con tope
     * ([preguntarAlDron]; si no contesta, el último que avisó el oyente), el modo
     * de vuelo (el del oyente de `KeyFlightMode`), `KeyIsInLandingMode` y por qué
     * salió del último GoHome (`KeyGoHomeExitReason`), y la distancia a la base.
     * Un estado que el oyente de `KeyGoHomeStatus` todavía no vio se le pasa, así
     * el resto del controlador sabe lo mismo que quien lee; salvo que el oyente
     * haya traído uno más nuevo mientras se preguntaba (ver [alLeerElRegreso]).
     */
    private suspend fun leerElVuelo(): VueloLeido {
        val antes = estadoDelRegreso.value
        val preguntado = preguntarAlDron(FlightControllerKey.KeyGoHomeStatus)
        val estado = if (preguntado != null) alLeerElRegreso(antes, preguntado) else estadoDelRegreso.value
        val km = KeyManager.getInstance()
        val modo = modoDelSdk.get() ?: runCatching { km.getValue(KeyTools.createKey(FlightControllerKey.KeyFlightMode)) }.getOrNull()
        val enModo = runCatching { km.getValue(KeyTools.createKey(FlightControllerKey.KeyIsInLandingMode)) }.getOrNull()
        val salida = runCatching { km.getValue(KeyTools.createKey(FlightControllerKey.KeyGoHomeExitReason)) }.getOrNull()
        return VueloLeido(
            estado = estado,
            modo = modo,
            enModoDeAterrizaje = enModo,
            salida = salida,
            contesto = preguntado != null,
            distanciaALaBaseM = distanciaALaBaseM(),
        )
    }

    /**
     * El dron vuelve, con lo último que avisó el SDK (sin preguntar): el mismo
     * criterio que la secuencia ([SupervisorDelRegreso.arranco]). Es lo que miran
     * [returnHome] para no repetir un regreso y [cancelarRegreso] para saber si
     * hay un GoHome que parar.
     */
    private fun dronVolviendo(): Boolean =
        SupervisorDelRegreso.arranco(estadoDelRegreso.value?.name, modoDelSdk.get()?.name, distanciaALaBaseM()) == true

    /** A cuántos metros del punto de retorno está el dron; NaN sin posición o sin punto de retorno. */
    private fun distanciaALaBaseM(): Double {
        val (lat, lon) = posicion() ?: return Double.NaN
        val (casaLat, casaLon) = puntoDeRetorno ?: return Double.NaN
        return Geo.distanciaM(lat, lon, casaLat, casaLon)
    }

    /**
     * Espera, con tope, el corte de un GoHome que está saliendo
     * ([corteDelRegreso]); [quien] encabeza la línea del logcat. Lo usan el lazo
     * que reemplaza a un regreso de la app (antes de habilitar el Virtual Stick:
     * contra el GoHome se lo rechazaba, o se pisaban por turnos) y la secuencia
     * de un regreso nuevo. Pasado el tope se sigue igual: el lazo, dejando que
     * el rechazo del Virtual Stick se avise; la secuencia, con [cortarAlVencer],
     * cortando ese corte para que no le corte el regreso que se pide ahora.
     */
    private suspend fun esperarElCorteDelRegreso(quien: String, topeMs: Long, cortarAlVencer: Boolean = false) {
        val corte = corteDelRegreso?.takeIf { it.isActive } ?: return
        val desde = System.currentTimeMillis()
        Log.i(TAG, "$quien: espera el corte del GoHome en curso antes de seguir")
        val termino = withTimeoutOrNull(topeMs) { corte.join() } != null
        Log.i(
            TAG,
            "$quien: el corte del GoHome ${if (termino) "terminó" else "NO terminó"} a los ${System.currentTimeMillis() - desde} ms; " +
                "el dron ${if (dronVolviendo()) "todavía vuelve" else "ya no vuelve"}",
        )
        if (!termino && cortarAlVencer) corte.cancel()
    }

    /**
     * Este regreso cortó un aterrizaje ([returnHome]): antes de mirar si el dron
     * vuelve se espera la respuesta de su `KeyStopAutoLanding` y una lectura sin
     * el aterrizaje ([SupervisorDelRegreso.sinElAterrizaje]), preguntando cada
     * medio segundo, con tope. Antes se miraba menos de un segundo después de
     * mandar el corte: el LANDING del aterrizaje se adoptaba como un regreso y
     * el dron bajaba donde estaba con la app diciendo que volvía. true si la
     * lectura llegó.
     */
    private suspend fun esperarQueDejeDeAterrizar(respuesta: CompletableDeferred<Boolean>): Boolean {
        val desde = System.currentTimeMillis()
        val contesto = withTimeoutOrNull(ESPERA_CORTE_ATERRIZAJE_MS) { respuesta.await() }
        Log.i(
            TAG,
            "Regreso: el KeyStopAutoLanding ${when (contesto) { true -> "se aceptó"; false -> "se rechazó"; null -> "no contestó" }} " +
                "a los ${System.currentTimeMillis() - desde} ms",
        )
        val limite = System.currentTimeMillis() + ESPERA_CORTE_ATERRIZAJE_MS
        while (true) {
            val vuelo = leerElVuelo()
            if (SupervisorDelRegreso.sinElAterrizaje(vuelo.estado?.name, vuelo.modo?.name, vuelo.enModoDeAterrizaje)) {
                Log.i(TAG, "Regreso: el dron dejó de aterrizar a los ${System.currentTimeMillis() - desde} ms ($vuelo)")
                return true
            }
            if (System.currentTimeMillis() >= limite) {
                Log.w(TAG, "Regreso: a los ${System.currentTimeMillis() - desde} ms el dron sigue aterrizando ($vuelo)")
                return false
            }
            delay(SupervisorDelRegreso.INTERVALO_MS)
        }
    }

    /**
     * Sin enlace con la aeronave una orden no le llega al dron: se espera que
     * vuelva, mirando cada [intervaloMs]. La espera es parte de la secuencia, así
     * que cualquier orden nueva la corta (releva el lazo). [quien] encabeza las
     * líneas del logcat.
     */
    private suspend fun esperarElEnlace(quien: String, intervaloMs: Long) {
        if (enlaceVivo) return
        val desde = System.currentTimeMillis()
        Log.i(TAG, "$quien: sin enlace con la aeronave, la orden espera que vuelva")
        while (!enlaceVivo) delay(intervaloMs)
        Log.i(TAG, "$quien: volvió el enlace a los ${System.currentTimeMillis() - desde} ms, sale la orden")
    }

    /** La secuencia terminó: arrancó, en el suelo, o soltando el regreso con su aviso. */
    private suspend fun terminarElRegreso(accion: SupervisorDelRegreso.Accion, supervisor: SupervisorDelRegreso, desde: Long) {
        val ms = System.currentTimeMillis() - desde
        when (accion) {
            SupervisorDelRegreso.Accion.ARRANCO ->
                Log.i(TAG, "Regreso: arrancó a los $ms ms con ${supervisor.ordenes} orden(es) (GoHomeState=${estadoDelRegreso.value})")
            SupervisorDelRegreso.Accion.EN_EL_SUELO ->
                Log.i(TAG, "Regreso: el dron está en el suelo a los $ms ms, no hay regreso que ordenar")
            else -> {
                val motivo = supervisor.motivoDelFallo()
                Log.w(TAG, "Regreso: se suelta a los $ms ms ($accion): $motivo")
                // Una respuesta definitiva a una orden de una persona: sale siempre.
                if (soltarEsteRegreso()) avisarSiempre("${DroneController.NO_SE_PUDO_VOLVER}: $motivo")
            }
        }
    }

    /**
     * Suelta el regreso de ESTA secuencia, si todavía es la vigente; false si
     * otra orden ya la había reemplazado. El dron queda con el Virtual Stick
     * apagado, estacionario por su cuenta, y la app sin ningún aterrizaje
     * esperado: lo que KeyGoHomeStatus diga después ya no es de este regreso.
     */
    private suspend fun soltarEsteRegreso(): Boolean {
        val yo = currentCoroutineContext()[Job]
        synchronized(relevoDeLazo) {
            if (yo !== navigationJob) return false
            aterrizajeEsperado = Aterrizaje.NINGUNO
            regresoOrdenado = false
            regresoVigilado = false
            lazoActual = Lazo.NINGUNO
        }
        return true
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

    /**
     * Llegó KeyGoHomeStatus (el oyente; también la adopción de un regreso, que
     * vuelve a contar el estado que hay): ver [alPasarElRegreso].
     */
    private fun alCambiarElRegreso(estado: GoHomeState) {
        val anterior = estadoDelRegreso.getAndUpdate { estado }
        alPasarElRegreso(anterior, estado)
    }

    /**
     * Un estado del regreso PREGUNTADO al dron ([leerElVuelo]): cuenta solo si
     * el oyente no avisó otro mientras se preguntaba. Un IDLE viejo de la
     * pregunta pisaba el RETURNING_TO_HOME que el oyente acababa de traer, y el
     * resto del controlador creía que el dron no volvía. Devuelve el que vale:
     * el leído, o el más nuevo del oyente.
     */
    private fun alLeerElRegreso(antes: GoHomeState?, leido: GoHomeState): GoHomeState? {
        if (leido == antes) return leido
        if (estadoDelRegreso.compareAndSet(antes, leido)) {
            alPasarElRegreso(antes, leido)
            return leido
        }
        val masNuevo = estadoDelRegreso.value
        Log.i(TAG, "Regreso: la lectura $leido llegó detrás del oyente ($masNuevo), vale la del oyente")
        return masNuevo
    }

    /**
     * El estado del regreso pasó de [anterior] a [estado]: el descenso en la
     * base y los regresos que nadie pidió ([SeguidorDelRegreso]), y si el dron
     * dejó de volver, el final del regreso de la app ([alDejarDeVolver]).
     */
    private fun alPasarElRegreso(anterior: GoHomeState?, estado: GoHomeState) {
        val enlaceRecienRecuperado = !enlaceVivo || System.currentTimeMillis() - enlaceVolvioMs < ENLACE_RECIEN_RECUPERADO_MS
        val motivo = TomaDelDron.motivoProbable(vigiaDelRth.estado, enlaceRecienRecuperado)
        when (val aviso = seguidorDelRegreso.alCambiarFase(faseDelRegreso(estado), ordenActual(), motivo)) {
            null -> Unit
            is FlightEvent.ElDronTomoElControl -> {
                if (TomaDelDron.bloqueaLaApp(aviso.motivo)) bloquearPorLaToma(aviso.motivo)
                avisarToma(aviso)
            }
            else -> flightEvents.tryEmit(aviso)
        }
        if (anterior != null && anterior.name in SupervisorDelRegreso.ESTADOS_DE_REGRESO_EN_CURSO && estado == GoHomeState.IDLE) {
            alDejarDeVolver("KeyGoHomeStatus $anterior → $estado")
        }
    }

    /**
     * La fase del regreso para [SeguidorDelRegreso]. Un LANDING lejos de la base
     * no es el descenso de un regreso (ver [SupervisorDelRegreso.CERCA_DE_LA_BASE_M]):
     * recién cortado un aterrizaje, el suyo avisaba un DescendiendoEnBase falso
     * (que en un relevo dispara `landing_at_base`) o una toma que no era.
     * Sin posición o sin punto de retorno se lo cuenta como siempre.
     */
    private fun faseDelRegreso(estado: GoHomeState): SeguidorDelRegreso.Fase {
        val fase = TomaDelDron.faseDelRegreso(estado.name)
        val lejos = distanciaALaBaseM() > SupervisorDelRegreso.CERCA_DE_LA_BASE_M
        return if (fase == SeguidorDelRegreso.Fase.DESCENDIENDO && lejos) SeguidorDelRegreso.Fase.OTRA else fase
    }

    /**
     * Llegó KeyFlightMode. Si el dron sale de GO_HOME con el estado del regreso
     * fuera del regreso (el GoHome se pone en GO_HOME antes de que su estado
     * salga de IDLE, y puede terminar sin que llegue a cambiar), es el final de
     * un regreso que el oyente del estado no ve: ver [alDejarDeVolver]. UNKNOWN
     * no es una salida: es el enlace que se corta.
     */
    private fun alCambiarElModo(modo: FlightMode) {
        val anterior = modoDelSdk.getAndSet(modo)
        if (anterior == FlightMode.GO_HOME && modo != FlightMode.GO_HOME && modo != FlightMode.UNKNOWN &&
            estadoDelRegreso.value?.name !in SupervisorDelRegreso.ESTADOS_DE_REGRESO_EN_CURSO
        ) {
            alDejarDeVolver("modo de vuelo $anterior → $modo con KeyGoHomeStatus=${estadoDelRegreso.value}")
        }
    }

    /**
     * El dron dejó de volver ([porQue]). Si era el regreso de la app
     * ([regresoVigilado]) y terminó EN EL AIRE ([SupervisorDelRegreso.seInterrumpioEnElAire]:
     * con el modo fuera de GO_HOME, sin aterrizar y por arriba de
     * [SupervisorDelRegreso.ALTURA_DEL_FINAL_DEL_REGRESO_M]) sin que nadie lo
     * cortara —OABT_STUCK, VELOCITY_STUCK, GPS_NO_SIGNAL, las palancas del
     * control…—, antes nadie se enteraba: la secuencia había terminado al
     * arrancar, la puerta del Virtual Stick seguía cerrada sin lazo, y la app en
     * RETURNING_HOME con el dron suspendido. Ahora se suelta este regreso (como
     * [soltarEsteRegreso]; si la secuencia todavía ordenaba, se la corta: ya no
     * tiene que volver a pedirlo) y se avisa por qué ([avisarLaSalidaDelRegreso]).
     * El Virtual Stick no se toca: si son las palancas, el dron es de quien las
     * mueve. Sin enlace no se avisa nada: lo que se ve es viejo.
     */
    private fun alDejarDeVolver(porQue: String) {
        if (!regresoVigilado || !enVuelo || !enlaceVivo) return
        val modo = modoDelSdk.get()
        val enModo = runCatching {
            KeyManager.getInstance().getValue(KeyTools.createKey(FlightControllerKey.KeyIsInLandingMode))
        }.getOrNull()
        val alt = lastAlt
        val altura = String.format(Locale.ROOT, "%.1f", alt)
        if (!SupervisorDelRegreso.seInterrumpioEnElAire(modo?.name, enModo, alt)) {
            Log.i(TAG, "Regreso: $porQue con el modo $modo, enModoDeAterrizaje=$enModo a $altura m: no es un final en el aire")
            return
        }
        val conVirtualStick = virtualStickListo.get()
        val soltado = synchronized(relevoDeLazo) {
            if (!regresoVigilado || aterrizando || aterrizajeEsperado != Aterrizaje.EN_BASE) return@synchronized false
            if (lazoActual == Lazo.REGRESO) {
                navigationJob?.cancel()
                navigationJob = null
                lazoActual = Lazo.NINGUNO
            }
            aterrizajeEsperado = Aterrizaje.NINGUNO
            regresoOrdenado = false
            regresoVigilado = false
            true
        }
        if (!soltado) return
        Log.w(
            TAG,
            "Regreso: $porQue en el aire, a $altura m con el modo $modo (Virtual Stick " +
                "${if (conVirtualStick) "habilitado" else "deshabilitado"}): se suelta el regreso de la app",
        )
        scope.launch { avisarLaSalidaDelRegreso() }
    }

    /**
     * Por qué terminó en el aire el regreso que [alDejarDeVolver] acaba de
     * soltar: `KeyGoHomeExitReason` preguntado al dron, y otra vez mientras no
     * diga nada (puede llegar detrás del estado). Las palancas del control
     * ([SupervisorDelRegreso.esSalidaPorLasPalancas]) son la persona al lado del
     * dron volándolo, la capa 2 de docs/VUELO.md §1:
     * [DroneController.REGRESO_CORTADO_EN_EL_CONTROL], y PatrolManager no le da
     * ninguna orden. Cualquier otra es una falla del regreso:
     * [DroneController.NO_SE_PUDO_VOLVER], y PatrolManager lo deja estacionario
     * a la espera de otra orden. Los dos salen siempre: son la respuesta a la
     * orden de volver.
     */
    private suspend fun avisarLaSalidaDelRegreso() {
        val desde = System.currentTimeMillis()
        var salida = preguntarAlDron(FlightControllerKey.KeyGoHomeExitReason)
        var lecturas = 1
        while (!SupervisorDelRegreso.salidaInformada(salida?.name) && lecturas < LECTURAS_DE_LA_SALIDA) {
            delay(ENTRE_LECTURAS_DE_LA_SALIDA_MS)
            salida = preguntarAlDron(FlightControllerKey.KeyGoHomeExitReason) ?: salida
            lecturas++
        }
        if (salida == null) {
            salida = runCatching {
                KeyManager.getInstance().getValue(KeyTools.createKey(FlightControllerKey.KeyGoHomeExitReason))
            }.getOrNull()
        }
        val codigo = salida?.name ?: "sin informar"
        val porLasPalancas = SupervisorDelRegreso.esSalidaPorLasPalancas(salida?.name)
        Log.i(
            TAG,
            "Regreso: salida del GoHome $codigo ($lecturas lectura(s) en ${System.currentTimeMillis() - desde} ms): " +
                if (porLasPalancas) "las palancas del control, el dron queda en manos de quien lo vuela" else "el regreso se interrumpió",
        )
        if (porLasPalancas) {
            avisarSiempre("${DroneController.REGRESO_CORTADO_EN_EL_CONTROL}: salida=$codigo")
        } else {
            avisarSiempre("${DroneController.NO_SE_PUDO_VOLVER}: el regreso se interrumpió en el aire (salida=$codigo)")
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
     *
     * Con un regreso de la app cuyo `KeyStartGoHome` ya salió ([regresoOrdenado])
     * cortar la secuencia no alcanza: el DJI sigue volando el GoHome, el lazo
     * nuevo le habilitaba el Virtual Stick en contra (rechazado, o pisándose por
     * turnos como en el campo, VUELO §0) y al llegar a casa su descenso se
     * avisaba como una toma del dron. Acá se lo corta, sin esperar y antes que
     * el lazo nuevo ([cortarElRegresoDeLaApp]); es la red de seguridad, porque
     * PatrolManager llama a [cancelarRegreso] antes de sus órdenes. Solo el de la
     * app: el regreso del propio DJI se corta con [cancelarRegreso] y su único
     * intento. Mientras un corte del GoHome está saliendo ([corteDelRegreso]),
     * el lazo nuevo lo espera, con tope, antes de empezar
     * ([esperarElCorteDelRegreso]). Un aterrizaje también: con el GoHome puesto
     * el DJI no aterriza donde está.
     *
     * [inicio] LAZY deja el lazo creado sin arrancar: [returnHome] anota el
     * regreso y recién después lo arranca, adentro del mismo lock.
     */
    private fun relevarLazo(
        tipo: Lazo,
        inicio: CoroutineStart = CoroutineStart.DEFAULT,
        cuerpo: suspend CoroutineScope.() -> Unit,
    ): Boolean =
        synchronized(relevoDeLazo) {
            if (aterrizando && tipo !in LAZOS_DEL_ATERRIZAJE) {
                descartarAterrizando("el lazo $tipo")
                return false
            }
            navigationJob?.cancel()
            if (regresoOrdenado && tipo != Lazo.REGRESO) cortarElRegresoDeLaApp(tipo)
            lazoActual = tipo
            // El estacionario o el mando que vengan anclan la nariz donde esté,
            // no donde estaba antes de este lazo.
            anclaDeRumbo.soltar()
            // Una orden de vuelo nueva: la app ya no espera ningún aterrizaje. Si
            // quedara el de un regreso que esta orden reemplaza, un regreso que
            // después arranque el propio DJI parecería pedido por la app y nadie
            // se enteraría de la toma. Un aterrizaje nuevo trae el suyo.
            if (tipo !in LAZOS_DEL_ATERRIZAJE) aterrizajeEsperado = Aterrizaje.NINGUNO
            // El despegue que hubiera era del lazo anterior (quien despega lo
            // marca después de relevar), y la altura pedida solo la conservan
            // los lazos que la releen.
            despegue = Despegue.NINGUNO
            regresoOrdenado = false
            regresoVigilado = false
            if (tipo !in LAZOS_CON_ALTURA_PEDIDA) alturaPedida = null
            // El regreso nuevo espera el corte por su cuenta, y más (ver sostenerElRegreso).
            val corte = corteDelRegreso?.takeIf { it.isActive && tipo != Lazo.REGRESO }
            navigationJob = if (corte == null) {
                scope.launch(start = inicio, block = cuerpo)
            } else {
                scope.launch(start = inicio) {
                    esperarElCorteDelRegreso("Lazo $tipo", ESPERA_CORTE_REGRESO_MS)
                    cuerpo()
                }
            }
            true
        }

    /**
     * Con [relevoDeLazo] tomado (ver [relevarLazo]): una orden de vuelo
     * ([porQue]) reemplaza al regreso de la app cuyo `KeyStartGoHome` salió.
     * `KeyStopGoHome` sin esperar, en su corrutina: el lazo nuevo la espera
     * antes de empezar, así que el corte le llega al dron antes que el Virtual
     * Stick (y detrás de la respuesta de un `KeyStartGoHome` que todavía no
     * contestó, ver [ordenDelRegreso]). Si no lo corta solo queda en el logcat:
     * el lazo nuevo sigue igual y, si el DJI le rechaza el Virtual Stick, se
     * avisa por ese lado.
     */
    private fun cortarElRegresoDeLaApp(porQue: Lazo) {
        Log.i(TAG, "Regreso de la app reemplazado por el lazo $porQue: KeyStopGoHome antes del lazo nuevo")
        // Desde ya el GoHome es de este corte: su vuelta a IDLE no es un regreso
        // interrumpido (ver alDejarDeVolver).
        regresoOrdenado = false
        regresoVigilado = false
        corteDelRegreso = scope.launch {
            val quien = "Corte del regreso (lazo $porQue)"
            cortarElGoHome(quien, ordenEnviada = true)?.let { sigue ->
                Log.w(TAG, "$quien: $sigue; el lazo nuevo sigue igual y el Virtual Stick puede ser rechazado")
            }
        }
    }

    /**
     * Corta el lazo en curso. Todos los que lo llaman terminan también un
     * aterrizaje de la app, si había: una orden de una persona (el regreso, el
     * corte del aterrizaje), el suelo, una toma del propio DJI o la despedida.
     * Un GoHome de la app que estuviera en curso sigue: ninguno de ellos es una
     * orden de vuelo que lo reemplace (ver [relevarLazo]).
     */
    private fun cortarLazo() {
        synchronized(relevoDeLazo) {
            lazoActual = Lazo.NINGUNO
            despegue = Despegue.NINGUNO
            regresoOrdenado = false
            regresoVigilado = false
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
        // Con un regreso a base de la app en curso (la secuencia, o el GoHome
        // que arrancó), tampoco: con el Virtual Stick tomado el DJI no arranca
        // el regreso, o lo deja (VUELO §7.2). Frena a la vuelta del lazo que
        // ya estaba adentro de enviarVelocidad* cuando se lo cortó; cualquier
        // otra orden de vuelo releva el lazo antes de llegar acá, y vuelve a poder.
        if (lazoActual == Lazo.REGRESO) return
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
                    // aterrizaje o un regreso a base: le cancelaría el
                    // aterrizaje automático, o el GoHome.
                    if (desconectado || (aterrizando && !corriendoseParaAterrizar) || lazoActual == Lazo.REGRESO) {
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
    private suspend fun apagarVirtualStickYEsperar(paraQue: String, siNoSePudo: String = "el dron puede no aterrizar") {
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
        if (apagado != true) {
            // No se sabe si quedó apagado: la marca vuelve a decir habilitado,
            // así quien la mira lo vuelve a intentar (las vigilancias del regreso
            // y del aterrizaje, cada medio segundo, y el regreso antes de cada
            // orden). Con la marca en false nadie lo reintentaba, y el GoHome o
            // el aterrizaje salían con el mando todavía tomado. Lo que el dron
            // diga de verdad lo corrige su oyente.
            virtualStickListo.set(true)
            avisar("no se pudo devolver el mando al control para $paraQue ($como): $siNoSePudo")
        }
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
        // Con la palanca de giro suelta la nariz se clava al rumbo que tenía al
        // soltarla (yaw en modo ÁNGULO), como con el control físico: "velocidad
        // de giro cero" amortigua el giro pero no sostiene el rumbo, y una
        // ráfaga dejaba al dron unos grados corrido, con la cámara mirando a
        // otro lado. Sin brújula todavía, se sigue con la velocidad de giro.
        val ancla = anclaDeRumbo.rumbo(giroSuelto = v.giroGradosS == 0.0, rumboActualGrados = rumboDeLaBrujula())
        VirtualStickManager.getInstance().sendVirtualStickAdvancedParam(
            VirtualStickFlightControlParam(
                p.pitch,
                p.roll,
                if (ancla != null) OrdenVirtualStick.rumboAngulo(ancla) else p.yaw,
                p.verticalThrottle,
                VerticalControlMode.VELOCITY,
                RollPitchControlMode.VELOCITY,
                if (ancla != null) YawControlMode.ANGLE else YawControlMode.ANGULAR_VELOCITY,
                FlightCoordinateSystem.BODY,
            ),
        )
    }

    /** El rumbo de la brújula en 0..360, o NaN mientras no haya informado: un cero inventado sería el norte. */
    private fun rumboDeLaBrujula(): Double = if (brujulaInformada) lastHeading else Double.NaN

    private companion object {
        /** El Virtual Stick se sostiene con comandos a 10 Hz. */
        const val INTERVALO_MANDO_MS = 100L

        /**
         * Ritmo de la telemetría: 5 por segundo. Más que los 2 que necesita la
         * web, porque PatrolManager guarda las últimas muestras para buscar la
         * pose del instante de cada cuadro analizado.
         */
        const val INTERVALO_TELEMETRIA_MS = 200L

        /** Órbita, seguimiento y vigilancia no bajan de esta altura (ver startOrbit). */
        const val ALTURA_MINIMA_SEGUIMIENTO_M = 15.0

        /** Vigilando, más cerca que esto del objetivo el rumbo hacia él es ruido del GPS: la nariz se queda donde está. */
        const val DISTANCIA_MINIMA_PARA_EL_RUMBO_M = 3.0

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

        /**
         * Los topes del corte de un GoHome (RELEVOS §4): la respuesta de
         * KeyStopGoHome; que el dron deje de volver después de aceptarlo; lo que
         * se mira que no arranque un GoHome que todavía no había entrado; y lo
         * que el lazo que reemplaza a un regreso de la app espera ese corte
         * antes de habilitar el Virtual Stick.
         */
        const val ESPERA_CORTE_REGRESO_MS = 3_000L

        /**
         * Lo que la secuencia de un regreso nuevo espera un corte del GoHome que
         * todavía está saliendo: el corte entero, en el peor caso (la respuesta
         * del KeyStartGoHome que tenía adelante, la suya, mirar que no arranque y
         * volver a cortarlo), con margen. Pasado esto el corte se corta: no
         * puede cortarle al dron el regreso que se pide ahora.
         */
        const val ESPERA_DEL_CORTE_ENTERO_MS = SupervisorDelRegreso.ESPERA_DE_LA_ORDEN_MS + 5 * ESPERA_CORTE_REGRESO_MS

        /**
         * Lo que un regreso que cortó un aterrizaje espera la respuesta de su
         * KeyStopAutoLanding, y después una lectura sin el aterrizaje (ver
         * esperarQueDejeDeAterrizar).
         */
        const val ESPERA_CORTE_ATERRIZAJE_MS = 3_000L

        /**
         * Cuántas veces se le pregunta al dron por qué dejó un GoHome en el aire
         * mientras no diga nada, y cada cuánto: KeyGoHomeExitReason puede llegar
         * detrás del estado del regreso.
         */
        const val LECTURAS_DE_LA_SALIDA = 4
        const val ENTRE_LECTURAS_DE_LA_SALIDA_MS = 300L

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
