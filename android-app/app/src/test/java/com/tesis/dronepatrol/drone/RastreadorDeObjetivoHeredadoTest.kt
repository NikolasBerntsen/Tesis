package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El rastreador de B en el traspaso de un relevo (docs/RELEVOS.md §3.5): arranca
 * con la estimación de A, no de cero. Lo que importa es que en el instante del
 * traspaso diga exactamente lo que A decía, y que de ahí en más se comporte
 * como el de A: sin extrapolar dos veces lo que A ya extrapoló y contando el
 * tiempo sin verlo desde la última vista de A.
 */
class RastreadorDeObjetivoHeredadoTest {

    private companion object {
        const val LAT = -34.85062
        const val LON = -56.19951
        const val T0 = 5_000_000L
    }

    private fun metrosDesde(e: RastreadorDeObjetivo.Estimacion) = Geo.distanciaM(LAT, LON, e.lat, e.lon)

    private fun auto(vistoHaceMs: Long, vEsteMs: Double = 4.2) =
        RastreadorDeObjetivo.heredado("VEHICLE", LAT, LON, 0.0, vEsteMs, true, vistoHaceMs, T0)

    @Test
    fun enElTraspasoDiceExactamenteLoQueDecíaA() {
        val e = auto(vistoHaceMs = 600).estimar(T0)

        assertEquals(LAT, e.lat, 1e-9)
        assertEquals(LON, e.lon, 1e-9)
        assertTrue(e.enMovimiento)
        assertEquals(0.0, e.vNorteMs, 1e-9)
        assertEquals(4.2, e.vEsteMs, 1e-9)
        assertEquals(4.2, e.velocidadMs, 1e-9)
        assertEquals(90.0, e.rumboGrados, 1e-6)
        assertEquals("hace cuánto lo vio A, no B", 600L, e.vistoHaceMs)
        assertFalse(e.perdido)
    }

    @Test
    fun arrancaSinDeteccionesPropias() {
        val r = auto(vistoHaceMs = 600)
        assertEquals("ninguna detección es de B todavía", 0, r.detecciones)
        assertEquals(T0 - 600, r.ultimaVistaMs)
        assertEquals("la clase es la de la alerta", "VEHICLE", r.clase)
    }

    /**
     * A ya extrapoló su estimación desde la última vista. Si B la tomara como
     * recién vista, le sumaría otros cuatro segundos de extrapolación encima y
     * lo buscaría donde el objetivo no está.
     */
    @Test
    fun noExtrapolaDosVecesLoQueAYaExtrapolo() {
        // Visto hace 3 s: A ya corrió la estimación 3 s; queda 1 s de los 4 del tope.
        val tarde = auto(vistoHaceMs = 3_000)
        assertEquals(4.2 * 1.0, metrosDesde(tarde.estimar(T0 + 2_000)), 0.05)

        // Visto hace 1 s: quedan 3 s de extrapolación, y ni uno más.
        val reciente = auto(vistoHaceMs = 1_000)
        assertEquals(4.2 * 2.0, metrosDesde(reciente.estimar(T0 + 2_000)), 0.05)
        assertEquals(4.2 * 3.0, metrosDesde(reciente.estimar(T0 + 10_000)), 0.05)
    }

    @Test
    fun aUnObjetivoQuietoNoSeLoExtrapola() {
        val r = RastreadorDeObjetivo.heredado("PERSON", LAT, LON, 0.4, 0.3, false, 2_000, T0)
        val e = r.estimar(T0 + 3_000)

        assertEquals(LAT, e.lat, 1e-9)
        assertEquals(LON, e.lon, 1e-9)
        assertFalse(e.enMovimiento)
        assertEquals("quieto no hay velocidad que seguir", 0.0, e.vNorteMs, 0.0)
        assertEquals(0.0, e.vEsteMs, 0.0)
        assertEquals("el ruido de A se conserva como dato", 0.5, e.velocidadMs, 1e-9)
    }

