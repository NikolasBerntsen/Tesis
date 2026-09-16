package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Traducción de los ejes del mando virtual a velocidades. Es la escala que
 * comparten el dron simulado y el DJI, así que un error acá se siente igual en
 * los dos: por eso se prueban los signos uno por uno.
 */
class MandoVirtualTest {

    private val toleranciaMs = 1e-9

    // ---- Normalización de cada eje ----

    @Test
    fun laZonaMuertaCome() {
        assertEquals(0.0, MandoVirtual.eje(0.04), toleranciaMs)
        assertEquals(0.0, MandoVirtual.eje(-0.04), toleranciaMs)
        assertEquals(0.0, MandoVirtual.eje(0.0), toleranciaMs)
    }

    @Test
    fun fueraDeLaZonaMuertaElEjeQuedaComoVino() {
        assertEquals(0.2, MandoVirtual.eje(0.2), toleranciaMs)
        assertEquals(-0.2, MandoVirtual.eje(-0.2), toleranciaMs)
    }

    /**
     * El borde exacto de la zona muerta, que es el único valor que distingue el
     * `<` del `<=` en [MandoVirtual.eje]. Sin este caso se puede cambiar la
     * comparación y toda la suite sigue verde: los demás asserts caen en 0,04 o
     * en 0,2 y ninguno pisa el 0,05.
     */
    @Test
    fun elBordeDeLaZonaMuertaQuedaAfuera() {
        assertEquals(0.05, MandoVirtual.ZONA_MUERTA, toleranciaMs)
        assertEquals(0.05, MandoVirtual.eje(0.05), toleranciaMs)
        assertEquals(-0.05, MandoVirtual.eje(-0.05), toleranciaMs)
    }

    /** Y el valor inmediatamente por debajo del borde sí se lo come. */
    @Test
    fun justoPorDebajoDelBordeLaZonaMuertaCome() {
        assertEquals(0.0, MandoVirtual.eje(0.0499), toleranciaMs)
        assertEquals(0.0, MandoVirtual.eje(-0.0499), toleranciaMs)
    }

    /** La consola no tendría que mandar esto, pero el dron no se entera de eso. */
    @Test
    fun losEjesSeRecortanAMenosUnoYUno() {
        assertEquals(1.0, MandoVirtual.eje(3.7), toleranciaMs)
        assertEquals(-1.0, MandoVirtual.eje(-12.0), toleranciaMs)
    }

    /** Un eje que faltaba en el mensaje llega como NaN y vale cero, no basura. */
    @Test
    fun unEjeNaNCuentaComoCero() {
        assertEquals(0.0, MandoVirtual.eje(Double.NaN), toleranciaMs)
        assertTrue(MandoVirtual.velocidades(Double.NaN, Double.NaN, Double.NaN, Double.NaN).estacionario)
    }

    // ---- Ejes → velocidades ----

    @Test
    fun aFondoCadaEjeDaSuVelocidadMaxima() {
        val v = MandoVirtual.velocidades(1.0, 1.0, 1.0, 1.0)

        assertEquals(MandoVirtual.MAX_HORIZONTAL_MS, v.adelanteMs, toleranciaMs)
        assertEquals(MandoVirtual.MAX_HORIZONTAL_MS, v.derechaMs, toleranciaMs)
        assertEquals(MandoVirtual.MAX_YAW_GRADOS_S, v.giroGradosS, toleranciaMs)
        assertEquals(MandoVirtual.MAX_VERTICAL_MS, v.subidaMs, toleranciaMs)
    }

    @Test
    fun losSignosVanComoDiceElContrato() {
        val v = MandoVirtual.velocidades(pitch = -1.0, roll = -1.0, yaw = -1.0, throttle = -1.0)

        assertEquals("-1 en pitch es ir para atrás", -MandoVirtual.MAX_HORIZONTAL_MS, v.adelanteMs, toleranciaMs)
        assertEquals("-1 en roll es ir a la izquierda", -MandoVirtual.MAX_HORIZONTAL_MS, v.derechaMs, toleranciaMs)
        assertEquals("-1 en yaw es girar antihorario", -MandoVirtual.MAX_YAW_GRADOS_S, v.giroGradosS, toleranciaMs)
        assertEquals("-1 en throttle es bajar", -MandoVirtual.MAX_VERTICAL_MS, v.subidaMs, toleranciaMs)
    }

