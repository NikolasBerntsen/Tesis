package com.tesis.dronepatrol

import android.content.Intent
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Smoke test de arranque: si la pantalla inicial revienta al crearse, este test
 * falla con el stack trace real en vez de un cierre silencioso en el dispositivo.
 * Se corre en el rango de APIs que abarca minSdk 26 .. targetSdk 34.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 30, 34])
class LoginActivityLaunchTest {

    private companion object {
        /** La del contrato: es la que tiene que aparecer sola en el campo. */
        const val URL_POR_DEFECTO = "https://tesis.144-22-138-149.sslip.io"
    }

    @Test
    fun laPantallaDeLoginArrancaSinCrashear() {
        val controller = Robolectric.buildActivity(LoginActivity::class.java).setup()
        assertNotNull(controller.get())
    }

    /**
     * La pantalla principal se crea con lo que devuelve el emparejamiento por
     * QR. El token es de mentira: acá solo interesa que inflar y cablear la UI
     * no rompa.
     */
    @Test
    fun laPantallaPrincipalArrancaSinCrashear() {
        val intent = Intent(RuntimeEnvironment.getApplication(), MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_DRONE_TOKEN, "token-de-prueba")
            .putExtra(MainActivity.EXTRA_DRONE_HASH, "0123456789abcdef0123456789abcdef")
            .putExtra(MainActivity.EXTRA_DISPLAY_NAME, "Alfa")
            .putExtra(MainActivity.EXTRA_BASE_LAT, -34.6037)
            .putExtra(MainActivity.EXTRA_BASE_LON, -58.3816)
            .putExtra(MainActivity.EXTRA_MODE, "TEST")

        val controller = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        assertNotNull(controller.get())
    }

    // De acá para abajo va comportamiento, que no depende de la versión de
    // Android: alcanza con una sola API y el arranque ya se probó en las tres.

    @Test
    @Config(sdk = [34])
    fun traeLaUrlDelComandoCentralPrecargada() {
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()

        val url = actividad.findViewById<EditText>(R.id.editBackendUrl).text.toString()
        assertEquals(URL_POR_DEFECTO, url)
    }

    /** Con guantes y a la intemperie nadie quiere retipear la URL. */
    @Test
    @Config(sdk = [34])
    fun recuerdaLaUltimaUrlDelComandoCentral() {
        PreferenciasEnlace(RuntimeEnvironment.getApplication()).urlComandoCentral = "https://otro.comando.central"

        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()

        assertEquals(
            "https://otro.comando.central",
            actividad.findViewById<EditText>(R.id.editBackendUrl).text.toString(),
        )
    }

    /** Volver al login sin decir por qué deja al operador probando de nuevo a ciegas. */
    @Test
    @Config(sdk = [34])
    fun muestraElAvisoConElQueVolvioAlLogin() {
        val aviso = RuntimeEnvironment.getApplication().getString(R.string.aviso_sesion_vencida)
        val intent = Intent(RuntimeEnvironment.getApplication(), LoginActivity::class.java)
            .putExtra(LoginActivity.EXTRA_AVISO, aviso)

        val actividad = Robolectric.buildActivity(LoginActivity::class.java, intent).setup().get()

        assertEquals(aviso, actividad.findViewById<TextView>(R.id.txtLoginStatus).text.toString())
    }

    @Test
    @Config(sdk = [34])
    fun sinCredencialesNiSiquieraSaleAPreguntar() {
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()

        actividad.findViewById<Button>(R.id.btnLogin).performClick()

        assertEquals(
            actividad.getString(R.string.login_faltan_datos),
            actividad.findViewById<TextView>(R.id.txtLoginStatus).text.toString(),
        )
    }
}
