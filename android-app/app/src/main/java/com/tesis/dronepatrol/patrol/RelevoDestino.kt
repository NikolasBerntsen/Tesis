package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.MensajeDelHub
import com.tesis.dronepatrol.comms.ObjetivoDelRelevo
import com.tesis.dronepatrol.comms.Participante
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.RastreadorDeObjetivo
import com.tesis.dronepatrol.model.PatrolRoute
import kotlin.math.hypot

/** Dónde está B dentro de un relevo (`status.relevo.fase` con `rol: "relevo"`, docs/PROTOCOLS.md §1). */
enum class FaseDelRelevo(val texto: String) {
    /** Aceptó: habilita el mando virtual en el suelo y corre la cuenta de 10 s. */
    CUENTA_REGRESIVA("cuenta_regresiva"),

    /** Relevo de patrulla: terminó la cuenta y espera `relay_go`. */
    ESPERANDO_DESPEGUE("esperando_despegue"),
    DESPEGANDO("despegando"),
    EN_CAMINO("en_camino"),

    /** Mandó `relay_ready` en un seguimiento y espera que A se aleje. */
    TRASPASO("traspaso"),
}

/**
 * La cuenta regresiva de B en el teléfono (docs/RELEVOS.md §2.4): audible, de
 * 10 s, con «Cancelar». Es lo que ve el operador de campo al lado del dron que
 * está por despegar solo.
 */
data class CuentaRegresiva(
    val relayId: Long,
    /** El dron que B va a relevar (A). */
    val de: String,
    /** Segundos que faltan; 0 al terminar. */
    val segundos: Int,
    val esSeguimiento: Boolean,
    /** Todavía se está habilitando el mando virtual: la cuenta no arrancó. */
    val habilitando: Boolean,
    /** Relevo de patrulla: terminó la cuenta y espera que A esté abajo (`relay_go`). */
    val esperandoQueBajeA: Boolean,
)

/**
 * El relevo que B está atendiendo, desde que acepta la orden hasta que la
 * cumple (o se cancela): qué se le pidió, por dónde va y lo último que sabe del
 * objetivo y de A.
 */
class RelevoAsignado(
    val relayId: Long,
    val de: Participante,
    /** Relevo de patrulla: la ruta de A y el nodo hacia el que volaba. */
    val ruta: PatrolRoute?,
    val fromIndex: Int,
    /** Relevo de seguimiento: la alerta del objetivo. */
    val alertId: Long?,
    val aceptadoMs: Long,
) {
    val esSeguimiento: Boolean get() = alertId != null

    var fase = FaseDelRelevo.CUENTA_REGRESIVA

    /** Desde cuándo corre la cuenta regresiva; null mientras se habilita el mando virtual. */
    var cuentaDesdeMs: Long? = null

    /** Llegó `relay_go` (solo patrulla). */
    var goRecibido = false

    var despegueDesdeMs: Long? = null

    /** Seguimiento: la última estimación válida del objetivo y la hora del teléfono en que llegó. */
    var objetivo: ObjetivoDelRelevo? = null
    var objetivoRecibidoMs = aceptadoMs

    /** `ts` del hub del último objetivo aplicado: solo para descartar uno viejo, nunca contra el reloj propio. */
    var ultimoTs = Long.MIN_VALUE

    /** Hora del teléfono del último `relay_target`. */
    var ultimoTargetMs = aceptadoMs

    var decision = "PENDING"

    /**
     * `en_linea`, `sin_enlace` o `retirado` del último `relay_target`. Un
     * `retirado` es para siempre: A ya no vuelve al objetivo, y un mensaje
     * posterior que diga otra cosa no lo trae de vuelta (ver [anotarOrigen]).
     */
    var origen = "en_linea"
        private set
    var aLat: Double? = null
    var aLon: Double? = null
    var aAlt: Double? = null

    /** La altura a la que sube para ir hacia el objetivo. */
    var alturaDeTransito = Autonomia.ALTURA_TRANSITO_M

    /**
     * La altura de A en el momento de la toma: es la de seguimiento, a la que
     * B baja cuando A se fue. null si A no la informó.
     */
    var alturaDeA: Double? = null

    /** Desde cuándo B baja en el lugar a la altura de seguimiento; null si todavía no. */
    var bajandoDesdeMs: Long? = null

    /** La altura a la que está bajando (ver [bajandoDesdeMs]). */
    var alturaDeBajada = Aproximacion.ALTURA_DE_SEGUIMIENTO_POR_DEFECTO_M

    val aRetirado: Boolean get() = origen == "retirado"

    /** El origen de un `relay_target`, sin volver nunca atrás de `retirado`. */
    fun anotarOrigen(nuevo: String) {
        if (!aRetirado) origen = nuevo
    }

    /** Última orden de tránsito: se renueva una vez por segundo, no en cada vuelta del lazo. */
    var ultimaOrdenMs = Long.MIN_VALUE / 2

    companion object {
        fun de(orden: MensajeDelHub.OrdenDePatrulla, ahoraMs: Long) =
            RelevoAsignado(orden.relayId, orden.de, orden.ruta, orden.fromIndex, null, ahoraMs)

        fun de(orden: MensajeDelHub.OrdenDeSeguimiento, ahoraMs: Long) =
            RelevoAsignado(orden.relayId, orden.de, null, 0, orden.alertId, ahoraMs).also {
                it.objetivo = orden.objetivo
                it.decision = orden.decision
                it.ultimoTs = orden.ts
            }
    }
}

