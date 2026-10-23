package com.tesis.dronepatrol.drone

import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/**
 * Seguimiento de UN objetivo en el terreno (la persona o el vehículo que
 * disparó la alerta) a partir de las detecciones, que llegan a 2 Hz como mucho
 * y ya georreferenciadas ([Georreferencia.proyectar]).
 *
 * Cada medición es ruidosa —la proyección depende de la altura barométrica, del
 * rumbo de la brújula y de la inclinación del gimbal, y todo eso se mide con
 * retraso respecto del cuadro—, así que no se le cree a ninguna sola: un filtro
 * alfa-beta suaviza la posición y estima la velocidad. Es el filtro de Kalman de
 * velocidad constante con las ganancias fijas, que para un blanco que camina o
 * maneja y mediciones cada medio segundo hace lo mismo con dos números en vez de
 * matrices.
 *
 * Lo que decide el comportamiento del dron sale de acá:
 *  - [enMovimiento], con histéresis: el dron deja de orbitar y pasa a seguir al
 *    objetivo cuando ESTE se va, y vuelve a orbitarlo cuando se detiene. Sin la
 *    histéresis, un peatón que se para cada tanto haría saltar al dron entre los
 *    dos modos.
 *  - [perdido]: hace [SIN_VER_PARA_PERDIDO_MS] que ninguna detección se asoció.
 *  - [indiceMasCercano]: qué detección nueva es ESTE objetivo y no otro que
 *    entró al cuadro (la más cercana a la posición predicha, dentro de una
 *    puerta que crece con la velocidad y con el tiempo sin verlo).
 *
 * Trabaja en metros sobre un plano local con origen en la primera detección: a
 * la escala de un seguimiento (cientos de metros) la curvatura no se nota, y el
 * filtro en metros no tiene la distorsión de mezclar grados de latitud y de
 * longitud.
 *
 * No tiene reloj propio: todo recibe `ahoraMs`, para poder probar los bordes sin
 * dormir el test.
 */
