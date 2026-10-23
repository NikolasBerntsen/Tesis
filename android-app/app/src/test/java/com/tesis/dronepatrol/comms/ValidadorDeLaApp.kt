package com.tesis.dronepatrol.comms

import kotlin.math.abs
import kotlin.math.hypot
import org.json.JSONObject

/**
 * Las reglas de docs/PROTOCOLS.md §1.b (y de `status.relevo`, `status.autonomia`
 * y `target.vNorteMs/vEsteMs` de §1) escritas del lado de las pruebas, como las
 * aplica el hub: lo que la app manda tiene que pasarlas, y lo que no las pasa
 * el hub lo descarta en silencio. Se prueba primero contra los ejemplos de
 * `docs/contrato/relevos.json` —todos los válidos pasan, ningún inválido— y
 * recién ahí se le cree para juzgar lo que arma [MensajesDeLaApp].
 *
 * Devuelve por qué un mensaje no cumple, o null si cumple.
 */
internal object ValidadorDeLaApp {

    private const val ENTERO_SEGURO = 9_007_199_254_740_991L
    private val BASE64 = Regex("^[A-Za-z0-9+/=]+$")

    private val MOTIVOS = mapOf(
        "relay_reject" to setOf("no_disponible", "virtual_stick", "cancelado_en_campo", "ocupado", "mensaje_invalido"),
        "relay_abort" to setOf("subida", "virtual_stick", "senial", "bateria", "dji", "orden_de_campo", "otro"),
        "relay_abandon" to setOf("piso", "dji", "orden_del_operador", "orden_de_campo", "senial"),
    )
    private val FASES = mapOf(
        "origen" to setOf("pedido", "ventana", "soltando", "aterrizando", "desviado"),
        "relevo" to setOf("cuenta_regresiva", "esperando_despegue", "despegando", "en_camino", "traspaso"),
    )

    private class NoCumple(motivo: String) : Exception(motivo)

    fun motivoParaRechazar(m: JSONObject): String? = try {
        validar(m)
        null
    } catch (e: NoCumple) {
        e.message
    }

    private fun validar(m: JSONObject) {
        when (val tipo = m.optString("type")) {
            "status" -> status(m)
            "relay_request" -> {
                ref(m)
                when (enumerado(m, "motivo", setOf("patrulla", "seguimiento"))) {
                    "patrulla" -> {
                        entero(m, "routeId", 1)
                        entero(m, "fromIndex", 0)
                    }
                    else -> {
                        entero(m, "alertId", 1)
                        if (!m.has("segundosDisponibles")) throw NoCumple("falta segundosDisponibles")
                        if (!m.isNull("segundosDisponibles")) numero(m, "segundosDisponibles", 0.0, 3_600.0)
                    }
                }
            }
            "relay_accept", "relay_ready", "relay_released" -> entero(m, "relayId", 1)
            "relay_reject", "relay_abort" -> {
                entero(m, "relayId", 1)
                enumerado(m, "motivo", MOTIVOS.getValue(tipo))
                detalle(m)
            }
            "relay_abandon" -> {
                entero(m, "relayId", 1)
                if (m.has("motivo")) enumerado(m, "motivo", MOTIVOS.getValue(tipo))
            }
            "landing_at_base" -> {
                ref(m)
                enteroONulo(m, "relayId")
                enteroONulo(m, "baseId")
                posicionONula(m)
                entero(m, "routeId", 1)
                entero(m, "fromIndex", 0)
            }
            "landed_at_base" -> {
                enteroONulo(m, "relayId")
                enteroONulo(m, "baseId")
                posicionONula(m)
            }
            "rth_diverted" -> {
                enteroONulo(m, "relayId")
                val motivo = enumerado(m, "motivo", setOf("otra_base", "emergencia"))
                if (!m.has("baseId")) throw NoCumple("falta baseId")
                if (motivo == "otra_base") entero(m, "baseId", 1)
                if (motivo == "emergencia" && !m.isNull("baseId")) throw NoCumple("con emergencia baseId es null")
                posicionONula(m)
            }
            "emergency_landing" -> {
                ref(m)
                enumerado(m, "motivo", setOf("autonomia", "bateria_critica_dji"))
                posicionONula(m)
                altura(m)
                numero(m, "bateria", 0.0, 100.0)
                entero(m, "ts", 1)
            }
            "emergency_photo" -> {
                ref(m)
                entero(m, "seq", 0, 7)
                enumerado(m, "tipo", setOf("oblicua", "cenital", "panoramica"))
                numero(m, "rumbo", 0.0, 360.0)
                numero(m, "inclinacion", -90.0, 30.0)
                posicionONula(m)
                altura(m)
                val jpeg = m.opt("jpegBase64") as? String ?: throw NoCumple("jpegBase64 no es texto")
                if (jpeg.length !in 1..400_000 || !BASE64.matches(jpeg) || !jpeg.startsWith("/9j/")) {
                    throw NoCumple("jpegBase64 no es un JPEG en base64 que entre")
                }
                entero(m, "ts", 1)
            }
            "emergency_landed" -> {
                ref(m)
                posicionONula(m)
                altura(m)
                entero(m, "ts", 1)
            }
            else -> throw NoCumple("type '$tipo' no es de §1.b")
        }
    }

