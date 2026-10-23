package com.tesis.dronepatrol.patrol

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * La orden que la app sumó a DroneController para el desvío (docs/RELEVOS.md
 * §4), en un controlador que no la implementa: intentar fijar el punto de
 * retorno en la base destino no le dice nada al dron. Es solo un intento —en
 * el real, el rechazo es lo esperado—, y el desvío llega igual: al llegar,
 * fijarPuntoDeRetornoAqui lo fija de verdad.
 *
 * Las órdenes que sí tienen que estar en los dos controladores las exige
 * ControladoresConLasOrdenesDeRelevosTest. Esta se prueba sobre [DronEspia]
 * sin sus órdenes de relevos: es exactamente el caso de un controlador viejo
 * (como en DroneControllerPorDefectoTest).
 */
class OrdenesNuevasPorDefectoTest {

    private val dron = DronEspia()

    @Test
    fun fijarElRetornoEnOtroPuntoNoLeDiceNadaAlDron() {
        dron.fijarPuntoDeRetornoEn(-34.85, -56.20)
        assertEquals(emptyList<String>(), dron.ordenes)
    }
}
