package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * Dron de mentira que anota TODAS las órdenes que recibe, en orden.
 *
 * Existe porque el dron simulado no alcanza para las pruebas del mando: con él
 * se puede ver dónde termina el dron, pero no QUÉ se le ordenó ni cuándo, y la
 * diferencia entre "quedó quieto porque se lo frenó al salir de MANUAL" y "quedó
 * quieto porque saltó el watchdog un segundo y medio más tarde" es justamente lo
 * que hay que poder distinguir.
 *
 * La telemetría la empuja el test: dejar de empujarla es el corte del enlace de
 * radio con el dron, igual que en el campo.
 */
internal class DronEspia : DroneController {

    private val telemetria = MutableSharedFlow<Telemetry>(replay = 1, extraBufferCapacity = 8)
    override val telemetry: SharedFlow<Telemetry> get() = telemetria
    override val videoFrames = MutableSharedFlow<ByteArray>(extraBufferCapacity = 4)
    override val flightEvents = MutableSharedFlow<FlightEvent>(extraBufferCapacity = 8)

    /** Cada orden como texto, que es lo que los tests comparan. */
    private val recibidas = mutableListOf<String>()

    val ordenes: List<String> get() = synchronized(recibidas) { recibidas.toList() }

    val ultimaOrden: String get() = synchronized(recibidas) { recibidas.lastOrNull() ?: "ninguna" }

    /**
     * Órdenes que dejan al dron quieto donde está: el vuelo estacionario y el
     * mando con los cuatro ejes en cero.
     */
    fun laUltimaOrdenLoDejaQuieto(): Boolean = ultimaOrden == "hold" || ultimaOrden == "stick(0.0, 0.0, 0.0, 0.0)"

    suspend fun emitirTelemetria(
        lat: Double = -34.6037,
        lon: Double = -58.3816,
        bateria: Double = 100.0,
    ) {
        telemetria.emit(Telemetry(lat, lon, 40.0, bateria, 90, 0.0, System.currentTimeMillis()))
    }

    /**
     * Gancho que corre al recibir cada orden, ANTES de anotarla. Los tests de
     * carrera lo usan para pararse en el medio de una orden y soltar al otro hilo
     * justo ahí: la ventana entre "leo el estado" y "le hablo al dron" es de
     * microsegundos, así que sin un punto de parada un test de esa carrera no
     * podría fallar de forma repetible — y un test que no puede fallar no prueba
     * nada.
     *
     * Se invoca FUERA del candado de [recibidas]: el gancho bloquea a propósito, y
     * con el candado tomado dejaría colgado al hilo que viene a leer las órdenes.
     */
    @Volatile
    var alRecibirLaOrden: ((String) -> Unit)? = null

    private fun anotar(orden: String) {
        alRecibirLaOrden?.invoke(orden)
        synchronized(recibidas) { recibidas += orden }
    }

    override fun connect() = anotar("connect")
    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) = anotar("startRoute(${route.id}, $fromWaypoint)")
    override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double) = anotar("startOrbit")
    override fun hold() = anotar("hold")
    override fun gotoPoint(lat: Double, lon: Double) = anotar("gotoPoint")
    override fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) =
        anotar("stick($pitch, $roll, $yaw, $throttle)")
    override fun returnHome() = anotar("returnHome")
    override fun disconnect() = anotar("disconnect")
}
