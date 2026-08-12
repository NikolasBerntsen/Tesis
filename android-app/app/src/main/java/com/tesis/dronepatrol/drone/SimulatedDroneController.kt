package com.tesis.dronepatrol.drone

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch

/**
 * Dron simulado: reproduce el comportamiento del Mini 4 Pro que le importa a la
 * lógica de patrullaje (vuelo por waypoints, órbita, RTH, drenaje de batería,
 * failsafe por pérdida de enlace RC) sin necesitar hardware.
 */
class SimulatedDroneController : DroneController {

    private companion object {
        // El Obelisco, sobre la 9 de Julio: el mismo punto en el que abren los
        // mapas de la consola y en el que están las bases de demostración.
        const val HOME_LAT = -34.6037
        const val HOME_LON = -58.3816
        const val SPEED_MS = 12.0
        const val TICK_MS = 500L
        const val FRAME_MS = 500L // ~2 fps
        const val BATTERY_DRAIN_PER_TICK = 0.02 // % por tick volando
        // Igual que el dron real: si pierde el enlace RC por más de este tiempo,
        // el propio dron inicia RTH (failsafe), sin intervención de la app.
        const val FAILSAFE_TIMEOUT_MS = 6_000L
        const val ARRIVE_THRESHOLD_M = 6.0
        const val METERS_PER_DEG_LAT = 111_320.0
        // Alcance del enlace RC: a esta distancia de la base la señal ya está al mínimo
        const val SIGNAL_RANGE_M = 1_200.0
        const val SIGNAL_MIN_PCT = 10
    }

    private enum class Mode { IDLE, FLY_ROUTE, ORBIT, RTH, HOLD, GOTO }

    override val telemetry = MutableSharedFlow<Telemetry>(replay = 1, extraBufferCapacity = 8)
    override val videoFrames = MutableSharedFlow<ByteArray>(extraBufferCapacity = 4)
    override val flightEvents = MutableSharedFlow<FlightEvent>(extraBufferCapacity = 8)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var loops: Job? = null

    // El modo lo escribe el hilo que comanda (hold/gotoPoint/...) y lo lee el
    // lazo de vuelo: volátil para que el cambio se vea enseguida.
    @Volatile
    private var mode = Mode.IDLE
    private var homeLat = HOME_LAT
    private var homeLon = HOME_LON
    private var lat = HOME_LAT
    private var lon = HOME_LON
    private var battery = 100.0
    private var route: PatrolRoute? = null
    private var targetWaypoint = 0
    private var orbitCenterLat = 0.0
    private var orbitCenterLon = 0.0
    private var orbitRadiusM = 30.0
    private var orbitAngle = 0.0
    private var gotoLat = 0.0
    private var gotoLon = 0.0
    // Rumbo hacia el objetivo mientras se mueve; estacionario conserva el último
    private var heading = 0.0

    /** Mientras es true no llega telemetría ni video a la app (enlace RC cortado). */
    @Volatile
    var signalLost = false
        private set
    private var signalLostAt = 0L

    fun setSignalLost(lost: Boolean) {
        signalLost = lost
        if (lost) signalLostAt = System.currentTimeMillis()
    }

    fun forceLowBattery() {
        battery = 24.0
    }

    fun rechargeBattery() {
        battery = 100.0
    }

    /** Base real del dron que inició sesión (la simulación arranca y vuelve ahí). */
    fun setHome(lat: Double, lon: Double) {
        homeLat = lat
        homeLon = lon
        if (mode == Mode.IDLE) {
            this.lat = lat
            this.lon = lon
        }
    }

