package com.tesis.dronepatrol.model

data class Waypoint(val lat: Double, val lon: Double, val alt: Double)

data class PatrolRoute(
    val id: Int,
    val name: String,
    val waypoints: List<Waypoint>,
)

data class Telemetry(
    val lat: Double,
    val lon: Double,
    val altM: Double,
    val batteryPct: Double,
    val ts: Long,
)

enum class PatrolState {
    IDLE,
    PATROLLING,
    ORBITING,
    RETURNING_HOME_SIGNAL,
    RETURNING_HOME_BATTERY,
    LANDED,
}

sealed class FlightEvent {
    /** El dron pasó por el waypoint [index] de la ruta activa. */
    data class WaypointReached(val index: Int) : FlightEvent()
    object ArrivedHome : FlightEvent()
}
