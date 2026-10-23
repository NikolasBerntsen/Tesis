package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.comms.ContratoDeRelevos.HUB_A_LA_APP
import java.math.BigDecimal
import java.math.BigInteger
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
 * La validación de los mensajes del hub (docs/PROTOCOLS.md §2.b, "Validación en
 * la app") contra los ejemplos de `docs/contrato/relevos.json`: cada válido sale
 * con su tipo y sus campos; cada inválido se ignora, salvo las dos excepciones
 * del contrato —la orden inválida con `relayId`, que se contesta, y el
 * `relay_cancel` con un motivo desconocido, que se aplica igual—. Más los bordes
 * de "nada se convierte". Usa Robolectric por org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LectorDelHubTest {

    private fun valido(m: JSONObject): MensajeDelHub = when (val l = LectorDelHub.leer(m)) {
        is LectorDelHub.Lectura.Valido -> l.mensaje
        is LectorDelHub.Lectura.Invalido -> fail("$m tendría que pasar: ${l.porque}") as Nothing
    }

    private fun invalido(m: JSONObject): String = when (val l = LectorDelHub.leer(m)) {
        is LectorDelHub.Lectura.Valido -> fail("$m tendría que no pasar, salió ${l.mensaje}") as Nothing
        is LectorDelHub.Lectura.Invalido -> l.porque
    }

    private fun ejemplo(tipo: String, i: Int = 0) = JSONObject(ContratoDeRelevos.validos(HUB_A_LA_APP, tipo)[i].toString())

    @Test
    fun cadaEjemploValidoSaleConSuTipo() {
        val esperado = mapOf(
            "bases" to MensajeDelHub.Bases::class,
            "relay_status" to MensajeDelHub.EstadoDelPedido::class,
            "relay_start" to MensajeDelHub.OrdenDePatrulla::class,
            "relay_tracking" to MensajeDelHub.OrdenDeSeguimiento::class,
            "relay_target" to MensajeDelHub.ObjetivoActualizado::class,
            "relay_go" to MensajeDelHub.Despegar::class,
            "relay_done" to MensajeDelHub.Traspaso::class,
            "relay_cancel" to MensajeDelHub.Cancelacion::class,
            "emergency_ack" to MensajeDelHub.AcuseDeEmergencia::class,
            "emergency_photo_ack" to MensajeDelHub.AcuseDeFoto::class,
        )
        assertEquals(esperado.keys, LectorDelHub.TIPOS_DE_MENSAJE)
        assertEquals(esperado.keys, ContratoDeRelevos.tipos(HUB_A_LA_APP))
        for ((tipo, clase) in esperado) {
            ContratoDeRelevos.validos(HUB_A_LA_APP, tipo).forEach {
                assertEquals(tipo, clase, valido(it)::class)
            }
        }
    }

    @Test
    fun cadaInvalidoSeIgnoraSalvoLasDosExcepciones() {
        for (tipo in ContratoDeRelevos.tipos(HUB_A_LA_APP)) {
            for (caso in ContratoDeRelevos.invalidos(HUB_A_LA_APP, tipo)) {
                when (tipo) {
                    // Con un relayId válido se le contesta relay_reject mensaje_invalido.
                    "relay_start", "relay_tracking" -> {
                        val m = valido(caso.mensaje) as MensajeDelHub.OrdenInvalida
                        assertEquals(caso.caso, caso.mensaje.getLong("relayId"), m.relayId)
                        assertEquals(tipo, m.tipo)
                        assertTrue(m.detalle.isNotBlank())
                    }
                    // Cancelar es siempre el lado seguro: se aplica como "otro".
                    "relay_cancel" -> assertEquals("otro", (valido(caso.mensaje) as MensajeDelHub.Cancelacion).motivo)
                    else -> assertTrue(caso.caso, invalido(caso.mensaje).startsWith(tipo))
                }
            }
        }
    }

    @Test
    fun losCamposLleganDondeVan() {
        val bases = valido(ejemplo("bases")) as MensajeDelHub.Bases
        assertEquals(1L, bases.propiaId)
        assertEquals("Base Norte", bases.propia!!.nombre)
        assertEquals(-34.85632, bases.propia!!.aterrizajeLat!!, 1e-9)
        assertNull(bases.bases[1].aterrizajeLat)
        assertNull((valido(ejemplo("bases", 1)) as MensajeDelHub.Bases).propia)

        val status = valido(ejemplo("relay_status", 1)) as MensajeDelHub.EstadoDelPedido
        assertEquals(7L, status.relayId)
        assertEquals("EN_CAMINO", status.estado)
        assertEquals("Bravo", status.relevo!!.displayName)
        assertEquals(74.0, status.etaS!!, 0.0)
        assertFalse(status.terminal)
        val cancelado = valido(ejemplo("relay_status", 3)) as MensajeDelHub.EstadoDelPedido
        assertTrue(cancelado.terminal)
        assertEquals("sin_relevo", cancelado.motivoFin)
        assertNull(cancelado.relevo)

        val start = valido(ejemplo("relay_start")) as MensajeDelHub.OrdenDePatrulla
        assertEquals(5L, start.relayId)
        assertEquals(4, start.ruta.waypoints.size)
        assertEquals(45.0, start.ruta.waypoints[2].alt, 0.0)
        assertEquals(2, start.fromIndex)
        assertEquals("Alfa", start.de.displayName)

        val tracking = valido(ejemplo("relay_tracking")) as MensajeDelHub.OrdenDeSeguimiento
        assertEquals(12L, tracking.alertId)
        assertEquals("VALIDATED", tracking.decision)
        assertEquals(4.2, tracking.objetivo.vEsteMs, 0.0)
        assertTrue(tracking.objetivo.enMovimiento)
        assertEquals("VEHICLE", tracking.objetivo.tipo)

        val retirado = valido(ejemplo("relay_target", 1)) as MensajeDelHub.ObjetivoActualizado
        assertEquals("retirado", retirado.origen)
        assertNull(retirado.aLat)
        assertNull(retirado.aAlt)
        val enLinea = valido(ejemplo("relay_target")) as MensajeDelHub.ObjetivoActualizado
        assertEquals(40.0, enLinea.aAlt!!, 0.0)

        assertEquals(MensajeDelHub.Despegar(5), valido(ejemplo("relay_go")))
        assertEquals("Bravo", (valido(ejemplo("relay_done")) as MensajeDelHub.Traspaso).relevadoPor.displayName)
        assertEquals(MensajeDelHub.Cancelacion(4, "terminado"), valido(ejemplo("relay_cancel", 1)))
        assertEquals(
            MensajeDelHub.AcuseDeEmergencia("9f8e7d6c-5b4a-4392-8172-6a5b4c3d2e1f", 3, aterrizada = true),
            valido(ejemplo("emergency_ack", 1)),
        )
        assertEquals(MensajeDelHub.AcuseDeFoto("9f8e7d6c-5b4a-4392-8172-6a5b4c3d2e1f", 4), valido(ejemplo("emergency_photo_ack")))
    }

    // ---- Nada se convierte ----

    @Test
    fun unNumeroEnTextoOUnBooleanoNoSonNumeros() {
        invalido(JSONObject().put("type", "relay_go").put("relayId", "5"))
        invalido(JSONObject().put("type", "relay_go").put("relayId", true))
        invalido(JSONObject().put("type", "relay_go").put("relayId", 5.5))
        invalido(JSONObject().put("type", "relay_go").put("relayId", 0))
        invalido(JSONObject().put("type", "relay_go"))
        invalido(ejemplo("relay_status").put("etaS", "74"))
        invalido(ejemplo("relay_status").put("etaS", true))
        invalido(ejemplo("relay_target").put("aAlt", 1_500))
        invalido(ejemplo("emergency_ack").put("aterrizada", "true"))
        invalido(ejemplo("emergency_photo_ack").put("ref", ""))
        invalido(ejemplo("emergency_photo_ack").put("ref", "x".repeat(65)))
        invalido(JSONObject().put("type", "otro_tipo"))
    }

    @Test
    fun lasPosicionesSonPosicionesDeVerdad() {
        fun base(lat: Any?, lon: Any?) = ejemplo("bases").also {
            it.getJSONArray("bases").getJSONObject(1).put("lat", lat ?: JSONObject.NULL).put("lon", lon ?: JSONObject.NULL)
        }
        invalido(base(0.0, 0.0))
        invalido(base(null, null))
        invalido(base(-34.9, null))
        invalido(base(-34.9, "x"))
        invalido(base("x", -56.0))
        invalido(base(-34.9, 200.0))
        invalido(ejemplo("relay_target").put("aLat", JSONObject.NULL))
        invalido(ejemplo("relay_target").also { it.remove("aLon") })
    }

    @Test
    fun losBordesDeCadaMensaje() {
        // relay_status: un motivoFin que no corresponde al estado, o que falta.
        invalido(ejemplo("relay_status", 3).put("motivoFin", "relevo_abortado"))
        invalido(ejemplo("relay_status").also { it.remove("motivoFin") })
        invalido(ejemplo("relay_status").also { it.remove("relevo") })
        invalido(ejemplo("relay_status").put("relevo", JSONObject().put("droneId", "B7E4209C3F1A4D6E8B2C5A7F9D1E3C40").put("displayName", "B")))
        // bases: más de 200, un nombre vacío, una base que no es objeto, una lista que no es lista.
        val muchas = JSONArray()
        repeat(201) { muchas.put(ejemplo("bases").getJSONArray("bases").getJSONObject(1).put("id", it + 1)) }
        invalido(JSONObject().put("type", "bases").put("propiaId", JSONObject.NULL).put("bases", muchas))
        invalido(ejemplo("bases").also { it.getJSONArray("bases").getJSONObject(1).put("nombre", "") })
        invalido(ejemplo("bases").also { it.getJSONArray("bases").put(3) })
        invalido(ejemplo("bases").put("bases", "ninguna"))
        // relay_start: un nodo que no es objeto, una altura de más, un apodo largo, una ruta que no es objeto.
        invalido(ejemplo("relay_start").also { it.getJSONObject("ruta").getJSONArray("waypoints").put(1) }.put("relayId", "x"))
        assertTrue(valido(ejemplo("relay_start").also { it.getJSONObject("ruta").getJSONArray("waypoints").getJSONObject(0).put("alt", 600) }) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_start").also { it.getJSONObject("ruta").getJSONArray("waypoints").getJSONObject(0).put("label", "x".repeat(41)) }) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_start").put("ruta", "r")) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_start").put("motivo", "seguimiento")) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_start").also { it.getJSONObject("ruta").put("id", 3_000_000_000L) }) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_start").put("fromIndex", -1)) is MensajeDelHub.OrdenInvalida)
        // relay_tracking: la decisión del objetivo distinta de la del mensaje, un tipo desconocido, un booleano en texto.
        assertTrue(valido(ejemplo("relay_tracking").put("decision", "PENDING")) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_tracking").also { it.getJSONObject("objetivo").put("type", "DOG") }) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_tracking").also { it.getJSONObject("objetivo").put("moving", "true") }) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_tracking").also { it.getJSONObject("objetivo").put("speedMs", 41) }) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_tracking").also { it.getJSONObject("objetivo").put("lastSeenMs", -1) }) is MensajeDelHub.OrdenInvalida)
        assertTrue(valido(ejemplo("relay_tracking").put("ts", 0)) is MensajeDelHub.OrdenInvalida)
        // relay_cancel sin relayId no se puede aplicar a nada; sin motivo, sí.
        invalido(JSONObject().put("type", "relay_cancel").put("motivo", "vencido"))
        assertEquals(MensajeDelHub.Cancelacion(4, "otro"), valido(JSONObject().put("type", "relay_cancel").put("relayId", 4)))
    }

    @Test
    fun unEnteroSeguroEsUnEnteroDeVerdad() {
        assertEquals(7L, LectorDelHub.enteroValido(7))
        assertEquals(7L, LectorDelHub.enteroValido(7L))
        assertEquals(7L, LectorDelHub.enteroValido(7.toShort()))
        assertEquals(7L, LectorDelHub.enteroValido(7.toByte()))
        assertEquals(7L, LectorDelHub.enteroValido(BigInteger.valueOf(7)))
        assertEquals(7L, LectorDelHub.enteroValido(BigDecimal("7.0")))
        assertEquals(7L, LectorDelHub.enteroValido(7.0))
        assertEquals(7L, LectorDelHub.enteroValido(7.0f))
        assertNull(LectorDelHub.enteroValido(BigInteger("100000000000000000000")))
        assertNull(LectorDelHub.enteroValido(BigDecimal("7.5")))
        assertNull(LectorDelHub.enteroValido(7.5))
        assertNull(LectorDelHub.enteroValido(Double.POSITIVE_INFINITY))
        assertNull(LectorDelHub.enteroValido(1e300))
        assertNull(LectorDelHub.enteroValido(7.5f))
        assertNull(LectorDelHub.enteroValido(Float.NaN))
        assertNull(LectorDelHub.enteroValido("7"))
        assertNull(LectorDelHub.enteroValido(true))
        assertNull(LectorDelHub.enteroValido(null))
        assertNull("más que el entero seguro de JavaScript", LectorDelHub.enteroValido(9_007_199_254_740_992L))
        assertNull("por debajo del mínimo", LectorDelHub.enteroValido(0))
        assertEquals(0L, LectorDelHub.enteroValido(0, minimo = 0))
        assertNull(LectorDelHub.enteroValido(8, minimo = 0, maximo = 7))
    }
}
