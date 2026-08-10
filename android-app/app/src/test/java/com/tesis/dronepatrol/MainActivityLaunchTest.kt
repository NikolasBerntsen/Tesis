package com.tesis.dronepatrol

import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Smoke test de arranque: si MainActivity revienta al crearse, este test falla
 * con el stack trace real en vez de un cierre silencioso en el dispositivo.
 * Se corre en el rango de APIs que abarca minSdk 26 .. targetSdk 34.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 30, 34])
class MainActivityLaunchTest {

    @Test
    fun laActivityArrancaSinCrashear() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        assertNotNull(controller.get())
    }
}
