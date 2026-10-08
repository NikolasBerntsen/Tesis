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

/**
 * Lo que la app sabe del aparato más allá de la telemetría de vuelo: si hay
 * enlace con él, si está en el aire, si tiene GPS y punto de retorno. Con el
 * dron real lo arman el SDK y las llaves del controlador de vuelo; el simulado
 * lo inventa. Es lo que la pantalla de operación muestra arriba de todo y lo que
 * decide si se puede despegar.
 */
data class EstadoDelDron(
    /** El SDK está registrado y listo (con el simulado, siempre). */
    val sdkListo: Boolean,
    /** Hay enlace con la aeronave (control conectado al teléfono y dron prendido). */
    val conectado: Boolean,
    /** Nombre del modelo que informa el SDK; "Simulado" en el flavor mock. */
    val modelo: String,
    val enVuelo: Boolean,
    /** Satélites GPS en uso; menos de [SATELITES_MINIMOS] no alcanza para una ruta. */
    val satelites: Int,
    /** El dron registró su punto de retorno: sin él no hay regreso a base posible. */
    val baseFijada: Boolean,
    /** Qué falta o qué pasa, redactado para el operador; vacío si está todo bien. */
    val detalle: String = "",
) {
    /** Todo lo que hace falta para que la app ordene un despegue. */
    val listoParaDespegar: Boolean
        get() = sdkListo && conectado && baseFijada && satelites >= SATELITES_MINIMOS

    companion object {
        /** Con menos satélites el GPS del Mini 4 Pro no fija bien el punto de retorno. */
        const val SATELITES_MINIMOS = 8

        /** Punto de partida: nada conectado todavía. */
        val DESCONOCIDO = EstadoDelDron(
            sdkListo = false,
            conectado = false,
            modelo = "",
            enVuelo = false,
            satelites = 0,
            baseFijada = false,
            detalle = "Esperando al dron",
        )
    }
}

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
    /** Vuelve a la base por orden del operador de campo desde la app. */
    RETURNING_HOME,
}

sealed class FlightEvent {
    /** El dron pasó por el waypoint [index] de la ruta activa. */
    data class WaypointReached(val index: Int) : FlightEvent()
    /** Terminó un regreso a base: el dron está en el suelo, en la base. */
    object ArrivedHome : FlightEvent()
    /** Llegó al punto pedido con gotoPoint y quedó en vuelo estacionario. */
    object GotoArrived : FlightEvent()

    /** Arrancó la secuencia de despegue (motores, salto a 1,2 m, subida a la altura de trabajo). */
    object Despegando : FlightEvent()

    /** El despegue terminó: el dron está a la altura de trabajo y empieza la orden que lo pidió. */
    object EnElAire : FlightEvent()

    /** Aterrizó donde estaba (orden de aterrizar, no un regreso a base). */
    object Aterrizado : FlightEvent()

    /**
     * El dron —o su SDK— rechazó una orden. Existe porque un rechazo mudo es lo
     * peor que puede pasar en vuelo: el operador mueve la palanca, el dron no se
     * mueve y no hay una sola pista de por qué. PatrolManager lo reporta al
     * Comando Central para que quede en el registro de la salida.
     */
    data class Problema(val motivo: String) : FlightEvent()
}
