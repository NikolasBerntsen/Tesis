package com.tesis.dronepatrol.drone

import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El rastreador del objetivo: el filtro, la histéresis de "se mueve / se
 * detuvo", la asociación de detecciones y la pérdida. Sin reloj propio, así
 * que los bordes se prueban exactos.
 */
class RastreadorDeObjetivoTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val T0 = 1_000_000L
    }

    private fun alNorte(metros: Double) = LAT + metros / Geo.METROS_POR_GRADO_LAT
    private fun alEste(metros: Double) = LON + metros / Geo.metrosPorGradoLon(LAT)

    @Test
    fun arrancaQuietoYDondeSeLoVio() {
        val r = RastreadorDeObjetivo("PERSON", LAT, LON, T0)
        val e = r.estimar(T0)
        assertEquals(LAT, e.lat, 1e-12)
        assertEquals(LON, e.lon, 1e-12)
        assertFalse(e.enMovimiento)
        assertFalse(e.perdido)
        assertEquals(0.0, e.vNorteMs, 0.0)
    }

    /** El ruido de la proyección (unos metros alrededor del mismo punto) no es movimiento. */
    @Test
    fun elRuidoAlrededorDelMismoPuntoNoEsMovimiento() {
        val r = RastreadorDeObjetivo("PERSON", LAT, LON, T0)
        val ruido = listOf(3.0 to -2.0, -2.5 to 3.0, 1.0 to 2.0, -3.0 to -1.0, 2.0 to -3.0, -1.0 to 1.5)
        var t = T0
        repeat(5) {
            ruido.forEach { (n, e) ->
                t += 500
                r.actualizar(alNorte(n), alEste(e), t)
            }
        }
        assertFalse(r.estimar(t).enMovimiento)
        assertTrue(Geo.distanciaM(LAT, LON, r.estimar(t).lat, r.estimar(t).lon) < 5.0)
    }

    /** Un vehículo que se va a 10 m/s pasa a "en movimiento" con la velocidad y el rumbo bien estimados. */
    @Test
    fun unVehiculoQueSeVaSeDetectaEnMovimientoConSuVelocidad() {
        val r = RastreadorDeObjetivo("VEHICLE", LAT, LON, T0)
        var t = T0
        var este = 0.0
        repeat(12) {
            t += 500
            este += 5.0 // 10 m/s al este
            r.actualizar(LAT, alEste(este), t)
        }
        val e = r.estimar(t)
        assertTrue(e.enMovimiento)
        assertEquals(10.0, e.velocidadMs, 1.5)
        assertEquals(90.0, e.rumboGrados, 5.0)
    }

    /** Un peatón lento (0,8 m/s) no supera el umbral de velocidad, pero termina saliendo de la órbita. */
    @Test
    fun unPeatonLentoTerminaContandoComoMovimientoPorDesplazamiento() {
        val r = RastreadorDeObjetivo("PERSON", LAT, LON, T0)
        var t = T0
        var norte = 0.0
        var seMovio = false
        repeat(60) {
            t += 500
            norte += 0.4
            r.actualizar(alNorte(norte), LON, t)
            if (r.enMovimiento) seMovio = true
        }
        assertTrue("con más de ${RastreadorDeObjetivo.DESPLAZAMIENTO_DE_MOVIMIENTO_M} m recorridos tiene que contar como movimiento", seMovio)
    }

    @Test
    fun alDetenerseVuelveAQuietoRecienDespuesDeLaQuietudSostenida() {
        val r = RastreadorDeObjetivo("VEHICLE", LAT, LON, T0)
        var t = T0
        var este = 0.0
        repeat(10) {
            t += 500
            este += 5.0
            r.actualizar(LAT, alEste(este), t)
        }
        assertTrue(r.enMovimiento)
        // Se detiene: mismas mediciones
        var quietoDesde = -1L
        repeat(60) {
            t += 500
            r.actualizar(LAT, alEste(este), t)
            if (!r.enMovimiento && quietoDesde < 0) quietoDesde = t
        }
        assertFalse(r.enMovimiento)
        // No antes de la quietud sostenida (más lo que tarda el filtro en frenar)
        assertTrue(quietoDesde - (T0 + 10 * 500) >= RastreadorDeObjetivo.QUIETUD_PARA_DETENIDO_MS)
    }

    @Test
    fun seDaPorPerdidoRecienPasadoElTiempoSinVerlo() {
        val r = RastreadorDeObjetivo("PERSON", LAT, LON, T0)
        assertFalse(r.perdido(T0 + RastreadorDeObjetivo.SIN_VER_PARA_PERDIDO_MS))
        assertTrue(r.perdido(T0 + RastreadorDeObjetivo.SIN_VER_PARA_PERDIDO_MS + 1))
        assertTrue(r.estimar(T0 + RastreadorDeObjetivo.SIN_VER_PARA_PERDIDO_MS + 1).perdido)
    }

    /** De dos detecciones, la que es el objetivo es la que cae cerca de donde se lo espera. */
    @Test
    fun asociaLaDeteccionMasCercanaDentroDeLaPuerta() {
        val r = RastreadorDeObjetivo("PERSON", LAT, LON, T0)
        val candidatos = listOf(
            alNorte(30.0) to LON, // otra persona, a 30 m
            alNorte(4.0) to alEste(-3.0), // el objetivo, corrido 5 m
        )
        assertEquals(1, r.indiceMasCercano(candidatos, T0 + 500))
    }

    @Test
    fun fueraDeLaPuertaNoAsociaNada() {
        val r = RastreadorDeObjetivo("PERSON", LAT, LON, T0)
        assertNull(r.indiceMasCercano(listOf(alNorte(40.0) to LON), T0 + 500))
    }

    /** Perdido, se lo busca más amplio: pudo moverse mientras no se lo veía. */
    @Test
    fun perdidoLaPuertaSeAgrandaParaReengancharlo() {
        val r = RastreadorDeObjetivo("PERSON", LAT, LON, T0)
        val lejos = listOf(alNorte(50.0) to LON)
        assertNull(r.indiceMasCercano(lejos, T0 + 500))
        val despues = T0 + RastreadorDeObjetivo.SIN_VER_PARA_PERDIDO_MS + 1_000
        assertEquals(0, r.indiceMasCercano(lejos, despues))
        // Y reenganchado, la posición nueva vale entera y deja de estar perdido
        r.actualizar(alNorte(50.0), LON, despues)
        assertFalse(r.perdido(despues))
        assertEquals(alNorte(50.0), r.estimar(despues).lat, 1e-9)
    }

    /** En movimiento, la estimación se adelanta con la velocidad, pero con tope. */
    @Test
    fun enMovimientoExtrapolaConTope() {
        val r = RastreadorDeObjetivo("VEHICLE", LAT, LON, T0)
        var t = T0
        var este = 0.0
        repeat(12) {
            t += 500
            este += 5.0
            r.actualizar(LAT, alEste(este), t)
        }
        val ahora = r.estimar(t)
        val en2s = r.estimar(t + 2_000)
        val en20s = r.estimar(t + 20_000)
        val avance2 = Geo.distanciaM(ahora.lat, ahora.lon, en2s.lat, en2s.lon)
        val avance20 = Geo.distanciaM(ahora.lat, ahora.lon, en20s.lat, en20s.lon)
        assertEquals(ahora.velocidadMs * 2, avance2, 2.0)
        assertEquals(ahora.velocidadMs * RastreadorDeObjetivo.PREDICCION_MAXIMA_MS / 1_000.0, avance20, 2.0)
    }

    /** Un salto absurdo de la proyección no da una velocidad absurda. */
    @Test
    fun laVelocidadTieneTecho() {
        val r = RastreadorDeObjetivo("VEHICLE", LAT, LON, T0)
        r.actualizar(LAT, alEste(500.0), T0 + 100)
        val e = r.estimar(T0 + 100)
        assertTrue(hypot(e.velocidadMs, 0.0) <= RastreadorDeObjetivo.VELOCIDAD_MAXIMA_CREIBLE_MS + 1e-9)
    }
}

