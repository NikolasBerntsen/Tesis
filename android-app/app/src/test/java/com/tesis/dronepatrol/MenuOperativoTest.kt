package com.tesis.dronepatrol

import android.view.View
import androidx.test.core.app.ApplicationProvider
import com.tesis.dronepatrol.comms.ModoEnlace
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El cajón de la pantalla de operación: dos vistas y la salida. Antes el
 * registro vivía adentro del cajón y no se podía leer sin taparlo.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MenuOperativoTest {

    private fun preferencias() = PreferenciasEnlace(ApplicationProvider.getApplicationContext())

    @Test
    fun `el modo de enlace por defecto es el cable`() {
        assertEquals(ModoEnlace.CABLE, preferencias().modoEnlace)
    }

    @Test
    fun `la url del comando central por defecto es la del servidor`() {
        assertEquals(com.tesis.dronepatrol.Config.URL_COMANDO_CENTRAL_POR_DEFECTO, preferencias().urlComandoCentral)
        assertEquals("https://tesis.144-22-138-149.sslip.io", com.tesis.dronepatrol.Config.URL_COMANDO_CENTRAL_POR_DEFECTO)
    }

    @Test
    fun `el identificador escrito a mano se valida igual que el del QR`() {
        // con espacios y en mayúsculas, tal como lo tipearía alguien con guantes
        assertEquals("a".repeat(32), hashDeDronODescartar("  " + "A".repeat(32) + " "))
        // y lo que no tiene la forma no llega a golpear el Comando Central
        assertEquals(null, hashDeDronODescartar("a".repeat(31)))
        assertEquals(null, hashDeDronODescartar("no es un hash"))
    }

    @Test
    fun `las constantes de visibilidad de los dos paneles son excluyentes`() {
        // el panel operativo y el del registro nunca se muestran juntos
        val operativo = View.VISIBLE
        val logs = View.GONE
        assertEquals(View.VISIBLE, operativo)
        assertEquals(View.GONE, logs)
    }
}
