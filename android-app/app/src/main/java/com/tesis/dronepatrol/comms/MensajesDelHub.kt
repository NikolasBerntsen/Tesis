package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Waypoint
import java.math.BigDecimal
import java.math.BigInteger
import kotlin.math.abs
import kotlin.math.hypot
import org.json.JSONArray
import org.json.JSONObject

/**
 * Un dron del otro lado de un relevo (`de`, `relevo`, `relevadoPor` en
 * docs/PROTOCOLS.md §2.b): su identificador en el protocolo y el nombre que ve
 * el operador.
 */
data class Participante(val droneId: String, val displayName: String)

/**
 * Una base de las que manda el hub en `bases` (docs/PROTOCOLS.md §2.b): el
 * punto de la base y, si la base lo declara, el punto donde baja un dron que se
 * desvía desde otra (docs/RELEVOS.md §0).
 */
data class BaseDelHub(
    val id: Long,
    val nombre: String,
    val lat: Double,
    val lon: Double,
    /** Punto de aterrizaje para visitantes; null si la base no lo declara (los dos o ninguno). */
    val aterrizajeLat: Double?,
    val aterrizajeLon: Double?,
)

/**
 * El `objetivo` de un relevo de seguimiento (docs/PROTOCOLS.md §2.b, "Objetivo
 * de un relevo"): el `status.target` de A con la velocidad en componentes, que
 * es con lo que B siembra su rastreador.
 */
data class ObjetivoDelRelevo(
    val alertId: Long,
    /** `PERSON` o `VEHICLE`. */
    val tipo: String,
    val lat: Double,
    val lon: Double,
    val velocidadMs: Double,
    val rumboGrados: Double,
    val enMovimiento: Boolean,
    val perdido: Boolean,
    val vistoHaceMs: Long,
    val decision: String,
    val vNorteMs: Double,
    val vEsteMs: Double,
)

/**
 * Los mensajes de docs/PROTOCOLS.md §2.b ya validados y con tipo. La app no ve
 * nunca el JSON de un relevo: si un mensaje no cumple el contrato no llega acá
 * (salvo [OrdenInvalida], que tiene respuesta).
 */
sealed interface MensajeDelHub {
    /** `bases`: la lista entera, que reemplaza a la anterior. */
    data class Bases(val propiaId: Long?, val bases: List<BaseDelHub>) : MensajeDelHub {
        val propia: BaseDelHub? get() = bases.firstOrNull { it.id == propiaId }
    }

    /** `relay_status`: cómo va el pedido de A. */
    data class EstadoDelPedido(
        val ref: String,
        val relayId: Long,
        val estado: String,
        val relevo: Participante?,
        val etaS: Double?,
        val motivoFin: String?,
    ) : MensajeDelHub {
        val terminal: Boolean get() = estado in LectorDelHub.ESTADOS_TERMINALES
    }

    /** `relay_start`: B releva una patrulla. */
    data class OrdenDePatrulla(
        val relayId: Long,
        val ruta: PatrolRoute,
        val fromIndex: Int,
        val de: Participante,
    ) : MensajeDelHub

    /** `relay_tracking`: B releva un seguimiento. */
    data class OrdenDeSeguimiento(
        val relayId: Long,
        val alertId: Long,
        val decision: String,
        val objetivo: ObjetivoDelRelevo,
        val de: Participante,
        /** Hora DEL HUB: sirve solo para ordenar (nunca se compara con el reloj del teléfono). */
        val ts: Long,
    ) : MensajeDelHub

    /** `relay_target`: dónde está el objetivo ahora y dónde está A. */
    data class ObjetivoActualizado(
        val relayId: Long,
        val alertId: Long,
        val decision: String,
        val objetivo: ObjetivoDelRelevo,
        /** `en_linea`, `sin_enlace` o `retirado`: si A sigue al objetivo, no dónde está. */
        val origen: String,
        val aLat: Double?,
        val aLon: Double?,
        val aAlt: Double?,
        /** El último status de A dice que está en tierra. */
        val aEnTierra: Boolean,
        val ts: Long,
    ) : MensajeDelHub

