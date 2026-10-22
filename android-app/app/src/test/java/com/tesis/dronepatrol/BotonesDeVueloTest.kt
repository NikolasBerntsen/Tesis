package com.tesis.dronepatrol

import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.PatrolState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Qué botones de vuelo se prenden en la pantalla de operación. Lo que enseñó el
 * campo: en interior no hay GPS, "Comenzar ruta" queda apagado y el operador
 * tiene que saber por qué; "Despegar aquí" no pide GPS; y después de aterrizar
 * por batería baja no se vuela hasta cambiarla.
 */
class BotonesDeVueloTest {

    private val listo = EstadoDelDron(
        sdkListo = true, conectado = true, modelo = "Mini 4 Pro", enVuelo = false, satelites = 14, baseFijada = true,
    )
    private val sinGps = listo.copy(satelites = 0, baseFijada = false, detalle = "sin GPS (0 satélites)")
    private val enElAire = sinGps.copy(enVuelo = true)
    private val sinEnlace = listo.copy(conectado = false, detalle = "sin enlace con la aeronave")

    // ---- Comenzar patrullaje ----

    @Test
    fun conRutaYElDronListoSePuedeComenzar() {
        assertTrue(BotonesDeVuelo.comenzarHabilitado(true, PatrolState.IDLE, listo))
        assertTrue("en el aire la ruta arranca sin despegar", BotonesDeVuelo.comenzarHabilitado(true, PatrolState.IDLE, enElAire))
    }

    @Test
    fun sinRutaSinGpsOConOtraCosaEnCursoNoSeComienza() {
        assertFalse(BotonesDeVuelo.comenzarHabilitado(false, PatrolState.IDLE, listo))
        assertFalse(BotonesDeVuelo.comenzarHabilitado(true, PatrolState.IDLE, sinGps))
        assertFalse(BotonesDeVuelo.comenzarHabilitado(true, PatrolState.PATROLLING, listo))
        assertFalse("con la batería por cambiar", BotonesDeVuelo.comenzarHabilitado(true, PatrolState.LANDED, listo))
    }

    // ---- Por qué están apagados ----

    @Test
    fun sinGpsDiceElMotivoDelDron() {
        assertEquals(
            BotonesDeVuelo.Aviso.SinCondicionesParaLaRuta("sin GPS (0 satélites)"),
            BotonesDeVuelo.aviso(true, PatrolState.IDLE, sinGps),
        )
    }

    @Test
    fun despuesDeAterrizarPorBateriaDiceQueHayQueCambiarla() {
        assertEquals(BotonesDeVuelo.Aviso.CambiarLaBateria, BotonesDeVuelo.aviso(true, PatrolState.LANDED, listo))
        assertEquals("también sin rutas", BotonesDeVuelo.Aviso.CambiarLaBateria, BotonesDeVuelo.aviso(false, PatrolState.LANDED, sinGps))
        assertNull("si alguien lo despegó con las palancas ya no aplica", BotonesDeVuelo.aviso(true, PatrolState.LANDED, enElAire))
    }

    @Test
    fun noExplicaNadaSiSePuedeOSiNoCorresponde() {
        assertNull("se puede", BotonesDeVuelo.aviso(true, PatrolState.IDLE, listo))
        assertNull("en el aire se puede", BotonesDeVuelo.aviso(true, PatrolState.IDLE, enElAire))
        assertNull("sin rutas no hay nada que patrullar", BotonesDeVuelo.aviso(false, PatrolState.IDLE, sinGps))
        assertNull("con otra cosa en curso", BotonesDeVuelo.aviso(true, PatrolState.MANUAL, sinGps))
    }

    // ---- Despegar aquí ----

    @Test
    fun despegarAquiNoPideGps() {
        assertTrue(BotonesDeVuelo.despegarAquiHabilitado(PatrolState.IDLE, sinGps))
        assertTrue("con el control tomado en el suelo", BotonesDeVuelo.despegarAquiHabilitado(PatrolState.MANUAL, sinGps))
    }

    @Test
    fun despegarAquiNoEnElAireNiSinEnlaceNiVolviendoABaseNiConLaBateriaPorCambiar() {
        assertFalse(BotonesDeVuelo.despegarAquiHabilitado(PatrolState.IDLE, enElAire))
        assertFalse(BotonesDeVuelo.despegarAquiHabilitado(PatrolState.IDLE, sinEnlace))
        assertFalse("aterrizó por batería baja", BotonesDeVuelo.despegarAquiHabilitado(PatrolState.LANDED, listo))
        for (regreso in listOf(
            PatrolState.RETURNING_HOME,
            PatrolState.RETURNING_HOME_BATTERY,
            PatrolState.RETURNING_HOME_SIGNAL,
        )) {
            assertFalse(regreso.name, BotonesDeVuelo.despegarAquiHabilitado(regreso, listo))
        }
    }
}

/** Los textos de los avisos salen de los recursos: hace falta un Context de verdad. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BotonesDeVueloTextoTest {

    private val contexto = RuntimeEnvironment.getApplication()

    @Test
    fun elAvisoSinGpsLlevaElMotivoDelDron() {
        val texto = BotonesDeVuelo.texto(BotonesDeVuelo.Aviso.SinCondicionesParaLaRuta("sin GPS (0 satélites)"), contexto)
        assertEquals(contexto.getString(R.string.main_no_se_puede_patrullar, "sin GPS (0 satélites)"), texto)
        assertTrue(texto.contains("sin GPS (0 satélites)"))
    }

    @Test
    fun elAvisoDeLaBateriaDiceQueHayQueCambiarla() {
        assertEquals(
            contexto.getString(R.string.main_cambiar_bateria),
            BotonesDeVuelo.texto(BotonesDeVuelo.Aviso.CambiarLaBateria, contexto),
        )
    }
}
