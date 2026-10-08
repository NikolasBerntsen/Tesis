package com.tesis.dronepatrol.drone

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot

/**
 * La cuenta de los lazos de navegación: dado dónde está el dron y a dónde
 * tiene que ir, qué velocidades mandarle en esta vuelta. Es puro y vive en
 * `main` para que se pruebe sin dron: el controlador DJI lo llama diez veces
 * por segundo y el simulador lo usa para moverse igual que el dron real.
 */
object Navegacion {

    /** Velocidad de crucero de los modos autónomos (ruta, goto). */
    const val VELOCIDAD_CRUCERO_MS = 8.0

    /** Velocidad tangencial en órbita: más lento, para que la cámara siga al objetivo. */
    const val VELOCIDAD_ORBITA_MS = 5.0

    /**
     * Velocidad vertical máxima en los modos autónomos. El Mini 4 Pro sube hasta
     * 5 m/s, pero en una ruta de patrullaje nadie necesita eso y bajar rápido
     * cerca del suelo es lo que no se quiere.
     */
    const val VELOCIDAD_VERTICAL_MS = 2.5

    /** A esta distancia horizontal de un punto se lo da por alcanzado. */
    const val UMBRAL_LLEGADA_M = 4.0

    /** A esta diferencia de altura se la da por alcanzada. */
    const val UMBRAL_ALTURA_M = 1.5

    /**
     * Debajo de esto el dron frena en proporción a lo que falta, para no pasarse
     * del punto y volver: a 8 m/s con comandos cada 100 ms se mueve 0,8 m por
     * vuelta.
     */
    const val DISTANCIA_DE_FRENADO_M = 16.0

    /** Lo que hay que mandar en una vuelta del lazo para acercarse a un punto. */
    data class Paso(
        val vNorteMs: Double,
        val vEsteMs: Double,
        /** Rumbo del dron al objetivo, 0..360 (norte = 0, este = 90). */
        val rumboGrados: Double,
        val distanciaM: Double,
    ) {
        val llego: Boolean get() = distanciaM < UMBRAL_LLEGADA_M
    }

    /**
     * Velocidades para ir desde ([lat], [lon]) hasta ([tLat], [tLon]) a no más
     * de [vMaxMs]. Frena en proporción a la distancia dentro de
     * [DISTANCIA_DE_FRENADO_M], y si ya llegó manda cero: el que llama decide
     * qué hacer con `llego`, pero nunca recibe una velocidad que lo aleje.
     */
    fun hacia(lat: Double, lon: Double, tLat: Double, tLon: Double, vMaxMs: Double = VELOCIDAD_CRUCERO_MS): Paso {
        val dy = (tLat - lat) * Geo.METROS_POR_GRADO_LAT
        val dx = (tLon - lon) * Geo.metrosPorGradoLon(lat)
        val dist = hypot(dx, dy)
        val rumbo = (Math.toDegrees(atan2(dx, dy)) + 360.0) % 360.0
        if (dist < UMBRAL_LLEGADA_M) return Paso(0.0, 0.0, rumbo, dist)
        val velocidad = vMaxMs * (dist / DISTANCIA_DE_FRENADO_M).coerceIn(0.0, 1.0)
        return Paso(velocidad * dy / dist, velocidad * dx / dist, rumbo, dist)
    }

    /**
     * Velocidad vertical para ir de [altM] a [objetivoM]: proporcional a lo que
     * falta, con tope [vMaxMs] y cero dentro de [UMBRAL_ALTURA_M], así el dron no
     * se pasa la vida subiendo y bajando medio metro alrededor del objetivo.
     */
    fun vertical(altM: Double, objetivoM: Double, vMaxMs: Double = VELOCIDAD_VERTICAL_MS): Double {
        val falta = objetivoM - altM
        if (abs(falta) < UMBRAL_ALTURA_M) return 0.0
        // Frena en los últimos metros por lo mismo que en el plano: a 2,5 m/s el
        // dron recorre 25 cm por vuelta y el barómetro tiene su propio retraso.
        return (falta / 4.0).coerceIn(-vMaxMs, vMaxMs)
    }

    /** true cuando [altM] ya está a la altura [objetivoM], con la tolerancia del lazo. */
    fun aLaAltura(altM: Double, objetivoM: Double): Boolean = abs(objetivoM - altM) < UMBRAL_ALTURA_M
}