    /** `relay_go`: B ya puede despegar. */
    data class Despegar(val relayId: Long) : MensajeDelHub

    /** `relay_done`: A ya puede soltar el objetivo. */
    data class Traspaso(val relayId: Long, val alertId: Long, val relevadoPor: Participante) : MensajeDelHub

    /**
     * `relay_cancel`. [motivo] ya viene normalizado: uno que no está en la lista
     * llega como `otro`, porque cancelar se aplica igual (es el lado seguro).
     */
    data class Cancelacion(val relayId: Long, val motivo: String) : MensajeDelHub

    /** `emergency_ack`. */
    data class AcuseDeEmergencia(val ref: String, val emergencyId: Long, val aterrizada: Boolean) : MensajeDelHub

    /** `emergency_photo_ack`. */
    data class AcuseDeFoto(val ref: String, val seq: Int) : MensajeDelHub

    /**
     * Un `relay_start` o `relay_tracking` que no pasó la validación pero trae
     * un `relayId` válido: la app le contesta `relay_reject` con
     * `mensaje_invalido` para que el hub pruebe con otro dron sin esperar 10 s.
     */
    data class OrdenInvalida(val relayId: Long, val tipo: String, val detalle: String) : MensajeDelHub
}

/**
 * La validación de los mensajes del hub de docs/PROTOCOLS.md §2.b, en un solo
 * lugar: cada mensaje sale de acá convertido en un [MensajeDelHub] o en nada.
 * La usa solo [CommandCenterClient.manejarMensaje].
 *
 * Es estricta a propósito, con las convenciones de §1.b: nada se convierte (un
 * número en texto, un booleano o un null que la tabla no admite invalidan el
 * mensaje entero), las posiciones son posiciones de verdad (0,0 no lo es) y los
 * enumerados van exactos. Un mensaje mal formado se ignora, que es siempre el
 * lado seguro: un `relay_go` inválido no despega, un `bases` inválido deja la
 * lista anterior. Los campos que el contrato no nombra se ignoran.
 */
internal object LectorDelHub {

    val ESTADOS_DEL_RELEVO = setOf(
        "RESERVADO", "ORDENADO", "EN_CAMINO", "TRASPASO", "SIN_RELEVO", "COMPLETADO", "CANCELADO", "FALLIDO",
    )
    val ESTADOS_TERMINALES = setOf("COMPLETADO", "CANCELADO", "FALLIDO")
    private val MOTIVOS_DE_FIN = mapOf(
        "COMPLETADO" to setOf("origen_sin_confirmar"),
        "CANCELADO" to setOf("orden_del_operador", "alerta_descartada", "sin_relevo", "origen_se_fue"),
        "FALLIDO" to setOf("relevo_abortado", "relevo_desconectado", "sin_despegue", "relevo_perdio_estado"),
    )
    val MOTIVOS_DE_CANCELACION = setOf("alerta_descartada", "vencido", "terminado", "inexistente")
    private val ORIGENES = setOf("en_linea", "sin_enlace", "retirado")
    private val DECISIONES = setOf("PENDING", "VALIDATED")
    private val TIPOS = setOf("PERSON", "VEHICLE")

    /** `Number.MAX_SAFE_INTEGER` de JavaScript: el hub no manda enteros más grandes. */
    private const val ENTERO_SEGURO_MAXIMO = 9_007_199_254_740_991L
    private const val REF_MAXIMO = 64
    private const val BASES_MAXIMAS = 200
    private const val NOMBRE_BASE_MAXIMO = 60
    private const val NODOS_MINIMOS = 2
    private const val NODOS_MAXIMOS = 60
    private const val ALTURA_NODO_MAXIMA_M = 500.0
    private const val APODO_NODO_MAXIMO = 40
    private const val VELOCIDAD_MAXIMA_MS = 40.0
    private const val SEQ_MAXIMO = 7
    private const val ALTURA_MINIMA_M = -200.0
    private const val ALTURA_MAXIMA_M = 1_000.0
    private val HASH_DE_DRON = Regex("^[0-9a-f]{32}$")

