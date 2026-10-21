package com.tesis.dronepatrol

import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.PatrolState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Qué botones de vuelo se prenden en la pantalla de operación. Lo que enseñó el
 * campo: en interior no hay GPS, "Comenzar ruta" queda apagado y el operador
 * tiene que saber por qué; "Despegar aquí" no pide GPS.
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
    }

    // ---- Por qué no se puede patrullar ----

    @Test
    fun sinGpsDiceElMotivoDelDron() {
        assertEquals("sin GPS (0 satélites)", BotonesDeVuelo.porQueNoPatrulla(true, PatrolState.IDLE, sinGps))
    }

    @Test
    fun noExplicaNadaSiSePuedeOSiNoCorresponde() {
        assertNull("se puede", BotonesDeVuelo.porQueNoPatrulla(true, PatrolState.IDLE, listo))
        assertNull("en el aire se puede", BotonesDeVuelo.porQueNoPatrulla(true, PatrolState.IDLE, enElAire))
        assertNull("sin rutas no hay nada que patrullar", BotonesDeVuelo.porQueNoPatrulla(false, PatrolState.IDLE, sinGps))
        assertNull("con otra cosa en curso", BotonesDeVuelo.porQueNoPatrulla(true, PatrolState.MANUAL, sinGps))
    }

    // ---- Despegar aquí ----

    @Test
    fun despegarAquiNoPideGps() {
        assertTrue(BotonesDeVuelo.despegarAquiHabilitado(PatrolState.IDLE, sinGps))
        assertTrue("con el control tomado en el suelo", BotonesDeVuelo.despegarAquiHabilitado(PatrolState.MANUAL, sinGps))
        assertTrue("después de un aterrizaje por batería", BotonesDeVuelo.despegarAquiHabilitado(PatrolState.LANDED, listo))
    }

    @Test
    fun despegarAquiNoEnElAireNiSinEnlaceNiVolviendoABase() {
        assertFalse(BotonesDeVuelo.despegarAquiHabilitado(PatrolState.IDLE, enElAire))
        assertFalse(BotonesDeVuelo.despegarAquiHabilitado(PatrolState.IDLE, sinEnlace))
        for (regreso in listOf(
            PatrolState.RETURNING_HOME,
            PatrolState.RETURNING_HOME_BATTERY,
            PatrolState.RETURNING_HOME_SIGNAL,
        )) {
            assertFalse(regreso.name, BotonesDeVuelo.despegarAquiHabilitado(regreso, listo))
        }
    }
}
