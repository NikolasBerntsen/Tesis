package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.drone.SupervisorDelAterrizaje.Accion
import com.tesis.dronepatrol.drone.SupervisorDelAterrizaje.Lectura
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cómo se sostiene un aterrizaje de la app hasta el suelo, lectura por
 * lectura: la orden que el dron rechaza o no contesta se vuelve a mandar, el
 * dron que la acepta tiene que entrar en modo aterrizaje y bajar, el que deja de
 * bajar se vuelve a ordenar y, agotadas las órdenes, se avisa por qué no se
 * pudo. Los bordes de cada plazo se miran con el reloj de la prueba.
 */
class SupervisorDelAterrizajeTest {

    private var ahora = 1_000_000L
    private val supervisor = SupervisorDelAterrizaje { ahora }

    private fun lectura(
        alt: Double = 20.0,
        bajando: Boolean? = true,
        pide: Boolean = false,
        enVuelo: Boolean = true,
        enlace: Boolean = true,
    ) = Lectura(enVuelo, enlace, bajando, pide, alt)

    private fun pasar(ms: Long) {
        ahora += ms
    }

    /** Arranca y el dron acepta la primera orden a [alt] metros. */
    private fun aceptado(alt: Double = 20.0) {
        assertEquals(Accion.ORDENAR, supervisor.empezar())
        assertEquals(Accion.SEGUIR, supervisor.alContestar(true, lectura(alt, bajando = false)))
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
        val noBaja = lectura(bajando = false)
        assertEquals(Accion.ORDENAR, supervisor.alContestar(false, noBaja, "landing not allowed"))
        assertEquals(Accion.ORDENAR, supervisor.alContestar(null, noBaja))
        assertEquals(Accion.NO_SE_PUDO, supervisor.alContestar(false, noBaja, null))

        assertFalse(supervisor.aceptado)
        val motivo = supervisor.motivoDelFallo()
        assertTrue(motivo, motivo.startsWith("el dron no aceptó la orden en 3 intentos (landing not allowed)"))
        assertTrue("queda dicho cómo queda el dron: $motivo", motivo.endsWith("queda suspendido donde está, con las palancas del control"))
    }

    @Test
    fun sinRespuestaNingunaElMotivoDiceQueNoContesto() {
        supervisor.empezar()
        repeat(SupervisorDelAterrizaje.MAXIMO_DE_ORDENES) { supervisor.alContestar(null, lectura(bajando = null)) }
        assertTrue(supervisor.motivoDelFallo(), supervisor.motivoDelFallo().startsWith("el dron no contestó la orden en 3 intentos"))
    }

    /** El "ya estoy aterrizando" del SDK: rechaza la orden, pero baja (o pide confirmar). */
    @Test
    fun rechazadaConElDronYaBajandoOPidiendoConfirmarCuentaComoAceptada() {
        supervisor.empezar()
        assertEquals(Accion.SEGUIR, supervisor.alContestar(false, lectura(bajando = true), "already landing"))
        assertTrue(supervisor.aceptado)

        val otro = SupervisorDelAterrizaje { ahora }
        otro.empezar()
        assertEquals(Accion.SEGUIR, otro.alContestar(null, lectura(alt = 0.5, bajando = false, pide = true)))
        assertTrue(otro.aceptado)
    }

    @Test
    fun enElSueloLaSecuenciaTermina() {
        supervisor.empezar()
        assertEquals(Accion.EN_EL_SUELO, supervisor.alContestar(false, lectura(enVuelo = false)))
        assertEquals(Accion.EN_EL_SUELO, supervisor.alLeer(lectura(enVuelo = false)))
    }

    // ---- Que de verdad baje ----

