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
 * cada orden reevaluando su disponibilidad entera, prepara el despegue (el
 * mando virtual) en el suelo antes de los motores, corre la cuenta regresiva
 * de 10 s con «Cancelar», despega solo cuando corresponde, y en un seguimiento
 * se detiene a la distancia de toma, 20 m por encima de A, y baja recién con A
 * lejos.
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

    private fun detalleDelRechazo(relayId: Long): String =
        banco.mensajes("relay_reject").last { it.getLong("relayId") == relayId }.getString("detalle")

    private suspend fun aceptado(relayId: Long) {
        esperarA("el relay_accept del relevo #$relayId") {
            banco.mensajes("relay_accept").any { it.getLong("relayId") == relayId }
        }
        esperarA("la cuenta regresiva") { patrulla.cuentaRegresiva.value?.habilitando == false }
    }

    private suspend fun tomarElControl() {
        banco.comando.recibir(JSONObject().put("type", "control_taken").put("by", "op"))
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
    }

    private fun soltarElControl() {
        banco.comando.recibir(JSONObject().put("type", "control_released").put("by", "op"))
    }

    private fun enElRegistro(texto: String): Boolean = patrulla.localLog.replayCache.any { it.contains(texto) }

    // ---- Relevo de patrulla ----

    @Test
    fun aceptaElRelevoDePatrullaYDespegaRecienConElGo() = runBlocking {
        disponible()
        banco.hub(relayStart(5, fromIndex = 1))
        aceptado(5)
        val ordenes = dron.ordenes
        assertTrue("el despegue (el mando virtual) se prepara en el suelo, antes de los motores", "prepararDespegue" in ordenes)
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
        assertFalse("despegó: el mando no vuelve a las palancas", "soltarDespegue" in dron.ordenes)
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
        assertFalse("ni intenta el mando virtual", "prepararDespegue" in dron.ordenes)
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
    fun cancelarEnElTelefonoNoDespegaYLeDevuelveElMandoALasPalancas() = runBlocking {
        disponible()
        banco.hub(relayStart(5))
        aceptado(5)
        patrulla.cancelarRelevoEnCampo()
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("cancelado_en_campo", motivoDelRechazo(5))
        assertEquals("Cancelado desde el teléfono", banco.ultimo("relay_reject").getString("detalle"))
        assertNull(patrulla.cuentaRegresiva.value)
        assertTrue("el mando virtual preparado se suelta", "soltarDespegue" in dron.ordenes)
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
        assertTrue("soltarDespegue" in dron.ordenes)
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

    /** B aceptó un seguimiento y terminó la cuenta: en la plataforma, subiendo ([despegarHasta] ya salió). */
    private suspend fun despegando(aAlt: Double? = 40.0) {
        disponible()
        banco.hub(relayTracking(7, 12, quieto, ts = 1_000))
        aceptado(7)
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 600.0, aAlt = aAlt))
        banco.pasar(10_000)
        esperarA("el despegue sin esperar ningún go") { dron.ordenes.any { it.startsWith("despegarHasta") } }
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)
    }

    /** B despegó para un seguimiento y ya está arriba, en camino. */
    private suspend fun enCamino(aAlt: Double = 40.0) {
        despegando(aAlt)
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.evento(FlightEvent.Despegando)
        banco.telemetria(norteM = 5.0, bateria = 94.0, alt = 60.0)
        banco.evento(FlightEvent.EnElAire)
    }

    /** B llegó a la distancia de toma, 20 m por encima de A: mandó `relay_ready` y espera que A se aleje. */
    private suspend fun enLaToma() {
        enCamino()
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
    }

    @Test
    fun elSeguimientoDespegaSinGoSubeYVaHaciaElPuntoDeToma() = runBlocking {
        enCamino(aAlt = 50.0)
        assertTrue("sube 20 m por encima de A: 50 + 20", "despegarHasta(70.0)" in dron.ordenes)
        assertEquals(1, banco.comando.eventos("TAKEOFF").count { it.getString("message").contains("relevar") || it.getString("message").contains("relevo") })
        esperarA("la orden de tránsito") { dron.ultimoDestino != null }
        assertTrue("el tránsito sostiene la altura pedida", "cambiarAltura(70)" in dron.ordenes)
        val (lat, lon) = dron.ultimoDestino!!
        val (oLat, oLon) = punto(600.0)
        assertEquals("se detiene a 60 m del objetivo, del lado por el que llega", 60.0, Geo.distanciaM(oLat, oLon, lat, lon), 1.0)
        assertTrue("del lado de B (al sur)", lat < oLat)
    }

    @Test
    fun alLlegarALaTomaSembraElRastreadorYAvisaQueEstaListo() = runBlocking {
        enLaToma()
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

        // A ya está a más de 100 m: B baja EN EL LUGAR, en vertical, a la altura
        // a la que A lo seguía (40 m) y recién ahí lo sigue; el relevo terminó.
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, aNorteM = 720.0))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
        val despuesDeLaBajada = dron.ordenes.dropWhile { it != "cambiarAltura(40)" }
        assertFalse("baja donde está, sin ir a ningún lado", "volarHacia" in despuesDeLaBajada)
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)
        // Llegó a la altura de seguimiento (40 + la tolerancia): empieza a seguir.
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 41.5)
        banco.pasar(300)
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

    /**
     * Un operador detuvo a A (stop_patrol): el hub lo cuenta como relay_abandon
     * y lo marca "retirado", pero A queda quieto sobre su órbita, a 30 m del
     * objetivo y a la altura a la que B bajaría. B NO baja ni orbita: sigue en
     * la toma, por encima, hasta ver a A lejos o en tierra.
     */
    @Test
    fun conADetenidoSobreSuOrbitaNoBajaNiOrbita() = runBlocking {
        enLaToma()
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, origen = "retirado", aNorteM = 630.0))
        // El hub repite el retirado con cada status de A: se avisa una sola vez.
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, origen = "retirado", aNorteM = 630.0))
        assertEquals(1, patrulla.localLog.replayCache.count { it.contains("Alfa ya no sigue al objetivo") })
        val tomas = dron.ordenes.count { it == "volarHacia" }
        banco.pasar(1_100)
        banco.pasar(1_100)
        esperarA("sigue sosteniendo la toma") { dron.ordenes.count { it == "volarHacia" } > tomas }
        assertTrue("no baja a la altura de A", dron.ordenes.none { it == "cambiarAltura(40)" })
        assertFalse("ni orbita encima de A", "startOrbit" in dron.ordenes)
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)
        // Retirado y sin la posición de A, tampoco.
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, origen = "retirado", aNorteM = null))
        banco.pasar(1_100)
        assertTrue(dron.ordenes.none { it == "cambiarAltura(40)" })

        // A aterrizó donde estaba: ahora sí.
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, origen = "retirado", aNorteM = 630.0, aAlt = 0.0, aEnTierra = true))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
        // El hub lo repite con cada status de A: se avisa una sola vez.
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, origen = "retirado", aNorteM = 630.0, aAlt = 0.0, aEnTierra = true))
        assertEquals(1, patrulla.localLog.replayCache.count { it == "Alfa ya está en tierra" })
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 41.5)
        banco.pasar(300)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    /**
     * A arranca el regreso del DJI ahí mismo (el alejamiento venció, llegó a su
     * piso, apretaron el botón del control): el regreso sube en vertical hasta
     * su altura de regreso. El hub ya no lo da por retirado por su estado: B
     * sigue viendo dónde está y baja recién con A a más de 100 m.
     */
    @Test
    fun conAVolviendoDesdeElObjetivoBajaRecienConALejos() = runBlocking {
        enLaToma()
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 610.0, aAlt = 55.0))
        banco.pasar(1_100)
        assertTrue("A sube al lado: B no baja", dron.ordenes.none { it == "cambiarAltura(40)" })
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 680.0, aAlt = 70.0))
        banco.pasar(1_100)
        assertTrue("a 80 m todavía no", dron.ordenes.none { it == "cambiarAltura(40)" })
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 720.0, aAlt = 75.0))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
        assertTrue("el aviso dice por qué", enElRegistro("Alfa ya se alejó"))
    }

    /**
     * `retirado` llega con el `ts` del último objetivo válido (el hub no tiene
     * uno nuevo): el origen y la posición de A se leen igual, aunque el
     * objetivo se descarte por viejo. Si no, B esperaría arriba para siempre a
     * un A que ya se fue.
     */
    @Test
    fun unRetiradoConElTsDelUltimoObjetivoIgualHaceBajar() = runBlocking {
        enLaToma()
        // El mismo ts que el último aplicado (2000), con un objetivo corrido que no se tiene que tomar.
        banco.hub(relayTarget(7, 12, objetivo(12, 900.0), ts = 2_000, origen = "retirado", aNorteM = 720.0, aAlt = null))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
        assertEquals("el objetivo viejo no pisó la estimación", quieto.getDouble("lat"), patrulla.objetivo!!.lat, 1e-6)

        // Una vez que baja no vuelve a subir: un en_linea posterior con A cerca no lo frena.
        banco.hub(relayTarget(7, 12, quieto, ts = 5_000, aNorteM = 600.0))
        banco.pasar(300)
        assertEquals("sigue bajando, sin volver a subir", 1, dron.ordenes.count { it == "cambiarAltura(40)" })
        assertEquals("ni al punto de toma", 0, dron.ordenes.dropWhile { it != "cambiarAltura(40)" }.count { it == "volarHacia" })
        // La bajada no se confirma (el dron no avisa su altura): pasado el tope, sigue igual desde donde está.
        banco.pasar(PatrolManager.BAJADA_MAXIMA_MS)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    /**
     * B se reconecta en la toma: el hub le reenvía el relay_tracking y la app lo
     * contesta con el mismo relay_accept. Nada más: el seguimiento adoptado y
     * el traspaso siguen igual (el hub ya no contesta ese accept con un
     * relay_cancel).
     */
    @Test
    fun unRelayTrackingRepetidoEnElTraspasoSeContestaIgualYSigueConElObjetivo() = runBlocking {
        enLaToma()
        banco.hub(relayTracking(7, 12, quieto, ts = 1_000))
        esperarA("la misma respuesta") { banco.mensajes("relay_accept").size == 2 }
        banco.pasar(1_100)
        assertEquals("sigue con el objetivo adoptado", 12L, patrulla.objetivo!!.alertId)
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)
        assertTrue(banco.mensajes("relay_abort").isEmpty() && banco.mensajes("relay_reject").isEmpty())
        assertTrue("ni lo da por perdido", banco.comando.eventos("TRACKING_ENDED").isEmpty())
        esperarA("el status sigue en el traspaso") {
            banco.mensajes("status").lastOrNull()?.optJSONObject("relevo")?.optString("fase") == "traspaso"
        }
        // y baja cuando A se va, como siempre
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 720.0))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
    }

    @Test
    fun unSinEnlaceConACercaNoDejaBajar() = runBlocking {
        enLaToma()
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, origen = "sin_enlace", aNorteM = 600.0))
        banco.pasar(1_100)
        assertEquals("sin_enlace no deja bajar: A puede seguir encima", PatrolState.RELEVANDO, patrulla.state.value)
        assertTrue(dron.ordenes.none { it == "cambiarAltura(40)" })
    }

    /**
     * En el traspaso A ya soltó su rastreador y manda el status sin objetivo: el
     * hub repite el `ts` del último objetivo con la posición NUEVA de A
     * (PROTOCOLS §2.b). El `ts` ordena solo el objetivo, así que B toma la
     * posición de A igual y baja con A a más de 100 m, sin esperar el `retirado`.
     */
    @Test
    fun unEnLineaConElTsRepetidoTraeLaPosicionDeAYHaceBajar() = runBlocking {
        enLaToma()
        // A sigue encima: con el ts repetido tampoco baja.
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 610.0))
        banco.pasar(1_100)
        assertTrue(dron.ordenes.none { it == "cambiarAltura(40)" })
        // ts 2000 = el último aplicado; el objetivo corrido que trae no se toma.
        banco.hub(relayTarget(7, 12, objetivo(12, 900.0), ts = 2_000, aNorteM = 720.0))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
        assertEquals("el objetivo repetido no pisó la estimación", quieto.getDouble("lat"), patrulla.objetivo!!.lat, 1e-6)
        assertFalse("A sigue en línea: no se lo da por retirado", enElRegistro("ya no sigue al objetivo"))
    }

    /** La altura de A también es del último status: si A sube con el `ts` repetido, B sube igual. */
    @Test
    fun siASubeConElTsRepetidoBSubeIgual() = runBlocking {
        enCamino(aAlt = 40.0)
        esperarA("la orden de tránsito") { dron.ultimoDestino != null }
        // A perdió el objetivo un momento (su status no trae uno que pase) y subió: el mismo ts 2000.
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 600.0, aAlt = 55.0))
        esperarA("la subida") { "cambiarAltura(75)" in dron.ordenes }
    }

    /**
     * La decisión es la de la alerta en el hub al mandar el mensaje: una
     * validación que llega con el `ts` repetido (el status de A no traía un
     * objetivo que pase) se toma igual, y la toma sale con ella.
     */
    @Test
    fun laDecisionDeLaAlertaSeTomaAunqueElTsSeRepita() = runBlocking {
        val pendiente = objetivo(12, 600.0, decision = "PENDING")
        disponible()
        banco.hub(relayTracking(7, 12, pendiente, ts = 1_000))
        aceptado(7)
        banco.hub(relayTarget(7, 12, pendiente, ts = 2_000, aNorteM = 600.0))
        banco.pasar(10_000)
        esperarA("el despegue") { dron.ordenes.any { it.startsWith("despegarHasta") } }
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.evento(FlightEvent.Despegando)
        banco.telemetria(norteM = 5.0, bateria = 94.0, alt = 60.0)
        banco.evento(FlightEvent.EnElAire)
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 600.0))
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        assertEquals("VALIDATED", patrulla.objetivo!!.decision)
    }

    /**
     * Sin un solo `relay_target` lo más probable es que B haya perdido el enlace
     * con el hub: nadie le puede decir si A se fue, así que NO baja (RELEVOS
     * §3.5). Sigue al objetivo desde la toma, a la altura de A + 20, con el
     * relevo en curso —el status lo sigue diciendo, y una reconexión no lo da
     * por perdido—, y baja recién cuando el hub vuelve y dice que A se fue.
     */
    @Test
    fun sinNoticiasDelHubNoBajaYSigueEnElRelevo() = runBlocking {
        enLaToma()
        banco.pasar(PatrolManager.SILENCIO_DEL_HUB_MS + 1_000)
        esperarA("el aviso del silencio") { enElRegistro("Sin noticias de Alfa") }
        val tomas = dron.ordenes.count { it == "volarHacia" }
        banco.pasar(1_100)
        esperarA("sigue sosteniendo la toma") { dron.ordenes.count { it == "volarHacia" } > tomas }
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)
        assertTrue("no baja a la altura de A", dron.ordenes.none { it == "cambiarAltura(40)" })
        assertTrue("ni lo da por completo", banco.comando.eventos("TRACKING_RESUMED").isEmpty())
        esperarA("el status con el relevo en curso") {
            banco.mensajes("status").lastOrNull()?.optJSONObject("relevo")?.let {
                it.optLong("relayId") == 7L && it.optString("fase") == "traspaso"
            } == true
        }
        assertEquals("se avisa una sola vez", 1, patrulla.localLog.replayCache.count { it.contains("Sin noticias de Alfa") })

        // El hub vuelve y dice que A se fue: recién ahí baja.
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, origen = "retirado", aNorteM = 720.0, aAlt = null))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
    }

    @Test
    fun unaAlturaDeAQueNoVieneNoBorraLaUltima() = runBlocking {
        enCamino(aAlt = 30.0)
        assertTrue("despegarHasta(60.0)" in dron.ordenes)
        // El hub manda un target sin la altura de A: la de 30 m sigue valiendo.
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 600.0, aAlt = null))
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, origen = "retirado", aNorteM = 720.0, aAlt = null))
        banco.pasar(300)
        esperarA("la bajada a la altura de A, no a la de por defecto") { "cambiarAltura(30)" in dron.ordenes }
    }

    @Test
    fun yaALaAlturaDeSeguimientoSigueEnElActo() = runBlocking {
        enCamino(aAlt = 30.0)
        // El dron quedó a 31 m (la de A, 30, más la tolerancia): no hay bajada.
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 31.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, origen = "retirado", aNorteM = 720.0, aAlt = null))
        banco.pasar(300)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        assertTrue("ya estaba a la altura: no hay bajada", dron.ordenes.none { it == "cambiarAltura(30)" })
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

    // ---- La separación con A (RELEVOS §3.5) ----

    @Test
    fun sinLaAlturaDeANoDespega() = runBlocking {
        disponible()
        banco.hub(relayTracking(7, 12, quieto, ts = 1_000))
        aceptado(7)
        // Ningún relay_target trajo la altura de A.
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 600.0, aAlt = null))
        banco.pasar(10_000)
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(7))
        assertTrue(detalleDelRechazo(7).contains("no se sabe a qué altura vuela Alfa"))
        assertFalse(dron.ordenes.any { it.startsWith("despegarHasta") })
        assertTrue("el mando vuelve a las palancas", "soltarDespegue" in dron.ordenes)
        assertEquals(PatrolState.IDLE, patrulla.state.value)
    }

    /** B sube en vertical y cruza la altura de A: no despega al lado del objetivo. */
    @Test
    fun conElObjetivoAMenosDeCienMetrosNoDespega() = runBlocking {
        val cerca = objetivo(12, 85.0)
        disponible()
        banco.hub(relayTracking(7, 12, cerca, ts = 1_000))
        aceptado(7)
        banco.hub(relayTarget(7, 12, cerca, ts = 2_000, aNorteM = 400.0))
        banco.pasar(10_000)
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(7))
        assertTrue(detalleDelRechazo(7), detalleDelRechazo(7).startsWith("el objetivo está a 80 m"))
        assertFalse(dron.ordenes.any { it.startsWith("despegarHasta") })
        assertEquals(PatrolState.IDLE, patrulla.state.value)
    }

    /** Ni al lado de A, aunque el objetivo esté lejos: A lo sigue y puede pasar por encima de la base. */
    @Test
    fun conAAMenosDeCienMetrosNoDespega() = runBlocking {
        disponible()
        banco.hub(relayTracking(7, 12, quieto, ts = 1_000))
        aceptado(7)
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 70.0))
        banco.pasar(10_000)
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertTrue(detalleDelRechazo(7), detalleDelRechazo(7).startsWith("Alfa está a 65 m"))
        assertFalse(dron.ordenes.any { it.startsWith("despegarHasta") })
    }

    @Test
    fun conAPorEncimaDeCienMetrosNoDespega() = runBlocking {
        disponible()
        banco.hub(relayTracking(7, 12, quieto, ts = 1_000))
        aceptado(7)
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 600.0, aAlt = 105.0))
        banco.pasar(10_000)
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertTrue("125 m no se recorta a 120: B quedaría a 15 m de A", detalleDelRechazo(7).contains("pasa el techo de 120 m"))
        assertFalse(dron.ordenes.any { it.startsWith("despegarHasta") })
    }

    @Test
    fun siASubeEnElCaminoBSubeTambienYSiBajaNo() = runBlocking {
        enCamino(aAlt = 40.0)
        esperarA("la orden de tránsito") { dron.ultimoDestino != null }
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 600.0, aAlt = 55.0))
        esperarA("la subida") { "cambiarAltura(75)" in dron.ordenes }
        val cambios = dron.ordenes.count { it.startsWith("cambiarAltura") }
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, aNorteM = 600.0, aAlt = 30.0))
        delay(100)
        assertEquals("si A baja, B no se le acerca", cambios, dron.ordenes.count { it.startsWith("cambiarAltura") })
    }

    @Test
    fun siASubeDemasiadoEnElAireDejaElRelevoYVuelve() = runBlocking {
        enCamino()
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 600.0, aAlt = 101.0))
        esperarA("el relay_abort") { banco.mensajes("relay_abort").isNotEmpty() }
        assertEquals("otro", banco.ultimo("relay_abort").getString("motivo"))
        assertTrue(banco.ultimo("relay_abort").getString("detalle").contains("120"))
        esperarA("el regreso a su base") { patrulla.state.value == PatrolState.RETURNING_HOME }
        assertEquals("returnHome", dron.ultimaOrden)
    }

    /** En la plataforma no se le cambia la altura: la nueva sale al llegar arriba. */
    @Test
    fun siASubeMientrasBDespegaLaSubeAlLlegarArriba() = runBlocking {
        despegando()
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 600.0, aAlt = 55.0))
        delay(100)
        assertTrue("en el suelo no se cambia la altura", dron.ordenes.none { it.startsWith("cambiarAltura") })
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.telemetria(norteM = 5.0, bateria = 94.0, alt = 60.0)
        banco.evento(FlightEvent.EnElAire)
        esperarA("la altura nueva antes del tránsito") { "cambiarAltura(75)" in dron.ordenes }
    }

    /** Con el control tomado tampoco: la persona tiene el dron, y al soltarlo sube a la nueva. */
    @Test
    fun siASubeConElControlTomadoLaSubeAlSoltarlo() = runBlocking {
        enCamino()
        tomarElControl()
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 600.0, aAlt = 55.0))
        delay(100)
        assertFalse("cambiarAltura(75)" in dron.ordenes)
        soltarElControl()
        esperarA("la altura nueva al soltarlo") { "cambiarAltura(75)" in dron.ordenes }
    }

    @Test
    fun siASubeDemasiadoEnElTraspasoSueltaElObjetivoYVuelve() = runBlocking {
        enLaToma()
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 610.0, aAlt = 110.0))
        esperarA("el relay_abort") { banco.mensajes("relay_abort").isNotEmpty() }
        assertTrue("suelta el objetivo que había tomado", banco.comando.eventos("TRACKING_ENDED").isNotEmpty())
        assertNull(patrulla.objetivo)
        esperarA("el regreso a su base") { patrulla.state.value == PatrolState.RETURNING_HOME }
    }

    @Test
    fun siASubeDemasiadoMientrasDespegaNoDespega() = runBlocking {
        despegando()
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, aNorteM = 600.0, aAlt = 105.0))
        esperarA("el rechazo: todavía no dejó la plataforma") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(7))
        assertEquals("el despegue en curso se aborta", "land", dron.ultimaOrden)
        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertTrue(banco.mensajes("relay_abort").isEmpty())
    }

    // ---- La toma adelantada y la estimación del objetivo (RELEVOS §3.4) ----

    private val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), null, 2L)

    /**
     * B lo ve con su cámara antes de llegar: a 400 m al norte, a 60 m, mirando
     * al norte con la cámara a −30°, y A lo ve 20 m más allá de donde B mira.
     */
    private suspend fun tomaAdelantada() {
        enCamino()
        banco.telemetria(norteM = 400.0, bateria = 90.0, alt = 60.0, gimbal = -30.0)
        val (pLat, pLon) = punto(400.0)
        val visto = Georreferencia.proyectar(pLat, pLon, 60.0, 0.0, -30.0, 0.5, 0.5)!!
        val cerca = objetivo(12, (visto.lat - BancoDeRelevos.BASE_LAT) * Geo.METROS_POR_GRADO_LAT + 20.0)
        banco.hub(relayTarget(7, 12, cerca, ts = 3_000, aNorteM = 600.0))
        banco.deteccion.onDetection?.invoke(persona)
        esperarA("la toma adelantada") { banco.mensajes("relay_ready").isNotEmpty() }
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

        banco.deteccion.onDetection?.invoke(persona)
        esperarA("la toma adelantada") { banco.mensajes("relay_ready").isNotEmpty() }
        assertTrue(banco.comando.alertas.isEmpty())
    }

    /** En el traspaso las detecciones de B siguen alimentando su rastreador: no se tiran. */
    @Test
    fun enElTraspasoSusDeteccionesSiguenActualizandoAlObjetivo() = runBlocking {
        tomaAdelantada()
        banco.reloj.adelantar(3_000)
        assertTrue("hace 3 s que no lo ve", patrulla.objetivo!!.vistoHaceMs >= 3_000)
        banco.deteccion.onDetection?.invoke(persona)
        esperarA("la detección propia en el rastreador") { patrulla.objetivo!!.vistoHaceMs == 0L }
        assertEquals(PatrolState.RELEVANDO, patrulla.state.value)
        assertTrue("sin alertas propias", banco.comando.alertas.isEmpty())
    }

    /**
     * Una sola detección propia (la que adelantó la toma) no puede dejar a B
     * sin la estimación de A: si A lo vio después, la de A manda.
     */
    @Test
    fun siALoVioDespuesQueBLaEstimacionDeAManda() = runBlocking {
        tomaAdelantada()
        banco.reloj.adelantar(6_000)
        val corrido = objetivo(12, 520.0, esteM = 30.0, vistoHaceMs = 400)
        banco.hub(relayTarget(7, 12, corrido, ts = 4_000, aNorteM = 600.0))
        esperarA("la estimación de A") { kotlin.math.abs(patrulla.objetivo!!.lon - corrido.getDouble("lon")) < 1e-9 }
        assertEquals(corrido.getDouble("lat"), patrulla.objetivo!!.lat, 1e-9)
        assertEquals(400L, patrulla.objetivo!!.vistoHaceMs)
    }

    @Test
    fun siBLoVioDespuesQueASuEstimacionSeQueda() = runBlocking {
        tomaAdelantada()
        val antes = patrulla.objetivo!!
        val corrido = objetivo(12, 520.0, esteM = 30.0, vistoHaceMs = 2_000)
        banco.hub(relayTarget(7, 12, corrido, ts = 4_000, aNorteM = 600.0))
        delay(100)
        val ahora = patrulla.objetivo!!
        assertEquals(antes.lat, ahora.lat, 1e-9)
        assertEquals(antes.lon, ahora.lon, 1e-9)
        assertTrue(Geo.distanciaM(ahora.lat, ahora.lon, corrido.getDouble("lat"), corrido.getDouble("lon")) > 20.0)
    }

    // ---- Bordes de la subida ----

    @Test
    fun siNoTerminaDeSubirAterrizaYAborta() = runBlocking {
        despegando()
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.pasar(PatrolManager.SUBIDA_MAXIMA_MS + 1)
        esperarA("el relay_abort") { banco.mensajes("relay_abort").isNotEmpty() }
        assertEquals("subida", banco.ultimo("relay_abort").getString("motivo"))
        esperarA("aterriza en vez de quedar suspendido") { dron.ultimaOrden == "land" }
    }

    @Test
    fun unRechazoDelDronAlDespegarEnTierraEsUnRelayReject() = runBlocking {
        despegando()
        banco.evento(FlightEvent.Problema("los motores no arrancaron"))
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(7))
        esperarA("el reposo") { patrulla.state.value == PatrolState.IDLE }
    }

    // ---- Una persona con el control de B (RELEVOS §3.9: tomar el control no cancela nada) ----

    /**
     * El operador toma el control de B a media subida: la app no se lo saca.
     * Ni el tope de la subida, ni un rechazo del dron, ni el aviso de que llegó
     * arriba lo aterrizan o lo mandan hacia el objetivo.
     */
    @Test
    fun conElControlTomadoDuranteLaSubidaNoSeLoSacan() = runBlocking {
        despegando()
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.telemetria(norteM = 5.0, bateria = 94.0, alt = 25.0)
        tomarElControl()
        banco.pasar(PatrolManager.SUBIDA_MAXIMA_MS + 1)
        banco.evento(FlightEvent.Problema("el dron rechazó el mando virtual"))
        banco.evento(FlightEvent.EnElAire)
        delay(200)
        assertTrue("el relevo sigue", banco.mensajes("relay_abort").isEmpty())
        assertFalse("land" in dron.ordenes)
        assertFalse("ni lo lleva hacia el objetivo", "volarHacia" in dron.ordenes)
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
    }

    @Test
    fun alSoltarloRetomaLaSubidaYSigueHaciaElObjetivo() = runBlocking {
        despegando()
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.telemetria(norteM = 5.0, bateria = 94.0, alt = 25.0)
        tomarElControl()
        banco.pasar(PatrolManager.SUBIDA_MAXIMA_MS + 1)
        soltarElControl()
        esperarA("de vuelta al relevo") { patrulla.state.value == PatrolState.RELEVANDO }
        esperarA("vuelve a subir, en vertical") { "cambiarAltura(60)" in dron.ordenes }
        assertFalse("todavía no va a ningún lado", "volarHacia" in dron.ordenes)
        // El tope de la subida cuenta desde que lo soltó: no aterriza por lo que tardó la persona.
        banco.pasar(1_000)
        assertTrue(banco.mensajes("relay_abort").isEmpty())

        banco.telemetria(norteM = 5.0, bateria = 94.0, alt = 59.0)
        banco.pasar(300)
        esperarA("en camino hacia el objetivo") { "volarHacia" in dron.ordenes }
        esperarA("el status en camino") {
            banco.mensajes("status").lastOrNull()?.optJSONObject("relevo")?.optString("fase") == "en_camino"
        }
    }

    @Test
    fun soltadoYSinTerminarDeSubirAterrizaComoSiempre() = runBlocking {
        despegando()
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        tomarElControl()
        soltarElControl()
        esperarA("de vuelta al relevo") { patrulla.state.value == PatrolState.RELEVANDO }
        banco.pasar(PatrolManager.SUBIDA_MAXIMA_MS + 1)
        esperarA("el relay_abort") { banco.mensajes("relay_abort").isNotEmpty() }
        assertEquals("subida", banco.ultimo("relay_abort").getString("motivo"))
        esperarA("aterriza") { dron.ultimaOrden == "land" }
    }

    @Test
    fun soltadoEnTierraAMediaSubidaNoDespegaSolo() = runBlocking {
        despegando()
        tomarElControl()
        soltarElControl()
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(7))
        assertTrue(detalleDelRechazo(7).contains("antes de que despegara"))
        esperarA("el reposo") { patrulla.state.value == PatrolState.IDLE }
    }

    @Test
    fun enUnRelevoDePatrullaAlSoltarloSigueLaRutaDeA() = runBlocking {
        disponible()
        banco.hub(relayStart(5, fromIndex = 1))
        aceptado(5)
        banco.pasar(10_000)
        banco.hub(relayGo(5))
        esperarA("el despegue") { "startRoute(1, 1)" in dron.ordenes }
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.evento(FlightEvent.Despegando)
        tomarElControl()
        banco.pasar(PatrolManager.SUBIDA_MAXIMA_MS + 1)
        assertFalse("land" in dron.ordenes)
        soltarElControl()
        esperarA("la ruta de A") { dron.ordenes.count { it == "startRoute(1, 1)" } == 2 }
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        esperarA("el relay_ready con la ruta arrancada") { banco.mensajes("relay_ready").size == 1 }
    }

    @Test
    fun tomarYSoltarElControlRetomaElRelevoALaAlturaDelTransito() = runBlocking {
        enCamino()
        tomarElControl()
        val antes = dron.ordenes.count { it == "cambiarAltura(60)" }
        soltarElControl()
        esperarA("de vuelta al relevo") { patrulla.state.value == PatrolState.RELEVANDO }
        assertTrue("tomar el control no canceló nada", banco.mensajes("relay_abort").isEmpty())
        assertEquals("la persona lo pudo dejar a cualquier altura", antes + 1, dron.ordenes.count { it == "cambiarAltura(60)" })
    }

    @Test
    fun tomarYSoltarElControlEnLaBajadaSigueBajando() = runBlocking {
        enLaToma()
        banco.hub(relayTarget(7, 12, quieto, ts = 3_000, origen = "retirado", aNorteM = 720.0, aAlt = null))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
        tomarElControl()
        soltarElControl()
        esperarA("de vuelta al relevo") { patrulla.state.value == PatrolState.RELEVANDO }
        assertEquals("sigue hacia la de seguimiento, no vuelve a la de A + 20", 2, dron.ordenes.count { it == "cambiarAltura(40)" })
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 41.0)
        banco.pasar(300)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    @Test
    fun unRelayCancelConElControlTomadoNoLoMandaACasa() = runBlocking {
        enCamino()
        tomarElControl()
        banco.hub(relayCancel(7, "alerta_descartada"))
        esperarA("el aviso") { enElRegistro("sigue en manos de quien tiene el control") }
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertFalse("returnHome" in dron.ordenes)
    }

    // ---- Otras salidas de B ----

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
        enLaToma()
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, origen = "retirado", aNorteM = 720.0, aAlt = null))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 41.0)
        banco.pasar(300)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    /**
     * Cumplido el relevo, el hub le sigue mandando a B dónde está A hasta que
     * A aterriza (PROTOCOLS §2.b): esos ya no le sirven, y no se anotan como
     * un mensaje fuera de lugar. Los de otro relevo, sí.
     */
    @Test
    fun losRelayTargetDelRelevoCumplidoSeIgnoranSinRuido() = runBlocking {
        siguiendoLoAdoptado()
        banco.hub(relayTarget(7, 12, quieto, ts = 9_000, origen = "retirado", aNorteM = 900.0))
        assertFalse(enElRegistro("relay_target de un relevo que no es el activo"))
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        banco.hub(relayTarget(8, 12, quieto, ts = 9_000, aNorteM = 900.0))
        esperarA("el aviso del otro") { enElRegistro("relay_target de un relevo que no es el activo") }
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
        assertFalse("en el aire no hay despegue que soltar", "soltarDespegue" in dron.ordenes)
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
        assertTrue("el mando vuelve a las palancas", "soltarDespegue" in dron.ordenes)
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
        // El operador toma el control y el go llega enseguida. Las dos órdenes
        // van en corrutinas propias: se espera que la toma esté hecha para que
        // el go no le gane la carrera (lo rechaza el go o el lazo, el que mire
        // primero).
        tomarElControl()
        banco.comando.recibir(relayGo(5))
        esperarA("el rechazo") { banco.mensajes("relay_reject").isNotEmpty() }
        assertEquals("no_disponible", motivoDelRechazo(5))
        assertFalse(dron.ordenes.any { it.startsWith("startRoute") })
    }

    @Test
    fun siElSdkFallaAlPrepararElDespegueRechazaSinDespegar() = runBlocking {
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