    /** Lo que se le contesta al llamador: el mensaje con tipo, o por qué no pasó. */
    sealed interface Lectura {
        data class Valido(val mensaje: MensajeDelHub) : Lectura
        data class Invalido(val porque: String) : Lectura
    }

    /** Un campo que no cumple el contrato; lleva el nombre del campo para el registro. */
    private class CampoInvalido(val porque: String) : Exception(porque)

    /** Los tipos de §2.b; cualquier otro `type` no es de esta sección. */
    val TIPOS_DE_MENSAJE = setOf(
        "bases", "relay_status", "relay_start", "relay_tracking", "relay_target", "relay_go", "relay_done",
        "relay_cancel", "emergency_ack", "emergency_photo_ack",
    )

    fun leer(msg: JSONObject): Lectura {
        val tipo = msg.optString("type")
        return try {
            Lectura.Valido(
                when (tipo) {
                    "bases" -> bases(msg)
                    "relay_status" -> estadoDelPedido(msg)
                    "relay_start" -> ordenOInvalida(msg, tipo) { ordenDePatrulla(msg) }
                    "relay_tracking" -> ordenOInvalida(msg, tipo) { ordenDeSeguimiento(msg) }
                    "relay_target" -> objetivoActualizado(msg)
                    "relay_go" -> MensajeDelHub.Despegar(entero(msg, "relayId"))
                    "relay_done" -> MensajeDelHub.Traspaso(
                        entero(msg, "relayId"),
                        entero(msg, "alertId"),
                        participante(msg, "relevadoPor"),
                    )
                    "relay_cancel" -> cancelacion(msg)
                    "emergency_ack" -> MensajeDelHub.AcuseDeEmergencia(
                        ref(msg),
                        entero(msg, "emergencyId"),
                        booleano(msg, "aterrizada"),
                    )
                    "emergency_photo_ack" -> MensajeDelHub.AcuseDeFoto(
                        ref(msg),
                        entero(msg, "seq", minimo = 0, maximo = SEQ_MAXIMO.toLong()).toInt(),
                    )
                    else -> throw CampoInvalido("type '$tipo' no es un mensaje de relevos")
                },
            )
        } catch (e: CampoInvalido) {
            Lectura.Invalido("$tipo: ${e.porque}")
        }
    }

    /**
     * Una orden a B inválida pero con un `relayId` que sirve para contestarle:
     * se convierte en [MensajeDelHub.OrdenInvalida]. Sin `relayId` válido no hay
     * a quién contestar y queda inválida.
     */
    private fun ordenOInvalida(msg: JSONObject, tipo: String, leerOrden: () -> MensajeDelHub): MensajeDelHub =
        try {
            leerOrden()
        } catch (e: CampoInvalido) {
            val relayId = try {
                entero(msg, "relayId")
            } catch (_: CampoInvalido) {
                throw e
            }
            MensajeDelHub.OrdenInvalida(relayId, tipo, e.porque)
        }

    private fun bases(msg: JSONObject): MensajeDelHub.Bases {
        val propiaId = enteroONulo(msg, "propiaId")
        val lista = lista(msg, "bases", minimo = 0, maximo = BASES_MAXIMAS)
        val bases = (0 until lista.length()).map { i ->
            val b = lista.opt(i) as? JSONObject ?: throw CampoInvalido("bases[$i] no es un objeto")
            val nombre = texto(b, "nombre", minimo = 1, maximo = NOMBRE_BASE_MAXIMO)
            val (lat, lon) = posicion(b, "lat", "lon")
            val (aLat, aLon) = posicionONula(b, "aterrizajeLat", "aterrizajeLon")
            BaseDelHub(entero(b, "id"), nombre, lat, lon, aLat, aLon)
        }
        if (propiaId != null && bases.none { it.id == propiaId }) {
            throw CampoInvalido("propiaId $propiaId no es ninguna de las bases")
        }
        return MensajeDelHub.Bases(propiaId, bases)
    }