class RastreadorDeObjetivo(
    /** `PERSON` o `VEHICLE`: solo una detección de la misma clase puede ser este objetivo. */
    val clase: String,
    lat: Double,
    lon: Double,
    ahoraMs: Long,
) {
    companion object {
        /** Cuánto se le cree a la medición nueva frente a la predicción (0..1). */
        const val ALFA = 0.5

        /** Cuánto corrige la velocidad cada residuo; chico porque la posición medida es ruidosa. */
        const val BETA = 0.15

        /** Puerta de asociación con el objetivo recién visto: el ruido de la proyección más un paso. */
        const val PUERTA_BASE_M = 15.0

        /** Tope de la puerta: más lejos ya es otra cosa que entró al cuadro. */
        const val PUERTA_MAXIMA_M = 45.0

        /** Para reenganchar un objetivo perdido se busca más amplio: pudo moverse mientras no se lo veía. */
        const val PUERTA_DE_REENGANCHE_M = 70.0

        /** Por encima de esta velocidad, sostenida, el objetivo se está yendo. Un peatón camina a ~1,4 m/s. */
        const val VELOCIDAD_DE_MOVIMIENTO_MS = 1.2

        /** Cuántas actualizaciones seguidas por encima de [VELOCIDAD_DE_MOVIMIENTO_MS] hacen falta (ruido). */
        const val ACTUALIZACIONES_PARA_MOVIMIENTO = 3

        /**
         * Alejarse esto del punto donde se lo vio quieto también es moverse,
         * aunque sea despacio: un peatón lento termina saliendo de la órbita.
         */
        const val DESPLAZAMIENTO_DE_MOVIMIENTO_M = 15.0

        /** Por debajo de esta velocidad, sostenida [QUIETUD_PARA_DETENIDO_MS], se considera detenido. */
        const val VELOCIDAD_DE_QUIETUD_MS = 0.6
        const val QUIETUD_PARA_DETENIDO_MS = 6_000L

        /** Sin una detección asociada durante esto, el objetivo se da por perdido de vista. */
        const val SIN_VER_PARA_PERDIDO_MS = 10_000L

        /** Hasta cuánto se extrapola la posición con la velocidad estimada sin verlo. */
        const val PREDICCION_MAXIMA_MS = 4_000L

        /** 144 km/h: una velocidad mayor es ruido de la proyección, no un vehículo. */
        const val VELOCIDAD_MAXIMA_CREIBLE_MS = 40.0

        /**
         * Un rastreador que arranca con la estimación de OTRO dron: el de B en el
         * traspaso de un relevo de seguimiento (docs/RELEVOS.md §3.5), sembrado
         * con el `objetivo` que A le pasó por el hub (docs/PROTOCOLS.md §2.b). B
         * todavía no vio al objetivo con su cámara, pero no puede arrancar de
         * cero: necesita la velocidad que A ya estimó para no perderlo en los
         * primeros segundos, y la puerta de asociación tiene que reflejar cuánto
         * hace que nadie lo ve.
         *
         * [lat]/[lon] son la estimación de A tal como sale en `status.target`: la
         * posición filtrada, ya extrapolada con su velocidad desde la última
         * vez que la vio, hasta [PREDICCION_MAXIMA_MS]. [vistoHaceMs] es hace
         * cuánto la vio (`lastSeenMs`; uno negativo cuenta como cero). El estado
         * se reconstruye como si a B le hubiera llegado esa vista en
         * `ahoraMs − vistoHaceMs`, en el punto que, extrapolado, da [lat]/[lon].
         * Así [estimar] en [ahoraMs] devuelve exactamente lo heredado, la
         * extrapolación total desde la última vista sigue sin pasar de
         * [PREDICCION_MAXIMA_MS] (no se extrapola dos veces lo que A ya
         * extrapoló), y "perdido" y la puerta corren desde la última vista de A,
         * no desde el traspaso.
         *
         * Una velocidad que no es un número finito se toma como cero, y una
         * increíble se recorta a [VELOCIDAD_MAXIMA_CREIBLE_MS], como las
         * propias. [lat]/[lon] tienen que ser una posición válida: el contrato
         * solo deja pasar objetivos que lo son. Arranca con cero [detecciones]:
         * ninguna es de B.
         */
        fun heredado(
            clase: String,
            lat: Double,
            lon: Double,
            vNorteMs: Double,
            vEsteMs: Double,
            enMovimiento: Boolean,
            vistoHaceMs: Long,
            ahoraMs: Long,
        ): RastreadorDeObjetivo {
            val vistoHace = vistoHaceMs.coerceAtLeast(0L)
            val r = RastreadorDeObjetivo(clase, lat, lon, ahoraMs - vistoHace)
            var vNorte = if (vNorteMs.isFinite()) vNorteMs else 0.0
            var vEste = if (vEsteMs.isFinite()) vEsteMs else 0.0
            val v = hypot(vNorte, vEste)
            if (v > VELOCIDAD_MAXIMA_CREIBLE_MS) {
                vNorte *= VELOCIDAD_MAXIMA_CREIBLE_MS / v
                vEste *= VELOCIDAD_MAXIMA_CREIBLE_MS / v
            }
            r.vNorte = vNorte
            r.vEste = vEste
            r.enMovimiento = enMovimiento
            if (enMovimiento) {
                // Lo que A ya extrapoló se le saca a la posición de partida: así
                // predecir() lo vuelve a sumar una sola vez.
                val yaExtrapoladoS = vistoHace.coerceAtMost(PREDICCION_MAXIMA_MS) / 1_000.0
                r.norte = -vNorte * yaExtrapoladoS
                r.este = -vEste * yaExtrapoladoS
            }
            r.anclarAca()
            r.detecciones = 0
            return r
        }
    }

    /** Lo que la app sabe del objetivo en un instante: es lo que va al dron y al Comando Central. */
    data class Estimacion(
        val lat: Double,
        val lon: Double,
        val vNorteMs: Double,
        val vEsteMs: Double,
        val velocidadMs: Double,
        /** Rumbo del desplazamiento, 0..360 (norte 0, este 90); 0 si está quieto. */
        val rumboGrados: Double,
        val enMovimiento: Boolean,
        val vistoHaceMs: Long,
        val perdido: Boolean,
    )

    // Origen del plano local
    private val lat0 = lat
    private val lon0 = lon
    private val metrosPorGradoLon = Geo.metrosPorGradoLon(lat)

    // Estado del filtro, en metros (norte, este) y m/s
    private var norte = 0.0
    private var este = 0.0
    private var vNorte = 0.0
    private var vEste = 0.0

    /** Dónde se lo consideró quieto por última vez: el desplazamiento se mide desde acá. */
    private var anclaNorte = 0.0
    private var anclaEste = 0.0

    private var ultimaActualizacionMs = ahoraMs

    /** Última vez que una detección se asoció a este objetivo. */
    var ultimaVistaMs = ahoraMs
        private set

    var enMovimiento = false
        private set

    /** Cuántas detecciones se le asociaron, la primera incluida. */
    var detecciones = 1
        private set

    private var rapidasSeguidas = 0
    private var lentoDesdeMs = -1L

    fun perdido(ahoraMs: Long): Boolean = ahoraMs - ultimaVistaMs > SIN_VER_PARA_PERDIDO_MS

    /**
     * Radio dentro del cual una detección nueva puede ser este objetivo: el
     * ruido de la proyección más lo que pudo andar desde la última vez que se lo
     * vio. Perdido, se busca más amplio para reengancharlo.
     */
    fun puertaM(ahoraMs: Long): Double {
        if (perdido(ahoraMs)) return PUERTA_DE_REENGANCHE_M
        val sinVerS = (ahoraMs - ultimaVistaMs).coerceAtLeast(0L) / 1_000.0
        return (PUERTA_BASE_M + hypot(vNorte, vEste) * sinVerS * 1.5).coerceAtMost(PUERTA_MAXIMA_M)
    }

    /**
     * De las posiciones candidatas (detecciones de la misma clase ya proyectadas
     * al terreno), cuál es este objetivo: la más cercana a donde se lo espera,
     * si cae dentro de la puerta. null si ninguna.
     */
    fun indiceMasCercano(candidatos: List<Pair<Double, Double>>, ahoraMs: Long): Int? {
        val (pNorte, pEste) = predecir(ahoraMs)
        val puerta = puertaM(ahoraMs)
        var mejor: Int? = null
        var mejorDistancia = Double.MAX_VALUE
        candidatos.forEachIndexed { i, (lat, lon) ->
            val (n, e) = aLocal(lat, lon)
            val d = hypot(n - pNorte, e - pEste)
            if (d <= puerta && d < mejorDistancia) {
                mejor = i
                mejorDistancia = d
            }
        }
        return mejor
    }

    /** Una detección asociada: corrige la posición y la velocidad, y reevalúa si se mueve. */
    fun actualizar(lat: Double, lon: Double, ahoraMs: Long) {
        val (zNorte, zEste) = aLocal(lat, lon)
        val estabaPerdido = perdido(ahoraMs)
        // Reenganchado después de perderlo: la velocidad vieja no sirve y la
        // posición nueva vale entera.
        if (estabaPerdido) {
            norte = zNorte
            este = zEste
            vNorte = 0.0
            vEste = 0.0
        } else {
            val dt = ((ahoraMs - ultimaActualizacionMs) / 1_000.0).coerceIn(0.1, 5.0)
            val pNorte = norte + vNorte * dt
            val pEste = este + vEste * dt
            val rNorte = zNorte - pNorte
            val rEste = zEste - pEste
            norte = pNorte + ALFA * rNorte
            este = pEste + ALFA * rEste
            vNorte += BETA / dt * rNorte
            vEste += BETA / dt * rEste
            val v = hypot(vNorte, vEste)
            if (v > VELOCIDAD_MAXIMA_CREIBLE_MS) {
                vNorte *= VELOCIDAD_MAXIMA_CREIBLE_MS / v
                vEste *= VELOCIDAD_MAXIMA_CREIBLE_MS / v
            }
        }
        ultimaActualizacionMs = ahoraMs
        ultimaVistaMs = ahoraMs
        detecciones++
        evaluarMovimiento(ahoraMs)
    }

    /**
     * El objetivo pasa a contarse como quieto donde está ahora: el desplazamiento
     * que lo vuelve a poner "en movimiento" se mide desde acá. Se llama al
     * volver a orbitarlo.
     */
    fun anclarAca() {
        anclaNorte = norte
        anclaEste = este
    }

    fun estimar(ahoraMs: Long): Estimacion {
        val (n, e) = predecir(ahoraMs)
        val v = hypot(vNorte, vEste)
        val rumbo = if (v < 0.1) 0.0 else (Math.toDegrees(atan2(vEste, vNorte)) + 360.0) % 360.0
        return Estimacion(
            lat = lat0 + n / Geo.METROS_POR_GRADO_LAT,
            lon = lon0 + e / metrosPorGradoLon,
            vNorteMs = if (enMovimiento) vNorte else 0.0,
            vEsteMs = if (enMovimiento) vEste else 0.0,
            velocidadMs = v,
            rumboGrados = rumbo,
            enMovimiento = enMovimiento,
            vistoHaceMs = (ahoraMs - ultimaVistaMs).coerceAtLeast(0L),
            perdido = perdido(ahoraMs),
        )
    }

    /**
     * Dónde se espera al objetivo ahora. Solo se extrapola si se está moviendo
     * —a un objetivo quieto, extrapolarle el ruido de la velocidad lo haría
     * derivar— y como mucho [PREDICCION_MAXIMA_MS]: más allá, la última
     * velocidad ya no dice nada.
     */
    private fun predecir(ahoraMs: Long): Pair<Double, Double> {
        if (!enMovimiento) return norte to este
        val dt = ((ahoraMs - ultimaActualizacionMs).coerceIn(0L, PREDICCION_MAXIMA_MS)) / 1_000.0
        return (norte + vNorte * dt) to (este + vEste * dt)
    }

    private fun evaluarMovimiento(ahoraMs: Long) {
        val v = hypot(vNorte, vEste)
        if (!enMovimiento) {
            rapidasSeguidas = if (v > VELOCIDAD_DE_MOVIMIENTO_MS) rapidasSeguidas + 1 else 0
            val desplazamiento = hypot(norte - anclaNorte, este - anclaEste)
            if (rapidasSeguidas >= ACTUALIZACIONES_PARA_MOVIMIENTO || desplazamiento > DESPLAZAMIENTO_DE_MOVIMIENTO_M) {
                enMovimiento = true
                rapidasSeguidas = 0
                lentoDesdeMs = -1L
            }
            return
        }
        if (v >= VELOCIDAD_DE_QUIETUD_MS) {
            lentoDesdeMs = -1L
            return
        }
        if (lentoDesdeMs < 0) lentoDesdeMs = ahoraMs
        if (ahoraMs - lentoDesdeMs >= QUIETUD_PARA_DETENIDO_MS) {
            enMovimiento = false
            lentoDesdeMs = -1L
            anclarAca()
        }
    }

    private fun aLocal(lat: Double, lon: Double): Pair<Double, Double> =
        (lat - lat0) * Geo.METROS_POR_GRADO_LAT to (lon - lon0) * metrosPorGradoLon
}

