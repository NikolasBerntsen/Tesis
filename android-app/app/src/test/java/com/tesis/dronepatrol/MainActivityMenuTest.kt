package com.tesis.dronepatrol

import android.content.DialogInterface
import android.content.Intent
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import com.tesis.dronepatrol.drone.DronEnCurso
import com.tesis.dronepatrol.model.SesionOperador
import com.tesis.dronepatrol.patrol.DronEspia
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.fakes.RoboMenuItem

/**
 * La barra de la pantalla de operación: el nombre del dron, el menú (renombrar,
 * terminar) y el "atrás". Terminar corta el dron y los enlaces; con el dron en
 * el aire se confirma, porque desde ese momento el que manda es el control físico.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityMenuTest {

    private val dron = DronEspia()
    private val banco = BancoDeOperacion(dron)

    @After
    fun desarmar() = banco.desarmar()

    private fun enElSuelo() {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
    }

    private fun conSesionDeCampo() {
        SesionDeCampo.abrir(SesionDeCampo.nuevoCliente(), SesionOperador("operador.campo", "field_operator", 1200))
    }

    private fun MainActivity.elegir(item: Int) {
        shadowOf(this).clickMenuItem(item)
        correrLaPantalla()
    }

    private fun responder(dialogo: AlertDialog?, boton: Int) {
        dialogo!!.getButton(boton).performClick()
        correrLaPantalla()
    }

    private fun proximaPantalla(): Intent? = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity

    // ---- Nombre ----

    @Test
    fun laBarraMuestraElNombreElModoYElHashAbreviado() {
        val pantalla = banco.abrir(modo = "DEPLOY", nombre = "Alfa")

        assertEquals("Alfa", pantalla.supportActionBar?.title)
        assertEquals(
            pantalla.getString(R.string.main_subtitulo, pantalla.getString(R.string.main_modo_despliegue), "012345…cdef"),
            pantalla.supportActionBar?.subtitle,
        )
    }

    /** Sin nombre visible el dron se llama por su hash, y sin modo arranca en prueba. */
    @Test
    fun sinNombreNiModoUsaElHashYArrancaEnPrueba() {
        val pantalla = banco.abrir(modo = null, nombre = null)

        assertEquals(hashAbreviado(BancoDeOperacion.HASH), pantalla.supportActionBar?.title)
        assertEquals(
            pantalla.getString(R.string.main_subtitulo, pantalla.getString(R.string.main_modo_prueba), hashAbreviado(BancoDeOperacion.HASH)),
            pantalla.supportActionBar?.subtitle,
        )
    }

    @Test
    fun renombrarMandaElNombreNuevoAlComandoCentral() {
        val pantalla = banco.abrir(nombre = "Alfa")

        pantalla.elegir(R.id.action_renombrar)
        val dialogo = ultimaConfirmacion()!!
        val campo = dialogo.findViewById<EditText>(R.id.editDisplayName)!!
        assertEquals("el campo arranca con el nombre de ahora", "Alfa", campo.text.toString())
        campo.setText("  Bravo  ")
        responder(dialogo, DialogInterface.BUTTON_POSITIVE)

        val pedidos = banco.comando.mensajes("set_name")
        assertEquals(1, pedidos.size)
        assertEquals("sin los espacios de los costados", "Bravo", pedidos.single().getString("displayName"))
        assertEquals("Bravo", pantalla.supportActionBar?.title)
    }

    @Test
    fun renombrarConElCampoVacioOCanceladoNoCambiaNada() {
        val pantalla = banco.abrir(nombre = "Alfa")

        pantalla.elegir(R.id.action_renombrar)
        ultimaConfirmacion()!!.findViewById<EditText>(R.id.editDisplayName)!!.setText("   ")
        responder(ultimaConfirmacion(), DialogInterface.BUTTON_POSITIVE)

        pantalla.elegir(R.id.action_renombrar)
        ultimaConfirmacion()!!.findViewById<EditText>(R.id.editDisplayName)!!.setText("Bravo")
        responder(ultimaConfirmacion(), DialogInterface.BUTTON_NEGATIVE)

        assertTrue(banco.comando.mensajes("set_name").isEmpty())
        assertEquals("Alfa", pantalla.supportActionBar?.title)
    }

    @Test
    fun siLaConsolaLoRenombraLaBarraLoMuestra() {
        val pantalla = banco.abrir(nombre = "Alfa")

        banco.comando.manejarMensaje("""{"type":"renamed","displayName":"Charlie"}""")
        correrLaPantalla()

        assertEquals("Charlie", pantalla.supportActionBar?.title)
        // Y el próximo "Renombrar" arranca desde ese nombre
        pantalla.elegir(R.id.action_renombrar)
        assertEquals("Charlie", ultimaConfirmacion()!!.findViewById<EditText>(R.id.editDisplayName)!!.text.toString())
    }

    /** Lo que no es del menú de la pantalla sigue de largo, sin abrir nada. */
    @Test
    fun unItemQueNoEsDelMenuNoLoAtiendeLaPantalla() {
        val pantalla = banco.abrir()

        assertFalse(pantalla.onOptionsItemSelected(RoboMenuItem(android.R.id.copy)))
        assertNull(ultimaConfirmacion())
        assertFalse(pantalla.isFinishing)
    }

    // ---- Terminar ----

    /** Con la sesión del operador viva, terminar vuelve al menú de campo que quedó debajo. */
    @Test
    fun terminarConElDronEnElSueloCortaTodoYVuelveAlMenuDeCampo() {
        enElSuelo()
        conSesionDeCampo()
        val pantalla = banco.abrir()

        pantalla.elegir(R.id.action_terminar)

        assertNull("en el suelo no hay nada que confirmar", ultimaConfirmacion())
        assertTrue(pantalla.isFinishing)
        assertEquals("disconnect", dron.ultimaOrden)
        assertNull("el menú de campo ya está debajo", proximaPantalla())
        assertNotSame("el dron en curso se suelta", dron, DronEnCurso.obtener())
    }

    @Test
    fun terminarConLaSesionVencidaVuelveAlLoginConElAviso() {
        enElSuelo()
        val pantalla = banco.abrir()

        pantalla.elegir(R.id.action_terminar)

        assertTrue(pantalla.isFinishing)
        val login = proximaPantalla()
        assertNotNull(login)
        assertEquals(LoginActivity::class.java.name, login!!.component?.className)
        assertEquals(pantalla.getString(R.string.aviso_sesion_vencida), login.getStringExtra(LoginActivity.EXTRA_AVISO))
        val limpia = Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK
        assertEquals("no queda nada debajo del login", limpia, login.flags and limpia)
    }

    /** Con el dron en el aire se pregunta: al terminar, el control físico recupera el mando. */
    @Test
    fun terminarConElDronEnElAirePideConfirmacion() {
        conSesionDeCampo()
        val pantalla = banco.abrir()

        pantalla.elegir(R.id.action_terminar)
        val pregunta = ultimaConfirmacion()
        assertEquals(
            pantalla.getString(R.string.main_confirmar_salir_texto),
            pregunta!!.findViewById<TextView>(android.R.id.message)?.text.toString(),
        )
        responder(pregunta, DialogInterface.BUTTON_NEGATIVE)
        assertFalse("cancelado, sigue operando", pantalla.isFinishing)
        assertFalse(dron.ordenes.contains("disconnect"))

        pantalla.elegir(R.id.action_terminar)
        responder(ultimaConfirmacion(), DialogInterface.BUTTON_POSITIVE)
        assertTrue(pantalla.isFinishing)
        assertEquals("disconnect", dron.ultimaOrden)
    }

    @Test
    fun atrasConElDronEnElAireTambienPregunta() {
        conSesionDeCampo()
        val pantalla = banco.abrir()

        pantalla.onBackPressedDispatcher.onBackPressed()
        correrLaPantalla()

        assertFalse(pantalla.isFinishing)
        responder(ultimaConfirmacion(), DialogInterface.BUTTON_POSITIVE)
        assertTrue(pantalla.isFinishing)
    }

    @Test
    fun atrasConElDronEnElSueloTerminaSinPreguntar() {
        enElSuelo()
        conSesionDeCampo()
        val pantalla = banco.abrir()

        pantalla.onBackPressedDispatcher.onBackPressed()
        correrLaPantalla()

        assertNull(ultimaConfirmacion())
        assertTrue(pantalla.isFinishing)
    }

    /** Si Android cierra la pantalla, el token del dron no queda vivo esperando a que alguien reabra. */
    @Test
    fun alCerrarseLaPantallaSueltaElDronYCortaLosEnlaces() {
        val pantalla = banco.abrir()
        banco.comando.connected.value = true
        banco.deteccion.connected.value = true

        banco.cerrar()

        assertTrue(pantalla.isDestroyed)
        assertEquals("disconnect", dron.ultimaOrden)
        assertFalse("el socket del Comando Central se cierra", banco.comando.connected.value)
        assertFalse("y el de la detección", banco.deteccion.connected.value)
        assertNotSame(dron, DronEnCurso.obtener())
    }
}
