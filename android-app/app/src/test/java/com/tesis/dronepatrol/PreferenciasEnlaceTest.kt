package com.tesis.dronepatrol

import com.tesis.dronepatrol.comms.ModoEnlace
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Lo que la app tiene que saber sola en una salida de campo: contra qué Comando
 * Central habla y por dónde le llega la detección. Necesita Robolectric por las
 * SharedPreferences.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PreferenciasEnlaceTest {

    private val preferencias = PreferenciasEnlace(RuntimeEnvironment.getApplication())

    @Test
    fun sinNadaGuardadoApuntaAlComandoCentralDeProduccion() {
        assertEquals("https://tesis.144-22-138-149.sslip.io", preferencias.urlComandoCentral)
    }

    /** El cable es el modo recomendado, así que es el que sale de fábrica. */
    @Test
    fun sinNadaGuardadoElEnlaceEsPorCable() {
        assertEquals(ModoEnlace.CABLE, preferencias.modoEnlace)
        assertEquals("", preferencias.urlDeteccionRed)
    }

    @Test
    fun recuerdaLoQueSeGuardo() {
        preferencias.urlComandoCentral = "https://otro.comando.central"
        preferencias.modoEnlace = ModoEnlace.RED
        preferencias.urlDeteccionRed = "ws://192.168.42.129:8765"

        val releida = PreferenciasEnlace(RuntimeEnvironment.getApplication())
        assertEquals("https://otro.comando.central", releida.urlComandoCentral)
        assertEquals(ModoEnlace.RED, releida.modoEnlace)
        assertEquals("ws://192.168.42.129:8765", releida.urlDeteccionRed)
    }

    /** Copiar y pegar una URL arrastra espacios que después rompen la conexión. */
    @Test
    fun recortaLosEspaciosAlGuardar() {
        preferencias.urlComandoCentral = "  https://tesis.144-22-138-149.sslip.io  "
        preferencias.urlDeteccionRed = " ws://192.168.42.129:8765\n"

        assertEquals("https://tesis.144-22-138-149.sslip.io", preferencias.urlComandoCentral)
        assertEquals("ws://192.168.42.129:8765", preferencias.urlDeteccionRed)
    }

    /** Una URL borrada no puede dejar a la app sin destino. */
    @Test
    fun sinUrlGuardadaVuelveALaDeProduccion() {
        preferencias.urlComandoCentral = "   "

        assertEquals("https://tesis.144-22-138-149.sslip.io", preferencias.urlComandoCentral)
    }
}