class ZonasDescartadasTest {

    private val lat = -34.6037
    private val lon = -58.3816

    @Test
    fun contieneLoCercanoYNoLoLejano() {
        val zonas = ZonasDescartadas()
        zonas.agregar(lat, lon, 0L)
        assertTrue(zonas.contiene(lat + 20.0 / Geo.METROS_POR_GRADO_LAT, lon, 1_000L))
        assertFalse(zonas.contiene(lat + 100.0 / Geo.METROS_POR_GRADO_LAT, lon, 1_000L))
    }

    @Test
    fun caducan() {
        val zonas = ZonasDescartadas()
        zonas.agregar(lat, lon, 0L)
        assertTrue(zonas.contiene(lat, lon, ZonasDescartadas.DURACION_MS - 1))
        assertFalse(zonas.contiene(lat, lon, ZonasDescartadas.DURACION_MS))
        assertEquals(0, zonas.cantidad)
    }

    @Test
    fun unaPosicionSinGpsNoSeAgrega() {
        val zonas = ZonasDescartadas()
        zonas.agregar(Double.NaN, Double.NaN, 0L)
        assertEquals(0, zonas.cantidad)
    }
}

class PersecucionTest {

    private val lat = -34.6037
    private val lon = -58.3816

    private fun alEste(metros: Double) = lon + metros / Geo.metrosPorGradoLon(lat)

