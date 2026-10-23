package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El modelo de batería del simulador (RELEVOS §0): 4 % por minuto a 8 m/s de
 * crucero, y la autonomía que de ahí sale, que es la que el simulador informa
 * como lo haría el DJI real.
 */
class ModeloDeBateriaTest {

    private val modelo = ModeloDeBateria()

    @Test
    fun porDefectoGastaCuatroPorCientoPorMinutoACrucero() {
        assertEquals(4.0, modelo.consumoPctPorMinuto, 0.0)
        assertEquals(8.0, modelo.velocidadCruceroMs, 0.0)
        assertEquals(4.0, modelo.gastoPct(60.0), 1e-12)
        assertEquals(10.0, modelo.umbralCriticoPct, 0.0)
    }

    /** El CONSUMO_PCT_POR_KM del diseño: unos 8,3 %/km, por encima del mínimo de 8. */
    @Test
    fun elConsumoPorKilometroSaleDelPorMinutoYLaVelocidad() {
        // 1000 m a 8 m/s son 125 s; a 4 %/min, 125/60 × 4.
        assertEquals(125.0 / 60.0 * 4.0, modelo.consumoPctPorKm, 1e-9)
        assertTrue(modelo.consumoPctPorKm >= 8.0)
    }

    /**
     * A 1 km de casa y 40 m de altura: 125 s de crucero más 8 s de descenso
     * desde la altura de regreso; aterrizar donde está son los mismos 8 s.
     */
    @Test
    fun laAutonomiaLejosDeCasa() {
        val a = modelo.estimar(bateriaPct = 60.0, distanciaACasaM = 1_000.0, altM = 40.0)

        val porSegundo = 4.0 / 60.0
        assertEquals(133.0, a.segundosParaVolver, 1e-9)
        assertEquals(133.0 * porSegundo, a.pctParaVolver, 1e-9)
        assertEquals(8.0 * porSegundo, a.pctParaAterrizar, 1e-9)
        // Lo que queda después de guardar el descenso, en metros de crucero.
        val metros = (60.0 - 8.0 * porSegundo) / modelo.consumoPctPorKm * 1_000.0
        assertEquals((metros + 1_000.0) / 2.0, a.alcanceM, 1e-6)
    }

    /**
     * El alcance cae por debajo de la distancia justo cuando la batería deja de
     * alcanzar para volver: es lo que lee el desvío (RELEVOS §4).
     */
    @Test
    fun elAlcanceEsMenorQueLaDistanciaSiYSoloSiNoLlega() {
        val distancia = 3_000.0
        val pctParaVolver = modelo.estimar(50.0, distancia, 40.0).pctParaVolver

        val alcanza = modelo.estimar(pctParaVolver + 0.5, distancia, 40.0)
        val noAlcanza = modelo.estimar(pctParaVolver - 0.5, distancia, 40.0)

        assertTrue("con ${alcanza.alcanceM} m de alcance", alcanza.alcanceM > distancia)
        assertTrue("con ${noAlcanza.alcanceM} m de alcance", noAlcanza.alcanceM < distancia)
    }

    /**
     * Encima de casa no sube a la altura de regreso: baja desde donde está. Los
     * 2 m que le faltan cuestan su cuarto de segundo de crucero, nada más.
     */
    @Test
    fun encimaDeCasaVolverEsBajarDesdeDondeEsta() {
        val a = modelo.estimar(bateriaPct = 80.0, distanciaACasaM = 2.0, altM = 15.0)

        assertEquals(2.0 / 8.0 + 15.0 / 5.0, a.segundosParaVolver, 1e-9)
        assertEquals(modelo.gastoPct(3.0), a.pctParaAterrizar, 1e-12)
        assertEquals(modelo.gastoPct(3.25), a.pctParaVolver, 1e-12)
    }

    @Test
    fun enElSueloEnCasaNoCuestaNadaVolver() {
        val a = modelo.estimar(bateriaPct = 100.0, distanciaACasaM = 0.0, altM = 0.0)

        assertEquals(0.0, a.pctParaVolver, 0.0)
        assertEquals(0.0, a.pctParaAterrizar, 0.0)
        assertEquals(100.0 / modelo.consumoPctPorKm * 1_000.0 / 2.0, a.alcanceM, 1e-6)
    }

    @Test
    fun sinBateriaElAlcanceEsLaMitadDeLaDistanciaYNuncaNegativo() {
        val a = modelo.estimar(bateriaPct = 0.0, distanciaACasaM = 800.0, altM = 40.0)

        assertEquals(400.0, a.alcanceM, 1e-9)
    }

    @Test
    fun losTopesDelContratoSeRespetan() {
        val a = modelo.estimar(bateriaPct = 100.0, distanciaACasaM = 900_000.0, altM = 40.0)

        assertEquals(AutonomiaInformada.TOPE_PCT, a.pctParaVolver, 0.0)
        assertEquals(AutonomiaInformada.TOPE_ALCANCE_M, a.alcanceM, 0.0)
        assertEquals(AutonomiaInformada.TOPE_SEGUNDOS, a.segundosParaVolver, 0.0)
    }

    @Test
    fun conDatosSinSentidoNoSeInventaNada() {
        assertSame(AutonomiaInformada.DESCONOCIDA, modelo.estimar(Double.NaN, 100.0, 40.0))
        assertSame(AutonomiaInformada.DESCONOCIDA, modelo.estimar(50.0, Double.NaN, 40.0))
        assertSame(AutonomiaInformada.DESCONOCIDA, modelo.estimar(50.0, 100.0, Double.POSITIVE_INFINITY))
    }

    /** El DJI vuelve solo cuando la batería ya solo alcanza para el regreso más su reserva crítica. */
    @Test
    fun elRegresoPropioArrancaConLaReservaCriticaEncimaDeLoQueCuestaVolver() {
        val a = AutonomiaInformada(pctParaVolver = 12.0, pctParaAterrizar = 1.0, alcanceM = 900.0, segundosParaVolver = 200.0)

        assertFalse(modelo.pideRegresoPropio(22.1, a))
        assertTrue(modelo.pideRegresoPropio(22.0, a))
        assertFalse("sin saber cuánto cuesta volver no decide nada", modelo.pideRegresoPropio(1.0, AutonomiaInformada.DESCONOCIDA))
    }

    @Test
    fun elAterrizajeForzadoEsEnElUmbralCritico() {
        assertFalse(modelo.fuerzaAterrizaje(10.01))
        assertTrue(modelo.fuerzaAterrizaje(10.0))
    }

    @Test
    fun configurableParaLasPruebas() {
        val rapido = ModeloDeBateria(consumoPctPorMinuto = 60.0, velocidadCruceroMs = 10.0, umbralCriticoPct = 15.0)

        assertEquals(1.0, rapido.consumoPctPorSegundo, 1e-12)
        assertEquals(100.0, rapido.consumoPctPorKm, 1e-9)
        assertTrue(rapido.fuerzaAterrizaje(15.0))
    }

    @Test
    fun unModeloSinConsumoOSinVelocidadNoSeArma() {
        assertThrows(IllegalArgumentException::class.java) { ModeloDeBateria(consumoPctPorMinuto = 0.0) }
        assertThrows(IllegalArgumentException::class.java) { ModeloDeBateria(velocidadCruceroMs = -1.0) }
        assertThrows(IllegalArgumentException::class.java) { ModeloDeBateria(velocidadDescensoMs = 0.0) }
    }
}
