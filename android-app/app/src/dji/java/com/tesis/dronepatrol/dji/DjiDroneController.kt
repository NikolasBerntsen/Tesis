package com.tesis.dronepatrol.dji

import com.tesis.dronepatrol.drone.CuadroDeVideo
import com.tesis.dronepatrol.drone.DroneController
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
import dji.sdk.keyvalue.value.flightcontroller.FlightCoordinateSystem
import dji.sdk.keyvalue.value.flightcontroller.RollPitchControlMode
import dji.sdk.keyvalue.value.flightcontroller.VerticalControlMode
import dji.sdk.keyvalue.value.flightcontroller.VirtualStickFlightControlParam
import dji.sdk.keyvalue.value.flightcontroller.YawControlMode
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.KeyManager
import dji.v5.manager.aircraft.virtualstick.VirtualStickManager
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch

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
    private var navigationJob: Job? = null

    private var lastLat = Double.NaN
    private var lastLon = Double.NaN
    private var lastAlt = 0.0
    private var lastBattery = 0.0

    // Lo que sigue lo escriben los listeners del SDK, cada uno en su hilo, y lo
    // lee el que arma la telemetría: volátil para que no quede pegado.
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

    /** true mientras el lazo de [navigationJob] sea el del mando manual. */
    @Volatile
    private var mandoActivo = false

    /** El Virtual Stick se habilita una sola vez; esto es lo que lo recuerda. */
    private val virtualStickListo = AtomicBoolean(false)

    private val limitadorDeCuadros = LimitadorDeRitmo(CuadroDeVideo.INTERVALO_CUADRO_MS)

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
            scope.launch(Dispatchers.Default) {
                CuadroDeVideo.nv21AJpeg(copia, 0, width, height)?.let { videoFrames.tryEmit(it) }
            }
        }
    }

    override fun connect() {
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
        cortarNavegacion()
        navigationJob = scope.launch {
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
        cortarNavegacion()
        navigationJob = scope.launch {
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
        cortarNavegacion()
        navigationJob = scope.launch {
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
        cortarNavegacion()
        navigationJob = scope.launch {
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
                val yawToCenter = Math.toDegrees(atan2(centerLon - lastLon, centerLat - lastLat))
                enviarVelocidadTerreno(speed * dy / dist, speed * dx / dist, yawToCenter)
            }
        }
    }

    override fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) {
        // El lazo lee estos ejes en cada vuelta: un mensaje nuevo solo los pisa.
        ejesMando = MandoVirtual.velocidades(pitch, roll, yaw, throttle)
        if (mandoActivo && navigationJob?.isActive == true) return
        cortarNavegacion()
        mandoActivo = true
        navigationJob = scope.launch {
            asegurarVirtualStick()
            // El lazo sigue a 10 Hz aunque los ejes estén en cero, por lo mismo
            // que hold(): el Virtual Stick se sostiene comandando.
            while (true) {
                enviarVelocidadCuerpo(ejesMando)
                delay(INTERVALO_MANDO_MS)
            }
        }
    }

    override fun returnHome() {
        cortarNavegacion()
        KeyManager.getInstance().performAction(
            KeyTools.createKey(FlightControllerKey.KeyStartGoHome),
            null,
        )
        // TODO(hardware): escuchar KeyIsFlying/KeyAreMotorsOn para emitir
        // FlightEvent.ArrivedHome cuando el dron aterriza.
    }

    override fun disconnect() {
        cortarNavegacion()
        MediaDataCenter.getInstance().getCameraStreamManager().removeFrameListener(oyenteDeCuadros)
        KeyManager.getInstance().cancelListen(this)
        // Se le devuelve el mando al palito físico del RC-N3: si el Virtual
        // Stick quedara habilitado, el operador no recuperaría el control del
        // dron al cerrar la app.
        if (virtualStickListo.compareAndSet(true, false)) {
            VirtualStickManager.getInstance().disableVirtualStick(
                object : CommonCallbacks.CompletionCallback {
                    override fun onSuccess() = Unit

                    override fun onFailure(error: IDJIError) = Unit
                },
            )
        }
    }

    private fun emitTelemetry() {
        // Sin enlace no se emite nada: ese silencio es lo que le avisa al
        // watchdog de PatrolManager que se perdió el dron.
        if (!enlaceVivo || lastLat.isNaN()) return
        telemetry.tryEmit(
            Telemetry(lastLat, lastLon, lastAlt, lastBattery, lastSignal, lastHeading, System.currentTimeMillis()),
        )
    }

    /** Corta el lazo de comandos en curso, sea de navegación o de mando manual. */
    private fun cortarNavegacion() {
        mandoActivo = false
        navigationJob?.cancel()
    }

    /**
     * Habilita el Virtual Stick una sola vez. Es idempotente porque lo llaman
     * todos los caminos que comandan velocidades (ruta, goto, órbita,
     * estacionario y mando manual), y pedírselo de nuevo al SDK diez veces por
     * segundo sería pelearse con él.
     *
     * La habilitación es asíncrona: los primeros comandos pueden caer mientras
     * el dron todavía la está aceptando y se pierden, pero como se manda a 10 Hz
     * el siguiente llega enseguida.
     */
    private fun asegurarVirtualStick() {
        if (!virtualStickListo.compareAndSet(false, true)) return
        val vs = VirtualStickManager.getInstance()
        vs.enableVirtualStick(
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    // El modo avanzado es el único que acepta velocidades y
                    // marco de coordenadas; sin esto sendVirtualStickAdvancedParam
                    // no tiene efecto.
                    vs.setVirtualStickAdvancedModeEnabled(true)
                }

                override fun onFailure(error: IDJIError) {
                    // Quedó sin habilitar: se libera la marca para que el próximo
                    // comando lo reintente, en vez de comandar al vacío para siempre.
                    virtualStickListo.set(false)
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
    }
}
