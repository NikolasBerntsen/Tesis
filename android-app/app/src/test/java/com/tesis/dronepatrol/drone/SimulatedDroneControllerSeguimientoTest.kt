package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
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
 * Lo nuevo del dron simulado para el seguimiento y la prueba de mandos: el
 * despegue en el lugar (queda suspendido y obedece al mando), la órbita que
 * arranca desde el punto más cercano y acompaña al centro cuando se corre, y el
 * modo seguimiento que se mantiene a la distancia de separación.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SimulatedDroneControllerSeguimientoTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
    }

    private val dron = SimulatedDroneController()

    @After
    fun bajarDron() {
        dron.disconnect()
    }

    private suspend fun alOrdenar(esperado: (FlightEvent) -> Boolean, orden: () -> Unit): FlightEvent = coroutineScope {
        val espera = async { dron.flightEvents.first(esperado) }
        dron.flightEvents.subscriptionCount.first { it > 0 }
        orden()
        withTimeout(10_000) { espera.await() }
    }

    @Test
    fun despegaEnElLugarQuedaSuspendidoYObedeceAlMando() = runBlocking {
        dron.connect()
        alOrdenar({ it is FlightEvent.Despegando }) { dron.despegarEnElLugar() }
        withTimeout(10_000) { dron.flightEvents.first { it is FlightEvent.EnElAire } }

        val t = withTimeout(5_000) { dron.telemetry.first() }
        assertTrue(dron.estado.value.enVuelo)
        assertEquals(1.2, t.altM, 0.3)
        // Quieto en el lugar: no salió hacia ninguna ruta
        assertEquals(LAT, t.lat, 1e-6)
        assertEquals(LON, t.lon, 1e-6)

        // El mando de giro lo hace girar sin moverlo
        val rumboAntes = t.heading
        dron.manualStick(0.0, 0.0, 1.0, 0.0)
        delay(1_200)
        val despues = withTimeout(5_000) { dron.telemetry.first() }
        assertTrue("tiene que haber girado", kotlin.math.abs(despues.heading - rumboAntes) > 10.0)
        assertEquals(LAT, despues.lat, 1e-6)
        assertEquals(LON, despues.lon, 1e-6)
    }

    @Test
    fun enElAireDespegarEnElLugarNoHaceNada() = runBlocking {
        val enElAire = SimulatedDroneController(arrancaEnElAire = true)
        try {
            enElAire.connect()
            val antes = withTimeout(5_000) { enElAire.telemetry.first() }.altM
            enElAire.despegarEnElLugar()
            delay(700)
            assertEquals(antes, withTimeout(5_000) { enElAire.telemetry.first() }.altM, 1.0)
        } finally {
            enElAire.disconnect()
        }
    }

    @Test
    fun enElSueloSeguirSeRechaza() = runBlocking {
        dron.connect()
        val aviso = alOrdenar({ it is FlightEvent.Problema }) { dron.seguirObjetivo(LAT, LON, 1.0, 0.0) }
        assertTrue((aviso as FlightEvent.Problema).motivo.contains("suelo"))
        assertFalse(dron.estado.value.enVuelo)
    }

    /** Siguiendo a un objetivo quieto, se acomoda a la distancia de separación y lo mira. */
    @Test
    fun siguiendoSeAcomodaALaDistanciaDeSeparacionYMiraAlObjetivo() = runBlocking {
        val enElAire = SimulatedDroneController(arrancaEnElAire = true)
        try {
            enElAire.connect()
            // El objetivo a 80 m al norte
            val objLat = LAT + 80.0 / Geo.METROS_POR_GRADO_LAT
            val limite = System.currentTimeMillis() + 20_000
            var distancia = Double.MAX_VALUE
            var rumbo = 0.0
            while (System.currentTimeMillis() < limite) {
                enElAire.seguirObjetivo(objLat, LON, 0.0, 0.0)
                delay(500)
                val t = enElAire.telemetry.first()
                distancia = Geo.distanciaM(t.lat, t.lon, objLat, LON)
                rumbo = t.heading
                if (kotlin.math.abs(distancia - Persecucion.DISTANCIA_M) < 3.0) break
            }
            assertEquals(Persecucion.DISTANCIA_M, distancia, 3.0)
            assertEquals(0.0, ((rumbo + 180.0) % 360.0) - 180.0, 10.0) // mira al norte, hacia el objetivo
        } finally {
            enElAire.disconnect()
        }
    }
}
