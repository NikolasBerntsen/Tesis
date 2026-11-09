package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.Telemetry
import kotlin.math.abs
import kotlin.math.min
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La vigilancia del dron simulado (DroneController.vigilar, la reacción
 * `detenerse` de docs/VUELO.md §5): se queda quieto donde está, a la altura
 * que tiene, gira la nariz hacia el objetivo y baja la cámara a él; volver a
 * pedirla solo corre el punto al que mira, sin cortar el estacionario. En el
 * suelo se rechaza como el resto de la navegación.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SimulatedDroneControllerVigilanciaTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
    }

    private val dron = SimulatedDroneController(arrancaEnElAire = true)

    @After
    fun bajarDron() {
        dron.disconnect()
    }

    private suspend fun telemetria(): Telemetry = withTimeout(5_000) { dron.telemetry.first() }

    /** Diferencia angular en grados (0..180). */
    private fun separacion(a: Double, b: Double): Double {
        val d = abs(((a - b) % 360.0 + 360.0) % 360.0)
        return min(d, 360.0 - d)
    }

    @Test
    fun vigilaQuietoGirandoLaNarizYLaCamaraAlObjetivoYCorreLaMiradaSinMoverse() = runBlocking {
        dron.connect()
        val antes = telemetria()
        assertEquals(0.0, antes.heading, 1e-6)

        // Un objetivo 100 m al este: la nariz gira a 90° y la cámara baja lo que hace falta para verlo desde 40 m.
        val (eLat, eLon) = Persecucion.desplazar(LAT, LON, 90.0, 100.0)
        dron.vigilar(eLat, eLon)
        delay(2_500)
        val mirandoAlEste = telemetria()
        assertEquals("no se mueve", LAT, mirandoAlEste.lat, 1e-6)
        assertEquals(LON, mirandoAlEste.lon, 1e-6)
        assertEquals("a la altura que tenía", antes.altM, mirandoAlEste.altM, 0.5)
        assertTrue("la nariz al objetivo: ${mirandoAlEste.heading}", separacion(mirandoAlEste.heading, 90.0) < 3.0)
        assertEquals(Georreferencia.inclinacionParaOrbitar(antes.altM, 100.0), mirandoAlEste.gimbalPitch, 1.0)
        assertTrue(dron.estado.value.enVuelo)

        // La estimación se corre al norte: gira hacia allá, sin salir del lugar.
        val (nLat, nLon) = Persecucion.desplazar(LAT, LON, 0.0, 60.0)
        dron.vigilar(nLat, nLon)
        delay(2_500)
        val mirandoAlNorte = telemetria()
        assertEquals(LAT, mirandoAlNorte.lat, 1e-6)
        assertEquals(LON, mirandoAlNorte.lon, 1e-6)
        assertTrue("la nariz al norte: ${mirandoAlNorte.heading}", separacion(mirandoAlNorte.heading, 0.0) < 3.0)
        assertEquals(Georreferencia.inclinacionParaOrbitar(antes.altM, 60.0), mirandoAlNorte.gimbalPitch, 1.0)
    }

    /** El estacionario la termina: la nariz deja de seguir al objetivo. */
    @Test
    fun elEstacionarioTerminaLaVigilancia() = runBlocking {
        dron.connect()
        val (eLat, eLon) = Persecucion.desplazar(LAT, LON, 90.0, 100.0)
        dron.vigilar(eLat, eLon)
        delay(300)
        dron.hold()
        val alSoltar = telemetria().heading
        delay(1_200)
        val despues = telemetria()
        assertEquals("ya no gira hacia el objetivo", alSoltar, despues.heading, 1e-6)
        assertEquals(LAT, despues.lat, 1e-6)
        assertEquals(LON, despues.lon, 1e-6)
    }

    /** Con el vuelo tomado por el propio dron se rechaza, y una posición inválida se ignora sin tocar nada. */
    @Test
    fun conElDronAlMandoSeRechazaYUnaPosicionInvalidaSeIgnora() = runBlocking {
        dron.connect()
        val antes = telemetria()
        dron.vigilar(Double.NaN, Double.NaN)
        delay(1_200)
        val despues = telemetria()
        assertEquals("ni gira", antes.heading, despues.heading, 1e-6)
        assertEquals(antes.lat, despues.lat, 1e-6)

        val problema = coroutineScope {
            val espera = async { dron.flightEvents.first { it is FlightEvent.Problema } }
            dron.flightEvents.subscriptionCount.first { it > 0 }
            dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)
            dron.vigilar(LAT + 0.001, LON)
            withTimeout(5_000) { espera.await() } as FlightEvent.Problema
        }
        assertTrue(problema.motivo, problema.motivo.contains("no se puede vigilar al objetivo"))
    }

    @Test
    fun enElSueloVigilarSeRechaza() = runBlocking {
        val enElSuelo = SimulatedDroneController()
        try {
            enElSuelo.connect()
            val problema = coroutineScope {
                val espera = async { enElSuelo.flightEvents.first { it is FlightEvent.Problema } }
                enElSuelo.flightEvents.subscriptionCount.first { it > 0 }
                enElSuelo.vigilar(LAT + 0.001, LON)
                withTimeout(5_000) { espera.await() } as FlightEvent.Problema
            }
            assertTrue(problema.motivo, problema.motivo.contains("vigilar al objetivo"))
            assertTrue("sigue en el suelo", !enElSuelo.estado.value.enVuelo)
        } finally {
            enElSuelo.disconnect()
        }
    }
}
