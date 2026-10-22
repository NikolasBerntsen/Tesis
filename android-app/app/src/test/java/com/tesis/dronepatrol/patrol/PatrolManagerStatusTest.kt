package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
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
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El `status` que la app le manda al Comando Central una vez por segundo
 * (docs/PROTOCOLS.md §1) y los avisos de vuelo que lo cambian: es lo único que
 * le dice a la consola dónde está el dron, cuánta batería le queda, qué ruta
 * vuela y si hay señal. Se verifica que cada campo salga de donde tiene que
 * salir —la telemetría, el estado del dron, la ruta, la patrulla— y los bordes:
 * antes de la primera telemetría, sin ruta, sin señal, y los avisos de vuelo
 * que llegan fuera de lugar.
 *
 * Usa Robolectric por lo mismo que el resto de las pruebas de PatrolManager: el
 * reparto de cuadros codifica en Base64 (android.util) y el Comando Central
 * espía arma el JSON con org.json. Los tiempos son reales: el status sale cada
 * segundo y la señal se da por perdida a los 4 s.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerStatusTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
        const val ALERTA = 9L
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = ComandoCentralEspia(alcance)
    private val deteccion = DetectionClient(alcance)
    private val patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST")
    private val ruta = PatrolRoute(
        1,
        "Manzana",
        listOf(Waypoint(LAT + 0.002, LON, ALT), Waypoint(LAT, LON + 0.002, ALT), Waypoint(LAT - 0.002, LON, ALT)),
    )

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private fun mensaje(json: String) = comandoCentral.manejarMensaje(json)

    private suspend fun esperarEstado(estado: PatrolState) {
        withTimeout(5_000) { patrulla.state.first { it == estado } }
    }

    private suspend fun telemetria(bateria: Double = 100.0, rumbo: Double = 90.0, gimbal: Double = -70.0) {
        dron.emitirTelemetria(LAT, LON, bateria = bateria, alt = ALT, rumbo = rumbo, gimbal = gimbal)
        delay(60)
    }

    /** El último status que cumple [condicion], esperándolo: sale uno por segundo. */
    private suspend fun esperarStatus(condicion: (JSONObject) -> Boolean): JSONObject {
        esperarA("un status que cumpla lo esperado") { comandoCentral.mensajes("status").any(condicion) }
        return comandoCentral.mensajes("status").last(condicion)
    }

    /**
     * Sin una primera telemetría no hay nada que informar ni contra qué medir el
     * silencio: no sale status, y el dron (que el controlador da en el aire) no
     * se da por perdido. Sin esa guarda la resta contra el epoch daba un
     * silencio de cincuenta años y el regreso a base saltaba apenas se abría la
     * pantalla.
     */
    @Test
    fun sinUnaPrimeraTelemetriaNoSaleStatusNiSeDaPorPerdidaLaSenial() = runBlocking<Unit> {
        patrulla.start()
        delay(1_600) // más de una vuelta del status y del vigía de la señal

        assertTrue(comandoCentral.mensajes("status").isEmpty())
        assertTrue(comandoCentral.eventos("SIGNAL_LOST").isEmpty())
        assertTrue(patrulla.signalOk.value)
        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertTrue("se le ordenó algo al dron: ${dron.ordenes}", dron.ordenes.isEmpty())

        telemetria()
        esperarStatus { true }
    }

    /** Cada campo del status sale de su fuente, sin ruta y con ruta. */
    @Test
    fun elStatusLlevaLaTelemetriaElDronYLaRuta() = runBlocking {
        dron.estado.value = dron.estado.value.copy(modoDeVuelo = "P-GPS", satelites = 17)
        patrulla.start()
        telemetria(bateria = 87.5, rumbo = 135.0, gimbal = -55.0)

        val sinRuta = esperarStatus { true }
        assertEquals("IDLE", sinRuta.getString("state"))
        assertTrue(sinRuta.isNull("routeId"))
        assertEquals(0, sinRuta.getInt("waypointTotal"))

        patrulla.startPatrol(ruta)
        dron.flightEvents.emit(FlightEvent.WaypointReached(1))
        // Otra lectura igual: sin telemetría por 4 s la señal se da por perdida
        telemetria(bateria = 87.5, rumbo = 135.0, gimbal = -55.0)
        val s = esperarStatus { it.getString("state") == "PATROLLING" && it.getInt("waypointIndex") == 1 }
        assertEquals(1, s.getInt("routeId"))
        assertEquals(3, s.getInt("waypointTotal"))
        assertEquals(87.5, s.getDouble("battery"), 1e-9)
        assertEquals(LAT, s.getDouble("lat"), 1e-9)
        assertEquals(LON, s.getDouble("lon"), 1e-9)
        assertTrue(s.getBoolean("gpsFix"))
        assertEquals(ALT, s.getDouble("alt"), 1e-9)
        assertEquals(135.0, s.getDouble("heading"), 1e-9)
        assertEquals(-55.0, s.getDouble("gimbalPitch"), 1e-9)
        assertEquals("OK", s.getString("signal"))
        assertEquals(90, s.getInt("signalPct"))
        assertEquals("TEST", s.getString("mode"))
        assertEquals(17, s.getInt("satellites"))
        assertTrue(s.getBoolean("flying"))
        assertEquals("P-GPS", s.getString("flightMode"))
        assertTrue(s.isNull("target"))
    }

    /**
     * Con la inclinación sin informar (el dron real antes de su primer aviso
     * del gimbal) el status no inventa la de patrulla: el campo no sale y la
     * consola supone la suya.
     */
    @Test
    fun unaInclinacionQueElDronNoInformoNoSaleEnElStatus() = runBlocking {
        patrulla.start()
        telemetria(gimbal = Double.NaN)
        val s = esperarStatus { true }
        assertFalse(s.toString(), s.has("gimbalPitch"))
    }

    /** El objetivo en seguimiento viaja en el status con su alerta, su tipo y su decisión. */
    @Test
    fun conUnObjetivoEnSeguimientoElStatusLoLleva() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/x", 1L)
        deteccion.onDetection?.invoke(persona)
        delay(80)
        deteccion.onDetection?.invoke(persona)
        esperarEstado(PatrolState.ORBITING)
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        val ref = comandoCentral.alertas.single().getString("ref")
        mensaje("""{"type":"alert_ack","ref":"$ref","alertId":$ALERTA}""")
        // Otra lectura igual: sin telemetría por 4 s la señal se da por perdida
        telemetria()

        val s = esperarStatus { !it.isNull("target") && it.getJSONObject("target").optLong("alertId") == ALERTA }
        assertEquals("ORBITING", s.getString("state"))
        val objetivo = s.getJSONObject("target")
        assertEquals("PERSON", objetivo.getString("type"))
        assertEquals("PENDING", objetivo.getString("decision"))
        assertFalse(objetivo.getBoolean("lost"))
        assertFalse(objetivo.getBoolean("moving"))
        assertEquals(dron.ultimaOrbita!!.first, objetivo.getDouble("lat"), 1e-9)
        assertEquals(dron.ultimaOrbita!!.second, objetivo.getDouble("lon"), 1e-9)
    }

    /**
     * Cortado el enlace de radio, el status lo dice (señal LOST, intensidad 0)
     * mientras el dron vuelve solo; si el regreso termina en la base sin que la
     * señal haya vuelto, la patrulla queda en reposo y no clavada esperando una
     * señal que ya no importa.
     */
    @Test
    fun sinSenialElStatusLoDiceYSiLlegaABaseQuedaEnReposo() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        withTimeout(12_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_SIGNAL } }

        val s = esperarStatus { it.getString("state") == "RETURNING_HOME_SIGNAL" }
        assertEquals("LOST", s.getString("signal"))
        assertEquals(0, s.getInt("signalPct"))
        assertFalse(patrulla.signalOk.value)

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.ArrivedHome)
        esperarEstado(PatrolState.IDLE)
        esperarA("LANDED") { comandoCentral.eventos("LANDED").isNotEmpty() }
        assertEquals("Dron aterrizado en la base", comandoCentral.eventos("LANDED").single().getString("message"))
    }

    /**
     * Un "llegó a base" que no cierra ningún regreso (un aviso tardío del SDK, o
     * uno de otro vuelo) no aterriza a la patrulla: sigue patrullando y no queda
     * un "aterrizado" falso en el registro.
     */
    @Test
    fun unAvisoDeLlegadaABaseFueraDeUnRegresoNoCambiaElEstado() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)

        dron.flightEvents.emit(FlightEvent.ArrivedHome)
        // El colector de avisos es uno y en orden: cuando sale el despegue, la
        // llegada ya se procesó.
        dron.flightEvents.emit(FlightEvent.Despegando)
        esperarA("el aviso que sigue") { comandoCentral.eventos("TAKEOFF").isNotEmpty() }

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertTrue(comandoCentral.eventos("LANDED").isEmpty())
    }

    /**
     * La app abierta con el dron ya volando una ruta que no cargó: el nodo que
     * informa el dron llega igual al status, y los avisos de vuelo que siguen se
     * siguen atendiendo.
     */
    @Test
    fun unNodoAlcanzadoSinRutaCargadaLlegaAlStatusYNoCortaLosAvisos() = runBlocking {
        patrulla.start()
        telemetria()

        dron.flightEvents.emit(FlightEvent.WaypointReached(3))
        val s = esperarStatus { it.getInt("waypointIndex") == 3 }
        assertEquals(0, s.getInt("waypointTotal"))

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.Aterrizado)
        esperarA("LANDED") { comandoCentral.eventos("LANDED").isNotEmpty() }
        assertEquals(PatrolState.IDLE, patrulla.state.value)
    }
}
