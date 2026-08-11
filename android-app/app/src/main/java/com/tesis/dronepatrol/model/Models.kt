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
    /** Rumbo 0..360° hacia donde mira la cámara. */
    val heading: Double,
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
    /** Patrulla interrumpida por el operador: vuelo estacionario. */
    PAUSED,
    /** Control manual desde el Comando Central. */
    MANUAL,
    /** Desvío forzado hacia un nodo puntual. */
    FORCED,
}

sealed class FlightEvent {
    /** El dron pasó por el waypoint [index] de la ruta activa. */
    data class WaypointReached(val index: Int) : FlightEvent()
    object ArrivedHome : FlightEvent()
    /** Llegó al punto pedido con gotoPoint y quedó en vuelo estacionario. */
    object GotoArrived : FlightEvent()
}