/**
 * Lugares donde el operador ya descartó una detección como falso positivo. Al
 * retomar la ruta el dron vuelve a pasar por ahí y el detector vuelve a ver lo
 * mismo —un poste, una sombra, un cartel—: sin esto el dron se quedaría
 * orbitando el mismo falso positivo una y otra vez, y el operador descartándolo.
 *
 * Una detección que cae dentro de [radioM] de una zona descartada hace menos de
 * [duracionMs] no alerta. Pasado ese tiempo la zona caduca: lo que hay ahí
 * puede ser otra cosa.
 */
class ZonasDescartadas(
    private val radioM: Double = RADIO_M,
    private val duracionMs: Long = DURACION_MS,
) {
    companion object {
        const val RADIO_M = 40.0
        const val DURACION_MS = 5 * 60_000L
    }

    private data class Zona(val lat: Double, val lon: Double, val hastaMs: Long)

    private val zonas = mutableListOf<Zona>()

    fun agregar(lat: Double, lon: Double, ahoraMs: Long) {
        if (lat.isNaN() || lon.isNaN()) return
        zonas += Zona(lat, lon, ahoraMs + duracionMs)
    }

    fun contiene(lat: Double, lon: Double, ahoraMs: Long): Boolean {
        zonas.removeAll { it.hastaMs <= ahoraMs }
        return zonas.any { Geo.distanciaM(it.lat, it.lon, lat, lon) <= radioM }
    }

    val cantidad: Int get() = zonas.size
}

