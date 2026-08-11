package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import kotlin.math.abs
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
 * Pruebas de los modos HOLD/GOTO y del rumbo del simulador. Usan Robolectric
 * solo porque el video simulado dibuja con android.graphics; la lógica de vuelo
 * corre igual que en la JVM, con tiempos reales (tick de 500 ms, 12 m/s).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SimulatedDroneControllerTest {

    private companion object {
        const val BASE_LAT = -34.8565
        const val BASE_LON = -56.2075
        const val M_POR_GRADO_LAT = 111_320.0
    }

    private val dron = SimulatedDroneController()

    @After
    fun bajarDron() {
        dron.disconnect()
    }

    @Test
    fun gotoLlegaEmiteGotoArrivedYQuedaEstacionario() = runBlocking {
        dron.connect()
        val objetivoLat = BASE_LAT + 30 / M_POR_GRADO_LAT // 30 m al norte
        dron.gotoPoint(objetivoLat, BASE_LON)

        withTimeout(20_000) { dron.flightEvents.first { it is FlightEvent.GotoArrived } }

        // Queda cerca del objetivo (umbral de llegada: 6 m)...
        val t1 = dron.telemetry.first()
        assertTrue(abs(t1.lat - objetivoLat) * M_POR_GRADO_LAT < 8.0)
        // ...y en vuelo estacionario: la posición ya no cambia
        delay(1_500)
        val t2 = dron.telemetry.first()
        assertEquals(t1.lat, t2.lat, 1e-12)
        assertEquals(t1.lon, t2.lon, 1e-12)
    }

    @Test
    fun holdDetieneElMovimiento() = runBlocking {
        dron.connect()
        dron.gotoPoint(BASE_LAT + 500 / M_POR_GRADO_LAT, BASE_LON) // objetivo lejano
        delay(1_200)
        dron.hold()
        delay(700) // margen para que termine el tick en curso

        val t1 = dron.telemetry.first()
        assertTrue("tendría que haber avanzado hacia el norte antes del hold", t1.lat > BASE_LAT)
        delay(1_500)
        val t2 = dron.telemetry.first()
        assertEquals(t1.lat, t2.lat, 1e-12)
        assertEquals(t1.lon, t2.lon, 1e-12)
    }

    @Test
    fun headingApuntaAlNorteCuandoVuelaAlNorte() = runBlocking {
        dron.connect()
        dron.gotoPoint(BASE_LAT + 500 / M_POR_GRADO_LAT, BASE_LON)
        delay(1_200) // en pleno vuelo hacia el objetivo
        val rumbo = dron.telemetry.first().heading
        assertTrue("rumbo $rumbo tendría que ser ~0°", rumbo < 1.0 || rumbo > 359.0)
    }

    @Test
    fun headingApuntaAlEsteCuandoVuelaAlEste() = runBlocking {
        dron.connect()
        dron.gotoPoint(BASE_LAT, BASE_LON + 0.005) // ~450 m al este
        delay(1_200)
        val rumbo = dron.telemetry.first().heading
        assertEquals(90.0, rumbo, 1.0)
    }

    @Test
    fun laBateriaSeDrenaEnHold() = runBlocking {
        dron.connect()
        dron.hold()
        delay(1_200)
        val antes = dron.telemetry.first().batteryPct
        delay(1_500)
        val despues = dron.telemetry.first().batteryPct
        assertTrue("batería antes=$antes después=$despues", despues < antes)
    }
}
