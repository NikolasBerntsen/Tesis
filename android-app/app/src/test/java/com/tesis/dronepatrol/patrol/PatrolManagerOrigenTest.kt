package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.punto
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayCancel
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayDone
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
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
 * A, el dron que pide el relevo (docs/RELEVOS.md §2 y §3): el pedido que se
 * repite con el mismo `ref` hasta el `relay_status`, el aviso de que baja y de
 * que aterrizó en su base, la ventana de gracia con el relevo en camino, el
 * alejamiento del objetivo después del `relay_done` y el abandono antes del
 * traspaso.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerOrigenTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    /** A patrullando la ruta, a 300 m al norte de su base, volando hacia el nodo 2 (índice 1). */
    private suspend fun patrullando(bateria: Double = 60.0) {
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 300.0, bateria = bateria)
        patrulla.startPatrol(RUTA)
        esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
        banco.evento(FlightEvent.WaypointReached(0))
    }

    private val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/captura", 1L)

    /** A orbitando una persona con la alerta 12 ya acusada. */
    private suspend fun siguiendo(bateria: Double = 60.0, pctParaVolver: Double = Double.NaN) {
        patrullando(bateria)
        banco.telemetria(norteM = 300.0, bateria = bateria, pctParaVolver = pctParaVolver)
        banco.deteccion.onDetection?.invoke(persona)
        delay(60)
        banco.deteccion.onDetection?.invoke(persona)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        esperarA("la alerta") { banco.comando.alertas.size == 1 }
        val ref = banco.comando.alertas.single().getString("ref")
        banco.comando.recibir(JSONObject().put("type", "alert_ack").put("ref", ref).put("alertId", 12))
        esperarA("el acuse") { patrulla.objetivo?.alertId == 12L }
    }

    private fun relevoDelStatus(): JSONObject? = banco.mensajes("status").lastOrNull()?.optJSONObject("relevo")

    // ---- Relevo de patrulla ----

    @Test
    fun alVolverPorBateriaPatrullandoPideRelevoYLoRepiteHastaElRelayStatus() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 300.0, bateria = 25.0)
        esperarA("el pedido") { banco.mensajes("relay_request").isNotEmpty() }
        val pedido = banco.ultimo("relay_request")
        assertEquals("patrulla", pedido.getString("motivo"))
        assertEquals(1, pedido.getInt("routeId"))
        assertEquals("el nodo hacia el que volaba, no el último alcanzado", 1, pedido.getInt("fromIndex"))
        val ref = pedido.getString("ref")
        esperarA("vuelve a SU base: sin autonomía no hay desvío") { dron.ultimaOrden == "returnHome" }
        assertEquals(PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)

        banco.pasar(4_000)
        assertEquals(1, banco.mensajes("relay_request").size)
        banco.pasar(1_000)
        esperarA("el reintento") { banco.mensajes("relay_request").size == 2 }
        assertEquals("el mismo ref en cada reintento", ref, banco.ultimo("relay_request").getString("ref"))

        banco.hub(relayStatus(ref, 5, "RESERVADO"))
        banco.pasar(5_000)
        banco.pasar(5_000)
        assertEquals("con el relay_status deja de repetirlo", 2, banco.mensajes("relay_request").size)
        esperarA("el status con el pedido") { relevoDelStatus()?.optString("fase") == "pedido" }
        assertEquals(5L, relevoDelStatus()!!.getLong("relayId"))
        assertEquals("origen", relevoDelStatus()!!.getString("rol"))
    }

    @Test
    fun unRelayStatusConOtroRefNoContesta() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 300.0, bateria = 25.0)
        esperarA("el pedido") { banco.mensajes("relay_request").isNotEmpty() }
        banco.hub(relayStatus("otro-ref", 5, "RESERVADO"))
        banco.pasar(5_000)
        esperarA("el reintento") { banco.mensajes("relay_request").size == 2 }
    }

    @Test
    fun alBajarEnSuBaseAvisaUnaVezYAlTocarTierraAvisaQueAterrizo() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 300.0, bateria = 25.0)
        esperarA("el pedido") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 5, "RESERVADO"))
        banco.telemetria(norteM = 2.0, bateria = 22.0, alt = 30.0)

        banco.evento(FlightEvent.DescendiendoEnBase)
        esperarA("el landing_at_base") { banco.mensajes("landing_at_base").isNotEmpty() }
        val aviso = banco.ultimo("landing_at_base")
        assertEquals(ref, aviso.getString("ref"))
        assertEquals(5L, aviso.getLong("relayId"))
        assertEquals("la base propia del último bases", 1L, aviso.getLong("baseId"))
        assertEquals(punto(2.0).first, aviso.getDouble("lat"), 1e-9)
        assertEquals(1, aviso.getInt("routeId"))
        assertEquals(1, aviso.getInt("fromIndex"))
        esperarA("el status aterrizando") { relevoDelStatus()?.optString("fase") == "aterrizando" }

        banco.evento(FlightEvent.DescendiendoEnBase)
        delay(100)
        assertEquals("sale una sola vez", 1, banco.mensajes("landing_at_base").size)

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.ArrivedHome)
        esperarA("el landed_at_base") { banco.mensajes("landed_at_base").isNotEmpty() }
        val aterrizo = banco.ultimo("landed_at_base")
        assertEquals(5L, aterrizo.getLong("relayId"))
        assertEquals(1L, aterrizo.getLong("baseId"))
        esperarA("el aterrizaje") { patrulla.state.value == PatrolState.LANDED }
        esperarA("el status sin relevo") { relevoDelStatus()?.isNull("relayId") == true }
    }

    @Test
    fun sinElComandoCentralLosAvisosDeAterrizajeSalenAlReconectar() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 300.0, bateria = 25.0)
        esperarA("el pedido") { banco.mensajes("relay_request").isNotEmpty() }
        banco.comando.connected.value = false
        delay(100)
        banco.evento(FlightEvent.DescendiendoEnBase)
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.ArrivedHome)
        delay(100)
        assertTrue(banco.mensajes("landing_at_base").isEmpty())
        assertTrue(banco.mensajes("landed_at_base").isEmpty())

        banco.comando.connected.value = true
        esperarA("los avisos guardados") { banco.mensajes("landed_at_base").isNotEmpty() }
        val orden = banco.comando.todos.map { it.optString("type") }.filter { it == "landing_at_base" || it == "landed_at_base" }
        assertEquals("en el orden en que pasaron", listOf("landing_at_base", "landed_at_base"), orden)
        assertTrue("sin relay_status, relayId va null", banco.ultimo("landing_at_base").isNull("relayId"))
    }

    @Test
    fun unEstadoTerminalOUnRelayCancelHacenOlvidarElPedido() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 300.0, bateria = 25.0)
        esperarA("el pedido") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 5, "SIN_RELEVO", relevo = null))
        esperarA("el status con el pedido") { relevoDelStatus()?.optLong("relayId") == 5L }
        banco.hub(relayStatus(ref, 5, "CANCELADO", relevo = null, motivoFin = "sin_relevo"))
        esperarA("el status sin relevo") { relevoDelStatus()?.isNull("relayId") == true }

        // Un relay_cancel de un pedido ya olvidado no cambia nada.
        banco.hub(relayCancel(5, "terminado"))
        assertEquals(PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)
    }

    @Test
    fun alReconectarElRelayCancelDeSuPedidoLoOlvida() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 300.0, bateria = 25.0)
        esperarA("el pedido") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 5, "ORDENADO"))
        esperarA("el status con el pedido") { relevoDelStatus()?.optLong("relayId") == 5L }
        banco.hub(relayCancel(5, "inexistente"))
        esperarA("el status sin relevo") { relevoDelStatus()?.isNull("relayId") == true }
    }

    // ---- Relevo de seguimiento ----

    @Test
    fun siguiendoPorDebajoDelUmbralDeRelevoPideUnoConSusSegundos() = runBlocking {
        siguiendo(bateria = 60.0, pctParaVolver = 10.0)
        banco.telemetria(norteM = 300.0, bateria = 36.0, pctParaVolver = 10.0)
        delay(100)
        assertTrue("el umbral es max(35, piso + 10) = 35", banco.mensajes("relay_request").isEmpty())

        banco.telemetria(norteM = 300.0, bateria = 34.0, pctParaVolver = 10.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val pedido = banco.ultimo("relay_request")
        assertEquals("seguimiento", pedido.getString("motivo"))
        assertEquals(12L, pedido.getLong("alertId"))
        // (34 − (15 + 3)) / (4 %/min) = 240 s, con el consumo por defecto (todavía no se midió).
        assertEquals(240.0, pedido.getDouble("segundosDisponibles"), 0.5)
        assertEquals("sigue sobre el objetivo", PatrolState.ORBITING, patrulla.state.value)

        banco.telemetria(norteM = 300.0, bateria = 33.0, pctParaVolver = 10.0)
        delay(100)
        assertEquals("uno solo por seguimiento", 1, banco.mensajes("relay_request").size)
    }

    @Test
    fun sinAutonomiaLosSegundosVanNull() = runBlocking {
        siguiendo()
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val pedido = banco.ultimo("relay_request")
        assertTrue("el campo está, en null", pedido.has("segundosDisponibles") && pedido.isNull("segundosDisponibles"))
    }

    /** A con la autonomía de un DJI que dice 10 %: piso 15, umbral de regreso 25, corte de la ventana 18. */
    private suspend fun conRelevoEnCamino(etaS: Double = 60.0): String {
        siguiendo(bateria = 60.0, pctParaVolver = 10.0)
        banco.telemetria(norteM = 300.0, bateria = 34.0, pctParaVolver = 10.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "EN_CAMINO", etaS = etaS))
        return ref
    }

    @Test
    fun conElRelevoEnCaminoLaVentanaDeGraciaLoDejaQuedarseHastaElPisoMasTres() = runBlocking {
        // B llega en 10 s: entra en lo que le queda a A hasta el corte (a los 19 %, 15 s).
        conRelevoEnCamino(etaS = 10.0)
        banco.telemetria(norteM = 300.0, bateria = 25.0, pctParaVolver = 10.0)
        delay(100)
        assertEquals("se queda sobre el objetivo", PatrolState.ORBITING, patrulla.state.value)
        assertFalse("returnHome" in dron.ordenes)
        esperarA("el status en la ventana") { relevoDelStatus()?.optString("fase") == "ventana" }

        banco.telemetria(norteM = 300.0, bateria = 19.0, pctParaVolver = 10.0)
        delay(100)
        assertEquals(PatrolState.ORBITING, patrulla.state.value)

        banco.telemetria(norteM = 300.0, bateria = 18.0, pctParaVolver = 10.0)
        esperarA("el abandono en el piso") { banco.mensajes("relay_abandon").isNotEmpty() }
        assertEquals(7L, banco.ultimo("relay_abandon").getLong("relayId"))
        assertEquals("piso", banco.ultimo("relay_abandon").getString("motivo"))
        esperarA("el regreso") { dron.ultimaOrden == "returnHome" }
        assertEquals(PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)
        assertTrue("avisa la última posición", banco.comando.eventos("TRACKING_ENDED").isNotEmpty())
    }

    @Test
    fun laVentanaDuraUnMinutoComoMucho() = runBlocking {
        val ref = conRelevoEnCamino()
        banco.telemetria(norteM = 300.0, bateria = 25.0, pctParaVolver = 10.0)
        delay(100)
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        // El relay_status se renueva (llega cada 5 s), pero la ventana no se estira.
        banco.reloj.adelantar(VentanaDeGracia.DURACION_MS - 5_000)
        banco.hub(relayStatus(ref, 7, "EN_CAMINO", etaS = 10.0))
        banco.reloj.adelantar(5_000)
        banco.telemetria(norteM = 300.0, bateria = 24.0, pctParaVolver = 10.0)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
    }

    @Test
    fun sinUnRelayStatusRecienteNoHayVentana() = runBlocking {
        conRelevoEnCamino()
        banco.reloj.adelantar(PedidoDeRelevo.STATUS_VIGENTE_MS)
        banco.telemetria(norteM = 300.0, bateria = 25.0, pctParaVolver = 10.0)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
    }

    @Test
    fun conUnRelevoQueNoLlegaATiempoNoHayVentana() = runBlocking {
        // A los 25 % le quedan (25 − 18) / (4 %/min) = 105 s: un relevo a 200 s no llega.
        conRelevoEnCamino(etaS = 200.0)
        banco.telemetria(norteM = 300.0, bateria = 25.0, pctParaVolver = 10.0)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
    }

    @Test
    fun sinAutonomiaNoHayVentanaYAbandonaEnElUmbral() = runBlocking {
        siguiendo()
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "EN_CAMINO", etaS = 10.0))
        banco.telemetria(norteM = 300.0, bateria = 25.0)
        esperarA("el abandono") { banco.mensajes("relay_abandon").isNotEmpty() }
        assertEquals("piso", banco.ultimo("relay_abandon").getString("motivo"))
    }

    /** A ya relevado: B mandó relay_ready y el hub le pasa el relay_done. */
    private suspend fun relevado(bateria: Double = 30.0, pctParaVolver: Double = Double.NaN) {
        siguiendo(bateria = 60.0, pctParaVolver = pctParaVolver)
        banco.telemetria(norteM = 300.0, bateria = 34.0, pctParaVolver = pctParaVolver)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "TRASPASO"))
        banco.telemetria(norteM = 300.0, bateria = bateria, pctParaVolver = pctParaVolver)
        banco.hub(relayDone(7, 12))
    }

    @Test
    fun conElRelayDoneSueltaSinPerderloSeAlejaYRecienLejosLoLiberaYVuelve() = runBlocking {
        relevado()
        esperarA("el alejamiento") { patrulla.state.value == PatrolState.PAUSED }
        assertNull("soltó el objetivo", patrulla.objetivo)
        assertTrue("sin TRACKING_ENDED de pérdida: el hub registra el traspaso", banco.comando.eventos("TRACKING_ENDED").isEmpty())
        esperarA("la orden de alejarse") { dron.ultimoDestino != null }
        val (lat, lon) = dron.ultimoDestino!!
        val objetivo = punto(300.0 + 40.0 / kotlin.math.tan(Math.toRadians(70.0)))
        assertEquals("a 115 m del objetivo", 115.0, Geo.distanciaM(objetivo.first, objetivo.second, lat, lon), 3.0)
        assertTrue("hacia el lado de su base", lat < objetivo.first)
        esperarA("el status soltando") { relevoDelStatus()?.optString("fase") == "soltando" }
        assertTrue(banco.mensajes("relay_released").isEmpty())

        // Una detección mientras se aleja no arranca otro seguimiento.
        banco.deteccion.onDetection?.invoke(persona)
        delay(60)
        banco.deteccion.onDetection?.invoke(persona)
        delay(100)
        assertEquals(1, banco.comando.alertas.size)

        banco.telemetria(norteM = 250.0, bateria = 30.0)
        delay(100)
        assertTrue("a 65 m todavía no", banco.mensajes("relay_released").isEmpty())
        banco.telemetria(norteM = 200.0, bateria = 30.0)
        esperarA("el relay_released") { banco.mensajes("relay_released").isNotEmpty() }
        assertEquals(7L, banco.ultimo("relay_released").getLong("relayId"))
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        esperarA("el regreso del DJI") { dron.ultimaOrden == "returnHome" }

        // Tenía un patrullaje en curso: pide que otro siga la ruta (RELEVOS §3.7).
        esperarA("el pedido de patrulla") { banco.mensajes("relay_request").any { it.getString("motivo") == "patrulla" } }
        val dePatrulla = banco.mensajes("relay_request").last { it.getString("motivo") == "patrulla" }
        assertEquals(1, dePatrulla.getInt("fromIndex"))

        // El hub reenvía el relay_done al reconectar: lo vuelve a confirmar.
        banco.hub(relayDone(7, 12))
        esperarA("la confirmación repetida") { banco.mensajes("relay_released").size == 2 }
    }

    /**
     * A en el umbral con B ya en la toma: el relay_done está por llegar, y
     * volver con el regreso del DJI lo haría subir donde B espera. Suelta y se
     * aleja como si hubiera llegado.
     */
    @Test
    fun enElUmbralConBYaEnLaTomaSueltaYSeAleja() = runBlocking {
        siguiendo()
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "TRASPASO"))
        banco.telemetria(norteM = 300.0, bateria = 25.0)
        esperarA("el alejamiento") { patrulla.state.value == PatrolState.PAUSED }
        assertTrue("sin abandono: ya lo tomaron", banco.mensajes("relay_abandon").isEmpty())
        assertFalse("returnHome" in dron.ordenes)
        // El relay_done que llega después ya está atendido.
        banco.hub(relayDone(7, 12))
        delay(100)
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        banco.telemetria(norteM = 200.0, bateria = 25.0)
        esperarA("el relay_released") { banco.mensajes("relay_released").isNotEmpty() }
    }

    @Test
    fun unRelayDoneDeOtraAlertaOSinPedidoSeIgnora() = runBlocking {
        siguiendo()
        banco.hub(relayDone(7, 12))
        delay(100)
        assertEquals("sin pedido de seguimiento no hay traspaso", PatrolState.ORBITING, patrulla.state.value)

        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "TRASPASO"))
        banco.hub(relayDone(7, 99))
        banco.hub(relayDone(8, 12))
        delay(100)
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertNotNull(patrulla.objetivo)
    }

    /** Con autonomía (piso 15): alejándose a los 20 % no corta para volver; 3 puntos debajo del piso, sí. */
    @Test
    fun alejandoseSoloElPisoLoHaceVolverAntes() = runBlocking {
        relevado(bateria = 26.0, pctParaVolver = 10.0)
        esperarA("el alejamiento") { patrulla.state.value == PatrolState.PAUSED }
        banco.telemetria(norteM = 280.0, bateria = 20.0, pctParaVolver = 10.0)
        delay(100)
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        banco.telemetria(norteM = 275.0, bateria = 13.0, pctParaVolver = 10.0)
        delay(100)
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        banco.telemetria(norteM = 270.0, bateria = 12.0, pctParaVolver = 10.0)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        assertTrue("no se alejó: no lo libera", banco.mensajes("relay_released").isEmpty())
    }

    @Test
    fun siNoLograAlejarseVuelveIgualSinLiberarlo() = runBlocking {
        relevado()
        esperarA("el alejamiento") { patrulla.state.value == PatrolState.PAUSED }
        banco.pasar(PatrolManager.ALEJAMIENTO_MAXIMO_MS)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        assertTrue(banco.mensajes("relay_released").isEmpty())
        // Un relay_done repetido no confirma un alejamiento que no pasó.
        banco.hub(relayDone(7, 12))
        delay(100)
        assertTrue(banco.mensajes("relay_released").isEmpty())
    }

    @Test
    fun conElControlTomadoSoloSueltaElObjetivo() = runBlocking {
        siguiendo()
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "TRASPASO"))
        banco.comando.recibir(JSONObject().put("type", "control_taken").put("by", "op"))
        esperarA("el control") { patrulla.state.value == PatrolState.MANUAL }
        banco.hub(relayDone(7, 12))
        esperarA("soltó el objetivo") { patrulla.objetivo == null }
        assertEquals("el dron es del operador", PatrolState.MANUAL, patrulla.state.value)
        assertTrue(dron.ordenes.none { it == "volarHacia" })
        // El operador lo aleja: se libera solo, sin volver (el dron sigue siendo suyo).
        banco.telemetria(norteM = 150.0, bateria = 33.0)
        esperarA("el relay_released") { banco.mensajes("relay_released").isNotEmpty() }
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
    }

    @Test
    fun unaOrdenDelOperadorAntesDelTraspasoEsUnAbandono() = runBlocking {
        siguiendo()
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "ORDENADO"))
        banco.comando.recibir(JSONObject().put("type", "stop_patrol").put("orderedBy", "op"))
        esperarA("el abandono") { banco.mensajes("relay_abandon").isNotEmpty() }
        assertEquals("orden_del_operador", banco.ultimo("relay_abandon").getString("motivo"))
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }
    }

    @Test
    fun unaOrdenDeCampoAntesDelTraspasoTambien() = runBlocking {
        siguiendo()
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "SIN_RELEVO", relevo = null))
        patrulla.detenerPatrullaje()
        esperarA("el abandono") { banco.mensajes("relay_abandon").isNotEmpty() }
        assertEquals("orden_de_campo", banco.ultimo("relay_abandon").getString("motivo"))
    }

    @Test
    fun elDescarteDeLaAlertaOlvidaElPedidoSinAbandonarlo() = runBlocking {
        siguiendo()
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "EN_CAMINO", etaS = 30.0))
        banco.comando.recibir(
            JSONObject().put("type", "alert_decision").put("alertId", 12).put("decision", "DISMISSED").put("decidedBy", "op"),
        )
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }
        assertTrue("el hub cancela el relevo de su lado", banco.mensajes("relay_abandon").isEmpty())
        esperarA("el status sin relevo") { relevoDelStatus()?.isNull("relayId") == true }
    }

    @Test
    fun sinSenialSiguiendoAbandonaPorLaSenial() = runBlocking {
        siguiendo()
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "EN_CAMINO", etaS = 30.0))
        banco.relojDeLaSenial.adelantar(PatrolManager.SIGNAL_TIMEOUT_MS + 1_000)
        esperarA("el abandono por la señal", topeMs = 3_000) { banco.mensajes("relay_abandon").isNotEmpty() }
        assertEquals("senial", banco.ultimo("relay_abandon").getString("motivo"))
    }

    @Test
    fun terminadoSinTraspasoNoVuelveAPedirEnseguida() = runBlocking {
        siguiendo()
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido de seguimiento") { banco.mensajes("relay_request").isNotEmpty() }
        val ref = banco.ultimo("relay_request").getString("ref")
        banco.hub(relayStatus(ref, 7, "FALLIDO", relevo = null, motivoFin = "relevo_abortado"))
        banco.telemetria(norteM = 300.0, bateria = 33.0)
        delay(100)
        assertEquals(1, banco.mensajes("relay_request").size)
        banco.reloj.adelantar(PatrolManager.REINTENTO_TRAS_FIN_MS)
        banco.telemetria(norteM = 300.0, bateria = 33.0)
        esperarA("el pedido nuevo") { banco.mensajes("relay_request").size == 2 }
        assertFalse("con otro ref", banco.mensajes("relay_request")[1].getString("ref") == ref)
    }
}
