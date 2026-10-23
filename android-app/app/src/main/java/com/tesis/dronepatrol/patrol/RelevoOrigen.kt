package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.MensajeDelHub
import com.tesis.dronepatrol.comms.Participante
import com.tesis.dronepatrol.drone.Geo
import kotlin.math.hypot

/** Dónde está A dentro de un relevo (`status.relevo.fase` con `rol: "origen"`, docs/PROTOCOLS.md §1). */
enum class FaseDelOrigen(val texto: String) {
    /** Mandó `relay_request`. */
    PEDIDO("pedido"),

    /** Estira el regreso a la espera de un relevo en camino (RELEVOS §3.5). */
    VENTANA("ventana"),

    /** Recibió `relay_done` y se aleja del objetivo. */
    SOLTANDO("soltando"),

    /** Mandó `landing_at_base`. */
    ATERRIZANDO("aterrizando"),

    /** Mandó `rth_diverted`. */
    DESVIADO("desviado"),
}

/**
 * Un pedido de relevo de A (`relay_request`, docs/PROTOCOLS.md §1.b): uno por
 * motivo. Se repite cada [REINTENTO_MS] con el MISMO [ref] hasta que llega un
 * `relay_status` con ese `ref`; desde ahí guarda lo último que dijo el hub.
 */
class PedidoDeRelevo(
    val ref: String,
    /** `patrulla` o `seguimiento`. */
    val motivo: String,
    val routeId: Int? = null,
    /** El nodo HACIA el que volaba A, no el último alcanzado. */
    val fromIndex: Int? = null,
    val alertId: Long? = null,
) {
    companion object {
        const val PATRULLA = "patrulla"
        const val SEGUIMIENTO = "seguimiento"
        const val REINTENTO_MS = 5_000L

        /** La ventana de gracia mira el último `relay_status` solo si es de hace menos que esto (reloj de la app). */
        const val STATUS_VIGENTE_MS = 10_000L
    }

    /** Lo que se mandó en el último envío; se recalcula en cada reintento. */
    var segundosDisponibles: Double? = null

    private var ultimoEnvioMs: Long? = null

    /** Ya llegó un `relay_status` con este `ref`: no se repite más. */
    var contestado = false
        private set

    var relayId: Long? = null
        private set
    var estado: String? = null
        private set
    var relevo: Participante? = null
        private set
    var etaS: Double? = null
        private set

    /** Hora del TELÉFONO a la que llegó el último `relay_status` (nunca un campo del mensaje). */
    var ultimoStatusMs: Long? = null
        private set

    var fase = FaseDelOrigen.PEDIDO

    /** `landing_at_base` ya salió (sale una sola vez). */
    var aterrizajeAvisado = false

    fun debeEnviar(ahoraMs: Long): Boolean {
        if (contestado) return false
        val ultimo = ultimoEnvioMs ?: return true
        // Un transcurrido negativo es el reloj acomodándose: se reenvía.
        return ahoraMs - ultimo !in 0 until REINTENTO_MS
    }

    fun enviado(ahoraMs: Long) {
        ultimoEnvioMs = ahoraMs
    }

    /** Volvió el Comando Central: si todavía no contestó, el próximo reintento sale ya. */
    fun reenviarYa() {
        ultimoEnvioMs = null
    }

    /** Un `relay_status` con este `ref`. */
    fun aplicar(s: MensajeDelHub.EstadoDelPedido, ahoraMs: Long) {
        contestado = true
        relayId = s.relayId
        estado = s.estado
        relevo = s.relevo
        etaS = s.etaS
        ultimoStatusMs = ahoraMs
    }

    /** Hay un B en camino según un `relay_status` todavía vigente. */
    fun relevoEnCamino(ahoraMs: Long): Boolean {
        val ultimo = ultimoStatusMs ?: return false
        return estado == "EN_CAMINO" && ahoraMs - ultimo in 0 until STATUS_VIGENTE_MS
    }
}

/**
 * La ventana de gracia de A (docs/RELEVOS.md §3.5): llegó a su umbral de
 * regreso siguiendo un objetivo y su relevo ya está en camino; puede quedarse
 * hasta [DURACION_MS] para no dejar al objetivo solo, pero solo con autonomía
 * informada, con un `relay_status` EN_CAMINO de hace menos de 10 s cuya `etaS`
 * entre en lo que le queda, y corta apenas la batería toca `piso + 3`.
 */
