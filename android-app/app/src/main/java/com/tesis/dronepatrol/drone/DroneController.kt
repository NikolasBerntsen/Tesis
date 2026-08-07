package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import kotlinx.coroutines.flow.SharedFlow

/**
 * Abstracción del dron. La lógica de patrullaje (PatrolManager) habla solo con
 * esta interfaz; detrás puede estar el simulador (flavor mock) o el DJI Mini 4
 * Pro vía MSDK v5 (flavor dji).
 */
interface DroneController {
    /** Telemetría a ~2 Hz. Si el enlace RC se corta, este flujo se silencia. */
    val telemetry: SharedFlow<Telemetry>

    /** Frames JPEG del video del dron (~2 fps en el MVP). */
    val videoFrames: SharedFlow<ByteArray>

    val flightEvents: SharedFlow<FlightEvent>

    fun connect()

    /** Vuela la ruta en loop, empezando por el waypoint [fromWaypoint]. */
    fun startRoute(route: PatrolRoute, fromWaypoint: Int)

    /** Orbita alrededor del punto dado (modo seguimiento de objetivo). */
    fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double)

    fun returnHome()

    fun disconnect()
}