    private fun estadoDelPedido(msg: JSONObject): MensajeDelHub.EstadoDelPedido {
        val estado = enumerado(msg, "estado", ESTADOS_DEL_RELEVO)
        val motivoFin = if (presenteYNulo(msg, "motivoFin")) {
            null
        } else {
            val m = texto(msg, "motivoFin", minimo = 1, maximo = REF_MAXIMO)
            if (m !in MOTIVOS_DE_FIN[estado].orEmpty()) throw CampoInvalido("motivoFin '$m' no vale en $estado")
            m
        }
        return MensajeDelHub.EstadoDelPedido(
            ref = ref(msg),
            relayId = entero(msg, "relayId"),
            estado = estado,
            relevo = if (presenteYNulo(msg, "relevo")) null else participante(msg, "relevo"),
            etaS = if (presenteYNulo(msg, "etaS")) null else numero(msg, "etaS", minimo = 0.0),
            motivoFin = motivoFin,
        )
    }

    private fun ordenDePatrulla(msg: JSONObject): MensajeDelHub.OrdenDePatrulla {
        val relayId = entero(msg, "relayId")
        enumerado(msg, "motivo", setOf("patrulla"))
        val ruta = objeto(msg, "ruta")
        val nodos = lista(ruta, "waypoints", minimo = NODOS_MINIMOS, maximo = NODOS_MAXIMOS)
        val waypoints = (0 until nodos.length()).map { i ->
            val w = nodos.opt(i) as? JSONObject ?: throw CampoInvalido("ruta.waypoints[$i] no es un objeto")
            val (lat, lon) = posicion(w, "lat", "lon")
            val alt = numero(w, "alt", minimo = 0.0, maximo = ALTURA_NODO_MAXIMA_M)
            if (w.has("label")) texto(w, "label", minimo = 0, maximo = APODO_NODO_MAXIMO)
            Waypoint(lat, lon, alt)
        }
        val fromIndex = entero(msg, "fromIndex", minimo = 0).toInt()
        if (fromIndex >= waypoints.size) throw CampoInvalido("fromIndex $fromIndex fuera de la ruta de ${waypoints.size} nodos")
        val idRuta = entero(ruta, "id")
        if (idRuta > Int.MAX_VALUE) throw CampoInvalido("ruta.id fuera de rango")
        return MensajeDelHub.OrdenDePatrulla(
            relayId = relayId,
            ruta = PatrolRoute(idRuta.toInt(), texto(ruta, "name", minimo = 0, maximo = Int.MAX_VALUE), waypoints),
            fromIndex = fromIndex,
            de = participante(msg, "de"),
        )
    }

    private fun ordenDeSeguimiento(msg: JSONObject): MensajeDelHub.OrdenDeSeguimiento {
        val relayId = entero(msg, "relayId")
        val alertId = entero(msg, "alertId")
        val decision = enumerado(msg, "decision", DECISIONES)
        return MensajeDelHub.OrdenDeSeguimiento(
            relayId = relayId,
            alertId = alertId,
            decision = decision,
            objetivo = objetivo(msg, alertId, decision),
            de = participante(msg, "de"),
            ts = entero(msg, "ts"),
        )
    }

    private fun objetivoActualizado(msg: JSONObject): MensajeDelHub.ObjetivoActualizado {
        val alertId = entero(msg, "alertId")
        val decision = enumerado(msg, "decision", DECISIONES)
        val (aLat, aLon) = posicionONula(msg, "aLat", "aLon")
        return MensajeDelHub.ObjetivoActualizado(
            relayId = entero(msg, "relayId"),
            alertId = alertId,
            decision = decision,
            objetivo = objetivo(msg, alertId, decision),
            origen = enumerado(msg, "origen", ORIGENES),
            aLat = aLat,
            aLon = aLon,
            aAlt = if (presenteYNulo(msg, "aAlt")) null else numero(msg, "aAlt", ALTURA_MINIMA_M, ALTURA_MAXIMA_M),
            aEnTierra = booleano(msg, "aEnTierra"),
            ts = entero(msg, "ts"),
        )
    }

