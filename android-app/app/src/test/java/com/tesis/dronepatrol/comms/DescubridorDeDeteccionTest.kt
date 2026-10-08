package com.tesis.dronepatrol.comms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La lectura de los anuncios UDP de la laptop. En una red Wi-Fi llega de todo
 * por broadcast: solo un JSON con el nombre del servicio y un puerto válido es
 * un anuncio. Robolectric porque el anuncio se lee con org.json, que en la JVM
 * pelada es un stub del SDK de Android.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DescubridorDeDeteccionTest {

    @Test
    fun `un anuncio valido da la url del enlace con la direccion de la que vino`() {
        val anuncio = DescubridorDeDeteccion.interpretar(
            """{"service":"dronepatrol-detection","port":8765,"name":"notebook-campo"}""",
            host = "192.168.1.40",
            ahoraMs = 1_000,
        )

        assertEquals("ws://192.168.1.40:8765/phone", anuncio?.url)
        assertEquals("notebook-campo", anuncio?.nombre)
        assertEquals(1_000L, anuncio?.recibidoMs)
    }

    @Test
    fun `sin nombre se usa la direccion`() {
        val anuncio = DescubridorDeDeteccion.interpretar("""{"service":"dronepatrol-detection","port":8765}""", "10.0.0.2", 0)

        assertEquals("10.0.0.2", anuncio?.nombre)
    }

    @Test
    fun `otro servicio, un puerto imposible o basura no son anuncios`() {
        assertNull(DescubridorDeDeteccion.interpretar("""{"service":"otra-cosa","port":8765}""", "10.0.0.2", 0))
        assertNull(DescubridorDeDeteccion.interpretar("""{"service":"dronepatrol-detection","port":0}""", "10.0.0.2", 0))
        assertNull(DescubridorDeDeteccion.interpretar("""{"service":"dronepatrol-detection"}""", "10.0.0.2", 0))
        assertNull(DescubridorDeDeteccion.interpretar("hola", "10.0.0.2", 0))
        assertNull(DescubridorDeDeteccion.interpretar("", "10.0.0.2", 0))
    }
}
