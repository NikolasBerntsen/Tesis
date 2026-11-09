package com.tesis.dronepatrol.patrol

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
 * Las órdenes de una persona que NO se cumplen, y que la consola se entere
 * (docs/VUELO.md §4, las filas «Regreso por señal» y «Emergencia §5
 * bajando»). Con el dron ya bajando en el aterrizaje de emergencia no se toma
 * el control, no se vuelve a la base y no sale ninguna orden de vuelo, ni de
 * la consola ni del teléfono: cada una dice «No se cumple la orden (…): el
 * dron está aterrizando de emergencia en su última ubicación». Sin señal con
 * el dron, «Volver a base», otra ruta, un desvío y reanudar tampoco: la
 * orden no le llega y el DJI vuelve solo; tomar el control sí, y se aplica al
 * volver la señal.
 *
 * El §5 corre entero con el reloj falso del banco, como en
 * PatrolManagerUltimaUbicacionTest: lejos de toda base, la batería cae al
 * disparo y la secuencia termina pidiendo aterrizar.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerOrdenesRechazadasTest {

    private companion object {
        const val BAJANDO = "el dron está aterrizando de emergencia en su última ubicación"
        const val SIN_SENIAL = "sin señal con el dron, el DJI vuelve solo"
        const val RUTA_POR_ANA = """{"type":"start_route","routeId":1,"fromIndex":1,"orderedBy":"ana"}"""
        const val NODO_POR_ANA = """{"type":"force_goto","routeId":1,"index":1,"orderedBy":"ana"}"""
    }

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun tomarElControl(by: String = "op") = consola("""{"type":"control_taken","by":"$by"}""")

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun problemas(): List<String> = banco.comando.eventos("DRONE_PROBLEM").map { it.getString("message") }

    private fun registro(texto: String) = patrulla.localLog.replayCache.any { it.contains(texto) }

    private suspend fun noSeCumple(orden: String, porque: String) {
        val texto = "No se cumple la orden ($orden): $porque"
        esperarA(texto) { texto in problemas() }
    }

    private suspend fun telemetria(bateria: Double) =
        banco.telemetria(norteM = 1_500.0, bateria = bateria, pctParaVolver = 20.0, pctParaAterrizar = 2.0)

    /** Lejos de toda base la batería cae al disparo: el §5 fotografía y termina pidiendo aterrizar. */
    private suspend fun enLaEmergencia(confirma: Boolean = true) {
        dron.estado.value = dron.estado.value.copy(umbralCriticoPct = 10.0)
        dron.confirmarCamaraYRumbo = confirma
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        telemetria(bateria = 60.0)
        patrulla.availableRoutes = listOf(RUTA)
        patrulla.startPatrol(RUTA)
        esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
        telemetria(bateria = 12.0)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
    }

    private suspend fun bajandoEnLaEmergencia() {
        enLaEmergencia()
        esperarA("el aterrizaje al final de la secuencia", topeMs = 10_000) { "land" in dron.ordenes }
        esperarA("el aterrizaje sostenido") { registro("El dron aceptó el aterrizaje de emergencia") }
    }

    private suspend fun sinSenial() {
        banco.relojDeLaSenial.adelantar(PatrolManager.SIGNAL_TIMEOUT_MS + 1_000)
        esperarA("la señal perdida", topeMs = 3_000) { patrulla.state.value == PatrolState.RETURNING_HOME_SIGNAL }
    }

    // ---- Bajando en el aterrizaje de emergencia ----

    @Test
    fun bajandoEnLaEmergenciaNingunaOrdenDeVueloSeCumpleYCadaUnaDicePorQue() = runBlocking {
        bajandoEnLaEmergencia()
        val i = dron.ordenes.size

        consola("""{"type":"return_home","by":"ana"}""")
        noSeCumple("ana ordenó volver a la base desde el Comando Central", BAJANDO)
        consola(RUTA_POR_ANA)
        noSeCumple("ana ordenó patrullar la ruta \"Perímetro norte\"", BAJANDO)
        consola(NODO_POR_ANA)
        noSeCumple("ana ordenó ir al nodo 2", BAJANDO)
        consola("""{"type":"stop_patrol","orderedBy":"ana"}""")
        noSeCumple("ana ordenó detenerse", BAJANDO)
        consola("""{"type":"resume_patrol","orderedBy":"ana"}""")
        noSeCumple("el operador ordenó reanudar", BAJANDO)
        patrulla.volverABase()
        noSeCumple("el operador de campo ordenó volver a la base", BAJANDO)
        patrulla.startPatrol(RUTA)
        noSeCumple("el operador de campo ordenó patrullar la ruta \"Perímetro norte\"", BAJANDO)
        patrulla.detenerPatrullaje()
        noSeCumple("el operador de campo ordenó detenerse", BAJANDO)
        patrulla.reanudarPatrullaje()
        noSeCumple("el operador de campo ordenó reanudar", BAJANDO)
        delay(200)

        assertEquals("sigue bajando, sin una orden más: ${desde(i)}", emptyList<String>(), desde(i))
        assertEquals(PatrolState.ATERRIZAJE_EMERGENCIA, patrulla.state.value)
        assertTrue("ningún regreso", banco.comando.eventos("RTH_MANUAL").isEmpty())
    }

    /**
     * Con el control tomado en las fotos y el dron bajando por el «Aterrizar» de
     * esa persona, `return_home` tampoco se cumple. El hub igual soltó el lock:
     * la app suelta el control y el dron queda en la pausa del aterrizaje, sin
     * una orden más.
     */
    @Test
    fun conElControlTomadoYBajandoElReturnHomeSueltaElControlYNoSeCumple() = runBlocking {
        enLaEmergencia(confirma = false)
        esperarA("la cenital, que no se confirma") { "apuntar(-90.0)" in dron.ordenes }
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        consola("""{"type":"land","by":"op"}""")
        esperarA("el aterrizaje") { "land" in dron.ordenes }
        val i = dron.ordenes.size
        // Es el descenso de la emergencia: ni pasada la gracia la palanca lo corta.
        banco.reloj.adelantar(PatrolManager.GRACIA_DEL_ATERRIZAJE_MS + 1_000)
        consola("""{"type":"manual_stick","pitch":1.0,"roll":0.0,"yaw":0.0,"throttle":0.0,"by":"op"}""")
        delay(200)
        assertEquals("ni corte ni palanca: ${desde(i)}", emptyList<String>(), desde(i))
        assertTrue(banco.comando.eventos("LANDING_CANCELLED").isEmpty())

        consola("""{"type":"return_home","by":"op"}""")
        noSeCumple("op ordenó volver a la base desde el Comando Central", BAJANDO)

        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals("salir de MANUAL solo tira la inclinación de la consola", listOf(DronEspia.CANCELAR_CAMARA), desde(i))
        assertTrue(registro("El control manual queda suelto: el Comando Central ya soltó el lock con la orden"))
        assertTrue("el hub ya lo soltó: no se le avisa", banco.mensajes("control_dropped").isEmpty())
    }

    // ---- Sin señal con el dron ----

    @Test
    fun sinSenialNiVolverABaseNiOtraRutaNiUnDesvioNiReanudarSeCumplen() = runBlocking {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":1,"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        sinSenial()
        val i = dron.ordenes.size

        patrulla.volverABase()
        noSeCumple("el operador de campo ordenó volver a la base", SIN_SENIAL)
        consola(RUTA_POR_ANA)
        noSeCumple("ana ordenó patrullar la ruta \"Perímetro norte\"", SIN_SENIAL)
        consola(NODO_POR_ANA)
        noSeCumple("ana ordenó ir al nodo 2", SIN_SENIAL)
        consola("""{"type":"resume_patrol","orderedBy":"ana"}""")
        noSeCumple("el operador ordenó reanudar", SIN_SENIAL)
        patrulla.reanudarPatrullaje()
        noSeCumple("el operador de campo ordenó reanudar", SIN_SENIAL)
        patrulla.startPatrol(RUTA)
        noSeCumple("el operador de campo ordenó patrullar la ruta \"Perímetro norte\"", SIN_SENIAL)
        delay(200)

        assertEquals("sin señal no se le ordena nada: ${desde(i)}", emptyList<String>(), desde(i))
        assertEquals(PatrolState.RETURNING_HOME_SIGNAL, patrulla.state.value)

        // Tomar el control sí: queda tomado y se aplica al volver la señal.
        tomarElControl()
        delay(100)
        banco.telemetria(norteM = 100.0)
        esperarA("el control al volver la señal") { patrulla.state.value == PatrolState.MANUAL }
    }
}