    override fun connect() {
        if (loops != null) return
        lat = homeLat
        lon = homeLon
        battery = 100.0
        mode = Mode.IDLE
        loops = scope.launch {
            launch { flightLoop() }
            launch { frameLoop() }
        }
    }

    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) {
        this.route = route
        targetWaypoint = fromWaypoint.coerceIn(0, route.waypoints.size - 1)
        mode = Mode.FLY_ROUTE
    }

    override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double) {
        orbitCenterLat = centerLat
        orbitCenterLon = centerLon
        orbitRadiusM = radiusM
        orbitAngle = 0.0
        mode = Mode.ORBIT
    }

    override fun hold() {
        mode = Mode.HOLD
    }

    override fun gotoPoint(lat: Double, lon: Double) {
        gotoLat = lat
        gotoLon = lon
        mode = Mode.GOTO
    }

    override fun returnHome() {
        mode = Mode.RTH
    }

    override fun disconnect() {
        scope.coroutineContext.cancelChildren()
        loops = null
        mode = Mode.IDLE
    }

    private suspend fun flightLoop() {
        while (true) {
            delay(TICK_MS)
            val dt = TICK_MS / 1000.0

            // Failsafe del propio dron ante pérdida prolongada del enlace RC
            if (signalLost && mode != Mode.RTH && mode != Mode.IDLE &&
                System.currentTimeMillis() - signalLostAt > FAILSAFE_TIMEOUT_MS
            ) {
                mode = Mode.RTH
            }

            when (mode) {
                Mode.FLY_ROUTE -> {
                    val wp = route?.waypoints?.getOrNull(targetWaypoint) ?: continue
                    if (moveToward(wp.lat, wp.lon, dt)) {
                        emitEvent(FlightEvent.WaypointReached(targetWaypoint))
                        targetWaypoint = (targetWaypoint + 1) % route!!.waypoints.size
                    }
                    drainBattery()
                }
                Mode.ORBIT -> {
                    // Círculo alrededor del objetivo a velocidad constante
                    orbitAngle += (SPEED_MS / orbitRadiusM) * dt * 0.5
                    lat = orbitCenterLat + (orbitRadiusM * cos(orbitAngle)) / METERS_PER_DEG_LAT
                    lon = orbitCenterLon + (orbitRadiusM * sin(orbitAngle)) / metersPerDegLon()
                    // En órbita la cámara mira al objetivo
                    heading = bearingTo(orbitCenterLat, orbitCenterLon)
                    drainBattery()
                }
                Mode.GOTO -> {
                    if (moveToward(gotoLat, gotoLon, dt)) {
                        mode = Mode.HOLD
                        emitEvent(FlightEvent.GotoArrived)
                    }
                    drainBattery()
                }
                Mode.HOLD -> drainBattery() // vuelo estacionario: gasta batería igual
                Mode.RTH -> {
                    if (moveToward(homeLat, homeLon, dt)) {
                        mode = Mode.IDLE
                        emitEvent(FlightEvent.ArrivedHome)
                    }
                    drainBattery()
                }
                Mode.IDLE -> Unit
            }

            if (!signalLost) {
                telemetry.tryEmit(Telemetry(lat, lon, 40.0, battery, signalPct(), heading, System.currentTimeMillis()))
            }
        }
    }

    /** Avanza hacia el punto dado; devuelve true si llegó. */
    private fun moveToward(tLat: Double, tLon: Double, dt: Double): Boolean {
        val dy = (tLat - lat) * METERS_PER_DEG_LAT
        val dx = (tLon - lon) * metersPerDegLon()
        val dist = hypot(dx, dy)
        if (dist < ARRIVE_THRESHOLD_M) return true
        heading = bearingTo(tLat, tLon)
        val step = (SPEED_MS * dt).coerceAtMost(dist)
        lat += (dy / dist) * step / METERS_PER_DEG_LAT
        lon += (dx / dist) * step / metersPerDegLon()
        return false
    }

    /** Rumbo 0..360° desde la posición actual hacia el punto dado (norte = 0, este = 90). */
    private fun bearingTo(tLat: Double, tLon: Double): Double {
        val dy = (tLat - lat) * METERS_PER_DEG_LAT
        val dx = (tLon - lon) * metersPerDegLon()
        return (Math.toDegrees(atan2(dx, dy)) + 360.0) % 360.0
    }

    private fun metersPerDegLon() = METERS_PER_DEG_LAT * cos(Math.toRadians(lat))

    /** La señal se degrada de forma lineal con la distancia a la base. */
    private fun signalPct(): Int {
        val dy = (lat - homeLat) * METERS_PER_DEG_LAT
        val dx = (lon - homeLon) * metersPerDegLon()
        val pct = 100 * (1 - hypot(dx, dy) / SIGNAL_RANGE_M)
        return pct.toInt().coerceIn(SIGNAL_MIN_PCT, 100)
    }

    private fun drainBattery() {
        battery = (battery - BATTERY_DRAIN_PER_TICK).coerceAtLeast(0.0)
    }

    private fun emitEvent(e: FlightEvent) {
        flightEvents.tryEmit(e)
    }

    // ---- Video simulado ----

    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    private suspend fun frameLoop() {
        val paint = Paint().apply { isAntiAlias = true }
        var t = 0.0
        while (true) {
            delay(FRAME_MS)
            if (signalLost) continue // el video también viaja por el enlace RC
            t += 0.35
            val bmp = Bitmap.createBitmap(640, 360, Bitmap.Config.ARGB_8888)
            val c = Canvas(bmp)
            c.drawColor(Color.rgb(24, 46, 32)) // "campo" visto desde arriba
            paint.color = Color.rgb(40, 70, 50)
            for (i in 0..8) c.drawLine(i * 80f, 0f, i * 80f, 360f, paint)
            for (i in 0..5) c.drawLine(0f, i * 72f, 640f, i * 72f, paint)
            // Un "objeto" que deambula, para que el software de detección tenga algo que mirar
            paint.color = Color.WHITE
            val ox = 320f + (220 * sin(t * 0.7)).toFloat()
            val oy = 180f + (120 * cos(t * 0.4)).toFloat()
            c.drawRect(ox, oy, ox + 14f, oy + 28f, paint)
            paint.textSize = 18f
            c.drawText("DRONE SIM  ${timeFmt.format(Date())}", 12f, 24f, paint)
            c.drawText("bat %.0f%%  %s".format(battery, mode.name), 12f, 48f, paint)
            c.drawText("pos %.5f, %.5f".format(lat, lon), 12f, 348f, paint)

            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 60, out)
            bmp.recycle()
            videoFrames.tryEmit(out.toByteArray())
        }
    }
}
