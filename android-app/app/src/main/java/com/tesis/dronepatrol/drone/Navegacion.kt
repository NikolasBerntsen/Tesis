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

    /**
     * Velocidad tangencial en órbita por defecto: más lento que el crucero,
     * para que la cámara siga al objetivo y la captura no salga barrida. Se
     * puede cambiar desde la vista del dron en la consola (`ajustes`,
     * docs/PROTOCOLS.md §2), entre [VELOCIDAD_ORBITA_MINIMA_MS] y
     * [VELOCIDAD_ORBITA_MAXIMA_MS].
     */
    const val VELOCIDAD_ORBITA_MS = 4.0

    /** Menos que esto es casi quedarse quieto sobre el círculo; más que el crucero no tiene sentido. */
    const val VELOCIDAD_ORBITA_MINIMA_MS = 1.0
    const val VELOCIDAD_ORBITA_MAXIMA_MS = VELOCIDAD_CRUCERO_MS

    /** La velocidad de órbita que se puede pedir, recortada al rango; sin pedido (null o NaN), la de fábrica. */
    fun velocidadDeOrbita(pedidaMs: Double?): Double {
        val v = pedidaMs ?: return VELOCIDAD_ORBITA_MS
        if (!v.isFinite()) return VELOCIDAD_ORBITA_MS
        return v.coerceIn(VELOCIDAD_ORBITA_MINIMA_MS, VELOCIDAD_ORBITA_MAXIMA_MS)
    }

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
     * del punto y volver. Eran 16 m, y el Mini 4 Pro se pasaba igual: el dron
     * responde a la velocidad que se le manda con medio segundo o uno de
     * retraso, y a 8 m/s eso son hasta 8 m de más. Con 30 m la velocidad que
     * se le pide a 8 m del nodo ya es de 2 m/s, y el retraso se come un metro.
     */
    const val DISTANCIA_DE_FRENADO_M = 30.0

    /**
     * Frenando en proporción el dron nunca termina de llegar: a 5 m del nodo
     * se le piden 1,3 m/s, a 4,5 m algo menos, y con el viento en contra se
     * queda clavado justo afuera del umbral de llegada. Por debajo de esto no
     * se le pide: llega a paso de hombre y entra. Con el frenado de 30 m rige
     * solo en los últimos metros (a 5 m la proporción ya pide 1,3 m/s).
     */
    const val VELOCIDAD_MINIMA_DE_APROXIMACION_MS = 1.5

    /**
     * Con la distancia al nodo ya por debajo de esto, que empiece a CRECER es
     * que el dron pasó al lado del nodo sin entrar en el umbral de llegada (el
     * GPS y el retraso del dron lo corren un par de metros): el nodo se da por
     * alcanzado y se sigue al siguiente, en vez de dar la vuelta para pisar un
     * punto que ya quedó atrás (ver [LlegadaAlNodo]).
     */
    const val RADIO_DE_PASO_M = 12.0

    /**
     * Cuánto tiene que crecer la distancia por encima de la mínima que se vio
     * para contar como "pasó de largo": el GPS tiembla medio metro entre una
     * lectura y la siguiente, y un temblor no es haber pasado.
     */
    const val MARGEN_DE_PASO_M = 2.5

    /** Dos lecturas seguidas alejándose, no una sola: una lectura suelta del GPS puede saltar. */
    const val LECTURAS_DE_PASO = 2

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
        // Frena en proporción, pero nunca por debajo del paso de llegada (ni
        // por encima de lo que se pidió, si se pidió menos que ese paso).
        val frenada = vMaxMs * (dist / DISTANCIA_DE_FRENADO_M).coerceIn(0.0, 1.0)
        val velocidad = maxOf(frenada, minOf(VELOCIDAD_MINIMA_DE_APROXIMACION_MS, vMaxMs))
        return Paso(velocidad * dy / dist, velocidad * dx / dist, rumbo, dist)
    }

    /**
     * Decide, vuelta a vuelta del lazo, si el dron ya alcanzó el nodo hacia el
     * que vuela. Hay dos formas de llegar:
     *
     *  1. entrar en el umbral de llegada ([UMBRAL_LLEGADA_M]), la de siempre;
     *  2. pasar de largo: el dron ya estaba a menos de [RADIO_DE_PASO_M] del
     *     nodo y la distancia volvió a crecer [MARGEN_DE_PASO_M] o más durante
     *     [LECTURAS_DE_PASO] lecturas seguidas. Es lo que pasa en el campo con
     *     el retraso del dron y el error del GPS: el Mini pasa a 5 o 6 m del
     *     nodo sin pisar los 4, y antes el lazo lo hacía dar la vuelta y
     *     volver a por un punto que ya había dejado atrás.
     *
     * Es un objeto con memoria (la distancia mínima vista) y por eso vive
     * aparte de [hacia], que es puro: uno por nodo, y [reiniciar] al cambiar de
     * nodo. Lo usan la ruta y el salto a un punto del dron real; el simulado
     * avanza en pasos que nunca pasan el punto y no lo necesita.
     */
    class LlegadaAlNodo(
        private val umbralM: Double = UMBRAL_LLEGADA_M,
        private val radioDePasoM: Double = RADIO_DE_PASO_M,
        private val margenDePasoM: Double = MARGEN_DE_PASO_M,
        private val lecturasDePaso: Int = LECTURAS_DE_PASO,
    ) {
        private var minimaM = Double.POSITIVE_INFINITY
        private var alejandose = 0

        /** La distancia mínima al nodo que se vio desde el último [reiniciar]; infinita si ninguna. */
        val distanciaMinimaM: Double get() = minimaM

        /** Una lectura más de la distancia al nodo: true si el nodo se da por alcanzado. */
        fun llego(distanciaM: Double): Boolean {
            if (!distanciaM.isFinite()) return false
            if (distanciaM < umbralM) return true
            if (distanciaM < minimaM) {
                minimaM = distanciaM
                alejandose = 0
                return false
            }
            // Lejos del nodo alejarse no dice nada: es el viento, o el dron que
            // todavía está enfilando. Solo cuenta si ya estuvo cerca.
            if (minimaM >= radioDePasoM || distanciaM < minimaM + margenDePasoM) {
                alejandose = 0
                return false
            }
            alejandose++
            return alejandose >= lecturasDePaso
        }

        /** Otro nodo: la memoria arranca de cero. */
        fun reiniciar() {
            minimaM = Double.POSITIVE_INFINITY
            alejandose = 0
        }
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

    /** Ganancia de la corrección radial de la órbita (1/s): cuánto vuelve al círculo por metro de error. */
    const val GANANCIA_RADIAL_ORBITA = 0.5

    /** Más lejos que esto del círculo, primero se acerca derecho a él (a crucero). */
    const val APROXIMACION_ORBITA_M = 10.0

    /**
     * Velocidades para orbitar ([centroLat], [centroLon]) a [radioM], en sentido
     * horario visto desde arriba (norte → este → sur), desde ([lat], [lon]).
     *
     * Sobre el círculo: velocidad tangencial [vTangencialMs] más una corrección
     * radial proporcional a lo que se aleja del radio. Antes se perseguía un
     * punto que avanzaba sobre el círculo, y como [hacia] frena en proporción a
     * la distancia, el dron quedaba unos 16 m atrás de ese punto cortando por
     * adentro del círculo: más cerca del objetivo de lo pedido y con la cámara
     * mal apuntada. Lejos del círculo (más de [APROXIMACION_ORBITA_M]) va derecho
     * al punto del círculo más cercano a velocidad de crucero.
     *
     * El rumbo del [Paso] es hacia el CENTRO: en órbita la nariz —y la cámara—
     * apunta al objetivo, no hacia donde se mueve el dron. La distancia es la
     * distancia al centro.
     */
    fun orbitar(
        lat: Double,
        lon: Double,
        centroLat: Double,
        centroLon: Double,
        radioM: Double,
        vTangencialMs: Double = VELOCIDAD_ORBITA_MS,
    ): Paso {
        // Del centro al dron, en metros
        val dNorte = (lat - centroLat) * Geo.METROS_POR_GRADO_LAT
        val dEste = (lon - centroLon) * Geo.metrosPorGradoLon(centroLat)
        val dist = hypot(dNorte, dEste)
        val rumboAlCentro = (Math.toDegrees(atan2(-dEste, -dNorte)) + 360.0) % 360.0
        // Encima del centro no hay "afuera": se sale hacia el norte.
        val (uNorte, uEste) = if (dist > 0.5) dNorte / dist to dEste / dist else 1.0 to 0.0
        val error = radioM - dist // > 0: demasiado cerca, hay que salir
        if (abs(error) > APROXIMACION_ORBITA_M) {
            val v = VELOCIDAD_CRUCERO_MS * (abs(error) / DISTANCIA_DE_FRENADO_M).coerceIn(0.0, 1.0)
            val signo = if (error > 0) 1.0 else -1.0
            return Paso(signo * v * uNorte, signo * v * uEste, rumboAlCentro, dist)
        }
        // Tangente del giro horario: el radial rotado 90° (norte → este)
        val tNorte = -uEste
        val tEste = uNorte
        var vNorte = vTangencialMs * tNorte + GANANCIA_RADIAL_ORBITA * error * uNorte
        var vEste = vTangencialMs * tEste + GANANCIA_RADIAL_ORBITA * error * uEste
        val v = hypot(vNorte, vEste)
        if (v > VELOCIDAD_CRUCERO_MS) {
            vNorte *= VELOCIDAD_CRUCERO_MS / v
            vEste *= VELOCIDAD_CRUCERO_MS / v
        }
        return Paso(vNorte, vEste, rumboAlCentro, dist)
    }

    /** true cuando [altM] ya está a la altura [objetivoM], con la tolerancia del lazo. */
    fun aLaAltura(altM: Double, objetivoM: Double): Boolean = abs(objetivoM - altM) < UMBRAL_ALTURA_M
}
