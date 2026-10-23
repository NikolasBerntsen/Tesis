package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.comms.ContratoDeRelevos.APP_AL_HUB
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Lo que la app le manda al hub (docs/PROTOCOLS.md §1.b) cumple el contrato:
 * primero se comprueba que [ValidadorDeLaApp] dice lo mismo que los ejemplos de
 * `docs/contrato/relevos.json`, y después que cada mensaje que arma
 * [MensajesDeLaApp] —también con los datos más feos: NaN, 0,0, un detalle
 * larguísimo— lo pasa, y que con los datos de un ejemplo arma exactamente ese
 * ejemplo. Usa Robolectric por org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MensajesDeLaAppTest {

    private fun cumple(m: JSONObject) {
        val motivo = ValidadorDeLaApp.motivoParaRechazar(m)
        if (motivo != null) fail("$m no cumple el contrato: $motivo")
    }

    private fun ejemplo(tipo: String, caso: String): JSONObject {
        val lista = ContratoDeRelevos.mensajes(APP_AL_HUB).getJSONObject(tipo).getJSONArray("validos")
        for (i in 0 until lista.length()) {
            val e = lista.getJSONObject(i)
            if (e.getString("caso") == caso) return e.getJSONObject("mensaje")
        }
        error("no hay un ejemplo '$caso' de $tipo")
    }

    /** Iguales como JSON: mismas claves y mismos valores, con los números comparados por valor (40 es 40.0). */
    private fun assertMismoJson(esperado: Any?, real: Any?, donde: String = "") {
        when {
            esperado is JSONObject && real is JSONObject -> {
                assertEquals("las claves de $donde", esperado.keys().asSequence().toSet(), real.keys().asSequence().toSet())
                esperado.keys().forEach { assertMismoJson(esperado.get(it), real.get(it), "$donde.$it") }
            }
            esperado is JSONArray && real is JSONArray -> {
                assertEquals(donde, esperado.length(), real.length())
                (0 until esperado.length()).forEach { assertMismoJson(esperado.get(it), real.get(it), "$donde[$it]") }
            }
            esperado is Number && real is Number -> assertEquals(donde, esperado.toDouble(), real.toDouble(), 1e-9)
            else -> assertEquals(donde, esperado, real)
        }
    }

    // ---- El validador dice lo mismo que el contrato ----

    @Test
    fun elValidadorAceptaCadaEjemploValidoYRechazaCadaInvalido() {
        for (tipo in ContratoDeRelevos.tipos(APP_AL_HUB)) {
            ContratoDeRelevos.validos(APP_AL_HUB, tipo).forEach { cumple(it) }
            ContratoDeRelevos.invalidos(APP_AL_HUB, tipo).forEach {
                assertTrue("${it.caso} (${it.porque}) tendría que no cumplir", ValidadorDeLaApp.motivoParaRechazar(it.mensaje) != null)
            }
        }
    }

    // ---- Con los datos de un ejemplo, arma ese ejemplo ----

    @Test
    fun conLosDatosDeCadaEjemploArmaEseEjemplo() {
        assertMismoJson(
            ejemplo("relay_request", "patrulla: A vuelve por batería en medio de la ruta 1, volaba hacia el nodo 2"),
            MensajesDeLaApp.relayRequestPatrulla("3b0f6f5e-7c1a-4d2b-9e1f-2a6c8d4e0b11", 1, 2),
        )
        assertMismoJson(
            ejemplo("relay_request", "seguimiento con autonomía informada"),
            MensajesDeLaApp.relayRequestSeguimiento("c2d9e7a4-1f3b-4c6d-8e5a-9b0c1d2e3f40", 12, 95.5),
        )
        assertMismoJson(
            ejemplo("relay_request", "seguimiento sin autonomía informada"),
            MensajesDeLaApp.relayRequestSeguimiento("d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70", 12, null),
        )
        assertMismoJson(ejemplo("relay_accept", "B acepta el relevo 7"), MensajesDeLaApp.relayAccept(7))
        assertMismoJson(
            ejemplo("relay_reject", "el operador apretó Cancelar en la cuenta regresiva"),
            MensajesDeLaApp.relayReject(7, "cancelado_en_campo", "Cancelado desde el teléfono"),
        )
        assertMismoJson(
            ejemplo("relay_reject", "al reevaluar dejó de estar disponible, sin detalle"),
            MensajesDeLaApp.relayReject(7, "no_disponible"),
        )
        assertMismoJson(ejemplo("relay_ready", "B llegó a 60 m del objetivo con su rastreador sembrado"), MensajesDeLaApp.relayReady(7))
        assertMismoJson(ejemplo("relay_abort", "B perdió la señal en RELEVANDO"), MensajesDeLaApp.relayAbort(7, "senial"))
        assertMismoJson(
            ejemplo("relay_abort", "falló la subida: B aterriza"),
            MensajesDeLaApp.relayAbort(9, "subida", "no llegó a 60 m en 40 s"),
        )
        assertMismoJson(ejemplo("relay_abandon", "A llegó a su piso de energía"), MensajesDeLaApp.relayAbandon(7, "piso"))
        assertMismoJson(ejemplo("relay_abandon", "sin motivo (es opcional)"), MensajesDeLaApp.relayAbandon(7, null))
        assertMismoJson(ejemplo("relay_released", "A ya se alejó 100 m y arranca su regreso"), MensajesDeLaApp.relayReleased(7))
        assertMismoJson(
            ejemplo("landing_at_base", "A empieza a bajar en su base con el relevo ya reservado"),
            MensajesDeLaApp.landingAtBase("3b0f6f5e-7c1a-4d2b-9e1f-2a6c8d4e0b11", 5, 1, -34.85651, -56.20748, 1, 2),
        )
        assertMismoJson(
            ejemplo("landing_at_base", "autosuficiente: el pedido se perdió y la app no recibió bases"),
            MensajesDeLaApp.landingAtBase("3b0f6f5e-7c1a-4d2b-9e1f-2a6c8d4e0b11", null, null, -34.85651, -56.20748, 1, 2),
        )
        assertMismoJson(ejemplo("landed_at_base", "A tocó tierra en su base"), MensajesDeLaApp.landedAtBase(5, 1, -34.8565, -56.2075))
        assertMismoJson(
            ejemplo("landed_at_base", "un desviado aterrizó en la base 2, sin GPS en ese momento"),
            MensajesDeLaApp.landedAtBase(null, 2, Double.NaN, Double.NaN),
        )
        assertMismoJson(
            ejemplo("rth_diverted", "se desvía a la base 2"),
            MensajesDeLaApp.rthDiverted(5, 2, -34.879, -56.185, "otra_base"),
        )
        assertMismoJson(
            ejemplo("rth_diverted", "no llega a ninguna: protocolo de última ubicación"),
            MensajesDeLaApp.rthDiverted(null, 7, -34.8702, -56.1902, "emergencia"),
        )
        assertMismoJson(
            ejemplo("emergency_landing", "lo disparó el cálculo de autonomía"),
            MensajesDeLaApp.emergencyLanding("9f8e7d6c-5b4a-4392-8172-6a5b4c3d2e1f", "autonomia", -34.8702, -56.1902, 38.0, 9.0, 1792767845000),
        )
        assertMismoJson(
            ejemplo("emergency_landing", "el propio DJI forzó el aterrizaje, sin GPS"),
            MensajesDeLaApp.emergencyLanding("0a1b2c3d-4e5f-4061-8273-94a5b6c7d8e9", "bateria_critica_dji", 0.0, 0.0, 25.5, 6.0, 1792767900000),
        )
        val foto = ejemplo("emergency_photo", "foto oblicua, la primera")
        assertMismoJson(
            foto,
            MensajesDeLaApp.emergencyPhoto(
                "9f8e7d6c-5b4a-4392-8172-6a5b4c3d2e1f", 0, "oblicua", 270.0, -70.0, -34.8702, -56.1902, 38.0,
                foto.getString("jpegBase64"), 1792767847000,
            ),
        )
        assertMismoJson(
            ejemplo("emergency_landed", "tocó tierra: la última posición GPS"),
            MensajesDeLaApp.emergencyLanded("9f8e7d6c-5b4a-4392-8172-6a5b4c3d2e1f", -34.87021, -56.19018, 0.2, 1792767870000),
        )
    }

    // ---- Con datos feos, igual cumple ----

    @Test
    fun conDatosFeosIgualCumple() {
        val nan = Double.NaN
        listOf(
            MensajesDeLaApp.relayRequestPatrulla("r", 1, -3),
            MensajesDeLaApp.relayRequestSeguimiento("r", 12, Double.POSITIVE_INFINITY),
            MensajesDeLaApp.relayRequestSeguimiento("r", 12, 9_999.0),
            MensajesDeLaApp.relayRequestSeguimiento("r", 12, -5.0),
            MensajesDeLaApp.relayReject(7, "no_disponible", "x".repeat(500)),
            MensajesDeLaApp.relayReject(7, "ocupado", "   "),
            MensajesDeLaApp.relayAbort(7, "otro", null),
            MensajesDeLaApp.landingAtBase("r", null, null, nan, nan, 1, -1),
            MensajesDeLaApp.landedAtBase(null, null, 0.0, 0.0),
            MensajesDeLaApp.landedAtBase(null, null, -34.0, nan),
            MensajesDeLaApp.rthDiverted(null, null, nan, nan, "emergencia"),
            MensajesDeLaApp.emergencyLanding("r", "autonomia", nan, nan, nan, nan, 0),
            MensajesDeLaApp.emergencyLanding("r", "autonomia", 95.0, 200.0, 5_000.0, 140.0, -5),
            MensajesDeLaApp.emergencyPhoto("r", 7, "panoramica", -90.0, -120.0, nan, nan, -500.0, "/9j/AAAA", 0),
            MensajesDeLaApp.emergencyPhoto("r", 3, "panoramica", nan, nan, -34.0, -56.0, 20.0, "/9j/AAAA", 1),
            MensajesDeLaApp.emergencyPhoto("r", 3, "panoramica", 725.0, 10.0, -34.0, -56.0, 20.0, "/9j/AAAA", 1),
            MensajesDeLaApp.emergencyLanded("r", nan, nan, nan, 0),
        ).forEach(::cumple)
        assertEquals(200, MensajesDeLaApp.relayReject(7, "no_disponible", "x".repeat(500)).getString("detalle").length)
        assertFalse("un detalle en blanco no sale", MensajesDeLaApp.relayReject(7, "ocupado", "   ").has("detalle"))
        assertEquals(0, MensajesDeLaApp.relayRequestPatrulla("r", 1, -3).getInt("fromIndex"))
        assertEquals(3_600.0, MensajesDeLaApp.relayRequestSeguimiento("r", 12, 9_999.0).getDouble("segundosDisponibles"), 0.0)
        assertTrue(MensajesDeLaApp.relayRequestSeguimiento("r", 12, Double.NaN).isNull("segundosDisponibles"))
        assertEquals(5.0, MensajesDeLaApp.emergencyPhoto("r", 3, "panoramica", 725.0, 10.0, -34.0, -56.0, 20.0, "/9j/A", 1).getDouble("rumbo"), 1e-9)
        assertEquals("con emergencia la base va null siempre", true, MensajesDeLaApp.rthDiverted(null, 4, -34.0, -56.0, "emergencia").isNull("baseId"))
    }

    // ---- status ----

    @Test
    fun elRelevoDelStatusCumpleLaReglaDeRolYFase() {
        val sinRelevo = MensajesDeLaApp.relevo(RelevoReportado(enEspera = true, disponible = true))
        assertTrue(sinRelevo.isNull("relayId") && sinRelevo.isNull("rol") && sinRelevo.isNull("fase"))
        assertTrue(sinRelevo.getBoolean("disponible"))

        val disponibleSinEspera = MensajesDeLaApp.relevo(RelevoReportado(enEspera = false, disponible = true))
        assertFalse("disponible sin estar en espera es inválido: sale false", disponibleSinEspera.getBoolean("disponible"))

        val aMedias = MensajesDeLaApp.relevo(RelevoReportado(false, false, relayId = 7, rol = "origen", fase = null))
        assertTrue("rol sin fase: sale sin relevo", aMedias.isNull("relayId") && aMedias.isNull("rol"))

        val conRelevo = MensajesDeLaApp.relevo(RelevoReportado(false, false, 7, "relevo", "en_camino"))
        assertEquals(7L, conRelevo.getLong("relayId"))
        for (r in listOf(sinRelevo, disponibleSinEspera, aMedias, conRelevo)) {
            cumple(JSONObject().put("type", "status").put("relevo", r))
        }
    }

    @Test
    fun laAutonomiaSacaNullLoQueNoSeSabeOLoQueEstaFueraDeRango() {
        val a = MensajesDeLaApp.autonomia(AutonomiaReportada(14.0, Double.NaN, 150_000.0, -3.0))
        assertEquals(14.0, a.getDouble("pctParaVolver"), 0.0)
        assertTrue(a.isNull("pctParaAterrizar") && a.isNull("alcanceM") && a.isNull("segundosParaVolver"))
        cumple(JSONObject().put("type", "status").put("autonomia", a))
        val todo = MensajesDeLaApp.autonomia(AutonomiaReportada(100.0, 0.0, 100_000.0, 36_000.0))
        cumple(JSONObject().put("type", "status").put("autonomia", todo))
        assertEquals(36_000.0, todo.getDouble("segundosParaVolver"), 0.0)
    }

    @Test
    fun laVelocidadDelObjetivoSaleSoloSiEsCreible() {
        assertEquals(4.2, MensajesDeLaApp.conVelocidad(JSONObject(), 0.0, 4.2).getDouble("vEsteMs"), 0.0)
        assertFalse(MensajesDeLaApp.conVelocidad(JSONObject(), Double.NaN, 1.0).has("vNorteMs"))
        assertFalse(MensajesDeLaApp.conVelocidad(JSONObject(), 1.0, Double.POSITIVE_INFINITY).has("vEsteMs"))
        assertFalse("más de 40 m/s no es creíble", MensajesDeLaApp.conVelocidad(JSONObject(), 30.0, 30.0).has("vNorteMs"))
        assertNull(MensajesDeLaApp.conVelocidad(JSONObject(), 30.0, 30.0).opt("vEsteMs"))
    }
}
