package com.tesis.dronepatrol

import android.os.Looper.getMainLooper
import com.tesis.dronepatrol.model.SesionOperador
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * La sesión del operador de campo es efímera a propósito y su vencimiento es lo
 * que corta el emparejamiento. Va con Robolectric por el reloj monótono.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SesionDeCampoTest {

    private fun abrir(expiresIn: Long) =
        SesionDeCampo.abrir(
            SesionDeCampo.nuevoCliente(),
            SesionOperador(username = "operador.campo", role = "field_operator", expiresIn = expiresIn),
        )

    @After
    fun cerrar() {
        SesionDeCampo.cerrar()
    }

    @Test
    fun tomaElVencimientoQueInformaElComandoCentral() {
        abrir(expiresIn = 300)

        assertEquals(300_000L, SesionDeCampo.restanteMs())
        assertTrue(SesionDeCampo.vigente)
        assertEquals("operador.campo", SesionDeCampo.usuario)
        assertNotNull(SesionDeCampo.cliente)
    }

    /** Si el backend no manda expiresIn, valen los 20 minutos del contrato. */
    @Test
    fun sinExpiresInAsumeVeinteMinutos() {
        abrir(expiresIn = 0)

        assertEquals(20L * 60 * 1_000, SesionDeCampo.restanteMs())
    }

    @Test
    fun alLlegarACeroDejaDeEstarVigente() {
        abrir(expiresIn = 60)

        shadowOf(getMainLooper()).idleFor(Duration.ofSeconds(61))

        assertEquals(0L, SesionDeCampo.restanteMs())
        assertFalse(SesionDeCampo.vigente)
    }

    @Test
    fun cerrarSueltaElTokenYLaIdentidad() {
        abrir(expiresIn = 300)

        SesionDeCampo.cerrar()

        assertNull(SesionDeCampo.cliente)
        assertEquals("", SesionDeCampo.usuario)
        assertEquals("", SesionDeCampo.rol)
        assertEquals(0L, SesionDeCampo.restanteMs())
    }

    @Test
    fun soloEmparejanLosRolesHabilitados() {
        assertTrue(SesionDeCampo.ROLES_HABILITADOS.containsAll(listOf("field_operator", "supervisor", "admin")))
        assertFalse("operator" in SesionDeCampo.ROLES_HABILITADOS)
        assertFalse("drone" in SesionDeCampo.ROLES_HABILITADOS)
    }
}
