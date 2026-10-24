package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.objetivo
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayStart
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayStatus
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayTarget
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayTracking
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
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
 * El propio DJI le saca el vuelo a la app ([FlightEvent.ElDronTomoElControl],
 * docs/RELEVOS.md §4): la app corta lo que le daba órdenes, no le pelea el
 * control en lazo, avisa lo que corresponde (el abandono de un relevo, el fin
 * del seguimiento con la última posición) y recién vuelve a ordenar cuando una
 * persona da una orden. Su regreso por pérdida de señal es la excepción: al
 * volver el enlace decide la regla de siempre.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerTomaDelDronTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private suspend fun patrullando() {
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 300.0, bateria = 60.0)
        patrulla.startPatrol(RUTA)
        esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
        banco.evento(FlightEvent.WaypointReached(0))
    }

    private suspend fun toma(motivo: MotivoDelDron) = banco.evento(FlightEvent.ElDronTomoElControl(motivo))

    @Test
    fun suRegresoPorBateriaEsUnRegresoPorBateriaSinPelearlo() = runBlocking {
        patrullando()
        val antes = dron.ordenes.size
        toma(MotivoDelDron.RTH_BATERIA)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        esperarA("el aviso") { banco.comando.eventos("RTH_LOW_BATTERY").any { it.getString("message").contains("propio dron") } }
        esperarA("el pedido de relevo de la ruta") { banco.mensajes("relay_request").isNotEmpty() }
        assertEquals("patrulla", banco.ultimo("relay_request").getString("motivo"))
        assertEquals("ni una orden: el regreso es suyo", antes, dron.ordenes.size)
        banco.telemetria(norteM = 250.0, bateria = 24.0)
        delay(100)
        assertEquals(antes, dron.ordenes.size)
    }

    @Test
    fun elBotonDelControlEsUnRegresoPedidoEnElCampo() = runBlocking {
        patrullando()
        toma(MotivoDelDron.RTH_DEL_CONTROL)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        esperarA("el aviso") { banco.comando.eventos("RTH_MANUAL").any { it.getString("message").contains("control físico") } }
        assertFalse("returnHome" in dron.ordenes)
    }

    @Test
    fun unRegresoSinMotivoConocidoSeLoDejaVolver() = runBlocking {
        patrullando()
        val antes = dron.ordenes.size
        toma(MotivoDelDron.OTRO)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        assertEquals(antes, dron.ordenes.size)
        // Las telemetrías que siguen tampoco lo hacen ordenar nada: el vuelo es suyo.
        banco.telemetria(norteM = 200.0, bateria = 50.0)
        delay(100)
        assertEquals(antes, dron.ordenes.size)
    }

    /**
     * El regreso por pérdida de señal del DJI no le saca el vuelo a la app para
     * siempre: es la pérdida de señal de siempre, y al volver el enlace se
     * retoma el patrullaje (la regla de antes de los relevos).
     */
    @Test
    fun suRegresoPorSenialEsLaPerdidaDeSenialDeSiempre() = runBlocking {
        patrullando()
        toma(MotivoDelDron.RTH_SENIAL)
        esperarA("la señal perdida") { patrulla.state.value == PatrolState.RETURNING_HOME_SIGNAL }
        esperarA("el aviso") { banco.comando.eventos("SIGNAL_LOST").any { it.getString("message").contains("pérdida de señal") } }
        assertFalse("no se le frena el regreso: es suyo", dron.ultimaOrden == "hold")
        banco.telemetria(norteM = 280.0, bateria = 55.0)
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }
        assertEquals("hacia el nodo que tenía por delante", "startRoute(1, 1)", dron.ultimaOrden)
    }

    @Test
    fun suRegresoPorSenialConUnRegresoEnCursoSoloSeAnota() = runBlocking {
        patrullando()
        banco.telemetria(norteM = 300.0, bateria = 24.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        toma(MotivoDelDron.RTH_SENIAL)
        delay(100)
        assertEquals(PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)
        assertTrue(banco.comando.eventos("SIGNAL_LOST").isEmpty())
    }

    @Test
    fun siguiendoUnObjetivoConRelevoPedidoLoAbandonaYAvisaLaUltimaPosicion() = runBlocking {
        patrullando()
        val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), null, 1L)
        banco.deteccion.onDetection?.invoke(persona)
        delay(60)
        banco.deteccion.onDetection?.invoke(persona)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        esperarA("la alerta") { banco.comando.alertas.size == 1 }
        val ref = banco.comando.alertas.single().getString("ref")
        banco.comando.recibir(JSONObject().put("type", "alert_ack").put("ref", ref).put("alertId", 12))
        esperarA("el acuse") { patrulla.objetivo?.alertId == 12L }
        banco.telemetria(norteM = 300.0, bateria = 34.0)
        esperarA("el pedido") { banco.mensajes("relay_request").isNotEmpty() }
        banco.hub(relayStatus(banco.ultimo("relay_request").getString("ref"), 7, "EN_CAMINO", etaS = 30.0))

        toma(MotivoDelDron.RTH_BATERIA)
        esperarA("el abandono") { banco.mensajes("relay_abandon").isNotEmpty() }
        assertEquals("dji", banco.ultimo("relay_abandon").getString("motivo"))
        esperarA("el fin del seguimiento") { banco.comando.eventos("TRACKING_ENDED").isNotEmpty() }
        val fin = banco.comando.eventos("TRACKING_ENDED").last()
        assertEquals(12L, fin.getLong("alertId"))
        assertTrue("con la última posición del objetivo", fin.has("lat"))
    }

    @Test
    fun unaPersonaQueDaUnaOrdenRecuperaElVuelo() = runBlocking {
        patrullando()
        toma(MotivoDelDron.OTRO)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        banco.comando.recibir(JSONObject().put("type", "control_taken").put("by", "op"))
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        assertEquals("hold", dron.ultimaOrden)
    }

    // ---- B ----

    private suspend fun bEnTierraDisponible() {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 5.0, bateria = 95.0, alt = 0.0)
        assertTrue(patrulla.ponerEnEspera(true))
    }

    @Test
    fun conBEnLaCuentaRegresivaRechazaSinDespegar() = runBlocking {
        bEnTierraDisponible()
        banco.hub(relayStart(5))
        esperarA("la cuenta") { patrulla.cuentaRegresiva.value?.habilitando == false }
        toma(MotivoDelDron.OTRO)
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", banco.ultimo("relay_reject").getString("motivo"))
    }

    @Test
    fun conBEnCaminoAbortaYNoLePeleaElVuelo() = runBlocking {
        bEnTierraDisponible()
        val quieto = objetivo(12, 600.0)
        banco.hub(relayTracking(7, 12, quieto))
        esperarA("la cuenta") { patrulla.cuentaRegresiva.value?.habilitando == false }
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 600.0))
        banco.pasar(10_000)
        esperarA("el despegue") { dron.ordenes.any { it.startsWith("despegarHasta") } }
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.telemetria(norteM = 5.0, bateria = 94.0, alt = 60.0)
        banco.evento(FlightEvent.EnElAire)
        esperarA("el tránsito") { "volarHacia" in dron.ordenes }

        toma(MotivoDelDron.RTH_DEL_CONTROL)
        esperarA("el abort") { banco.mensajes("relay_abort").isNotEmpty() }
        assertEquals("orden_de_campo", banco.ultimo("relay_abort").getString("motivo"))
        val antes = dron.ordenes.size
        banco.pasar(2_000)
        banco.telemetria(norteM = 50.0, bateria = 93.0, alt = 60.0)
        assertEquals("ni una orden de tránsito más", antes, dron.ordenes.size)
    }
}
