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
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El gancho de prueba del simulado para el regreso que corta la persona al
 * lado del dron con las palancas del control (`REGRESO_CORTADO_EN_EL_CONTROL`,
 * docs/VUELO.md §1): solo vale con un regreso de la app en curso, como el
 * `GoHomeExitCode` JOYSTICK_* del real; deja al dron quieto donde estaba, sin
 * seguir hacia la base, y lo avisa una vez. El regreso propio del dron no es
 * de la app, y no pasa nada.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SimulatedDroneControllerRegresoCortadoTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816

        fun alNorte(metros: Double) = LAT + metros / Geo.METROS_POR_GRADO_LAT
    }

    private class Banco(val dron: SimulatedDroneController, val eventos: List<FlightEvent>) {
        val ultima: Telemetry get() = dron.telemetry.replayCache.last()

        val cortados: List<String>
            get() = eventos.filterIsInstance<FlightEvent.Problema>().map { it.motivo }
                .filter { it.startsWith(DroneController.REGRESO_CORTADO_EN_EL_CONTROL) }
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

    /** Lejos de la base y volviendo con el regreso de la app. */
    private fun TestScope.volviendoDeLejos(b: Banco) {
        b.dron.gotoPoint(alNorte(300.0), LON)
        volar(120_000)
        b.dron.returnHome()
        volar(2_000)
    }

    @Test
    fun conElRegresoDeLaAppLoCortaLoDejaQuietoYLoAvisaUnaVez() = conDron { b ->
        volviendoDeLejos(b)

        b.dron.simularRegresoCortadoEnElControl()
        volar(1_000)
        val aca = b.ultima
        volar(10_000)

        assertEquals("un solo aviso, con su prefijo: ${b.cortados}", 1, b.cortados.size)
        assertEquals("no siguió hacia la base", aca.lat, b.ultima.lat, 1e-9)
        assertTrue("sigue en el aire", b.dron.estado.value.enVuelo)

        // Ya sin regreso, el gancho no hace nada.
        b.dron.simularRegresoCortadoEnElControl()
        volar(500)
        assertEquals(1, b.cortados.size)
    }

    @Test
    fun conElRegresoPropioDelDronNoPasaNada() = conDron { b ->
        b.dron.gotoPoint(alNorte(300.0), LON)
        volar(120_000)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)
        volar(2_000)
        val antes = b.ultima

        b.dron.simularRegresoCortadoEnElControl()
        volar(5_000)

        assertTrue(b.cortados.isEmpty())
        assertTrue("sigue volviendo: estaba a ${antes.lat}, está a ${b.ultima.lat}", b.ultima.lat < antes.lat)
    }

    @Test
    fun sinRegresoEnCursoNoPasaNada() = conDron { b ->
        b.dron.hold()
        b.dron.simularRegresoCortadoEnElControl()
        volar(1_000)
        assertTrue(b.cortados.isEmpty())
    }
}