    private fun objetivo(msg: JSONObject, alertId: Long, decision: String): ObjetivoDelRelevo {
        val o = objeto(msg, "objetivo")
        val suAlerta = entero(o, "alertId")
        if (suAlerta != alertId) throw CampoInvalido("objetivo.alertId $suAlerta no es la alerta $alertId del mensaje")
        val suDecision = enumerado(o, "decision", DECISIONES)
        if (suDecision != decision) throw CampoInvalido("objetivo.decision no es la del mensaje")
        val (lat, lon) = posicion(o, "lat", "lon")
        val vNorte = numero(o, "vNorteMs")
        val vEste = numero(o, "vEsteMs")
        if (hypot(vNorte, vEste) > VELOCIDAD_MAXIMA_MS) throw CampoInvalido("objetivo: velocidad de más de 40 m/s")
        return ObjetivoDelRelevo(
            alertId = suAlerta,
            tipo = enumerado(o, "type", TIPOS),
            lat = lat,
            lon = lon,
            velocidadMs = numero(o, "speedMs", minimo = 0.0, maximo = VELOCIDAD_MAXIMA_MS),
            rumboGrados = numero(o, "courseDeg", minimo = 0.0, maximo = 360.0),
            enMovimiento = booleano(o, "moving"),
            perdido = booleano(o, "lost"),
            vistoHaceMs = entero(o, "lastSeenMs", minimo = 0),
            decision = suDecision,
            vNorteMs = vNorte,
            vEsteMs = vEste,
        )
    }

    private fun cancelacion(msg: JSONObject): MensajeDelHub.Cancelacion {
        val relayId = entero(msg, "relayId")
        // Cancelar es siempre el lado seguro: un motivo que no está en la
        // lista (o que falta) no frena la cancelación, se anota como "otro".
        val motivo = (msg.opt("motivo") as? String)?.takeIf { it in MOTIVOS_DE_CANCELACION } ?: "otro"
        return MensajeDelHub.Cancelacion(relayId, motivo)
    }

    // ---- Las piezas de §1.b, "Convenciones" ----

    private fun ref(msg: JSONObject): String = texto(msg, "ref", minimo = 1, maximo = REF_MAXIMO)

    private fun participante(msg: JSONObject, campo: String): Participante {
        val p = objeto(msg, campo)
        val id = texto(p, "droneId", minimo = 32, maximo = 32)
        if (!HASH_DE_DRON.matches(id)) throw CampoInvalido("$campo.droneId no son 32 hexadecimales en minúsculas")
        return Participante(id, texto(p, "displayName", minimo = 0, maximo = Int.MAX_VALUE))
    }

    private fun presenteYNulo(o: JSONObject, campo: String): Boolean {
        if (!o.has(campo)) throw CampoInvalido("falta $campo")
        return o.isNull(campo)
    }

    private fun objeto(o: JSONObject, campo: String): JSONObject =
        o.opt(campo) as? JSONObject ?: throw CampoInvalido("$campo no es un objeto")

    private fun lista(o: JSONObject, campo: String, minimo: Int, maximo: Int): JSONArray {
        val l = o.opt(campo) as? JSONArray ?: throw CampoInvalido("$campo no es una lista")
        if (l.length() !in minimo..maximo) throw CampoInvalido("$campo tiene ${l.length()} elementos")
        return l
    }

    private fun texto(o: JSONObject, campo: String, minimo: Int, maximo: Int): String {
        val t = o.opt(campo) as? String ?: throw CampoInvalido("$campo no es texto")
        if (t.length !in minimo..maximo) throw CampoInvalido("$campo tiene ${t.length} caracteres")
        return t
    }