    /** A la distancia justa y con el objetivo quieto, el dron no se mueve y lo mira. */
    @Test
    fun aLaDistanciaJustaYConElObjetivoQuietoNoSeMueve() {
        val orden = Persecucion.calcular(lat, alEste(-Persecucion.DISTANCIA_M), 40.0, lat, lon, 0.0, 0.0)
        assertEquals(0.0, orden.vNorteMs, 1e-6)
        assertEquals(0.0, orden.vEsteMs, 1e-6)
        assertEquals(90.0, orden.rumboGrados, 0.5) // mira al este, hacia el objetivo
        assertEquals(Persecucion.DISTANCIA_M, orden.distanciaM, 0.1)
        assertTrue(orden.gimbalPitch < -50.0) // 40 m de alto a 25 m: mira bastante hacia abajo
    }

    /** Lejos, se acerca; demasiado cerca, se aleja: siempre hacia la distancia de separación. */
    @Test
    fun corrigeLaDistanciaHaciaLaSeparacion() {
        val lejos = Persecucion.calcular(lat, alEste(-60.0), 40.0, lat, lon, 0.0, 0.0)
        assertTrue("lejos tiene que acercarse (hacia el este)", lejos.vEsteMs > 0)
        val cerca = Persecucion.calcular(lat, alEste(-5.0), 40.0, lat, lon, 0.0, 0.0)
        assertTrue("cerca tiene que alejarse (hacia el oeste)", cerca.vEsteMs < 0)
    }

    /** Copia la velocidad del objetivo: a la distancia justa, se mueve con él. */
    @Test
    fun copiaLaVelocidadDelObjetivo() {
        val orden = Persecucion.calcular(lat, alEste(-Persecucion.DISTANCIA_M), 40.0, lat, lon, 6.0, 0.0)
        assertEquals(6.0, orden.vNorteMs, 1e-6)
        assertEquals(0.0, orden.vEsteMs, 1e-6)
    }

    @Test
    fun laVelocidadTieneTope() {
        val orden = Persecucion.calcular(lat, alEste(-2_000.0), 40.0, lat, lon, 30.0, 0.0)
        assertTrue(hypot(orden.vNorteMs, orden.vEsteMs) <= Persecucion.VELOCIDAD_MAXIMA_MS + 1e-9)
    }

    /** Encima del objetivo no hay "lado": se pone detrás de su marcha. */
    @Test
    fun encimaDelObjetivoSeUbicaDetrasDeSuMarcha() {
        val orden = Persecucion.calcular(lat, lon, 40.0, lat, lon, 0.0, 5.0)
        // Marcha al este: atrás es el oeste, así que la corrección empuja al oeste
        assertTrue(orden.vEsteMs < 5.0)
    }
}
