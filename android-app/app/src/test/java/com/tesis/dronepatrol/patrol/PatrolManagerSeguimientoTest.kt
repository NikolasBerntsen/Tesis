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
 * El seguimiento del objetivo de una alerta (docs/PROTOCOLS.md §4, "Qué hace la
 * app con una detección"): la decisión atada a SU alerta, el descarte que
 * retoma la ruta hacia el próximo nodo y marca la zona, la validación que deja
 * al dron sobre el objetivo aunque el operador tome y suelte el control, el
 * paso a seguir al objetivo cuando se mueve y a orbitarlo cuando se detiene, y
 * el aviso con la última posición cuando se lo pierde de vista.
 *
 * Los tiempos del seguimiento ("hace 10 s que no se lo ve") corren con un reloj
 * falso que el test adelanta: dormir el test para eso sería lento y frágil.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerSeguimientoTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
        const val ALERTA = 7L
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

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private val personaEnElCentro = Deteccion(
        clases = listOf("PERSON"),
        confianza = 0.9,
        cajas = listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)),
        snapshotBase64 = "/9j/captura",
        ts = 1L,
    )

    private suspend fun telemetria(lat: Double = LAT, lon: Double = LON) {
        dron.emitirTelemetria(lat, lon, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        delay(60)
    }

    private suspend fun detectar(d: Deteccion = personaEnElCentro) {
        deteccion.onDetection?.invoke(d)
        delay(60)
    }

    private fun mensaje(json: String) = comandoCentral.manejarMensaje(json)

    /** Patrullando, con una alerta confirmada, orbitando y con el id de la alerta ya acusado. */
    private suspend fun orbitandoUnaPersona() {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        detectar()
        detectar()
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        val ref = comandoCentral.alertas.single().getString("ref")
        mensaje("""{"type":"alert_ack","ref":"$ref","alertId":$ALERTA}""")
        esperarA("el acuse de la alerta") { patrulla.objetivo?.alertId == ALERTA }
    }

    @Test
    fun elAcuseAsociaLaAlertaAlObjetivoYElStatusLoLleva() = runBlocking {
        orbitandoUnaPersona()

        val objetivo = patrulla.objetivo!!
        assertEquals("PERSON", objetivo.tipo)
        assertEquals("PENDING", objetivo.decision)
        assertFalse(objetivo.enMovimiento)
        assertFalse(objetivo.perdido)
        assertEquals(dron.ultimaOrbita!!.first, objetivo.lat, 1e-9)
        assertEquals(dron.ultimaOrbita!!.second, objetivo.lon, 1e-9)
    }

    /** Un acuse con otro ref (de una alerta vieja) no se mezcla con el objetivo en curso. */
    @Test
    fun unAcuseDeOtraAlertaNoSeAsocia() = runBlocking {
        orbitandoUnaPersona()
        mensaje("""{"type":"alert_ack","ref":"otra-cosa","alertId":99}""")
        delay(200)
        assertEquals(ALERTA, patrulla.objetivo?.alertId)
    }

    @Test
    fun alDescartarRetomaLaRutaHaciaElProximoNodoYNoHaciaAtras() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        // Pasó por el primer nodo: el que tiene por delante es el segundo (índice 1)
        dron.flightEvents.emit(FlightEvent.WaypointReached(0))
        delay(100)
        detectar()
        detectar()
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }

        mensaje("""{"type":"alert_decision","alertId":$ALERTA,"decision":"DISMISSED","decidedBy":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        esperarA("la ruta retomada") { dron.ultimaOrden == "startRoute(1, 1)" }
        esperarA("el fin del seguimiento") { comandoCentral.eventos("TRACKING_ENDED").isNotEmpty() }
        assertNull(patrulla.objetivo)
    }

    @Test
    fun descartadoEnElUltimoNodoRetomaDesdeElPrimero() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        dron.flightEvents.emit(FlightEvent.WaypointReached(2))
        delay(100)
        detectar()
        detectar()
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }

        mensaje("""{"type":"alert_decision","decision":"DISMISSED","decidedBy":"op"}""")
        esperarA("la ruta retomada") { dron.ultimaOrden == "startRoute(1, 0)" }
    }

    /** Lo descartado no vuelve a alertar al pasar de nuevo por ahí; otra cosa en otro lado, sí. */
    @Test
    fun laZonaDescartadaNoVuelveAAlertar() = runBlocking {
        orbitandoUnaPersona()
        mensaje("""{"type":"alert_decision","alertId":$ALERTA,"decision":"DISMISSED","decidedBy":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }

        // Pasado el silencio posterior al descarte, el mismo lugar no alerta
        reloj.adelantar(PatrolManager.SILENCIO_TRAS_DESCARTE_MS + 1_000)
        detectar()
        detectar()
        delay(300)
        assertEquals(1, comandoCentral.alertas.size)
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)

        // 300 m al norte es otra cosa: alerta
        telemetria(lat = LAT + 300.0 / Geo.METROS_POR_GRADO_LAT)
        detectar()
        detectar()
        esperarA("la alerta nueva") { comandoCentral.alertas.size == 2 }
    }

    /** Recién descartado, ni siquiera en otro lado se alerta durante unos segundos. */
    @Test
    fun trasElDescarteHayUnSilencio() = runBlocking {
        orbitandoUnaPersona()
        mensaje("""{"type":"alert_decision","alertId":$ALERTA,"decision":"DISMISSED","decidedBy":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }

        telemetria(lat = LAT + 300.0 / Geo.METROS_POR_GRADO_LAT)
        detectar()
        detectar()
        delay(300)
        assertEquals(1, comandoCentral.alertas.size)
    }

    /** La decisión sobre una alerta vieja no hace abandonar el objetivo nuevo. */
    @Test
    fun laDecisionDeOtraAlertaNoTocaElObjetivo() = runBlocking {
        orbitandoUnaPersona()
        mensaje("""{"type":"alert_decision","alertId":3,"decision":"DISMISSED","decidedBy":"op"}""")
        delay(300)
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertNotNull(patrulla.objetivo)
    }

    /**
     * Al reconectarse, el hub reenvía las decisiones de los últimos minutos. Si
     * la app todavía espera el acuse de su alerta nueva, un "descartado" viejo
     * reenviado NO puede aplicarse al objetivo nuevo: los reenvíos solo valen
     * para la alerta exacta.
     */
    @Test
    fun unaDecisionReenviadaSoloValeParaLaAlertaExacta() = runBlocking<Unit> {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        detectar()
        detectar()
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }
        // Sin acuse todavía: llega un reenvío de una alerta vieja
        mensaje("""{"type":"alert_decision","alertId":3,"decision":"DISMISSED","decidedBy":"op","resent":true}""")
        delay(300)
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertNotNull(patrulla.objetivo)

        // Ya con el acuse, el reenvío de SU alerta sí se aplica
        val ref = comandoCentral.alertas.single().getString("ref")
        mensaje("""{"type":"alert_ack","ref":"$ref","alertId":$ALERTA}""")
        esperarA("el acuse") { patrulla.objetivo?.alertId == ALERTA }
        mensaje("""{"type":"alert_decision","alertId":$ALERTA,"decision":"DISMISSED","decidedBy":"op","resent":true}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
    }

    @Test
    fun validadaYConControlManualAlSoltarVuelveAlObjetivo() = runBlocking {
        orbitandoUnaPersona()
        val centro = dron.ultimaOrbita!!
        mensaje("""{"type":"alert_decision","alertId":$ALERTA,"decision":"VALIDATED","decidedBy":"op"}""")
        esperarA("la validación") { patrulla.objetivo?.decision == "VALIDATED" }

        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
        dron.ultimaOrbita = null
        mensaje("""{"type":"control_released","by":"op"}""")

        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }
        esperarA("la órbita retomada") { dron.ultimaOrbita != null }
        assertEquals(centro.first, dron.ultimaOrbita!!.first, 1e-6)
        assertEquals(centro.second, dron.ultimaOrbita!!.second, 1e-6)
        esperarA("TRACKING_RESUMED") { comandoCentral.eventos("TRACKING_RESUMED").isNotEmpty() }
        assertEquals(ALERTA, comandoCentral.eventos("TRACKING_RESUMED").single().getLong("alertId"))
    }

    /** "Reanudar patrullaje" con un objetivo validado termina el seguimiento. */
    @Test
    fun reanudarElPatrullajeTerminaElSeguimiento() = runBlocking {
        orbitandoUnaPersona()
        mensaje("""{"type":"alert_decision","alertId":$ALERTA,"decision":"VALIDATED","decidedBy":"op"}""")
        esperarA("la validación") { patrulla.objetivo?.decision == "VALIDATED" }

        mensaje("""{"type":"resume_patrol","orderedBy":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        esperarA("el fin del seguimiento") { comandoCentral.eventos("TRACKING_ENDED").isNotEmpty() }
        assertNull(patrulla.objetivo)
    }

    @Test
    fun siElObjetivoSeMueveLoSigueYAlDetenerseVuelveAOrbitarlo() = runBlocking {
        orbitandoUnaPersona()

        // El dron lo ve siempre en el centro del cuadro mientras se corre 8 m al
        // este por cada detección (cada 500 ms): el objetivo va a 16 m/s.
        var lon = LON
        repeat(6) {
            lon += 8.0 / Geo.metrosPorGradoLon(LAT)
            telemetria(lon = lon)
            reloj.adelantar(500)
            detectar()
        }
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.FOLLOWING } }
        esperarA("la orden de seguirlo") { dron.ultimoSeguimiento != null }
        esperarA("TARGET_MOVING") { comandoCentral.eventos("TARGET_MOVING").isNotEmpty() }
        val aviso = comandoCentral.eventos("TARGET_MOVING").single()
        assertEquals(ALERTA, aviso.getLong("alertId"))
        assertTrue("el aviso lleva la posición del objetivo", aviso.has("lat") && aviso.has("lon"))
        assertTrue(patrulla.objetivo!!.enMovimiento)

        // Se detiene: el dron se queda quieto y lo sigue viendo en el mismo lugar
        var vueltas = 0
        while (patrulla.state.value != PatrolState.ORBITING && vueltas < 60) {
            telemetria(lon = lon)
            reloj.adelantar(500)
            detectar()
            vueltas++
        }
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        esperarA("TARGET_STOPPED") { comandoCentral.eventos("TARGET_STOPPED").isNotEmpty() }
        assertFalse(patrulla.objetivo!!.enMovimiento)
    }

    @Test
    fun siDejaDeVerseloAvisaConLaUltimaPosicionYOrbitaAhi() = runBlocking {
        orbitandoUnaPersona()
        val ultima = patrulla.objetivo!!

        reloj.adelantar(RastreadorDeObjetivo.SIN_VER_PARA_PERDIDO_MS + 1_000)
        esperarA("TARGET_LOST", topeMs = 5_000) { comandoCentral.eventos("TARGET_LOST").isNotEmpty() }
        val aviso = comandoCentral.eventos("TARGET_LOST").single()
        assertEquals(ultima.lat, aviso.getDouble("lat"), 1e-6)
        assertEquals(ultima.lon, aviso.getDouble("lon"), 1e-6)
        assertEquals(ALERTA, aviso.getLong("alertId"))
        assertTrue(patrulla.objetivo!!.perdido)
        assertEquals(PatrolState.ORBITING, patrulla.state.value)

        // Se vuelve a ver cerca: lo retoma
        detectar()
        esperarA("TARGET_REACQUIRED") { comandoCentral.eventos("TARGET_REACQUIRED").isNotEmpty() }
        assertFalse(patrulla.objetivo!!.perdido)
    }

    /** Con el control tomado el operador vuela, y la app no pierde al objetivo. */
    @Test
    fun enManualElObjetivoSeSigueEstimandoSinMoverAlDron() = runBlocking {
        orbitandoUnaPersona()
        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
        val ordenesAntes = dron.ordenes.size

        reloj.adelantar(500)
        detectar()
        delay(200)
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertTrue(
            "en MANUAL no se ordena ni órbita ni seguimiento",
            dron.ordenes.drop(ordenesAntes).none { it == "startOrbit" || it == "seguirObjetivo" },
        )
        assertNotNull(patrulla.objetivo)
    }

    /** En control manual, una detección arranca el seguimiento sin sacarle el dron al operador. */
    @Test
    fun enManualUnaDeteccionAlertaYAlSoltarElDronVaAlObjetivo() = runBlocking {
        patrulla.start()
        telemetria()
        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }

        detectar()
        detectar()
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        esperarA("TARGET_DETECTED") { comandoCentral.eventos("TARGET_DETECTED").isNotEmpty() }
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertNull("el dron sigue siendo del operador", dron.ultimaOrbita)
        assertNotNull(patrulla.objetivo)

        mensaje("""{"type":"control_released","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }
        esperarA("la órbita sobre el objetivo") { dron.ultimaOrbita != null }
    }

    // ---- Despegue y aterrizaje desde la consola ----

    private suspend fun enElSueloConElControlTomado() {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetria()
        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
    }

    @Test
    fun conElControlTomadoLaConsolaDespegaEnElLugar() = runBlocking {
        enElSueloConElControlTomado()
        mensaje("""{"type":"takeoff","by":"op"}""")
        esperarA("el despegue") { dron.ordenes.contains("despegarEnElLugar") }
        esperarA("TAKEOFF") { comandoCentral.eventos("TAKEOFF").isNotEmpty() }
    }

    @Test
    fun sinElControlTomadoNoSeDespega() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetria()
        mensaje("""{"type":"takeoff","by":"op"}""")
        delay(300)
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    @Test
    fun enElSueloElMandoNoLlegaAlDron() = runBlocking {
        enElSueloConElControlTomado()
        mensaje("""{"type":"manual_stick","pitch":0.0,"roll":0.0,"yaw":0.8,"throttle":0.0,"by":"op"}""")
        delay(200)
        assertTrue(dron.ordenes.none { it.startsWith("stick(") })
    }

    @Test
    fun alAterrizarConElControlTomadoSigueEnManual() = runBlocking {
        patrulla.start()
        telemetria()
        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }

        mensaje("""{"type":"land","by":"op"}""")
        esperarA("el aterrizaje") { dron.ordenes.contains("land") }
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.Aterrizado)
        esperarA("LANDED") { comandoCentral.eventos("LANDED").isNotEmpty() }
        assertEquals(PatrolState.MANUAL, patrulla.state.value)

        // Y puede volver a despegar sin soltar el control
        mensaje("""{"type":"takeoff","by":"op"}""")
        esperarA("el segundo despegue") { dron.ordenes.contains("despegarEnElLugar") }
    }
}
