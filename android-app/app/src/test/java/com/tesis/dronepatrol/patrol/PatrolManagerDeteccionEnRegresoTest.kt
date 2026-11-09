package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Volviendo a base o aterrizando de emergencia, una detección no le da al dron
 * ni una orden (docs/VUELO.md §1, el primer corolario, y §7.3): ni órbita, ni
 * seguimiento, ni alerta; solo las cajas en el video. Es lo que pasó en el
 * campo: el estado decía que volvía y el dron seguía queriendo orbitar.
 *
 * Se prueba en cada estado de regreso, siempre partiendo de un objetivo en
 * curso: el regreso lo termina antes (TRACKING_ENDED), así que no queda un
 * rastreador que una detección pudiera actualizar, y el lazo del seguimiento,
 * que corre cada medio segundo, tampoco encuentra nada que comandar.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerDeteccionEnRegresoTest {

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

    private suspend fun patrullando(norteM: Double = 100.0, bateria: Double = 100.0) {
        banco.arrancar()
        banco.telemetria(norteM = norteM, bateria = bateria)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
    }

    private suspend fun orbitando() {
        patrullando()
        detectar()
        detectar()
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        esperarA("la alerta") { banco.comando.alertas.size == 1 }
    }

    /**
     * Ya en el regreso: no quedó objetivo, y dos detecciones seguidas (las que
     * confirmarían) más el lazo del seguimiento no le dan al dron ninguna orden
     * ni suman alertas; las cajas sí se entregan.
     */
    private suspend fun lasDeteccionesNoOrdenanNada(estado: PatrolState) {
        assertEquals(estado, patrulla.state.value)
        esperarA("el fin del seguimiento") { banco.comando.eventos("TRACKING_ENDED").isNotEmpty() }
        assertNull("el regreso terminó el seguimiento: no hay rastreador que actualizar", patrulla.objetivo)
        val i = dron.ordenes.size

        detectar()
        detectar()
        banco.reloj.adelantar(500)
        delay(700)
        detectar()
        delay(300)

        assertEquals("ni una orden por las detecciones: ${dron.ordenes.drop(i)}", emptyList<String>(), dron.ordenes.drop(i))
        assertEquals("ni una alerta nueva", 1, banco.comando.alertas.size)
        assertNull(patrulla.objetivo)
        assertEquals("las cajas sí se dibujan", 1, patrulla.cajasRecientes.value.size)
        assertEquals(estado, patrulla.state.value)
    }

    @Test
    fun volviendoPorOrdenDelCampo() = runBlocking {
        orbitando()
        patrulla.volverABase()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        lasDeteccionesNoOrdenanNada(PatrolState.RETURNING_HOME)
    }

    @Test
    fun volviendoPorOrdenDeLaConsola() = runBlocking {
        orbitando()
        consola("""{"type":"return_home","by":"op"}""")
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        lasDeteccionesNoOrdenanNada(PatrolState.RETURNING_HOME)
    }

    @Test
    fun volviendoPorBateria() = runBlocking {
        orbitando()
        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        lasDeteccionesNoOrdenanNada(PatrolState.RETURNING_HOME_BATTERY)
    }

    @Test
    fun volviendoPorSenial() = runBlocking {
        orbitando()
        banco.relojDeLaSenial.adelantar(PatrolManager.SIGNAL_TIMEOUT_MS + 1_000)
        esperarA("la señal perdida") { patrulla.state.value == PatrolState.RETURNING_HOME_SIGNAL }
        lasDeteccionesNoOrdenanNada(PatrolState.RETURNING_HOME_SIGNAL)
    }

    @Test
    fun enElAterrizajeDeEmergencia() = runBlocking {
        dron.estado.value = dron.estado.value.copy(umbralCriticoPct = 10.0)
        dron.confirmarCamaraYRumbo = true
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 1_500.0, bateria = 60.0, pctParaVolver = 20.0, pctParaAterrizar = 2.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        detectar()
        detectar()
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        esperarA("la alerta") { banco.comando.alertas.size == 1 }

        banco.telemetria(norteM = 1_500.0, bateria = 12.0, pctParaVolver = 20.0, pctParaAterrizar = 2.0)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        // Con la secuencia de fotos terminada, lo único que puede ordenar algo es una detección: nada.
        esperarA("el aterrizaje al final de la secuencia", topeMs = 10_000) { "land" in dron.ordenes }
        lasDeteccionesNoOrdenanNada(PatrolState.ATERRIZAJE_EMERGENCIA)
    }
}
