package com.tesis.dronepatrol.dji

import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import dji.sdk.keyvalue.key.BatteryKey
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.KeyTools
import dji.v5.manager.KeyManager
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
 * ESQUELETO de la integración real con el DJI Mini 4 Pro vía MSDK v5.
 *
 * Importante (limitación del producto, no de este código): el Mini 4 Pro NO
 * soporta las misiones de waypoints nativas del MSDK (WaypointMissionManager es
 * solo Enterprise). El patrullaje autónomo se implementa con Virtual Stick:
 * un lazo que envía velocidades hacia el waypoint objetivo, igual que hace el
 * simulador. Este archivo compila bajo el flavor "dji" y marca con TODO los
 * puntos que requieren ajuste/prueba con el hardware real.
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
    private var lastHeading = 0.0

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
        // TODO(hardware): escuchar FlightControllerKey.KeyConnection para cortar
        // la emisión de telemetría cuando se pierde el enlace RC (el watchdog de
        // PatrolManager depende de ese silencio para detectar la pérdida).

        // TODO(hardware): video real. Con MediaDataCenter.getInstance()
        // .cameraStreamManager añadir un frame listener NV21, convertir a JPEG
        // (YuvImage.compressToJpeg) y emitir en videoFrames a ~2 fps.
    }

    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) {
        navigationJob?.cancel()
        navigationJob = scope.launch {
            // TODO(hardware): VirtualStickManager.getInstance().enableVirtualStick(...)
            // y habilitar el modo avanzado antes de comandar velocidades.
            var target = fromWaypoint.coerceIn(0, route.waypoints.size - 1)
            while (true) {
                delay(100) // Virtual Stick requiere comandos a ~10 Hz
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
                val vNorth = speed * dy / dist
                val vEast = speed * dx / dist
                lastHeading = (Math.toDegrees(atan2(vEast, vNorth)) + 360.0) % 360.0
                sendVelocity(vNorth, vEast, yawDeg = Math.toDegrees(atan2(vEast, vNorth)))
            }
        }
    }

    override fun hold() {
        navigationJob?.cancel()
        // TODO(hardware): mantener Virtual Stick activo enviando velocidad cero
        // a ~10 Hz para que el dron quede en vuelo estacionario donde está.
    }

    override fun gotoPoint(lat: Double, lon: Double) {
        navigationJob?.cancel()
        navigationJob = scope.launch {
            // TODO(hardware): habilitar Virtual Stick (modo avanzado) antes de
            // comandar velocidades, igual que en startRoute.
            while (true) {
                delay(100)
                if (lastLat.isNaN()) continue
                val dy = (lat - lastLat) * METERS_PER_DEG_LAT
                val dx = (lon - lastLon) * METERS_PER_DEG_LAT * cos(Math.toRadians(lastLat))
                val dist = hypot(dx, dy)
                if (dist < ARRIVE_THRESHOLD_M) {
                    flightEvents.tryEmit(FlightEvent.GotoArrived)
                    break
                }
                val speed = SPEED_MS.coerceAtMost(dist / 2)
                val vNorth = speed * dy / dist
                val vEast = speed * dx / dist
                lastHeading = (Math.toDegrees(atan2(vEast, vNorth)) + 360.0) % 360.0
                sendVelocity(vNorth, vEast, yawDeg = Math.toDegrees(atan2(vEast, vNorth)))
            }
            // Llegó: queda en vuelo estacionario.
            // TODO(hardware): sostener velocidad cero como en hold().
        }
    }

    override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double) {
        navigationJob?.cancel()
        navigationJob = scope.launch {
            var angle = 0.0
            while (true) {
                delay(100)
                if (lastLat.isNaN()) continue
                // Órbita: velocidad tangencial sobre el círculo y nariz apuntando al centro
                angle += (ORBIT_SPEED_MS / radiusM) * 0.1
                val tLat = centerLat + (radiusM * cos(angle)) / METERS_PER_DEG_LAT
                val tLon = centerLon + (radiusM * sin(angle)) / (METERS_PER_DEG_LAT * cos(Math.toRadians(centerLat)))
                val dy = (tLat - lastLat) * METERS_PER_DEG_LAT
                val dx = (tLon - lastLon) * METERS_PER_DEG_LAT * cos(Math.toRadians(lastLat))
                val dist = hypot(dx, dy).coerceAtLeast(0.1)
                val speed = ORBIT_SPEED_MS.coerceAtMost(dist)
                val yawToCenter = Math.toDegrees(atan2(centerLon - lastLon, centerLat - lastLat))
                sendVelocity(speed * dy / dist, speed * dx / dist, yawToCenter)
            }
        }
    }

    override fun returnHome() {
        navigationJob?.cancel()
        KeyManager.getInstance().performAction(
            KeyTools.createKey(FlightControllerKey.KeyStartGoHome),
            null,
        )
        // TODO(hardware): escuchar KeyIsFlying/KeyAreMotorsOn para emitir
        // FlightEvent.ArrivedHome cuando el dron aterriza.
    }

    override fun disconnect() {
        navigationJob?.cancel()
        KeyManager.getInstance().cancelListen(this)
    }

    private fun emitTelemetry() {
        if (!lastLat.isNaN()) {
            // TODO(hardware): leer la intensidad real del enlace con
            // KeyLinkQuality / KeySignalQuality en lugar de asumir 100.
            // TODO(hardware): leer el rumbo real de la brújula con
            // FlightControllerKey.KeyCompassHeading en vez del rumbo comandado.
            telemetry.tryEmit(Telemetry(lastLat, lastLon, lastAlt, lastBattery, 100, lastHeading, System.currentTimeMillis()))
        }
    }

    @Suppress("UNUSED_PARAMETER")
    private fun sendVelocity(vNorthMs: Double, vEastMs: Double, yawDeg: Double) {
        // TODO(hardware): mapear a VirtualStickFlightControlParam con
        // RollPitchControlMode.VELOCITY + YawControlMode.ANGLE en coordenadas
        // GROUND y enviarlo con VirtualStickManager.sendVirtualStickAdvancedParam.
    }

    private companion object {
        const val METERS_PER_DEG_LAT = 111_320.0
        const val SPEED_MS = 8.0
        const val ORBIT_SPEED_MS = 5.0
        const val ARRIVE_THRESHOLD_M = 4.0
    }
}
