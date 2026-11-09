package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayStart
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Volver a la base desde la consola (`return_home`, docs/VUELO.md §7.1 y §11)
 * y el regreso que no arranca (§7.2). El `return_home` es el «Volver a base»
 * del teléfono pero del lado del hub: corta todo lo de la capa 4, el relevo se
 * cancela como con cualquier orden del operador y, si el que ordena tenía el
 * control, la app lo suelta sola SIN `control_dropped` (el hub ya soltó el
 * lock). Ya volviendo o en el suelo no cambia nada. Y si el controlador avisa
 * que el GoHome no arrancó (`NO_SE_PUDO_VOLVER`), la consola se entera siempre
 * y el dron queda estacionario en PAUSED, a la espera de otra orden.
 *
 * El dron es el espía: lo que se mira es qué le queda ordenado.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerRegresoPorLaConsolaTest {

    private companion object {
        const val NO_ARRANCO = "${DroneController.NO_SE_PUDO_VOLVER}: el regreso no salió de IDLE en 3 intentos (prueba)"
    }

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun volverPorLaConsola(by: String = "op") = consola("""{"type":"return_home","by":"$by"}""")

    private fun palanca(pitch: Double) =
        consola("""{"type":"manual_stick","pitch":$pitch,"roll":0.0,"yaw":0.0,"throttle":0.0,"by":"op"}""")

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun eventos(tipo: String) = banco.comando.eventos(tipo)

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

    private suspend fun orbitando() {
        patrullando()
        detectar()
        detectar()
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    // ---- return_home ----

    @Test
    fun sinElControlVuelveDesdeLaRutaConSuEvento() = runBlocking {
        patrullando()
        val i = dron.ordenes.size

        volverPorLaConsola("ana")
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }

        assertEquals(listOf("returnHome"), desde(i))
        assertEquals("Volver a la base ordenado por ana desde el Comando Central", eventos("RTH_MANUAL").single().getString("message"))
        assertTrue("sin control tomado no hay lock que mencionar", banco.mensajes("control_dropped").isEmpty())
    }

    @Test
    fun conElControlTomadoLoSueltaSinAvisarYVuelve() = runBlocking {
        patrullando()
        consola("""{"type":"control_taken","by":"op"}""")
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        val i = dron.ordenes.size

        volverPorLaConsola()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        palanca(1.0)
        delay(200)

        // Salir de MANUAL tira la inclinación de la consola; después, el regreso; la palanca ya no es de nadie.
        assertEquals(listOf(DronEspia.CANCELAR_CAMARA, "returnHome"), desde(i))
        assertTrue("el hub ya soltó el lock: no se le avisa", banco.mensajes("control_dropped").isEmpty())
        assertTrue(registro("El control manual queda suelto: el Comando Central ya soltó el lock con la orden"))

        // Si el hub igual creyera que alguien lo tiene, la app le cuenta por qué lo soltó.
        consola("""{"type":"control_taken","by":"op","resync":true}""")
        esperarA("el aviso al hub") { banco.mensajes("control_dropped").isNotEmpty() }
        assertTrue(banco.mensajes("control_dropped").single().getString("motivo").contains("ordenó volver a la base desde el Comando Central"))
    }

    @Test
    fun orbitandoCortaElSeguimientoYLasDeteccionesYaNoOrdenanNada() = runBlocking {
        orbitando()
        val i = dron.ordenes.size

        volverPorLaConsola()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        esperarA("TRACKING_ENDED") { eventos("TRACKING_ENDED").isNotEmpty() }
        assertNull(patrulla.objetivo)

        detectar()
        detectar()
        delay(300)
        assertEquals(listOf("returnHome"), desde(i))
        assertEquals(1, banco.comando.alertas.size)
    }

    @Test
    fun yaVolviendoSoloQuedaEnElRegistro() = runBlocking {
        patrullando()
        patrulla.volverABase()
        esperarA("el regreso del campo") { patrulla.state.value == PatrolState.RETURNING_HOME }
        val i = dron.ordenes.size

        volverPorLaConsola()
        esperarA("el registro") { registro("ya está volviendo (RETURNING_HOME): no cambia nada") }

        assertEquals(emptyList<String>(), desde(i))
        assertEquals("un solo RTH_MANUAL, el del campo", 1, eventos("RTH_MANUAL").size)
    }

    @Test
    fun enElSueloSoloQuedaEnElRegistro() = runBlocking {
        banco.enElSuelo()
        banco.arrancar()
        banco.telemetria(alt = 0.0)

        volverPorLaConsola()
        esperarA("el registro") { registro("pero el dron está en el suelo: no hay a dónde volver") }

        assertTrue(dron.ordenes.isEmpty())
        assertTrue(eventos("RTH_MANUAL").isEmpty())
        assertEquals(PatrolState.IDLE, patrulla.state.value)
    }

    /** Como cualquier orden del operador: el hub ya canceló el relevo de su lado, la app lo olvida sin contestar nada. */
    @Test
    fun cancelaElRelevoComoCualquierOrdenDelOperador() = runBlocking {
        banco.enElSuelo()
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 5.0, bateria = 95.0, alt = 0.0)
        assertTrue(patrulla.ponerEnEspera(true))
        banco.hub(relayStart(5, fromIndex = 1))
        esperarA("la cuenta regresiva") { patrulla.cuentaRegresiva.value?.habilitando == false }

        volverPorLaConsola()
        // El registro sale después de olvidar el relevo: esperar la cuenta en null no alcanza.
        esperarA("el relevo olvidado") { registro("La orden del operador cancela el relevo de Alfa") }

        assertNull(patrulla.cuentaRegresiva.value)
        assertTrue("no contesta relay_reject: el hub ya lo canceló", banco.mensajes("relay_reject").isEmpty())
        assertTrue(banco.mensajes("relay_abort").isEmpty())
        assertEquals("en el suelo el mando vuelve a las palancas", "soltarDespegue", dron.ultimaOrden)
        assertFalse("en el suelo no hay a dónde volver", "returnHome" in dron.ordenes)
    }

    // ---- El regreso que no arranca (VUELO §7.2) ----

    @Test
    fun siElRegresoNoArrancaSeAvisaSiempreYElDronQuedaEnPausa() = runBlocking {
        patrullando()
        // El techo por minuto, gastado: la respuesta a una orden sale igual.
        repeat(PatrolManager.MAX_PROBLEMAS_POR_VENTANA) { banco.evento(FlightEvent.Problema("rechazo $it")) }
        esperarA("el techo gastado") { eventos("DRONE_PROBLEM").size == PatrolManager.MAX_PROBLEMAS_POR_VENTANA }
        volverPorLaConsola()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        val i = dron.ordenes.size

        banco.evento(FlightEvent.Problema(NO_ARRANCO))
        esperarA("el aviso") { eventos("DRONE_PROBLEM").size == PatrolManager.MAX_PROBLEMAS_POR_VENTANA + 1 }
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }

        assertEquals("No se pudo volver a la base: el regreso no salió de IDLE en 3 intentos (prueba)", eventos("DRONE_PROBLEM").last().getString("message"))
        assertEquals(listOf("hold"), desde(i))

        // El mismo motivo otra vez (otra orden que tampoco arranca) también sale.
        volverPorLaConsola()
        esperarA("el segundo regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        banco.evento(FlightEvent.Problema(NO_ARRANCO))
        esperarA("el segundo aviso, igual al primero") { eventos("DRONE_PROBLEM").size == PatrolManager.MAX_PROBLEMAS_POR_VENTANA + 2 }
        esperarA("la pausa otra vez") { patrulla.state.value == PatrolState.PAUSED }
    }

    /** Con la batería en el umbral, la pausa dura hasta la telemetría siguiente: el regreso a tiempo manda. */
    @Test
    fun siElRegresoPorBateriaNoArrancaQuedaEnPausaYLaBateriaLoVuelveAMandar() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        val i = dron.ordenes.size

        banco.evento(FlightEvent.Problema(NO_ARRANCO))
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }
        assertEquals(listOf("hold"), desde(i))
        assertTrue(eventos("DRONE_PROBLEM").single().getString("message").startsWith("No se pudo volver a la base"))

        banco.telemetria(norteM = 100.0, bateria = 19.0)
        esperarA("el regreso de nuevo") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        assertEquals(listOf("hold", "returnHome"), desde(i))
    }

    /**
     * Con el control tomado (el regreso por batería que salta en MANUAL), si el
     * GoHome no arranca el dron vuelve a manos de la persona: en PAUSED sus
     * palancas no harían nada, que es lo que pasó en el campo (VUELO §0). La
     * batería no se lo vuelve a sacar mientras lo tenga.
     */
    @Test
    fun conElControlTomadoSiElRegresoNoArrancaVuelveAManosDeLaPersona() = runBlocking {
        patrullando()
        consola("""{"type":"control_taken","by":"op"}""")
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        val i = dron.ordenes.size

        banco.evento(FlightEvent.Problema(NO_ARRANCO))
        esperarA("el control de vuelta") { patrulla.state.value == PatrolState.MANUAL }
        palanca(1.0)
        banco.telemetria(norteM = 100.0, bateria = 19.0)
        delay(200)

        assertEquals(listOf("hold", "stick(1.0, 0.0, 0.0, 0.0)"), desde(i))
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertEquals("la batería no se lo vuelve a sacar", 1, eventos("RTH_LOW_BATTERY").size)
        assertTrue(eventos("DRONE_PROBLEM").single().getString("message").startsWith("No se pudo volver a la base"))
        assertTrue(registro("queda estacionario y en manos de op"))
    }

    /** El regreso del propio DJI no es de la app: si no arranca solo se avisa, el vuelo sigue siendo suyo. */
    @Test
    fun conElDronAlMandoSoloSeAvisa() = runBlocking {
        patrullando()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        esperarA("el regreso del DJI") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        val i = dron.ordenes.size

        banco.evento(FlightEvent.Problema(NO_ARRANCO))
        esperarA("el aviso") { eventos("DRONE_PROBLEM").isNotEmpty() }
        delay(200)

        assertEquals(PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
    }
}
