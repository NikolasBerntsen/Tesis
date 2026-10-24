package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El control manual que se queda sin nadie al mando, y el que cambia de manos
 * (docs/PROTOCOLS.md §2): el hub lo suelta porque el titular estuvo 30 s sin
 * dar señales, la app lo suelta sola porque estuvo 30 s sin el Comando Central,
 * el titular se lo pasa a otro sin soltarlo, y al reconectarse los dos lados
 * se ponen de acuerdo sobre quién lo tiene.
 *
 * Lo que se mira es qué le queda ordenado al dron (el espía anota cada orden),
 * el estado, y lo que la app le contesta al hub (`control_dropped`). Los 30 s
 * de la app corren con el reloj falso del banco, sin esperarlos.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerControlSinNadieAlMandoTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun palanca(pitch: Double) =
        consola("""{"type":"manual_stick","pitch":$pitch,"roll":0.0,"yaw":0.0,"throttle":0.0,"by":"op"}""")

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun registro(texto: String) = patrulla.localLog.replayCache.any { it.contains(texto) }

    private fun soltados(): List<JSONObject> = banco.mensajes("control_dropped")

    /** En el aire, con el control de op tomado; devuelve desde qué orden mirar. */
    private suspend fun enManual(): Int {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        consola("""{"type":"control_taken","by":"op"}""")
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        return dron.ordenes.size
    }

    /** El enlace con el Comando Central se corta (el cliente lo avisa por `connected`). */
    private suspend fun sinComandoCentral() {
        banco.comando.connected.value = false
        delay(100)
    }

    // ---- El hub lo suelta: el titular estuvo 30 s sin señales ----

    @Test
    fun soltadoPorInactividadQuedaQuietoYConElMandoEnElControlFisico() = runBlocking {
        enManual()
        palanca(1.0)
        val i = dron.ordenes.size

        consola("""{"type":"control_released","by":"Comando Central","motivo":"inactividad"}""")
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }
        delay(PatrolManager.MANDO_TIMEOUT_MS + 500)

        // Ni el estacionario del Virtual Stick ni el cero del watchdog después:
        // el mando es del control físico, y el dron frena solo.
        assertEquals(listOf(DronEspia.CANCELAR_CAMARA, DronEspia.DEVOLVER_EL_MANDO), desde(i))
        assertTrue(registro("estuvo 30 s sin dar señales"))
        assertTrue(registro("el mando vuelve al control físico"))
        // Y no sale a patrullar solo: lo hace un resume_patrol de la consola.
        assertTrue(banco.mensajes("event").none { it.optString("eventType") == "PATROL_STARTED" })
    }

    @Test
    fun desdeAhiLaConsolaLoPuedeVolverATomarOMandarAPatrullar() = runBlocking {
        enManual()
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"control_released","by":"Comando Central","motivo":"inactividad"}""")
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }

        consola("""{"type":"control_taken","by":"otro"}""")
        esperarA("el control de nuevo") { patrulla.state.value == PatrolState.MANUAL }
        assertEquals("hold", dron.ordenes.last())

        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"otro"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
    }

    /** Aterrizando, soltar el control nunca es otra orden: sigue bajando, y el mando no se toca. */
    @Test
    fun soltadoPorInactividadAterrizandoSigueBajando() = runBlocking {
        enManual()
        consola("""{"type":"land","by":"op"}""")
        esperarA("el LANDING") { banco.comando.eventos("LANDING").isNotEmpty() }
        val i = dron.ordenes.size

        consola("""{"type":"control_released","by":"Comando Central","motivo":"inactividad"}""")
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }
        delay(200)

        assertEquals(listOf(DronEspia.CANCELAR_CAMARA), desde(i))
        assertTrue(registro("El dron sigue aterrizando hasta el suelo"))
    }

    @Test
    fun soltadoPorInactividadEnElSueloQuedaEnReposo() = runBlocking {
        enManual()
        banco.enElSuelo()
        val i = dron.ordenes.size

        consola("""{"type":"control_released","by":"Comando Central","motivo":"inactividad"}""")
        esperarA("el reposo") { patrulla.state.value == PatrolState.IDLE }

        assertFalse(DronEspia.DEVOLVER_EL_MANDO in desde(i))
    }

    @Test
    fun soltadoPorInactividadSinElControlTomadoNoEsNuestro() = runBlocking {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        val i = dron.ordenes.size

        consola("""{"type":"control_released","by":"Comando Central","motivo":"inactividad"}""")
        delay(200)

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
    }

    // ---- La app lo suelta sola: 30 s sin el Comando Central ----

    @Test
    fun treintaSegundosSinElComandoCentralLoSueltaSolaYAlVolverSeLoDice() = runBlocking {
        val i = enManual()
        sinComandoCentral()

        banco.pasar(PatrolManager.CONTROL_SIN_COMANDO_CENTRAL_MS - 1_000)
        assertEquals("a los 29 s sigue esperando", PatrolState.MANUAL, patrulla.state.value)
        banco.pasar(1_000)
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }
        assertEquals(DronEspia.DEVOLVER_EL_MANDO, dron.ultimaOrden)
        assertTrue(registro("Hace 30 s que no hay enlace con el Comando Central"))
        val hastaAca = dron.ordenes.size

        // Vuelve el enlace y el hub, que todavía cree que op lo tiene, se lo dice.
        banco.comando.connected.value = true
        delay(100)
        consola("""{"type":"control_taken","by":"op","resync":true}""")
        esperarA("el aviso al hub") { soltados().isNotEmpty() }

        val aviso = soltados().single()
        assertEquals("op", aviso.getString("by"))
        assertEquals("la app soltó el control sola: estuvo 30 s sin enlace con el Comando Central", aviso.getString("motivo"))
        // No lo vuelve a tomar: el mando sigue en el control físico.
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(hastaAca))
        assertTrue("el primer tramo no tocó el mando: ${desde(i)}", desde(i).none { it == "hold" })
    }

    @Test
    fun siElEnlaceVuelveAntesDeLosTreintaSegundosNoPasaNada() = runBlocking {
        val i = enManual()
        sinComandoCentral()
        banco.pasar(PatrolManager.CONTROL_SIN_COMANDO_CENTRAL_MS - 5_000)
        banco.comando.connected.value = true
        delay(100)
        banco.pasar(10_000)

        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
    }

    @Test
    fun sinElControlTomadoPerderElComandoCentralNoSueltaNada() = runBlocking {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        val i = dron.ordenes.size
        sinComandoCentral()
        banco.pasar(PatrolManager.CONTROL_SIN_COMANDO_CENTRAL_MS + 1_000)

        assertEquals(emptyList<String>(), desde(i))
        assertFalse(registro("la app lo suelta"))
    }

    // ---- La reconexión: el hub dice quién lo tiene ----

    /** Ya lo tenía: no es una toma nueva, ni frena ni cambia de estado. */
    @Test
    fun laReconexionConElControlTomadoNoLeDaNingunaOrden() = runBlocking {
        val i = enManual()

        consola("""{"type":"control_taken","by":"op","resync":true}""")
        esperarA("la confirmación") { registro("El Comando Central confirma que op sigue con el control manual") }

        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
        assertTrue(soltados().isEmpty())
    }

    /** La ruta que el titular le mandó sin soltar el control tampoco se la saca. */
    @Test
    fun laReconexionNoLeSacaLaRutaAlQueLaMandoSinSoltar() = runBlocking {
        enManual()
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        val i = dron.ordenes.size

        consola("""{"type":"control_taken","by":"op","resync":true}""")
        delay(200)

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
    }

    /** No lo tenía (la app se reinició): no lo toma, le pide al hub que lo suelte. */
    @Test
    fun laReconexionSinElControlTomadoNoLoTomaYLePideAlHubQueLoSuelte() = runBlocking {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        val i = dron.ordenes.size

        consola("""{"type":"control_taken","by":"op","resync":true}""")
        esperarA("el aviso al hub") { soltados().isNotEmpty() }

        assertEquals("la app no tenía el control tomado al reconectarse", soltados().single().getString("motivo"))
        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
    }

    // ---- El traspaso: el control pasa de una persona a otra sin soltarse ----

    @Test
    fun elTraspasoDejaAlDronEnManualQuietoParaElNuevoTitular() = runBlocking {
        enManual()
        // El anterior dejó la palanca a fondo: su cero ya no va a pasar por el hub.
        palanca(1.0)
        val i = dron.ordenes.size

        consola("""{"type":"control_transferred","by":"nuevo","de":"op"}""")
        esperarA("el freno") { "hold" in desde(i) }
        delay(PatrolManager.MANDO_TIMEOUT_MS + 500)

        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        // Solo el freno: sin salir de MANUAL (nada de soltar la cámara) y sin el
        // cero del watchdog más tarde, que las marcas del mando ya se limpiaron.
        assertEquals(listOf("hold"), desde(i))
        assertTrue(registro("op le pasó el control manual a nuevo"))

        // El nuevo titular pilotea en el acto.
        palanca(0.5)
        esperarA("el mando del nuevo") { dron.ultimaOrden == "stick(0.5, 0.0, 0.0, 0.0)" }
    }

    @Test
    fun elTraspasoNoLeCortaElAterrizajeNiLaRuta() = runBlocking {
        enManual()
        consola("""{"type":"land","by":"op"}""")
        esperarA("el LANDING") { banco.comando.eventos("LANDING").isNotEmpty() }
        val i = dron.ordenes.size
        consola("""{"type":"control_transferred","by":"nuevo","de":"op"}""")
        delay(200)
        assertEquals(emptyList<String>(), desde(i))
        assertEquals(PatrolState.MANUAL, patrulla.state.value)

        // Una ruta que el titular mandó sin soltar el control sigue con el nuevo.
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"nuevo"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        val j = dron.ordenes.size
        consola("""{"type":"control_transferred","by":"tercero","de":"nuevo"}""")
        delay(200)
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(j))
    }

    /** En el suelo no hay nada que frenar: el control cambia de manos y nada más. */
    @Test
    fun elTraspasoEnElSueloNoLeDaNingunaOrden() = runBlocking {
        enManual()
        banco.enElSuelo()
        val i = dron.ordenes.size
        consola("""{"type":"control_transferred","by":"nuevo","de":"op"}""")
        esperarA("el traspaso") { registro("op le pasó el control manual a nuevo") }
        delay(100)
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
    }

    @Test
    fun elTraspasoDeUnControlQueLaAppNoTieneTomadoSeLeAvisaAlHub() = runBlocking {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        val i = dron.ordenes.size

        consola("""{"type":"control_transferred","by":"nuevo","de":"op"}""")
        esperarA("el aviso al hub") { soltados().isNotEmpty() }

        val aviso = soltados().single()
        assertEquals("nuevo", aviso.getString("by"))
        assertEquals("la app no tenía el control tomado cuando op se lo pasó", aviso.getString("motivo"))
        assertEquals(emptyList<String>(), desde(i))
    }
}
