package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.model.ObjetivoReportado
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
 * Los mensajes nuevos del contrato (docs/PROTOCOLS.md §1, §2 y §4) tal como
 * salen y entran de la app: el status sin GPS, el objetivo en seguimiento, los
 * eventos con su alerta y su posición, el acuse de una alerta, la decisión con
 * su id, el despegue y el aterrizaje desde la consola, el `frameTs` de la
 * detección y el "hola" del descubrimiento.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ContratoDelSeguimientoTest {

    private class ClienteQueAnota(alcance: CoroutineScope) : CommandCenterClient(alcance) {
        val enviados = mutableListOf<JSONObject>()
        override fun send(obj: JSONObject) {
            enviados += obj
        }
    }

    private val alcance = CoroutineScope(SupervisorJob())
    private val cliente = ClienteQueAnota(alcance)

    @After
    fun cortar() {
        alcance.cancel()
    }

    private fun status(lat: Double, lon: Double, objetivo: ObjetivoReportado? = null, gimbalPitch: Double = Double.NaN): JSONObject {
        cliente.sendStatus(
            state = "MANUAL", battery = 80.0, lat = lat, lon = lon, routeId = null, waypointIndex = 0,
            waypointTotal = 0, signalOk = true, signalPct = 90, heading = 45.0, mode = "TEST",
            altM = 1.2, satellites = 4, flying = true, flightMode = "ATTI", target = objetivo,
            gimbalPitch = gimbalPitch,
        )
        return cliente.enviados.last()
    }

    /** La inclinación de la cámara viaja con el nombre del contrato (§1, `gimbalPitch`), en grados y tal cual. */
    @Test
    fun laInclinacionDeLaCamaraVaEnElStatus() {
        assertEquals(-35.5, status(-34.6, -58.38, gimbalPitch = -35.5).getDouble("gimbalPitch"), 0.0)
        // El horizonte es una inclinación como cualquier otra, no un "no sé"
        assertEquals(0.0, status(-34.6, -58.38, gimbalPitch = 0.0).getDouble("gimbalPitch"), 0.0)
    }

    /**
     * Sin inclinación conocida el campo NO sale (ni siquiera en null): es
     * opcional en el contrato y la consola supone su valor cuando falta. Y el
     * status sale igual, sin explotar por el NaN.
     */
    @Test
    fun sinInclinacionConocidaElCampoNoSale() {
        for (desconocida in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            val s = status(-34.6, -58.38, gimbalPitch = desconocida)
            assertFalse("con $desconocida no tendría que salir: $s", s.has("gimbalPitch"))
            assertEquals("MANUAL", s.getString("state"))
        }
        // Y quien no la pasa (el default) tampoco la manda
        cliente.sendStatus("IDLE", 50.0, -34.6, -58.38, null, 0, 0, true, 90, 0.0, "TEST")
        assertFalse(cliente.enviados.last().has("gimbalPitch"))
    }

    /** Sin GPS el status sale igual, con la posición en null y gpsFix en false (y sin explotar por el NaN). */
    @Test
    fun sinGpsElStatusSaleConLaPosicionEnNull() {
        val s = status(Double.NaN, Double.NaN)
        assertTrue(s.isNull("lat"))
        assertTrue(s.isNull("lon"))
        assertFalse(s.getBoolean("gpsFix"))
        assertEquals(80.0, s.getDouble("battery"), 0.0)
        assertTrue(s.getBoolean("flying"))
        assertEquals(1.2, s.getDouble("alt"), 0.0)
        assertEquals("ATTI", s.getString("flightMode"))
        assertTrue(s.isNull("target"))
    }

    @Test
    fun conGpsLaPosicionVaYGpsFixEsTrue() {
        val s = status(-34.6, -58.38)
        assertEquals(-34.6, s.getDouble("lat"), 0.0)
        assertTrue(s.getBoolean("gpsFix"))
    }

    @Test
    fun elObjetivoVaConLosNombresDelContrato() {
        val o = ObjetivoReportado(12L, "VEHICLE", -34.6, -58.38, 4.2, 118.0, true, false, 600L, "VALIDATED")
        val t = status(-34.6, -58.38, o).getJSONObject("target")
        assertEquals(12L, t.getLong("alertId"))
        assertEquals("VEHICLE", t.getString("type"))
        assertEquals(-34.6, t.getDouble("lat"), 0.0)
        assertEquals(-58.38, t.getDouble("lon"), 0.0)
        assertEquals(4.2, t.getDouble("speedMs"), 0.0)
        assertEquals(118.0, t.getDouble("courseDeg"), 0.0)
        assertTrue(t.getBoolean("moving"))
        assertFalse(t.getBoolean("lost"))
        assertEquals(600L, t.getLong("lastSeenMs"))
        assertEquals("VALIDATED", t.getString("decision"))
    }

    @Test
    fun sinAcuseElObjetivoVaConAlertIdNull() {
        val o = ObjetivoReportado(null, "PERSON", -34.6, -58.38, 0.0, 0.0, false, false, 0L, "PENDING")
        assertTrue(status(-34.6, -58.38, o).getJSONObject("target").isNull("alertId"))
    }

    @Test
    fun losEventosDeSeguimientoLlevanAlertaYPosicion() {
        cliente.sendEvent("TARGET_LOST", "se perdió", 7L, -34.6, -58.38)
        val e = cliente.enviados.last()
        assertEquals("event", e.getString("type"))
        assertEquals(7L, e.getLong("alertId"))
        assertEquals(-34.6, e.getDouble("lat"), 0.0)

        cliente.sendEvent("PATROL_STARTED", "arrancó")
        val simple = cliente.enviados.last()
        assertFalse(simple.has("alertId"))
        assertFalse(simple.has("lat"))

        // Una posición inválida no viaja (org.json no acepta NaN)
        cliente.sendEvent("TARGET_LOST", "sin posición", 7L, Double.NaN, Double.NaN)
        assertFalse(cliente.enviados.last().has("lat"))
    }

    @Test
    fun laAlertaLlevaRefYPoseDelDron() {
        cliente.sendAlertRequest("PERSON", -34.6, -58.38, "/9j/x", 0.8, listOf("PERSON"), "ref-1", -34.601, -58.381, 40.0)
        val a = cliente.enviados.last()
        assertEquals("ref-1", a.getString("ref"))
        assertEquals(-34.601, a.getDouble("droneLat"), 0.0)
        assertEquals(40.0, a.getDouble("droneAlt"), 0.0)
    }

    @Test
    fun elAcuseLlegaConRefEId() {
        var recibido: Pair<String, Long>? = null
        cliente.onAlertAck = { ref, id -> recibido = ref to id }
        cliente.manejarMensaje("""{"type":"alert_ack","ref":"ref-1","alertId":12}""")
        assertEquals("ref-1" to 12L, recibido)
    }

    @Test
    fun unAcuseIncompletoSeIgnora() {
        var llamado = false
        cliente.onAlertAck = { _, _ -> llamado = true }
        cliente.manejarMensaje("""{"type":"alert_ack","alertId":12}""")
        cliente.manejarMensaje("""{"type":"alert_ack","ref":"r"}""")
        assertFalse(llamado)
    }

    @Test
    fun laDecisionTraeElIdDeLaAlerta() {
        var recibido: List<Any?>? = null
        cliente.onAlertDecision = { id, decision, por, reenvio -> recibido = listOf(id, decision, por, reenvio) }
        cliente.manejarMensaje("""{"type":"alert_decision","alertId":12,"decision":"DISMISSED","decidedBy":"ana"}""")
        assertEquals(listOf(12L, "DISMISSED", "ana", false), recibido)

        cliente.manejarMensaje("""{"type":"alert_decision","decision":"VALIDATED","decidedBy":"ana"}""")
        assertNull(recibido!![0])

        cliente.manejarMensaje("""{"type":"alert_decision","alertId":3,"decision":"DISMISSED","decidedBy":"ana","resent":true}""")
        assertEquals(true, recibido!![3])
    }

    @Test
    fun despegueYAterrizajeDesdeLaConsola() {
        val ordenes = mutableListOf<String>()
        cliente.onTakeoff = { por -> ordenes += "takeoff:$por" }
        cliente.onLand = { por -> ordenes += "land:$por" }
        cliente.manejarMensaje("""{"type":"takeoff","by":"ana"}""")
        cliente.manejarMensaje("""{"type":"land","by":"ana"}""")
        assertEquals(listOf("takeoff:ana", "land:ana"), ordenes)
    }

    /** El detector devuelve el ts del cuadro analizado: con él se busca la pose de ese instante. */
    @Test
    fun laDeteccionTraeLaHoraDelCuadro() {
        val d = DetectionClient.interpretarDeteccion(
            """{"type":"detection","detected":true,"classes":["PERSON"],"confidence":0.8,"ts":5,"frameTs":1700000000123}""",
        )!!
        assertEquals(1_700_000_000_123L, d.frameTs)
        val vieja = DetectionClient.interpretarDeteccion(
            """{"type":"detection","detected":true,"classes":["PERSON"],"confidence":0.8,"ts":5}""",
        )!!
        assertNull(vieja.frameTs)
    }

    private fun JSONObject.claves(): Set<String> = keys().asSequence().toSet()

    /** Un campo que viaja en null: presente, no ausente. */
    private fun assertEnNull(o: JSONObject, campo: String) {
        assertTrue("$campo tiene que estar: $o", o.has(campo))
        assertTrue("$campo tiene que ir en null: $o", o.isNull(campo))
    }

    /**
     * El status de un dron patrullando, campo por campo con su nombre y su tipo
     * (§1, "Campos de status"), y ni uno más: el hub lo reenvía tal cual.
     */
    @Test
    fun elStatusLlevaCadaCampoDelContratoYNadaMas() {
        cliente.sendStatus(
            state = "PATROLLING", battery = 87.5, lat = -34.855, lon = -56.206, routeId = 1, waypointIndex = 2,
            waypointTotal = 4, signalOk = true, signalPct = 78, heading = 132.0, mode = "DEPLOY", altM = 40.0,
            satellites = 14, flying = true, flightMode = "P-GPS", gimbalPitch = -70.0,
        )
        val s = cliente.enviados.last()

        assertEquals(
            setOf(
                "type", "state", "battery", "lat", "lon", "gpsFix", "routeId", "waypointIndex", "waypointTotal",
                "signal", "signalPct", "heading", "mode", "alt", "satellites", "flying", "flightMode",
                "gimbalPitch", "target",
            ),
            s.claves(),
        )
        assertEquals("status", s.getString("type"))
        assertEquals("PATROLLING", s.getString("state"))
        assertEquals(87.5, s.getDouble("battery"), 0.0)
        assertEquals(-34.855, s.getDouble("lat"), 0.0)
        assertEquals(-56.206, s.getDouble("lon"), 0.0)
        assertTrue(s.getBoolean("gpsFix"))
        assertEquals(1, s.getInt("routeId"))
        assertEquals(2, s.getInt("waypointIndex"))
        assertEquals(4, s.getInt("waypointTotal"))
        assertEquals("OK", s.getString("signal"))
        assertEquals(78, s.getInt("signalPct"))
        assertEquals(132.0, s.getDouble("heading"), 0.0)
        assertEquals("DEPLOY", s.getString("mode"))
        assertEquals(40.0, s.getDouble("alt"), 0.0)
        assertEquals(14, s.getInt("satellites"))
        assertTrue(s.getBoolean("flying"))
        assertEquals("P-GPS", s.getString("flightMode"))
        assertEquals(-70.0, s.getDouble("gimbalPitch"), 0.0)
        assertEnNull(s, "target")
    }

    /** Sin enlace RC la señal es `LOST`, y sin ruta `routeId` va en null (§1). */
    @Test
    fun sinSenialNiRutaElStatusLoDice() {
        cliente.sendStatus("PAUSED", 50.0, -34.6, -58.38, null, 0, 0, false, 0, 10.0, "TEST")
        val s = cliente.enviados.last()

        assertEquals("LOST", s.getString("signal"))
        assertEquals(0, s.getInt("signalPct"))
        assertEnNull(s, "routeId")
        // Los opcionales con su valor por defecto
        assertEquals(0.0, s.getDouble("alt"), 0.0)
        assertEquals(0, s.getInt("satellites"))
        assertFalse(s.getBoolean("flying"))
        assertEquals("", s.getString("flightMode"))
    }

    /**
     * Media posición no es una posición: con una sola coordenada inválida las
     * dos salen en null y `gpsFix` en false.
     */
    @Test
    fun conUnaSolaCoordenadaInvalidaNoHayPosicion() {
        for ((lat, lon) in listOf(-34.6 to Double.NaN, Double.NaN to -58.38, Double.POSITIVE_INFINITY to -58.38, -34.6 to Double.NEGATIVE_INFINITY)) {
            val s = status(lat, lon)
            assertEnNull(s, "lat")
            assertEnNull(s, "lon")
            assertFalse("($lat, $lon) no es una posición", s.getBoolean("gpsFix"))
        }
    }

    /**
     * Una lectura rota del dron (NaN o infinito en la batería, el rumbo o la
     * altura) sale en null: org.json rechaza esos números con una excepción, y
     * en el lazo del status eso es la app cerrándose en pleno vuelo.
     */
    @Test
    fun unaLecturaNoFinitaSaleEnNullYElStatusSaleIgual() {
        cliente.sendStatus(
            "PATROLLING", Double.NaN, -34.6, -58.38, 1, 0, 3, true, 90, Double.POSITIVE_INFINITY, "TEST",
            altM = Double.NEGATIVE_INFINITY,
        )
        val s = cliente.enviados.last()

        assertEnNull(s, "battery")
        assertEnNull(s, "heading")
        assertEnNull(s, "alt")
        assertEquals("PATROLLING", s.getString("state"))
        assertTrue(s.getBoolean("gpsFix"))
    }

    /** Lo mismo para el objetivo: una estimación sin número no hace explotar el status. */
    @Test
    fun unObjetivoConNumerosNoFinitosLosMandaEnNull() {
        val o = ObjetivoReportado(3L, "PERSON", Double.NaN, Double.POSITIVE_INFINITY, Double.NaN, Double.NEGATIVE_INFINITY, false, true, 12_000L, "PENDING")
        val t = status(-34.6, -58.38, o).getJSONObject("target")

        assertEquals(
            setOf("alertId", "type", "lat", "lon", "speedMs", "courseDeg", "moving", "lost", "lastSeenMs", "decision"),
            t.claves(),
        )
        for (campo in listOf("lat", "lon", "speedMs", "courseDeg")) assertEnNull(t, campo)
        assertTrue(t.getBoolean("lost"))
        assertEquals(12_000L, t.getLong("lastSeenMs"))
    }

    /** `set_name` → `displayName` (§1). */
    @Test
    fun renombrarMandaElNombreNuevo() {
        cliente.sendSetName("Alfa 2")
        val m = cliente.enviados.last()

        assertEquals(setOf("type", "displayName"), m.claves())
        assertEquals("set_name", m.getString("type"))
        assertEquals("Alfa 2", m.getString("displayName"))
    }

    /** `video_frame` → `jpegBase64, ts` (§1), con la hora del teléfono. */
    @Test
    fun elCuadroDeLaConsolaLlevaLaImagenYLaHora() {
        val antes = System.currentTimeMillis()
        cliente.sendVideoFrame("/9j/cuadro")
        val despues = System.currentTimeMillis()
        val m = cliente.enviados.last()

        assertEquals(setOf("type", "jpegBase64", "ts"), m.claves())
        assertEquals("video_frame", m.getString("type"))
        assertEquals("/9j/cuadro", m.getString("jpegBase64"))
        assertTrue(m.getLong("ts") in antes..despues)
    }

    /** `alert_request` completo (§1): cada campo con su nombre, la posición del objetivo y la pose del dron. */
    @Test
    fun laAlertaLlevaCadaCampoDelContrato() {
        cliente.sendAlertRequest("VEHICLE", -34.6, -58.38, "/9j/anotada", 0.91, listOf("VEHICLE", "PERSON"), "ref-9", -34.601, -58.381, 40.0)
        val a = cliente.enviados.last()

        assertEquals(
            setOf(
                "type", "alertType", "lat", "lon", "snapshotBase64", "confidence", "classes", "ref",
                "droneLat", "droneLon", "droneAlt",
            ),
            a.claves(),
        )
        assertEquals("alert_request", a.getString("type"))
        assertEquals("VEHICLE", a.getString("alertType"))
        assertEquals(-34.6, a.getDouble("lat"), 0.0)
        assertEquals(-58.38, a.getDouble("lon"), 0.0)
        assertEquals("/9j/anotada", a.getString("snapshotBase64"))
        assertEquals(0.91, a.getDouble("confidence"), 0.0)
        val clases = a.getJSONArray("classes")
        assertEquals(listOf("VEHICLE", "PERSON"), (0 until clases.length()).map { clases.getString(it) })
        assertEquals(-58.381, a.getDouble("droneLon"), 0.0)
    }

    /**
     * Una alerta sin captura, sin `ref`, sin posición del objetivo y sin pose
     * del dron sale igual, con esos campos en null y las clases en la del tipo:
     * es la alerta sin seguimiento de un dron en el suelo o sin GPS (§4).
     */
    @Test
    fun unaAlertaSinDatosLosMandaEnNull() {
        cliente.sendAlertRequest("PERSON", Double.NaN, Double.NaN, null)
        val a = cliente.enviados.last()

        for (campo in listOf("lat", "lon", "snapshotBase64", "ref", "droneLat", "droneLon", "droneAlt")) assertEnNull(a, campo)
        assertEquals(0.0, a.getDouble("confidence"), 0.0)
        assertEquals("PERSON", a.getJSONArray("classes").getString(0))
        assertEquals(1, a.getJSONArray("classes").length())

        cliente.sendAlertRequest("PERSON", -34.6, -58.38, null, confidence = Double.NaN)
        assertEnNull(cliente.enviados.last(), "confidence")
    }

    /**
     * El evento solo lleva posición si las dos coordenadas son números
     * finitos: media posición no se manda, y el `alertId` va aunque no haya
     * posición (§1, `event`).
     */
    @Test
    fun elEventoSoloLlevaUnaPosicionCompleta() {
        cliente.sendEvent("TARGET_LOST", "sin posición", alertId = 7L)
        val conAlerta = cliente.enviados.last()
        assertEquals(7L, conAlerta.getLong("alertId"))
        assertFalse(conAlerta.has("lat"))
        assertFalse(conAlerta.has("lon"))

        for ((lat, lon) in listOf(-34.6 to null, null to -58.38, -34.6 to Double.POSITIVE_INFINITY, Double.NaN to -58.38)) {
            cliente.sendEvent("DETECTION", "media posición", lat = lat, lon = lon)
            val e = cliente.enviados.last()
            assertFalse("($lat, $lon) no es una posición: $e", e.has("lat") || e.has("lon"))
        }

        cliente.sendEvent("DETECTION", "con posición", lat = -34.6, lon = -58.38)
        val completo = cliente.enviados.last()
        assertEquals(setOf("type", "eventType", "message", "lat", "lon"), completo.claves())
        assertEquals("DETECTION", completo.getString("eventType"))
        assertEquals("con posición", completo.getString("message"))
        assertEquals(-58.38, completo.getDouble("lon"), 0.0)
    }

    /** El "hola" de la app tiene la forma que el servidor espera (contrato §4). */
    @Test
    fun elHolaDeLaAppEsElDelContrato() {
        val hola = JSONObject(DescubridorDeDeteccion.hola("S23 Ultra"))
        assertEquals("dronepatrol-app", hola.getString("service"))
        assertEquals(8766, hola.getInt("port"))
        assertEquals("S23 Ultra", hola.getString("name"))
        // Y no se confunde con un anuncio de la detección
        assertNull(DescubridorDeDeteccion.interpretar(hola.toString(), "192.168.68.55", 0L))
    }
}
