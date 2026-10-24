package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Waypoint
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El aterrizaje del dron simulado con el contrato de DroneController.land: lo
 * acepta avisándolo, lo sostiene hasta el suelo contra el estacionario y el
 * mando (lo que en el campo le cancelaba el aterrizaje al DJI), rechaza la
 * navegación, y solo lo cortan otra orden de vuelo, el corte explícito o una
 * toma del propio dron. El que no acepta aterrizar lo avisa como el real.
 *
 * Corre con el reloj virtual de la prueba, como las de los relevos: el dron
 * arranca a 40 m y baja a 5 m/s, así que toca el suelo a los 8 s.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SimulatedDroneControllerAterrizajeTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816

        fun alNorte(metros: Double) = LAT + metros / Geo.METROS_POR_GRADO_LAT

        val LEJOS = PatrolRoute(1, "Lejos", listOf(Waypoint(alNorte(300.0), LON, 30.0), Waypoint(LAT, LON, 30.0)))
    }

    private class Banco(val dron: SimulatedDroneController, val eventos: List<FlightEvent>) {
        val ultima: Telemetry get() = dron.telemetry.replayCache.last()

        val problemas: List<String> get() = eventos.filterIsInstance<FlightEvent.Problema>().map { it.motivo }
    }

    private fun conDron(cuerpo: suspend TestScope.(Banco) -> Unit) = runTest {
        val dron = SimulatedDroneController(true, ModeloDeBateria(), StandardTestDispatcher(testScheduler)) { testScheduler.currentTime }
        val eventos = mutableListOf<FlightEvent>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { dron.flightEvents.collect { eventos += it } }
        dron.connect()
        try {
            cuerpo(Banco(dron, eventos))
        } finally {
            dron.disconnect()
        }
    }

    private fun TestScope.volar(ms: Long) {
        advanceTimeBy(ms)
        runCurrent()
    }

    private fun metrosAlNorte(t: Telemetry) = (t.lat - LAT) * Geo.METROS_POR_GRADO_LAT

    @Test
    fun aterrizarAceptaEnElActoYAvisaAlTocarElSuelo() = conDron { b ->
        b.dron.land()
        assertEquals(listOf<FlightEvent>(FlightEvent.AterrizajeAceptado), b.eventos)

        volar(10_000)
        assertEquals(listOf(FlightEvent.AterrizajeAceptado, FlightEvent.Aterrizado), b.eventos)
        assertFalse(b.dron.estado.value.enVuelo)
    }

    /** El cero de soltar la palanca, una palanca a fondo y el estacionario: ninguno lo frena. */
    @Test
    fun elEstacionarioYElMandoNoCortanElAterrizaje() = conDron { b ->
        b.dron.land()
        volar(2_000)
        val antes = b.ultima.altM

        b.dron.manualStick(0.0, 0.0, 0.0, 0.0)
        b.dron.hold()
        b.dron.manualStick(1.0, 0.0, 0.0, 1.0)
        volar(1_000)

        assertTrue("dejó de bajar: estaba a $antes m y está a ${b.ultima.altM} m", b.ultima.altM <= antes - 4.0)
        assertEquals("la palanca no lo movió", LAT, b.ultima.lat, 0.0)
        volar(10_000)
        assertEquals(FlightEvent.Aterrizado, b.eventos.last())
        assertTrue("no son un rechazo que avisar: ${b.problemas}", b.problemas.isEmpty())
    }

    @Test
    fun laNavegacionSeRechazaAterrizando() = conDron { b ->
        b.dron.land()

        b.dron.gotoPoint(alNorte(100.0), LON)
        b.dron.startOrbit(alNorte(50.0), LON, 30.0)
        b.dron.seguirObjetivo(alNorte(50.0), LON, 1.0, 0.0)
        b.dron.cambiarAltura(60.0)
        b.dron.volarHacia(alNorte(100.0), LON)
        b.dron.girarEnElLugar(90.0)

        assertEquals(6, b.problemas.size)
        assertTrue(b.problemas.toString(), b.problemas.all { it.startsWith("el dron está aterrizando: no se puede") })
        volar(10_000)
        assertEquals(FlightEvent.Aterrizado, b.eventos.last())
        assertEquals("bajó donde estaba", LAT, b.ultima.lat, 0.0)
    }

    /** El corte de una persona: queda quieto donde está, y la orden que sigue sale. */
    @Test
    fun cancelarElAterrizajeLoDejaQuietoYLaOrdenQueSigueSale() = conDron { b ->
        b.dron.land()
        volar(2_000)
        b.dron.cancelarAterrizaje()
        volar(500)
        val quieto = b.ultima.altM
        volar(2_000)
        assertEquals("quedó estacionario", quieto, b.ultima.altM, 0.0)

        b.dron.gotoPoint(alNorte(300.0), LON)
        volar(3_000)
        assertTrue("fue al punto", metrosAlNorte(b.ultima) > 10.0)
        assertFalse(FlightEvent.Aterrizado in b.eventos)
        assertTrue(b.problemas.isEmpty())
    }

    @Test
    fun volverALaBaseCortaElAterrizaje() = conDron { b ->
        b.dron.setHome(alNorte(100.0), LON)
        b.dron.land()
        volar(1_000)

        b.dron.returnHome()
        volar(5_000)
        assertTrue("vuelve a la base", metrosAlNorte(b.ultima) > 10.0)
        volar(30_000)
        assertEquals(FlightEvent.ArrivedHome, b.eventos.last())
    }

    @Test
    fun unaRutaCortaElAterrizaje() = conDron { b ->
        b.dron.land()
        volar(1_000)

        b.dron.startRoute(LEJOS, 0)
        volar(4_000)
        assertTrue("sigue la ruta", metrosAlNorte(b.ultima) > 10.0)
        assertFalse(FlightEvent.Aterrizado in b.eventos)
    }

    /** Lo que el dron haga después de una toma es suyo: el aterrizaje de la app ya no lo traba. */
    @Test
    fun unaTomaDelPropioDronTerminaElAterrizajeDeLaApp() = conDron { b ->
        b.dron.land()
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)
        volar(500)

        b.dron.gotoPoint(alNorte(300.0), LON)
        volar(3_000)
        assertTrue("fue al punto", metrosAlNorte(b.ultima) > 10.0)
        assertTrue(b.problemas.toString(), b.problemas.isEmpty())
    }

    /** Como el real cuando se le agotan las órdenes: cada orden tiene su aviso, y queda estacionario. */
    @Test
    fun unDronQueNoAceptaAterrizarLoAvisaSiempreYQuedaEstacionario() = conDron { b ->
        b.dron.rechazarElAterrizaje(true)
        b.dron.land()
        b.dron.land()

        assertEquals(2, b.problemas.size)
        assertTrue(b.problemas.toString(), b.problemas.all { it.startsWith(DroneController.NO_SE_PUDO_ATERRIZAR) })
        volar(3_000)
        assertEquals(40.0, b.ultima.altM, 0.0)
        assertFalse(FlightEvent.AterrizajeAceptado in b.eventos)
        assertTrue(b.dron.estado.value.enVuelo)

        // Y el mando no quedó trabado por un aterrizaje que no fue.
        b.dron.manualStick(1.0, 0.0, 0.0, 0.0)
        volar(1_000)
        assertTrue(metrosAlNorte(b.ultima) > 1.0)
    }

    @Test
    fun cancelarSinUnAterrizajeNoHaceNada() = conDron { b ->
        b.dron.gotoPoint(alNorte(300.0), LON)
        volar(1_000)
        b.dron.cancelarAterrizaje()
        volar(2_000)
        assertTrue("sigue yendo", metrosAlNorte(b.ultima) > 15.0)
    }
}
