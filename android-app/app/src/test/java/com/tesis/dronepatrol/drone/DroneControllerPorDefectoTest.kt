package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.patrol.DronEspia
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Lo que hacen las órdenes de los relevos (docs/RELEVOS.md) en un controlador
 * que todavía no las implementa: el lado seguro. Las que tienen una orden de
 * siempre que se les parece la delegan; las demás no le dicen nada al dron —un
 * controlador que no sabe despegar para un relevo no despega—; y la foto es el
 * próximo cuadro para la detección, nunca uno de antes de pedirla.
 *
 * Se prueban sobre [DronEspia], que no pisa ninguna: es exactamente el caso de
 * un controlador viejo.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DroneControllerPorDefectoTest {

    private val dron = DronEspia()

    @Test
    fun volarHaciaEsIrAlPunto() {
        dron.volarHacia(-34.85, -56.20)
        assertEquals(listOf("gotoPoint"), dron.ordenes)
    }

    /**
     * Un controlador que no sabe soltar el mando al control físico lo deja
     * quieto: el control manual sin nadie al mando no puede quedar con la
     * última velocidad que le llegó.
     */
    @Test
    fun devolverElMandoAlControlEsQuedarseQuieto() {
        dron.devolverElMandoAlControl()
        assertEquals(listOf("hold"), dron.ordenes)
    }

    @Test
    fun apuntarLaCamaraEsInclinarla() {
        dron.apuntarCamara(-90.0)
        assertEquals(listOf("camara(-90.0)"), dron.ordenes)
    }

    @Test
    fun lasOrdenesSinEquivalenteNoLeDicenNadaAlDron() {
        dron.despegarHasta(60.0)
        dron.cambiarAltura(80.0)
        dron.girarEnElLugar(90.0)
        dron.cancelarRegreso()
        dron.fijarPuntoDeRetornoAqui()
        dron.permitirRthPropioPorBateria(false)
        dron.fijarFailsafeAterrizar(true)
        dron.soltarDespegue()
        // Un controlador que no sostiene el aterrizaje no tiene nada que cortar:
        // la orden que sigue lo corta sola.
        dron.cancelarAterrizaje()

        assertEquals("ni despega, ni sube, ni gira, ni corta un regreso", emptyList<String>(), dron.ordenes)
    }

    /** Un controlador que no sabe despegar para un relevo no lo acepta: B lo rechaza sin moverse. */
    @Test
    fun sinImplementacionElDespegueDeUnRelevoNoSePrepara() = runTest {
        assertFalse(dron.prepararDespegue())
        assertEquals(emptyList<String>(), dron.ordenes)
    }

    @Test
    fun laFotoEsElProximoCuadroParaLaDeteccion() = runTest {
        val cuadroDeLaConsola = byteArrayOf(1, 1, 1)
        val cuadroDeLaDeteccion = byteArrayOf(-1, -40, -1, 7)

        val foto = async { dron.capturarFoto() }
        runCurrent()
        // El video de la consola es otro flujo, más chico: la foto no sale de ahí.
        dron.videoFrames.emit(cuadroDeLaConsola)
        dron.cuadrosParaDeteccion.emit(cuadroDeLaDeteccion)

        assertArrayEquals(cuadroDeLaDeteccion, foto.await())
    }

    /**
     * Un cuadro de antes de pedir la foto es una foto con la cámara apuntando a
     * otro lado: el protocolo apunta la cámara, espera la telemetría y recién
     * ahí pide.
     */
    @Test
    fun laFotoNuncaEsUnCuadroDeAntesDePedirla() = runTest {
        dron.cuadrosParaDeteccion.emit(byteArrayOf(9, 9))
        val nuevo = byteArrayOf(-1, -40, 2)

        val foto = async { dron.capturarFoto() }
        runCurrent()
        dron.cuadrosParaDeteccion.emit(nuevo)

        assertArrayEquals(nuevo, foto.await())
    }

    @Test
    fun sinCuadrosLaFotoEsNullALosDosSegundosYNiUnoAntes() = runTest {
        val foto = async { dron.capturarFoto() }

        advanceTimeBy(DroneController.ESPERA_FOTO_MS - 1)
        runCurrent()
        assertFalse("antes del plazo todavía espera", foto.isCompleted)

        advanceTimeBy(1)
        runCurrent()
        assertTrue(foto.isCompleted)
        assertNull(foto.await())
    }
}
