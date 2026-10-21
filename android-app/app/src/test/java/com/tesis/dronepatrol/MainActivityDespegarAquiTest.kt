package com.tesis.dronepatrol

import android.content.DialogInterface
import android.content.Intent
import android.os.Looper
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

/**
 * "Despegar aquí" en la pantalla de operación: despegar es irreversible desde
 * el teléfono, así que el botón primero pregunta, y recién al confirmar se le
 * pide el despegue a la patrulla.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityDespegarAquiTest {

    private fun pantallaDeOperacion(): MainActivity {
        val intent = Intent(RuntimeEnvironment.getApplication(), MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_DRONE_TOKEN, "token-de-prueba")
            .putExtra(MainActivity.EXTRA_DRONE_HASH, "0123456789abcdef0123456789abcdef")
            .putExtra(MainActivity.EXTRA_DISPLAY_NAME, "Alfa")
            .putExtra(MainActivity.EXTRA_BASE_LAT, -34.6037)
            .putExtra(MainActivity.EXTRA_BASE_LON, -58.3816)
            .putExtra(MainActivity.EXTRA_MODE, "TEST")
        return Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    }

    @Test
    fun preguntaAntesDeDespegarYAlConfirmarCierraLaPregunta() {
        val pantalla = pantallaDeOperacion()

        pantalla.findViewById<Button>(R.id.btnDespegarAqui).performClick()
        shadowOf(Looper.getMainLooper()).idle()

        val pregunta = ShadowDialog.getLatestDialog() as AlertDialog
        assertNotNull(pregunta)
        assertEquals(
            pantalla.getString(R.string.main_confirmar_despegue_aqui_texto),
            pregunta.findViewById<TextView>(android.R.id.message)?.text.toString(),
        )

        pregunta.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(false, pregunta.isShowing)
    }

    /** Sin rutas cargadas no hay nada que explicar debajo de "Comenzar". */
    @Test
    fun sinRutasNoExplicaPorQueNoPatrulla() {
        val pantalla = pantallaDeOperacion()
        val aviso = pantalla.findViewById<TextView>(R.id.txtNoPatrulla)
        assertEquals(android.view.View.GONE, aviso.visibility)
        assertNull(aviso.text.toString().takeIf { it.isNotEmpty() })
    }
}
