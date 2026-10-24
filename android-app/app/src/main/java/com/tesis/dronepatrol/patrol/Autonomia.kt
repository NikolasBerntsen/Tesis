package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.BaseDelHub
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.Telemetry

/**
 * Las cuentas de energía de docs/RELEVOS.md §1, §3.1, §4 y §5: cuándo volver,
 * cuándo pedir relevo, cuánto puede quedarse A sobre el objetivo y, sobre todo,
 * ADÓNDE volver ([decidirRegreso]).
 *
 * Todo es puro —la situación entra, la decisión sale— para poder probar los
 * bordes (el 10 s exacto de la confirmación, la base que está a 1999 m o a
 * 2001 m) sin dron y sin reloj.
 *
 * **Regla de oro: el regreso a tiempo manda**, y el dron vuelve SIEMPRE a su
 * propia base. Desviarse a otra es el caso extremo: solo cuando ya no hay forma
 * de que la batería alcance para la propia, confirmado durante
 * [CONFIRMAR_NO_LLEGA_MS], y nunca porque otra base esté más cerca o sea más
 * cómoda. Cada dron que aterriza en otra base deja la suya con un dron menos, y
 * una base sin drones no puede relevar ni patrullar.
 */
object Autonomia {

    /** El umbral fijo del regreso por batería: el piso cuando no hay autonomía informada. */
    const val LOW_BATTERY_PCT = PatrolManager.LOW_BATTERY_PCT

    /** Margen sobre lo que el propio DJI dice que le cuesta volver. */
    const val RESERVA_PCT = 5.0

    /**
     * Para decidir que NO llega se usa un margen más chico que la reserva: la
     * reserva se puede gastar en el regreso, y desviar con ella intacta sería
     * desviar de más (RELEVOS §4).
     */
    const val MARGEN_DESVIO_PCT = 2.0

    /** "piso + 3": donde corta la ventana de gracia y desde donde se cuentan los segundos disponibles. */
    const val MARGEN_SOBRE_EL_PISO_PCT = 3.0

    /** UMBRAL_RELEVO_PCT = max(35 %, piso + 10). */
    const val UMBRAL_RELEVO_MINIMO_PCT = 35.0
    const val UMBRAL_RELEVO_SOBRE_EL_PISO_PCT = 10.0

    /** El "no llega" tiene que sostenerse esto antes de desviar: una lectura suelta no alcanza. */
    const val CONFIRMAR_NO_LLEGA_MS = 10_000L

    /** Una base candidata tiene que estar a esto de la propia, donde está el control remoto. */
    const val RADIO_ENLACE_M = 2_000.0

    /** Estar en una base: a menos de esto de su punto (RELEVOS §0). */
    const val RADIO_DE_BASE_M = 50.0

    /** Sin punto de visitantes, el visitante baja a esto al norte del punto de la base. */
    const val DESPLAZAMIENTO_VISITANTE_M = 15.0

    /** Altura de un relevo hacia el objetivo y de un desvío (15..120). */
    const val ALTURA_TRANSITO_M = 60.0
    const val ALTURA_TRANSITO_MINIMA_M = 15.0
    const val ALTURA_TRANSITO_MAXIMA_M = 120.0

    /** Por debajo de esta distancia a casa la cifra del DJI no se escala (dividiría por casi nada). */
    const val DISTANCIA_MINIMA_PARA_ESCALAR_M = 200.0

    /** Con el consumo medido para escalar a otra base, nunca menos que esto. */
    const val CONSUMO_MINIMO_PCT_POR_KM = 8.0

    /** Consumo en el aire cuando todavía no se midió: el del modelo del simulador, 4 %/min. */
    const val CONSUMO_POR_DEFECTO_PCT_POR_S = 4.0 / 60.0

    /** Velocidad de subida para estimar lo que cuesta llegar a la altura de tránsito. */
    const val VELOCIDAD_DE_SUBIDA_MS = 3.0

