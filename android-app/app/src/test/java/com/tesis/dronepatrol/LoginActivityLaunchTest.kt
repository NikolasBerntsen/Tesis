package com.tesis.dronepatrol

import android.content.Intent
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

    @Test
    fun laPantallaDeLoginArrancaSinCrashear() {
        val controller = Robolectric.buildActivity(LoginActivity::class.java).setup()
        assertNotNull(controller.get())
    }

    /**
     * La pantalla principal se crea con los datos que manda el login. Se apunta
     * a un puerto muerto: acá solo interesa que inflar y cablear la UI no rompa.
     */
    @Test
    fun laPantallaPrincipalArrancaSinCrashear() {
        val intent = Intent(RuntimeEnvironment.getApplication(), MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_BACKEND_URL, "http://127.0.0.1:1")
            .putExtra(MainActivity.EXTRA_DETECTION_URL, "ws://127.0.0.1:1")
            .putExtra(MainActivity.EXTRA_USERNAME, "drone1")
            .putExtra(MainActivity.EXTRA_PASSWORD, "sin-uso")
            .putExtra(MainActivity.EXTRA_DISPLAY_NAME, "Alfa")
            .putExtra(MainActivity.EXTRA_BASE_LAT, -34.8565)
            .putExtra(MainActivity.EXTRA_BASE_LON, -56.2075)
            .putExtra(MainActivity.EXTRA_MODE, "TEST")

        val controller = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        assertNotNull(controller.get())
    }
}
