package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.drone.SimulatedDroneController
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El regreso de la app que la persona al lado del dron corta con las palancas
 * del RC-N3 (`REGRESO_CORTADO_EN_EL_CONTROL`, docs/VUELO.md §1, la capa 2): no
 * es una falla del regreso. La app no le da ninguna orden —un estacionario es
 * el Virtual Stick y se lo sacaría de las manos—, queda en la pausa con el
 * mando en el control físico, la consola se entera siempre (`RTH_INTERRUPTED`)
 * y, si tenía el control tomado, lo pierde: manda el que está al lado. Desde
 * ahí una detección alerta sin seguimiento, y la batería no le vuelve a pelear
 * el regreso que la persona cortó.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerRegresoCortadoEnElControlTest {

    private companion object {
        const val CORTADO = "${DroneController.REGRESO_CORTADO_EN_EL_CONTROL} (GoHomeExitCode=JOYSTICK_PITCH, prueba)"
        const val AVISO = "El regreso a base se cortó con las palancas del control físico: el dron queda en manos de quien lo vuela al lado"
        const val SOLTADO = "alguien tomó el dron con las palancas del control físico"
    }

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun palanca(pitch: Double) =
        consola("""{"type":"manual_stick","pitch":$pitch,"roll":0.0,"yaw":0.0,"throttle":0.0,"by":"op"}""")

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun avisos(): List<String> = banco.comando.eventos("RTH_INTERRUPTED").map { it.getString("message") }

    private fun registro(texto: String) = patrulla.localLog.replayCache.any { it.contains(texto) }

    private val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/x", 1L)

    private suspend fun detectar() {
        banco.deteccion.onDetection?.invoke(persona)
        delay(80)
    }

    private suspend fun patrullando() {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
    }

    private suspend fun cortadoConLasPalancas() {
        banco.evento(FlightEvent.Problema(CORTADO))
        esperarA("el aviso") { avisos().isNotEmpty() }
    }

    @Test
    fun quedaEnLaPausaSinUnaOrdenYLaConsolaSeEnteraSiempre() = runBlocking {
        patrullando()
        // El techo de los avisos del dron, gastado: este sale igual.
        repeat(PatrolManager.MAX_PROBLEMAS_POR_VENTANA) { banco.evento(FlightEvent.Problema("rechazo $it")) }
        patrulla.volverABase()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME && dron.ultimaOrden == "returnHome" }
        val i = dron.ordenes.size

        cortadoConLasPalancas()

        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals(listOf(AVISO), avisos())
        assertEquals("ni estacionario ni Virtual Stick: ${desde(i)}", emptyList<String>(), desde(i))
        assertTrue("no es un problema del dron", banco.comando.eventos("DRONE_PROBLEM").none { it.getString("message").contains("palancas") })
        assertTrue(banco.mensajes("control_dropped").isEmpty())
    }

    @Test
    fun conElControlTomadoLaConsolaLoPierdeYElHubSeEntera() = runBlocking {
        patrullando()
        consola("""{"type":"control_taken","by":"op"}""")
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        // La batería que baja por primera vez con el control tomado lo manda a casa igual.
        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY && dron.ultimaOrden == "returnHome" }
        val i = dron.ordenes.size

        cortadoConLasPalancas()
        palanca(1.0)
        delay(200)

        val soltado = banco.mensajes("control_dropped").single()
        assertEquals("op", soltado.getString("by"))
        assertEquals(SOLTADO, soltado.getString("motivo"))
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals("ni la palanca de la consola: ${desde(i)}", emptyList<String>(), desde(i))

        // Si el hub pregunta al reconectarse, se le dice por qué.
        consola("""{"type":"control_taken","by":"op","resync":true}""")
        esperarA("el segundo aviso") { banco.mensajes("control_dropped").size == 2 }
        assertEquals(SOLTADO, banco.mensajes("control_dropped")[1].getString("motivo"))
    }

    @Test
    fun despuesUnaDeteccionAlertaSinSeguimiento() = runBlocking {
        patrullando()
        patrulla.volverABase()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME && dron.ultimaOrden == "returnHome" }
        cortadoConLasPalancas()
        val i = dron.ordenes.size

        detectar()
        detectar()
        esperarA("la alerta") { banco.comando.alertas.isNotEmpty() }

        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals("ni órbita ni seguimiento: ${desde(i)}", emptyList<String>(), desde(i))
        assertTrue(banco.comando.eventos("DETECTION").single().getString("message").contains("con el mando en el control físico"))
    }

    /** La batería ya lo había mandado a casa y la persona le cortó ese regreso: no se lo vuelve a pelear en cada telemetría. */
    @Test
    fun laBateriaNoLeVuelveAPelearElRegresoQueLaPersonaCorto() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY && dron.ultimaOrden == "returnHome" }
        cortadoConLasPalancas()
        val i = dron.ordenes.size

        banco.telemetria(norteM = 100.0, bateria = 19.0)
        banco.telemetria(norteM = 100.0, bateria = 18.0)
        delay(100)
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
        assertEquals("un solo regreso por batería", 1, banco.comando.eventos("RTH_LOW_BATTERY").size)

        // La orden de una persona le devuelve el dron a la app.
        patrulla.volverABase()
        esperarA("el regreso") { dron.ultimaOrden == "returnHome" }
    }

    /** Si la batería todavía no lo había mandado a casa, la primera vez que llega al umbral manda igual. */
    @Test
    fun siLaBateriaTodaviaNoLoHabiaMandadoACasaLaPrimeraVezManda() = runBlocking {
        patrullando()
        patrulla.volverABase()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME && dron.ultimaOrden == "returnHome" }
        cortadoConLasPalancas()

        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY && dron.ultimaOrden == "returnHome" }
    }

    /** Sin un regreso de la app en curso el aviso es viejo, o el dron ya está en otra orden: no cambia nada. */
    @Test
    fun sinUnRegresoDeLaAppEnCursoNoCambiaNada() = runBlocking {
        patrullando()
        val i = dron.ordenes.size

        banco.evento(FlightEvent.Problema(CORTADO))
        esperarA("el registro") { registro("pero no hay uno de la app en curso: no cambia nada") }

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertTrue(avisos().isEmpty())
        assertEquals(emptyList<String>(), desde(i))
    }

    /** Con el dron simulado de verdad: su gancho corta el regreso de la app y la patrulla lo atiende. */
    @Test
    fun conElSimuladorElRegresoCortadoLlegaYLaPatrullaQuedaEnLaPausa() = runBlocking {
        val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val simulado = SimulatedDroneController(arrancaEnElAire = true)
        val comando = ComandoCentralEspia(alcance)
        val otra = PatrolManager(simulado, comando, DetectionClient(alcance), alcance, "TEST")
        try {
            otra.start()
            simulado.connect()
            withTimeout(5_000) { simulado.flightEvents.subscriptionCount.first { it > 0 } }
            withTimeout(5_000) { simulado.telemetry.first() }
            otra.volverABase()
            assertEquals(PatrolState.RETURNING_HOME, otra.state.value)

            simulado.simularRegresoCortadoEnElControl()
            esperarA("la pausa") { otra.state.value == PatrolState.PAUSED }
            esperarA("el aviso") { comando.eventos("RTH_INTERRUPTED").isNotEmpty() }
            assertEquals(AVISO, comando.eventos("RTH_INTERRUPTED").single().getString("message"))
        } finally {
            simulado.disconnect()
            alcance.cancel()
        }
    }
}
