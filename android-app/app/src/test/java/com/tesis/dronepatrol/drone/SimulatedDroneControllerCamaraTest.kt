package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Waypoint
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La cámara del dron simulado obedece a `inclinarCamara`: la telemetría sale con
 * la inclinación pedida —que es lo que la consola ve en `status.gimbalPitch`—,
 * en el suelo y en el aire, recortada al rango del contrato. Y los modos que
 * apuntan la cámara por su cuenta la vuelven a apuntar, como el dron real.
 *
 * Usa Robolectric solo porque el video simulado dibuja con android.graphics; la
 * telemetría sale con el tick real de 500 ms.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SimulatedDroneControllerCamaraTest {

    private companion object {
        const val BASE_LAT = -34.6037
        const val BASE_LON = -58.3816
    }

    private var dron = SimulatedDroneController()

    @After
    fun bajarDron() {
        dron.disconnect()
    }

    /** Espera a que la telemetría salga con esa inclinación (la del tick que ya pasó puede ser la vieja). */
    private suspend fun esperarInclinacion(grados: Double): Telemetry =
        withTimeout(5_000) { dron.telemetry.first { it.gimbalPitch == grados } }

    @Test
    fun enElSueloLaCamaraSeInclinaSinDespegarNiQuejarse() = runBlocking {
        dron.connect()
        val problema = async { withTimeoutOrNull(1_500) { dron.flightEvents.first { it is FlightEvent.Problema } } }
        dron.flightEvents.subscriptionCount.first { it > 0 }

        dron.inclinarCamara(-20.0)

        val t = esperarInclinacion(-20.0)
        assertEquals("no tendría que haber despegado", 0.0, t.altM, 0.0)
        assertFalse(dron.estado.value.enVuelo)
        // Inclinar la cámara en el suelo no es una orden de vuelo rechazada
        assertNull(problema.await())
    }

    @Test
    fun enElAireSeInclinaYSeRecortaAlRangoDelContrato() = runBlocking {
        dron = SimulatedDroneController(arrancaEnElAire = true)
        dron.connect()

        dron.inclinarCamara(-45.5)
        esperarInclinacion(-45.5)

        dron.inclinarCamara(-120.0)
        esperarInclinacion(-90.0)

        dron.inclinarCamara(45.0)
        val t = esperarInclinacion(30.0)
        // Y no se movió: la cámara no es el vuelo
        assertEquals(BASE_LAT, t.lat, 1e-9)
        assertEquals(BASE_LON, t.lon, 1e-9)
    }

    @Test
    fun unaInclinacionNoFinitaNoCambiaNada() = runBlocking {
        dron.connect()
        dron.inclinarCamara(-15.0)
        esperarInclinacion(-15.0)

        dron.inclinarCamara(Double.NaN)
        dron.inclinarCamara(Double.POSITIVE_INFINITY)

        // Dos ticks enteros después, sigue donde estaba
        delay(1_100)
        val siguientes = withTimeout(5_000) { dron.telemetry.take(2).toList() }
        siguientes.forEach { assertEquals(-15.0, it.gimbalPitch, 0.0) }
    }

    /**
     * Acá la inclinación se aplica en el acto, así que al salir de MANUAL no hay
     * ninguna esperando que tirar: cancelar no deshace la que ya se aplicó (como
     * en el real con la que el gimbal está cumpliendo) y la siguiente se aplica
     * igual.
     */
    @Test
    fun cancelarLaInclinacionManualNoDeshaceLaAplicada() = runBlocking<Unit> {
        dron = SimulatedDroneController(arrancaEnElAire = true)
        dron.connect()
        dron.inclinarCamara(-25.0)
        esperarInclinacion(-25.0)

        dron.cancelarInclinacionManual()

        delay(1_100)
        val siguientes = withTimeout(5_000) { dron.telemetry.take(2).toList() }
        siguientes.forEach { assertEquals(-25.0, it.gimbalPitch, 0.0) }
        dron.inclinarCamara(-40.0)
        esperarInclinacion(-40.0)
    }

    /** Retomar la ruta vuelve a la cámara de patrulla: la que necesita el detector. */
    @Test
    fun alArrancarLaRutaLaCamaraVuelveALaDePatrulla() = runBlocking<Unit> {
        dron = SimulatedDroneController(arrancaEnElAire = true)
        dron.connect()
        dron.inclinarCamara(-5.0)
        esperarInclinacion(-5.0)

        dron.startRoute(PatrolRoute(1, "Manzana", listOf(Waypoint(BASE_LAT + 0.001, BASE_LON, 40.0))), 0)

        esperarInclinacion(Telemetry.GIMBAL_PATRULLA)
    }
}