/**
 * La geometría de B en un relevo de seguimiento (docs/RELEVOS.md §3.4 y §3.5):
 * hacia dónde vuela, dónde se detiene, a qué altura y cuándo baja. Pura, para
 * probar cada borde sin dron.
 */
object Aproximacion {

    /** B se detiene a esto del objetivo, del lado por el que llega. */
    const val DISTANCIA_TOMA_M = 60.0

    /** Cuánto más cerca que [DISTANCIA_TOMA_M] cuenta como llegado: el objetivo se mueve. */
    const val TOLERANCIA_TOMA_M = 8.0

    /** B queda esto por encima de A en el traspaso. */
    const val SEPARACION_VERTICAL_M = 20.0

    /** B baja recién con A a más de esto del objetivo (o retirado). */
    const val A_LEJOS_M = 100.0

    /**
     * Altura de seguimiento cuando no se sabe la de A: la de crucero de una
     * ruta típica, a la que el detector ve bien a una persona.
     */
    const val ALTURA_DE_SEGUIMIENTO_POR_DEFECTO_M = 40.0

    /** Por debajo de esto B no baja a seguir: la proyección al terreno ya no sirve. */
    const val ALTURA_DE_SEGUIMIENTO_MINIMA_M = 15.0

    /** Cuánto de más sobre la altura de seguimiento ya cuenta como "bajó". */
    const val TOLERANCIA_DE_ALTURA_M = 2.0

    /** Crucero de B hacia el objetivo, para estimar cuánto tarda en llegar. */
    const val VELOCIDAD_DE_TRANSITO_MS = 8.0

    /** Más allá de esto la velocidad de un objetivo ya no dice dónde va a estar. */
    const val EXTRAPOLACION_MAXIMA_MS = 30_000L

    /**
     * La altura del tránsito: [Autonomia.ALTURA_TRANSITO_M], o más si hace falta
     * para quedar [SEPARACION_VERTICAL_M] por encima de A, dentro de 15..120.
     */
    fun alturaDeTransito(aAlt: Double?): Double {
        val sobreA = aAlt?.takeIf { it.isFinite() }?.plus(SEPARACION_VERTICAL_M) ?: Autonomia.ALTURA_TRANSITO_M
        return maxOf(Autonomia.ALTURA_TRANSITO_M, sobreA)
            .coerceIn(Autonomia.ALTURA_TRANSITO_MINIMA_M, Autonomia.ALTURA_TRANSITO_MAXIMA_M)
    }

    /**
     * Dónde se espera al objetivo dentro de [adelantoMs] desde [ahoraMs]: la
     * estimación de A extrapolada con su velocidad (si se mueve) por el tiempo
     * desde que llegó más el adelanto, hasta [EXTRAPOLACION_MAXIMA_MS].
     */
    fun estimacion(o: ObjetivoDelRelevo, recibidoMs: Long, ahoraMs: Long, adelantoMs: Long = 0L): Pair<Double, Double> {
        if (!o.enMovimiento) return o.lat to o.lon
        val s = ((ahoraMs - recibidoMs).coerceAtLeast(0L) + adelantoMs).coerceAtMost(EXTRAPOLACION_MAXIMA_MS) / 1_000.0
        return (o.lat + o.vNorteMs * s / Geo.METROS_POR_GRADO_LAT) to
            (o.lon + o.vEsteMs * s / Geo.metrosPorGradoLon(o.lat))
    }

