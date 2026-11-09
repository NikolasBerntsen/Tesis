package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.drone.SupervisorDelRegreso.Accion
import com.tesis.dronepatrol.drone.SupervisorDelRegreso.Lectura
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cómo se sostiene un regreso a base de la app hasta que arranca (VUELO §7.2),
 * lectura por lectura: la orden que el dron rechaza o no contesta se vuelve a
 * mandar, la que acepta tiene que sacar al regreso de IDLE en tres segundos, y
 * agotadas las órdenes se avisa por qué no se pudo. Los bordes de cada plazo se
 * miran con el reloj de la prueba.
 */
class SupervisorDelRegresoTest {

    private var ahora = 1_000_000L
    private val supervisor = SupervisorDelRegreso { ahora }

    private fun lectura(
        arranco: Boolean? = false,
        enVuelo: Boolean = true,
        enlace: Boolean = true,
    ) = Lectura(enVuelo, enlace, arranco)

    private fun pasar(ms: Long) {
        ahora += ms
    }

    /** Arranca y el dron acepta la primera orden, con el regreso todavía en IDLE. */
    private fun aceptado() {
        assertEquals(Accion.ORDENAR, supervisor.empezar())
        assertEquals(Accion.SEGUIR, supervisor.alContestar(true, lectura()))
    }

    // ---- La orden ----

    @Test
    fun laPrimeraOrdenAceptadaSigueMirandoYQuedaAceptado() {
        assertFalse(supervisor.aceptado)
        aceptado()
        assertTrue(supervisor.aceptado)
        assertEquals(1, supervisor.ordenes)
    }

    @Test
    fun unaOrdenRechazadaSeVuelveAMandarYALaTerceraSeRinde() {
        supervisor.empezar()
        assertEquals(Accion.ORDENAR, supervisor.alContestar(false, lectura(), "go home not allowed"))
        assertEquals(Accion.ORDENAR, supervisor.alContestar(null, lectura()))
        assertEquals(Accion.NO_SE_PUDO, supervisor.alContestar(false, lectura(), null))

        assertFalse(supervisor.aceptado)
        assertEquals(3, supervisor.ordenes)
        val motivo = supervisor.motivoDelFallo()
        assertTrue(motivo, motivo.startsWith("el dron no aceptó la orden en 3 intentos (go home not allowed)"))
        assertTrue("queda dicho cómo queda el dron: $motivo", motivo.endsWith("queda estacionario donde está, a la espera de otra orden"))
    }

    @Test
    fun sinRespuestaNingunaElMotivoDiceQueNoContesto() {
        supervisor.empezar()
        repeat(SupervisorDelRegreso.MAXIMO_DE_ORDENES) { supervisor.alContestar(null, lectura(arranco = null)) }
        assertTrue(supervisor.motivoDelFallo(), supervisor.motivoDelFallo().startsWith("el dron no contestó la orden en 3 intentos"))
    }

    /** El "ya estoy volviendo" del SDK: rechaza (o no contesta) la orden, pero el regreso está en curso. */
    @Test
    fun rechazadaConElDronYaVolviendoCuentaComoArrancado() {
        supervisor.empezar()
        assertEquals(Accion.ARRANCO, supervisor.alContestar(false, lectura(arranco = true), "already going home"))

        val otro = SupervisorDelRegreso { ahora }
        otro.empezar()
        assertEquals(Accion.ARRANCO, otro.alContestar(null, lectura(arranco = true)))
    }

    @Test
    fun enElSueloLaSecuenciaTermina() {
        supervisor.empezar()
        assertEquals(Accion.EN_EL_SUELO, supervisor.alContestar(true, lectura(enVuelo = false)))
        assertEquals(Accion.EN_EL_SUELO, supervisor.alLeer(lectura(enVuelo = false)))
    }

    // ---- Que de verdad arranque ----

