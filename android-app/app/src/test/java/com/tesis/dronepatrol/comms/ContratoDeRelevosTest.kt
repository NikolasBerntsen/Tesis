package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.comms.ContratoDeRelevos.APP_AL_HUB
import com.tesis.dronepatrol.comms.ContratoDeRelevos.HUB_A_LA_APP
import com.tesis.dronepatrol.comms.ContratoDeRelevos.HUB_A_LA_CONSOLA
import com.tesis.dronepatrol.drone.RastreadorDeObjetivo
import com.tesis.dronepatrol.model.PatrolState
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El archivo compartido del contrato de relevos (`docs/contrato/relevos.json`)
 * se lee desde las pruebas de la app y tiene lo que docs/PROTOCOLS.md promete:
 * un ejemplo válido de cada mensaje de §1.b, §2.b y §3, cada inválido con su
 * motivo, y los estados y constantes que la app ya conoce escritos igual.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ContratoDeRelevosTest {

    private companion object {
        /** Los mensajes de docs/PROTOCOLS.md §1.b (más `status`, por sus campos nuevos). */
        val DE_LA_APP = setOf(
            "status", "relay_request", "relay_accept", "relay_reject", "relay_ready", "relay_abort", "relay_abandon",
            "relay_released", "landing_at_base", "landed_at_base", "rth_diverted", "emergency_landing",
            "emergency_photo", "emergency_landed",
        )

        /** Los de §2.b. */
        val A_LA_APP = setOf(
            "bases", "relay_status", "relay_start", "relay_tracking", "relay_target", "relay_go", "relay_done",
            "relay_cancel", "emergency_ack", "emergency_photo_ack",
        )

        /** Los de §3 que cambian o se suman. */
        val A_LA_CONSOLA = setOf("relay_updated", "emergency_updated", "emergency_photo", "alert_updated", "base_updated")

        val DIRECCIONES = mapOf(APP_AL_HUB to DE_LA_APP, HUB_A_LA_APP to A_LA_APP, HUB_A_LA_CONSOLA to A_LA_CONSOLA)
    }

    @Test
    fun seLeeDesdeElModuloDeLaApp() {
        assertTrue("no está ${File(ContratoDeRelevos.RUTA).absolutePath}", File(ContratoDeRelevos.RUTA).isFile)
        assertEquals(1, ContratoDeRelevos.raiz.getInt("version"))
    }

    @Test
    fun cadaMensajeTieneAlMenosUnEjemploValidoConSuType() {
        for ((direccion, tipos) in DIRECCIONES) {
            assertEquals("los mensajes de $direccion", tipos, ContratoDeRelevos.tipos(direccion))
            for (tipo in tipos) {
                val validos = ContratoDeRelevos.validos(direccion, tipo)
                assertTrue("$tipo no tiene ejemplo válido", validos.isNotEmpty())
                validos.forEach { assertEquals("ejemplo de $tipo", tipo, it.getString("type")) }
            }
        }
    }

    @Test
    fun cadaInvalidoDicePorQueLoEs() {
        var invalidos = 0
        for ((direccion, tipos) in DIRECCIONES) {
            for (tipo in tipos) {
                ContratoDeRelevos.invalidos(direccion, tipo).forEach {
                    invalidos++
                    assertTrue("${it.caso}: falta el porqué", it.porque.isNotBlank())
                    assertEquals(it.caso, tipo, it.mensaje.getString("type"))
                }
            }
        }
        assertTrue("el contrato trae inválidos para probar el rechazo", invalidos >= 20)
    }

    /** El hub y la consola escriben los estados nuevos tal como los manda la app. */
    @Test
    fun losEstadosDelContratoSonLosDeLaApp() {
        val deLaApp = PatrolState.entries.map { it.name }.toSet()
        assertTrue(deLaApp.containsAll(ContratoDeRelevos.enumerado("estadosNuevosDelPatrullaje")))
        ContratoDeRelevos.validos(APP_AL_HUB, "status").forEach {
            assertTrue(it.getString("state"), it.getString("state") in deLaApp)
        }
    }

    @Test
    fun lasConstantesQueLaAppYaTieneCoinciden() {
        assertEquals(
            RastreadorDeObjetivo.VELOCIDAD_MAXIMA_CREIBLE_MS.toLong(),
            ContratoDeRelevos.limite("velocidadObjetivoMaximaMs"),
        )
        assertEquals("el ref del alert_request y el de los relevos", 64L, ContratoDeRelevos.limite("refMaxCaracteres"))
    }

    /**
     * El `objetivo` que A le pasa a B por el hub alcanza para sembrar el
     * rastreador de B: en el instante del traspaso, B ve lo mismo que A.
     */
    @Test
    fun elObjetivoDeUnRelevoSiembraElRastreadorDeB() {
        val orden = ContratoDeRelevos.validos(HUB_A_LA_APP, "relay_tracking").first()
        val o = orden.getJSONObject("objetivo")
        val ahora = 1_000_000L

        val r = RastreadorDeObjetivo.heredado(
            clase = o.getString("type"),
            lat = o.getDouble("lat"),
            lon = o.getDouble("lon"),
            vNorteMs = o.getDouble("vNorteMs"),
            vEsteMs = o.getDouble("vEsteMs"),
            enMovimiento = o.getBoolean("moving"),
            vistoHaceMs = o.getLong("lastSeenMs"),
            ahoraMs = ahora,
        )
        val e = r.estimar(ahora)

        assertEquals(orden.getLong("alertId"), o.getLong("alertId"))
        assertEquals(o.getDouble("lat"), e.lat, 1e-9)
        assertEquals(o.getDouble("lon"), e.lon, 1e-9)
        assertEquals(o.getBoolean("moving"), e.enMovimiento)
        assertEquals(o.getDouble("speedMs"), e.velocidadMs, 1e-9)
        assertEquals(o.getDouble("courseDeg"), e.rumboGrados, 1e-6)
        assertEquals(o.getLong("lastSeenMs"), e.vistoHaceMs)
    }
}
