package com.tesis.dronepatrol.drone

/**
 * Lo que el dron calcula que le cuesta volver a su punto de retorno y aterrizar
 * (docs/RELEVOS.md §0, `status.autonomia` en docs/PROTOCOLS.md §1): los cuatro
 * campos de autonomía de [com.tesis.dronepatrol.model.Telemetry], juntos.
 *
 * Cada valor es NaN si no se sabe, y sin autonomía informada no hay desvío a
 * otra base ni ventana de gracia: el piso vuelve a ser el umbral fijo de
 * batería y el respaldo es el regreso inteligente del propio DJI. Por eso la
 * regla es no inventar: un valor dudoso vale NaN, nunca un número.
 *
 * Los topes son los rangos del contrato. Un valor por encima se recorta en vez
 * de descartarse porque conserva lo que dice: un dron que necesita "más del
 * 100 %" para volver no vuelve, y con 100 la cuenta de la app llega a lo mismo.
 */
data class AutonomiaInformada(
    /** Batería (%) que necesita para volver a su punto de retorno. */
    val pctParaVolver: Double,
    /** Batería (%) que necesita para aterrizar donde está. */
    val pctParaAterrizar: Double,
    /** Radio en metros, medido desde el punto de retorno, que puede volar y todavía volver. */
    val alcanceM: Double,
    /** Segundos que tarda en volver a su punto de retorno. */
    val segundosParaVolver: Double,
) {
    companion object {
        /** Nada informado: los cuatro en NaN. */
        val DESCONOCIDA = AutonomiaInformada(Double.NaN, Double.NaN, Double.NaN, Double.NaN)

        /** Topes del contrato (PROTOCOLS §1, `autonomia`). */
        const val TOPE_PCT = 100.0
        const val TOPE_ALCANCE_M = 100_000.0
        const val TOPE_SEGUNDOS = 36_000.0

        /**
         * Más lejos que esto del punto de retorno, con el dron en el aire, un
         * cero del SDK no es un dato (RELEVOS §0): a cien metros de casa volver
         * cuesta algo, y un "0 %" ahí es el MSDK que todavía no calculó.
         */
        const val DISTANCIA_CERO_DUDOSO_M = 100.0

        /**
         * Lo que informa el DJI en `FlightControllerKey.KeyLowBatteryRTHInfo`
         * (`LowBatteryRTHInfo`: `batteryPercentNeededToGoHome`,
         * `batteryPercentNeededToLand`, `maxRadiusCanFlyAndGoHome`,
         * `timeNeededToGoHome`), pasado a la telemetría.
         *
         * Un valor null, negativo o no finito es NaN. Un CERO es NaN si el dron
         * está en el aire y a más de [DISTANCIA_CERO_DUDOSO_M] de casa —o no se
         * sabe a cuánto, que para no inventar es lo mismo—; en el suelo, o
         * encima de casa, un cero es lo que corresponde y queda.
         *
         * @param distanciaACasaM distancia horizontal al punto de retorno; NaN
         *   si falta la posición o el punto de retorno.
         */
        fun delDji(
            pctParaVolver: Int?,
            pctParaAterrizar: Int?,
            alcanceM: Double?,
            segundosParaVolver: Int?,
            enVuelo: Boolean,
            distanciaACasaM: Double,
        ): AutonomiaInformada {
            val lejosOSinSaber = distanciaACasaM.isNaN() || distanciaACasaM > DISTANCIA_CERO_DUDOSO_M
            val ceroDudoso = enVuelo && lejosOSinSaber
            fun leer(valor: Double?, tope: Double): Double = when {
                valor == null || !valor.isFinite() || valor < 0.0 -> Double.NaN
                valor == 0.0 && ceroDudoso -> Double.NaN
                else -> valor.coerceAtMost(tope)
            }
            return AutonomiaInformada(
                pctParaVolver = leer(pctParaVolver?.toDouble(), TOPE_PCT),
                pctParaAterrizar = leer(pctParaAterrizar?.toDouble(), TOPE_PCT),
                alcanceM = leer(alcanceM, TOPE_ALCANCE_M),
                segundosParaVolver = leer(segundosParaVolver?.toDouble(), TOPE_SEGUNDOS),
            )
        }
    }
}
