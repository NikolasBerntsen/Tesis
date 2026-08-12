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

/**
 * Ficha del dron. El [hash] es su identificador en todo el protocolo (el
 * `droneId` de los mensajes): sale del QR pegado en el dron, nunca lo declara
 * la app.
 */
data class DroneProfile(
    val hash: String,
    val displayName: String,
    val model: String = "",
    val base: DroneBase? = null,
)

/**
 * Sesión del operador de campo (POST /api/auth/login). Es efímera a propósito:
 * [expiresIn] son los segundos que le quedan, para la cuenta regresiva.
 */
data class SesionOperador(
    val username: String,
    val role: String,
    val expiresIn: Long,
)

/** Resultado de POST /api/drones/pair: el token de máquina del dron y su ficha. */
data class Emparejamiento(
    val token: String,
    val drone: DroneProfile,
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
