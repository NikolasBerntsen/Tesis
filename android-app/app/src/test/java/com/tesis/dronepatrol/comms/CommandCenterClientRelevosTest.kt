package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.model.ObjetivoReportado
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONObject
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
 * El cliente del Comando Central con los relevos (docs/PROTOCOLS.md §1, §1.b y
 * §2.b): los mensajes de §2.b se validan en un solo lugar y salen con tipo, uno
 * inválido solo se anota, el resto de los mensajes sigue por su camino de
 * siempre, y el status lleva `relevo`, `autonomia` y la velocidad del objetivo
 * en componentes. Usa Robolectric por org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CommandCenterClientRelevosTest {

    private val alcance = CoroutineScope(SupervisorJob())

    private val enviados = mutableListOf<JSONObject>()

    private val cliente = object : CommandCenterClient(alcance) {
        override fun send(obj: JSONObject) {
            enviados += JSONObject(obj.toString())
        }
    }

    @After
    fun cortar() {
        alcance.cancel()
    }

    @Test
    fun losMensajesDeRelevosSalenValidadosYConTipo() {
        val recibidos = mutableListOf<MensajeDelHub>()
        val invalidos = mutableListOf<String>()
        cliente.onMensajeDelHub = { recibidos += it }
        cliente.onMensajeInvalido = { invalidos += it }
        var decision: String? = null
        cliente.onAlertDecision = { _, d, _, _ -> decision = d }

        cliente.manejarMensaje("""{"type":"relay_go","relayId":5}""")
        cliente.manejarMensaje("""{"type":"relay_go","relayId":"5"}""")
        cliente.manejarMensaje("""{"type":"alert_decision","alertId":3,"decision":"VALIDATED","decidedBy":"op"}""")
        cliente.manejarMensaje("no es json")

        assertEquals(listOf<MensajeDelHub>(MensajeDelHub.Despegar(5)), recibidos)
        assertEquals(1, invalidos.size)
        assertTrue("dice qué mensaje y por qué", invalidos[0].startsWith("relay_go: relayId"))
        assertEquals("el resto sigue por su camino de siempre", "VALIDATED", decision)
    }

    @Test
    fun sinQuienEscucheNoPasaNada() {
        cliente.manejarMensaje("""{"type":"relay_go","relayId":5}""")
        cliente.manejarMensaje("""{"type":"relay_go"}""")
        assertTrue(enviados.isEmpty())
    }

    @Test
    fun enviarMandaElMensajeTalCual() {
        cliente.enviar(MensajesDeLaApp.relayAccept(7))
        assertEquals("relay_accept", enviados.single().getString("type"))
        assertEquals(7L, enviados.single().getLong("relayId"))
    }

    private fun status(
        relevo: RelevoReportado? = null,
        autonomia: AutonomiaReportada? = null,
        objetivo: ObjetivoReportado? = null,
    ): JSONObject {
        cliente.sendStatus(
            state = "FOLLOWING", battery = 38.0, lat = -34.85, lon = -56.20, routeId = 1, waypointIndex = 2,
            waypointTotal = 4, signalOk = true, signalPct = 81, heading = 118.0, mode = "TEST",
            target = objetivo, relevo = relevo, autonomia = autonomia,
        )
        return enviados.last()
    }

    @Test
    fun elStatusLlevaElRelevoYLaAutonomiaSoloSiSeLosPasan() {
        val viejo = status()
        assertFalse("como una app vieja", viejo.has("relevo"))
        assertFalse(viejo.has("autonomia"))

        val nuevo = status(
            relevo = RelevoReportado(enEspera = false, disponible = false, relayId = 7, rol = "origen", fase = "pedido"),
            autonomia = AutonomiaReportada(14.0, 3.0, 2_400.0, Double.NaN),
        )
        assertEquals("pedido", nuevo.getJSONObject("relevo").getString("fase"))
        assertEquals(14.0, nuevo.getJSONObject("autonomia").getDouble("pctParaVolver"), 0.0)
        assertTrue(nuevo.getJSONObject("autonomia").isNull("segundosParaVolver"))
        assertNull(ValidadorDeLaApp.motivoParaRechazar(nuevo))
    }

    @Test
    fun elObjetivoLlevaLaVelocidadEnComponentesSiSeSabe() {
        val conVelocidad = ObjetivoReportado(12, "VEHICLE", -34.85, -56.2, 4.2, 90.0, true, false, 600, "VALIDATED", 0.0, 4.2)
        val target = status(objetivo = conVelocidad).getJSONObject("target")
        assertEquals(4.2, target.getDouble("vEsteMs"), 0.0)
        assertEquals(0.0, target.getDouble("vNorteMs"), 0.0)
        assertEquals(12L, target.getLong("alertId"))

        val sinVelocidad = conVelocidad.copy(alertId = null, vNorteMs = Double.NaN, vEsteMs = Double.NaN)
        val viejo = status(objetivo = sinVelocidad).getJSONObject("target")
        assertFalse("opcionales: una app vieja no las manda", viejo.has("vNorteMs") || viejo.has("vEsteMs"))
        assertTrue(viejo.isNull("alertId"))
    }
}
