package com.tesis.dronepatrol.drone

import kotlin.math.tan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Dónde cae en el terreno lo que la cámara ve. Los casos son geometría de
 * manual: con la cámara al nadir el centro del cuadro es el dron, con 70° de
 * inclinación está a alt/tan(70°) adelante, y un rayo al horizonte no corta
 * el suelo.
 */
class GeorreferenciaTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
    }

    private fun metrosNorte(o: Georreferencia.Objetivo) = (o.lat - LAT) * Geo.METROS_POR_GRADO_LAT
    private fun metrosEste(o: Georreferencia.Objetivo) = (o.lon - LON) * Geo.metrosPorGradoLon(LAT)

    @Test
    fun `al nadir el centro del cuadro es el propio dron`() {
        val o = Georreferencia.proyectar(LAT, LON, ALT, 123.0, -90.0, 0.5, 0.5)

        assertNotNull(o)
        assertEquals(0.0, o!!.distanciaM, 0.01)
    }

    @Test
    fun `con 70 grados de inclinacion el centro esta a alt sobre tan70 adelante`() {
        val o = Georreferencia.proyectar(LAT, LON, ALT, 0.0, -70.0, 0.5, 0.5)!!

        assertEquals(ALT / tan(Math.toRadians(70.0)), o.distanciaM, 0.05)
        assertEquals(0.0, o.rumboGrados, 0.01)
        assertEquals(o.distanciaM, metrosNorte(o), 0.05)
        assertEquals(0.0, metrosEste(o), 0.05)
    }

    @Test
    fun `el rumbo del dron rota el objetivo`() {
        val o = Georreferencia.proyectar(LAT, LON, ALT, 90.0, -70.0, 0.5, 0.5)!!

        assertEquals(90.0, o.rumboGrados, 0.01)
        assertEquals(o.distanciaM, metrosEste(o), 0.05)
        assertEquals(0.0, metrosNorte(o), 0.05)
    }

    @Test
    fun `una caja a la derecha del cuadro queda a la derecha del rumbo y mas lejos`() {
        val centro = Georreferencia.proyectar(LAT, LON, ALT, 0.0, -70.0, 0.5, 0.5)!!
        val derecha = Georreferencia.proyectar(LAT, LON, ALT, 0.0, -70.0, 1.0, 0.5)!!

        // Con la cámara a 70° el borde derecho del cuadro queda a unos 65° del
        // rumbo: el ancho de la imagen se proyecta sobre un rayo muy inclinado.
        assertTrue("rumbo ${derecha.rumboGrados}", derecha.rumboGrados in 55.0..75.0)
        assertTrue(derecha.distanciaM > centro.distanciaM)
        assertTrue(metrosEste(derecha) > 5.0)
    }

    @Test
    fun `arriba del cuadro esta mas lejos y abajo mas cerca`() {
        val arriba = Georreferencia.proyectar(LAT, LON, ALT, 0.0, -70.0, 0.5, 0.0)!!
        val centro = Georreferencia.proyectar(LAT, LON, ALT, 0.0, -70.0, 0.5, 0.5)!!
        val abajo = Georreferencia.proyectar(LAT, LON, ALT, 0.0, -70.0, 0.5, 1.0)!!

        assertTrue(arriba.distanciaM > centro.distanciaM)
        assertTrue(abajo.distanciaM < centro.distanciaM)
    }

    /** Con la cámara al nadir, abajo en la imagen es atrás del dron: el rayo pasa el nadir. */
    @Test
    fun `al nadir el borde de abajo del cuadro cae atras del dron`() {
        val abajo = Georreferencia.proyectar(LAT, LON, ALT, 0.0, -90.0, 0.5, 1.0)!!

        assertEquals(180.0, abajo.rumboGrados, 0.01)
        assertTrue(metrosNorte(abajo) < -5.0)
    }

    @Test
    fun `un rayo al horizonte no corta el suelo`() {
        assertNull(Georreferencia.proyectar(LAT, LON, ALT, 0.0, -10.0, 0.5, 0.0))
        assertNull(Georreferencia.proyectar(LAT, LON, ALT, 0.0, 0.0, 0.5, 0.5))
    }

    @Test
    fun `sin altura no hay proyeccion y la distancia tiene tope`() {
        assertNull(Georreferencia.proyectar(LAT, LON, 0.5, 0.0, -70.0, 0.5, 0.5))
        val rasante = Georreferencia.proyectar(LAT, LON, 120.0, 0.0, -12.0, 0.5, 0.5)!!
        assertEquals(Georreferencia.DISTANCIA_MAXIMA_M, rasante.distanciaM, 0.0)
    }

    @Test
    fun `la inclinacion para orbitar apunta al centro del circulo`() {
        assertEquals(-56.3, Georreferencia.inclinacionParaOrbitar(45.0, 30.0), 0.1)
        assertEquals(-90.0, Georreferencia.inclinacionParaOrbitar(100.0, 0.0), 0.0)
        assertEquals(-10.0, Georreferencia.inclinacionParaOrbitar(1.0, 100.0), 0.0)
    }
}
