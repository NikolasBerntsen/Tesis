package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.drone.Geo
import kotlin.math.hypot
import org.json.JSONObject

/**
 * `status.relevo` (docs/PROTOCOLS.md §1): si el dron está en espera,
 * disponible o participando de un relevo. [rol] y [fase] van null si y solo si
 * [relayId] es null; quien lo arma ya lo garantiza, y [MensajesDeLaApp.relevo]
 * lo vuelve a asegurar antes de mandarlo.
 */
data class RelevoReportado(
    val enEspera: Boolean,
    val disponible: Boolean,
    val relayId: Long? = null,
    /** `origen` (A) o `relevo` (B). */
    val rol: String? = null,
    val fase: String? = null,
)

/**
 * `status.autonomia` (docs/PROTOCOLS.md §1): lo que el dron calcula que le
 * cuesta volver. NaN es "no se sabe" y sale como null.
 */
data class AutonomiaReportada(
    val pctParaVolver: Double,
    val pctParaAterrizar: Double,
    val alcanceM: Double,
    val segundosParaVolver: Double,
)

/**
 * Los mensajes de la app al hub de docs/PROTOCOLS.md §1.b, armados en un solo
 * lugar y con las convenciones de §1.b: los enteros salen como enteros, una
 * posición que no lo es (NaN, 0,0) sale como los dos null, ningún número sale
 * como NaN (org.json no lo acepta y el lazo que lo manda se caería) y los
 * textos libres se recortan a su tope. Son funciones puras para que las pruebas
 * comparen cada uno contra el contrato sin socket.
 */
internal object MensajesDeLaApp {

    const val DETALLE_MAXIMO = 200
    private const val VELOCIDAD_MAXIMA_MS = 40.0

    fun relayRequestPatrulla(ref: String, routeId: Int, fromIndex: Int): JSONObject = JSONObject()
        .put("type", "relay_request")
        .put("ref", ref)
        .put("motivo", "patrulla")
        .put("routeId", routeId)
        .put("fromIndex", fromIndex.coerceAtLeast(0))

    /** [segundosDisponibles] null (sin autonomía informada) viaja como null: el campo tiene que estar. */
    fun relayRequestSeguimiento(ref: String, alertId: Long, segundosDisponibles: Double?): JSONObject = JSONObject()
        .put("type", "relay_request")
        .put("ref", ref)
        .put("motivo", "seguimiento")
        .put("alertId", alertId)
        .put(
            "segundosDisponibles",
            segundosDisponibles?.takeIf { it.isFinite() }?.coerceIn(0.0, 3_600.0) ?: JSONObject.NULL,
        )

    fun relayAccept(relayId: Long): JSONObject = JSONObject().put("type", "relay_accept").put("relayId", relayId)

    fun relayReject(relayId: Long, motivo: String, detalle: String? = null): JSONObject =
        conDetalle(JSONObject().put("type", "relay_reject").put("relayId", relayId).put("motivo", motivo), detalle)

    fun relayReady(relayId: Long): JSONObject = JSONObject().put("type", "relay_ready").put("relayId", relayId)

    fun relayAbort(relayId: Long, motivo: String, detalle: String? = null): JSONObject =
        conDetalle(JSONObject().put("type", "relay_abort").put("relayId", relayId).put("motivo", motivo), detalle)

    fun relayAbandon(relayId: Long, motivo: String?): JSONObject = JSONObject()
        .put("type", "relay_abandon")
        .put("relayId", relayId)
        .apply { if (motivo != null) put("motivo", motivo) }

    fun relayReleased(relayId: Long): JSONObject = JSONObject().put("type", "relay_released").put("relayId", relayId)

    fun landingAtBase(
        ref: String,
        relayId: Long?,
        baseId: Long?,
        lat: Double,
        lon: Double,
        routeId: Int,
        fromIndex: Int,
    ): JSONObject = posicion(
        JSONObject()
            .put("type", "landing_at_base")
            .put("ref", ref)
            .put("relayId", relayId ?: JSONObject.NULL)
            .put("baseId", baseId ?: JSONObject.NULL),
        "lat", "lon", lat, lon,
    )
        .put("routeId", routeId)
        .put("fromIndex", fromIndex.coerceAtLeast(0))

    fun landedAtBase(relayId: Long?, baseId: Long?, lat: Double, lon: Double): JSONObject = posicion(
        JSONObject()
            .put("type", "landed_at_base")
            .put("relayId", relayId ?: JSONObject.NULL)
            .put("baseId", baseId ?: JSONObject.NULL),
        "lat", "lon", lat, lon,
    )

    /** Con `emergencia` la base va null siempre: no se llega a ninguna (§1.b). */
    fun rthDiverted(relayId: Long?, baseId: Long?, lat: Double, lon: Double, motivo: String): JSONObject = posicion(
        JSONObject()
            .put("type", "rth_diverted")
            .put("relayId", relayId ?: JSONObject.NULL)
            .put("baseId", if (motivo == "emergencia") JSONObject.NULL else baseId ?: JSONObject.NULL),
        "lat", "lon", lat, lon,
    ).put("motivo", motivo)