    private fun status(m: JSONObject) {
        m.optJSONObject("relevo")?.let { r ->
            val enEspera = r.opt("enEspera") as? Boolean ?: throw NoCumple("relevo.enEspera")
            val disponible = r.opt("disponible") as? Boolean ?: throw NoCumple("relevo.disponible")
            if (disponible && !enEspera) throw NoCumple("relevo disponible sin estar en espera")
            val sinRelevo = r.isNull("relayId")
            if (!sinRelevo) entero(r, "relayId", 1)
            if (sinRelevo != r.isNull("rol") || sinRelevo != r.isNull("fase")) {
                throw NoCumple("rol y fase son null si y solo si relayId es null")
            }
            if (!sinRelevo) {
                val rol = enumerado(r, "rol", FASES.keys)
                enumerado(r, "fase", FASES.getValue(rol))
            }
        }
        m.optJSONObject("autonomia")?.let { a ->
            for ((campo, tope) in listOf("pctParaVolver" to 100.0, "pctParaAterrizar" to 100.0, "alcanceM" to 100_000.0, "segundosParaVolver" to 36_000.0)) {
                if (!a.has(campo)) throw NoCumple("autonomia.$campo falta")
                if (!a.isNull(campo)) numero(a, campo, 0.0, tope)
            }
        }
        m.optJSONObject("target")?.let { t ->
            if (t.has("vNorteMs") || t.has("vEsteMs")) {
                val vn = numero(t, "vNorteMs")
                val ve = numero(t, "vEsteMs")
                if (hypot(vn, ve) > 40.0) throw NoCumple("target: más de 40 m/s")
            }
        }
    }

    private fun ref(m: JSONObject) {
        val r = m.opt("ref") as? String ?: throw NoCumple("ref no es texto")
        if (r.length !in 1..64) throw NoCumple("ref de ${r.length} caracteres")
    }

    private fun detalle(m: JSONObject) {
        if (!m.has("detalle")) return
        val d = m.opt("detalle") as? String ?: throw NoCumple("detalle no es texto")
        if (d.length > 200) throw NoCumple("detalle de ${d.length} caracteres")
    }

    private fun enumerado(m: JSONObject, campo: String, valores: Set<String>): String {
        val v = m.opt(campo) as? String ?: throw NoCumple("$campo no es texto")
        if (v !in valores) throw NoCumple("$campo '$v' no vale")
        return v
    }

    private fun numero(m: JSONObject, campo: String, minimo: Double = Double.NEGATIVE_INFINITY, maximo: Double = Double.POSITIVE_INFINITY): Double {
        val v = m.opt(campo)
        if (v !is Number) throw NoCumple("$campo no es un número")
        val d = v.toDouble()
        if (!d.isFinite() || d < minimo || d > maximo) throw NoCumple("$campo $d fuera de rango")
        return d
    }

    private fun entero(m: JSONObject, campo: String, minimo: Long, maximo: Long = ENTERO_SEGURO): Long {
        val v = m.opt(campo)
        val n = when (v) {
            is Int -> v.toLong()
            is Long -> v
            is Double -> if (v % 1.0 == 0.0 && abs(v) <= ENTERO_SEGURO) v.toLong() else throw NoCumple("$campo no es entero")
            else -> throw NoCumple("$campo no es un entero")
        }
        if (n !in minimo..maximo) throw NoCumple("$campo $n fuera de rango")
        return n
    }

    private fun enteroONulo(m: JSONObject, campo: String) {
        if (!m.has(campo)) throw NoCumple("falta $campo")
        if (!m.isNull(campo)) entero(m, campo, 1)
    }

    private fun altura(m: JSONObject) = numero(m, "alt", -200.0, 1_000.0)

    private fun posicionONula(m: JSONObject) {
        if (!m.has("lat") || !m.has("lon")) throw NoCumple("falta lat o lon")
        val latNula = m.isNull("lat")
        val lonNula = m.isNull("lon")
        if (latNula && lonNula) return
        if (latNula || lonNula) throw NoCumple("lat y lon van los dos o ninguno")
        val lat = numero(m, "lat", -90.0, 90.0)
        val lon = numero(m, "lon", -180.0, 180.0)
        if (abs(lat) < 1e-6 && abs(lon) < 1e-6) throw NoCumple("0,0 no es una posición")
    }
}
