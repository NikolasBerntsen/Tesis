package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * La revisión de los umbrales de batería que el DJI trae configurados (RELEVOS
 * §0): un crítico desde 20 % o un aviso por encima del regreso de la app (25 %)
 * le ganan a la lógica de la app, y el operador tiene que saberlo al conectar.
 */
class UmbralesDelDjiTest {

    private val regresoDeLaApp = 25.0

    @Test
    fun losDeFabricaEstanBien() {
        assertNull(UmbralesDelDji.problema(criticoPct = 10.0, avisoPct = 20.0, regresoDeLaAppPct = regresoDeLaApp))
    }

    @Test
    fun unCriticoDeVeintePorCientoEsUnProblema() {
        val problema = UmbralesDelDji.problema(20.0, 20.0, regresoDeLaApp)!!

        assertTrue(problema, problema.contains("crítica está en 20 %"))
        assertFalse(problema, problema.contains("aviso"))
    }

    @Test
    fun unCriticoJustoDebajoDeVeinteEstaBien() {
        assertNull(UmbralesDelDji.problema(19.0, 20.0, regresoDeLaApp))
    }

    @Test
    fun unAvisoPorEncimaDelRegresoDeLaAppEsUnProblema() {
        val problema = UmbralesDelDji.problema(10.0, 30.0, regresoDeLaApp)!!

        assertTrue(problema, problema.contains("aviso de batería baja está en 30 %"))
        assertTrue(problema, problema.contains("25 %"))
        assertFalse(problema, problema.contains("crítica"))
    }

    @Test
    fun unAvisoIgualAlRegresoDeLaAppEstaBien() {
        assertNull(UmbralesDelDji.problema(10.0, 25.0, regresoDeLaApp))
    }

    @Test
    fun losDosMalPuestosVanEnUnSoloAviso() {
        val problema = UmbralesDelDji.problema(25.0, 35.0, regresoDeLaApp)!!

        assertTrue(problema.startsWith("umbrales de batería del dron mal configurados en DJI Fly: "))
        assertEquals("los dos motivos, separados", 2, problema.substringAfter(": ").split("; ").size)
    }

    /** Mientras el SDK no los informa no hay nada que señalar. */
    @Test
    fun sinSaberlosNoHayProblema() {
        assertNull(UmbralesDelDji.problema(Double.NaN, Double.NaN, regresoDeLaApp))
        assertNull(UmbralesDelDji.problema(Double.NaN, 20.0, regresoDeLaApp))
    }
}
