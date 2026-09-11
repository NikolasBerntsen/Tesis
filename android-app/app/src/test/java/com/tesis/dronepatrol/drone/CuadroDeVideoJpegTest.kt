package com.tesis.dronepatrol.drone

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La otra mitad del camino del video: la compresión, que necesita
 * android.graphics y por eso corre con Robolectric (el mismo patrón que ya usa
 * el video del dron simulado).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CuadroDeVideoJpegTest {

    /** Cuadro NV21 gris parejo de [ancho]x[alto]. */
    private fun cuadroGris(ancho: Int, alto: Int): ByteArray =
        ByteArray(ancho * alto * 3 / 2) { 128.toByte() }

    @Test
    fun elCaminoCompletoDevuelveUnJpeg() {
        val jpeg = CuadroDeVideo.nv21AJpeg(cuadroGris(64, 48), 0, 64, 48)

        assertNotNull("tendría que haber comprimido el cuadro", jpeg)
        assertTrue(jpeg!!.size > 2)
        // Firma SOI: todo JPEG arranca con FF D8
        assertTrue(
            "no parece un JPEG: ${jpeg.take(2)}",
            jpeg[0] == 0xFF.toByte() && jpeg[1] == 0xD8.toByte(),
        )
    }

    /** Un cuadro corto se descarta sin romper el lazo de video del controlador. */
    @Test
    fun unCuadroCortoNoRompeNada() {
        assertNull(CuadroDeVideo.nv21AJpeg(ByteArray(10), 0, 64, 48))
        assertNull(CuadroDeVideo.nv21AJpeg(ByteArray(10), 0, 0, 0))
    }

    /** Por esto se reescala: el JPEG del cuadro chico pesa menos que el del grande. */
    @Test
    fun comprimeElTamanioDeDestinoYNoElDelOrigen() {
        val verde = 0xFF00FF00.toInt()
        val grande = CuadroDeVideo.aJpeg(IntArray(320 * 240) { verde }, CuadroDeVideo.Tamanio(320, 240))
        val chico = CuadroDeVideo.aJpeg(IntArray(160 * 120) { verde }, CuadroDeVideo.Tamanio(160, 120))

        assertTrue("grande=${grande.size} chico=${chico.size}", chico.size < grande.size)
    }
}
