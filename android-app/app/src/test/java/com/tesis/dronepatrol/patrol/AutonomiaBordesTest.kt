package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.BaseDelHub
import com.tesis.dronepatrol.drone.Geo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Los bordes de las cuentas de energía (docs/RELEVOS.md §1, §4 y §5) con los
 * datos que llegan mal: un DJI que manda un número negativo, una altura que no
 * se sabe, un consumo en cero, un punto de visitantes a medias, una base propia
 * que no está en la lista. Ante la duda, lo que sale es el lado seguro: sin
 * autonomía no hay desvío, y lo que no se sabe se cuenta como lo más caro.
 */
class AutonomiaBordesTest {

    private companion object {
        const val LAT0 = -34.8565
        const val LON0 = -56.2075
        const val T0 = 1_000_000L

        fun punto(norteM: Double, esteM: Double = 0.0): Pair<Double, Double> =
            (LAT0 + norteM / Geo.METROS_POR_GRADO_LAT) to (LON0 + esteM / Geo.metrosPorGradoLon(LAT0))

        fun base(id: Long, norteM: Double, esteM: Double = 0.0): BaseDelHub {
            val (lat, lon) = punto(norteM, esteM)
            return BaseDelHub(id, "Base $id", lat, lon, null, null)
        }

        val PROPIA = base(1, 0.0)
        val SUR = base(2, 900.0)
    }

    private fun situacion(
        norteM: Double = 1_000.0,
        bateria: Double = 21.0,
        pctParaVolver: Double = 20.0,
        pctParaAterrizar: Double = 2.0,
        altM: Double = 40.0,
        casa: Pair<Double, Double>? = PROPIA.lat to PROPIA.lon,
        bases: List<BaseDelHub> = listOf(PROPIA, SUR),
        propiaId: Long? = 1L,
        porKm: Double = Double.NaN,
        porS: Double = Double.NaN,
        ahora: Long = T0,
    ): Autonomia.Situacion {
        val (lat, lon) = punto(norteM)
        return Autonomia.Situacion(
            ahora, bateria, lat, lon, altM, pctParaVolver, pctParaAterrizar, Double.NaN, Double.NaN,
            casa?.first ?: Double.NaN, casa?.second ?: Double.NaN, bases, propiaId, porKm, porS,
        )
    }

    @Test
    fun unNumeroNegativoDelDjiNoEsAutonomia() {
        assertFalse(Autonomia.informada(-1.0))
        assertFalse(Autonomia.informada(Double.POSITIVE_INFINITY))
        assertEquals(PatrolManager.LOW_BATTERY_PCT, Autonomia.piso(-1.0), 0.0)
    }

    @Test
    fun losSegundosDisponiblesConDatosQueFaltan() {
        assertNull("sin batería no se sabe", Autonomia.segundosDisponibles(Double.NaN, 10.0, 0.1))
        val porDefecto = (40.0 - 18.0) / Autonomia.CONSUMO_POR_DEFECTO_PCT_POR_S
        assertEquals("un consumo en cero es no medido", porDefecto, Autonomia.segundosDisponibles(40.0, 10.0, 0.0)!!, 1e-6)
        assertEquals(porDefecto, Autonomia.segundosDisponibles(40.0, 10.0, Double.NaN)!!, 1e-6)
        assertEquals("nunca negativo", 0.0, Autonomia.segundosDisponibles(10.0, 10.0, 0.1)!!, 0.0)
        assertEquals("tope del contrato", 3_600.0, Autonomia.segundosDisponibles(99.0, 1.0, 0.001)!!, 0.0)
    }

    @Test
    fun elDisparoUsaSoloLoQueEsUnDato() {
        assertTrue(Autonomia.disparoDeUltimaUbicacion(-1.0, -5.0).isNaN())
        assertEquals(13.0, Autonomia.disparoDeUltimaUbicacion(Double.NaN, 10.0), 0.0)
        assertEquals(7.0, Autonomia.disparoDeUltimaUbicacion(2.0, Double.NaN), 0.0)
        assertEquals(13.0, Autonomia.disparoDeUltimaUbicacion(2.0, 10.0), 0.0)
    }

    @Test
    fun unPuntoDeVisitantesAMediasNoEsUnPunto() {
        val aMedias = BaseDelHub(3, "X", LAT0, LON0, -34.0, null)
        val (lat, lon) = Autonomia.puntoDeVisitantes(aMedias)
        assertEquals("15 m al norte", 15.0, (lat - LAT0) * Geo.METROS_POR_GRADO_LAT, 1e-6)
        assertEquals(LON0, lon, 0.0)
        val declarado = BaseDelHub(3, "X", LAT0, LON0, -34.0, -56.0)
        assertEquals(-34.0 to -56.0, Autonomia.puntoDeVisitantes(declarado))
    }