object VentanaDeGracia {

    /** VENTANA_RELEVO_MS. */
    const val DURACION_MS = 60_000L

    /**
     * Si A puede seguir sobre el objetivo en [ahoraMs]. [hastaMs] es el final
     * de la ventana ya abierta, o null si todavía no se abrió.
     */
    fun puedeSeguir(
        pedido: PedidoDeRelevo?,
        ahoraMs: Long,
        bateriaPct: Double,
        pctParaVolver: Double,
        consumoPctPorS: Double,
        hastaMs: Long?,
    ): Boolean {
        if (pedido == null || !Autonomia.informada(pctParaVolver)) return false
        if (hastaMs != null && ahoraMs >= hastaMs) return false
        if (!pedido.relevoEnCamino(ahoraMs)) return false
        if (bateriaPct <= Autonomia.corteDeLaVentana(pctParaVolver)) return false
        val quedan = Autonomia.segundosDisponibles(bateriaPct, pctParaVolver, consumoPctPorS) ?: return false
        val eta = pedido.etaS ?: return false
        return eta <= quedan
    }
}

/**
 * A después del `relay_done` (docs/RELEVOS.md §3.5): soltó el objetivo y se
 * aleja en horizontal, a su altura, hasta [Alejamiento.DISTANCIA_M] de él; recién
 * ahí arranca su regreso y manda `relay_released`.
 */
class Soltando(
    val relayId: Long,
    val objetivoLat: Double,
    val objetivoLon: Double,
    /** Cuándo empezó a alejarse (reloj de la app): alejarse tiene un tope. */
    val desdeMs: Long,
) {
    /** Ya no lo está soltando: se alejó, o se le venció el alejamiento y volvió igual. */
    var liberado = false

    /** Salió `relay_released`: se alejó de verdad. Solo así se vuelve a confirmar ante un `relay_done` repetido. */
    var alejado = false
}

/** La cuenta del alejamiento de A. */
object Alejamiento {

    /** A no está "lejos" del objetivo hasta esto: con menos, los dos drones estarían encima de él. */
    const val DISTANCIA_M = 100.0

    /** Adónde se manda, un poco más allá: así llegar al punto ya es estar a más de [DISTANCIA_M]. */
    const val DESTINO_M = 115.0

    /**
     * El punto a [DESTINO_M] del objetivo en dirección a casa; sin casa, en la
     * dirección en que ya está A (alejarse sin volver a pasar por encima).
     */
    fun punto(
        objetivoLat: Double,
        objetivoLon: Double,
        aLat: Double,
        aLon: Double,
        casaLat: Double,
        casaLon: Double,
    ): Pair<Double, Double> {
        val (haciaLat, haciaLon) = when {
            Geo.esPosicionValida(casaLat, casaLon) && Geo.distanciaM(objetivoLat, objetivoLon, casaLat, casaLon) > 1.0 ->
                casaLat to casaLon
            Geo.esPosicionValida(aLat, aLon) && Geo.distanciaM(objetivoLat, objetivoLon, aLat, aLon) > 1.0 -> aLat to aLon
            // Encima del objetivo y sin casa: hacia el sur, como Persecucion.
            else -> (objetivoLat - 1.0 / Geo.METROS_POR_GRADO_LAT) to objetivoLon
        }
        val norte = (haciaLat - objetivoLat) * Geo.METROS_POR_GRADO_LAT
        val este = (haciaLon - objetivoLon) * Geo.metrosPorGradoLon(objetivoLat)
        val d = hypot(norte, este)
        return (objetivoLat + norte / d * DESTINO_M / Geo.METROS_POR_GRADO_LAT) to
            (objetivoLon + este / d * DESTINO_M / Geo.metrosPorGradoLon(objetivoLat))
    }

    fun seAlejo(objetivoLat: Double, objetivoLon: Double, aLat: Double, aLon: Double): Boolean =
        Geo.esPosicionValida(aLat, aLon) && Geo.distanciaM(objetivoLat, objetivoLon, aLat, aLon) >= DISTANCIA_M
}
