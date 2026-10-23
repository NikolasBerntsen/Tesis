package com.tesis.dronepatrol.dji

import android.util.Log
import com.tesis.dronepatrol.drone.CuadroDeVideo
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.drone.EsperaCreciente
import com.tesis.dronepatrol.drone.FilaDelGimbal
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.Georreferencia
import com.tesis.dronepatrol.drone.LimitadorDeRitmo
import com.tesis.dronepatrol.drone.MandoVirtual
import com.tesis.dronepatrol.drone.Navegacion
import com.tesis.dronepatrol.drone.OrdenVirtualStick
import com.tesis.dronepatrol.drone.UltimoPedido
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Vinculacion
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
import dji.sdk.keyvalue.value.gimbal.GimbalAngleRotation
import dji.sdk.keyvalue.value.gimbal.GimbalAngleRotationMode
import dji.sdk.keyvalue.value.flightcontroller.FlightControlAuthorityChangeReason
import dji.sdk.keyvalue.value.flightcontroller.FlightCoordinateSystem
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
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

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
    private enum class Lazo { NINGUNO, RUTA, ESTACIONARIO, GOTO, ORBITA, SEGUIMIENTO, MANDO, DESPEGUE }

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
            cuadrosPorConvertir.trySend(CuadroCrudo(copia, width, height, paraConsola, paraDeteccion))
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
                    )?.let { cuadrosParaDeteccion.tryEmit(it) }
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
            if (motivo != FlightControlAuthorityChangeReason.MSDK_REQUEST) {
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
            modoDeVuelo = modo
            publicarEstado()
        }
        // Altura barométrica sobre el punto de despegue, que es la que entienden
        // las rutas (sus alturas son relativas a la base).
        escuchar(FlightControllerKey.KeyAltitude) { alt -> lastAlt = alt }
        escuchar(BatteryKey.KeyChargeRemainingInPercent) { pct -> lastBattery = pct.toDouble() }
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
        // agua o algo que no es suelo). Si la app lo ordenó, la app lo confirma.
        escuchar(FlightControllerKey.KeyIsLandingConfirmationNeeded) { hace ->
            if (hace && aterrizajeEsperado != Aterrizaje.NINGUNO) {
                scope.launch { accion(FlightControllerKey.KeyConfirmLanding, "confirmar el aterrizaje") }
            }
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
        )
    }

    override fun vincularControl() {
        scope.launch { accion(RemoteControllerKey.KeyRequestPairing, "iniciar la vinculación con la aeronave") }
    }

    override fun cancelarVinculacion() {
        scope.launch { accion(RemoteControllerKey.KeyStopPairing, "cancelar la vinculación") }
    }

    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) {
        relevarLazo(Lazo.RUTA) {
            var target = fromWaypoint.coerceIn(0, route.waypoints.size - 1)
            val alturaDeTrabajo = alturaDeVuelo(route.waypoints[target].alt)
            if (!enVuelo) {
                flightEvents.tryEmit(FlightEvent.Despegando)
                if (!despegar()) return@relevarLazo
            }
            asegurarVirtualStick()
            // Primero la altura, después el plano: a un metro del suelo no se
            // sale a 8 m/s hacia ningún lado.
            if (!subirA(alturaDeTrabajo)) return@relevarLazo
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
        if (!enVuelo) return // en el suelo ya está quieto
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
        if (rechazarEnElSuelo("el mando manual")) return
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
        if (!enVuelo) return
        // Sin lazo nuevo: el regreso a base lo maneja el propio dron. Se le
        // devuelve antes la autoridad de vuelo, que es lo que el RTH necesita.
        cortarLazo()
        apagarVirtualStick()
        aterrizajeEsperado = Aterrizaje.EN_BASE
        scope.launch {
            if (!accion(FlightControllerKey.KeyStartGoHome, "volver a la base")) aterrizajeEsperado = Aterrizaje.NINGUNO
        }
    }

    override fun land() {
        if (!enVuelo) return
        cortarLazo()
        apagarVirtualStick()
        aterrizajeEsperado = Aterrizaje.AQUI
        scope.launch {
            if (!accion(FlightControllerKey.KeyStartAutoLanding, "aterrizar")) aterrizajeEsperado = Aterrizaje.NINGUNO
        }
    }

    override fun despegarEnElLugar() {
        if (enVuelo) return
        relevarLazo(Lazo.DESPEGUE) {
            // Sin GPS se puede (en interior el Mini se sostiene con los sensores
            // de visión); sin enlace con la aeronave, no.
            val listo = _estado.value
            if (!listo.conectado) {
                avisar("no se puede despegar: ${listo.detalle}")
                return@relevarLazo
            }
            flightEvents.tryEmit(FlightEvent.Despegando)
            if (!ordenarDespegue()) return@relevarLazo
            if (!esperarDespegue()) return@relevarLazo
            flightEvents.tryEmit(FlightEvent.EnElAire)
            // Y nada más: el propio dron se sostiene suspendido donde quedó, y
            // el palito físico del RC-N3 sigue mandando hasta que llegue el
            // primer mando de la consola (que habilita el Virtual Stick).
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
        telemetry.tryEmit(
            Telemetry(
                p?.first ?: Double.NaN, p?.second ?: Double.NaN, lastAlt, lastBattery, lastSignal, lastHeading,
                System.currentTimeMillis(), lastGimbalPitch, rumboDeLaCamara(),
            ),
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
            delay(200)
        }
        seResolvioElProblema()
        return true
    }

    /** Sube (o baja) derecho hasta [alturaM] sosteniendo la posición y el rumbo. */
    private suspend fun subirA(alturaM: Double): Boolean {
        val limite = System.currentTimeMillis() + ESPERA_SUBIDA_MS
        while (!Navegacion.aLaAltura(lastAlt, alturaM)) {
            if (System.currentTimeMillis() > limite) {
                avisar("el dron no llegó a los ${alturaM.toInt()} m de altura de trabajo (está en ${lastAlt.toInt()} m)")
                return false
            }
            enviarVelocidadTerreno(0.0, 0.0, lastHeading, Navegacion.vertical(lastAlt, alturaM))
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
        suspendCancellableCoroutine { continuacion ->
            KeyManager.getInstance().performAction(
                KeyTools.createKey(llave),
                EmptyMsg(),
                object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                    override fun onSuccess(resultado: EmptyMsg?) {
                        if (continuacion.isActive) continuacion.resume(true)
                    }

                    override fun onFailure(error: IDJIError) {
                        val extra = runCatching(masDetalle).getOrDefault("").takeIf { it.isNotBlank() }
                        avisar("el dron no aceptó $que (${describir(error)}${extra?.let { "; $it" } ?: ""})")
                        if (continuacion.isActive) continuacion.resume(false)
                    }
                },
            )
        }

    /**
     * Releva el lazo de comandos: mata el que estaba y publica el nuevo, todo
     * bajo [relevoDeLazo]. Todos los modos pasan por acá —ruta, goto, órbita,
     * estacionario y mando manual— porque el par cortar+asignar es justamente lo
     * que no puede entrelazarse entre hilos.
     */
    private fun relevarLazo(tipo: Lazo, cuerpo: suspend CoroutineScope.() -> Unit) =
        synchronized(relevoDeLazo) {
            navigationJob?.cancel()
            lazoActual = tipo
            navigationJob = scope.launch(block = cuerpo)
        }

    private fun cortarLazo() {
        synchronized(relevoDeLazo) {
            lazoActual = Lazo.NINGUNO
            navigationJob?.cancel()
            navigationJob = null
        }
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
        if (!reintentoDelMandoVirtual.sePuedeIntentar(System.currentTimeMillis())) return
        if (!virtualStickListo.compareAndSet(false, true)) return
        val vs = VirtualStickManager.getInstance()
        vs.enableVirtualStick(
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    reintentoDelMandoVirtual.exito()
                    // El dron aceptó: si más adelante vuelve a rechazar, es un
                    // problema nuevo y tiene que volver a avisarse.
                    seResolvioElProblema()
                    // El modo avanzado es el único que acepta velocidades y
                    // marco de coordenadas; sin esto sendVirtualStickAdvancedParam
                    // no tiene efecto.
                    vs.setVirtualStickAdvancedModeEnabled(true)
                    // Si la app se cerró mientras el dron todavía lo aceptaba,
                    // esta habilitación llegó tarde y hay que deshacerla (ver
                    // mandarApagado()).
                    if (desconectado) {
                        virtualStickListo.set(false)
                        mandarApagado()
                    }
                }

                override fun onFailure(error: IDJIError) {
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
        mandarApagado()
    }

    /**
     * El apagado propiamente dicho, SIN pasar por la marca. Existe aparte porque
     * hay un camino donde la marca ya se consumió y el dron igual quedó con el
     * Virtual Stick habilitado: [disconnect] apaga mientras una habilitación
     * está en vuelo, y cuando la aeronave contesta ese `onSuccess` tardío el
     * Virtual Stick está prendido pero la marca ya dice false.
     */
    private fun mandarApagado() {
        VirtualStickManager.getInstance().disableVirtualStick(
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() = Unit

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

        const val TAG = "DjiDroneController"
    }
}
