package com.tesis.dronepatrol.drone

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Las fotos del protocolo de última ubicación (RELEVOS §5) con el dron
 * simulado: un cuadro de detección (1280 px) dibujado en el acto, con lo que la
 * cámara ve en ese momento; sin enlace no hay foto, como en el real. Y el video
 * de siempre, que el simulador ahora solo dibuja si alguien lo mira.
 *
 * Usa Robolectric porque el simulador dibuja con android.graphics; el tiempo es
 * el virtual de la prueba.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SimulatedDroneControllerFotoTest {

    private fun TestScope.simulador() =
        SimulatedDroneController(despachador = StandardTestDispatcher(testScheduler)) { testScheduler.currentTime }

    private fun esJpeg(bytes: ByteArray) = bytes.size > 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte()

    /**
     * El ancho que declara el JPEG en su encabezado de cuadro (SOF0 a SOF2: la
     * marca, dos bytes de largo, uno de precisión, dos de alto y dos de ancho).
     * Se lee a mano porque la JVM de las pruebas de Android no trae javax.imageio.
     */
    private fun anchoDelJpeg(jpeg: ByteArray): Int {
        fun byte(i: Int) = jpeg[i].toInt() and 0xFF
        var i = 2
        while (i + 8 < jpeg.size) {
            if (byte(i) != 0xFF) {
                i++
                continue
            }
            if (byte(i + 1) in 0xC0..0xC2) return (byte(i + 7) shl 8) or byte(i + 8)
            i += 2 + ((byte(i + 2) shl 8) or byte(i + 3))
        }
        return -1
    }

    @Test
    fun laFotoEsUnCuadroDeDeteccionDibujadoEnElActo() = runTest {
        val dron = simulador()
        dron.connect()
        try {
            val foto = dron.capturarFoto()

            assertNotNull(foto)
            assertTrue("no parece un JPEG", esJpeg(foto!!))
            assertEquals(CuadroDeVideo.ANCHO_DETECCION, anchoDelJpeg(foto))
            assertEquals("no esperó al próximo cuadro del video", 0L, testScheduler.currentTime)
        } finally {
            dron.disconnect()
        }
    }

    /** Sin enlace el video no llega, y la foto tampoco: la espera de siempre vence a los 2 s. */
    @Test
    fun sinEnlaceNoHayFotoYLaEsperaVenceALosDosSegundos() = runTest {
        val dron = simulador()
        dron.connect()
        try {
            dron.setSignalLost(true)
            val foto = async { dron.capturarFoto() }

            advanceTimeBy(DroneController.ESPERA_FOTO_MS - 1)
            runCurrent()
            assertFalse("antes del plazo todavía espera", foto.isCompleted)
            advanceTimeBy(1)
            runCurrent()

            assertNull(foto.await())
        } finally {
            dron.disconnect()
        }
    }

    @Test
    fun sinConectarNoHayFoto() = runTest {
        val dron = simulador()

        val foto = async { dron.capturarFoto() }
        advanceTimeBy(DroneController.ESPERA_FOTO_MS)
        runCurrent()

        assertNull(foto.await())
    }

    /** Con alguien mirando, los dos videos salen como siempre: el de la consola y el de la detección. */
    @Test
    fun conAlguienMirandoElVideoSaleComoSiempre() = runTest {
        val dron = simulador()
        dron.connect()
        try {
            val consola = async { dron.videoFrames.first() }
            val deteccion = async { dron.cuadrosParaDeteccion.first() }
            runCurrent()
            advanceTimeBy(CuadroDeVideo.INTERVALO_CUADRO_MS)
            runCurrent()

            assertEquals(CuadroDeVideo.ANCHO_MAXIMO, anchoDelJpeg(consola.await()))
            assertEquals(CuadroDeVideo.ANCHO_DETECCION, anchoDelJpeg(deteccion.await()))
        } finally {
            dron.disconnect()
        }
    }
}