    private fun booleano(o: JSONObject, campo: String): Boolean =
        o.opt(campo) as? Boolean ?: throw CampoInvalido("$campo no es booleano")

    private fun enumerado(o: JSONObject, campo: String, valores: Set<String>): String {
        val t = o.opt(campo) as? String ?: throw CampoInvalido("$campo no es texto")
        if (t !in valores) throw CampoInvalido("$campo '$t' no es uno de $valores")
        return t
    }

    private fun numero(
        o: JSONObject,
        campo: String,
        minimo: Double = Double.NEGATIVE_INFINITY,
        maximo: Double = Double.POSITIVE_INFINITY,
    ): Double {
        val v = numeroCrudo(o.opt(campo)) ?: throw CampoInvalido("$campo no es un número")
        if (!v.isFinite() || v < minimo || v > maximo) throw CampoInvalido("$campo $v fuera de rango")
        return v
    }

    /** Un número del JSON (nunca texto ni booleano), o null. */
    private fun numeroCrudo(v: Any?): Double? = when (v) {
        is Boolean -> null
        is Number -> v.toDouble()
        else -> null
    }

    /** Un entero seguro en [minimo, maximo]: `7.5`, `"7"` o `true` no lo son. */
    internal fun enteroValido(v: Any?, minimo: Long = 1, maximo: Long = ENTERO_SEGURO_MAXIMO): Long? {
        val entero: Long = when (v) {
            is Int -> v.toLong()
            is Long -> v
            is Short -> v.toLong()
            is Byte -> v.toLong()
            is BigInteger -> if (v.bitLength() < 63) v.toLong() else return null
            is BigDecimal -> runCatching { v.longValueExact() }.getOrNull() ?: return null
            is Double -> if (v.isFinite() && v % 1.0 == 0.0 && abs(v) <= ENTERO_SEGURO_MAXIMO) v.toLong() else return null
            is Float -> if (v.isFinite() && v % 1.0f == 0.0f) v.toLong() else return null
            else -> return null
        }
        return entero.takeIf { abs(it) <= ENTERO_SEGURO_MAXIMO && it in minimo..maximo }
    }

    private fun entero(o: JSONObject, campo: String, minimo: Long = 1, maximo: Long = ENTERO_SEGURO_MAXIMO): Long =
        enteroValido(o.opt(campo), minimo, maximo) ?: throw CampoInvalido("$campo no es un entero en [$minimo, $maximo]")

    private fun enteroONulo(o: JSONObject, campo: String): Long? =
        if (presenteYNulo(o, campo)) null else entero(o, campo)

    /** Una posición de verdad: los dos números, finitos, en rango y no 0,0 (un null tampoco lo es). */
    private fun posicion(o: JSONObject, campoLat: String, campoLon: String): Pair<Double, Double> {
        if (!o.has(campoLat) || !o.has(campoLon)) throw CampoInvalido("falta $campoLat o $campoLon")
        val lat = numeroCrudo(o.opt(campoLat)) ?: throw CampoInvalido("$campoLat no es un número")
        val lon = numeroCrudo(o.opt(campoLon)) ?: throw CampoInvalido("$campoLon no es un número")
        if (!Geo.esPosicionValida(lat, lon)) throw CampoInvalido("$campoLat/$campoLon ($lat, $lon) no es una posición")
        return lat to lon
    }

    /** Una posición o los dos null ("posición o `null`" de §1.b). Uno solo en null es inválido. */
    private fun posicionONula(o: JSONObject, campoLat: String, campoLon: String): Pair<Double?, Double?> {
        if (!o.has(campoLat) || !o.has(campoLon)) throw CampoInvalido("falta $campoLat o $campoLon")
        val latNula = o.isNull(campoLat)
        val lonNula = o.isNull(campoLon)
        if (latNula && lonNula) return null to null
        if (latNula || lonNula) throw CampoInvalido("$campoLat/$campoLon: los dos números o los dos null")
        return posicion(o, campoLat, campoLon)
    }
}
