package com.tesis.dronepatrol

import android.content.DialogInterface
import android.content.Intent
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import com.tesis.dronepatrol.drone.DronEnCurso
import com.tesis.dronepatrol.patrol.DronEspia
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

/**
 * "Despegar aquí" en la pantalla de operación, con un dron en el suelo y
 * enlazado: el botón se prende, primero pregunta (despegar es irreversible
 * desde el teléfono), y recién al confirmar se le pide el despegue al dron.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityDespegarAquiTest {

    /** En el suelo y enlazado, sin GPS: lo de la prueba en interior. */
    private val dron = DronEspia().apply {
        estado.value = estado.value.copy(enVuelo = false, satelites = 0, baseFijada = false, detalle = "sin GPS")
    }

    @After
    fun desarmar() {
        DronEnCurso.soltar()
    }

    private fun pantallaDeOperacion(): MainActivity {
        DronEnCurso.usar(dron)
        val intent = Intent(RuntimeEnvironment.getApplication(), MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_DRONE_TOKEN, "token-de-prueba")
            .putExtra(MainActivity.EXTRA_DRONE_HASH, "0123456789abcdef0123456789abcdef")
            .putExtra(MainActivity.EXTRA_DISPLAY_NAME, "Alfa")
            .putExtra(MainActivity.EXTRA_MODE, "TEST")
        val pantalla = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
        shadowOf(Looper.getMainLooper()).idle()
        return pantalla
    }

    private fun preguntar(pantalla: MainActivity): AlertDialog {
        val boton = pantalla.findViewById<Button>(R.id.btnDespegarAqui)
        assertTrue("en el suelo y enlazado se puede despegar en el lugar, aun sin GPS", boton.isEnabled)
        boton.performClick()
        shadowOf(Looper.getMainLooper()).idle()
        val pregunta = ShadowDialog.getLatestDialog() as AlertDialog
        assertEquals(
            pantalla.getString(R.string.main_confirmar_despegue_aqui_texto),
            pregunta.findViewById<TextView>(android.R.id.message)?.text.toString(),
        )
        return pregunta
    }

    @Test
    fun alConfirmarDespegaEnElLugar() {
        val pregunta = preguntar(pantallaDeOperacion())
        assertFalse("antes de confirmar no despega", dron.ordenes.contains("despegarEnElLugar"))

        pregunta.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(dron.ordenes.contains("despegarEnElLugar"))
    }

    @Test
    fun alCancelarNoDespega() {
        val pregunta = preguntar(pantallaDeOperacion())

        pregunta.getButton(DialogInterface.BUTTON_NEGATIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /** Sin rutas cargadas no hay nada que explicar debajo de "Comenzar", aunque falte el GPS. */
    @Test
    fun sinRutasNoExplicaPorQueNoPatrulla() {
        val aviso = pantallaDeOperacion().findViewById<TextView>(R.id.txtNoPatrulla)
        assertEquals(View.GONE, aviso.visibility)
        assertEquals("", aviso.text.toString())
    }
}
