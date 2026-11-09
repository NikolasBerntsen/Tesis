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
 * agotadas las órdenes se avisa por qué no se pudo. Sin enlace las órdenes no
 * cuentan y nunca se rinde; bajando (cerca de la base el GoHome aterriza
 * directo) se lo mira hasta el suelo. Los bordes de cada plazo se miran con el
 * reloj de la prueba.
 */
class SupervisorDelRegresoTest {

    private var ahora = 1_000_000L
    private val supervisor = SupervisorDelRegreso { ahora }

    /** De fábrica, a 20 m de altura y a 10 m de la base: bajar ahí es el GoHome que aterriza directo. */
    private fun lectura(
        arranco: Boolean? = false,
        enVuelo: Boolean = true,
        enlace: Boolean = true,
        bajando: Boolean? = false,
        salida: String? = null,
        alt: Double = 20.0,
        distancia: Double = 10.0,
    ) = Lectura(enVuelo, enlace, arranco, bajando, salida, alt, distancia)

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
        assertEquals(
            "el dron no aceptó la orden en 3 intentos (go home not allowed): queda estacionario donde está, a la espera de otra orden",
            motivo,
        )
    }

    @Test
    fun sinRespuestaNingunaElMotivoDiceQueNoContesto() {
        supervisor.empezar()
        repeat(SupervisorDelRegreso.MAXIMO_DE_ORDENES) { supervisor.alContestar(null, lectura(arranco = null)) }
        assertEquals(
            "el dron no contestó la orden en 3 intentos: queda estacionario donde está, a la espera de otra orden",
            supervisor.motivoDelFallo(),
        )
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
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(arranco = null, bajando = null)))
        pasar(1)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura(arranco = null, bajando = null)))
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
        assertEquals(
            "el dron aceptó la orden pero el regreso no arrancó en 3 s (3 órdenes): queda estacionario donde está, a la espera de otra orden",
            supervisor.motivoDelFallo(),
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

    @Test
    fun empezarDeNuevoArrancaLaCuentaDeCero() {
        aceptado()
        pasar(SupervisorDelRegreso.VERIFICACION_MS)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura(salida = "OABT_STUCK")))

        assertEquals(Accion.ORDENAR, supervisor.empezar())

        assertEquals(0, supervisor.ordenes)
        assertFalse(supervisor.aceptado)
        assertEquals(
            "la salida del regreso anterior tampoco queda",
            "el dron no contestó la orden en 0 intentos: queda estacionario donde está, a la espera de otra orden",
            supervisor.motivoDelFallo(),
        )
    }

    /** Con el reloj de fábrica (el del sistema) la secuencia arranca igual: es el que usa el controlador real. */
    @Test
    fun conElRelojDelSistemaLaSecuenciaArrancaIgual() {
        val real = SupervisorDelRegreso()
        assertEquals(Accion.ORDENAR, real.empezar())
        assertEquals(Accion.SEGUIR, real.alContestar(true, lectura()))
        assertEquals("recién aceptada, el plazo no venció", Accion.SEGUIR, real.alLeer(lectura()))
    }

    // ---- Sin enlace ----

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

    /**
     * Antes las órdenes sin enlace se gastaban igual, y a las tres salía «no se
     * pudo volver» con el dron quizás volviendo: PatrolManager le daba un
     * estacionario en cuanto volvía la señal.
     */
    @Test
    fun sinEnlaceNuncaSaleNoSePudo() {
        supervisor.empezar()
        repeat(10) {
            assertEquals(Accion.SEGUIR, supervisor.alContestar(false, lectura(enlace = false), "aircraft not connected"))
            assertEquals(Accion.SEGUIR, supervisor.alContestar(null, lectura(arranco = null, enlace = false)))
            pasar(60_000)
            assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(arranco = null, enlace = false)))
        }
        assertEquals("sin enlace las órdenes no cuentan", 0, supervisor.ordenes)
        assertFalse(supervisor.aceptado)
    }

    /** Una respuesta sin enlace no dice nada: tampoco una aceptación cuenta ni deja el regreso por aceptado. */
    @Test
    fun unaOrdenAceptadaSinEnlaceNoCuentaNiQuedaAceptada() {
        supervisor.empezar()
        assertEquals(Accion.SEGUIR, supervisor.alContestar(true, lectura(enlace = false)))
        assertEquals(0, supervisor.ordenes)
        assertFalse(supervisor.aceptado)
    }

    /** El enlace vuelve: tres segundos desde ahí, y las órdenes siguen donde estaban. */
    @Test
    fun elEnlaceQueVuelveReanudaLasOrdenes() {
        supervisor.empezar()
        assertEquals(Accion.ORDENAR, supervisor.alContestar(false, lectura(), "go home not allowed"))
        assertEquals(Accion.ORDENAR, supervisor.alContestar(null, lectura()))
        // Se corta el enlace: la tercera no le llega al dron y no cuenta.
        assertEquals(Accion.SEGUIR, supervisor.alContestar(null, lectura(arranco = null, enlace = false)))
        assertEquals(2, supervisor.ordenes)
        pasar(30_000)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(arranco = null, enlace = false)))
        pasar(SupervisorDelRegreso.VERIFICACION_MS - 1)
        assertEquals("con el enlace de vuelta, el plazo cuenta desde ahí", Accion.SEGUIR, supervisor.alLeer(lectura()))
        pasar(1)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura()))
        assertEquals(
            "recién la tercera con enlace agota las órdenes",
            Accion.NO_SE_PUDO,
            supervisor.alContestar(false, lectura(), "go home not allowed"),
        )
        assertEquals(3, supervisor.ordenes)
    }

    /** Durante el corte el dron pudo arrancar su regreso (el de señal, o el que se pidió): al volver el enlace se ve. */
    @Test
    fun alVolverElEnlaceConElDronVolviendoArranco() {
        supervisor.empezar()
        assertEquals(Accion.SEGUIR, supervisor.alContestar(null, lectura(arranco = null, enlace = false)))
        pasar(SupervisorDelRegreso.INTERVALO_MS)
        assertEquals(Accion.ARRANCO, supervisor.alLeer(lectura(arranco = true)))
    }

    // ---- Bajando ----

    /**
     * Cerca de la base el GoHome aterriza directo: el estado queda en IDLE, el
     * modo en AUTO_LANDING. Antes se tomaba por un regreso que no arrancó, se
     * reordenaba bajando y salía «no se pudo volver» a segundos de tocar tierra.
     */
    @Test
    fun bajandoNoSeReordenaNiSeRindeYTerminaEnElSuelo() {
        aceptado()
        repeat(60) {
            pasar(SupervisorDelRegreso.INTERVALO_MS)
            assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, salida = "NOT_HOMING_IN_SHORT_DISTANCE")))
        }
        assertEquals(1, supervisor.ordenes)
        assertEquals(Accion.EN_EL_SUELO, supervisor.alLeer(lectura(bajando = true, enVuelo = false)))
    }

    /** El «ya estoy aterrizando» del SDK: rechazada con el dron bajando, se lo mira; la orden cuenta, pero no es aceptada. */
    @Test
    fun rechazadaConElDronBajandoSigueMirando() {
        supervisor.empezar()
        assertEquals(Accion.SEGUIR, supervisor.alContestar(false, lectura(bajando = true), "aircraft is landing"))
        assertEquals(1, supervisor.ordenes)
        assertFalse(supervisor.aceptado)
        pasar(SupervisorDelRegreso.VERIFICACION_MS * 10)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true)))
    }

    /**
     * Bajaba en la base y deja de bajar en el aire: es la persona del control
     * físico que empujó el acelerador (el modo pasa de AUTO_LANDING a P-GPS).
     * Antes se lo reordenaba a los 3 s, hasta tres veces, y el «no se pudo
     * volver» terminaba en un estacionario con el Virtual Stick que le sacaba el
     * dron de las manos. Ahora se lo suelta, sin una sola orden más.
     */
    @Test
    fun alDejarDeBajarEnElAireLoTomaronYNoSeReordena() {
        aceptado()
        pasar(SupervisorDelRegreso.INTERVALO_MS)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, alt = 6.0)))
        pasar(SupervisorDelRegreso.INTERVALO_MS)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, alt = 5.0)))
        pasar(SupervisorDelRegreso.INTERVALO_MS)
        assertEquals(Accion.LO_TOMARON, supervisor.alLeer(lectura(bajando = false, alt = 5.2)))
        assertEquals(1, supervisor.ordenes)
        assertEquals(
            "dejó de aterrizar en la base a 5.2 m (subió 0.2 m desde lo más bajo): lo vuela una persona con las palancas del control",
            supervisor.motivoDeLaToma(),
        )
    }

    /** A medio metro (la protección de aterrizaje) dejar de bajar es el final: se espera el suelo y nunca otra orden. */
    @Test
    fun alDejarDeBajarAMedioMetroEsElFinalYNuncaSeReordena() {
        aceptado()
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, alt = 3.0)))
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, alt = 0.5)))
        repeat(60) {
            pasar(SupervisorDelRegreso.INTERVALO_MS)
            assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = false, alt = 0.5)))
        }
        assertEquals(1, supervisor.ordenes)
        assertEquals(Accion.EN_EL_SUELO, supervisor.alLeer(lectura(bajando = false, alt = 0.0, enVuelo = false)))
    }

    /** Subirlo más de un metro y medio desde lo más bajo también es la persona, aunque no llegue a los 2 m. */
    @Test
    fun subirloMasDeUnMetroYMedioEsQueLoTomaron() {
        aceptado()
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, alt = 0.3)))
        assertEquals("subir justo 1,5 m todavía no", Accion.SEGUIR, supervisor.alLeer(lectura(bajando = false, alt = 1.8)))
        assertEquals(Accion.LO_TOMARON, supervisor.alLeer(lectura(bajando = false, alt = 1.81)))
    }

    /** El borde de la altura del final: en los 2 m justos todavía es el final; un centímetro más, lo tomaron. */
    @Test
    fun porArribaDeLaAlturaDelFinalLoTomaron() {
        val final = SupervisorDelRegreso.ALTURA_DEL_FINAL_DEL_REGRESO_M
        aceptado()
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, alt = final - 0.1)))
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = false, alt = final)))
        assertEquals(Accion.LO_TOMARON, supervisor.alLeer(lectura(bajando = false, alt = final + 0.01)))
    }

    /** Sin altura no se sabe si lo subieron: se espera, y nunca otra orden. */
    @Test
    fun yaBajoEnLaBaseYSinAlturaSeEspera() {
        aceptado()
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, alt = Double.NaN)))
        pasar(SupervisorDelRegreso.VERIFICACION_MS * 10)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = false, alt = Double.NaN)))
    }

    /** Ya bajando en la base, perder la posición (el GPS) no lo vuelve otro descenso; sin enlace, tampoco se decide nada. */
    @Test
    fun yaBajoEnLaBaseSinPosicionNiEnlaceSigueSiendoElDescenso() {
        aceptado()
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, alt = 8.0)))
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, alt = 7.0, distancia = Double.NaN)))
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = false, alt = 7.0, enlace = false)))
        assertEquals(Accion.LO_TOMARON, supervisor.alLeer(lectura(bajando = false, alt = 7.0, distancia = Double.NaN)))
    }

    /**
     * Lejos de la base bajar no es el GoHome que aterriza directo (es, por
     * ejemplo, un aterrizaje que no se pudo cortar): rigen las reglas de siempre
     * y, rechazada tres veces, no se pudo. Antes se lo miraba hasta el suelo y
     * terminaba en un ArrivedHome callado lejos de la base.
     */
    @Test
    fun bajandoLejosDeLaBaseRigenLasReglasDeSiempre() {
        val lejos = SupervisorDelRegreso.CERCA_DE_LA_BASE_M + 0.001
        supervisor.empezar()
        assertEquals(Accion.ORDENAR, supervisor.alContestar(false, lectura(bajando = true, distancia = lejos), "aircraft is landing"))
        assertEquals(Accion.ORDENAR, supervisor.alContestar(false, lectura(bajando = true, distancia = 500.0), "aircraft is landing"))
        assertEquals(Accion.NO_SE_PUDO, supervisor.alContestar(false, lectura(bajando = true, distancia = Double.NaN), "aircraft is landing"))

        val otro = SupervisorDelRegreso { ahora }
        otro.empezar()
        assertEquals(Accion.SEGUIR, otro.alContestar(true, lectura(bajando = true, distancia = 500.0)))
        pasar(SupervisorDelRegreso.VERIFICACION_MS)
        assertEquals("aceptada y bajando lejos, sin arrancar: otra orden", Accion.ORDENAR, otro.alLeer(lectura(bajando = true, distancia = 500.0)))
    }

    /** En el borde de la distancia, todavía es la base. */
    @Test
    fun bajandoEnElBordeDeLaBaseEsElDescenso() {
        aceptado()
        pasar(SupervisorDelRegreso.VERIFICACION_MS * 10)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true, distancia = SupervisorDelRegreso.CERCA_DE_LA_BASE_M)))
    }

    /** Con las órdenes agotadas y el dron bajando, tampoco: se lo mira hasta el suelo. */
    @Test
    fun conLasOrdenesAgotadasBajandoNoSeRinde() {
        supervisor.empezar()
        assertEquals(Accion.ORDENAR, supervisor.alContestar(false, lectura(), "go home not allowed"))
        assertEquals(Accion.ORDENAR, supervisor.alContestar(false, lectura(), "go home not allowed"))
        assertEquals(Accion.SEGUIR, supervisor.alContestar(false, lectura(bajando = true), "aircraft is landing"))
        assertEquals(3, supervisor.ordenes)
        pasar(60_000)
        assertEquals(Accion.SEGUIR, supervisor.alLeer(lectura(bajando = true)))
        assertEquals(Accion.EN_EL_SUELO, supervisor.alLeer(lectura(enVuelo = false)))
    }

    // ---- Por qué salió del GoHome ----

    @Test
    fun elMotivoDelFalloDiceLaUltimaSalidaDelGoHomeQueDiceAlgo() {
        aceptado()
        repeat(SupervisorDelRegreso.MAXIMO_DE_ORDENES - 1) {
            pasar(SupervisorDelRegreso.VERIFICACION_MS)
            assertEquals(Accion.ORDENAR, supervisor.alLeer(lectura(salida = "OABT_STUCK")))
            assertEquals(Accion.SEGUIR, supervisor.alContestar(true, lectura(salida = "NO_ERROR")))
        }
        pasar(SupervisorDelRegreso.VERIFICACION_MS)
        assertEquals(Accion.NO_SE_PUDO, supervisor.alLeer(lectura(salida = "UNKNOWN")))
        assertEquals(
            "el dron aceptó la orden pero el regreso no arrancó en 3 s (3 órdenes; salida del GoHome: OABT_STUCK): " +
                "queda estacionario donde está, a la espera de otra orden",
            supervisor.motivoDelFallo(),
        )
    }

    @Test
    fun laSalidaDelGoHomeVaTambienConLosRechazosYSinRespuesta() {
        supervisor.empezar()
        supervisor.alContestar(false, lectura(salida = "GPS_NO_SIGNAL"), "go home not allowed")
        assertEquals(
            "el dron no aceptó la orden en 1 intentos (go home not allowed; salida del GoHome: GPS_NO_SIGNAL): " +
                "queda estacionario donde está, a la espera de otra orden",
            supervisor.motivoDelFallo(),
        )

        val otro = SupervisorDelRegreso { ahora }
        otro.empezar()
        otro.alContestar(null, lectura(salida = "VELOCITY_STUCK"))
        assertEquals(
            "el dron no contestó la orden en 1 intentos (salida del GoHome: VELOCITY_STUCK): " +
                "queda estacionario donde está, a la espera de otra orden",
            otro.motivoDelFallo(),
        )
    }

    // ---- El estado del dron ----

    /** Una lectura que no dice si baja ni por qué salió del GoHome (un controlador que no lo lee) decide como antes. */
    @Test
    fun unaLecturaSinBajandoNiSalidaDecideComoAntes() {
        val vieja = Lectura(enVuelo = true, conEnlace = true, arranco = false)
        assertNull(vieja.bajando)
        assertNull(vieja.salida)
        aceptado()
        pasar(SupervisorDelRegreso.VERIFICACION_MS)
        assertEquals(Accion.ORDENAR, supervisor.alLeer(vieja))
    }

    /** Lo que puede decidir la secuencia, y nada más: cada una tiene su camino en el controlador. */
    @Test
    fun lasAccionesDeLaSecuencia() {
        assertEquals(
            listOf(Accion.SEGUIR, Accion.ORDENAR, Accion.ARRANCO, Accion.EN_EL_SUELO, Accion.NO_SE_PUDO, Accion.LO_TOMARON),
            Accion.entries.toList(),
        )
        assertEquals(
            listOf(SupervisorDelRegreso.FinEnElAire.EN_EL_CONTROL, SupervisorDelRegreso.FinEnElAire.FALLA),
            SupervisorDelRegreso.FinEnElAire.entries.toList(),
        )
    }

    // ---- Cómo terminó en el aire un regreso que había arrancado ----

    /** Las palancas son la persona del control físico, sea la salida nueva o la misma de antes. */
    @Test
    fun lasPalancasSonSiempreElControlFisico() {
        val control = SupervisorDelRegreso.FinEnElAire.EN_EL_CONTROL
        assertEquals(control, SupervisorDelRegreso.comoTermino("NO_ERROR", "JOYSTICK_PITCH_ADD"))
        assertEquals(control, SupervisorDelRegreso.comoTermino(null, "OYSTICK_THROTTLE_ADD"))
        assertEquals("la misma de antes, también", control, SupervisorDelRegreso.comoTermino("JOYSTICK_PITCH_ADD", "JOYSTICK_PITCH_ADD"))
    }

    /**
     * Una salida que no dice nada, o la misma que al arrancar (la de un GoHome
     * anterior, que el dron no actualizó), no prueba una falla: ante la duda el
     * dron queda en manos de quien lo vuela. Antes eso terminaba en el
     * estacionario con el Virtual Stick.
     */
    @Test
    fun sinUnaSalidaNuevaQueLoExpliqueQuedaEnElControlFisico() {
        val control = SupervisorDelRegreso.FinEnElAire.EN_EL_CONTROL
        assertEquals(control, SupervisorDelRegreso.comoTermino("OABT_STUCK", null))
        assertEquals(control, SupervisorDelRegreso.comoTermino(null, null))
        assertEquals(control, SupervisorDelRegreso.comoTermino("OABT_STUCK", "NO_ERROR"))
        assertEquals(control, SupervisorDelRegreso.comoTermino(null, "UNKNOWN"))
        assertEquals("la misma que al arrancar", control, SupervisorDelRegreso.comoTermino("OABT_STUCK", "OABT_STUCK"))
        assertEquals(control, SupervisorDelRegreso.comoTermino("GPS_NO_SIGNAL", "GPS_NO_SIGNAL"))
    }

    /** Solo una salida NUEVA, conocida y que no son las palancas es una falla del regreso. */
    @Test
    fun unaSalidaNuevaYConocidaEsUnaFalla() {
        val falla = SupervisorDelRegreso.FinEnElAire.FALLA
        assertEquals(falla, SupervisorDelRegreso.comoTermino("NO_ERROR", "OABT_STUCK"))
        assertEquals(falla, SupervisorDelRegreso.comoTermino(null, "GPS_NO_SIGNAL"))
        assertEquals("otra que la de antes", falla, SupervisorDelRegreso.comoTermino("OABT_STUCK", "VELOCITY_STUCK"))
        assertEquals(falla, SupervisorDelRegreso.comoTermino("JOYSTICK_PITCH_ADD", "NOT_HOMING_IN_SHORT_DISTANCE"))
    }

    @Test
    fun elRegresoArrancoSegunElEstadoDelRegresoOElModoDeVuelo() {
        val lejos = 500.0
        assertEquals(setOf("RETURNING_TO_HOME", "LANDING"), SupervisorDelRegreso.ESTADOS_DE_REGRESO_EN_CURSO)
        assertEquals(true, SupervisorDelRegreso.arranco("RETURNING_TO_HOME", null, lejos))
        assertEquals("volviendo no depende de dónde esté", true, SupervisorDelRegreso.arranco("RETURNING_TO_HOME", null, Double.NaN))
        assertEquals("el modo de vuelo alcanza", true, SupervisorDelRegreso.arranco("IDLE", "GO_HOME", lejos))
        assertEquals(true, SupervisorDelRegreso.arranco(null, "GO_HOME", Double.NaN))
        assertEquals(false, SupervisorDelRegreso.arranco("IDLE", "GPS_NORMAL", 0.0))
        assertEquals(false, SupervisorDelRegreso.arranco("IDLE", null, 0.0))
        assertEquals("un regreso anterior terminado no es este", false, SupervisorDelRegreso.arranco("COMPLETED", null, 0.0))
        assertEquals(false, SupervisorDelRegreso.arranco(null, "VIRTUAL_STICK", 0.0))
        assertEquals("cerca de la base el GoHome aterriza directo: no es volviendo", false, SupervisorDelRegreso.arranco("IDLE", "AUTO_LANDING", 0.0))
        assertEquals(false, SupervisorDelRegreso.arranco("UNKNOWN", "GPS_NORMAL", 0.0))
        assertNull("sin nada informado no se sabe", SupervisorDelRegreso.arranco(null, null, 0.0))
        assertNull(SupervisorDelRegreso.arranco("UNKNOWN", "UNKNOWN", 0.0))
        assertNull(SupervisorDelRegreso.arranco("UNKNOWN", null, lejos))
    }

    /** LANDING es el descenso del regreso solo cerca de la base: lejos es el de un aterrizaje (el recién cortado, por ejemplo). */
    @Test
    fun landingCuentaComoRegresoSoloCercaDeLaBase() {
        val cerca = SupervisorDelRegreso.CERCA_DE_LA_BASE_M
        assertEquals(true, SupervisorDelRegreso.arranco("LANDING", null, 0.0))
        assertEquals("en el borde, todavía cerca", true, SupervisorDelRegreso.arranco("LANDING", null, cerca))
        assertEquals(false, SupervisorDelRegreso.arranco("LANDING", null, cerca + 0.001))
        assertEquals("sin saber dónde está, no prueba nada", false, SupervisorDelRegreso.arranco("LANDING", null, Double.NaN))
        assertEquals("con el modo GO_HOME es el regreso igual", true, SupervisorDelRegreso.arranco("LANDING", "GO_HOME", 500.0))
        assertEquals(false, SupervisorDelRegreso.arranco("LANDING", "AUTO_LANDING", 500.0))
    }

    @Test
    fun unRegresoQueDejaDeVolverSeInterrumpioEnElAireSoloArribaYSinAterrizar() {
        val arriba = 40.0
        val final = SupervisorDelRegreso.ALTURA_DEL_FINAL_DEL_REGRESO_M
        assertTrue(SupervisorDelRegreso.seInterrumpioEnElAire("GPS_NORMAL", false, arriba))
        assertTrue(SupervisorDelRegreso.seInterrumpioEnElAire("GPS_NORMAL", null, arriba))
        assertTrue("con las palancas en ATTI también", SupervisorDelRegreso.seInterrumpioEnElAire("ATTI", null, arriba))
        assertFalse("en GO_HOME es el estado que se atrasó", SupervisorDelRegreso.seInterrumpioEnElAire("GO_HOME", false, arriba))
        assertFalse("aterrizando es el final del regreso", SupervisorDelRegreso.seInterrumpioEnElAire("AUTO_LANDING", null, arriba))
        assertFalse(SupervisorDelRegreso.seInterrumpioEnElAire("GPS_NORMAL", true, arriba))
        assertFalse("en el borde de la altura del final, todavía es el final", SupervisorDelRegreso.seInterrumpioEnElAire("GPS_NORMAL", false, final))
        assertTrue(SupervisorDelRegreso.seInterrumpioEnElAire("GPS_NORMAL", false, final + 0.01))
        assertFalse("sin altura no se sabe", SupervisorDelRegreso.seInterrumpioEnElAire("GPS_NORMAL", false, Double.NaN))
        assertFalse("sin modo (el enlace que se corta) no se sabe", SupervisorDelRegreso.seInterrumpioEnElAire(null, false, arriba))
        assertFalse(SupervisorDelRegreso.seInterrumpioEnElAire("UNKNOWN", false, arriba))
    }

    /** Los `GoHomeExitCode` del MSDK 5.18 (javap): solo los dos de las palancas son una persona volándolo. */
    @Test
    fun lasSalidasPorLasPalancasDelMsdk() {
        assertTrue(SupervisorDelRegreso.esSalidaPorLasPalancas("JOYSTICK_PITCH_ADD"))
        assertTrue("así, sin la J, en el MSDK 5.18", SupervisorDelRegreso.esSalidaPorLasPalancas("OYSTICK_THROTTLE_ADD"))
        listOf(
            "OABT_INIT_FAIL", "OABT_STUCK", "VELOCITY_STUCK", "SHORT_DISTANCE_OA", "GPS_NO_SIGNAL", "GPS_VIO_NO_OUTPUT",
            "GPS_VIO_POS_ERROR", "BACKTRACK_IN_SHORT_DISTANCE", "NOT_HOMING_IN_SHORT_DISTANCE", "NO_ERROR", "UNKNOWN",
        ).forEach { assertFalse(it, SupervisorDelRegreso.esSalidaPorLasPalancas(it)) }
        assertFalse(SupervisorDelRegreso.esSalidaPorLasPalancas(null))
    }

    @Test
    fun unaSalidaInformadaDiceAlgo() {
        assertTrue(SupervisorDelRegreso.salidaInformada("OABT_STUCK"))
        assertTrue(SupervisorDelRegreso.salidaInformada("JOYSTICK_PITCH_ADD"))
        assertFalse(SupervisorDelRegreso.salidaInformada("NO_ERROR"))
        assertFalse(SupervisorDelRegreso.salidaInformada("UNKNOWN"))
        assertFalse(SupervisorDelRegreso.salidaInformada(null))
    }

    /** Recién cortado un aterrizaje, solo una lectura que lo diga deja mirar si el dron vuelve. */
    @Test
    fun sinElAterrizajeHaceFaltaUnaLecturaQueLoDiga() {
        assertTrue(SupervisorDelRegreso.sinElAterrizaje("IDLE", "GPS_NORMAL", false))
        assertTrue(SupervisorDelRegreso.sinElAterrizaje("IDLE", "GPS_NORMAL", null))
        assertTrue("KeyIsInLandingMode alcanza sin el modo", SupervisorDelRegreso.sinElAterrizaje(null, null, false))
        assertTrue("volviendo ya no aterriza", SupervisorDelRegreso.sinElAterrizaje("RETURNING_TO_HOME", "GO_HOME", false))
        assertFalse("el LANDING del estado", SupervisorDelRegreso.sinElAterrizaje("LANDING", "GPS_NORMAL", false))
        assertFalse(SupervisorDelRegreso.sinElAterrizaje("IDLE", "AUTO_LANDING", null))
        assertFalse(SupervisorDelRegreso.sinElAterrizaje("IDLE", "GPS_NORMAL", true))
        assertFalse("sin nada informado no se sabe", SupervisorDelRegreso.sinElAterrizaje("IDLE", null, null))
        assertFalse(SupervisorDelRegreso.sinElAterrizaje(null, "UNKNOWN", null))
    }
}
