package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cuándo se le contesta que no al regreso inteligente por batería del DJI
 * (RELEVOS §4): una vez por cuenta regresiva y solo con el regreso propio
 * negado; y cuándo arrancó el regreso, que es una toma aunque el Virtual Stick
 * no estuviera habilitado para enterarse.
 */
class VigiaDelRthPorBateriaTest {

    private val vigia = VigiaDelRthPorBateria()

    @Test
    fun conElRegresoPropioPermitidoNoSeContestaNada() {
        assertFalse(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)
        assertFalse(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)
    }

    @Test
    fun negadoSeContestaUnaVezPorCuentaRegresiva() {
        vigia.alPermitir(false)

        assertTrue(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)
        // El SDK actualiza cada segundo mientras cuenta: no es otra respuesta.
        assertFalse(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)
        assertFalse(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)

        // Terminó (se canceló) y vuelve a contar: es otra cuenta.
        assertFalse(vigia.alCambiarEstado("CANCELLED").contestarQueNo)
        assertTrue(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)
    }

    /** Negarlo con la cuenta en curso contesta en el acto: la próxima actualización puede ser tarde. */
    @Test
    fun negarloConLaCuentaEnCursoContestaEnElActo() {
        vigia.alCambiarEstado("COUNTING_DOWN")

        assertTrue(vigia.alPermitir(false))
        assertFalse("ya contestado", vigia.alPermitir(false))
        assertFalse(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)
    }

    @Test
    fun negarloSinCuentaEnCursoNoContestaNada() {
        assertFalse(vigia.alPermitir(false))
        vigia.alCambiarEstado("IDLE")
        assertFalse(vigia.alPermitir(false))
    }

    /** Si la respuesta no llegó al dron, se reintenta con la actualización siguiente (al ritmo del SDK, no en lazo). */
    @Test
    fun unaRespuestaQueFallaSeReintentaConLaProximaNovedad() {
        vigia.alPermitir(false)
        assertTrue(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)

        vigia.alFallarLaRespuesta()

        assertTrue(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)
    }

    @Test
    fun volverAPermitirloDejaDeContestar() {
        vigia.alPermitir(false)
        vigia.alPermitir(true)

        assertFalse(vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)
    }

    @Test
    fun elArranqueDelRegresoEsLaTransicionAEjecutado() {
        assertFalse(vigia.alCambiarEstado("COUNTING_DOWN").arrancoElRegreso)
        assertTrue(vigia.alCambiarEstado("EXECUTED").arrancoElRegreso)
        // Sigue en EXECUTED (por ejemplo, después de aterrizar): no es otro arranque.
        assertFalse(vigia.alCambiarEstado("EXECUTED").arrancoElRegreso)
        vigia.alCambiarEstado("IDLE")
        assertTrue(vigia.alCambiarEstado("EXECUTED").arrancoElRegreso)
    }

    @Test
    fun recuerdaElUltimoEstadoParaElMotivoDeUnRegreso() {
        assertNull(vigia.estado)
        vigia.alCambiarEstado("COUNTING_DOWN")
        assertEquals("COUNTING_DOWN", vigia.estado)
        vigia.alCambiarEstado(null)
        assertNull(vigia.estado)
    }

    /** Al reconectar se olvida la cuenta de antes, pero no lo que la app pidió. */
    @Test
    fun reiniciarOlvidaLaCuentaYConservaElPermiso() {
        vigia.alPermitir(false)
        vigia.alCambiarEstado("EXECUTED")

        vigia.reiniciar()

        assertNull(vigia.estado)
        assertTrue("sigue negado", vigia.alCambiarEstado("COUNTING_DOWN").contestarQueNo)
        assertFalse(vigia.alCambiarEstado("COUNTING_DOWN").arrancoElRegreso)
    }
}