    /** El punto de toma: a [DISTANCIA_TOMA_M] de ([oLat], [oLon]) en la dirección en que está B. */
    fun puntoDeToma(oLat: Double, oLon: Double, bLat: Double, bLon: Double): Pair<Double, Double> {
        val norte = (bLat - oLat) * Geo.METROS_POR_GRADO_LAT
        val este = (bLon - oLon) * Geo.metrosPorGradoLon(oLat)
        val d = hypot(norte, este)
        // Encima del objetivo no hay lado de llegada: se toma el sur.
        val (uNorte, uEste) = if (d > 1.0) norte / d to este / d else -1.0 to 0.0
        return (oLat + uNorte * DISTANCIA_TOMA_M / Geo.METROS_POR_GRADO_LAT) to
            (oLon + uEste * DISTANCIA_TOMA_M / Geo.metrosPorGradoLon(oLat))
    }

    /**
     * Hacia dónde vuela B en tránsito: el punto de toma de donde va a estar el
     * objetivo cuando B llegue (la extrapolación más el tiempo de viaje), así
     * no lo persigue de atrás ni le pasa por encima.
     */
    fun destinoDeTransito(o: ObjetivoDelRelevo, recibidoMs: Long, ahoraMs: Long, bLat: Double, bLon: Double): Pair<Double, Double> {
        val (eLat, eLon) = estimacion(o, recibidoMs, ahoraMs)
        val faltaM = (Geo.distanciaM(bLat, bLon, eLat, eLon) - DISTANCIA_TOMA_M).coerceAtLeast(0.0)
        val viajeMs = (faltaM / VELOCIDAD_DE_TRANSITO_MS * 1_000.0).toLong()
        val (lat, lon) = estimacion(o, recibidoMs, ahoraMs, viajeMs)
        return puntoDeToma(lat, lon, bLat, bLon)
    }

    /** B ya llegó a la distancia de toma del objetivo. */
    fun llegoALaToma(oLat: Double, oLon: Double, bLat: Double, bLon: Double): Boolean =
        Geo.distanciaM(oLat, oLon, bLat, bLon) <= DISTANCIA_TOMA_M + TOLERANCIA_TOMA_M

    /**
     * B puede bajar a la altura de seguimiento: A ya no sigue al objetivo
     * (`retirado`) o el último `relay_target` lo muestra a más de [A_LEJOS_M].
     */
    fun puedeBajar(r: RelevoAsignado): Boolean {
        if (r.aRetirado) return true
        val o = r.objetivo ?: return false
        val lat = r.aLat ?: return false
        val lon = r.aLon ?: return false
        return Geo.distanciaM(o.lat, o.lon, lat, lon) > A_LEJOS_M
    }

    /**
     * A qué altura baja B a seguir al objetivo: la que tenía A en la toma (es la
     * que le sirvió para seguirlo), o [ALTURA_DE_SEGUIMIENTO_POR_DEFECTO_M] si
     * no se sabe, entre [ALTURA_DE_SEGUIMIENTO_MINIMA_M] y la de tránsito.
     */
    fun alturaDeSeguimiento(alturaDeA: Double?, alturaDeTransito: Double): Double {
        val h = alturaDeA?.takeIf { it.isFinite() } ?: ALTURA_DE_SEGUIMIENTO_POR_DEFECTO_M
        return h.coerceIn(ALTURA_DE_SEGUIMIENTO_MINIMA_M, maxOf(ALTURA_DE_SEGUIMIENTO_MINIMA_M, alturaDeTransito))
    }

    /**
     * El rastreador de B sembrado con la estimación de A ([o], llegada en
     * [recibidoMs]), como si lo hubiera visto él: la posición se adelanta lo
     * que pasó desde que llegó, sin pasar el tope de extrapolación del
     * rastreador desde la última vista de A (lo que A ya extrapoló no se
     * vuelve a sumar).
     */
    fun sembrar(o: ObjetivoDelRelevo, recibidoMs: Long, ahoraMs: Long): RastreadorDeObjetivo {
        val desdeQueLlego = (ahoraMs - recibidoMs).coerceAtLeast(0L)
        val vistoHace = o.vistoHaceMs + desdeQueLlego
        val tope = RastreadorDeObjetivo.PREDICCION_MAXIMA_MS
        val extraMs = (minOf(vistoHace, tope) - minOf(o.vistoHaceMs, tope)).coerceAtLeast(0L)
        val s = if (o.enMovimiento) extraMs / 1_000.0 else 0.0
        return RastreadorDeObjetivo.heredado(
            clase = o.tipo,
            lat = o.lat + o.vNorteMs * s / Geo.METROS_POR_GRADO_LAT,
            lon = o.lon + o.vEsteMs * s / Geo.metrosPorGradoLon(o.lat),
            vNorteMs = o.vNorteMs,
            vEsteMs = o.vEsteMs,
            enMovimiento = o.enMovimiento,
            vistoHaceMs = vistoHace,
            ahoraMs = ahoraMs,
        )
    }
}