    /** Aceptó y no entró en modo aterrizaje ni bajó: a los 3 s, otra orden; un milisegundo antes, todavía no. */
    @Test
    fun sinSenialesDeAterrizajeEnTresSegundosSeVuelveAOrdenar() {
        aceptado()
        pasar(SupervisorDelAterrizaje.VERIFICACION_MS - 1)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = false)))
        pasar(1)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura(bajando = false)))
    }

    /** El modo de vuelo dice que aterriza: alcanza para no reordenar a los 3 s. */
    @Test
    fun enModoAterrizajeNoSeReordenaALosTresSegundos() {
        aceptado()
        repeat(10) {
            pasar(500)
            assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true)))
        }
    }

    /** Sin modo informado, la altura que baja es la señal. */
    @Test
    fun sinModoInformadoLaAlturaQueBajaAlcanza() {
        aceptado(alt = 30.0)
        var alt = 30.0
        repeat(20) {
            pasar(500)
            alt -= 1.0
            assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = alt, bajando = null)))
        }
    }

    /** Dice que aterriza pero no baja en 20 s: está trabado y se vuelve a ordenar. */
    @Test
    fun enModoAterrizajeSinBajarVeinteSegundosSeVuelveAOrdenar() {
        aceptado(alt = 8.0)
        pasar(SupervisorDelAterrizaje.ESTANCADO_MS - 1)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = 8.0, bajando = true)))
        pasar(1)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura(alt = 8.0, bajando = true)))
    }

    /** Suspendido a medio metro pidiendo confirmar no es estar trabado: eso lo contesta la confirmación. */
    @Test
    fun pidiendoConfirmarNuncaSeReordena() {
        aceptado(alt = 0.5)
        repeat(60) {
            pasar(500)
            assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = 0.5, bajando = false, pide = true)))
        }
    }

    @Test
    fun aceptadaTresVecesSinBajarSeRindeDiciendoQueNoBaja() {
        aceptado()
        repeat(SupervisorDelAterrizaje.MAXIMO_DE_ORDENES - 1) {
            pasar(SupervisorDelAterrizaje.VERIFICACION_MS)
            assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura(bajando = false)))
            assertEquals(Accion.SEGUIR, supervisor.alContestar(true, lectura(bajando = false)))
        }
        pasar(SupervisorDelAterrizaje.VERIFICACION_MS)
        assertEquals(Accion.NO_SE_PUDO, supervisor.alLeer(lectura(bajando = false)))
        assertTrue(supervisor.motivoDelFallo(), supervisor.motivoDelFallo().startsWith("el dron aceptó la orden pero no baja (3 órdenes)"))
    }

    /** Sin enlace el dron sigue con lo suyo y no hay lectura nueva: el plazo no corre. */
    @Test
    fun sinEnlaceElPlazoNoCorre() {
        aceptado()
        pasar(10_000)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = null, enlace = false)))
        pasar(SupervisorDelAterrizaje.VERIFICACION_MS - 1)
        assertEquals("cuenta desde que volvió el enlace", Accion.SEGUIR, supervisor.alLeer(lectura(bajando = false)))
    }

    // ---- Una persona que lo sube con las palancas ----

    @Test
    fun siDejaDeAterrizarYSubeLoSubieronYNoSeLoPelea() {
        aceptado(alt = 10.0)
        pasar(500)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = 5.0)))
        pasar(500)
        assertEquals("subir lo justo no corta", Accion.SEGUIR, supervisor.alLeer(lectura(alt = 6.4, bajando = false)))
        pasar(500)
        assertEquals(Accion.LO_SUBIERON, supervisor.alLeer(lectura(alt = 7.0, bajando = false)))
        assertTrue(supervisor.motivoDeLaSubida(), supervisor.motivoDeLaSubida().startsWith("el dron dejó de bajar y subió 2.0 m"))
    }

    /** Aterrizando o pidiendo confirmar, lo que sube es el propio dron acomodándose. */
    @Test
    fun subirAterrizandoOPidiendoConfirmarNoEsQueLoSubieron() {
        aceptado(alt = 3.0)
        pasar(500)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = 0.5, bajando = true)))
        pasar(500)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = 2.5, bajando = true)))
        pasar(500)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = 2.5, bajando = false, pide = true)))
    }

    /** El corrimiento lo sube a 2 m desde medio metro: después, la cuenta arranca de cero. */
    @Test
    fun despuesDeEmpezarDeNuevoLaAlturaDeAntesNoCuenta() {
        aceptado(alt = 3.0)
        pasar(500)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = 0.5, bajando = true)))
        assertEquals(Accion.ORDENAR, supervisor.empezar())
        assertEquals(0, supervisor.ordenes)
        assertEquals(Accion.SEGUIR, supervisor.alContestar(true, lectura(alt = 2.5, bajando = false)))
        pasar(500)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = 2.5, bajando = false)))
    }

    @Test
    fun sinAlturaNoSeSabeSiLoSubieron() {
        aceptado(alt = Double.NaN)
        pasar(500)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(alt = Double.NaN, bajando = true)))
    }

    // ---- La confirmación que el dron no toma ----

    @Test
    fun aLaQuintaConfirmacionSinEfectoSeAvisaUnaVez() {
        val avisos = (1..8).map { supervisor.alConfirmar() }
        assertEquals(listOf(false, false, false, false, true, false, false, false), avisos)
        assertEquals(8, supervisor.confirmaciones)
    }

    // ---- El modo de vuelo ----

    @Test
    fun losModosDeAterrizajeDelMsdkSonBajando() {
        SupervisorDelAterrizaje.MODOS_DE_ATERRIZAJE.forEach {
            assertEquals(it, true, SupervisorDelAterrizaje.estaBajando(it, null))
        }
        assertEquals(false, SupervisorDelAterrizaje.estaBajando("GPS_NORMAL", null))
        assertEquals(false, SupervisorDelAterrizaje.estaBajando("VIRTUAL_STICK", false))
        assertEquals("KeyIsInLandingMode alcanza", true, SupervisorDelAterrizaje.estaBajando("GPS_NORMAL", true))
        assertEquals(true, SupervisorDelAterrizaje.estaBajando(null, true))
        assertEquals(false, SupervisorDelAterrizaje.estaBajando("UNKNOWN", false))
        assertNull("sin nada informado no se sabe", SupervisorDelAterrizaje.estaBajando(null, null))
        assertNull(SupervisorDelAterrizaje.estaBajando("UNKNOWN", null))
    }
}
