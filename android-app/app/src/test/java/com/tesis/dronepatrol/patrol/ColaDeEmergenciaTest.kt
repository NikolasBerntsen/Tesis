package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.MensajeDelHub
import com.tesis.dronepatrol.comms.MensajesDeLaApp
import java.io.File
import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La cola persistente de una emergencia (docs/PROTOCOLS.md §1.b, "Cola
 * persistente"): el aviso primero y nada antes de su acuse, el aterrizaje antes
 * que las fotos pendientes, las fotos en orden y de a una, la espera creciente
 * de 5 a 60 s, y que sobreviva a un reinicio —y a un archivo roto— sin perder la
 * última posición. Usa Robolectric por org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ColaDeEmergenciaTest {

    @get:Rule
    val carpeta = TemporaryFolder()

    private companion object {
        const val REF = "9f8e7d6c-5b4a-4392-8172-6a5b4c3d2e1f"
        const val LAT = -34.8702
        const val LON = -56.1902
        val JPEG: String = Base64.getEncoder().encodeToString(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 1, 2, 3))
    }

    private fun aviso(ref: String = REF, lat: Double = LAT) =
        MensajesDeLaApp.emergencyLanding(ref, "autonomia", lat, LON, 38.0, 9.0, 1_000L)

    private fun foto(seq: Int, ref: String = REF) =
        MensajesDeLaApp.emergencyPhoto(ref, seq, "cenital", 0.0, -90.0, LAT, LON, 38.0, JPEG, 2_000L)

    private fun aterrizaje(ref: String = REF) = MensajesDeLaApp.emergencyLanded(ref, LAT + 0.0001, LON, 0.2, 3_000L)

    private fun tipos(l: List<JSONObject>) = l.map { it.getString("type") + (if (it.has("seq")) "#" + it.getInt("seq") else "") }

    @Test
    fun elAvisoSalePrimeroYNadaMasAntesDeSuAcuse() {
        val cola = ColaDeEmergencia(AlmacenEnMemoria())
        assertFalse(cola.hayPendientes)
        cola.abrir(aviso())
        cola.agregarFoto(REF, foto(0))
        cola.agregarAterrizaje(REF, aterrizaje())
        assertTrue(cola.hayPendientes)
        assertEquals(listOf("emergency_landing"), tipos(cola.aEnviar(0)))
        assertTrue("sin acuse, nada hasta la espera", cola.aEnviar(4_999).isEmpty())
        assertEquals("reintento a los 5 s", listOf("emergency_landing"), tipos(cola.aEnviar(5_000)))
        assertTrue("el siguiente espera el doble", cola.aEnviar(14_999).isEmpty())
        assertEquals(listOf("emergency_landing"), tipos(cola.aEnviar(15_000)))

        assertTrue(cola.alAcuse(MensajeDelHub.AcuseDeEmergencia(REF, 3, aterrizada = false)))
        assertEquals("el aterrizaje antes que las fotos", listOf("emergency_landed"), tipos(cola.aEnviar(15_001)))
        assertTrue(cola.aEnviar(15_002).isEmpty())
        assertTrue(cola.alAcuse(MensajeDelHub.AcuseDeEmergencia(REF, 3, aterrizada = true)))
        assertEquals(listOf("emergency_photo#0"), tipos(cola.aEnviar(15_003)))
        assertTrue(cola.alAcuseDeFoto(MensajeDelHub.AcuseDeFoto(REF, 0)))
        assertFalse("todo acusado: no queda nada", cola.hayPendientes)
        assertTrue(cola.aEnviar(100_000).isEmpty())
    }

    @Test
    fun lasFotosVanEnOrdenDeSeqYDeAUna() {
        val cola = ColaDeEmergencia(AlmacenEnMemoria())
        cola.abrir(aviso())
        cola.agregarFoto(REF, foto(3))
        cola.agregarFoto(REF, foto(1))
        cola.agregarFoto(REF, foto(1))
        cola.aEnviar(0)
        cola.alAcuse(MensajeDelHub.AcuseDeEmergencia(REF, 3, aterrizada = false))
        assertEquals(listOf("emergency_photo#1"), tipos(cola.aEnviar(1)))
        assertFalse("un acuse de una foto que no está no saca nada", cola.alAcuseDeFoto(MensajeDelHub.AcuseDeFoto(REF, 5)))
        assertTrue(cola.alAcuseDeFoto(MensajeDelHub.AcuseDeFoto(REF, 1)))
        assertEquals(listOf("emergency_photo#3"), tipos(cola.aEnviar(2)))
    }

    @Test
    fun laEsperaNoPasaDeSesentaSegundosYAlReconectarSaleYa() {
        val cola = ColaDeEmergencia(AlmacenEnMemoria())
        cola.abrir(aviso())
        var t = 0L
        var espera = ColaDeEmergencia.REINTENTO_MINIMO_MS
        cola.aEnviar(t)
        repeat(6) {
            t += espera
            assertEquals("a los $t ms", 1, cola.aEnviar(t).size)
            espera = (espera * 2).coerceAtMost(ColaDeEmergencia.REINTENTO_MAXIMO_MS)
        }
        assertTrue(cola.aEnviar(t + ColaDeEmergencia.REINTENTO_MAXIMO_MS - 1).isEmpty())
        assertEquals(1, cola.aEnviar(t + ColaDeEmergencia.REINTENTO_MAXIMO_MS).size)
        cola.reconectado()
        assertEquals("volvió el Comando Central: sale sin esperar", 1, cola.aEnviar(t + ColaDeEmergencia.REINTENTO_MAXIMO_MS + 1).size)
    }

    @Test
    fun acusesDeOtraEmergenciaNoTocanNada() {
        val cola = ColaDeEmergencia(AlmacenEnMemoria())
        cola.abrir(aviso())
        cola.abrir(aviso())
        assertFalse(cola.alAcuse(MensajeDelHub.AcuseDeEmergencia("otra", 1, aterrizada = true)))
        assertFalse(cola.alAcuseDeFoto(MensajeDelHub.AcuseDeFoto("otra", 0)))
        cola.agregarFoto("otra", foto(0, "otra"))
        cola.agregarAterrizaje("otra", aterrizaje("otra"))
        assertEquals("una sola emergencia, la abierta", 1, cola.aEnviar(0).size)
    }

    @Test
    fun dosEmergenciasSalenCadaUnaConLoSuyo() {
        val cola = ColaDeEmergencia(AlmacenEnMemoria())
        cola.abrir(aviso("a"))
        cola.abrir(aviso("b"))
        assertEquals(listOf("a", "b"), cola.aEnviar(0).map { it.getString("ref") })
    }

    @Test
    fun unAterrizajeYaAcusadoNoVuelveAEntrar() {
        val cola = ColaDeEmergencia(AlmacenEnMemoria())
        cola.abrir(aviso())
        cola.agregarFoto(REF, foto(0))
        cola.agregarAterrizaje(REF, aterrizaje())
        cola.alAcuse(MensajeDelHub.AcuseDeEmergencia(REF, 3, aterrizada = true))
        cola.agregarAterrizaje(REF, aterrizaje())
        assertEquals(listOf("emergency_photo#0"), tipos(cola.aEnviar(0)))
    }

    @Test
    fun sobreviveAUnReinicioConLaUltimaPosicion() {
        val almacen = AlmacenEnMemoria()
        val cola = ColaDeEmergencia(almacen)
        assertNull(cola.ultimaPosicion())
        cola.abrir(aviso())
        assertEquals(ColaDeEmergencia.Posicion(LAT, LON, aterrizada = false), cola.ultimaPosicion())
        cola.aEnviar(0)
        cola.alAcuse(MensajeDelHub.AcuseDeEmergencia(REF, 3, aterrizada = false))
        cola.agregarFoto(REF, foto(0))
        cola.agregarAterrizaje(REF, aterrizaje())

        val otra = ColaDeEmergencia(almacen)
        assertEquals(ColaDeEmergencia.Posicion(LAT + 0.0001, LON, aterrizada = true), otra.ultimaPosicion())
        assertEquals("el aviso ya estaba acusado: sale el aterrizaje", listOf("emergency_landed"), tipos(otra.aEnviar(0)))
        otra.alAcuse(MensajeDelHub.AcuseDeEmergencia(REF, 3, aterrizada = true))
        assertEquals(listOf("emergency_photo#0"), tipos(otra.aEnviar(1)))
    }

    @Test
    fun sinPosicionNoHayNadaQueFijar() {
        val cola = ColaDeEmergencia(AlmacenEnMemoria())
        cola.abrir(aviso(lat = Double.NaN))
        assertNull(cola.ultimaPosicion())
    }

    @Test
    fun unArchivoRotoNoTiraLaApp() {
        assertFalse(ColaDeEmergencia(AlmacenEnMemoria("{no es json")).hayPendientes)
        assertFalse(ColaDeEmergencia(AlmacenEnMemoria("""{"emergencias":[{"ref":"a"}]}""")).hayPendientes)
        assertFalse(ColaDeEmergencia(AlmacenEnMemoria("""{"otra":1}""")).hayPendientes)
    }

    @Test
    fun elArchivoGuardaYLeeEntero() {
        val archivo = File(carpeta.root, "emergencias.json")
        val almacen = AlmacenEnArchivo(archivo)
        assertNull("todavía no hay archivo", almacen.leer())
        ColaDeEmergencia(almacen).abrir(aviso())
        assertTrue(archivo.isFile)
        assertFalse("el temporal no queda", File(carpeta.root, "emergencias.json.tmp").exists())
        assertTrue(ColaDeEmergencia(AlmacenEnArchivo(archivo)).hayPendientes)
        // Sobrescribe el anterior.
        almacen.guardar("{}")
        assertEquals("{}", almacen.leer())
    }

    /**
     * El reescalado de verdad decodifica y recomprime con android.graphics.
     * Robolectric no decodifica JPEG de verdad, así que acá solo se mira que
     * no tire nada y que lo que sale (si sale algo) cumpla el contrato.
     */
    @Test
    fun elReescaladoDeVerdadNoRompeNadaYNoDejaPasarLoQueNoEntra() {
        val grande = ByteArray(3_000) { 7 }.also {
            it[0] = 0xFF.toByte()
            it[1] = 0xD8.toByte()
            it[2] = 0xFF.toByte()
        }
        val texto = FotoDeEmergencia.aBase64(grande, tope = 200)
        assertTrue("$texto", texto == null || (texto.length <= 200 && texto.startsWith("/9j/")))
    }
}
