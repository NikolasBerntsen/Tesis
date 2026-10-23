package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Waypoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

/**
 * El banco de las pruebas de relevos, desvíos y emergencias: un PatrolManager
 * con el dron espía, el Comando Central espía (conectado) y los dos relojes
 * falsos, más los mensajes del hub armados con los nombres del contrato
 * (docs/PROTOCOLS.md §2.b). Los mensajes pasan por la validación de
 * CommandCenterClient, igual que los del socket.
 *
 * Las esperas de la secuencia de última ubicación adelantan el reloj falso en
 * vez de dormir: la secuencia entera corre en milisegundos.
 */
internal class BancoDeRelevos(
    val almacen: AlmacenDeCola = AlmacenEnMemoria(),
) {
    companion object {
        const val BASE_LAT = -34.8565
        const val BASE_LON = -56.2075
        const val ALFA = "a3f9c1b27d5e4408f61a9c3e772b7e42"
        const val BRAVO = "b7e4209c3f1a4d6e8b2c5a7f9d1e3c40"

        /** Un punto a [norteM] y [esteM] de la base propia. */
        fun punto(norteM: Double, esteM: Double = 0.0): Pair<Double, Double> =
            (BASE_LAT + norteM / Geo.METROS_POR_GRADO_LAT) to (BASE_LON + esteM / Geo.metrosPorGradoLon(BASE_LAT))

        val RUTA = PatrolRoute(
            1,
            "Perímetro norte",
            listOf(
                Waypoint(punto(300.0).first, punto(300.0).second, 40.0),
                Waypoint(punto(300.0, 300.0).first, punto(300.0, 300.0).second, 40.0),
                Waypoint(punto(0.0, 300.0).first, punto(0.0, 300.0).second, 40.0),
            ),
        )

        fun participante(id: String, nombre: String): JSONObject = JSONObject().put("droneId", id).put("displayName", nombre)

        fun base(id: Long, nombre: String, norteM: Double, esteM: Double = 0.0): JSONObject {
            val (lat, lon) = punto(norteM, esteM)
            return JSONObject()
                .put("id", id).put("nombre", nombre).put("lat", lat).put("lon", lon)
                .put("aterrizajeLat", JSONObject.NULL).put("aterrizajeLon", JSONObject.NULL)
        }

        fun bases(propiaId: Long?, vararg bases: JSONObject): JSONObject = JSONObject()
            .put("type", "bases")
            .put("propiaId", propiaId ?: JSONObject.NULL)
            .put("bases", JSONArray(bases.toList()))

        /** Las dos bases de siempre: la propia (1) en el origen y "Sur" (2) a [surNorteM] al norte. */
        fun basesDeSiempre(surNorteM: Double = 900.0): JSONObject =
            bases(1L, base(1, "Norte", 0.0), base(2, "Sur", surNorteM))

        fun relayStatus(
            ref: String,
            relayId: Long,
            estado: String,
            etaS: Double? = null,
            relevo: JSONObject? = participante(BRAVO, "Bravo"),
            motivoFin: String? = null,
        ): JSONObject = JSONObject()
            .put("type", "relay_status").put("ref", ref).put("relayId", relayId).put("estado", estado)
            .put("relevo", relevo ?: JSONObject.NULL)
            .put("etaS", etaS ?: JSONObject.NULL)
            .put("motivoFin", motivoFin ?: JSONObject.NULL)

        fun relayStart(relayId: Long, ruta: PatrolRoute = RUTA, fromIndex: Int = 1): JSONObject = JSONObject()
            .put("type", "relay_start").put("relayId", relayId).put("motivo", "patrulla")
            .put(
                "ruta",
                JSONObject().put("id", ruta.id).put("name", ruta.name).put(
                    "waypoints",
                    JSONArray(ruta.waypoints.map { JSONObject().put("lat", it.lat).put("lon", it.lon).put("alt", it.alt) }),
                ),
            )
            .put("fromIndex", fromIndex)
            .put("de", participante(ALFA, "Alfa"))

        /** El objetivo de un relevo: una persona quieta a [norteM]/[esteM] de la base, o moviéndose. */
        fun objetivo(
            alertId: Long,
            norteM: Double,
            esteM: Double = 0.0,
            decision: String = "VALIDATED",
            vNorte: Double = 0.0,
            vEste: Double = 0.0,
            vistoHaceMs: Long = 400,
        ): JSONObject {
            val (lat, lon) = punto(norteM, esteM)
            val v = kotlin.math.hypot(vNorte, vEste)
            return JSONObject()
                .put("alertId", alertId).put("type", "PERSON").put("lat", lat).put("lon", lon)
                .put("speedMs", v).put("courseDeg", if (v < 0.1) 0.0 else (Math.toDegrees(kotlin.math.atan2(vEste, vNorte)) + 360.0) % 360.0)
                .put("moving", v >= 0.1).put("lost", false).put("lastSeenMs", vistoHaceMs).put("decision", decision)
                .put("vNorteMs", vNorte).put("vEsteMs", vEste)
        }

        fun relayTracking(relayId: Long, alertId: Long, objetivo: JSONObject, ts: Long = 1_000L): JSONObject = JSONObject()
            .put("type", "relay_tracking").put("relayId", relayId).put("alertId", alertId)
            .put("decision", objetivo.getString("decision")).put("objetivo", objetivo)
            .put("de", participante(ALFA, "Alfa")).put("ts", ts)

        fun relayTarget(
            relayId: Long,
            alertId: Long,
            objetivo: JSONObject,
            ts: Long,
            origen: String = "en_linea",
            aNorteM: Double? = null,
            aAlt: Double? = 40.0,
        ): JSONObject {
            val a = aNorteM?.let { punto(it) }
            return JSONObject()
                .put("type", "relay_target").put("relayId", relayId).put("alertId", alertId)
                .put("decision", objetivo.getString("decision")).put("objetivo", objetivo).put("origen", origen)
                .put("aLat", a?.first ?: JSONObject.NULL).put("aLon", a?.second ?: JSONObject.NULL)
                .put("aAlt", aAlt ?: JSONObject.NULL).put("ts", ts)
        }

        fun relayGo(relayId: Long): JSONObject = JSONObject().put("type", "relay_go").put("relayId", relayId)

        fun relayDone(relayId: Long, alertId: Long): JSONObject = JSONObject()
            .put("type", "relay_done").put("relayId", relayId).put("alertId", alertId)
            .put("relevadoPor", participante(BRAVO, "Bravo"))

        fun relayCancel(relayId: Long, motivo: String): JSONObject =
            JSONObject().put("type", "relay_cancel").put("relayId", relayId).put("motivo", motivo)

        fun emergencyAck(ref: String, id: Long, aterrizada: Boolean): JSONObject = JSONObject()
            .put("type", "emergency_ack").put("ref", ref).put("emergencyId", id).put("aterrizada", aterrizada)

        fun emergencyPhotoAck(ref: String, seq: Int): JSONObject =
            JSONObject().put("type", "emergency_photo_ack").put("ref", ref).put("seq", seq)
    }

    val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val dron = DronEspia(conRelevos = true)
    val comando = ComandoCentralEspia(alcance)
    val deteccion = DetectionClient(alcance)

    /** El reloj de los relevos y del seguimiento (PatrolManager.reloj). */
    val reloj = RelojFalso()

    /** El de la señal, aparte: adelantar los relevos no puede ser además una señal perdida. */
    val relojDeLaSenial = RelojFalso()

    val patrulla = PatrolManager(
        dron, comando, deteccion, alcance, "TEST", reloj::ahora, relojDeLaSenial::ahora,
        almacenDeEmergencias = almacen,
        // Un respiro de verdad muy corto: la confirmación de la cámara llega por
        // la telemetría, que procesa otra corrutina.
        pausaDeEmergencia = { ms ->
            reloj.adelantar(ms)
            delay(5)
        },
    )

    fun desarmar() = alcance.cancel()

    /** Arranca la patrulla y espera que escuche los avisos del dron (que no se guardan). */
    suspend fun arrancar() {
        patrulla.start()
        withTimeout(5_000) { dron.flightEvents.subscriptionCount.first { it > 0 } }
        withTimeout(5_000) { dron.estado.subscriptionCount.first { it > 0 } }
    }

    /** Un mensaje del hub, por la misma validación que el socket, y un respiro para que se procese. */
    suspend fun hub(mensaje: JSONObject) {
        comando.recibir(mensaje)
        delay(60)
    }

    suspend fun evento(e: FlightEvent) {
        dron.flightEvents.emit(e)
        delay(60)
    }

    /** Telemetría a [norteM]/[esteM] de la base; el reloj de la señal la acompaña. */
    suspend fun telemetria(
        norteM: Double = 0.0,
        esteM: Double = 0.0,
        bateria: Double = 100.0,
        alt: Double = 40.0,
        rumbo: Double = 0.0,
        pctParaVolver: Double = Double.NaN,
        pctParaAterrizar: Double = Double.NaN,
        alcanceM: Double = Double.NaN,
        gimbal: Double = -70.0,
    ) {
        val (lat, lon) = punto(norteM, esteM)
        relojDeLaSenial.adelantar(500)
        dron.emitirTelemetria(
            lat, lon, bateria, alt, rumbo, gimbal,
            pctParaVolver = pctParaVolver, pctParaAterrizar = pctParaAterrizar, alcanceM = alcanceM,
        )
        delay(60)
    }

    /** Adelanta el reloj de los relevos y deja correr el lazo (que revisa cada 200 ms). */
    suspend fun pasar(ms: Long) {
        reloj.adelantar(ms)
        delay(300)
    }

    /** El dron en el suelo, en su base, enlazado y listo para despegar. */
    fun enElSuelo() {
        dron.estado.value = dron.estado.value.copy(enVuelo = false, conectado = true, sdkListo = true, satelites = 14, baseFijada = true)
    }

    fun mensajes(tipo: String): List<JSONObject> = comando.mensajes(tipo)

    fun ultimo(tipo: String): JSONObject = mensajes(tipo).last()
}
