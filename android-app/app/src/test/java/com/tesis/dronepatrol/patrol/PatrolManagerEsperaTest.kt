package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
 * El interruptor «En espera para relevos» (docs/RELEVOS.md §0) y lo que el
 * status le cuenta al hub (docs/PROTOCOLS.md §1): `relevo`, `autonomia` y las
 * componentes de la velocidad del objetivo. El interruptor se prende solo con
 * lo que el operador revisó —el dron en el suelo, enlazado, en reposo— y se
 * apaga solo por cualquier cosa que cambie eso.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerEsperaTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private suspend fun enTierra(bateria: Double = 95.0) {
        banco.enElSuelo()
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 5.0, bateria = bateria, alt = 0.0)
    }

    private suspend fun prendido() {
        enTierra()
        assertTrue(patrulla.ponerEnEspera(true))
        assertTrue(patrulla.enEspera.value)
    }

    private fun relevoDelStatus(): JSONObject? = banco.mensajes("status").lastOrNull()?.optJSONObject("relevo")

    /** El aviso sale también al registro local, que guarda los últimos: no se pierde por llegar tarde a mirarlo. */
    private suspend fun esperarQueSeApague(porque: String) {
        withTimeout(5_000) { patrulla.localLog.first { it.contains("se apagó") && it.contains(porque) } }
        assertFalse(patrulla.enEspera.value)
    }

    @Test
    fun seAnunciaEnElStatusYConTodoEnRegloEstaDisponible() = runBlocking {
        prendido()
        esperarA("el status disponible") { relevoDelStatus()?.optBoolean("disponible") == true }
        val r = relevoDelStatus()!!
        assertTrue(r.getBoolean("enEspera"))
        assertTrue(r.isNull("relayId") && r.isNull("rol") && r.isNull("fase"))
    }

    @Test
    fun conPocaBateriaEstaEnEsperaPeroNoDisponible() = runBlocking {
        enTierra(bateria = 55.0)
        assertTrue(patrulla.ponerEnEspera(true))
        esperarA("el status en espera") { relevoDelStatus()?.optBoolean("enEspera") == true }
        assertFalse(relevoDelStatus()!!.getBoolean("disponible"))
    }

    @Test
    fun noSePrendeEnElAireNiSinEnlaceNiFueraDeReposo() = runBlocking {
        banco.arrancar()
        banco.telemetria(norteM = 5.0, bateria = 95.0)
        assertFalse("en el aire", patrulla.ponerEnEspera(true))

        banco.enElSuelo()
        dron.estado.value = dron.estado.value.copy(conectado = false)
        delay(60)
        assertFalse("sin el dron", patrulla.ponerEnEspera(true))

        dron.estado.value = dron.estado.value.copy(conectado = true)
        banco.comando.connected.value = false
        delay(60)
        assertFalse("sin el Comando Central", patrulla.ponerEnEspera(true))

        banco.comando.connected.value = true
        banco.comando.recibir(JSONObject().put("type", "control_taken").put("by", "op"))
        esperarA("el control") { patrulla.state.value == PatrolState.MANUAL }
        assertFalse("con una orden en curso", patrulla.ponerEnEspera(true))
        assertFalse(patrulla.enEspera.value)
        // Apagarlo se puede siempre.
        assertTrue(patrulla.ponerEnEspera(false))
    }

    @Test
    fun seApagaAlDespegar() = runBlocking {
        prendido()
        banco.evento(FlightEvent.Despegando)
        esperarQueSeApague("despegó")
    }

    @Test
    fun seApagaAlAterrizar() = runBlocking {
        prendido()
        banco.evento(FlightEvent.Aterrizado)
        esperarQueSeApague("aterrizó")
    }

    @Test
    fun seApagaAlCambiarLaBateria() = runBlocking {
        prendido()
        banco.telemetria(norteM = 5.0, bateria = 30.0, alt = 0.0)
        assertTrue("una batería que baja es la misma", patrulla.enEspera.value)
        banco.telemetria(norteM = 5.0, bateria = 99.0, alt = 0.0)
        esperarQueSeApague("batería")
    }

    @Test
    fun seApagaConElRecargarDelSimulador() = runBlocking {
        prendido()
        patrulla.onBatteryRecharged()
        esperarQueSeApague("batería")
    }

    @Test
    fun seApagaAlPerderElDron() = runBlocking {
        prendido()
        dron.estado.value = dron.estado.value.copy(conectado = false)
        esperarQueSeApague("enlace con el dron")
    }

    @Test
    fun seApagaAlPerderElComandoCentral() = runBlocking {
        prendido()
        banco.comando.connected.value = false
        esperarQueSeApague("Comando Central")
    }

    @Test
    fun seApagaAlCerrarLaPantalla() = runBlocking {
        prendido()
        patrulla.alCerrarLaPantalla()
        esperarQueSeApague("pantalla")
    }

    @Test
    fun seApagaALosTreintaMinutos() = runBlocking {
        prendido()
        banco.pasar(EsperaParaRelevos.VENCIMIENTO_MS - 1_000)
        assertTrue(patrulla.enEspera.value)
        banco.pasar(1_000)
        esperarQueSeApague("30 minutos")
    }

    @Test
    fun elOperadorLoApagaCuandoQuiere() = runBlocking {
        prendido()
        assertTrue(patrulla.ponerEnEspera(false))
        assertFalse(patrulla.enEspera.value)
        esperarA("el status sin espera") { relevoDelStatus()?.optBoolean("enEspera") == false }
        // Prenderlo dos veces no lo vuelve a anunciar ni reinicia nada.
        assertTrue(patrulla.ponerEnEspera(true))
        assertTrue(patrulla.ponerEnEspera(true))
    }

    // ---- autonomia y target en el status ----

    @Test
    fun laAutonomiaVaEnElStatusConNullLoQueNoSeSabe() = runBlocking {
        banco.arrancar()
        banco.telemetria(norteM = 100.0, bateria = 70.0, pctParaVolver = 12.5, alcanceM = 2_400.0)
        esperarA("el status con autonomía") { banco.mensajes("status").lastOrNull()?.has("autonomia") == true }
        val a = banco.ultimo("status").getJSONObject("autonomia")
        assertEquals(12.5, a.getDouble("pctParaVolver"), 1e-9)
        assertEquals(2_400.0, a.getDouble("alcanceM"), 1e-9)
        assertTrue("NaN es no se sabe, y sale null", a.isNull("pctParaAterrizar") && a.isNull("segundosParaVolver"))
    }

    @Test
    fun elObjetivoDelStatusLlevaLaVelocidadEnComponentes() = runBlocking {
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 300.0, bateria = 60.0)
        patrulla.startPatrol(RUTA)
        esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
        val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), null, 1L)
        banco.deteccion.onDetection?.invoke(persona)
        delay(60)
        banco.deteccion.onDetection?.invoke(persona)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        esperarA("el status con el objetivo") { banco.mensajes("status").lastOrNull()?.opt("target") is JSONObject }
        val target = banco.ultimo("status").getJSONObject("target")
        assertEquals("quieto: cero y cero", 0.0, target.getDouble("vNorteMs"), 1e-9)
        assertEquals(0.0, target.getDouble("vEsteMs"), 1e-9)
    }
}
