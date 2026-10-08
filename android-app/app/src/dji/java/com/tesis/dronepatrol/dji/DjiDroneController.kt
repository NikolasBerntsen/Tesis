package com.tesis.dronepatrol.dji

import android.util.Log
import com.tesis.dronepatrol.drone.CuadroDeVideo
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.drone.EsperaCreciente
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.Georreferencia
import com.tesis.dronepatrol.drone.LimitadorDeRitmo
import com.tesis.dronepatrol.drone.MandoVirtual
import com.tesis.dronepatrol.drone.Navegacion
import com.tesis.dronepatrol.drone.OrdenVirtualStick
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import dji.sdk.keyvalue.key.AirLinkKey
import dji.sdk.keyvalue.key.BatteryKey
import dji.sdk.keyvalue.key.DJIActionKeyInfo
import dji.sdk.keyvalue.key.DJIKeyInfo
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.GimbalKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.key.ProductKey
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
import kotlin.math.cos
import kotlin.math.sin
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

    /** true mientras el lazo de [navigationJob] sea el del mando manual. Mismo lock. */
    private var mandoActivo = false

    /** Corrutina que convierte los cuadros del SDK, una por vez (ver [convertirCuadros]). */
    private var conversionJob: Job? = null

    /** Corrutina que sigue el estado del SDK ([DjiSdk]) para armar [estado]. */
    private var sdkJob: Job? = null

    // Lo que sigue lo escriben los listeners del SDK, cada uno en su hilo, y lo
    // leen los lazos de navegación y el que arma la telemetría, que corren en
    // otros: volátil para que no quede pegado. Sin esto un lazo podía quedarse
    // con lastLat en NaN y hacer `continue` para siempre —el dron reportando
    // posición y la ruta sin comandar una sola velocidad— sin que nada lo avise.
    @Volatile
    private var lastLat = Double.NaN

    @Volatile
    private var lastLon = Double.NaN

    /** Altura sobre el punto de despegue (barómetro), en metros. */
    @Volatile
    private var lastAlt = 0.0

    @Volatile
    private var lastBattery = 0.0

    @Volatile
    private var lastHeading = 0.0

    @Volatile
    private var lastSignal = 100

    /** Inclinación real del gimbal (0 horizonte, −90 nadir): con ella se ubica en el terreno lo que ve la cámara. */
    @Volatile
    private var lastGimbalPitch = Telemetry.GIMBAL_PATRULLA

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
        desconectado = false
        aterrizajeEsperado = Aterrizaje.NINGUNO
        // Un solo consumidor de cuadros, y se relanza por si se reconecta
        conversionJob?.cancel()
        conversionJob = scope.launch { convertirCuadros() }
        sdkJob?.cancel()
        sdkJob = scope.launch { DjiSdk.estado.collect { publicarEstado() } }
        VirtualStickManager.getInstance().setVirtualStickStateListener(oyenteDeVirtualStick)

        // Posición del dron → telemetría
        escuchar(FlightControllerKey.KeyAircraftLocation3D) { location ->
            lastLat = location.latitude
            lastLon = location.longitude
            emitTelemetry()
        }
        // Altura barométrica sobre el punto de despegue, que es la que entienden
        // las rutas (sus alturas son relativas a la base).
        escuchar(FlightControllerKey.KeyAltitude) { alt -> lastAlt = alt }
        // Nivel de batería → telemetría
        escuchar(BatteryKey.KeyChargeRemainingInPercent) { pct ->
            lastBattery = pct.toDouble()
            emitTelemetry()
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
        // enlace vuelve, el primer valor de posición reanuda la emisión sola.
        escuchar(FlightControllerKey.KeyConnection) { conectado ->
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
            baseFijada = casa.latitude != 0.0 || casa.longitude != 0.0
            publicarEstado()
        }
        escuchar(ProductKey.KeyProductType) { tipo ->
            modelo = tipo.name.replace('_', ' ').replace("DJI ", "")
            publicarEstado()
        }
        // Inclinación del gimbal: va en la telemetría porque PatrolManager la
        // necesita para proyectar al terreno la caja de una detección.
        escuchar(GimbalKey.KeyGimbalAttitude) { actitud -> lastGimbalPitch = actitud.pitch }
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
        val detalle = when {
            sdk.ultimoError.isNotBlank() && !sdk.registrado -> sdk.ultimoError
            !sdk.registrado -> "Registrando la app ante DJI… (hace falta internet la primera vez)"
            !sdk.productoConectado -> "Conectá el control al teléfono por USB y encendé el dron"
            !enlaceVivo -> "Control conectado, sin enlace con la aeronave: encendela y esperá el emparejamiento"
            !baseFijada -> "Esperando que el dron fije el punto de retorno (GPS)"
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
        )
    }

    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) {
        relevarLazo(esMando = false) {
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
            apuntarCamara(Telemetry.GIMBAL_PATRULLA)
            while (true) {
                delay(INTERVALO_MANDO_MS) // Virtual Stick requiere comandos a ~10 Hz
                if (lastLat.isNaN()) continue
                val wp = route.waypoints[target]
                val paso = Navegacion.hacia(lastLat, lastLon, wp.lat, wp.lon)
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
        relevarLazo(esMando = false) {
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
        relevarLazo(esMando = false) {
            asegurarVirtualStick()
            val altura = lastAlt
            while (true) {
                delay(INTERVALO_MANDO_MS)
                if (lastLat.isNaN()) continue
                val paso = Navegacion.hacia(lastLat, lastLon, lat, lon)
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
        relevarLazo(esMando = false) {
            asegurarVirtualStick()
            val altura = lastAlt
            // La cámara apunta al centro del círculo: con la nariz hacia el
            // centro (abajo) y el gimbal a esta inclinación, el objetivo queda
            // en el medio del cuadro durante toda la órbita.
            apuntarCamara(Georreferencia.inclinacionParaOrbitar(altura, radiusM))
            var angle = 0.0
            while (true) {
                delay(INTERVALO_MANDO_MS)
                if (lastLat.isNaN()) continue
                // Órbita: velocidad tangencial sobre el círculo y nariz apuntando al centro
                angle += (Navegacion.VELOCIDAD_ORBITA_MS / radiusM) * (INTERVALO_MANDO_MS / 1_000.0)
                val tLat = centerLat + (radiusM * cos(angle)) / Geo.METROS_POR_GRADO_LAT
                val tLon = centerLon + (radiusM * sin(angle)) / Geo.metrosPorGradoLon(centerLat)
                val paso = Navegacion.hacia(lastLat, lastLon, tLat, tLon, Navegacion.VELOCIDAD_ORBITA_MS)
                // La nariz —y con ella la cámara— apunta al objetivo que se orbita
                val rumboAlCentro = (Geo.rumboHacia(lastLat, lastLon, centerLat, centerLon) + 360.0) % 360.0
                enviarVelocidadTerreno(paso.vNorteMs, paso.vEsteMs, rumboAlCentro, Navegacion.vertical(lastAlt, altura))
            }
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
            if (mandoActivo && navigationJob?.isActive == true) return
            relevarLazo(esMando = true) {
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

    /** Tocó el suelo: el evento depende de qué se había ordenado. */
    private fun alAterrizar() {
        when (aterrizajeEsperado) {
            Aterrizaje.EN_BASE -> flightEvents.tryEmit(FlightEvent.ArrivedHome)
            Aterrizaje.AQUI -> flightEvents.tryEmit(FlightEvent.Aterrizado)
            Aterrizaje.NINGUNO -> Unit
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
        // 2) Se corta el lazo de comandos, sin esperarlo (ver arriba).
        cortarLazo()
        // 3) Se corta todo lo demás que sigue emitiendo: sin esto las
        //    conversiones ya lanzadas seguían publicando cuadros de un dron del
        //    que la app ya se despidió.
        scope.coroutineContext.cancelChildren()
        conversionJob = null
        sdkJob = null
        MediaDataCenter.getInstance().getCameraStreamManager().removeFrameListener(oyenteDeCuadros)
        VirtualStickManager.getInstance().removeVirtualStickStateListener(oyenteDeVirtualStick)
        KeyManager.getInstance().cancelListen(this)
        // 4) Y recién ahora se le devuelve el mando al palito físico del RC-N3.
        apagarVirtualStick()
    }

    private fun emitTelemetry() {
        // Sin enlace no se emite nada: ese silencio es lo que le avisa al
        // watchdog de PatrolManager que se perdió el dron.
        if (!enlaceVivo || lastLat.isNaN()) return
        telemetry.tryEmit(
            Telemetry(
                lastLat, lastLon, lastAlt, lastBattery, lastSignal, lastHeading,
                System.currentTimeMillis(), lastGimbalPitch,
            ),
        )
    }

    /**
     * Inclina el gimbal a [pitchGrados] (0 horizonte, −90 nadir) en ángulo
     * absoluto. Un rechazo se avisa, pero no frena nada: volar sin la cámara
     * donde se quiere es peor que no volar solo si el operador no se entera.
     */
    private fun apuntarCamara(pitchGrados: Double) {
        val giro = GimbalAngleRotation().apply {
            mode = GimbalAngleRotationMode.ABSOLUTE_ANGLE
            pitch = pitchGrados.coerceIn(-90.0, 0.0)
            roll = 0.0
            yaw = 0.0
            pitchIgnored = false
            rollIgnored = true
            yawIgnored = true
            duration = 1.0
            jointReferenceUsed = false
            timeout = 10
        }
        KeyManager.getInstance().performAction(
            KeyTools.createKey(GimbalKey.KeyRotateByAngle),
            giro,
            object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(resultado: EmptyMsg?) = Unit

                override fun onFailure(error: IDJIError) {
                    avisar("el gimbal no aceptó apuntar la cámara a ${pitchGrados.toInt()}° (${error.description()})")
                }
            },
        )
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
        if (!accion(FlightControllerKey.KeyStartTakeoff, "despegar")) return false
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
     * base) y espera su resultado. Un rechazo se avisa con el motivo del SDK.
     */
    private suspend fun accion(llave: DJIActionKeyInfo<EmptyMsg, EmptyMsg>, que: String): Boolean =
        suspendCancellableCoroutine { continuacion ->
            KeyManager.getInstance().performAction(
                KeyTools.createKey(llave),
                EmptyMsg(),
                object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                    override fun onSuccess(resultado: EmptyMsg?) {
                        if (continuacion.isActive) continuacion.resume(true)
                    }

                    override fun onFailure(error: IDJIError) {
                        avisar("el dron no aceptó $que (${error.description()})")
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
    private fun relevarLazo(esMando: Boolean, cuerpo: suspend CoroutineScope.() -> Unit) =
        synchronized(relevoDeLazo) {
            navigationJob?.cancel()
            mandoActivo = esMando
            navigationJob = scope.launch(block = cuerpo)
        }

    private fun cortarLazo() {
        synchronized(relevoDeLazo) {
            mandoActivo = false
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
                        "el dron no aceptó el mando virtual (${error.description()}): " +
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
                        "no se pudo devolver el mando al control (${error.description()}): " +
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

        /** Por debajo de esto no se trabaja: es menos que la altura del despegue automático. */
        const val ALTURA_MINIMA_M = 3.0

        /** Techo del vuelo: 120 m es el límite legal (ANAC) y el del propio dron. */
        const val ALTURA_MAXIMA_M = 120.0

        /** El despegue automático del SDK deja al dron a 1,2 m; se da por despegado a partir de 1 m. */
        const val ALTURA_DESPEGUE_SDK_M = 1.0

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
