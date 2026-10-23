package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.base
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.bases
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.punto
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayStatus
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
 * El desvío a otra base (docs/RELEVOS.md §4) en la máquina de estados: el caso
 * extremo, cuando de verdad no llega a la propia —confirmado 10 s—, nunca porque
 * otra esté más cerca; de una sola vía, con el destino comprometido aunque la
 * base salga de la lista; el único corte del regreso propio del DJI; y el
 * aterrizaje en un lugar sin revisar, que no se confirma solo.
 *
 * El DJI informa que volver le cuesta 20 % y aterrizar 2 %; el dron está a
 * 1500 m al norte de su base y la base "Sur" (la 2) está a 900 m al norte de la
 * propia: a 585 m del dron, y llegar ahí cuesta unos 10 %.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerDesvioTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private suspend fun telemetria(norteM: Double = 1_500.0, bateria: Double, pctParaVolver: Double = 20.0) =
        banco.telemetria(norteM = norteM, bateria = bateria, pctParaVolver = pctParaVolver, pctParaAterrizar = 2.0)

    /** Patrullando a 1500 m de su base con autonomía informada. */
    private suspend fun lejosDeCasa() {
        dron.estado.value = dron.estado.value.copy(umbralCriticoPct = 10.0)
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        telemetria(bateria = 60.0)
        patrulla.startPatrol(RUTA)
        esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
    }

    /** Ya volviendo por batería, con la batería (21 %) por debajo de lo que cuesta volver + 2. */
    private suspend fun noLlega() {
        lejosDeCasa()
        telemetria(bateria = 21.0)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
    }

    /** No llega, sostenido 10 s: se desvía a "Sur". */
    private suspend fun desviado() {
        noLlega()
        esperarA("el pedido de patrulla") { banco.mensajes("relay_request").isNotEmpty() }
        banco.hub(relayStatus(banco.ultimo("relay_request").getString("ref"), 5, "RESERVADO"))
        banco.reloj.adelantar(Autonomia.CONFIRMAR_NO_LLEGA_MS)
        telemetria(bateria = 21.0)
        esperarA("el desvío") { banco.mensajes("rth_diverted").isNotEmpty() }
    }

    private val puntoDeVisitantesDeSur = punto(915.0)

    @Test
    fun siLlegaVuelveASuBaseAunqueOtraEsteMasCerca() = runBlocking {
        lejosDeCasa()
        // 23 % ≥ 20 + 2: llega. La base "Sur" está más cerca y sobra batería para ir: igual vuelve a la suya.
        telemetria(bateria = 23.0)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        repeat(4) {
            banco.reloj.adelantar(5_000)
            telemetria(bateria = 23.0)
        }
        assertTrue(banco.mensajes("rth_diverted").isEmpty())
        assertEquals("returnHome", dron.ordenes.last { it == "returnHome" || it.startsWith("volarHacia") })
    }

    @Test
    fun noLlegarTieneQueSostenerseDiezSegundos() = runBlocking {
        noLlega()
        esperarA("primero vuelve a SU base") { dron.ultimaOrden == "returnHome" }
        banco.reloj.adelantar(Autonomia.CONFIRMAR_NO_LLEGA_MS - 1_000)
        telemetria(bateria = 21.0)
        delay(100)
        assertTrue("9 s no alcanzan", banco.mensajes("rth_diverted").isEmpty())
        // Una lectura que vuelve a llegar reinicia la cuenta.
        telemetria(bateria = 22.0)
        banco.reloj.adelantar(2_000)
        telemetria(bateria = 21.0)
        delay(100)
        assertTrue(banco.mensajes("rth_diverted").isEmpty())
    }

    @Test
    fun sinAutonomiaNoSeDesviaNunca() = runBlocking {
        lejosDeCasa()
        telemetria(bateria = 21.0, pctParaVolver = Double.NaN)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        repeat(3) {
            banco.reloj.adelantar(10_000)
            telemetria(bateria = 21.0, pctParaVolver = Double.NaN)
        }
        assertTrue(banco.mensajes("rth_diverted").isEmpty())
    }

    @Test
    fun sinBasesDelHubNoHayDesvio() = runBlocking {
        dron.estado.value = dron.estado.value.copy(umbralCriticoPct = 10.0)
        banco.arrancar()
        telemetria(bateria = 60.0)
        patrulla.startPatrol(RUTA)
        telemetria(bateria = 21.0)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        banco.reloj.adelantar(Autonomia.CONFIRMAR_NO_LLEGA_MS)
        telemetria(bateria = 21.0)
        delay(100)
        assertTrue(banco.mensajes("rth_diverted").isEmpty())
    }

    @Test
    fun alDesviarseApagaElRegresoDelDjiYVuelaAlPuntoDeVisitantesALaAlturaDeTransito() = runBlocking {
        desviado()
        val ordenes = dron.ordenes
        val desde = ordenes.indexOf("permitirRthPropio(false)")
        assertTrue("apaga el regreso propio por batería", desde >= 0)
        assertEquals(
            listOf(
                "permitirRthPropio(false)", "cancelarRegreso", "failsafeAterrizar(true)", "confirmacionAutomatica(false)",
                "fijarPuntoDeRetornoEn", "volarHaciaA(60)",
            ),
            ordenes.subList(desde, desde + 6),
        )
        val (lat, lon) = dron.ultimoDestino!!
        assertEquals(0.0, Geo.distanciaM(puntoDeVisitantesDeSur.first, puntoDeVisitantesDeSur.second, lat, lon), 0.5)

        val aviso = banco.ultimo("rth_diverted")
        assertEquals("otra_base", aviso.getString("motivo"))
        assertEquals(2L, aviso.getLong("baseId"))
        assertEquals(5L, aviso.getLong("relayId"))
        assertEquals(punto(1_500.0).first, aviso.getDouble("lat"), 1e-9)
        esperarA("el aviso del desvío") {
            banco.comando.eventos("RTH_LOW_BATTERY").any { it.getString("message").contains("\"Sur\"") }
        }
        assertEquals("sigue siendo un regreso por batería", PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)
        esperarA("el status desviado") {
            banco.mensajes("status").lastOrNull()?.optJSONObject("relevo")?.optString("fase") == "desviado"
        }

        // De una sola vía: aunque ahora "llegue" a su base, no vuelve a evaluarla.
        telemetria(norteM = 1_400.0, bateria = 40.0)
        delay(100)
        assertEquals(1, banco.mensajes("rth_diverted").size)
        assertFalse(dron.ordenes.subList(desde, dron.ordenes.size).contains("returnHome"))
    }

    @Test
    fun alLlegarFijaElRetornoYAterrizaYAvisaEnQueBaseToco() = runBlocking {
        desviado()
        telemetria(norteM = 916.0, bateria = 15.0)
        esperarA("el aterrizaje") { dron.ultimaOrden == "land" }
        val ordenes = dron.ordenes
        assertEquals("fijarPuntoDeRetornoAqui", ordenes[ordenes.size - 2])

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.Aterrizado)
        esperarA("el landed_at_base") { banco.mensajes("landed_at_base").isNotEmpty() }
        val aterrizo = banco.ultimo("landed_at_base")
        assertEquals("la base del desvío", 2L, aterrizo.getLong("baseId"))
        assertEquals(5L, aterrizo.getLong("relayId"))
        assertTrue("no es landing_at_base: ese relevo ya salió con el rth_diverted", banco.mensajes("landing_at_base").isEmpty())
        esperarA("el aviso de que aterrizó en Sur") {
            banco.comando.eventos("LANDED").any { it.getString("message").contains("\"Sur\"") }
        }
        assertEquals(PatrolState.LANDED, patrulla.state.value)
        esperarA("la confirmación automática de vuelta") { dron.ultimaOrden == "confirmacionAutomatica(true)" }
        val fin = dron.ordenes.takeLast(4)
        assertTrue("vuelve el regreso propio", "permitirRthPropio(true)" in fin)
        assertTrue("y el failsafe de fábrica", "failsafeAterrizar(false)" in fin)
        assertTrue("y la confirmación automática", "confirmacionAutomatica(true)" in fin)
    }

    @Test
    fun elAvisoDeLlegadaLejosDelPuntoNoLoAterriza() = runBlocking {
        desviado()
        banco.evento(FlightEvent.GotoArrived)
        delay(100)
        assertFalse("land" in dron.ordenes)
        telemetria(norteM = 925.0, bateria = 15.0)
        banco.evento(FlightEvent.GotoArrived)
        esperarA("el aterrizaje") { dron.ultimaOrden == "land" }
    }

    @Test
    fun elDestinoComprometidoSeMantieneAunqueLaBaseSalgaDeLaLista() = runBlocking {
        desviado()
        banco.hub(bases(1L, base(1, "Norte", 0.0)))
        repeat(3) {
            banco.reloj.adelantar(5_000)
            telemetria(norteM = 1_200.0, bateria = 19.0)
        }
        assertEquals("ni otro destino ni la propia", 1, banco.mensajes("rth_diverted").size)
        telemetria(norteM = 915.0, bateria = 15.0)
        esperarA("el aterrizaje en la base comprometida") { dron.ultimaOrden == "land" }
    }

    @Test
    fun alReconectarSeVuelveAAvisarElDesvio() = runBlocking {
        desviado()
        banco.comando.connected.value = false
        delay(100)
        banco.comando.connected.value = true
        esperarA("el aviso repetido") { banco.mensajes("rth_diverted").size == 2 }
        assertEquals(banco.mensajes("rth_diverted")[0].toString(), banco.mensajes("rth_diverted")[1].toString())
    }

    @Test
    fun siElDjiArrancaSuRegresoDuranteElDesvioSeLoCortaUnaSolaVez() = runBlocking {
        desviado()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        esperarA("el corte") { dron.ordenes.count { it == "cancelarRegreso" } == 2 }
        esperarA("y sigue hacia la base del desvío") { dron.ultimaOrden == "volarHaciaA(60)" }

        val antes = dron.ordenes.size
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        delay(100)
        assertEquals("la segunda vez se lo deja seguir: nunca se pelea en lazo", antes, dron.ordenes.size)
        telemetria(norteM = 1_300.0, bateria = 19.0)
        telemetria(norteM = 915.0, bateria = 17.0)
        delay(100)
        assertEquals("ni siquiera al llegar: el vuelo es del DJI", antes, dron.ordenes.size)
    }

    @Test
    fun unaOrdenQueSeCumpleAbandonaElDesvioYUnaQueNoNo() = runBlocking {
        desviado()
        // stop_patrol no detiene un regreso: el desvío sigue.
        banco.comando.recibir(JSONObject().put("type", "stop_patrol").put("orderedBy", "op"))
        delay(100)
        assertFalse("permitirRthPropio(true)" in dron.ordenes)
        // Tomar el control sí: manda la persona.
        banco.comando.recibir(JSONObject().put("type", "control_taken").put("by", "op"))
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        assertTrue("permitirRthPropio(true)" in dron.ordenes)
        assertTrue("failsafeAterrizar(false)" in dron.ordenes)
        assertTrue("confirmacionAutomatica(true)" in dron.ordenes)
        // Ya no hay desvío que repetir al reconectar.
        banco.comando.connected.value = false
        delay(100)
        banco.comando.connected.value = true
        delay(200)
        assertEquals(1, banco.mensajes("rth_diverted").size)
    }

    @Test
    fun conElRegresoQuePidioUnaPersonaTambienSeDesviaSiNoLlega() = runBlocking {
        lejosDeCasa()
        telemetria(bateria = 30.0)
        patrulla.volverABase()
        esperarA("el regreso pedido") { patrulla.state.value == PatrolState.RETURNING_HOME }
        telemetria(bateria = 26.0)
        banco.reloj.adelantar(Autonomia.CONFIRMAR_NO_LLEGA_MS)
        telemetria(bateria = 26.0)
        delay(100)
        assertTrue("arriba del umbral de regreso vuelve como se pidió", banco.mensajes("rth_diverted").isEmpty())
        telemetria(bateria = 21.0)
        banco.reloj.adelantar(Autonomia.CONFIRMAR_NO_LLEGA_MS)
        telemetria(bateria = 21.0)
        esperarA("el desvío") { banco.mensajes("rth_diverted").isNotEmpty() }
        assertEquals(PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)
    }

    @Test
    fun conElDjiVolviendoSoloElDesvioUsaElUnicoCorte() = runBlocking {
        lejosDeCasa()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        esperarA("el regreso del DJI") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        assertFalse("la app no le pide otro regreso", "returnHome" in dron.ordenes)
        telemetria(bateria = 21.0)
        banco.reloj.adelantar(Autonomia.CONFIRMAR_NO_LLEGA_MS)
        telemetria(bateria = 21.0)
        esperarA("el desvío") { banco.mensajes("rth_diverted").isNotEmpty() }
        assertEquals("un solo corte", 1, dron.ordenes.count { it == "cancelarRegreso" })
    }

    @Test
    fun conElRegresoDelControlNoSeDesviaNunca() = runBlocking {
        lejosDeCasa()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_DEL_CONTROL))
        esperarA("el regreso pedido en el control") { patrulla.state.value == PatrolState.RETURNING_HOME }
        telemetria(bateria = 21.0)
        banco.reloj.adelantar(Autonomia.CONFIRMAR_NO_LLEGA_MS)
        telemetria(bateria = 21.0)
        delay(100)
        assertTrue("es una persona pidiendo el dron de vuelta", banco.mensajes("rth_diverted").isEmpty())
        assertFalse("cancelarRegreso" in dron.ordenes)
    }

    // ---- La confirmación del aterrizaje en un lugar sin revisar (RELEVOS §4) ----

    @Test
    fun siPideConfirmarSeCorreDosVecesYRecienEnElCriticoMasUnoConfirma() = runBlocking {
        desviado()
        telemetria(norteM = 915.0, bateria = 15.0)
        esperarA("el aterrizaje") { dron.ultimaOrden == "land" }

        banco.evento(FlightEvent.AterrizajePideConfirmacion)
        esperarA("el primer corrimiento") { dron.ultimaOrden == "volarHacia" }
        val (lat1, lon1) = dron.ultimoDestino!!
        val (aquiLat, aquiLon) = punto(915.0)
        assertEquals(10.0, Geo.distanciaM(aquiLat, aquiLon, lat1, lon1), 0.2)
        assertTrue("hacia el norte", lat1 > aquiLat)
        banco.evento(FlightEvent.GotoArrived)
        esperarA("el reintento") { dron.ultimaOrden == "land" }

        banco.evento(FlightEvent.AterrizajePideConfirmacion)
        esperarA("el segundo corrimiento") { dron.ultimaOrden == "volarHacia" }
        assertTrue("hacia el este", dron.ultimoDestino!!.second > aquiLon)
        banco.evento(FlightEvent.GotoArrived)
        esperarA("el segundo reintento") { dron.ultimaOrden == "land" }

        banco.evento(FlightEvent.AterrizajePideConfirmacion)
        delay(100)
        assertEquals("ya no se corre más: espera", "land", dron.ultimaOrden)
        telemetria(norteM = 915.0, bateria = 12.0)
        delay(100)
        assertFalse("confirmarAterrizaje" in dron.ordenes)
        telemetria(norteM = 915.0, bateria = 11.0)
        esperarA("la confirmación en el crítico + 1") { "confirmarAterrizaje" in dron.ordenes }
    }

    @Test
    fun conLaBateriaEnElCriticoMasUnoConfirmaSinCorrerse() = runBlocking {
        desviado()
        telemetria(norteM = 915.0, bateria = 11.0)
        esperarA("el aterrizaje") { dron.ultimaOrden == "land" }
        banco.evento(FlightEvent.AterrizajePideConfirmacion)
        esperarA("la confirmación") { dron.ultimaOrden == "confirmarAterrizaje" }
    }

    @Test
    fun unAterrizajeQueOrdenaUnaPersonaSeConfirmaComoSiempre() = runBlocking {
        desviado()
        patrulla.aterrizar()
        esperarA("el aterrizaje ordenado") { dron.ultimaOrden == "land" }
        assertTrue("confirmacionAutomatica(true)" in dron.ordenes)
        banco.evento(FlightEvent.AterrizajePideConfirmacion)
        esperarA("la confirmación") { dron.ultimaOrden == "confirmarAterrizaje" }
    }
}
