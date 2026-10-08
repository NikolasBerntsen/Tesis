package com.tesis.dronepatrol.drone

import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * La cuenta de cada vuelta del lazo de navegación, que el DJI y el simulador
 * comparten: hacia dónde y a qué velocidad, con el frenado al llegar y el
 * control de altura.
 */
class NavegacionTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        val M_POR_GRADO_LON = Geo.metrosPorGradoLon(LAT)
    }

    @Test
    fun `lejos del objetivo va a velocidad de crucero y con el rumbo correcto`() {
        // 500 m al este
        val paso = Navegacion.hacia(LAT, LON, LAT, LON + 500 / M_POR_GRADO_LON)

        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS, hypot(paso.vNorteMs, paso.vEsteMs), 1e-6)
        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS, paso.vEsteMs, 1e-6)
        assertEquals(0.0, paso.vNorteMs, 1e-6)
        assertEquals(90.0, paso.rumboGrados, 0.5)
        assertEquals(500.0, paso.distanciaM, 1.0)
        assertFalse(paso.llego)
    }

    @Test
    fun `hacia el sur el rumbo es 180 y la velocidad norte negativa`() {
        val paso = Navegacion.hacia(LAT, LON, LAT - 200 / Geo.METROS_POR_GRADO_LAT, LON)

        assertEquals(180.0, paso.rumboGrados, 0.5)
        assertTrue(paso.vNorteMs < 0)
        assertEquals(0.0, paso.vEsteMs, 1e-6)
    }

    /** Cerca del punto frena en proporción: a mitad de la distancia de frenado va a la mitad. */
    @Test
    fun `cerca del objetivo frena en proporcion a lo que falta`() {
        val mitad = Navegacion.DISTANCIA_DE_FRENADO_M / 2
        val paso = Navegacion.hacia(LAT, LON, LAT + mitad / Geo.METROS_POR_GRADO_LAT, LON)

        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS / 2, hypot(paso.vNorteMs, paso.vEsteMs), 0.05)
    }

    @Test
    fun `dentro del umbral de llegada manda cero y avisa que llego`() {
        val paso = Navegacion.hacia(LAT, LON, LAT + 2 / Geo.METROS_POR_GRADO_LAT, LON)

        assertTrue(paso.llego)
        assertEquals(0.0, paso.vNorteMs, 0.0)
        assertEquals(0.0, paso.vEsteMs, 0.0)
    }

    @Test
    fun `respeta la velocidad maxima que se le pide`() {
        val paso = Navegacion.hacia(LAT, LON, LAT + 1.0, LON, vMaxMs = Navegacion.VELOCIDAD_ORBITA_MS)

        assertEquals(Navegacion.VELOCIDAD_ORBITA_MS, hypot(paso.vNorteMs, paso.vEsteMs), 1e-6)
    }

    @Test
    fun `la altura sube con tope, baja con tope y se queda quieta en el umbral`() {
        assertEquals(Navegacion.VELOCIDAD_VERTICAL_MS, Navegacion.vertical(altM = 1.2, objetivoM = 40.0), 0.0)
        assertEquals(-Navegacion.VELOCIDAD_VERTICAL_MS, Navegacion.vertical(altM = 60.0, objetivoM = 40.0), 0.0)
        assertEquals(0.0, Navegacion.vertical(altM = 40.8, objetivoM = 40.0), 0.0)
        assertEquals(0.0, Navegacion.vertical(altM = 39.4, objetivoM = 40.0), 0.0)
        // y en los últimos metros frena en proporción
        assertEquals(1.0, Navegacion.vertical(altM = 36.0, objetivoM = 40.0), 1e-9)
    }

    @Test
    fun `a la altura se decide con la misma tolerancia que el control`() {
        assertTrue(Navegacion.aLaAltura(40.9, 40.0))
        assertFalse(Navegacion.aLaAltura(42.0, 40.0))
    }
}
