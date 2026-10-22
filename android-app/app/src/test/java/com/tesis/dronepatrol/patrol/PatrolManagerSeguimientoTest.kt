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

    // ---- Despegue en el lugar desde la propia app ----

    @Test
    fun desdeLaAppDespegaEnElLugarYQuedaRegistrado() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetria()
        patrulla.despegarAqui()
        esperarA("el despegue") { dron.ordenes.contains("despegarEnElLugar") }
        esperarA("TAKEOFF") { comandoCentral.eventos("TAKEOFF").isNotEmpty() }
        assertTrue(comandoCentral.eventos("TAKEOFF").single().getString("message").contains("operador de campo"))
        // El evento de vuelo del despegue no lo vuelve a registrar como "automático"
        dron.flightEvents.emit(FlightEvent.Despegando)
        delay(200)
        assertEquals(1, comandoCentral.eventos("TAKEOFF").size)
    }

    @Test
    fun desdeLaAppEnElAireODesenlazadoNoDespega() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.despegarAqui() // el espía arranca en el aire
        delay(200)
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))

        dron.estado.value = dron.estado.value.copy(enVuelo = false, conectado = false, detalle = "sin enlace")
        patrulla.despegarAqui()
        esperarA("el aviso") { comandoCentral.eventos("DRONE_PROBLEM").isNotEmpty() }
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    // ---- Batería baja con el dron en el suelo ----

    private suspend fun telemetriaConBateria(pct: Double) {
        dron.emitirTelemetria(LAT, LON, bateria = pct, alt = 0.0, rumbo = 90.0, gimbal = -70.0)
        delay(100)
    }

    /**
     * Lo que pasó en la prueba en interior: aterrizado con el control tomado, la
     * batería bajó del 25 % y el estado quedaba clavado en "volviendo a base",
     * de donde la consola ya no podía despegarlo. En el suelo no hay regreso.
     */
    @Test
    fun enElSueloLaBateriaBajaNoDisparaElRegresoNiTrabaElEstado() = runBlocking {
        enElSueloConElControlTomado()
        telemetriaConBateria(20.0)
        delay(200)
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertTrue(comandoCentral.eventos("RTH_LOW_BATTERY").isEmpty())
        assertFalse(dron.ordenes.contains("returnHome"))
    }

    /** Con la batería al 25 % o menos no se despega, y la consola se entera del motivo. */
    @Test
    fun conLaBateriaBajaNoSeDespegaYSeAvisa() = runBlocking {
        enElSueloConElControlTomado()
        telemetriaConBateria(22.0)
        mensaje("""{"type":"takeoff","by":"op"}""")
        esperarA("el aviso") { comandoCentral.eventos("DRONE_PROBLEM").isNotEmpty() }
        assertTrue(comandoCentral.eventos("DRONE_PROBLEM").single().getString("message").contains("22%"))
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))

        patrulla.despegarAqui()
        delay(200)
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /** Comenzar la ruta desde el suelo también es despegar: con la batería baja, no. */
    @Test
    fun conLaBateriaBajaNoSeArrancaLaRutaDesdeElSuelo() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetriaConBateria(22.0)
        patrulla.startPatrol(ruta)
        esperarA("el aviso") { comandoCentral.eventos("DRONE_PROBLEM").isNotEmpty() }
        assertTrue(comandoCentral.eventos("DRONE_PROBLEM").single().getString("message").contains("22%"))
        assertTrue(dron.ordenes.none { it.startsWith("startRoute") })
        assertEquals(PatrolState.IDLE, patrulla.state.value)
    }

    /**
     * Después de un despegue en el lugar, el próximo despegue (el de una ruta)
     * vuelve a registrarse como automático: la marca del despegue en el lugar
     * se gasta al llegar al aire.
     */
    @Test
    fun laMarcaDelDespegueEnElLugarSeGastaAlLlegarAlAire() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetria()
        patrulla.despegarAqui()
        esperarA("TAKEOFF") { comandoCentral.eventos("TAKEOFF").isNotEmpty() }
        dron.flightEvents.emit(FlightEvent.Despegando)
        dron.flightEvents.emit(FlightEvent.EnElAire)
        delay(200)
        assertEquals(1, comandoCentral.eventos("TAKEOFF").size)

        dron.flightEvents.emit(FlightEvent.Despegando)
        esperarA("el despegue automático") { comandoCentral.eventos("TAKEOFF").size == 2 }
        assertTrue(comandoCentral.eventos("TAKEOFF").last().getString("message").contains("automático"))
    }

    /**
     * Si aterriza en medio de la ruta sin que nadie lo haya ordenado (las
     * palancas del control, o el propio dron), la patrulla vuelve a IDLE y no
     * queda en un estado de vuelo con el dron en el suelo.
     */
    @Test
    fun aterrizarEnMedioDeLaRutaDejaLaPatrullaEnReposo() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.Aterrizado)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.IDLE } }
        esperarA("LANDED") { comandoCentral.eventos("LANDED").isNotEmpty() }
        assertEquals("Dron aterrizado", comandoCentral.eventos("LANDED").single().getString("message"))
    }

    /** Con la batería bien, la ruta desde el suelo arranca: el despegue lo hace el controlador. */
    @Test
    fun conLaBateriaBienLaRutaArrancaDesdeElSuelo() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetriaConBateria(80.0)
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        esperarA("la ruta") { dron.ordenes.contains("startRoute(1, 0)") }
        assertTrue(comandoCentral.eventos("DRONE_PROBLEM").isEmpty())
    }

    /** Sin enlace y sin que el controlador diga por qué, el aviso igual dice qué falta. */
    @Test
    fun desdeLaAppSinEnlaceYSinDetalleDiceQueFalta() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false, conectado = false, detalle = "")
        patrulla.start()
        patrulla.despegarAqui()
        esperarA("el aviso") { comandoCentral.eventos("DRONE_PROBLEM").isNotEmpty() }
        assertTrue(comandoCentral.eventos("DRONE_PROBLEM").single().getString("message").contains("sin enlace con la aeronave"))
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /**
     * En interior no hay GPS: el despegue en el lugar igual sale, y el registro
     * dice que el dron se sostiene con los sensores de visión. Vale tanto sin
     * telemetría todavía (sin dato de batería no se frena: decide el dron) como
     * con telemetría sin posición.
     */
    @Test
    fun desdeLaAppSinTelemetriaDespegaYAvisaQueNoHayGps() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        patrulla.despegarAqui()
        esperarA("el despegue") { dron.ordenes.contains("despegarEnElLugar") }
        esperarA("TAKEOFF") { comandoCentral.eventos("TAKEOFF").isNotEmpty() }
        assertTrue(comandoCentral.eventos("TAKEOFF").single().getString("message").contains("sin GPS"))
    }

    @Test
    fun desdeLaAppSinPosicionDespegaYAvisaQueNoHayGps() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        dron.emitirTelemetria(Double.NaN, Double.NaN, alt = 0.0)
        delay(100)
        patrulla.despegarAqui()
        esperarA("TAKEOFF") { comandoCentral.eventos("TAKEOFF").isNotEmpty() }
        assertTrue(comandoCentral.eventos("TAKEOFF").single().getString("message").contains("sin GPS"))
    }

    @Test
    fun desdeLaAppConGpsNoAvisaQueFalta() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetria()
        patrulla.despegarAqui()
        esperarA("TAKEOFF") { comandoCentral.eventos("TAKEOFF").isNotEmpty() }
        assertFalse(comandoCentral.eventos("TAKEOFF").single().getString("message").contains("sin GPS"))
    }

    // ---- Aterrizar por batería baja ----

    /**
     * Con el control tomado y en el aire, la batería al 20 % dispara el regreso
     * a base, y el dron toca tierra con [evento]: ArrivedHome es lo que manda el
     * controlador al terminar el returnHome() del failsafe; Aterrizado, si
     * aterrizó por su cuenta (las palancas, o un regreso que el dron no aceptó).
     */
    private suspend fun aterrizarPorBateriaConElControlTomado(evento: FlightEvent) {
        patrulla.start()
        telemetria()
        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
        dron.emitirTelemetria(LAT, LON, bateria = 20.0, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_BATTERY } }
        esperarA("el regreso a base") { dron.ordenes.contains("returnHome") }

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(evento)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
        esperarA("LANDED") { comandoCentral.eventos("LANDED").isNotEmpty() }
    }

    /**
     * El motivo es la batería por cambiar y no el 20 %: con decir "hace falta
     * más del 25 %" parecería que una lectura que rebote al 26 % alcanza.
     */
    private suspend fun alPedirDespegarLaBateriaLoFrena() {
        mensaje("""{"type":"takeoff","by":"op"}""")
        esperarElAvisoDeCambiarLaBateria()
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /**
     * El camino real del failsafe con el control tomado: llega a base
     * (ArrivedHome), el control sigue siendo del operador —el Comando Central no
     * lo suelta por un aterrizaje, y la consola le ofrece "Despegar"—, el aviso
     * dice que hay que cambiar la batería y despegar queda frenado por ella.
     */
    @Test
    fun conElControlTomadoLlegarABasePorBateriaBajaLoDiceYNoDejaDespegar() = runBlocking {
        aterrizarPorBateriaConElControlTomado(FlightEvent.ArrivedHome)
        val aviso = comandoCentral.eventos("LANDED").single().getString("message")
        assertTrue(aviso, aviso.contains("batería baja"))
        assertTrue(aviso, aviso.contains("control manual sigue tomado"))
        alPedirDespegarLaBateriaLoFrena()
    }

    @Test
    fun conElControlTomadoAterrizarSoloPorBateriaBajaLoDiceYNoDejaDespegar() = runBlocking {
        aterrizarPorBateriaConElControlTomado(FlightEvent.Aterrizado)
        val aviso = comandoCentral.eventos("LANDED").single().getString("message")
        assertTrue(aviso, aviso.contains("batería baja"))
        assertTrue(aviso, aviso.contains("control manual sigue tomado"))
        alPedirDespegarLaBateriaLoFrena()
    }

    /** Soltar el control en el suelo con la batería baja deja el dron esperando la batería nueva. */
    @Test
    fun soltarElControlEnElSueloConLaBateriaBajaQuedaEnBase() = runBlocking<Unit> {
        aterrizarPorBateriaConElControlTomado(FlightEvent.ArrivedHome)
        mensaje("""{"type":"control_released","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.LANDED } }
    }

    /**
     * "Retomar ruta" con el control tomado y el dron en el suelo es despegar
     * solo: con la batería baja no sale, y se avisa por qué. Tampoco cuando la
     * lectura rebota por encima del 25 %: la batería sigue por cambiar.
     */
    @Test
    fun retomarLaRutaEnElSueloConLaBateriaBajaNoDespega() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
        dron.emitirTelemetria(LAT, LON, bateria = 20.0, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_BATTERY } }
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.ArrivedHome)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
        val rutasOrdenadas = dron.ordenes.count { it.startsWith("startRoute") }

        mensaje("""{"type":"resume_patrol","orderedBy":"op"}""")
        esperarElAvisoDeCambiarLaBateria()
        assertEquals(rutasOrdenadas, dron.ordenes.count { it.startsWith("startRoute") })
        assertEquals(PatrolState.MANUAL, patrulla.state.value)

        telemetriaConBateria(30.0)
        mensaje("""{"type":"resume_patrol","orderedBy":"op"}""")
        esperarA("el segundo aviso") {
            comandoCentral.eventos("DRONE_PROBLEM").count { it.getString("message").contains("hay que cambiarla") } == 2
        }
        assertEquals(rutasOrdenadas, dron.ordenes.count { it.startsWith("startRoute") })
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
    }

    /** Sin el control tomado, el dron que vuelve por batería baja queda en base esperando la batería nueva. */
    private suspend fun enBaseConLaBateriaPorCambiar() {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        dron.emitirTelemetria(LAT, LON, bateria = 20.0, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_BATTERY } }
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.ArrivedHome)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.LANDED } }
    }

    /**
     * En el dron real nadie aprieta "Recargar": se cambia la batería, se lo
     * prende, y la telemetría con la carga nueva lo deja listo para volar.
     * Hasta entonces "Despegar aquí" no sale, aunque la lectura rebote por
     * encima del umbral.
     */
    @Test
    fun conLaBateriaPorCambiarNoDespegaYAlCambiarlaQuedaListo() = runBlocking {
        enBaseConLaBateriaPorCambiar()

        telemetriaConBateria(30.0) // rebote de la batería descargada: sigue por cambiar
        patrulla.despegarAqui()
        esperarA("el aviso") {
            comandoCentral.eventos("DRONE_PROBLEM").any { it.getString("message").contains("hay que cambiarla") }
        }
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
        assertEquals(PatrolState.LANDED, patrulla.state.value)

        telemetriaConBateria(97.0)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.IDLE } }
        esperarA("BATTERY_RECHARGED") { comandoCentral.eventos("BATTERY_RECHARGED").isNotEmpty() }
        assertTrue(comandoCentral.eventos("BATTERY_RECHARGED").single().getString("message").contains("97%"))

        patrulla.despegarAqui()
        esperarA("el despegue") { dron.ordenes.contains("despegarEnElLugar") }
    }

    /** Una lectura sin dato de batería no cuenta como batería cambiada. */
    @Test
    fun sinDatoDeBateriaSigueEsperandoLaBateriaNueva() = runBlocking {
        enBaseConLaBateriaPorCambiar()
        telemetriaConBateria(Double.NaN)
        delay(200)
        assertEquals(PatrolState.LANDED, patrulla.state.value)
        assertTrue(comandoCentral.eventos("BATTERY_RECHARGED").isEmpty())
    }

    /**
     * La consola también puede ordenar una ruta con el dron en el suelo, y eso
     * es despegar solo: sin GPS no sale, y con la batería por cambiar tampoco.
     */
    @Test
    fun laRutaDesdeLaConsolaEnElSueloPideLasMismasCondiciones() = runBlocking {
        patrulla.availableRoutes = listOf(ruta)
        dron.estado.value = dron.estado.value.copy(enVuelo = false, satelites = 0, baseFijada = false, detalle = "sin GPS")
        patrulla.start()
        telemetria()
        mensaje("""{"type":"start_route","routeId":1,"fromIndex":0,"orderedBy":"op"}""")
        esperarA("el aviso") { comandoCentral.eventos("DRONE_PROBLEM").any { it.getString("message").contains("sin GPS") } }
        assertTrue(dron.ordenes.none { it.startsWith("startRoute") })
        assertEquals(PatrolState.IDLE, patrulla.state.value)
    }

    @Test
    fun laRutaDesdeLaConsolaConLaBateriaPorCambiarNoSale() = runBlocking {
        enBaseConLaBateriaPorCambiar()
        patrulla.availableRoutes = listOf(ruta)
        val rutasOrdenadas = dron.ordenes.count { it.startsWith("startRoute") }
        telemetriaConBateria(30.0)
        mensaje("""{"type":"start_route","routeId":1,"fromIndex":0,"orderedBy":"op"}""")
        esperarA("el aviso") {
            comandoCentral.eventos("DRONE_PROBLEM").any { it.getString("message").contains("hay que cambiarla") }
        }
        assertEquals(rutasOrdenadas, dron.ordenes.count { it.startsWith("startRoute") })
        assertEquals(PatrolState.LANDED, patrulla.state.value)
    }

    private suspend fun esperarElAvisoDeCambiarLaBateria() = esperarA("el aviso de cambiar la batería") {
        comandoCentral.eventos("DRONE_PROBLEM").any { it.getString("message").contains("hay que cambiarla") }
    }

    /**
     * Tomar el control de un dron en LANDED lo pasa a MANUAL, y la consola le
     * ofrece "Despegar": con la lectura rebotada por encima del 25 %, solo el
     * estado frenaba el despegue y el estado ya no era LANDED.
     */
    @Test
    fun conLaBateriaPorCambiarTomarElControlNoDejaDespegarDesdeLaConsola() = runBlocking {
        enBaseConLaBateriaPorCambiar()
        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
        telemetriaConBateria(30.0) // rebote de la batería descargada: sigue por cambiar

        mensaje("""{"type":"takeoff","by":"op"}""")
        esperarElAvisoDeCambiarLaBateria()
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /** Tomar y soltar el control en el suelo no da por cambiada la batería. */
    @Test
    fun conLaBateriaPorCambiarTomarYSoltarElControlLaSigueEsperando() = runBlocking {
        enBaseConLaBateriaPorCambiar()
        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
        telemetriaConBateria(30.0)

        mensaje("""{"type":"control_released","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.LANDED } }
        patrulla.despegarAqui()
        esperarElAvisoDeCambiarLaBateria()
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /**
     * Aterrizar por batería con el control tomado no pasa por LANDED: queda en
     * MANUAL. Con la lectura rebotada al 30 % ni la consola despega ni una ruta
     * arranca, hasta que llega la batería nueva; con esa sigue en MANUAL, del
     * operador, y ya despega.
     */
    @Test
    fun conElControlTomadoLaBateriaPorCambiarNoSeVuelaAunqueRebote() = runBlocking {
        aterrizarPorBateriaConElControlTomado(FlightEvent.ArrivedHome)
        patrulla.availableRoutes = listOf(ruta)
        telemetriaConBateria(30.0)

        mensaje("""{"type":"takeoff","by":"op"}""")
        esperarElAvisoDeCambiarLaBateria()
        mensaje("""{"type":"start_route","routeId":1,"fromIndex":0,"orderedBy":"op"}""")
        esperarA("el segundo aviso") {
            comandoCentral.eventos("DRONE_PROBLEM").count { it.getString("message").contains("hay que cambiarla") } == 2
        }
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
        assertTrue(dron.ordenes.none { it.startsWith("startRoute") })
        assertEquals(PatrolState.MANUAL, patrulla.state.value)

        telemetriaConBateria(97.0)
        esperarA("BATTERY_RECHARGED") { comandoCentral.eventos("BATTERY_RECHARGED").isNotEmpty() }
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        mensaje("""{"type":"takeoff","by":"op"}""")
        esperarA("el despegue") { dron.ordenes.contains("despegarEnElLugar") }
    }

    /**
     * Despegado con las palancas sin cambiar la batería y vuelto a aterrizar
     * (sin regreso por batería en el medio): la sigue esperando, no queda en
     * reposo como un dron listo para volar.
     */
    @Test
    fun aterrizarConLaBateriaTodaviaPorCambiarLaSigueEsperando() = runBlocking {
        enBaseConLaBateriaPorCambiar()
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        dron.emitirTelemetria(LAT, LON, bateria = 30.0, alt = 3.0, rumbo = 90.0, gimbal = -70.0)
        delay(100)
        val aterrizajes = comandoCentral.eventos("LANDED").size

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.Aterrizado)
        esperarA("el aterrizaje") { comandoCentral.eventos("LANDED").size == aterrizajes + 1 }
        assertEquals(PatrolState.LANDED, patrulla.state.value)
        patrulla.despegarAqui()
        esperarElAvisoDeCambiarLaBateria()
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /** El "Recargar" del simulador también da la batería por cambiada con el control tomado. */
    @Test
    fun recargarLaBateriaConElControlTomadoDejaDespegar() = runBlocking {
        enBaseConLaBateriaPorCambiar()
        mensaje("""{"type":"control_taken","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
        telemetriaConBateria(30.0)

        patrulla.onBatteryRecharged()
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        mensaje("""{"type":"takeoff","by":"op"}""")
        esperarA("el despegue") { dron.ordenes.contains("despegarEnElLugar") }
    }

    /** Sin GPS y sin que el controlador diga por qué, el aviso igual dice que no está listo. */
    @Test
    fun laRutaDesdeLaConsolaEnElSueloSinDetalleDiceQueNoEstaListo() = runBlocking {
        patrulla.availableRoutes = listOf(ruta)
        dron.estado.value = dron.estado.value.copy(enVuelo = false, satelites = 0, baseFijada = false, detalle = "")
        patrulla.start()
        telemetria()
        mensaje("""{"type":"start_route","routeId":1,"fromIndex":0,"orderedBy":"op"}""")
        esperarA("el aviso") {
            comandoCentral.eventos("DRONE_PROBLEM").any { it.getString("message").contains("el dron no está listo") }
        }
        assertTrue(dron.ordenes.none { it.startsWith("startRoute") })
    }

    /** El regreso a base que pidió el operador de campo termina en reposo, listo para volver a volar. */
    @Test
    fun volverABaseYLlegarDejaLaPatrullaEnReposo() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        patrulla.volverABase()
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME } }

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.ArrivedHome)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.IDLE } }
        esperarA("LANDED") { comandoCentral.eventos("LANDED").isNotEmpty() }
        assertEquals("Dron aterrizado en la base", comandoCentral.eventos("LANDED").single().getString("message"))
    }

    /** Soltar el control en el suelo con la batería bien deja el dron disponible. */
    @Test
    fun soltarElControlEnElSueloConLaBateriaBienQuedaEnReposo() = runBlocking<Unit> {
        enElSueloConElControlTomado()
        mensaje("""{"type":"control_released","by":"op"}""")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.IDLE } }
    }

    /**
     * Si alguien lo despega con las palancas del control sin haber cambiado la
     * batería, los failsafes siguen: con la batería baja vuelve a base.
     */
    @Test
    fun despegadoConLasPalancasSinCambiarLaBateriaVuelveABase() = runBlocking {
        enBaseConLaBateriaPorCambiar()
        val regresos = dron.ordenes.count { it == "returnHome" }

        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        dron.emitirTelemetria(LAT, LON, bateria = 22.0, alt = 10.0, rumbo = 90.0, gimbal = -70.0)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_BATTERY } }
        esperarA("el segundo regreso a base") { dron.ordenes.count { it == "returnHome" } == regresos + 1 }
    }

    /** Un despegue que no corresponde (sin el control tomado) se avisa a la consola, no queda mudo. */
    @Test
    fun unDespegueSinElControlSeAvisaALaConsola() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetria()
        mensaje("""{"type":"takeoff","by":"op"}""")
        esperarA("el aviso") { comandoCentral.eventos("DRONE_PROBLEM").isNotEmpty() }
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /** Si aterriza volviendo por batería baja, queda LANDED y no clavado en el regreso. */
    @Test
    fun aterrizarVolviendoPorBateriaBajaDejaElDronEnBase() = runBlocking<Unit> {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        dron.emitirTelemetria(LAT, LON, bateria = 20.0, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_BATTERY } }

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.Aterrizado)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.LANDED } }
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