    /** El disparo del §5 queda a esto por encima del crítico del propio DJI. */
    const val MARGEN_SOBRE_EL_CRITICO_PCT = 3.0

    /** Tope de `segundosDisponibles` en el contrato. */
    const val SEGUNDOS_DISPONIBLES_MAXIMOS = 3_600.0

    /** Con autonomía informada: el DJI dice lo que le cuesta volver. Sin ella no hay desvío ni ventana. */
    fun informada(pctParaVolver: Double): Boolean = pctParaVolver.isFinite() && pctParaVolver >= 0.0

    /**
     * El piso de energía: lo que cuesta volver más la reserva. Sin autonomía
     * informada, el umbral fijo.
     */
    fun piso(pctParaVolver: Double): Double =
        if (informada(pctParaVolver)) pctParaVolver + RESERVA_PCT else LOW_BATTERY_PCT

    /**
     * Con la batería en o por debajo de esto, el dron empieza a volver. Es el
     * disparo para EMPEZAR a volver, nunca por sí solo prueba de que no llega.
     */
    fun umbralDeRegreso(pctParaVolver: Double): Double = maxOf(LOW_BATTERY_PCT, piso(pctParaVolver))

    /** Siguiendo un objetivo, por debajo de esto se pide relevo (RELEVOS §1). */
    fun umbralDeRelevo(pctParaVolver: Double): Double =
        maxOf(UMBRAL_RELEVO_MINIMO_PCT, piso(pctParaVolver) + UMBRAL_RELEVO_SOBRE_EL_PISO_PCT)

    /** Donde corta la ventana de gracia de A (RELEVOS §3.5). */
    fun corteDeLaVentana(pctParaVolver: Double): Double = piso(pctParaVolver) + MARGEN_SOBRE_EL_PISO_PCT

    /**
     * Cuánto puede quedarse A sobre el objetivo: `(batería − (piso + 3)) /
     * consumo (%/s)`, en [0, 3600]. null sin autonomía informada (el contrato
     * lo manda así).
     */
    fun segundosDisponibles(bateriaPct: Double, pctParaVolver: Double, consumoPctPorS: Double): Double? {
        if (!informada(pctParaVolver) || !bateriaPct.isFinite()) return null
        val consumo = consumoPctPorS.takeIf { it.isFinite() && it > 0.0 } ?: CONSUMO_POR_DEFECTO_PCT_POR_S
        return ((bateriaPct - corteDeLaVentana(pctParaVolver)) / consumo).coerceIn(0.0, SEGUNDOS_DISPONIBLES_MAXIMOS)
    }

    /**
     * El disparo del protocolo de última ubicación (RELEVOS §5): `max(pctParaAterrizar
     * + RESERVA, umbralCritico + 3)`, con los términos que se sepan. NaN si no se
     * sabe ninguno: entonces la app no lo dispara y queda el aterrizaje forzado
     * del propio DJI.
     */
    fun disparoDeUltimaUbicacion(pctParaAterrizar: Double, umbralCriticoPct: Double): Double {
        val terminos = listOfNotNull(
            (pctParaAterrizar + RESERVA_PCT).takeIf { pctParaAterrizar.isFinite() && pctParaAterrizar >= 0.0 },
            (umbralCriticoPct + MARGEN_SOBRE_EL_CRITICO_PCT).takeIf { umbralCriticoPct.isFinite() && umbralCriticoPct >= 0.0 },
        )
        return terminos.maxOrNull() ?: Double.NaN
    }

    /** Dónde baja un visitante en [base]: su punto declarado, o 15 m al norte del de la base. */
    fun puntoDeVisitantes(base: BaseDelHub): Pair<Double, Double> {
        val lat = base.aterrizajeLat
        val lon = base.aterrizajeLon
        if (lat != null && lon != null) return lat to lon
        return (base.lat + DESPLAZAMIENTO_VISITANTE_M / Geo.METROS_POR_GRADO_LAT) to base.lon
    }

