package com.tesis.dronepatrol.drone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * La espera que separa los reintentos de la habilitación del mando virtual.
 *
 * Existe por un defecto medido: `asegurarVirtualStick()` se llama en CADA vuelta
 * de los lazos de comando del DJI, que corren a 10 Hz, así que un rechazo del
 * dron se reintentaba —y se avisaba— diez veces por segundo, indefinidamente y
 * por un solo dron. Acá se mide que la segunda pregunta ya no sale en la vuelta
 * siguiente y que la frecuencia baja sola si el motivo no se va.
 *
 * Corre en la JVM pelada: no toca nada de Android.
 */
class EsperaCrecienteTest {

    private fun nueva() = EsperaCreciente(inicialMs = 500, topeMs = 5_000)

    /** Mientras no haya fracasado, no hay peaje: el primer intento sale ya. */
    @Test
    fun sinFracasosSeIntentaSiempre() {
        val espera = nueva()

        assertTrue(espera.sePuedeIntentar(0))
        assertTrue(espera.sePuedeIntentar(1))
        assertTrue(espera.sePuedeIntentar(999_999))
    }

    /**
     * El primer fracaso cuesta la espera inicial y ni un milisegundo menos: con
     * el lazo a 10 Hz, sin esto el reintento salía 100 ms después.
     */
    @Test
    fun despuesDeUnFracasoHayQueEsperarLaInicial() {
        val espera = nueva()
        espera.fracaso(1_000)

        assertFalse("a los 100 ms el lazo volvía a preguntar", espera.sePuedeIntentar(1_100))
        assertFalse("justo en el límite todavía no", espera.sePuedeIntentar(1_499))
        assertTrue("cumplidos los 500 ms sí", espera.sePuedeIntentar(1_500))
    }

    /** Si el motivo no se va, cada fracaso duplica la espera hasta el tope. */
    @Test
    fun cadaFracasoDuplicaLaEsperaHastaElTope() {
        val espera = nueva()

        espera.fracaso(0)
        assertTrue("primer fracaso: 500 ms", espera.sePuedeIntentar(500))
        espera.fracaso(500)
        assertFalse("segundo fracaso: 1 s", espera.sePuedeIntentar(1_400))
        assertTrue(espera.sePuedeIntentar(1_500))
        espera.fracaso(1_500)
        assertFalse("tercer fracaso: 2 s", espera.sePuedeIntentar(3_400))
        assertTrue(espera.sePuedeIntentar(3_500))
        espera.fracaso(3_500)
        assertFalse("cuarto fracaso: 4 s", espera.sePuedeIntentar(7_400))
        assertTrue(espera.sePuedeIntentar(7_500))
        espera.fracaso(7_500)
        assertFalse("quinto fracaso: el tope de 5 s", espera.sePuedeIntentar(12_400))
        assertTrue(espera.sePuedeIntentar(12_500))
        espera.fracaso(12_500)
        assertFalse("y de ahí no crece más", espera.sePuedeIntentar(17_400))
        assertTrue(espera.sePuedeIntentar(17_500))
    }

    /**
     * El dron aceptó: se borra la deuda. Si no, un rechazo viejo le seguiría
     * cobrando cinco segundos de espera a un mando que ya funciona.
     */
    @Test
    fun elExitoVuelveALaEsperaInicial() {
        val espera = nueva()
        espera.fracaso(0)
        espera.fracaso(500)
        espera.fracaso(1_500)

        espera.exito()

        assertTrue("después del éxito se puede intentar en cualquier momento", espera.sePuedeIntentar(1_501))
        espera.fracaso(2_000)
        assertFalse(espera.sePuedeIntentar(2_400))
        assertTrue("y el próximo fracaso vuelve a costar 500 ms", espera.sePuedeIntentar(2_500))
    }

    /**
     * El reloj del celular acomodándose hacia atrás (NTP, cambio de hora) no
     * puede dejar al operador sin mando hasta que el reloj recupere la
     * diferencia.
     */
    @Test
    fun elRelojParaAtrasNoDejaAlMandoBloqueado() {
        val espera = nueva()
        espera.fracaso(1_000_000)

        assertTrue("con el reloj corrido hacia atrás se deja intentar", espera.sePuedeIntentar(900_000))
    }
}