    @Test
    fun elCostoConLoQueNoSeSabeEsElMasCaro() {
        // 85 m hasta el punto de visitantes de Sur, 1000 m a casa: 20 × 85 / 1000 = 1,7.
        val sinAltura = Autonomia.costoDeOtraBase(situacion(altM = Double.NaN, pctParaAterrizar = Double.NaN, porS = 0.0), SUR)!!
        val subidaDesdeElSuelo = 60.0 / Autonomia.VELOCIDAD_DE_SUBIDA_MS * Autonomia.CONSUMO_POR_DEFECTO_PCT_POR_S
        assertEquals("sin altura se cuenta la subida entera, y sin el de aterrizar, cero", 1.7 + subidaDesdeElSuelo, sinAltura, 1e-6)
        val arriba = Autonomia.costoDeOtraBase(situacion(altM = 90.0, porS = 0.2), SUR)!!
        assertEquals("ya arriba de la de tránsito no hay subida", 1.7 + 2.0, arriba, 1e-6)

        assertNull("sin autonomía", Autonomia.costoDeOtraBase(situacion(pctParaVolver = Double.NaN), SUR))
        assertNull("sin casa ni base propia", Autonomia.costoDeOtraBase(situacion(casa = null, propiaId = null), SUR))
    }

    @Test
    fun cercaDeCasaElConsumoMedidoManda() {
        // A 150 m de casa: no se escala la cifra del DJI. Sur está a 765 m del dron.
        val sur = SUR
        val medido = Autonomia.costoDeOtraBase(situacion(norteM = 150.0, porKm = 12.0, altM = 60.0, pctParaAterrizar = 0.0), sur)!!
        assertEquals(12.0 * 0.765, medido, 1e-6)
        val poco = Autonomia.costoDeOtraBase(situacion(norteM = 150.0, porKm = 5.0, altM = 60.0, pctParaAterrizar = 0.0), sur)!!
        assertEquals("nunca menos de 8 %/km", 8.0 * 0.765, poco, 1e-6)
    }

    @Test
    fun sinBasePropiaEnLaListaNiCasaNadaEstaDentroDelEnlace() {
        val d0 = Autonomia.decidirRegreso(situacion(propiaId = 9L), Autonomia.Memoria())
        val d1 = Autonomia.decidirRegreso(situacion(propiaId = 9L, ahora = T0 + 10_000), d0.memoria)
        // Con casa (el punto de retorno) sí hay enlace: Sur es candidata.
        assertTrue(d1.destino is Autonomia.Destino.OtraBase)

        val e0 = Autonomia.decidirRegreso(situacion(casa = null, propiaId = 9L), Autonomia.Memoria())
        assertSame("sin casa ni propia no se sabe ni a cuánto está casa", Autonomia.Destino.BasePropia, e0.destino)
    }

    @Test
    fun laComprometidaQueDejaDeAlcanzarSinOtraSigueSiendoElDestino() {
        val d0 = Autonomia.decidirRegreso(situacion(), Autonomia.Memoria())
        val d1 = Autonomia.decidirRegreso(situacion(ahora = T0 + 10_000), d0.memoria)
        assertEquals(SUR, d1.memoria.comprometida)
        // Ya no alcanza (3 %), sostenido, y no hay otra: sigue hacia Sur, sabiendo que no llega.
        val d2 = Autonomia.decidirRegreso(situacion(norteM = 1_100.0, bateria = 3.0, pctParaAterrizar = Double.NaN, ahora = T0 + 11_000), d1.memoria)
        assertEquals(Autonomia.Destino.OtraBase(SUR, alcanzable = false), d2.destino)
        val d3 = Autonomia.decidirRegreso(
            situacion(norteM = 1_100.0, bateria = 3.0, pctParaAterrizar = Double.NaN, ahora = T0 + 22_000),
            d2.memoria,
        )
        assertEquals(Autonomia.Destino.OtraBase(SUR, alcanzable = false), d3.destino)
        assertEquals(T0 + 11_000, d3.memoria.inalcanzableDesdeMs)
        // Si vuelve a alcanzar, se olvida que no alcanzaba.
        val d4 = Autonomia.decidirRegreso(situacion(norteM = 950.0, bateria = 30.0, ahora = T0 + 23_000), d3.memoria)
        assertEquals(Autonomia.Destino.OtraBase(SUR, alcanzable = true), d4.destino)
        assertNull(d4.memoria.inalcanzableDesdeMs)
    }

    @Test
    fun conElAlcanceQueSobraLlega() {
        val s = situacion(bateria = 60.0).copy(alcanceM = 5_000.0)
        val d = Autonomia.decidirRegreso(s, Autonomia.Memoria())
        assertSame(Autonomia.Destino.BasePropia, d.destino)
        assertNull(d.memoria.noLlegaDesdeMs)
    }

    @Test
    fun sinPosicionNoEstaFueraDeBaseNiEnNinguna() {
        assertFalse(Autonomia.fueraDeBase(Double.NaN, Double.NaN, listOf(PROPIA), Double.NaN, Double.NaN))
        val (lat, lon) = punto(30.0)
        assertFalse("cerca de casa aunque no haya bases", Autonomia.fueraDeBase(lat, lon, emptyList(), LAT0, LON0))
        assertTrue(Autonomia.fueraDeBase(lat + 0.01, lon, emptyList(), LAT0, LON0))
    }
}
