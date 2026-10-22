package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.RastreadorDeObjetivo
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Waypoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Los bordes del seguimiento de un objetivo: perderlo de vista MIENTRAS se lo
 * sigue, soltar el control con el objetivo caminando o ya perdido, qué
 * detecciones lo reenganchan, y las decisiones y acuses que llegan cuando no
 * corresponden (sin objetivo, reenviados sin id, con el control tomado o con
 * una decisión que no es ninguna de las dos).
 *
 * Los tiempos del seguimiento corren con el reloj falso de la patrulla, que el
 * test adelanta. Usa Robolectric porque el reparto de cuadros codifica en
 * Base64 (android.util) y el Comando Central espía arma el JSON con org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerSeguimientoBordesTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
        const val ALERTA = 7L
        const val PERDIDO_MS = RastreadorDeObjetivo.SIN_VER_PARA_PERDIDO_MS + 1_000
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = ComandoCentralEspia(alcance)
    private val deteccion = DetectionClient(alcance)
    private val reloj = RelojFalso()
    private val patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST", reloj::ahora)
    private val ruta = PatrolRoute(
        1,
        "Manzana",
        listOf(Waypoint(LAT + 0.002, LON, ALT), Waypoint(LAT, LON + 0.002, ALT), Waypoint(LAT - 0.002, LON, ALT)),
    )

    private val personaEnElCentro = Deteccion(
        clases = listOf("PERSON"),
        confianza = 0.9,
        cajas = listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)),
        snapshotBase64 = "/9j/captura",
        ts = 1L,
    )

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private fun mensaje(json: String) = comandoCentral.manejarMensaje(json)

    private suspend fun esperarEstado(estado: PatrolState) {
        withTimeout(5_000) { patrulla.state.first { it == estado } }
    }

    private suspend fun telemetria(lon: Double = LON, gimbal: Double = -70.0) {
        dron.emitirTelemetria(LAT, lon, alt = ALT, rumbo = 90.0, gimbal = gimbal)
        delay(60)
    }

    private suspend fun detectar(d: Deteccion = personaEnElCentro) {
        deteccion.onDetection?.invoke(d)
        delay(60)
    }

    /** Patrullando, con una alerta confirmada, orbitando y con el id de la alerta ya acusado. */
    private suspend fun orbitandoUnaPersona() {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        esperarEstado(PatrolState.PATROLLING)
        detectar()
        detectar()
        esperarEstado(PatrolState.ORBITING)
        acusarLaAlerta()
    }

    private suspend fun acusarLaAlerta() {
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        val ref = comandoCentral.alertas.single().getString("ref")
        mensaje("""{"type":"alert_ack","ref":"$ref","alertId":$ALERTA}""")
        esperarA("el acuse de la alerta") { patrulla.objetivo?.alertId == ALERTA }
    }

    /**
     * La persona camina hacia el este a 16 m/s: el dron la ve siempre en el
     * centro del cuadro mientras se corre 8 m por cada detección (una cada
     * 500 ms del reloj de la patrulla), hasta que el seguimiento pasa a seguirla.
     */
    private suspend fun siguiendoAUnaPersonaQueCamina() {
        var lon = LON
        repeat(6) {
            lon += 8.0 / Geo.metrosPorGradoLon(LAT)
            telemetria(lon = lon)
            reloj.adelantar(500)
            detectar()
        }
        esperarEstado(PatrolState.FOLLOWING)
    }

    private suspend fun tomarElControl() {
        mensaje("""{"type":"control_taken","by":"op"}""")
        esperarEstado(PatrolState.MANUAL)
    }

    // ---- Perderlo de vista y volver a verlo ----

    /**
     * Si se lo deja de ver MIENTRAS se lo sigue, el dron deja de perseguir una
     * estimación que ya no se corrige y orbita la última posición conocida. El
     * aviso sale una sola vez, aunque el seguimiento lo siga dando por perdido
     * en cada vuelta.
     */
    @Test
    fun siSeLoPierdeSiguiendoloOrbitaSuUltimaPosicionYAvisaUnaSolaVez() = runBlocking {
        orbitandoUnaPersona()
        siguiendoAUnaPersonaQueCamina()
        val orbitasAntes = dron.ordenes.count { it == "startOrbit" }

        reloj.adelantar(PERDIDO_MS)
        esperarA("TARGET_LOST") { comandoCentral.eventos("TARGET_LOST").isNotEmpty() }
        esperarEstado(PatrolState.ORBITING)
        esperarA("la órbita en la última posición") { dron.ordenes.count { it == "startOrbit" } > orbitasAntes }

        delay(1_200) // más de dos vueltas del seguimiento con el objetivo todavía perdido
        assertEquals(1, comandoCentral.eventos("TARGET_LOST").size)
        assertTrue(patrulla.objetivo!!.perdido)
    }

    /**
     * Solo lo reengancha una detección de SU clase que se pueda ubicar en el
     * terreno: un vehículo en el mismo lugar no es la persona, y una persona
     * vista con la cámara al horizonte no se sabe dónde está.
     */
    @Test
    fun soloLoReenganchaUnaDeteccionDeSuClaseYUbicable() = runBlocking {
        orbitandoUnaPersona()
        reloj.adelantar(PERDIDO_MS)
        esperarA("TARGET_LOST") { comandoCentral.eventos("TARGET_LOST").isNotEmpty() }

        detectar(Deteccion(listOf("VEHICLE"), 0.9, listOf(Caja("VEHICLE", 0.9, 0.5, 0.5, 0.1, 0.1)), null, 2L))
        telemetria(gimbal = 0.0)
        detectar()
        delay(200)
        assertTrue(comandoCentral.eventos("TARGET_REACQUIRED").isEmpty())
        assertTrue(patrulla.objetivo!!.perdido)

        telemetria()
        detectar()
        esperarA("TARGET_REACQUIRED") { comandoCentral.eventos("TARGET_REACQUIRED").isNotEmpty() }
        assertFalse(patrulla.objetivo!!.perdido)
    }

    // ---- Soltar el control con un objetivo en curso ----

    /** Soltar el control con el objetivo caminando: el dron vuelve a seguirlo, no a orbitar donde estaba. */
    @Test
    fun alSoltarElControlConElObjetivoEnMovimientoLoVuelveASeguir() = runBlocking {
        orbitandoUnaPersona()
        siguiendoAUnaPersonaQueCamina()
        tomarElControl()
        val desde = dron.ordenes.size

        mensaje("""{"type":"control_released","by":"op"}""")
        esperarEstado(PatrolState.FOLLOWING)
        esperarA("TRACKING_RESUMED") { comandoCentral.eventos("TRACKING_RESUMED").isNotEmpty() }

        val despues = dron.ordenes.drop(desde)
        assertTrue("no se le ordenó seguirlo: $despues", despues.contains("seguirObjetivo"))
        assertTrue("se le ordenó orbitar un objetivo que camina: $despues", despues.none { it == "startOrbit" })
        assertEquals(ALERTA, comandoCentral.eventos("TRACKING_RESUMED").single().getLong("alertId"))
    }

    /**
     * Si mientras el operador volaba el objetivo se perdió de vista, al soltar
     * el control no se persigue una velocidad vieja: se orbita la última
     * posición conocida. Mientras el control estuvo tomado no se avisó nada: el
     * dron era del operador.
     */
    @Test
    fun alSoltarElControlConElObjetivoPerdidoOrbitaDondeSeLoVio() = runBlocking {
        orbitandoUnaPersona()
        siguiendoAUnaPersonaQueCamina()
        tomarElControl()
        reloj.adelantar(PERDIDO_MS)
        delay(700) // una vuelta del seguimiento con el control tomado
        assertTrue(comandoCentral.eventos("TARGET_LOST").isEmpty())
        val desde = dron.ordenes.size

        mensaje("""{"type":"control_released","by":"op"}""")
        esperarEstado(PatrolState.ORBITING)
        esperarA("TRACKING_RESUMED") { comandoCentral.eventos("TRACKING_RESUMED").isNotEmpty() }

        val despues = dron.ordenes.drop(desde)
        assertTrue("no se le ordenó orbitar: $despues", despues.contains("startOrbit"))
        assertTrue("persiguió a un objetivo perdido: $despues", despues.none { it == "seguirObjetivo" })
    }

    // ---- Acuses y decisiones fuera de lugar ----

    /** Un acuse o una decisión sin objetivo en curso no cambian nada (y la decisión queda anotada). */
    @Test
    fun unAcuseOUnaDecisionSinObjetivoNoCambianNada() = runBlocking {
        patrulla.start()
        telemetria()

        mensaje("""{"type":"alert_ack","ref":"de-otro-vuelo","alertId":5}""")
        mensaje("""{"type":"alert_decision","alertId":5,"decision":"DISMISSED","decidedBy":"op"}""")
        withTimeout(5_000) { patrulla.localLog.first { it.contains("no está siguiendo ningún objetivo") } }
        delay(100)

        assertTrue(patrulla.localLog.replayCache.none { it.contains("quedó registrada") })
        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertTrue("se le ordenó algo al dron: ${dron.ordenes}", dron.ordenes.isEmpty())
    }

    /**
     * Un reenvío del hub que no dice de qué alerta es no se puede atar al
     * objetivo en curso: podría ser de una alerta vieja, y no se aplica.
     */
    @Test
    fun unaDecisionReenviadaSinIdNoSeAplica() = runBlocking {
        orbitandoUnaPersona()

        mensaje("""{"type":"alert_decision","decision":"DISMISSED","decidedBy":"op","resent":true}""")
        withTimeout(5_000) { patrulla.localLog.first { it.contains("Decisión reenviada") } }

        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertNotNull(patrulla.objetivo)
    }

    /**
     * Descartada la alerta con el control tomado, el seguimiento termina (y la
     * zona queda descartada) pero el dron sigue siendo del operador: no se lo
     * manda a retomar la ruta.
     */
    @Test
    fun descartarConElControlTomadoTerminaElSeguimientoSinSacarleElDron() = runBlocking {
        orbitandoUnaPersona()
        tomarElControl()
        val desde = dron.ordenes.size

        mensaje("""{"type":"alert_decision","alertId":$ALERTA,"decision":"DISMISSED","decidedBy":"op"}""")
        esperarA("el fin del seguimiento") { comandoCentral.eventos("TRACKING_ENDED").isNotEmpty() }
        delay(200)

        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertNull(patrulla.objetivo)
        assertTrue("se le sacó el dron al operador: ${dron.ordenes.drop(desde)}", dron.ordenes.drop(desde).isEmpty())
    }

    /** Una decisión que no es ni descartar ni validar no toca al objetivo. */
    @Test
    fun unaDecisionDesconocidaNoCambiaNada() = runBlocking {
        orbitandoUnaPersona()

        mensaje("""{"type":"alert_decision","alertId":$ALERTA,"decision":"ESCALATED","decidedBy":"op"}""")
        delay(300)

        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertEquals("PENDING", patrulla.objetivo?.decision)
        assertTrue(comandoCentral.eventos("TRACKING_ENDED").isEmpty())
    }

    /**
     * Una detección con el patrullaje en pausa también arranca el seguimiento,
     * y descartarla retoma la ruta hacia el nodo que tenía por delante cuando se
     * la detuvo: el seguimiento no le pisa ese nodo.
     */
    @Test
    fun conElPatrullajeEnPausaUnaDeteccionSeSigueYDescartarlaRetomaLaRuta() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        dron.flightEvents.emit(FlightEvent.WaypointReached(0))
        delay(100)
        patrulla.detenerPatrullaje()

        detectar()
        detectar()
        esperarEstado(PatrolState.ORBITING)
        acusarLaAlerta()

        mensaje("""{"type":"alert_decision","alertId":$ALERTA,"decision":"DISMISSED","decidedBy":"op"}""")
        esperarEstado(PatrolState.PATROLLING)
        esperarA("la ruta hacia el segundo nodo") { dron.ultimaOrden == "startRoute(1, 1)" }
    }
}
