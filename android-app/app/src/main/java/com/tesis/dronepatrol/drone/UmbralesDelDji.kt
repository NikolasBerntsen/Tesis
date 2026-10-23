package com.tesis.dronepatrol.drone

import kotlin.math.roundToInt

/**
 * Los dos umbrales de batería que el propio DJI trae configurados (en DJI Fly)
 * y que la app no toca: el de aviso (`KeyLowBatteryWarningThreshold`) y el
 * crítico (`KeySeriousLowBatteryWarningThreshold`). Al conectar se revisan
 * (docs/RELEVOS.md §0) porque cualquiera de los dos mal puesto le gana a la
 * lógica de la app:
 *
 *  - con el crítico en 20 % o más, el dron aterriza solo donde esté antes de
 *    que el protocolo de última ubicación llegue a sacar las fotos;
 *  - con el aviso por encima del umbral de regreso de la app, el regreso
 *    inteligente del DJI se adelanta al de la app, que es el que sabe de
 *    relevos y de bases alternativas.
 */
object UmbralesDelDji {

    /** Un crítico desde acá aterriza al dron demasiado pronto. */
    const val CRITICO_MAXIMO_PCT = 20.0

    /**
     * El problema, redactado para el operador, o null si los dos están bien (o
     * no se saben: NaN no es un problema que se pueda señalar).
     *
     * @param regresoDeLaAppPct el umbral con el que la app ordena el regreso por
     *   batería (`PatrolManager.LOW_BATTERY_PCT`).
     */
    fun problema(criticoPct: Double, avisoPct: Double, regresoDeLaAppPct: Double): String? {
        val critico = if (criticoPct >= CRITICO_MAXIMO_PCT) {
            "la batería crítica está en ${criticoPct.roundToInt()} % (a partir de ahí aterriza solo donde esté, " +
                "y tiene que ser menos de ${CRITICO_MAXIMO_PCT.roundToInt()} %)"
        } else {
            null
        }
        val aviso = if (avisoPct > regresoDeLaAppPct) {
            "el aviso de batería baja está en ${avisoPct.roundToInt()} % (su regreso propio se adelantaría al de " +
                "la app, que vuelve al ${regresoDeLaAppPct.roundToInt()} %)"
        } else {
            null
        }
        val problemas = listOfNotNull(critico, aviso)
        if (problemas.isEmpty()) return null
        return "umbrales de batería del dron mal configurados en DJI Fly: ${problemas.joinToString("; ")}"
    }
}
