package com.tesis.dronepatrol.patrol

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Las órdenes que la app sumó a DroneController para el desvío, el traspaso y
 * el aterrizaje en un lugar sin revisar (docs/RELEVOS.md §2.4, §3.5 y §4), en
 * un controlador que todavía no las implementa: el lado seguro, que es lo que
 * el dron hacía antes. Volar a una altura es volar a la que está; fijar el
 * retorno en otro punto, confirmar a mano o confirmar no hacen nada (el
 * controlador sigue confirmando solo); y el mando virtual en tierra se da por
 * habilitado, porque el despegue de relevo igual necesita despegarHasta.
 *
 * Se prueban sobre [DronEspia] sin sus órdenes de relevos: es exactamente el
 * caso de un controlador viejo (como en DroneControllerPorDefectoTest).
 */
class OrdenesNuevasPorDefectoTest {

    private val dron = DronEspia()

    @Test
    fun volarAUnaAlturaEsVolarALaQueEsta() {
        dron.volarHaciaA(-34.85, -56.20, 60.0)
        assertEquals("volarHacia, que por defecto es ir al punto", listOf("gotoPoint"), dron.ordenes)
    }

    @Test
    fun lasDemasNoLeDicenNadaAlDron() {
        dron.fijarPuntoDeRetornoEn(-34.85, -56.20)
        dron.fijarConfirmacionDeAterrizaje(false)
        dron.confirmarAterrizaje()
        assertEquals(emptyList<String>(), dron.ordenes)
    }

    @Test
    fun elMandoVirtualEnTierraSeDaPorHabilitado() = runBlocking {
        assertTrue(dron.habilitarMandoVirtualEnTierra())
        assertEquals(emptyList<String>(), dron.ordenes)
    }
}