/**
 * Cómo se acerca el dron a un objetivo que se mueve: se queda a [DISTANCIA_M]
 * de él en horizontal, del lado en que ya está (no da la vuelta para ponerse
 * atrás: eso le haría cruzar por encima del objetivo), copiando su velocidad y
 * corrigiendo la diferencia con una ganancia proporcional. La nariz —y con ella
 * la cámara— apunta al objetivo, y el gimbal baja lo justo para que quede en el
 * centro del cuadro.
 *
 * Es una función pura para poder probarla sin dron; la usan el controlador DJI
 * y el simulado en su lazo de 10 Hz.
 */
object Persecucion {

    /** Separación horizontal con el objetivo: lo bastante cerca para verlo, lo bastante lejos para no espantarlo. */
    const val DISTANCIA_M = 25.0

    /** Tope de velocidad del seguimiento: el modo N del Mini 4 Pro llega a 12 m/s. */
    const val VELOCIDAD_MAXIMA_MS = 12.0

    /** Cuánto corrige por metro de error (1/s). */
    const val GANANCIA = 0.4

    data class Orden(
        val vNorteMs: Double,
        val vEsteMs: Double,
        /** Hacia dónde apunta la nariz: hacia el objetivo. 0..360. */
        val rumboGrados: Double,
        /** Inclinación del gimbal para tener al objetivo en el centro del cuadro. */
        val gimbalPitch: Double,
        val distanciaM: Double,
    )