    @Test
    fun seDaPorPerdidoContandoDesdeLaUltimaVistaDeA() {
        val r = auto(vistoHaceMs = 9_000)
        val sinVerParaPerdido = RastreadorDeObjetivo.SIN_VER_PARA_PERDIDO_MS

        assertFalse(r.perdido(T0 + sinVerParaPerdido - 9_000))
        assertTrue(r.perdido(T0 + sinVerParaPerdido - 9_000 + 1))
        assertEquals("perdido, se lo busca más amplio", RastreadorDeObjetivo.PUERTA_DE_REENGANCHE_M, r.puertaM(T0 + 2_000), 0.0)
    }

    @Test
    fun laPuertaCreceConElTiempoQueHaceQueNadieLoVe() {
        val r = auto(vistoHaceMs = 2_000, vEsteMs = 4.0)
        // 15 m de base + 4 m/s × 2 s × 1,5
        assertEquals(27.0, r.puertaM(T0), 1e-9)
    }

    @Test
    fun unaVelocidadIncreibleSeRecortaYUnaQueNoEsNumeroEsCero() {
        val rapido = RastreadorDeObjetivo.heredado("VEHICLE", LAT, LON, 30.0, 40.0, true, 0, T0).estimar(T0)
        assertEquals(RastreadorDeObjetivo.VELOCIDAD_MAXIMA_CREIBLE_MS, rapido.velocidadMs, 1e-9)
        assertEquals("el rumbo se conserva", 53.13, rapido.rumboGrados, 0.01)

        val sinDato = RastreadorDeObjetivo.heredado("VEHICLE", LAT, LON, Double.NaN, Double.POSITIVE_INFINITY, true, 500, T0)
        val e = sinDato.estimar(T0 + 1_000)
        assertEquals(0.0, e.velocidadMs, 0.0)
        assertEquals("sin velocidad no se mueve de donde lo dejó A", LAT, e.lat, 1e-9)
        assertEquals(LON, e.lon, 1e-9)

        // Al revés: el infinito en el norte y el NaN en el este, que tampoco son un dato.
        val alReves = RastreadorDeObjetivo.heredado("VEHICLE", LAT, LON, Double.NEGATIVE_INFINITY, Double.NaN, true, 500, T0)
        assertEquals(0.0, alReves.estimar(T0 + 1_000).velocidadMs, 0.0)
    }

    @Test
    fun unaVistaNegativaCuentaComoRecienVisto() {
        val r = auto(vistoHaceMs = -500)
        assertEquals(T0, r.ultimaVistaMs)
        assertEquals(0L, r.estimar(T0).vistoHaceMs)
        assertEquals(LAT, r.estimar(T0).lat, 1e-9)
    }

    /**
     * Lo que B ve con su propia cámara después del traspaso se asocia al
     * objetivo heredado si cae donde se lo espera, y no a otra cosa que entró al
     * cuadro: es la diferencia entre relevar al objetivo y perseguir a otro.
     */
    @Test
    fun laPrimeraDeteccionDeBSeAsociaDondeSeLoEsperaba() {
        val r = auto(vistoHaceMs = 500, vEsteMs = 10.0)
        val t = T0 + 500
        val esperado = r.estimar(t)
        val otroQueEntro = Persecucion.desplazar(LAT, LON, 0.0, 60.0)

        val i = r.indiceMasCercano(listOf(otroQueEntro, esperado.lat to esperado.lon), t)
        assertEquals(1, i)

        r.actualizar(esperado.lat, esperado.lon, t)
        assertEquals(1, r.detecciones)
        assertEquals(t, r.ultimaVistaMs)
        val despues = r.estimar(t)
        assertTrue("sigue en movimiento", despues.enMovimiento)
        assertEquals(10.0, despues.velocidadMs, 0.5)
        assertEquals(90.0, despues.rumboGrados, 2.0)
    }
}
