package com.tesis.dronepatrol.drone

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.tesis.dronepatrol.model.Caja
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Las cajas sobre el cuadro de la consola: nunca puede dejarla sin video. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AnotadorDeCuadrosTest {

    private fun unJpeg(ancho: Int = 64, alto: Int = 36): ByteArray {
        val mapa = Bitmap.createBitmap(ancho, alto, Bitmap.Config.ARGB_8888)
        val salida = ByteArrayOutputStream()
        mapa.compress(Bitmap.CompressFormat.JPEG, 60, salida)
        return salida.toByteArray()
    }

    @Test
    fun `con cajas devuelve un jpeg del mismo tamano`() {
        val anotado = AnotadorDeCuadros.anotar(unJpeg(), listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.2, 0.3)))

        val mapa = BitmapFactory.decodeByteArray(anotado, 0, anotado.size)
        assertNotNull(mapa)
        assertEquals(64, mapa.width)
        assertEquals(36, mapa.height)
    }

    @Test
    fun `sin cajas devuelve el mismo cuadro`() {
        val cuadro = unJpeg()
        assertSame(cuadro, AnotadorDeCuadros.anotar(cuadro, emptyList()))
    }

    /**
     * Bytes que no son un JPEG no pueden tirar excepción: en Android el
     * decodificador devuelve null y el cuadro sale igual. Robolectric decodifica
     * cualquier cosa a un bitmap de mentira, así que acá solo se puede verificar
     * que no revienta y que devuelve algo.
     */
    @Test
    fun `un cuadro que no se puede decodificar no rompe el reparto`() {
        val basura = byteArrayOf(1, 2, 3)
        assertNotNull(AnotadorDeCuadros.anotar(basura, listOf(Caja("VEHICLE", 0.5, 0.5, 0.5, 0.1, 0.1))))
    }
}
