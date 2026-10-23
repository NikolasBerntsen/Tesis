package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El failsafe de enlace mientras la app lo tiene en "aterrizar" (RELEVOS §4 y
 * §5): se guarda el del operador una sola vez y se le devuelve al apagar.
 */
class RecuerdoDelFailsafeTest {

    private enum class Accion { VOLVER, ATERRIZAR, QUEDARSE }

    private val recuerdo = RecuerdoDelFailsafe(aterrizar = Accion.ATERRIZAR, deFabrica = Accion.VOLVER)

    @Test
    fun activarloFijaAterrizarYApagarloDevuelveElDeAntes() {
        assertEquals(Accion.ATERRIZAR, recuerdo.alActivar(Accion.QUEDARSE))
        assertTrue(recuerdo.activo)

        assertEquals(Accion.QUEDARSE, recuerdo.alDesactivar())
        assertFalse(recuerdo.activo)
    }

    /**
     * El desvío y la emergencia lo prenden los dos: la segunda vez el dron ya
     * dice "aterrizar", y guardar eso dejaría al operador sin su failsafe.
     */
    @Test
    fun activarloDosVecesGuardaElOriginalYNoElAterrizar() {
        recuerdo.alActivar(Accion.QUEDARSE)
        assertEquals(Accion.ATERRIZAR, recuerdo.alActivar(Accion.ATERRIZAR))

        assertEquals(Accion.QUEDARSE, recuerdo.alDesactivar())
    }

    @Test
    fun apagarloSinHaberloPrendidoNoTocaAlDron() {
        assertNull(recuerdo.alDesactivar())
    }

    @Test
    fun apagarloDosVecesRestauraUnaSola() {
        recuerdo.alActivar(Accion.QUEDARSE)
        recuerdo.alDesactivar()

        assertNull(recuerdo.alDesactivar())
    }

    /** Si al prenderlo no se pudo leer el de antes, al apagar vuelve el de fábrica. */
    @Test
    fun sinElOriginalSeDevuelveElDeFabrica() {
        recuerdo.alActivar(null)

        assertEquals(Accion.VOLVER, recuerdo.alDesactivar())
    }

    /** Si el operador ya lo tenía en aterrizar, se le devuelve aterrizar: es su configuración. */
    @Test
    fun siElOriginalYaEraAterrizarSeLoDevuelveIgual() {
        recuerdo.alActivar(Accion.ATERRIZAR)

        assertEquals(Accion.ATERRIZAR, recuerdo.alDesactivar())
    }

    /** Después de apagarlo, prenderlo de nuevo guarda el valor de ese momento. */
    @Test
    fun unCicloNuevoGuardaElValorNuevo() {
        recuerdo.alActivar(Accion.QUEDARSE)
        recuerdo.alDesactivar()
        recuerdo.alActivar(Accion.VOLVER)

        assertEquals(Accion.VOLVER, recuerdo.alDesactivar())
    }
}