    /** Aceptó y el regreso sigue en IDLE: a los 3 s, otra orden; un milisegundo antes, todavía no. */
    @Test
    fun sinArrancarEnTresSegundosSeVuelveAOrdenar() {
        aceptado()
        pasar(SupervisorDelRegreso.VERIFICACION_MS - 1)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura()))
        pasar(1)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura()))
    }

    @Test
    fun cuandoElRegresoArrancaLaSecuenciaTermina() {
        aceptado()
        pasar(SupervisorDelRegreso.INTERVALO_MS)
        assertEquals(Accion.ARRANCO, supervisor.alLeer(lectura(arranco = true)))
        assertEquals(1, supervisor.ordenes)
    }

    /** Si el dron no informa el estado del regreso, el plazo corre igual: no se sabe que arrancó. */
    @Test
    fun sinEstadoInformadoElPlazoCorreIgual() {
        aceptado()
        pasar(SupervisorDelRegreso.VERIFICACION_MS - 1)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(arranco = null)))
        pasar(1)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura(arranco = null)))
    }

    /** El plazo cuenta desde la respuesta de CADA orden, no desde la primera. */
    @Test
    fun elPlazoCuentaDesdeLaRespuestaDeCadaOrden() {
        aceptado()
        pasar(SupervisorDelRegreso.VERIFICACION_MS)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura()))
        pasar(SupervisorDelRegreso.ENTRE_ORDENES_MS)
        assertEquals(Accion.SEGUIR, supervisor.alContestar(true, lectura()))
        pasar(SupervisorDelRegreso.VERIFICACION_MS - 1)
        assertEquals("los 3 s de la primera orden ya pasaron, los de la segunda no", Accion.SEGUIR, supervisor.alLeer(lectura()))
        pasar(1)
        assertEquals("la tercera orden, todavía no rendirse", Accion.ORDENAR, supervisor.alLeer(lectura()))
        assertEquals(2, supervisor.ordenes)
    }

    @Test
    fun aceptadaTresVecesSinArrancarSeRindeDiciendoQueNoArranco() {
        aceptado()
        repeat(SupervisorDelRegreso.MAXIMO_DE_ORDENES - 1) {
            pasar(SupervisorDelRegreso.VERIFICACION_MS)
            assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura()))
            assertEquals(Accion.SEGUIR, supervisor.alContestar(true, lectura()))
        }
        pasar(SupervisorDelRegreso.VERIFICACION_MS)
        assertEquals(Accion.NO_SE_PUDO, supervisor.alLeer(lectura()))
        assertEquals(3, supervisor.ordenes)
        assertTrue(
            supervisor.motivoDelFallo(),
            supervisor.motivoDelFallo().startsWith("el dron aceptó la orden pero el regreso no arrancó en 3 s (3 órdenes)"),
        )
    }

    /** Con una orden aceptada en el medio de dos rechazadas, lo que se dice es que no arrancó. */
    @Test
    fun unaOrdenAceptadaEntreRechazosDiceQueNoArranco() {
        supervisor.empezar()
        assertEquals(Accion.ORDENAR, supervisor.alContestar(false, lectura(), "go home not allowed"))
        assertEquals(Accion.SEGUIR, supervisor.alContestar(true, lectura()))
        pasar(SupervisorDelRegreso.VERIFICACION_MS)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura()))
        assertEquals(Accion.NO_SE_PUDO, supervisor.alContestar(false, lectura(), "go home not allowed"))
        assertTrue(supervisor.motivoDelFallo(), supervisor.motivoDelFallo().startsWith("el dron aceptó la orden pero el regreso no arrancó"))
    }

    /** Sin enlace el dron sigue con lo suyo y no hay lectura nueva: el plazo no corre. */
    @Test
    fun sinEnlaceElPlazoNoCorre() {
        aceptado()
        pasar(10_000)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(arranco = null, enlace = false)))
        pasar(SupervisorDelRegreso.VERIFICACION_MS - 1)
        assertEquals("cuenta desde que volvió el enlace", Accion.SEGUIR, supervisor.alLeer(lectura()))
        pasar(1)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura()))
    }

    @Test
    fun empezarDeNuevoArrancaLaCuentaDeCero() {
        aceptado()
        pasar(SupervisorDelRegreso.VERIFICACION_MS)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura()))

        assertEquals(Accion.ORDENAR, supervisor.empezar())

        assertEquals(0, supervisor.ordenes)
        assertFalse(supervisor.aceptado)
        assertTrue(supervisor.motivoDelFallo(), supervisor.motivoDelFallo().startsWith("el dron no contestó la orden en 0 intentos"))
    }

    /** Con el reloj de fábrica (el del sistema) la secuencia arranca igual: es el que usa el controlador real. */
    @Test
    fun conElRelojDelSistemaLaSecuenciaArrancaIgual() {
        val real = SupervisorDelRegreso()
        assertEquals(Accion.ORDENAR, real.empezar())
        assertEquals(Accion.SEGUIR, real.alContestar(true, lectura()))
        assertEquals("recién aceptada, el plazo no venció", Accion.SEGUIR, real.alLeer(lectura()))
    }

    // ---- El estado del dron ----

    @Test
    fun elRegresoArrancoSegunElEstadoDelRegresoOElModoDeVuelo() {
        SupervisorDelRegreso.ESTADOS_DE_REGRESO_EN_CURSO.forEach {
            assertEquals(it, true, SupervisorDelRegreso.arranco(it, null))
        }
        assertEquals("el modo de vuelo alcanza", true, SupervisorDelRegreso.arranco("IDLE", "GO_HOME"))
        assertEquals(true, SupervisorDelRegreso.arranco(null, "GO_HOME"))
        assertEquals(false, SupervisorDelRegreso.arranco("IDLE", "GPS_NORMAL"))
        assertEquals(false, SupervisorDelRegreso.arranco("IDLE", null))
        assertEquals("un regreso anterior terminado no es este", false, SupervisorDelRegreso.arranco("COMPLETED", null))
        assertEquals(false, SupervisorDelRegreso.arranco(null, "VIRTUAL_STICK"))
        assertEquals(false, SupervisorDelRegreso.arranco("UNKNOWN", "GPS_NORMAL"))
        assertNull("sin nada informado no se sabe", SupervisorDelRegreso.arranco(null, null))
        assertNull(SupervisorDelRegreso.arranco("UNKNOWN", "UNKNOWN"))
        assertNull(SupervisorDelRegreso.arranco("UNKNOWN", null))
    }
}