    @Test
    fun mediaPalancaEsMediaVelocidad() {
        val v = MandoVirtual.velocidades(0.5, 0.0, 0.0, 0.0)

        assertEquals(MandoVirtual.MAX_HORIZONTAL_MS / 2, v.adelanteMs, toleranciaMs)
        assertEquals(0.0, v.derechaMs, toleranciaMs)
    }

    @Test
    fun losCuatroEjesEnCeroSonVueloEstacionario() {
        assertTrue(MandoVirtual.velocidades(0.0, 0.0, 0.0, 0.0).estacionario)
        // Un dedo que casi soltó la palanca también es vuelo estacionario
        assertTrue(MandoVirtual.velocidades(0.03, -0.02, 0.0, 0.01).estacionario)
        assertFalse(MandoVirtual.velocidades(0.0, 0.0, 0.0, 0.3).estacionario)
    }

    // ---- Cuerpo del dron → terreno ----

    @Test
    fun conRumboNorteAdelanteEsIrAlNorte() {
        val t = MandoVirtual.aTerreno(MandoVirtual.velocidades(1.0, 0.0, 0.0, 0.0), rumboGrados = 0.0)

        assertEquals(MandoVirtual.MAX_HORIZONTAL_MS, t.norteMs, toleranciaMs)
        assertEquals(0.0, t.esteMs, toleranciaMs)
    }

    @Test
    fun conRumbo90AdelanteEsIrAlEste() {
        val t = MandoVirtual.aTerreno(MandoVirtual.velocidades(1.0, 0.0, 0.0, 0.0), rumboGrados = 90.0)

        assertEquals(MandoVirtual.MAX_HORIZONTAL_MS, t.esteMs, 1e-9)
        assertEquals(0.0, t.norteMs, 1e-9)
    }

    @Test
    fun conRumbo180AdelanteEsIrAlSur() {
        val t = MandoVirtual.aTerreno(MandoVirtual.velocidades(1.0, 0.0, 0.0, 0.0), rumboGrados = 180.0)

        assertEquals(-MandoVirtual.MAX_HORIZONTAL_MS, t.norteMs, 1e-9)
        assertEquals(0.0, t.esteMs, 1e-9)
    }

    /** Con la nariz al norte, la derecha del dron es el este. */
    @Test
    fun conRumboNorteLaDerechaEsElEste() {
        val t = MandoVirtual.aTerreno(MandoVirtual.velocidades(0.0, 1.0, 0.0, 0.0), rumboGrados = 0.0)

        assertEquals(MandoVirtual.MAX_HORIZONTAL_MS, t.esteMs, toleranciaMs)
        assertEquals(0.0, t.norteMs, toleranciaMs)
    }

    /** Con la nariz al este, la derecha del dron es el sur. */
    @Test
    fun conRumbo90LaDerechaEsElSur() {
        val t = MandoVirtual.aTerreno(MandoVirtual.velocidades(0.0, 1.0, 0.0, 0.0), rumboGrados = 90.0)

        assertEquals(-MandoVirtual.MAX_HORIZONTAL_MS, t.norteMs, 1e-9)
        assertEquals(0.0, t.esteMs, 1e-9)
    }

    /** El rumbo no cambia la velocidad total, solo la reparte entre los dos ejes. */
    @Test
    fun laRotacionNoCambiaLaVelocidadTotal() {
        val v = MandoVirtual.velocidades(0.8, -0.4, 0.0, 0.0)
        val t = MandoVirtual.aTerreno(v, rumboGrados = 37.0)

        val enElCuerpo = Math.hypot(v.adelanteMs, v.derechaMs)
        val sobreElTerreno = Math.hypot(t.norteMs, t.esteMs)
        assertEquals(enElCuerpo, sobreElTerreno, 1e-9)
    }
}
