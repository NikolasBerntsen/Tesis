package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Waypoint
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El dron simulado arranca en el suelo, como el real: solo "Comenzar
 * patrullaje" lo despega, el resto de las órdenes se rechaza avisando, y
 * aterrizar o volver a base lo deja otra vez en el suelo.
 *
 * Los eventos que una orden emite EN EL ACTO (Despegando, el rechazo) se
 * esperan con el colector ya suscripto —ver [alOrdenar]—: `flightEvents` no
 * tiene replay, igual que en la app, donde PatrolManager está suscripto desde
 * antes de la primera orden.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SimulatedDroneControllerSueloTest {

    private companion object {
        const val BASE_LAT = -34.6037
        const val BASE_LON = -58.3816
        val RUTA = PatrolRoute(
            id = 1,
            name = "Manzana",
            waypoints = listOf(
                Waypoint(BASE_LAT + 20 / Geo.METROS_POR_GRADO_LAT, BASE_LON, 12.0),
                Waypoint(BASE_LAT, BASE_LON, 12.0),
            ),
        )
    }

    private val dron = SimulatedDroneController()

    @After
    fun bajarDron() {
        dron.disconnect()
    }

    /** Se suscribe al evento que se espera, recién entonces manda la orden, y lo devuelve. */
    private suspend fun alOrdenar(esperado: (FlightEvent) -> Boolean, orden: () -> Unit): FlightEvent = coroutineScope {
        val espera = async { dron.flightEvents.first(esperado) }
        dron.flightEvents.subscriptionCount.first { it > 0 }
        orden()
        withTimeout(10_000) { espera.await() }
    }

    @Test
    fun arrancaEnElSueloYConectado() = runBlocking {
        dron.connect()
        val estado = dron.estado.value

        assertTrue(estado.conectado)
        assertFalse(estado.enVuelo)
        assertTrue(estado.listoParaDespegar)
        assertEquals(0.0, withTimeout(5_000) { dron.telemetry.first() }.altM, 0.0)
    }

    @Test
    fun comenzarUnaRutaDespegaSubeALaAlturaDelWaypointYRecienAhiVuela() = runBlocking<Unit> {
        dron.connect()

        alOrdenar({ it is FlightEvent.Despegando }) { dron.startRoute(RUTA, 0) }
        assertTrue(dron.estado.value.enVuelo)
        // 12 m a 5 m/s: unos 3 s
        withTimeout(10_000) { dron.flightEvents.first { it is FlightEvent.EnElAire } }
        assertEquals(12.0, dron.telemetry.first().altM, 1.5)
        // Y después del despegue arranca la ruta: llega al primer waypoint
        withTimeout(10_000) { dron.flightEvents.first { it is FlightEvent.WaypointReached } }
    }

    @Test
    fun enElSueloElMandoYElGotoSeRechazanAvisandoUnaSolaVez() = runBlocking {
        dron.connect()

        val problema = alOrdenar({ it is FlightEvent.Problema }) {
            dron.manualStick(1.0, 0.0, 0.0, 0.0)
            dron.manualStick(1.0, 0.0, 0.0, 0.0)
            dron.gotoPoint(BASE_LAT + 0.001, BASE_LON)
        } as FlightEvent.Problema

        assertTrue(problema.motivo, problema.motivo.contains("en el suelo"))
        delay(1_200)
        val t = dron.telemetry.first()
        assertEquals(0.0, t.altM, 0.0)
        assertEquals(BASE_LAT, t.lat, 1e-9)
        assertFalse(dron.estado.value.enVuelo)
    }

    @Test
    fun aterrizarLoDejaEnElSueloYAvisa() = runBlocking {
        dron.connect()
        dron.startRoute(RUTA, 0)
        withTimeout(10_000) { dron.flightEvents.first { it is FlightEvent.EnElAire } }

        dron.land()
        withTimeout(10_000) { dron.flightEvents.first { it is FlightEvent.Aterrizado } }

        assertEquals(0.0, dron.telemetry.first().altM, 0.0)
        assertFalse(dron.estado.value.enVuelo)
    }

    @Test
    fun volverABaseAterrizaEnLaBaseYAvisa() = runBlocking {
        dron.connect()
        dron.startRoute(RUTA, 0)
        withTimeout(10_000) { dron.flightEvents.first { it is FlightEvent.WaypointReached } }

        dron.returnHome()
        withTimeout(20_000) { dron.flightEvents.first { it is FlightEvent.ArrivedHome } }

        val t = dron.telemetry.first()
        assertEquals(0.0, t.altM, 0.0)
        assertEquals(BASE_LAT, t.lat, 8 / Geo.METROS_POR_GRADO_LAT)
        assertFalse(dron.estado.value.enVuelo)
    }
}