    /**
     * Fuera de base (RELEVOS §0): a más de [RADIO_DE_BASE_M] de toda base y del
     * punto de retorno propio. Sin posición no se sabe, y la respuesta es no:
     * la app no dispara el §5 a ciegas (el DJI tiene el suyo).
     */
    fun fueraDeBase(
        lat: Double,
        lon: Double,
        bases: List<BaseDelHub>,
        casaLat: Double,
        casaLon: Double,
    ): Boolean {
        if (!Geo.esPosicionValida(lat, lon)) return false
        if (Geo.esPosicionValida(casaLat, casaLon) && Geo.distanciaM(lat, lon, casaLat, casaLon) <= RADIO_DE_BASE_M) {
            return false
        }
        return bases.none { Geo.distanciaM(lat, lon, it.lat, it.lon) <= RADIO_DE_BASE_M }
    }

    /** En [base]: a menos de [RADIO_DE_BASE_M] de su punto. Sin posición, no. */
    fun enLaBase(lat: Double, lon: Double, base: BaseDelHub?): Boolean =
        base != null && Geo.esPosicionValida(lat, lon) && Geo.distanciaM(lat, lon, base.lat, base.lon) < RADIO_DE_BASE_M

    /** Lo que se sabe en el momento de decidir adónde volver. */
    data class Situacion(
        val ahoraMs: Long,
        val bateriaPct: Double,
        val lat: Double,
        val lon: Double,
        val altM: Double,
        val pctParaVolver: Double,
        val pctParaAterrizar: Double,
        val alcanceM: Double,
        val umbralCriticoPct: Double,
        /** El punto de retorno del DJI (`KeyHomeLocation`); NaN si no se sabe. */
        val casaLat: Double,
        val casaLon: Double,
        /** Las bases del último `bases`. */
        val bases: List<BaseDelHub>,
        val propiaId: Long?,
        /** Consumo medido (%/km); NaN si todavía no se midió. */
        val consumoPctPorKm: Double = Double.NaN,
        /** Consumo medido (%/s); NaN si todavía no se midió. */
        val consumoPctPorS: Double = Double.NaN,
    ) {
        companion object {
            fun desde(
                ahoraMs: Long,
                t: Telemetry,
                umbralCriticoPct: Double,
                casaLat: Double,
                casaLon: Double,
                bases: List<BaseDelHub>,
                propiaId: Long?,
                consumoPctPorKm: Double,
                consumoPctPorS: Double,
            ) = Situacion(
                ahoraMs, t.batteryPct, t.lat, t.lon, t.altM, t.pctParaVolver, t.pctParaAterrizar, t.alcanceM,
                umbralCriticoPct, casaLat, casaLon, bases, propiaId, consumoPctPorKm, consumoPctPorS,
            )
        }
    }

    /**
     * Lo que la decisión recuerda de una vez a la siguiente. Es la parte que no
     * puede ser pura —la confirmación sostenida y el compromiso de una sola
     * vía—, así que entra y sale como dato: quien llama la guarda y la vuelve a
     * pasar.
     */
    data class Memoria(
        /** Desde cuándo se sostiene "no llega a su base"; null si no se sostiene. */
        val noLlegaDesdeMs: Long? = null,
        /**
         * La base del desvío, una vez comprometida: no se vuelve a evaluar la
         * propia, y se mantiene aunque salga de la lista de bases.
         */
        val comprometida: BaseDelHub? = null,
        /** Desde cuándo la comprometida dejó de ser alcanzable; null si lo es. */
        val inalcanzableDesdeMs: Long? = null,
    )

    sealed interface Destino {
        /** Sigue el regreso a su base: el del propio DJI. */
        object BasePropia : Destino

        /**
         * Se desvía a [base]. [alcanzable] false es el "no llega a ninguna" con
         * la más cercana siendo otra: vuela hacia ella mientras pueda y el §5 lo
         * baja cuando corresponda.
         */
        data class OtraBase(val base: BaseDelHub, val alcanzable: Boolean) : Destino

        /** Protocolo de última ubicación (RELEVOS §5). */
        object UltimaUbicacion : Destino
    }

