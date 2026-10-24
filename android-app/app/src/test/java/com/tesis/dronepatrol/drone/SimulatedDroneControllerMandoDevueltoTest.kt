package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.Telemetry
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
 * El mando devuelto al control físico en el dron simulado
 * (DroneController.devolverElMandoAlControl): el control manual que se quedó
 * sin nadie al mando. El simulado no tiene palancas, así que lo que se mira es
 * que quede quieto DONDE está —no a la altura de crucero, como el estacionario
 * de siempre—, que no le corte un aterrizaje y que un despegue que todavía no
 * dejó el suelo no salga.
 *
 * Corre con el reloj virtual de la prueba: el dron arranca a 40 m.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SimulatedDroneControllerMandoDevueltoTest {

    private class Banco(val dron: SimulatedDroneController, val eventos: List<FlightEvent>) {
        val ultima: Telemetry get() = dron.telemetry.replayCache.last()
    }

    private fun conDron(enElAire: Boolean = true, cuerpo: suspend TestScope.(Banco) -> Unit) = runTest {
        val dron = SimulatedDroneController(enElAire, ModeloDeBateria(), StandardTestDispatcher(testScheduler)) { testScheduler.currentTime }
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

    @Test
    fun quedaQuietoDondeEstaYALaAlturaQueTiene() = conDron { b ->
        // El operador lo venía subiendo y adelantando con la palanca.
        b.dron.manualStick(1.0, 0.0, 0.0, 1.0)
        volar(2_000)
        assertTrue("tenía que haber subido: ${b.ultima.altM}", b.ultima.altM > 42.0)

        b.dron.devolverElMandoAlControl()
        volar(1_000)
        val quieto = b.ultima
        volar(3_000)

        assertEquals("no volvió a la altura de crucero", quieto.altM, b.ultima.altM, 0.0)
        assertEquals("no siguió avanzando", quieto.lat, b.ultima.lat, 0.0)
        assertEquals(quieto.lon, b.ultima.lon, 0.0)
        assertTrue(b.dron.estado.value.enVuelo)
    }

    @Test
    fun aterrizandoSigueBajandoHastaElSuelo() = conDron { b ->
        b.dron.land()
        volar(2_000)
        val antes = b.ultima.altM

        b.dron.devolverElMandoAlControl()
        volar(1_000)

        assertTrue("dejó de bajar: estaba a $antes m y está a ${b.ultima.altM} m", b.ultima.altM <= antes - 4.0)
        volar(10_000)
        assertEquals(FlightEvent.Aterrizado, b.eventos.last())
    }

    /** Como el estacionario: ante la duda en el suelo, el dron no despega. */
    @Test
    fun unDespegueQueNoDejoElSueloNoSale() = conDron(enElAire = false) { b ->
        b.dron.devolverElMandoAlControl()
        assertTrue("en reposo no hay nada que soltar: ${b.eventos}", b.eventos.isEmpty())

        b.dron.despegarEnElLugar()
        b.dron.devolverElMandoAlControl()
        volar(5_000)

        assertFalse(b.dron.estado.value.enVuelo)
        assertEquals(FlightEvent.Aterrizado, b.eventos.last())
        assertFalse(FlightEvent.EnElAire in b.eventos)
    }

    /** Con el vuelo tomado por el propio dron, lo que haga es suyo: no hay mando que soltar ni nada que rechazar. */
    @Test
    fun conElVueloTomadoPorElDronNoHaceNada() = conDron { b ->
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)
        val antes = b.eventos.size
        b.dron.devolverElMandoAlControl()
        assertEquals("no es un rechazo que avisar", antes, b.eventos.size)
    }
}
