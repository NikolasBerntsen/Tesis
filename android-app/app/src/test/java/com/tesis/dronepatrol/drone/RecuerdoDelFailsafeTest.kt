package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El failsafe de enlace mientras la app lo tiene en "aterrizar" (RELEVOS §4 y
 * §5): se guarda el del operador una sola vez, se le devuelve al apagar, y
 * queda guardado fuera del controlador hasta que el dron lo aceptó.
 */
class RecuerdoDelFailsafeTest {

    private enum class Accion { VOLVER, ATERRIZAR, QUEDARSE }

    /** Lo que guardaría el teléfono: sobrevive al recuerdo que lo escribió. */
    private class Almacen(var texto: String? = null) : AlmacenDeTexto {
        override fun leer(): String? = texto

        override fun escribir(valor: String?) {
            texto = valor
        }
    }

    private val almacen = Almacen()

    private fun nuevoRecuerdo(conAlmacen: AlmacenDeTexto? = almacen) =
        RecuerdoDelFailsafe(aterrizar = Accion.ATERRIZAR, deFabrica = Accion.VOLVER, almacen = conAlmacen)

    private val recuerdo = nuevoRecuerdo()

    @Test
    fun activarloFijaAterrizarYRestaurarloDevuelveElDeAntes() {
        assertEquals(Accion.ATERRIZAR, recuerdo.alActivar(Accion.QUEDARSE))
        assertTrue(recuerdo.activo)

        assertEquals(Accion.QUEDARSE, recuerdo.porRestaurar())
        recuerdo.alRestaurar()
        assertFalse(recuerdo.activo)
        assertNull(recuerdo.porRestaurar())
    }

    /**
     * El desvío y la emergencia lo prenden los dos: la segunda vez el dron ya
     * dice "aterrizar", y guardar eso dejaría al operador sin su failsafe.
     */
    @Test
    fun activarloDosVecesGuardaElOriginalYNoElAterrizar() {
        recuerdo.alActivar(Accion.QUEDARSE)
        assertEquals(Accion.ATERRIZAR, recuerdo.alActivar(Accion.ATERRIZAR))

        assertEquals(Accion.QUEDARSE, recuerdo.porRestaurar())
    }

    @Test
    fun sinHaberloPrendidoNoHayNadaQueRestaurar() {
        assertFalse(recuerdo.activo)
        assertNull(recuerdo.porRestaurar())
    }

    /**
     * Hasta que el dron no acepta el failsafe devuelto, sigue pendiente: si la
     * escritura falla se vuelve a intentar con el mismo valor.
     */
    @Test
    fun sinLaRestauracionAceptadaSiguePendiente() {
        recuerdo.alActivar(Accion.QUEDARSE)

        assertEquals(Accion.QUEDARSE, recuerdo.porRestaurar())
        assertEquals("un intento fallido no lo olvida", Accion.QUEDARSE, recuerdo.porRestaurar())
        assertTrue(recuerdo.activo)
    }

    /** Si al prenderlo no se pudo leer el de antes, al apagar vuelve el de fábrica. */
    @Test
    fun sinElOriginalSeDevuelveElDeFabrica() {
        recuerdo.alActivar(null)

        assertEquals(Accion.VOLVER, recuerdo.porRestaurar())
    }

    /** Si el operador ya lo tenía en aterrizar, se le devuelve aterrizar: es su configuración. */
    @Test
    fun siElOriginalYaEraAterrizarSeLoDevuelveIgual() {
        recuerdo.alActivar(Accion.ATERRIZAR)

        assertEquals(Accion.ATERRIZAR, recuerdo.porRestaurar())
    }

    /** Después de restaurarlo, prenderlo de nuevo guarda el valor de ese momento. */
    @Test
    fun unCicloNuevoGuardaElValorNuevo() {
        recuerdo.alActivar(Accion.QUEDARSE)
        recuerdo.alRestaurar()
        recuerdo.alActivar(Accion.VOLVER)

        assertEquals(Accion.VOLVER, recuerdo.porRestaurar())
    }

    // ---- Lo que sobrevive al controlador ----

    @Test
    fun loGuardaFueraAlActivarYLoBorraAlRestaurar() {
        recuerdo.alActivar(Accion.QUEDARSE)
        assertEquals("QUEDARSE", almacen.texto)

        // La segunda activación no pisa lo guardado.
        recuerdo.alActivar(Accion.ATERRIZAR)
        assertEquals("QUEDARSE", almacen.texto)

        recuerdo.alRestaurar()
        assertNull(almacen.texto)
    }

    /**
     * La pantalla se cerró en pleno desvío: el controlador nuevo arranca con el
     * failsafe pendiente y lo devuelve como si lo hubiera guardado él.
     */
    @Test
    fun unRecuerdoNuevoEncuentraElPendienteDeUnoAnterior() {
        recuerdo.alActivar(Accion.QUEDARSE)

        val despues = nuevoRecuerdo()

        assertTrue(despues.activo)
        assertEquals(Accion.QUEDARSE, despues.porRestaurar())
        // Activarlo otra vez (otro desvío) no guarda el aterrizar que el dron tiene puesto.
        despues.alActivar(Accion.ATERRIZAR)
        assertEquals(Accion.QUEDARSE, despues.porRestaurar())
        despues.alRestaurar()
        assertFalse(nuevoRecuerdo().activo)
    }

    @Test
    fun unPendienteSinOriginalConocidoDevuelveElDeFabrica() {
        recuerdo.alActivar(null)

        val despues = nuevoRecuerdo()

        assertTrue(despues.activo)
        assertEquals(Accion.VOLVER, despues.porRestaurar())
    }

    /** Un valor guardado que no es de este enumerado (otra versión de la app): se devuelve el de fábrica. */
    @Test
    fun unValorGuardadoDesconocidoDevuelveElDeFabrica() {
        val despues = nuevoRecuerdo(Almacen("PARACAIDAS"))

        assertTrue(despues.activo)
        assertEquals(Accion.VOLVER, despues.porRestaurar())
    }

    /** Un almacén que falla no se lleva puesto al controlador: el recuerdo sigue en memoria. */
    @Test
    fun unAlmacenQueFallaNoRompeNada() {
        val roto = object : AlmacenDeTexto {
            override fun leer(): String? {
                error("sin preferencias")
            }

            override fun escribir(valor: String?) {
                error("sin preferencias")
            }
        }
        val conRoto = nuevoRecuerdo(roto)

        assertFalse(conRoto.activo)
        conRoto.alActivar(Accion.QUEDARSE)
        assertEquals(Accion.QUEDARSE, conRoto.porRestaurar())
        conRoto.alRestaurar()
        assertFalse(conRoto.activo)
    }

    @Test
    fun sinAlmacenQuedaEnMemoria() {
        val enMemoria = nuevoRecuerdo(conAlmacen = null)
        enMemoria.alActivar(Accion.QUEDARSE)

        assertEquals(Accion.QUEDARSE, enMemoria.porRestaurar())
        assertNull(almacen.texto)
    }
}