    data class Decision(val destino: Destino, val memoria: Memoria)

    /**
     * ADÓNDE vuelve el dron, con las reglas de RELEVOS §4 y §5, en este orden:
     *
     * 1. Fuera de base y con la batería en el disparo del §5: última ubicación.
     * 2. Ya desviado: la decisión es de una sola vía. La base comprometida no
     *    cambia salvo que deje de ser alcanzable durante
     *    [CONFIRMAR_NO_LLEGA_MS], y entonces cambia a otra alcanzable si la hay
     *    (nunca de vuelta a la propia).
     * 3. Sin autonomía informada: la propia, siempre (y el DJI de respaldo).
     * 4. La propia, mientras no se sostenga [CONFIRMAR_NO_LLEGA_MS] que no
     *    llega: `batería < pctParaVolver + 2` o la distancia a casa más allá de
     *    `alcanceM`.
     * 5. No llega: la candidata más cercana ([esCandidata]).
     * 6. No llega a ninguna: si la más cercana es otra, hacia ella; si es la
     *    propia, sigue el regreso del DJI. En los dos casos el §5 lo corta
     *    cuando corresponde.
     */
    fun decidirRegreso(s: Situacion, memoria: Memoria): Decision {
        val bases = (s.bases + listOfNotNull(memoria.comprometida)).distinctBy { it.id }
        val disparo = disparoDeUltimaUbicacion(s.pctParaAterrizar, s.umbralCriticoPct)
        if (disparo.isFinite() && s.bateriaPct <= disparo && fueraDeBase(s.lat, s.lon, bases, s.casaLat, s.casaLon)) {
            return Decision(Destino.UltimaUbicacion, memoria)
        }
        val comprometida = memoria.comprometida
        if (comprometida != null) return seguirDesviado(s, memoria, comprometida)
        val dCasa = distanciaACasa(s)
        if (!informada(s.pctParaVolver) || !Geo.esPosicionValida(s.lat, s.lon) || dCasa == null) {
            return Decision(Destino.BasePropia, Memoria())
        }
        val noLlega = s.bateriaPct < s.pctParaVolver + MARGEN_DESVIO_PCT || (s.alcanceM.isFinite() && dCasa > s.alcanceM)
        if (!noLlega) return Decision(Destino.BasePropia, Memoria())
        val desde = memoria.noLlegaDesdeMs ?: s.ahoraMs
        val sostenido = s.ahoraMs - desde >= CONFIRMAR_NO_LLEGA_MS
        if (!sostenido) return Decision(Destino.BasePropia, Memoria(noLlegaDesdeMs = desde))
        candidatas(s, dCasa).minByOrNull { it.second }?.let { (base, _) ->
            return Decision(Destino.OtraBase(base, alcanzable = true), Memoria(noLlegaDesdeMs = desde, comprometida = base))
        }
        // No llega a ninguna: baja lo más cerca posible de una zona controlada.
        val otraMasCercana = otrasBases(s)
            .filter { dentroDelEnlace(s, it) }
            .map { it to distanciaAlPunto(s, it) }
            .filter { it.second < dCasa }
            .minByOrNull { it.second }
            ?.first
        if (otraMasCercana != null) {
            return Decision(
                Destino.OtraBase(otraMasCercana, alcanzable = false),
                Memoria(noLlegaDesdeMs = desde, comprometida = otraMasCercana),
            )
        }
        return Decision(Destino.BasePropia, Memoria(noLlegaDesdeMs = desde))
    }

    private fun seguirDesviado(s: Situacion, memoria: Memoria, comprometida: BaseDelHub): Decision {
        if (alcanzable(s, comprometida)) {
            return Decision(Destino.OtraBase(comprometida, alcanzable = true), memoria.copy(inalcanzableDesdeMs = null))
        }
        val desde = memoria.inalcanzableDesdeMs ?: s.ahoraMs
        if (s.ahoraMs - desde >= CONFIRMAR_NO_LLEGA_MS) {
            val otra = otrasBases(s)
                .filter { it.id != comprometida.id && dentroDelEnlace(s, it) && alcanzable(s, it) }
                .minByOrNull { distanciaAlPunto(s, it) }
            if (otra != null) {
                return Decision(Destino.OtraBase(otra, alcanzable = true), memoria.copy(comprometida = otra, inalcanzableDesdeMs = null))
            }
        }
        return Decision(Destino.OtraBase(comprometida, alcanzable = false), memoria.copy(inalcanzableDesdeMs = desde))
    }