    fun emergencyLanding(
        ref: String,
        motivo: String,
        lat: Double,
        lon: Double,
        alt: Double,
        bateria: Double,
        ts: Long,
    ): JSONObject = posicion(
        JSONObject().put("type", "emergency_landing").put("ref", ref).put("motivo", motivo),
        "lat", "lon", lat, lon,
    )
        .put("alt", altura(alt))
        .put("bateria", if (bateria.isFinite()) bateria.coerceIn(0.0, 100.0) else 0.0)
        .put("ts", ts.coerceAtLeast(1L))

    fun emergencyPhoto(
        ref: String,
        seq: Int,
        tipo: String,
        rumbo: Double,
        inclinacion: Double,
        lat: Double,
        lon: Double,
        alt: Double,
        jpegBase64: String,
        ts: Long,
    ): JSONObject = posicion(
        JSONObject()
            .put("type", "emergency_photo")
            .put("ref", ref)
            .put("seq", seq)
            .put("tipo", tipo)
            .put("rumbo", if (rumbo.isFinite()) ((rumbo % 360.0) + 360.0) % 360.0 else 0.0)
            .put("inclinacion", if (inclinacion.isFinite()) inclinacion.coerceIn(-90.0, 30.0) else -90.0),
        "lat", "lon", lat, lon,
    )
        .put("alt", altura(alt))
        .put("jpegBase64", jpegBase64)
        .put("ts", ts.coerceAtLeast(1L))

    fun emergencyLanded(ref: String, lat: Double, lon: Double, alt: Double, ts: Long): JSONObject = posicion(
        JSONObject().put("type", "emergency_landed").put("ref", ref),
        "lat", "lon", lat, lon,
    )
        .put("alt", altura(alt))
        .put("ts", ts.coerceAtLeast(1L))

    /** `status.relevo`, con la regla de §1: rol y fase null si y solo si relayId es null. */
    fun relevo(r: RelevoReportado): JSONObject {
        val conRelevo = r.relayId != null && r.rol != null && r.fase != null
        return JSONObject()
            .put("enEspera", r.enEspera)
            // disponible sin estar en espera es inválido en el contrato
            .put("disponible", r.disponible && r.enEspera)
            .put("relayId", if (conRelevo) r.relayId else JSONObject.NULL)
            .put("rol", if (conRelevo) r.rol else JSONObject.NULL)
            .put("fase", if (conRelevo) r.fase else JSONObject.NULL)
    }

    /** `status.autonomia`: cada campo fuera de su rango sale null, para no invalidar el objeto entero. */
    fun autonomia(a: AutonomiaReportada): JSONObject = JSONObject()
        .put("pctParaVolver", enRango(a.pctParaVolver, 0.0, 100.0))
        .put("pctParaAterrizar", enRango(a.pctParaAterrizar, 0.0, 100.0))
        .put("alcanceM", enRango(a.alcanceM, 0.0, 100_000.0))
        .put("segundosParaVolver", enRango(a.segundosParaVolver, 0.0, 36_000.0))

    /**
     * Las componentes de la velocidad del objetivo (`target.vNorteMs/vEsteMs`)
     * salen solo si son números con módulo creíble: son opcionales, y el hub
     * las deriva de `speedMs`/`courseDeg` cuando faltan.
     */
    fun conVelocidad(target: JSONObject, vNorteMs: Double, vEsteMs: Double): JSONObject {
        if (vNorteMs.isFinite() && vEsteMs.isFinite() && hypot(vNorteMs, vEsteMs) <= VELOCIDAD_MAXIMA_MS) {
            target.put("vNorteMs", vNorteMs).put("vEsteMs", vEsteMs)
        }
        return target
    }

    private fun enRango(v: Double, minimo: Double, maximo: Double): Any =
        if (v.isFinite() && v in minimo..maximo) v else JSONObject.NULL

    private fun altura(alt: Double): Double = if (alt.isFinite()) alt.coerceIn(-200.0, 1_000.0) else 0.0

    private fun conDetalle(o: JSONObject, detalle: String?): JSONObject {
        if (!detalle.isNullOrBlank()) o.put("detalle", detalle.take(DETALLE_MAXIMO))
        return o
    }

    /** Los dos números si son una posición de verdad; si no, los dos null (nunca uno solo, nunca 0,0). */
    private fun posicion(o: JSONObject, campoLat: String, campoLon: String, lat: Double, lon: Double): JSONObject {
        val valida = Geo.esPosicionValida(lat, lon)
        return o.put(campoLat, if (valida) lat else JSONObject.NULL).put(campoLon, if (valida) lon else JSONObject.NULL)
    }
}
