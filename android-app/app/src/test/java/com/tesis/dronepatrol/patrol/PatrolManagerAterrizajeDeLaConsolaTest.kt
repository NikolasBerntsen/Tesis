package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El `land` de la consola sin el control tomado (docs/VUELO.md §9) y la
 * palanca deliberada que corta un aterrizaje sostenido (§8). El aterrizaje es
 * una orden de llegada: manda sobre la ruta, la órbita y el regreso (corta el
 * GoHome antes, como la toma del control), y lo que no discute es un failsafe
 * del DJI, la señal perdida y el descenso final de una emergencia. Con el
 * control tomado, el dron sigue bajando ante las palancas en cero y las que
 * llegan dentro de la gracia de 1,5 s; la primera deliberada después de eso lo
 * corta, lo deja estacionario a su mando y registra `LANDING_CANCELLED`.
 *
 * El dron es el espía con las órdenes de los relevos anotadas (corta el
 * regreso y el aterrizaje con nombre); el reloj del aterrizaje es el falso del
 * banco, así la gracia se prueba al milisegundo sin dormir.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerAterrizajeDeLaConsolaTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun aterrizarPorLaConsola(by: String = "op") = consola("""{"type":"land","by":"$by"}""")

    private fun tomarElControl() = consola("""{"type":"control_taken","by":"op"}""")

    private fun palanca(pitch: Double, by: String = "op") =
        consola("""{"type":"manual_stick","pitch":$pitch,"roll":0.0,"yaw":0.0,"throttle":0.0,"by":"$by"}""")

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun eventos(tipo: String) = banco.comando.eventos(tipo)

    private fun cancelados(): List<String> = eventos("LANDING_CANCELLED").map { it.getString("message") }

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

    private suspend fun enManual() {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
    }

    /** Aterrizando por la consola con el control tomado; devuelve desde qué orden mirar. */
    private suspend fun aterrizandoConElControl(): Int {
        enManual()
        aterrizarPorLaConsola()
        esperarA("el LANDING") { eventos("LANDING").isNotEmpty() }
        return dron.ordenes.size
    }

    // ---- land sin el control ----

    @Test
    fun aterrizaDesdeLaRutaSinElControl() = runBlocking {
        patrullando()
        val i = dron.ordenes.size

        aterrizarPorLaConsola("ana")
        esperarA("el LANDING") { eventos("LANDING").isNotEmpty() }

        assertEquals(listOf("land"), desde(i))
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals(
            "Aterrizaje ordenado por ana desde el Comando Central: el dron aceptó y desciende donde está",
            eventos("LANDING").single().getString("message"),
        )
        assertTrue(banco.mensajes("control_dropped").isEmpty())

        // Al tocar el suelo queda en reposo, como con el del teléfono.
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.Aterrizado)
        esperarA("el reposo") { patrulla.state.value == PatrolState.IDLE }
    }

    @Test
    fun aterrizaDesdeLaOrbitaSinElControlYCortaElSeguimiento() = runBlocking {
        orbitando()
        val i = dron.ordenes.size

        aterrizarPorLaConsola()
        esperarA("el LANDING") { eventos("LANDING").isNotEmpty() }
        esperarA("TRACKING_ENDED") { eventos("TRACKING_ENDED").isNotEmpty() }

        assertEquals(listOf("land"), desde(i))
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertTrue(eventos("TRACKING_ENDED").single().getString("message").contains("op ordenó aterrizar desde la consola"))
    }

    /** Volviendo a base con el GoHome de la app, el aterrizaje corta el regreso antes: el DJI no acepta otra orden con el GoHome puesto. */
    @Test
    fun volviendoCortaElRegresoAntesDeAterrizar() = runBlocking {
        patrullando()
        patrulla.volverABase()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        val i = dron.ordenes.size

        aterrizarPorLaConsola()
        esperarA("el LANDING") { eventos("LANDING").isNotEmpty() }

        assertEquals(listOf("cancelarRegreso", "land"), desde(i))
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
    }

    @Test
    fun volviendoPorBateriaTambienAterriza() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        val i = dron.ordenes.size

        aterrizarPorLaConsola()
        esperarA("el LANDING") { eventos("LANDING").isNotEmpty() }
        assertEquals(listOf("cancelarRegreso", "land"), desde(i))

        // Aterrizando, la batería baja no le pisa el aterrizaje con otro regreso.
        banco.telemetria(norteM = 100.0, bateria = 19.0)
        delay(200)
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals(listOf("cancelarRegreso", "land"), desde(i))
    }

    /** Con el control tomado pero el dron en una ruta que el titular mandó sin soltarlo: baja en pausa y en el suelo sigue siendo suyo. */
    @Test
    fun conElControlTomadoFueraDeManualBajaEnPausaYEnElSueloSigueTomado() = runBlocking {
        enManual()
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }

        aterrizarPorLaConsola()
        esperarA("el LANDING") { eventos("LANDING").isNotEmpty() }
        assertEquals(PatrolState.PAUSED, patrulla.state.value)

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.Aterrizado)
        esperarA("el control en el suelo") { patrulla.state.value == PatrolState.MANUAL }
        assertTrue(eventos("LANDED").single().getString("message").contains("el control manual sigue tomado"))
    }

    @Test
    fun sinSenialNoSeAterriza() = runBlocking {
        patrullando()
        banco.relojDeLaSenial.adelantar(PatrolManager.SIGNAL_TIMEOUT_MS + 1_000)
        esperarA("la señal perdida") { patrulla.state.value == PatrolState.RETURNING_HOME_SIGNAL }
        val i = dron.ordenes.size

        aterrizarPorLaConsola()
        esperarA("el registro") { registro("pero no hay señal con el dron: la orden no le llega") }

        assertEquals(emptyList<String>(), desde(i))
        assertEquals(PatrolState.RETURNING_HOME_SIGNAL, patrulla.state.value)
    }

    @Test
    fun conUnFailsafeDelDjiNoSeAterrizaYSeAvisa() = runBlocking {
        patrullando()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_DEL_CONTROL))
        esperarA("el regreso del control físico") { patrulla.state.value == PatrolState.RETURNING_HOME }
        val i = dron.ordenes.size

        aterrizarPorLaConsola()
        esperarA("el aviso") { eventos("DRONE_PROBLEM").any { it.getString("message").startsWith("No se aterriza") } }

        assertEquals(emptyList<String>(), desde(i))
        assertEquals(PatrolState.RETURNING_HOME, patrulla.state.value)
        assertTrue(eventos("DRONE_PROBLEM").last().getString("message").contains("control físico"))
    }

    // ---- La palanca deliberada corta el aterrizaje (VUELO §8) ----

    @Test
    fun laPalancaDeliberadaPasadaLaGraciaCortaElAterrizajeYSeAplica() = runBlocking {
        val i = aterrizandoConElControl()
        banco.reloj.adelantar(PatrolManager.GRACIA_DEL_ATERRIZAJE_MS)

        palanca(1.0)
        esperarA("el corte") { cancelados().isNotEmpty() }

        assertEquals(listOf("cancelarAterrizaje", "hold", "stick(1.0, 0.0, 0.0, 0.0)"), desde(i))
        assertEquals(listOf("op movió las palancas: el aterrizaje se corta y el dron queda a su mando"), cancelados())
        assertEquals(PatrolState.MANUAL, patrulla.state.value)

        // El que sigue es mando común: ni otro corte ni otro aviso.
        palanca(0.5)
        delay(200)
        assertEquals("stick(0.5, 0.0, 0.0, 0.0)", dron.ultimaOrden)
        assertEquals(1, cancelados().size)
    }

    @Test
    fun unaPalancaEnCeroOAntesDeLaGraciaNoLoCorta() = runBlocking {
        val i = aterrizandoConElControl()

        palanca(0.0)
        banco.reloj.adelantar(PatrolManager.GRACIA_DEL_ATERRIZAJE_MS - 500)
        palanca(1.0)
        palanca(0.0)
        delay(300)

        assertEquals("sigue bajando, sin una orden más: ${desde(i)}", emptyList<String>(), desde(i))
        assertTrue(cancelados().isEmpty())

        // Justo al cumplirse la gracia ya cuenta.
        banco.reloj.adelantar(500)
        palanca(1.0)
        esperarA("el corte") { cancelados().isNotEmpty() }
        assertEquals(listOf("cancelarAterrizaje", "hold", "stick(1.0, 0.0, 0.0, 0.0)"), desde(i))
    }

    @Test
    fun unSaltoDelPadTambienLoCorta() = runBlocking {
        val i = aterrizandoConElControl()
        banco.reloj.adelantar(PatrolManager.GRACIA_DEL_ATERRIZAJE_MS + 100)

        consola("""{"type":"manual_move","bearing":0,"distanceM":25,"by":"op"}""")
        esperarA("el corte") { cancelados().isNotEmpty() }

        assertEquals(listOf("cancelarAterrizaje", "hold", "gotoPoint"), desde(i))
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
    }

    /** Sin el control tomado no hay persona al mando: la palanca se descarta como siempre, y el dron baja. */
    @Test
    fun sinElControlLaPalancaNoCortaElAterrizajeDelCampo() = runBlocking {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.aterrizar()
        esperarA("el LANDING") { eventos("LANDING").isNotEmpty() }
        val i = dron.ordenes.size
        banco.reloj.adelantar(PatrolManager.GRACIA_DEL_ATERRIZAJE_MS + 1_000)

        palanca(1.0)
        delay(300)

        assertEquals(emptyList<String>(), desde(i))
        assertTrue(cancelados().isEmpty())
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
    }

    /** Tomar el control durante un aterrizaje del campo y mover la palanca: la gracia cuenta desde la orden de aterrizar. */
    @Test
    fun conElControlTomadoDuranteUnAterrizajeDelCampoLaPalancaLoCortaYPasaAManual() = runBlocking {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.aterrizar()
        esperarA("el LANDING") { eventos("LANDING").isNotEmpty() }
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        val i = dron.ordenes.size
        banco.reloj.adelantar(PatrolManager.GRACIA_DEL_ATERRIZAJE_MS)

        palanca(1.0)
        esperarA("el corte") { cancelados().isNotEmpty() }

        assertEquals(listOf("cancelarAterrizaje", "hold", "stick(1.0, 0.0, 0.0, 0.0)"), desde(i))
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
    }

    /**
     * El descenso final de una emergencia no se discute (VUELO §1 y §4): ni el
     * `land` de la consola (ya aterriza: un `land` repetido le volvería a
     * empezar la secuencia al DJI) ni, con el control tomado, la palanca.
     */
    @Test
    fun enElDescensoDeUnaEmergenciaNiElLandNiLaPalancaLoTocan() = runBlocking {
        dron.estado.value = dron.estado.value.copy(umbralCriticoPct = 10.0)
        dron.confirmarCamaraYRumbo = true
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 1_500.0, bateria = 60.0, pctParaVolver = 20.0, pctParaAterrizar = 2.0)
        patrulla.startPatrol(RUTA)
        esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
        banco.telemetria(norteM = 1_500.0, bateria = 12.0, pctParaVolver = 20.0, pctParaAterrizar = 2.0)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        esperarA("el aterrizaje al final de la secuencia", topeMs = 10_000) { "land" in dron.ordenes }
        esperarA("el aterrizaje sostenido") { registro("El dron aceptó el aterrizaje de emergencia") }
        val i = dron.ordenes.size

        aterrizarPorLaConsola()
        esperarA("el rechazo") { registro("pero el dron ya está bajando en el aterrizaje de emergencia") }
        assertEquals(PatrolState.ATERRIZAJE_EMERGENCIA, patrulla.state.value)

        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        banco.reloj.adelantar(PatrolManager.GRACIA_DEL_ATERRIZAJE_MS + 1_000)
        palanca(1.0)
        aterrizarPorLaConsola()
        esperarA("el segundo rechazo") {
            patrulla.localLog.replayCache.count { it.contains("pero el dron ya está bajando en el aterrizaje de emergencia") } == 2
        }
        delay(200)

        // Tomar el control aterrizando no frena (no hay estacionario) y entrar a MANUAL no toca la cámara.
        assertEquals("sigue bajando, sin una orden más: ${desde(i)}", emptyList<String>(), desde(i))
        assertTrue(cancelados().isEmpty())
        assertFalse("cancelarAterrizaje" in dron.ordenes)
        assertTrue("ningún LANDING de la consola", eventos("LANDING").none { it.getString("message").contains("desde el Comando Central") })
    }

    /** Con el control tomado y el dron bajando en la pausa (una ruta sin soltar y después «Aterrizar»), la palanca lo corta y pasa a MANUAL. */
    @Test
    fun conElControlTomadoEnLaPausaDelAterrizajeLaPalancaLoCortaYPasaAManual() = runBlocking {
        enManual()
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        aterrizarPorLaConsola()
        esperarA("el LANDING") { eventos("LANDING").isNotEmpty() }
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        val i = dron.ordenes.size
        banco.reloj.adelantar(PatrolManager.GRACIA_DEL_ATERRIZAJE_MS)

        palanca(0.6)
        esperarA("el corte") { cancelados().isNotEmpty() }

        assertEquals(listOf("cancelarAterrizaje", "hold", "stick(0.6, 0.0, 0.0, 0.0)"), desde(i))
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
    }
}