    /**
     * Una base candidata para desviarse (RELEVOS §4): no es la propia, está
     * más cerca que casa, a [RADIO_ENLACE_M] de la propia, y lo que cuesta
     * llegar más la reserva entra en la batería. Devuelve las candidatas con su
     * distancia.
     */
    private fun candidatas(s: Situacion, dCasa: Double): List<Pair<BaseDelHub, Double>> =
        otrasBases(s)
            .map { it to distanciaAlPunto(s, it) }
            .filter { (base, dOtra) -> dOtra < dCasa && dentroDelEnlace(s, base) && alcanzable(s, base) }

    /** `pctOtra + RESERVA < batería`. */
    private fun alcanzable(s: Situacion, base: BaseDelHub): Boolean {
        val costo = costoDeOtraBase(s, base) ?: return false
        return costo + RESERVA_PCT < s.bateriaPct
    }

    /**
     * Lo que cuesta llegar a [base] y bajar ahí: se escala la cifra del propio
     * DJI por la distancia (`pctParaVolver × dOtra / dCasa`, solo con `dCasa ≥
     * 200 m`; si no, con el consumo medido, nunca menos de 8 %/km), más la
     * subida a la altura de tránsito y lo que cuesta aterrizar. null si no se
     * puede estimar.
     */
    internal fun costoDeOtraBase(s: Situacion, base: BaseDelHub): Double? {
        if (!informada(s.pctParaVolver)) return null
        val dCasa = distanciaACasa(s) ?: return null
        val dOtra = distanciaAlPunto(s, base)
        val viaje = if (dCasa >= DISTANCIA_MINIMA_PARA_ESCALAR_M) {
            s.pctParaVolver * dOtra / dCasa
        } else {
            val porKm = s.consumoPctPorKm.takeIf { it.isFinite() } ?: CONSUMO_MINIMO_PCT_POR_KM
            maxOf(porKm, CONSUMO_MINIMO_PCT_POR_KM) * dOtra / 1_000.0
        }
        val porSegundo = s.consumoPctPorS.takeIf { it.isFinite() && it > 0.0 } ?: CONSUMO_POR_DEFECTO_PCT_POR_S
        val altura = if (s.altM.isFinite()) s.altM else 0.0
        val subida = (ALTURA_TRANSITO_M - altura).coerceAtLeast(0.0) / VELOCIDAD_DE_SUBIDA_MS * porSegundo
        val aterrizaje = s.pctParaAterrizar.takeIf { it.isFinite() && it >= 0.0 } ?: 0.0
        return viaje + subida + aterrizaje
    }

    private fun otrasBases(s: Situacion): List<BaseDelHub> = s.bases.filter { it.id != s.propiaId }

    /** La base propia según la lista; si no está, el punto de retorno hace de base propia. */
    private fun puntoDeLaPropia(s: Situacion): Pair<Double, Double>? {
        s.bases.firstOrNull { it.id == s.propiaId }?.let { return it.lat to it.lon }
        return (s.casaLat to s.casaLon).takeIf { Geo.esPosicionValida(s.casaLat, s.casaLon) }
    }

    /** Casa es el punto de retorno del DJI; si no se sabe, la base propia. */
    private fun distanciaACasa(s: Situacion): Double? {
        if (!Geo.esPosicionValida(s.lat, s.lon)) return null
        val (lat, lon) = (s.casaLat to s.casaLon).takeIf { Geo.esPosicionValida(s.casaLat, s.casaLon) }
            ?: s.bases.firstOrNull { it.id == s.propiaId }?.let { it.lat to it.lon }
            ?: return null
        return Geo.distanciaM(s.lat, s.lon, lat, lon)
    }

