package com.tesis.dronepatrol.drone

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Conversión de los cuadros de video del dron real. Es aritmética pura, así que
 * corre en la JVM pelada: lo único que necesita Android es la compresión a JPEG,
 * que vive aparte justamente por esto (ver CuadroDeVideoJpegTest).
 */
class CuadroDeVideoTest {

    private val negro = 0
    private val blanco = 255
    private val cromaNeutra = 128
    private val argbNegro = 0xFF000000.toInt()
    private val argbBlanco = 0xFFFFFFFF.toInt()
    private val medio = CuadroDeVideo.Tamanio(2, 2)

    /**
     * Arma un cuadro NV21 de [ancho]x[alto]: primero el plano de luminancia que
     * dicte [luz] y después el de croma, con un par (V,U) cada 2x2 pixeles.
     */
    private fun cuadro(ancho: Int, alto: Int, croma: Int = cromaNeutra, luz: (x: Int, y: Int) -> Int): ByteArray {
        val datos = ByteArray(ancho * alto * 3 / 2)
        for (y in 0 until alto) {
            for (x in 0 until ancho) datos[y * ancho + x] = luz(x, y).toByte()
        }
        for (i in ancho * alto until datos.size) datos[i] = croma.toByte()
        return datos
    }

    // ---- Tamaño de destino ----

    @Test
    fun reescalaA640ConservandoLaRelacionDeAspecto() {
        assertEquals(CuadroDeVideo.Tamanio(640, 360), CuadroDeVideo.tamanioDestino(1920, 1080))
        assertEquals(CuadroDeVideo.Tamanio(640, 360), CuadroDeVideo.tamanioDestino(1280, 720))
        assertEquals(CuadroDeVideo.Tamanio(640, 480), CuadroDeVideo.tamanioDestino(1024, 768))
    }

    /** Un cuadro que ya entra en 640 se manda como viene: agrandarlo no suma nada. */
    @Test
    fun unCuadroMasChicoQueElMaximoNoSeAgranda() {
        assertEquals(CuadroDeVideo.Tamanio(320, 240), CuadroDeVideo.tamanioDestino(320, 240))
    }

    @Test
    fun losDosLadosQuedanPares() {
        // 100x75 tiene el alto impar y el destino lo baja a 74: el plano de
        // croma del NV21 va de a dos pixeles
        assertEquals(CuadroDeVideo.Tamanio(100, 74), CuadroDeVideo.tamanioDestino(100, 75))
        assertEquals(CuadroDeVideo.Tamanio(80, 60), CuadroDeVideo.tamanioDestino(81, 61))
    }

    @Test
    fun unTamanioImposibleNoSeCalcula() {
        assertThrows(IllegalArgumentException::class.java) { CuadroDeVideo.tamanioDestino(0, 0) }
        assertThrows(IllegalArgumentException::class.java) { CuadroDeVideo.tamanioDestino(640, 1) }
    }

    // ---- Conversión NV21 → ARGB ----

    @Test
    fun elSubmuestreoTomaElPixelQueCorresponde() {
        // De 4x4 a 2x2 el vecino más cercano cae en (0,0), (2,0), (0,2) y (2,2)
        val muestreados = setOf(0 to 0, 2 to 0, 0 to 2, 2 to 2)
        val datos = cuadro(4, 4) { x, y -> if ((x to y) in muestreados) blanco else negro }

        val pixeles = CuadroDeVideo.nv21AArgb(datos, 0, 4, 4, medio)!!

        assertEquals(4, pixeles.size)
        assertTrue(
            "los cuatro pixeles del destino tendrían que ser blancos: ${pixeles.toList()}",
            pixeles.all { it == argbBlanco },
        )
    }

    /** El mismo cuadro dado vuelta: si tomara los vecinos, saldría blanco. */
    @Test
    fun elSubmuestreoNoTomaLosPixelesDeAlLado() {
        val muestreados = setOf(0 to 0, 2 to 0, 0 to 2, 2 to 2)
        val datos = cuadro(4, 4) { x, y -> if ((x to y) in muestreados) negro else blanco }

        val pixeles = CuadroDeVideo.nv21AArgb(datos, 0, 4, 4, medio)!!

        assertTrue(
            "los cuatro pixeles del destino tendrían que ser negros: ${pixeles.toList()}",
            pixeles.all { it == argbNegro },
        )
    }

    /** El MSDK entrega su buffer con un desplazamiento: no es el arranque del arreglo. */
    @Test
    fun unOffsetDistintoDeCeroNoCorreLaImagen() {
        val datos = cuadro(4, 4) { x, _ -> if (x < 2) blanco else negro }
        val conBasuraAdelante = ByteArray(7) { 0x5A.toByte() } + datos

        val conOffset = CuadroDeVideo.nv21AArgb(conBasuraAdelante, 7, 4, 4, medio)!!
        val sinOffset = CuadroDeVideo.nv21AArgb(datos, 0, 4, 4, medio)!!

        assertArrayEquals(sinOffset, conOffset)
        // Y la mitad izquierda del cuadro sigue siendo la blanca
        assertEquals(argbBlanco, conOffset[0])
        assertEquals(argbNegro, conOffset[1])
    }

    @Test
    fun unCuadroMasCortoDeLoDeclaradoSeDescarta() {
        val datos = cuadro(4, 4) { _, _ -> blanco }

        assertNull(CuadroDeVideo.nv21AArgb(datos.copyOf(datos.size - 1), 0, 4, 4, medio))
        // Con offset pasa lo mismo: lo que queda después del offset no alcanza
        assertNull(CuadroDeVideo.nv21AArgb(datos, 1, 4, 4, medio))
    }

    @Test
    fun unCuadroConMedidasImposiblesSeDescarta() {
        assertNull(CuadroDeVideo.nv21AArgb(ByteArray(24), 0, 0, 0, medio))
        assertNull(CuadroDeVideo.nv21AArgb(ByteArray(24), -1, 4, 4, medio))
    }

    /**
     * Croma al máximo con luminancia al máximo: el rojo y el azul se van por
     * arriba de 255 y, sin recortar, se comerían los bits del canal de al lado
     * (el pixel saldría transparente en vez de saturado).
     */
    @Test
    fun losCanalesSeRecortanA0255() {
        val datos = cuadro(2, 2, croma = 255) { _, _ -> blanco }

        val pixeles = CuadroDeVideo.nv21AArgb(datos, 0, 2, 2, medio)!!

        pixeles.forEach { pixel ->
            assertEquals("el pixel tiene que quedar opaco", 0xFF, pixel ushr 24)
            assertEquals("rojo saturado, no dado vuelta", 255, (pixel shr 16) and 0xFF)
            assertEquals("azul saturado, no dado vuelta", 255, pixel and 0xFF)
        }
    }

    /** El negro del NV21 es Y=0, por debajo del 16 del rango de video. */
    @Test
    fun laLuminanciaPorDebajoDelRangoDeVideoDaNegroYNoBasura() {
        val datos = cuadro(2, 2) { _, _ -> 0 }

        val pixeles = CuadroDeVideo.nv21AArgb(datos, 0, 2, 2, medio)!!

        assertTrue(pixeles.all { it == argbNegro })
    }
}
