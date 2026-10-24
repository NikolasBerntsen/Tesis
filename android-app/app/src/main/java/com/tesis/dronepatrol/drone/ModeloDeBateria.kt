package com.tesis.dronepatrol.drone

/**
 * Cuánto gasta el dron simulado y, de ahí, su autonomía (docs/RELEVOS.md §0):
 * lo que el DJI real calcula por su cuenta y entrega en `KeyLowBatteryRTHInfo`,
 * el simulador lo saca de acá.
 *
 * El modelo es a propósito simple —un consumo fijo por minuto en el aire,
 * horizontal o vertical da igual— porque lo que se prueba con el simulador son
 * las decisiones de la app (cuándo pedir relevo, cuándo desviarse, cuándo
 * aterrizar donde está), no la física de la batería. Por defecto: 4 % por minuto
 * a la velocidad de crucero de 8 m/s, que da unos 8,3 % por kilómetro (el
 * `CONSUMO_PCT_POR_KM` del diseño, cuyo mínimo es 8). Las pruebas lo cambian
 * para llegar a los umbrales sin volar media hora.
 */
data class ModeloDeBateria(
    /** Lo que gasta por minuto en el aire, en puntos de batería. */
    val consumoPctPorMinuto: Double = 4.0,
    /** Velocidad horizontal de crucero, la misma que [Navegacion] le da al dron real. */
    val velocidadCruceroMs: Double = Navegacion.VELOCIDAD_CRUCERO_MS,
    /** Velocidad de descenso del aterrizaje y del final del regreso a base. */
    val velocidadDescensoMs: Double = 5.0,
    /** Altura a la que vuelve a casa (la de crucero del simulador): desde ahí baja al llegar. */
    val alturaDeRegresoM: Double = 40.0,
    /**
     * Umbral de batería crítica del propio dron (`KeySeriousLowBatteryWarningThreshold`
     * en el real): ahí aterriza donde esté, sin preguntarle a nadie. El Mini 4
     * Pro viene de fábrica con 10 %.
     */
    val umbralCriticoPct: Double = 10.0,
) {
    init {
        require(consumoPctPorMinuto > 0.0 && velocidadCruceroMs > 0.0 && velocidadDescensoMs > 0.0) {
            "el modelo de batería necesita consumo y velocidades positivos"
        }
    }

    /** Puntos de batería por segundo de vuelo. */
    val consumoPctPorSegundo: Double get() = consumoPctPorMinuto / 60.0

    /** Puntos de batería por kilómetro horizontal a velocidad de crucero. */
    val consumoPctPorKm: Double get() = consumoPctPorSegundo / velocidadCruceroMs * 1_000.0

    /** Lo que gasta en [segundos] de vuelo. */
    fun gastoPct(segundos: Double): Double = segundos * consumoPctPorSegundo

    /**
     * La autonomía con la batería en [bateriaPct], a [distanciaACasaM] del punto
     * de retorno y a [altM] de altura:
     *
     *  - para aterrizar donde está: el descenso desde [altM];
     *  - para volver: el tramo horizontal a crucero más el descenso desde la
     *    altura de regreso (si ya está encima de casa, desde donde está);
     *  - el alcance: con lo que queda después de guardar el descenso, cuánto
     *    puede alejarse de casa y volver. Desde una distancia d con m metros de
     *    vuelo disponibles llega hasta (m + d) / 2: ida hasta ese radio y
     *    vuelta desde él. Así, alcance < d es exactamente "ya no le alcanza
     *    para volver", que es como lo lee el desvío (RELEVOS §4).
     *
     * Sin datos con sentido (NaN, infinitos) no se inventa: [AutonomiaInformada.DESCONOCIDA].
     */
    fun estimar(bateriaPct: Double, distanciaACasaM: Double, altM: Double): AutonomiaInformada {
        if (!bateriaPct.isFinite() || !distanciaACasaM.isFinite() || !altM.isFinite()) {
            return AutonomiaInformada.DESCONOCIDA
        }
        val altura = altM.coerceAtLeast(0.0)
        val distancia = distanciaACasaM.coerceAtLeast(0.0)
        val alturaAlLlegar = if (distancia < ENCIMA_DE_CASA_M) altura else alturaDeRegresoM
        val segundosParaAterrizar = altura / velocidadDescensoMs
        val segundosParaVolver = distancia / velocidadCruceroMs + alturaAlLlegar / velocidadDescensoMs
        val pctParaAterrizar = gastoPct(segundosParaAterrizar)
        val metrosDisponibles = (bateriaPct - pctParaAterrizar).coerceAtLeast(0.0) / consumoPctPorKm * 1_000.0
        return AutonomiaInformada(
            pctParaVolver = gastoPct(segundosParaVolver).coerceIn(0.0, AutonomiaInformada.TOPE_PCT),
            pctParaAterrizar = pctParaAterrizar.coerceIn(0.0, AutonomiaInformada.TOPE_PCT),
            alcanceM = ((metrosDisponibles + distancia) / 2.0).coerceIn(0.0, AutonomiaInformada.TOPE_ALCANCE_M),
            segundosParaVolver = segundosParaVolver.coerceIn(0.0, AutonomiaInformada.TOPE_SEGUNDOS),
        )
    }

    /**
     * Si el regreso inteligente por batería del propio DJI arrancaría ahora: el
     * DJI vuelve cuando la batería ya solo alcanza para el regreso más su
     * reserva crítica, que es la que guarda para aterrizar en casa.
     */
    fun pideRegresoPropio(bateriaPct: Double, autonomia: AutonomiaInformada): Boolean =
        !autonomia.pctParaVolver.isNaN() && bateriaPct <= autonomia.pctParaVolver + umbralCriticoPct

    /** Si el propio DJI forzaría ahora el aterrizaje donde está: batería en su umbral crítico. */
    fun fuerzaAterrizaje(bateriaPct: Double): Boolean = bateriaPct <= umbralCriticoPct

    private companion object {
        /** A menos de esto de casa ya está encima: no hay tramo horizontal ni subida a la altura de regreso. */
        const val ENCIMA_DE_CASA_M = 6.0
    }
}
