package com.tesis.dronepatrol.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Las reglas del silencio al retomar y de la reacción, las piezas puras de los
 * ajustes del dron (docs/VUELO.md §10, `docs/contrato/ajustes.json`): qué
 * silencio acepta el contrato, cómo lo recorta la app si un hub le manda otro,
 * y que la reacción se lee exacta, sin convertir nada.
 */
class AjustesDelDronTest {

    @Test
    fun unSilencioValidoEsUnEnteroDe0A30DeA5() {
        for (s in listOf(0L, 5L, 15L, 30L)) assertTrue("$s", AjustesDelDron.esUnSilencioValido(s))
        for (s in listOf(-5L, 12L, 31L, 35L, 45L)) assertFalse("$s", AjustesDelDron.esUnSilencioValido(s))
    }

    @Test
    fun elSilencioQueSeAplicaSeRecortaAlRangoYAlPasoYSinPedidoEsElDeFabrica() {
        assertEquals(AjustesDelDron.SILENCIO_DE_FABRICA_S, AjustesDelDron.silencioAlRetomarS(null))
        assertEquals(0, AjustesDelDron.silencioAlRetomarS(0))
        assertEquals(20, AjustesDelDron.silencioAlRetomarS(20))
        assertEquals("al paso de abajo", 10, AjustesDelDron.silencioAlRetomarS(12))
        assertEquals("al tope", 30, AjustesDelDron.silencioAlRetomarS(45))
        assertEquals("al piso", 0, AjustesDelDron.silencioAlRetomarS(-5))
    }

    @Test
    fun laReaccionSeLeeExactaYNullNoEsNinguna() {
        assertEquals(ReaccionADeteccion.DETENERSE, ReaccionADeteccion.desdeElProtocolo("detenerse"))
        assertEquals(ReaccionADeteccion.SEGUIR_Y_ORBITAR, ReaccionADeteccion.DE_FABRICA)
        assertNull(ReaccionADeteccion.desdeElProtocolo("SEGUIR"))
        assertNull(ReaccionADeteccion.desdeElProtocolo(" seguir"))
        assertNull(ReaccionADeteccion.desdeElProtocolo(null))
    }
}
