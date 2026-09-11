package com.tesis.dronepatrol.drone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El limitador que ralea los cuadros de video. Corre en la JVM pelada y sin
 * dormir: el reloj lo pone el test, que para eso el limitador no tiene uno
 * propio.
 */
class LimitadorDeRitmoTest {

    @Test
    fun elPrimeroSiemprePasa() {
        val limitador = LimitadorDeRitmo(200)

        assertTrue(limitador.aceptar(1_000))
    }

    @Test
    fun elQueLlegaAntesDelIntervaloSeDescarta() {
        val limitador = LimitadorDeRitmo(200)
        limitador.aceptar(1_000)

        assertFalse(limitador.aceptar(1_050))
        assertFalse(limitador.aceptar(1_199))
    }

    @Test
    fun elQueLlegaDespuesDelIntervaloPasa() {
        val limitador = LimitadorDeRitmo(200)
        limitador.aceptar(1_000)
        limitador.aceptar(1_100) // descartado

        assertTrue(limitador.aceptar(1_250))
    }

    /** Justo en el intervalo ya pasó: si no, a 5 fps exactos nunca aceptaría nada. */
    @Test
    fun justoEnElIntervaloPasa() {
        val limitador = LimitadorDeRitmo(200)
        limitador.aceptar(1_000)

        assertTrue(limitador.aceptar(1_200))
    }

    /**
     * El intervalo se cuenta desde el último ACEPTADO, no desde el último que
     * llegó: si no, con cuadros a 30 por segundo el limitador no dejaría pasar
     * ninguno nunca.
     */
    @Test
    fun elIntervaloSeCuentaDesdeElUltimoAceptado() {
        val limitador = LimitadorDeRitmo(200)
        limitador.aceptar(1_000)
        for (t in 1_033L..1_199L step 33L) assertFalse(limitador.aceptar(t))

        assertTrue(limitador.aceptar(1_200))
    }

    /** Si el reloj del celular se acomoda hacia atrás, el limitador no queda mudo. */
    @Test
    fun unRelojQueVaParaAtrasNoLoDejaMudo() {
        val limitador = LimitadorDeRitmo(200)
        limitador.aceptar(10_000)

        assertTrue(limitador.aceptar(2_000))
        assertFalse(limitador.aceptar(2_100))
    }
}
