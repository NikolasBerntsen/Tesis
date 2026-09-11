package com.tesis.dronepatrol.dji

import android.util.Log
import com.tesis.dronepatrol.drone.CuadroDeVideo
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.LimitadorDeRitmo
import com.tesis.dronepatrol.drone.MandoVirtual
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import dji.sdk.keyvalue.key.AirLinkKey
import dji.sdk.keyvalue.key.BatteryKey
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.value.common.ComponentIndexType
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
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Integración real con el DJI Mini 4 Pro vía MSDK v5.
 *
 * Importante (limitación del producto, no de este código): el Mini 4 Pro NO
 * soporta las misiones de waypoints nativas del MSDK (WaypointMissionManager es
 * solo Enterprise). El patrullaje autónomo se implementa con Virtual Stick:
 * un lazo que envía velocidades hacia el waypoint objetivo, igual que hace el
 * simulador.
 *
 * Este archivo es a propósito lo más flaco posible: compila solo bajo el flavor
 * "dji" (que CI no compila, hace falta -PenableDji), así que todo lo que se
 * puede probar sin dron —la conversión de los cuadros de video, el limitador de
 * ritmo y la escala del mando virtual— vive en el sourceSet `main` y acá queda
 * el pegamento con el SDK.
 */
class DjiDroneController : DroneController {

    override val telemetry = MutableSharedFlow<Telemetry>(replay = 1, extraBufferCapacity = 8)
    override val videoFrames = MutableSharedFlow<ByteArray>(extraBufferCapacity = 4)
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

    // Lo que sigue lo escriben los listeners del SDK, cada uno en su hilo, y lo
    // leen los lazos de navegación y el que arma la telemetría, que corren en
    // otros: volátil para que no quede pegado. Sin esto un lazo podía quedarse
    // con lastLat en NaN y hacer `continue` para siempre —el dron reportando
    // posición y la ruta sin comandar una sola velocidad— sin que nada lo avise.
    @Volatile
    private var lastLat = Double.NaN

    @Volatile
    private var lastLon = Double.NaN

    @Volatile
    private var lastAlt = 0.0

    @Volatile
    private var lastBattery = 0.0

    @Volatile
    private var lastHeading = 0.0

    @Volatile
    private var lastSignal = 100

    /**
     * Enlace con el dron. Arranca en true porque el SDK avisa recién cuando el
     * valor cambia: mientras no diga lo contrario, se asume que el enlace está.
     */
    @Volatile
    private var enlaceVivo = true

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

    private val limitadorDeCuadros = LimitadorDeRitmo(CuadroDeVideo.INTERVALO_CUADRO_MS)

    /** Un cuadro crudo del MSDK, ya copiado del buffer que el SDK reusa. */
    private class CuadroCrudo(val datos: ByteArray, val ancho: Int, val alto: Int)

