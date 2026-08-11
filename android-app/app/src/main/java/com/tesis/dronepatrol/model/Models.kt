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
    /** Intensidad del enlace RC 0..100 (baja con la distancia a la base). */
    val signalPct: Int,
    val ts: Long,
)

data class DroneBase(val name: String, val lat: Double, val lon: Double)

/** Ficha del dron que devuelve GET /api/me. */
data class DroneProfile(
    val droneId: String,
    val displayName: String,
    val base: DroneBase?,
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