    private fun distanciaAlPunto(s: Situacion, base: BaseDelHub): Double {
        val (lat, lon) = puntoDeVisitantes(base)
        return Geo.distanciaM(s.lat, s.lon, lat, lon)
    }

    /** A [RADIO_ENLACE_M] de la base propia, donde está el control remoto. */
    private fun dentroDelEnlace(s: Situacion, base: BaseDelHub): Boolean {
        val (lat, lon) = puntoDeLaPropia(s) ?: return false
        return Geo.distanciaM(lat, lon, base.lat, base.lon) <= RADIO_ENLACE_M
    }
}

/**
 * El consumo de batería medido en el vuelo en curso, en %/km y en %/s: lo usan
 * los segundos que A puede quedarse sobre el objetivo y el costo de llegar a
 * otra base cerca de casa (RELEVOS §3.1 y §4). Arranca de cero en cada
 * despegue; mientras no hay datos suficientes las dos cifras son NaN y quien
 * las usa toma los valores por defecto de [Autonomia].
 */
class ConsumoMedido {

    companion object {
        /** Menos recorrido que esto no da un %/km creíble (la batería se lee de a un punto). */
        const val RECORRIDO_MINIMO_M = 300.0

        /** Menos tiempo que esto no da un %/s creíble. */
        const val TIEMPO_MINIMO_MS = 30_000L
    }

    private var bateriaInicial = Double.NaN
    private var desdeMs = 0L
    private var recorridoM = 0.0
    private var ultimaLat = Double.NaN
    private var ultimaLon = Double.NaN
    private var ultimaBateria = Double.NaN
    private var ultimoMs = 0L

    @Synchronized
    fun registrar(t: Telemetry, enVuelo: Boolean) {
        // Una batería que SUBE es otra batería: la medición vieja ya no sirve.
        if (!enVuelo || !t.batteryPct.isFinite() || (ultimaBateria.isFinite() && t.batteryPct > ultimaBateria + 1.0)) {
            reiniciar()
            if (!enVuelo || !t.batteryPct.isFinite()) return
        }
        if (bateriaInicial.isNaN()) {
            bateriaInicial = t.batteryPct
            desdeMs = t.ts
        }
        if (Geo.esPosicionValida(t.lat, t.lon) && Geo.esPosicionValida(ultimaLat, ultimaLon)) {
            recorridoM += Geo.distanciaM(ultimaLat, ultimaLon, t.lat, t.lon)
        }
        if (Geo.esPosicionValida(t.lat, t.lon)) {
            ultimaLat = t.lat
            ultimaLon = t.lon
        }
        ultimaBateria = t.batteryPct
        ultimoMs = t.ts
    }

    /** %/km gastados en lo que va del vuelo; NaN sin recorrido suficiente. */
    val pctPorKm: Double
        @Synchronized get() {
            val gastado = bateriaInicial - ultimaBateria
            if (!gastado.isFinite() || gastado <= 0.0 || recorridoM < RECORRIDO_MINIMO_M) return Double.NaN
            return gastado / (recorridoM / 1_000.0)
        }

    /** %/s gastados en lo que va del vuelo; NaN sin tiempo suficiente. */
    val pctPorS: Double
        @Synchronized get() {
            val gastado = bateriaInicial - ultimaBateria
            val transcurridoMs = ultimoMs - desdeMs
            if (!gastado.isFinite() || gastado <= 0.0 || transcurridoMs < TIEMPO_MINIMO_MS) return Double.NaN
            return gastado / (transcurridoMs / 1_000.0)
        }

    private fun reiniciar() {
        bateriaInicial = Double.NaN
        desdeMs = 0L
        recorridoM = 0.0
        ultimaLat = Double.NaN
        ultimaLon = Double.NaN
        ultimaBateria = Double.NaN
        ultimoMs = 0L
    }
}
