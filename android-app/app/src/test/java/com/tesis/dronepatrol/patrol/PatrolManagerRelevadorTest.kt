package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.ContratoDeRelevos
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.Georreferencia
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.objetivo
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.punto
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayCancel
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayGo
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayStart
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayTarget
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayTracking
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * B, el dron que sale a relevar (docs/RELEVOS.md §2 y §3): acepta o rechaza
 * cada orden reevaluando su disponibilidad entera, habilita el mando virtual en
 * el suelo antes de los motores, corre la cuenta regresiva de 10 s con
 * «Cancelar», despega solo cuando corresponde, y en un seguimiento se detiene a
 * la distancia de toma, por encima de A, y baja recién con A lejos.
 *
 * Los mensajes del hub pasan por la misma validación que el socket, y los
 * tiempos (la cuenta, la subida) corren con el reloj falso.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerRelevadorTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    /** B en su base, en el suelo, con batería y el interruptor prendido: disponible. */
    private suspend fun disponible() {
        banco.enElSuelo()
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 5.0, bateria = 95.0, alt = 0.0)
        assertTrue("el interruptor se prende en el suelo y enlazado", patrulla.ponerEnEspera(true))
    }

    private fun motivoDelRechazo(relayId: Long): String =
        banco.mensajes("relay_reject").last { it.getLong("relayId") == relayId }.getString("motivo")

    private suspend fun aceptado(relayId: Long) {
        esperarA("el relay_accept del relevo #$relayId") {
            banco.mensajes("relay_accept").any { it.getLong("relayId") == relayId }
        }
        esperarA("la cuenta regresiva") { patrulla.cuentaRegresiva.value?.habilitando == false }
    }

    // ---- Relevo de patrulla ----

    @Test
    fun aceptaElRelevoDePatrullaYDespegaRecienConElGo() = runBlocking {
        disponible()
        banco.hub(relayStart(5, fromIndex = 1))
        aceptado(5)
        val ordenes = dron.ordenes
        assertTrue("el mando virtual se habilita en el suelo, antes de los motores", "habilitarMandoVirtual" in ordenes)
        assertEquals(10, patrulla.cuentaRegresiva.value!!.segundos)

        banco.pasar(9_000)
        assertEquals(1, patrulla.cuentaRegresiva.value!!.segundos)
        banco.pasar(1_000)
        esperarA("la espera del go") { patrulla.cuentaRegresiva.value?.esperandoQueBajeA == true }
        assertFalse("sin relay_go no despega", dron.ordenes.any { it.startsWith("startRoute") })

        banco.hub(relayGo(5))
        esperarA("el despegue con la ruta de A desde su nodo") { "startRoute(1, 1)" in dron.ordenes }
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertFalse("el interruptor vale una sola vez", patrulla.enEspera.value)
        assertNull(patrulla.cuentaRegresiva.value)

        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.evento(FlightEvent.Despegando)
        banco.evento(FlightEvent.EnElAire)
        esperarA("el relay_ready en el aire") { banco.mensajes("relay_ready").size == 1 }
        assertEquals(5L, banco.ultimo("relay_ready").getLong("relayId"))
        assertTrue("es patrulla de verdad: Reanudar la retoma", patrulla.puedeReanudar)
    }

    @Test
    fun unGoDuranteLaCuentaDespegaAlTerminarla() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        banco.hub(relayGo(5))
        banco.pasar(5_000)
        assertFalse("la cuenta no se acorta", dron.ordenes.any { it.startsWith("startRoute") })
        banco.pasar(5_000)
        esperarA("el despegue al terminar la cuenta") { dron.ordenes.any { it.startsWith("startRoute") } }
    }

    @Test
    fun sinElInterruptorRechazaPorNoDisponible() = runBlocking {
        banco.enElSuelo()
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 5.0, bateria = 95.0, alt = 0.0)
        banco.hub(relayStart(5))
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(5))
        assertTrue(banco.ultimo("relay_reject").getString("detalle").contains("En espera para relevos"))
        assertFalse("ni intenta el mando virtual", "habilitarMandoVirtual" in dron.ordenes)
        assertTrue(banco.mensajes("relay_accept").isEmpty())
    }

    @Test
    fun fueraDeSuBaseOConPocaBateriaNoEstaDisponible() = runBlocking {
        disponible()
        banco.telemetria(norteM = 80.0, bateria = 95.0, alt = 0.0)
        banco.hub(relayStart(5))
        esperarA("el rechazo fuera de base") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no está en su base", banco.ultimo("relay_reject").getString("detalle"))

        // Una batería que baja no es un cambio de batería: el interruptor sigue prendido.
        banco.telemetria(norteM = 5.0, bateria = 55.0, alt = 0.0)
        banco.hub(relayStart(6))
        esperarA("el rechazo por batería") { banco.mensajes("relay_reject").size == 2 }
        assertEquals("no_disponible", motivoDelRechazo(6))
        assertTrue(banco.ultimo("relay_reject").getString("detalle").contains("55"))
    }

    @Test
    fun conOtroRelevoEnCursoContestaOcupado() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        banco.hub(relayStart(6))
        esperarA("el rechazo del segundo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("ocupado", motivoDelRechazo(6))
    }

    @Test
    fun laOrdenRepetidaSeContestaIgualSinReiniciarLaCuenta() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        banco.pasar(6_000)
        banco.hub(relayStart(5))
        esperarA("la misma respuesta") { banco.mensajes("relay_accept").size == 2 }
        banco.pasar(4_000)
        esperarA("la cuenta siguió sin reiniciarse") { patrulla.cuentaRegresiva.value?.esperandoQueBajeA == true }
    }

    @Test
    fun unaOrdenInvalidaConRelayIdSeRechazaPorMensajeInvalido() = runBlocking {
        disponible()
        val invalida = ContratoDeRelevos.invalidos(ContratoDeRelevos.HUB_A_LA_APP, "relay_start")
            .first { it.caso == "fromIndex fuera de la ruta" }.mensaje
        banco.hub(invalida)
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("mensaje_invalido", motivoDelRechazo(8))
        assertTrue(banco.mensajes("relay_accept").isEmpty())

        // Sin relayId no hay a quién contestar: se ignora.
        banco.hub(JSONObject(invalida.toString()).put("relayId", "8"))
        delay(200)
        assertEquals(1, banco.mensajes("relay_reject").size)
    }

    @Test
    fun siElMandoVirtualNoSeHabilitaRechazaSinDespegar() = runBlocking {
        disponible()
        dron.mandoVirtualEnTierra = false
        banco.hub(relayStart(5))
        esperarA("el rechazo por el mando virtual") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals(1, banco.mensajes("relay_accept").size)
        assertEquals("virtual_stick", motivoDelRechazo(5))
        assertNull("no hay cuenta regresiva", patrulla.cuentaRegresiva.value)
        banco.hub(relayGo(5))
        banco.pasar(11_000)
        assertFalse(dron.ordenes.any { it.startsWith("startRoute") })
    }

    @Test
    fun cancelarEnElTelefonoNoDespega() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        patrulla.cancelarRelevoEnCampo()
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("cancelado_en_campo", motivoDelRechazo(5))
        assertEquals("Cancelado desde el teléfono", banco.ultimo("relay_reject").getString("detalle"))
        assertNull(patrulla.cuentaRegresiva.value)
        banco.hub(relayGo(5))
        banco.pasar(11_000)
        assertFalse(dron.ordenes.any { it.startsWith("startRoute") })
        // Una orden repetida de ese relevo se contesta con el mismo rechazo.
        banco.hub(relayStart(5))
        esperarA("la misma respuesta") { banco.mensajes("relay_reject").size == 2 }
        assertEquals("cancelado_en_campo", motivoDelRechazo(5))
    }

    @Test
    fun siSeApagaElInterruptorDuranteLaCuentaNoDespega() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        assertTrue(patrulla.ponerEnEspera(false))
        banco.pasar(200)
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(5))
    }

    @Test
    fun unRelayCancelEnTierraCortaLaCuenta() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        banco.hub(relayCancel(5, "vencido"))
        esperarA("el fin de la cuenta") { patrulla.cuentaRegresiva.value == null }
        banco.hub(relayGo(5))
        banco.pasar(11_000)
        assertFalse(dron.ordenes.any { it.startsWith("startRoute") })
        assertEquals(PatrolState.IDLE, patrulla.state.value)
    }

    @Test
    fun conElControlTomadoEnTierraNoDespega() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        banco.comando.recibir(JSONObject().put("type", "control_taken").put("by", "op"))
        banco.pasar(200)
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(5))
    }

    @Test
    fun elStatusDeBDiceSuRolYSuFase() = runBlocking {
        disponible()
        esperarA("el status en espera") {
            banco.mensajes("status").lastOrNull()?.optJSONObject("relevo")?.optBoolean("disponible") == true
        }
        banco.hub(relayStart(5))
        aceptado(5)
        esperarA("el status con el relevo") {
            banco.mensajes("status").lastOrNull()?.optJSONObject("relevo")?.optString("fase") == "cuenta_regresiva"
        }
        val r = banco.ultimo("status").getJSONObject("relevo")
        assertEquals(5L, r.getLong("relayId"))
        assertEquals("relevo", r.getString("rol"))
        assertFalse("en un relevo ya no es candidato", r.getBoolean("disponible"))
        assertTrue(r.getBoolean("enEspera"))
    }

    // ---- Relevo de seguimiento ----

    /** El objetivo de la alerta 12: una persona quieta a 600 m al norte de la base. */
    private val quieto = objetivo(12, 600.0)

    /** B despegó para un seguimiento y ya está arriba, en camino. */
    private suspend fun enCamino(aAlt: Double = 40.0) {
        disponible()
        banco.hub(relayTracking(7, 12, quieto, ts = 1_000))
        aceptado(7)
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 600.0, aAlt = aAlt))
        banco.pasar(10_000)
        esperarA("el despegue sin esperar ningún go") { dron.ordenes.any { it.startsWith("despegarHasta") } }
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.evento(FlightEvent.Despegando)
        banco.telemetria(norteM = 5.0, bateria = 94.0, alt = 60.0)
        banco.evento(FlightEvent.EnElAire)
    }

    @Test
    fun elSeguimientoDespegaSinGoSubeYVaHaciaElPuntoDeToma() = runBlocking {
        enCamino(aAlt = 50.0)
        assertTrue("sube 20 m por encima de A: 50 + 20", "despegarHasta(70.0)" in dron.ordenes)
        assertEquals(1, banco.comando.eventos("TAKEOFF").count { it.getString("message").contains("relevar") || it.getString("message").contains("relevo") })
        esperarA("la orden de tránsito") { dron.ultimoDestino != null }
        val (lat, lon) = dron.ultimoDestino!!
        val (oLat, oLon) = punto(600.0)
        assertEquals("se detiene a 60 m del objetivo, del lado por el que llega", 60.0, Geo.distanciaM(oLat, oLon, lat, lon), 1.0)
        assertTrue("del lado de B (al sur)", lat < oLat)
    }

    @Test
    fun alLlegarALaTomaSembraElRastreadorYAvisaQueEstaListo() = runBlocking {
        enCamino()
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        assertEquals(7L, banco.ultimo("relay_ready").getLong("relayId"))
        val objetivoDeB = patrulla.objetivo!!
        assertEquals("la misma alerta", 12L, objetivoDeB.alertId)
        assertEquals("la decisión de la base", "VALIDATED", objetivoDeB.decision)
        assertEquals("con la estimación de A", quieto.getDouble("lat"), objetivoDeB.lat, 1e-9)
        assertEquals("todavía no baja: A está encima", PatrolState.RELEVANDO, patrulla.state.value)

        // A sigue sobre el objetivo: B se queda arriba.
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 610.0))
        banco.pasar(1_100)
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)

        // A ya está a más de 100 m: B baja EN EL LUGAR a la altura a la que A
        // lo seguía (40 m) y recién ahí lo sigue; el relevo terminó para él.
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, aNorteM = 720.0))
        banco.pasar(300)
        esperarA("la bajada") { "volarHaciaA(40)" in dron.ordenes }
        val (bLat, bLon) = punto(545.0)
        assertEquals("baja donde está, sin ir a ningún lado", 0.0, Geo.distanciaM(bLat, bLon, dron.ultimoDestino!!.first, dron.ultimoDestino!!.second), 0.5)
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)
        banco.evento(FlightEvent.GotoArrived)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        assertTrue("startOrbit" in dron.ordenes)
        assertTrue(banco.comando.eventos("TRACKING_RESUMED").last().getString("message").contains("Alfa"))
        esperarA("el status sin relevo") {
            banco.mensajes("status").lastOrNull()?.let { s ->
                s.getJSONObject("relevo").isNull("relayId") && s.getJSONObject("target").getLong("alertId") == 12L
            } == true
        }
        assertFalse("no hereda la ruta de A", patrulla.puedeReanudar)
    }

    @Test
    fun conAJubiladoBajaAunqueEsteCerca() = runBlocking {
        enCamino()
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, origen = "retirado", aNorteM = null, aAlt = null))
        banco.pasar(300)
        esperarA("la bajada") { "volarHaciaA(40)" in dron.ordenes }
        // Llegó a la altura de seguimiento (40 + la tolerancia): empieza a seguir.
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 41.5)
        banco.pasar(300)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    /**
     * `retirado` llega con el `ts` del último objetivo válido (el hub no tiene
     * uno nuevo): el origen se lee igual, aunque el objetivo se descarte por
     * viejo. Si no, B esperaría arriba para siempre a un A que ya se fue.
     */
    @Test
    fun unRetiradoConElTsDelUltimoObjetivoIgualHaceBajar() = runBlocking {
        enCamino()
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        // El mismo ts que el último aplicado (2000), con un objetivo corrido que no se tiene que tomar.
        banco.hub(relayTarget(7, 12, objetivo(12, 900.0), ts = 2_000, origen = "retirado", aNorteM = null, aAlt = null))
        banco.pasar(300)
        esperarA("la bajada") { "volarHaciaA(40)" in dron.ordenes }
        assertEquals("el objetivo viejo no pisó la estimación", quieto.getDouble("lat"), patrulla.objetivo!!.lat, 1e-6)

        // `retirado` es para siempre: un en_linea posterior con A cerca no lo vuelve a frenar.
        banco.hub(relayTarget(7, 12, quieto, ts = 5_000, aNorteM = 600.0))
        banco.pasar(300)
        assertEquals("sigue bajando, sin volver al punto de toma", 1, dron.ordenes.count { it.startsWith("volarHaciaA") })
        banco.evento(FlightEvent.GotoArrived)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    @Test
    fun unSinEnlaceViejoSoloAnotaElOrigen() = runBlocking {
        enCamino()
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, origen = "sin_enlace", aNorteM = 600.0))
        banco.pasar(1_100)
        assertEquals("sin_enlace no deja bajar: A puede seguir encima", PatrolState.RELEVANDO, patrulla.state.value)
        assertTrue(dron.ordenes.none { it.startsWith("volarHaciaA") })
    }

    @Test
    fun sinNoticiasDelHubBajaIgualPasadoElSilencio() = runBlocking {
        enCamino()
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        banco.pasar(PatrolManager.SILENCIO_DEL_HUB_MS)
        esperarA("la bajada") { "volarHaciaA(40)" in dron.ordenes }
        // El dron no llega a la altura (ni avisa): pasado el tope, sigue igual desde donde está.
        banco.pasar(PatrolManager.BAJADA_MAXIMA_MS)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    @Test
    fun sinLaAlturaDeAYaAbajoSigueEnElActo() = runBlocking {
        enCamino(aAlt = 30.0)
        // Llega a la toma a la altura de seguimiento por defecto (la de A no se supo: el último target no la trae).
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 600.0, aAlt = null))
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 40.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, origen = "retirado", aNorteM = null, aAlt = null))
        banco.pasar(300)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        assertTrue("ya estaba a la altura: no hay bajada", dron.ordenes.none { it.startsWith("volarHaciaA") })
    }

    @Test
    fun unRelayTargetViejoNoCambiaLaEstimacion() = runBlocking {
        enCamino()
        esperarA("la primera orden") { dron.ultimoDestino != null }
        val antes = dron.ultimoDestino!!
        // ts 1500 < 2000: viejo. Movería el objetivo 300 m al este.
        banco.hub(relayTarget(7, 12, objetivo(12, 600.0, esteM = 300.0), ts = 1_500, aNorteM = 600.0))
        banco.pasar(1_100)
        esperarA("otra orden de tránsito") { dron.ordenes.count { it == "volarHacia" } >= 2 }
        val despues = dron.ultimoDestino!!
        assertEquals(antes.second, despues.second, 1e-6)
    }

    @Test
    fun unaDeteccionDeLaMismaClaseCercaDeLaEstimacionAdelantaLaToma() = runBlocking {
        enCamino()
        // B a 400 m al norte, a 60 m, mirando al norte con la cámara a −30°.
        banco.telemetria(norteM = 400.0, bateria = 90.0, alt = 60.0, gimbal = -30.0)
        val (pLat, pLon) = punto(400.0)
        val visto = Georreferencia.proyectar(pLat, pLon, 60.0, 0.0, -30.0, 0.5, 0.5)!!
        val (oLat, oLon) = punto(600.0)
        assertTrue("lo que B mira queda lejos del objetivo original", Geo.distanciaM(oLat, oLon, visto.lat, visto.lon) > 70.0)
        // Un objetivo que A ve justo donde B lo está mirando, a 20 m de lo que B ve
        val cerca = objetivo(12, (visto.lat - BancoDeRelevos.BASE_LAT) * Geo.METROS_POR_GRADO_LAT + 20.0)
        banco.hub(relayTarget(7, 12, cerca, ts = 3_000, aNorteM = 600.0))
        val otraClase = Deteccion(listOf("VEHICLE"), 0.9, listOf(Caja("VEHICLE", 0.9, 0.5, 0.5, 0.05, 0.05)), null, 1L)
        banco.deteccion.onDetection?.invoke(otraClase)
        delay(200)
        assertTrue("otra clase se descarta", banco.mensajes("relay_ready").isEmpty())
        assertTrue("sin alertas propias", banco.comando.alertas.isEmpty())

        val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), null, 2L)
        banco.deteccion.onDetection?.invoke(persona)
        esperarA("la toma adelantada") { banco.mensajes("relay_ready").isNotEmpty() }
        assertTrue(banco.comando.alertas.isEmpty())
    }

    @Test
    fun siNoTerminaDeSubirAterrizaYAborta() = runBlocking {
        disponible()
        banco.hub(relayTracking(7, 12, quieto))
        aceptado(7)
        banco.pasar(10_000)
        esperarA("el despegue") { dron.ordenes.any { it.startsWith("despegarHasta") } }
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.pasar(PatrolManager.SUBIDA_MAXIMA_MS + 1)
        esperarA("el relay_abort") { banco.mensajes("relay_abort").isNotEmpty() }
        assertEquals("subida", banco.ultimo("relay_abort").getString("motivo"))
        esperarA("aterriza en vez de quedar suspendido") { dron.ultimaOrden == "land" }
    }

    @Test
    fun unRechazoDelDronAlDespegarEnTierraEsUnRelayReject() = runBlocking {
        disponible()
        banco.hub(relayTracking(7, 12, quieto))
        aceptado(7)
        banco.pasar(10_000)
        esperarA("el despegue") { dron.ordenes.any { it.startsWith("despegarHasta") } }
        banco.evento(FlightEvent.Problema("los motores no arrancaron"))
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(7))
        esperarA("el reposo") { patrulla.state.value == PatrolState.IDLE }
    }

    @Test
    fun sinSenialEnElRelevoAbortaYAlRecuperarlaVuelveASuBase() = runBlocking {
        enCamino()
        banco.relojDeLaSenial.adelantar(PatrolManager.SIGNAL_TIMEOUT_MS + 1_000)
        esperarA("el relay_abort por la señal", topeMs = 3_000) { banco.mensajes("relay_abort").isNotEmpty() }
        assertEquals("senial", banco.ultimo("relay_abort").getString("motivo"))
        esperarA("la espera de la señal") { patrulla.state.value == PatrolState.RETURNING_HOME_SIGNAL }

        banco.telemetria(norteM = 200.0, bateria = 90.0, alt = 60.0)
        esperarA("el regreso a su base") { patrulla.state.value == PatrolState.RETURNING_HOME }
        esperarA("la orden de volver") { dron.ultimaOrden == "returnHome" }
    }

    @Test
    fun unRelayCancelEnElAireLoMandaASuBaseNuncaAPatrullar() = runBlocking {
        enCamino()
        banco.hub(relayCancel(7, "alerta_descartada"))
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        esperarA("la orden de volver") { dron.ultimaOrden == "returnHome" }
        assertFalse(dron.ordenes.any { it.startsWith("startRoute") })
    }

    /** B ya tomó el objetivo y lo está siguiendo por su cuenta. */
    private suspend fun siguiendoLoAdoptado() {
        enCamino()
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, origen = "retirado", aNorteM = null, aAlt = null))
        banco.pasar(300)
        esperarA("la bajada") { "volarHaciaA(40)" in dron.ordenes }
        banco.evento(FlightEvent.GotoArrived)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    @Test
    fun elDescarteDeUnSeguimientoAdoptadoLoMandaASuBase() = runBlocking {
        siguiendoLoAdoptado()
        banco.comando.recibir(JSONObject().put("type", "alert_decision").put("alertId", 12).put("decision", "DISMISSED").put("decidedBy", "op"))
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        esperarA("la orden de volver") { dron.ultimaOrden == "returnHome" }
        assertNull(patrulla.objetivo)
    }

    @Test
    fun reanudarConUnSeguimientoAdoptadoLoMandaASuBase() = runBlocking {
        siguiendoLoAdoptado()
        banco.comando.recibir(JSONObject().put("type", "resume_patrol").put("orderedBy", "op"))
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        assertFalse(dron.ordenes.any { it.startsWith("startRoute") })
        assertTrue(banco.comando.eventos("TRACKING_ENDED").isNotEmpty())
    }

    @Test
    fun unaOrdenDelOperadorCancelaElRelevoSinAvisarNada() = runBlocking {
        enCamino()
        banco.comando.recibir(JSONObject().put("type", "stop_patrol").put("orderedBy", "op"))
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }
        assertTrue("el hub ya lo canceló de su lado", banco.mensajes("relay_abort").isEmpty() && banco.mensajes("relay_reject").isEmpty())
        esperarA("el status sin relevo") { banco.mensajes("status").lastOrNull()?.getJSONObject("relevo")?.isNull("relayId") == true }
    }

    @Test
    fun tomarYSoltarElControlRetomaElRelevo() = runBlocking {
        enCamino()
        banco.comando.recibir(JSONObject().put("type", "control_taken").put("by", "op"))
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        banco.comando.recibir(JSONObject().put("type", "control_released").put("by", "op"))
        esperarA("de vuelta al relevo") { patrulla.state.value == PatrolState.RELEVANDO }
        assertTrue("tomar el control no canceló nada", banco.mensajes("relay_abort").isEmpty())
    }

    @Test
    fun laBateriaDeBEnElUmbralAbortaYVuelve() = runBlocking {
        enCamino()
        banco.telemetria(norteM = 200.0, bateria = 24.0, alt = 60.0)
        esperarA("el relay_abort") { banco.mensajes("relay_abort").isNotEmpty() }
        assertEquals("bateria", banco.ultimo("relay_abort").getString("motivo"))
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
    }

    @Test
    fun volverABaseDesdeElTelefonoAbortaPorOrdenDeCampo() = runBlocking {
        enCamino()
        patrulla.volverABase()
        esperarA("el relay_abort") { banco.mensajes("relay_abort").isNotEmpty() }
        assertEquals("orden_de_campo", banco.ultimo("relay_abort").getString("motivo"))
        assertEquals(PatrolState.RETURNING_HOME, patrulla.state.value)
    }

    // ---- Bordes de B ----

    @Test
    fun esperandoElGoTambienSeSigueMirandoLaDisponibilidad() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        banco.pasar(10_000)
        esperarA("la espera del go") { patrulla.cuentaRegresiva.value?.esperandoQueBajeA == true }
        assertTrue(patrulla.ponerEnEspera(false))
        banco.pasar(200)
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(5))
    }

    @Test
    fun sinElGoPasadoElTopeSeOlvidaSinDespegar() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        banco.pasar(10_000)
        esperarA("la espera del go") { patrulla.cuentaRegresiva.value?.esperandoQueBajeA == true }
        banco.pasar(PatrolManager.ESPERA_DEL_GO_MAXIMA_MS)
        esperarA("el fin de la espera") { patrulla.cuentaRegresiva.value == null }
        assertTrue("el hub ya lo dio por fallido: no se contesta nada", banco.mensajes("relay_reject").isEmpty())
        banco.hub(relayGo(5))
        delay(100)
        assertFalse(dron.ordenes.any { it.startsWith("startRoute") })
    }

    @Test
    fun unGoConElDronYaNoDisponibleNoDespega() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        banco.pasar(10_000)
        esperarA("la espera del go") { patrulla.cuentaRegresiva.value?.esperandoQueBajeA == true }
        // El operador toma el control y el go llega enseguida, sin que el lazo vuelva a mirar.
        banco.comando.recibir(JSONObject().put("type", "control_taken").put("by", "op"))
        banco.comando.recibir(relayGo(5))
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(5))
        assertFalse(dron.ordenes.any { it.startsWith("startRoute") })
    }

    @Test
    fun siElSdkFallaAlHabilitarElMandoVirtualRechazaSinDespegar() = runBlocking {
        disponible()
        dron.fallaDelMandoVirtual = IllegalStateException("el SDK no contestó")
        banco.hub(relayStart(5))
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("virtual_stick", motivoDelRechazo(5))
    }

    @Test
    fun unRelayTargetDeOtroRelevoSeIgnora() = runBlocking {
        enCamino()
        esperarA("la primera orden") { dron.ultimoDestino != null }
        val antes = dron.ultimoDestino!!
        banco.hub(relayTarget(8, 12, objetivo(12, 600.0, esteM = 300.0), ts = 9_000, aNorteM = 600.0))
        banco.hub(relayTarget(7, 13, objetivo(13, 600.0, esteM = 300.0), ts = 9_000, aNorteM = 600.0))
        banco.pasar(1_100)
        esperarA("otra orden de tránsito") { dron.ordenes.count { it == "volarHacia" } >= 2 }
        assertEquals(antes.second, dron.ultimoDestino!!.second, 1e-6)
    }

    @Test
    fun siAterrizaEnCaminoAbortaElRelevo() = runBlocking {
        enCamino()
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.Aterrizado)
        esperarA("el relay_abort") { banco.mensajes("relay_abort").isNotEmpty() }
        assertEquals("otro", banco.ultimo("relay_abort").getString("motivo"))
    }

    @Test
    fun unGoDeUnRelevoDeSeguimientoNoCambiaNada() = runBlocking {
        disponible()
        banco.hub(relayTracking(7, 12, quieto))
        aceptado(7)
        banco.hub(relayGo(7))
        delay(100)
        assertFalse("el seguimiento no espera ningún go", dron.ordenes.any { it.startsWith("despegarHasta") })
        assertEquals(10, patrulla.cuentaRegresiva.value!!.segundos)
    }
}
