package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Waypoint
import kotlin.math.tan
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La inclinación de la cámara desde la consola (`manual_gimbal`) vista desde la
 * máquina de estados: solo con el control tomado y en MANUAL, también en el
 * suelo, recortada al rango del contrato; y la inclinación del dron viajando en
 * el status (`gimbalPitch`), que no sale cuando el dron todavía no la informó.
 *
 * El dron es el espía que anota cada orden: lo que hay que ver es si la orden
 * le llegó o no, y con qué valor.
 *
 * Usa Robolectric porque el reparto de cuadros de PatrolManager codifica en
 * Base64 (android.util) y el Comando Central espía arma el JSON con org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerCamaraTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = ComandoCentralEspia(alcance)
    private val deteccion = DetectionClient(alcance)
    private val patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST")

    @Before
    fun armar() {
        patrulla.start()
    }

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private suspend fun tomarElControl() {
        dron.emitirTelemetria()
        delay(100)
        comandoCentral.onControlTaken?.invoke("operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
    }

    /** Las órdenes de cámara que le llegaron al dron, en orden. */
    private fun ordenesDeCamara(): List<String> = dron.ordenes.filter { it.startsWith("camara(") }

    private fun inclinar(pitch: Double) {
        comandoCentral.onManualGimbal?.invoke(pitch, "operador1")
    }

    @Test
    fun sinElControlTomadoLaCamaraNoSeMueve() = runBlocking {
        dron.emitirTelemetria()
        delay(100)
        assertEquals(PatrolState.IDLE, patrulla.state.value)

        inclinar(-45.0)
        delay(100)

        assertTrue("no tendría que haberle llegado nada: ${dron.ordenes}", ordenesDeCamara().isEmpty())
    }

    @Test
    fun conElControlTomadoLaInclinacionLlegaAlDronTalCual() = runBlocking {
        tomarElControl()

        inclinar(-45.5)
        inclinar(0.0)

        // En orden: llegan por el mismo hilo y la última es la que vale.
        assertEquals(listOf("camara(-45.5)", "camara(0.0)"), ordenesDeCamara())
        // Y no toca el vuelo: el estado sigue en MANUAL y no salió ninguna otra orden.
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertEquals("camara(0.0)", dron.ultimaOrden)
    }

    /** Inclinar la cámara no mueve al dron: es justo lo que se prueba antes de despegar. */
    @Test
    fun enElSueloConElControlTomadoTambienSeInclina() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        tomarElControl()

        inclinar(-10.0)
        // El mando, en cambio, en el suelo se sigue descartando
        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")

        assertEquals(listOf("camara(-10.0)"), ordenesDeCamara())
        assertFalse("el mando no tendría que haber llegado: ${dron.ordenes}", dron.ordenes.any { it.startsWith("stick(") })
    }

    @Test
    fun laInclinacionSeRecortaAlRangoDelContrato() = runBlocking {
        tomarElControl()

        inclinar(-120.0)
        inclinar(50.0)
        inclinar(-90.0)
        inclinar(30.0)

        assertEquals(listOf("camara(-90.0)", "camara(30.0)", "camara(-90.0)", "camara(30.0)"), ordenesDeCamara())
    }

    /** El cliente ya filtra lo que no es número; acá se vuelve a mirar porque es la app la que le habla al gimbal. */
    @Test
    fun unaInclinacionNoFinitaSeIgnora() = runBlocking {
        tomarElControl()

        inclinar(Double.NaN)
        inclinar(Double.POSITIVE_INFINITY)
        inclinar(Double.NEGATIVE_INFINITY)

        assertTrue("no tendría que haberle llegado nada: ${dron.ordenes}", ordenesDeCamara().isEmpty())
    }

    @Test
    fun soltadoElControlLaCamaraDejaDeObedecer() = runBlocking {
        tomarElControl()
        comandoCentral.onControlReleased?.invoke("operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PAUSED } }

        inclinar(-60.0)

        assertTrue("con el control soltado no se aplica: ${dron.ordenes}", ordenesDeCamara().isEmpty())
    }

    /**
     * El control sigue TOMADO pero el estado salió de MANUAL (batería baja: el
     * dron vuelve a la base). El regreso es del dron y la cámara no se toca.
     */
    @Test
    fun conElControlTomadoPeroFueraDeManualTampocoSeAplica() = runBlocking {
        tomarElControl()
        dron.emitirTelemetria(bateria = 20.0)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_BATTERY } }

        inclinar(-60.0)

        assertTrue("fuera de MANUAL no se aplica: ${dron.ordenes}", ordenesDeCamara().isEmpty())
    }

    @Test
    fun elStatusLlevaLaInclinacionQueInformaElDron() = runBlocking {
        dron.emitirTelemetria(gimbal = -35.0)

        esperarA("un status") { comandoCentral.mensajes("status").isNotEmpty() }

        val status = comandoCentral.mensajes("status").last()
        assertEquals(-35.0, status.getDouble("gimbalPitch"), 0.0)
    }

    /** El dron real recién enlazado todavía no la informó: el status sale igual, sin el campo. */
    @Test
    fun sinInclinacionInformadaElStatusNoLaInventa() = runBlocking {
        dron.emitirTelemetria(gimbal = Double.NaN)

        esperarA("un status") { comandoCentral.mensajes("status").isNotEmpty() }

        val status = comandoCentral.mensajes("status").last()
        assertFalse("no tendría que llevar gimbalPitch: $status", status.has("gimbalPitch"))
        assertEquals("y el resto sale igual", "IDLE", status.getString("state"))
    }

    /**
     * Sin inclinación informada, una detección se proyecta igual, con la
     * inclinación de patrulla: el objetivo queda adelante del dron, donde lo
     * pone la cámara a 70° hacia abajo, y no se pierde la detección.
     */
    @Test
    fun sinInclinacionInformadaLaDeteccionSeProyectaConLaDePatrulla() = runBlocking {
        dron.emitirTelemetria(LAT, LON, alt = ALT, rumbo = 90.0, gimbal = Double.NaN)
        delay(100)
        patrulla.startPatrol(PatrolRoute(1, "Manzana", listOf(Waypoint(LAT + 0.001, LON, ALT), Waypoint(LAT, LON + 0.001, ALT))))
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }

        val enElCentro = Deteccion(listOf("PERSON"), 0.87, listOf(Caja("PERSON", 0.87, 0.5, 0.5, 0.02, 0.05)), null, 1L)
        deteccion.onDetection?.invoke(enElCentro)
        delay(80)
        deteccion.onDetection?.invoke(enElCentro)
        esperarA("la orden de órbita") { dron.ultimaOrbita != null }

        val (lat, lon) = dron.ultimaOrbita!!
        val metrosEste = (lon - LON) * Geo.metrosPorGradoLon(LAT)
        val metrosNorte = (lat - LAT) * Geo.METROS_POR_GRADO_LAT
        assertEquals(ALT / tan(Math.toRadians(-Telemetry.GIMBAL_PATRULLA)), metrosEste, 0.5)
        assertEquals(0.0, metrosNorte, 0.5)
    }
}
