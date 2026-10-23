package com.tesis.dronepatrol.patrol

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * La foto de una emergencia en el formato del contrato (docs/PROTOCOLS.md §1.b,
 * `jpegBase64`): un JPEG en base64 que empieza con `/9j/` y entra en el tope;
 * si no entra se reescala y se recomprime hasta que entre, cada vez más chico.
 * El reescalado de verdad decodifica imágenes; acá se cambia por uno de
 * mentira para probar los reintentos.
 */
class FotoDeEmergenciaTest {

    private fun jpeg(tamanio: Int) = ByteArray(tamanio) { 7 }.also {
        it[0] = 0xFF.toByte()
        it[1] = 0xD8.toByte()
        it[2] = 0xFF.toByte()
    }

    @Test
    fun loQueNoEsUnJpegNoSale() {
        assertNull(FotoDeEmergencia.aBase64(null))
        assertNull(FotoDeEmergencia.aBase64(byteArrayOf(0xFF.toByte(), 0xD8.toByte())))
        assertNull(FotoDeEmergencia.aBase64(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)))
        assertNull(FotoDeEmergencia.aBase64(byteArrayOf(0xFF.toByte(), 0x00, 0xFF.toByte())))
    }

    @Test
    fun unJpegQueEntraSaleTalCual() {
        val chico = jpeg(300)
        val texto = FotoDeEmergencia.aBase64(chico, reescalar = { _, _ -> error("no hace falta reescalar") })!!
        assertTrue(texto.startsWith("/9j/"))
        assertEquals(Base64.getEncoder().encodeToString(chico), texto)
    }

    @Test
    fun siNoEntraSeAchicaHastaQueEntre() {
        val escalas = mutableListOf<Double>()
        val texto = FotoDeEmergencia.aBase64(jpeg(3_000), tope = 1_000) { original, escala ->
            escalas += escala
            // Las dos primeras veces no achica lo suficiente.
            if (escalas.size < 3) original else jpeg(500)
        }!!
        assertTrue(texto.length <= 1_000)
        assertTrue(texto.startsWith("/9j/"))
        assertEquals(3, escalas.size)
        assertTrue("cada intento más chico", escalas[0] > escalas[1] && escalas[1] > escalas[2])
        assertTrue("arranca por debajo de la proporción que hace falta", escalas[0] < 1.0)
    }

    @Test
    fun siNoHayFormaDeQueEntreNoSale() {
        var intentos = 0
        assertNull(
            FotoDeEmergencia.aBase64(jpeg(3_000), tope = 1_000) { original, _ ->
                intentos++
                original
            },
        )
        assertEquals(5, intentos)
        assertNull("una recompresión que falla tampoco", FotoDeEmergencia.aBase64(jpeg(3_000), tope = 1_000) { _, _ -> null })
        assertNull(
            "ni una que no da un JPEG",
            FotoDeEmergencia.aBase64(jpeg(3_000), tope = 1_000) { _, _ -> byteArrayOf(1, 2, 3) },
        )
    }

    @Test
    fun elTopeDelContratoEsDeCuatrocientosMilCaracteres() {
        assertEquals(400_000, FotoDeEmergencia.TOPE_CARACTERES)
    }
}