    fun calcular(
        latDron: Double,
        lonDron: Double,
        altM: Double,
        latObjetivo: Double,
        lonObjetivo: Double,
        vNorteObjetivo: Double,
        vEsteObjetivo: Double,
    ): Orden {
        // Del objetivo al dron, en metros
        val dNorte = (latDron - latObjetivo) * Geo.METROS_POR_GRADO_LAT
        val dEste = (lonDron - lonObjetivo) * Geo.metrosPorGradoLon(latObjetivo)
        val distancia = hypot(dNorte, dEste)
        // El lado desde el que se lo mira. Encima del objetivo (distancia ~0) no
        // hay lado: se elige el de atrás de su marcha, o el sur si está quieto.
        val (uNorte, uEste) = when {
            distancia > 1.0 -> dNorte / distancia to dEste / distancia
            hypot(vNorteObjetivo, vEsteObjetivo) > 0.1 -> {
                val v = hypot(vNorteObjetivo, vEsteObjetivo)
                -vNorteObjetivo / v to -vEsteObjetivo / v
            }
            else -> -1.0 to 0.0
        }
        // Error entre donde está y donde debería estar (a DISTANCIA_M del objetivo)
        val errorNorte = uNorte * DISTANCIA_M - dNorte
        val errorEste = uEste * DISTANCIA_M - dEste
        var vNorte = vNorteObjetivo + GANANCIA * errorNorte
        var vEste = vEsteObjetivo + GANANCIA * errorEste
        val v = hypot(vNorte, vEste)
        if (v > VELOCIDAD_MAXIMA_MS) {
            vNorte *= VELOCIDAD_MAXIMA_MS / v
            vEste *= VELOCIDAD_MAXIMA_MS / v
        }
        val rumbo = (Geo.rumboHacia(latDron, lonDron, latObjetivo, lonObjetivo) + 360.0) % 360.0
        return Orden(
            vNorteMs = vNorte,
            vEsteMs = vEste,
            rumboGrados = rumbo,
            gimbalPitch = Georreferencia.inclinacionParaOrbitar(altM, distancia),
            distanciaM = distancia,
        )
    }

    /** Punto a [metros] del objetivo en la dirección [rumboGrados]: lo usa el simulador. */
    fun desplazar(lat: Double, lon: Double, rumboGrados: Double, metros: Double): Pair<Double, Double> {
        val rad = Math.toRadians(rumboGrados)
        return (lat + metros * cos(rad) / Geo.METROS_POR_GRADO_LAT) to
            (lon + metros * sin(rad) / Geo.metrosPorGradoLon(lat))
    }
}
