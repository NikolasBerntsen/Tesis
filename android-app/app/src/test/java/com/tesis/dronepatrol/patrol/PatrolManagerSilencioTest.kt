package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El silencio al retomar (docs/VUELO.md §6): después de dejar un objetivo para
 * volver a volar solo, durante `silencioAlRetomarS` las detecciones solo
 * dibujan sus cajas. Lo arrancan el descarte, reanudar (consola y teléfono),
 * otra ruta y un desvío a un nodo, siempre con un objetivo en curso; no lo
 * arrancan un regreso ni un aterrizaje, ni reanudar desde una pausa sin
 * objetivo. Dura lo que la consola fijó (0, 15 de fábrica, 30).
 *
 * Es el caso del estacionamiento (VUELO §0): «Descartar» devolvía al dron a la
 * ruta y a los dos segundos ya orbitaba el auto de al lado. Para que la segunda
 * detección no caiga en la zona descartada del primer objetivo, el dron se
 * corre 300 m antes de volver a ver algo.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerSilencioTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/x", 1L)

    private suspend fun detectar() {
        banco.deteccion.onDetection?.invoke(persona)
        delay(80)
    }

    private val alertas: Int get() = banco.comando.alertas.size

    private suspend fun patrullando() {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
    }

    private suspend fun orbitandoUnaPersona() {
        patrullando()
        detectar()
        detectar()
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        esperarA("la alerta") { alertas == 1 }
    }

    private suspend fun conElSilencioEn(segundos: Int) {
        consola("""{"type":"ajustes","silencioAlRetomarS":$segundos,"by":"op"}""")
        esperarA("el silencio de $segundos s") { patrulla.silencioAlRetomar == segundos * 1_000L }
    }

    private fun descartar() = consola("""{"type":"alert_decision","decision":"DISMISSED","decidedBy":"op"}""")

    /** Lejos de la zona descartada, dentro del silencio no alerta; apenas vence, sí. */
    private suspend fun elSilencioDura(ms: Long) {
        banco.telemetria(norteM = 400.0)
        banco.reloj.adelantar(ms - 1_000)
        detectar()
        detectar()
        delay(300)
        assertEquals("dentro del silencio no se alerta", 1, alertas)
        assertEquals("ni queda una candidata esperando", PatrolState.PATROLLING, patrulla.state.value)

        banco.reloj.adelantar(2_000)
        detectar()
        detectar()
        esperarA("la alerta nueva") { alertas == 2 }
    }

    @Test
    fun elDescarteArrancaElSilencioDeFabricaDe15s() = runBlocking {
        orbitandoUnaPersona()
        assertEquals(PatrolManager.SILENCIO_AL_RETOMAR_MS, patrulla.silencioAlRetomar)
        descartar()
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }
        assertTrue(patrulla.localLog.replayCache.any { it.contains("durante 15 s lo que vea el detector solo se marca en el video") })

        elSilencioDura(15_000)
    }

    @Test
    fun conElSilencioEn30ElDronPasaDeLargoMasTiempo() = runBlocking {
        orbitandoUnaPersona()
        conElSilencioEn(30)
        descartar()
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }

        elSilencioDura(30_000)
    }

    @Test
    fun conElSilencioEnCeroNoHaySilencio() = runBlocking {
        orbitandoUnaPersona()
        conElSilencioEn(0)
        descartar()
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }

        banco.telemetria(norteM = 400.0)
        detectar()
        detectar()
        esperarA("la alerta en el acto") { alertas == 2 }
    }

    /** Las cajas se siguen dibujando durante el silencio: es lo único que una detección deja. */
    @Test
    fun duranteElSilencioLasCajasSeSiguenEntregando() = runBlocking {
        orbitandoUnaPersona()
        descartar()
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }
        banco.telemetria(norteM = 400.0)

        detectar()
        assertEquals(1, patrulla.cajasRecientes.value.size)
        detectar()
        delay(300)
        assertEquals(1, alertas)
    }

    // ---- Quién lo arranca ----

    @Test
    fun reanudarDesdeLaConsolaConUnObjetivoLoArranca() = runBlocking {
        orbitandoUnaPersona()
        consola("""{"type":"resume_patrol","orderedBy":"op"}""")
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }

        elSilencioDura(15_000)
    }

    @Test
    fun reanudarDesdeElTelefonoConUnObjetivoLoArranca() = runBlocking {
        orbitandoUnaPersona()
        patrulla.reanudarPatrullaje()
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }

        elSilencioDura(15_000)
    }

    @Test
    fun otraRutaConUnObjetivoLoArranca() = runBlocking {
        orbitandoUnaPersona()
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":1,"orderedBy":"op"}""")
        esperarA("la ruta nueva") { patrulla.state.value == PatrolState.PATROLLING && dron.ultimaOrden == "startRoute(1, 1)" }

        elSilencioDura(15_000)
    }

    @Test
    fun comenzarDesdeElTelefonoConUnObjetivoLoArranca() = runBlocking {
        orbitandoUnaPersona()
        patrulla.startPatrol(RUTA)
        esperarA("la ruta nueva") { patrulla.state.value == PatrolState.PATROLLING && dron.ultimaOrden == "startRoute(1, 0)" }

        elSilencioDura(15_000)
    }

    /** Un desvío a un nodo con un objetivo lo arranca; desde el desvío, pasado el silencio, una detección vuelve a seguir. */
    @Test
    fun unDesvioAUnNodoConUnObjetivoLoArranca() = runBlocking {
        orbitandoUnaPersona()
        consola("""{"type":"force_goto","routeId":${RUTA.id},"index":1,"orderedBy":"op"}""")
        esperarA("el desvío") { patrulla.state.value == PatrolState.FORCED }

        banco.telemetria(norteM = 400.0)
        banco.reloj.adelantar(14_000)
        detectar()
        detectar()
        delay(300)
        assertEquals(1, alertas)
        assertEquals(PatrolState.FORCED, patrulla.state.value)

        banco.reloj.adelantar(2_000)
        detectar()
        detectar()
        esperarA("la alerta nueva") { alertas == 2 }
        esperarA("la órbita desde el desvío") { patrulla.state.value == PatrolState.ORBITING }
    }

    // ---- Quién NO lo arranca ----

    @Test
    fun reanudarSinUnObjetivoNoLoArranca() = runBlocking {
        patrullando()
        consola("""{"type":"stop_patrol","orderedBy":"op"}""")
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }
        consola("""{"type":"resume_patrol","orderedBy":"op"}""")
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }

        detectar()
        detectar()
        esperarA("la alerta en el acto") { alertas == 1 }
    }

    /** Un regreso no es volver a volar solo: al tocar tierra, una detección alerta (sin seguimiento) en el acto. */
    @Test
    fun volverALaBaseNoLoArranca() = runBlocking {
        orbitandoUnaPersona()
        patrulla.volverABase()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.ArrivedHome)
        esperarA("el reposo") { patrulla.state.value == PatrolState.IDLE }

        detectar()
        detectar()
        esperarA("la alerta en el suelo, sin silencio") { alertas == 2 }
        assertTrue(banco.comando.eventos("DETECTION").single().getString("message").contains("con el dron en el suelo"))
    }

    @Test
    fun aterrizarNoLoArranca() = runBlocking {
        orbitandoUnaPersona()
        patrulla.aterrizar()
        esperarA("el aterrizaje") { "land" in dron.ordenes }

        detectar()
        detectar()
        esperarA("la alerta aterrizando, sin silencio") { alertas == 2 }
        assertTrue(banco.comando.eventos("DETECTION").single().getString("message").contains("con el dron aterrizando"))
    }
}
