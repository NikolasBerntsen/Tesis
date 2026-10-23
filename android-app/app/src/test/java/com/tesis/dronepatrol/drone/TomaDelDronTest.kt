package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.MotivoDelDron
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * La lectura de los avisos del MSDK sobre el propio DJI tomando el vuelo. Los
 * nombres son los de los enumerados del MSDK 5.18.0 tal cual: si el SDK los
 * cambia, esta prueba es la que tiene que fallar.
 */
class TomaDelDronTest {

    @Test
    fun losMotivosDeBateriaYDeRegresoSonTomas() {
        assertEquals(MotivoDelDron.RTH_BATERIA, TomaDelDron.porCambioDeAutoridad("BATTERY_LOW_GO_HOME"))
        assertEquals(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA, TomaDelDron.porCambioDeAutoridad("BATTERY_SUPER_LOW_LANDING"))
        assertEquals(MotivoDelDron.RTH_DEL_CONTROL, TomaDelDron.porCambioDeAutoridad("RC_ONE_KEY_GO_HOME"))
        assertEquals(MotivoDelDron.RTH_SENIAL, TomaDelDron.porCambioDeAutoridad("RC_LOST"))
    }

    /** El operador con las palancas, la propia app o lo desconocido: el aviso de siempre, no una toma. */
    @Test
    fun elRestoNoEsUnaToma() {
        listOf(
            "MSDK_REQUEST", "AUTO_TEST_REQUEST", "OSDK_REQUEST", "RC_NOT_P_MODE", "RC_SWITCH",
            "RC_PAUSE_STOP", "OSDK_LOST", "NEAR_BOUNDARY", "AIRPORT_REQUEST", "UNKNOWN", "",
        ).forEach { assertNull(it, TomaDelDron.porCambioDeAutoridad(it)) }
    }

    /** La batería y el botón del control dejan a la app sin mando; la señal y lo desconocido, no. */
    @Test
    fun soloBateriaYBotonDelControlBloqueanALaApp() {
        assertTrue(TomaDelDron.bloqueaLaApp(MotivoDelDron.RTH_BATERIA))
        assertTrue(TomaDelDron.bloqueaLaApp(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA))
        assertTrue(TomaDelDron.bloqueaLaApp(MotivoDelDron.RTH_DEL_CONTROL))
        assertFalse(TomaDelDron.bloqueaLaApp(MotivoDelDron.RTH_SENIAL))
        assertFalse(TomaDelDron.bloqueaLaApp(MotivoDelDron.OTRO))
    }

    @Test
    fun lasFasesDelRegresoSegunGoHomeState() {
        assertEquals(SeguidorDelRegreso.Fase.INACTIVO, TomaDelDron.faseDelRegreso("IDLE"))
        assertEquals(SeguidorDelRegreso.Fase.VOLVIENDO, TomaDelDron.faseDelRegreso("RETURNING_TO_HOME"))
        assertEquals(SeguidorDelRegreso.Fase.DESCENDIENDO, TomaDelDron.faseDelRegreso("LANDING"))
        assertEquals(SeguidorDelRegreso.Fase.OTRA, TomaDelDron.faseDelRegreso("COMPLETED"))
        assertEquals(SeguidorDelRegreso.Fase.OTRA, TomaDelDron.faseDelRegreso("UNKNOWN"))
    }

    @Test
    fun elMotivoProbableDeUnRegresoSinExplicar() {
        assertEquals(MotivoDelDron.RTH_BATERIA, TomaDelDron.motivoProbable("COUNTING_DOWN", enlaceRecienRecuperado = false))
        assertEquals(MotivoDelDron.RTH_BATERIA, TomaDelDron.motivoProbable("EXECUTED", enlaceRecienRecuperado = true))
        assertEquals(MotivoDelDron.RTH_SENIAL, TomaDelDron.motivoProbable("IDLE", enlaceRecienRecuperado = true))
        assertEquals(MotivoDelDron.RTH_SENIAL, TomaDelDron.motivoProbable(null, enlaceRecienRecuperado = true))
        assertEquals(MotivoDelDron.OTRO, TomaDelDron.motivoProbable("CANCELLED", enlaceRecienRecuperado = false))
        assertEquals(MotivoDelDron.OTRO, TomaDelDron.motivoProbable(null, enlaceRecienRecuperado = false))
    }
}
