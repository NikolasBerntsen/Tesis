package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** El rumbo que se le sostiene a la nariz con la palanca de giro suelta (ver [AnclaDeRumbo]). */
class AnclaDeRumboTest {

    @Test
    fun conLaPalancaSueltaAnclaElRumboQueTeniaYLoSostiene() {
        val ancla = AnclaDeRumbo()
        assertEquals(90.0, ancla.rumbo(giroSuelto = true, rumboActualGrados = 90.0)!!, 1e-9)
        // El dron se corrió unos grados por el viento: el ancla no se mueve.
        assertEquals(90.0, ancla.rumbo(giroSuelto = true, rumboActualGrados = 97.0)!!, 1e-9)
        assertEquals(90.0, ancla.rumbo(giroSuelto = true, rumboActualGrados = 84.0)!!, 1e-9)
    }

    @Test
    fun conLaPalancaDeGiroEnUsoNoHayAnclaYAlSoltarlaAnclaDondeQuedo() {
        val ancla = AnclaDeRumbo()
        ancla.rumbo(giroSuelto = true, rumboActualGrados = 90.0)
        assertNull(ancla.rumbo(giroSuelto = false, rumboActualGrados = 120.0))
        assertNull(ancla.rumbo(giroSuelto = false, rumboActualGrados = 150.0))
        assertEquals(150.0, ancla.rumbo(giroSuelto = true, rumboActualGrados = 150.0)!!, 1e-9)
    }

    @Test
    fun sinRumboDeLaBrujulaNoAnclaYLoIntentaEnLaVueltaSiguiente() {
        val ancla = AnclaDeRumbo()
        assertNull(ancla.rumbo(giroSuelto = true, rumboActualGrados = Double.NaN))
        assertTrue(ancla.rumboGrados.isNaN())
        assertEquals(10.0, ancla.rumbo(giroSuelto = true, rumboActualGrados = 10.0)!!, 1e-9)
    }

    @Test
    fun elRumboSePliegaACeroTrescientosSesenta() {
        assertEquals(350.0, AnclaDeRumbo().rumbo(giroSuelto = true, rumboActualGrados = -10.0)!!, 1e-9)
        assertEquals(5.0, AnclaDeRumbo().rumbo(giroSuelto = true, rumboActualGrados = 365.0)!!, 1e-9)
    }

    @Test
    fun soltarOlvidaElAncla() {
        val ancla = AnclaDeRumbo()
        ancla.rumbo(giroSuelto = true, rumboActualGrados = 90.0)
        ancla.soltar()
        assertTrue(ancla.rumboGrados.isNaN())
        assertEquals(200.0, ancla.rumbo(giroSuelto = true, rumboActualGrados = 200.0)!!, 1e-9)
    }
}