    /**
     * Cola de UN solo lugar entre el hilo del decodificador y el que convierte.
     * Antes cada cuadro se convertía en su propia corrutina sobre un pool
     * multihilo y nada garantizaba el orden: si la conversión de uno tardaba más
     * que los 200 ms que lo separan del siguiente, se emitía el viejo último y
     * la consola pintaba un cuadro atrasado encima del nuevo (y la captura que
     * se adjunta a una alerta podía no ser la que disparó la detección).
     *
     * Con un solo consumidor el orden se preserva, y con DROP_OLDEST el que se
     * pierde cuando el celular se atrasa es el viejo —que es lo que corresponde
     * en video en vivo— en vez de apilarse corrutinas.
     */
    private val cuadrosPorConvertir =
        Channel<CuadroCrudo>(capacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /**
     * Cuadros de la cámara principal. Ojo con este callback: lo llama el
     * decodificador del MSDK en SU hilo y con SU buffer, que reusa para el cuadro
     * siguiente. Por eso acá solo se copia lo justo y la conversión —medio millón
     * de pixeles— se hace en una corrutina aparte: frenar este hilo sería frenar
     * el video entero.
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
            // El stream llega a 30 cuadros por segundo; se quedan 5, que es lo
            // que el contrato manda al Comando Central.
            if (!limitadorDeCuadros.aceptar(System.currentTimeMillis())) return
            val hasta = minOf(offset + length, frameData.size)
            if (offset < 0 || hasta <= offset) return
            val copia = frameData.copyOfRange(offset, hasta)
            cuadrosPorConvertir.trySend(CuadroCrudo(copia, width, height))
        }
    }

    /**
     * Convierte los cuadros de a uno y en orden (ver [cuadrosPorConvertir]).
     *
     * El cuerpo va entero adentro de un runCatching: una excepción sin atrapar
     * en un `launch` no se descarta sola —el SupervisorJob salva al scope, pero
     * el hilo la propaga igual— y se llevaría puesta la app en pleno vuelo. El
     * caso concreto es un OutOfMemoryError reservando el bitmap de 640x360 con
     * el celular ocupado; perder un cuadro de treinta no se nota, perder la app
     * sí.
     */
    private suspend fun convertirCuadros() {
        for (cuadro in cuadrosPorConvertir) {
            runCatching { CuadroDeVideo.nv21AJpeg(cuadro.datos, 0, cuadro.ancho, cuadro.alto) }
                .onSuccess { jpeg -> jpeg?.let { videoFrames.tryEmit(it) } }
                .onFailure { falla -> Log.w(TAG, "Se descartó un cuadro de video", falla) }
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
        // Un solo consumidor de cuadros, y se relanza por si se reconecta
        conversionJob?.cancel()
        conversionJob = scope.launch { convertirCuadros() }
        VirtualStickManager.getInstance().setVirtualStickStateListener(oyenteDeVirtualStick)
        val km = KeyManager.getInstance()

        // Posición del dron → telemetría
        km.listen(KeyTools.createKey(FlightControllerKey.KeyAircraftLocation3D), this) { _, location ->
            if (location != null) {
                lastLat = location.latitude
                lastLon = location.longitude
                lastAlt = location.altitude
                emitTelemetry()
            }
        }
        // Nivel de batería → telemetría
        km.listen(KeyTools.createKey(BatteryKey.KeyChargeRemainingInPercent), this) { _, pct ->
            if (pct != null) {
                lastBattery = pct.toDouble()
                emitTelemetry()
            }
        }
        // Rumbo real de la brújula. El MSDK lo da en -180..180 y el resto del
        // sistema lo usa en 0..360 (norte = 0, este = 90).
        km.listen(KeyTools.createKey(FlightControllerKey.KeyCompassHeading), this) { _, rumbo ->
            if (rumbo != null) lastHeading = (rumbo + 360.0) % 360.0
        }
        // Intensidad del enlace de radio, que es lo que la consola pinta como
        // barritas de señal
        km.listen(KeyTools.createKey(AirLinkKey.KeySignalQuality), this) { _, calidad ->
            if (calidad != null) lastSignal = calidad.coerceIn(0, 100)
        }
        // Enlace con el dron. Cuando se cae hay que DEJAR de emitir telemetría:
        // el watchdog de PatrolManager detecta la pérdida por el silencio —igual
        // que con el dron simulado— y no por un campo del mensaje. Cuando el
        // enlace vuelve, el primer valor de posición reanuda la emisión sola.
        km.listen(KeyTools.createKey(FlightControllerKey.KeyConnection), this) { _, conectado ->
            enlaceVivo = conectado == true
        }

        // Video real: los cuadros de la cámara principal (la del gimbal) en
        // NV21, que es el formato que sale del decodificador sin conversión.
        MediaDataCenter.getInstance().getCameraStreamManager().addFrameListener(
            ComponentIndexType.LEFT_OR_MAIN,
            ICameraStreamManager.FrameFormat.NV21,
            oyenteDeCuadros,
        )
    }

    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) {
        relevarLazo(esMando = false) {
            asegurarVirtualStick()
            var target = fromWaypoint.coerceIn(0, route.waypoints.size - 1)
            while (true) {
                delay(INTERVALO_MANDO_MS) // Virtual Stick requiere comandos a ~10 Hz
                if (lastLat.isNaN()) continue
                val wp = route.waypoints[target]
                val dy = (wp.lat - lastLat) * METERS_PER_DEG_LAT
                val dx = (wp.lon - lastLon) * METERS_PER_DEG_LAT * cos(Math.toRadians(lastLat))
                val dist = hypot(dx, dy)
                if (dist < ARRIVE_THRESHOLD_M) {
                    flightEvents.tryEmit(FlightEvent.WaypointReached(target))
                    target = (target + 1) % route.waypoints.size
                    continue
                }
                val speed = SPEED_MS.coerceAtMost(dist / 2)
                enviarVelocidadTerreno(
                    speed * dy / dist,
                    speed * dx / dist,
                    Math.toDegrees(atan2(dx, dy)),
                )
            }
        }
    }

    override fun hold() {
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
        relevarLazo(esMando = false) {
            asegurarVirtualStick()
            while (true) {
                delay(INTERVALO_MANDO_MS)
                if (lastLat.isNaN()) continue
                val dy = (lat - lastLat) * METERS_PER_DEG_LAT
                val dx = (lon - lastLon) * METERS_PER_DEG_LAT * cos(Math.toRadians(lastLat))
                val dist = hypot(dx, dy)
                if (dist < ARRIVE_THRESHOLD_M) {
                    flightEvents.tryEmit(FlightEvent.GotoArrived)
                    break
                }
                val speed = SPEED_MS.coerceAtMost(dist / 2)
                enviarVelocidadTerreno(
                    speed * dy / dist,
                    speed * dx / dist,
                    Math.toDegrees(atan2(dx, dy)),
                )
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
        relevarLazo(esMando = false) {
            asegurarVirtualStick()
            var angle = 0.0
            while (true) {
                delay(INTERVALO_MANDO_MS)
                if (lastLat.isNaN()) continue
                // Órbita: velocidad tangencial sobre el círculo y nariz apuntando al centro
                angle += (ORBIT_SPEED_MS / radiusM) * (INTERVALO_MANDO_MS / 1_000.0)
                val tLat = centerLat + (radiusM * cos(angle)) / METERS_PER_DEG_LAT
                val tLon = centerLon + (radiusM * sin(angle)) / (METERS_PER_DEG_LAT * cos(Math.toRadians(centerLat)))
                val dy = (tLat - lastLat) * METERS_PER_DEG_LAT
                val dx = (tLon - lastLon) * METERS_PER_DEG_LAT * cos(Math.toRadians(lastLat))
                val dist = hypot(dx, dy).coerceAtLeast(0.1)
                val speed = ORBIT_SPEED_MS.coerceAtMost(dist)
                // Por Geo y no a mano: la cuenta anterior restaba grados de
                // longitud contra grados de latitud sin escalar por cos(lat), y
                // la nariz —con ella la cámara— no quedaba apuntando al objetivo
                // que se está orbitando.
                val yawToCenter = Geo.rumboHacia(lastLat, lastLon, centerLat, centerLon)
                enviarVelocidadTerreno(speed * dy / dist, speed * dx / dist, yawToCenter)
            }
        }
    }

    override fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) {
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
        // Sin lazo nuevo: el regreso a base lo maneja el propio dron.
        synchronized(relevoDeLazo) {
            mandoActivo = false
            navigationJob?.cancel()
            navigationJob = null
        }
        KeyManager.getInstance().performAction(
            KeyTools.createKey(FlightControllerKey.KeyStartGoHome),
            null,
        )
        // TODO(hardware): escuchar KeyIsFlying/KeyAreMotorsOn para emitir
        // FlightEvent.ArrivedHome cuando el dron aterriza.
    }

    /**
     * El orden de acá abajo es la mitad del arreglo. Antes se cancelaba el lazo
     * sin esperarlo y se deshabilitaba el Virtual Stick enseguida: una vuelta
     * que ya había pasado el `delay` entraba a `enviarVelocidadCuerpo`, llamaba
     * a [asegurarVirtualStick] y lo volvía a habilitar DESPUÉS del disable. El
     * Virtual Stick quedaba prendido con la app cerrada y el operador no
     * recuperaba el dron con las palancas del RC-N3.
     */
    override fun disconnect() {
        // 1) Se cierra la puerta: ningún lazo puede volver a habilitarlo.
        desconectado = true
        // 2) Se espera a que el lazo muera de verdad (con tope: esto lo llama la
        //    pantalla al cerrarse y no puede quedarse colgado).
        val lazo = synchronized(relevoDeLazo) {
            mandoActivo = false
            navigationJob.also { navigationJob = null }
        }
        runBlocking { withTimeoutOrNull(ESPERA_CORTE_MS) { lazo?.cancelAndJoin() } }
        // 3) Se corta todo lo demás que sigue emitiendo: sin esto las
        //    conversiones ya lanzadas seguían publicando cuadros de un dron del
        //    que la app ya se despidió.
        scope.coroutineContext.cancelChildren()
        conversionJob = null
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
            Telemetry(lastLat, lastLon, lastAlt, lastBattery, lastSignal, lastHeading, System.currentTimeMillis()),
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

    /**
     * Deja constancia de un problema del dron. Va al log del dispositivo y, sobre
     * todo, al Comando Central por [flightEvents]: un rechazo mudo es lo peor que
     * puede pasar en vuelo —el operador mueve la palanca, el dron no se mueve y
     * no hay una sola pista de por qué—, y este archivo no tiene registro local
     * propio.
     */
    private fun avisar(motivo: String) {
        Log.w(TAG, motivo)
        flightEvents.tryEmit(FlightEvent.Problema(motivo))
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
     */
    private fun asegurarVirtualStick() {
        // La app ya se despidió del dron: habilitarlo acá sería dejárselo
        // prendido al operador (ver disconnect()).
        if (desconectado) return
        if (!virtualStickListo.compareAndSet(false, true)) return
        val vs = VirtualStickManager.getInstance()
        vs.enableVirtualStick(
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    // El modo avanzado es el único que acepta velocidades y
                    // marco de coordenadas; sin esto sendVirtualStickAdvancedParam
                    // no tiene efecto.
                    vs.setVirtualStickAdvancedModeEnabled(true)
                    // Si la app se cerró mientras el dron todavía lo aceptaba,
                    // esta habilitación llegó tarde y hay que deshacerla.
                    if (desconectado) apagarVirtualStick()
                }

                override fun onFailure(error: IDJIError) {
                    // Quedó sin habilitar: se libera la marca para que el próximo
                    // comando lo reintente, en vez de comandar al vacío para siempre.
                    virtualStickListo.set(false)
                    // Y se avisa: sin esto el dron ignoraba la consola en
                    // silencio, porque sendVirtualStickAdvancedParam descarta el
                    // parámetro cuando el modo avanzado no está prendido.
                    avisar("el dron no aceptó el mando virtual (${error.description()}): la consola no lo va a poder mover")
                }
            },
        )
    }

    /** Le devuelve el mando al palito físico del RC-N3. */
    private fun apagarVirtualStick() {
        if (!virtualStickListo.compareAndSet(true, false)) return
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
     * coordenadas, no relativo al dron.
     */
    private fun enviarVelocidadTerreno(vNorteMs: Double, vEsteMs: Double, rumboGrados: Double) {
        asegurarVirtualStick()
        // En VELOCITY, "pitch" es la velocidad sobre el eje X y "roll" sobre el
        // Y; con FlightCoordinateSystem.GROUND esos ejes son el norte y el este.
        VirtualStickManager.getInstance().sendVirtualStickAdvancedParam(
            VirtualStickFlightControlParam(
                vNorteMs,
                vEsteMs,
                rumboGrados,
                0.0, // vertical en cero: mantiene la altura
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
        VirtualStickManager.getInstance().sendVirtualStickAdvancedParam(
            VirtualStickFlightControlParam(
                v.adelanteMs,
                v.derechaMs,
                v.giroGradosS,
                v.subidaMs,
                VerticalControlMode.VELOCITY,
                RollPitchControlMode.VELOCITY,
                YawControlMode.ANGULAR_VELOCITY,
                FlightCoordinateSystem.BODY,
            ),
        )
    }

    private companion object {
        const val METERS_PER_DEG_LAT = 111_320.0
        const val SPEED_MS = 8.0
        const val ORBIT_SPEED_MS = 5.0
        const val ARRIVE_THRESHOLD_M = 4.0

        /** El Virtual Stick se sostiene con comandos a 10 Hz. */
        const val INTERVALO_MANDO_MS = 100L

        /**
         * Tope de lo que [disconnect] espera a que muera el lazo de comandos. El
         * lazo duerme en un `delay` de 100 ms, así que en la práctica corta al
         * toque; el tope está para que cerrar la app no se cuelgue nunca.
         */
        const val ESPERA_CORTE_MS = 500L

        const val TAG = "DjiDroneController"
    }
}
