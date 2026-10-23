package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cómo se lee la autonomía que informa el DJI en `KeyLowBatteryRTHInfo`
 * (RELEVOS §0): lo dudoso vale NaN y nunca un número, porque sin autonomía
 * informada la app se queda del lado seguro (el umbral fijo y el regreso propio
 * del dron), y con un número inventado se desviaría o estiraría el regreso.
 */
class AutonomiaInformadaTest {

    private fun leer(
        volver: Int? = 30,
        aterrizar: Int? = 4,
        alcance: Double? = 2_500.0,
        segundos: Int? = 180,
        enVuelo: Boolean = true,
        distancia: Double = 400.0,
    ) = AutonomiaInformada.delDji(volver, aterrizar, alcance, segundos, enVuelo, distancia)

    @Test
    fun losValoresDelSdkPasanTalCual() {
        val a = leer()

        assertEquals(30.0, a.pctParaVolver, 0.0)
        assertEquals(4.0, a.pctParaAterrizar, 0.0)
        assertEquals(2_500.0, a.alcanceM, 0.0)
        assertEquals(180.0, a.segundosParaVolver, 0.0)
    }

    @Test
    fun unNullDelSdkEsNaNYNoCero() {
        val a = leer(volver = null, aterrizar = null, alcance = null, segundos = null)

        assertTrue(a.pctParaVolver.isNaN())
        assertTrue(a.pctParaAterrizar.isNaN())
        assertTrue(a.alcanceM.isNaN())
        assertTrue(a.segundosParaVolver.isNaN())
    }

    /** A 400 m de casa volver cuesta algo: un cero ahí es el SDK que todavía no calculó. */
    @Test
    fun unCeroEnVueloLejosDeCasaEsNaN() {
        val a = leer(volver = 0, aterrizar = 0, alcance = 0.0, segundos = 0, distancia = 400.0)

        assertTrue(a.pctParaVolver.isNaN())
        assertTrue(a.pctParaAterrizar.isNaN())
        assertTrue(a.alcanceM.isNaN())
        assertTrue(a.segundosParaVolver.isNaN())
    }

    /** Solo el cero es dudoso: los demás campos de la misma lectura valen. */
    @Test
    fun elCeroDudosoNoArrastraALosDemasCampos() {
        val a = leer(volver = 0, aterrizar = 3, distancia = 400.0)

        assertTrue(a.pctParaVolver.isNaN())
        assertEquals(3.0, a.pctParaAterrizar, 0.0)
        assertEquals(2_500.0, a.alcanceM, 0.0)
    }

    @Test
    fun unCeroEnVueloCercaDeCasaVale() {
        val a = leer(volver = 0, segundos = 0, distancia = AutonomiaInformada.DISTANCIA_CERO_DUDOSO_M)

        assertEquals(0.0, a.pctParaVolver, 0.0)
        assertEquals(0.0, a.segundosParaVolver, 0.0)
    }

    @Test
    fun unCeroEnElSueloValeAunqueEsteLejosDeCasa() {
        val a = leer(volver = 0, distancia = 5_000.0, enVuelo = false)

        assertEquals(0.0, a.pctParaVolver, 0.0)
    }

    /** Sin posición o sin punto de retorno no se sabe a cuánto está: en vuelo, el cero no se cree. */
    @Test
    fun sinSaberLaDistanciaElCeroEnVueloEsNaN() {
        val a = leer(volver = 0, distancia = Double.NaN)

        assertTrue(a.pctParaVolver.isNaN())
    }

    @Test
    fun unNegativoEsNaN() {
        val a = leer(volver = -1, alcance = -5.0, segundos = -3)

        assertTrue(a.pctParaVolver.isNaN())
        assertTrue(a.alcanceM.isNaN())
        assertTrue(a.segundosParaVolver.isNaN())
    }

    @Test
    fun unAlcanceNoFinitoEsNaN() {
        assertTrue(leer(alcance = Double.POSITIVE_INFINITY).alcanceM.isNaN())
        assertTrue(leer(alcance = Double.NaN).alcanceM.isNaN())
    }

    /** Por encima del contrato se recorta: "necesita más del 100 %" sigue queriendo decir que no llega. */
    @Test
    fun loQuePasaDelContratoSeRecortaAlTope() {
        val a = leer(volver = 140, aterrizar = 120, alcance = 250_000.0, segundos = 99_999)

        assertEquals(AutonomiaInformada.TOPE_PCT, a.pctParaVolver, 0.0)
        assertEquals(AutonomiaInformada.TOPE_PCT, a.pctParaAterrizar, 0.0)
        assertEquals(AutonomiaInformada.TOPE_ALCANCE_M, a.alcanceM, 0.0)
        assertEquals(AutonomiaInformada.TOPE_SEGUNDOS, a.segundosParaVolver, 0.0)
    }

    @Test
    fun laDesconocidaEsTodaNaN() {
        val a = AutonomiaInformada.DESCONOCIDA

        assertTrue(a.pctParaVolver.isNaN() && a.pctParaAterrizar.isNaN() && a.alcanceM.isNaN() && a.segundosParaVolver.isNaN())
    }
}
