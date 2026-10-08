package com.tesis.dronepatrol.drone

import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.math.tan

/**
 * Dónde está, en el terreno, lo que la cámara ve en un punto del cuadro.
 *
 * Es lo que convierte una caja de detección en un lugar al que orbitar: sin
 * esto la órbita se centraba en la posición del dron al momento de detectar, y
 * que el objetivo quedara a la vista dependía de la suerte. Con la altura, el
 * rumbo y la inclinación del gimbal, el rayo que pasa por el centro de la caja
 * se corta con el suelo (que se toma plano, a la altura de la base) y ese
 * punto es el objetivo. El error es de metros —el barómetro, la brújula, el
 * suelo que no es plano— y la órbita tiene 30 m de radio: alcanza para que la
 * cámara, apuntada al centro, no lo pierda.
 */
object Georreferencia {

    /**
     * Campo visual horizontal de la cámara del Mini 4 Pro en video 16:9 (24 mm
     * equivalentes, 82,1° de diagonal en el sensor 4:3). Con otro dron cambia
     * este número y nada más.
     */
    const val HFOV_GRADOS = 73.0

    /** Un rayo más rasante que esto no corta el suelo a una distancia creíble. */
    const val DEPRESION_MINIMA_GRADOS = 5.0

    /** Tope: más lejos que esto el cálculo es ruido y el dron no debería irse tan lejos. */
    const val DISTANCIA_MAXIMA_M = 250.0

    /** El punto del terreno, con su distancia y rumbo desde el dron para el registro. */
    data class Objetivo(val lat: Double, val lon: Double, val distanciaM: Double, val rumboGrados: Double)

    /** Campo visual vertical para una relación de aspecto dada (16:9 por defecto). */
    fun vfovGrados(relacionDeAspecto: Double = 16.0 / 9.0): Double =
        Math.toDegrees(2 * atan(tan(Math.toRadians(HFOV_GRADOS / 2)) / relacionDeAspecto))

    /**
     * Proyecta al terreno el punto ([xNorm], [yNorm]) del cuadro (0..1, origen
     * arriba a la izquierda) visto desde ([lat], [lon]) a [altM] metros sobre el
     * suelo, con la nariz al rumbo [rumboGrados] y el gimbal inclinado
     * [gimbalPitchGrados] (0 horizonte, −90 nadir). Devuelve null si el rayo no
     * baja lo suficiente para cortar el suelo (horizonte) o si no hay altura.
     *
     * La cuenta va por vectores y no por sumar ángulos, para que valga también
     * con el gimbal al nadir, donde "abajo en la imagen" es "atrás del dron".
     */
    fun proyectar(
        lat: Double,
        lon: Double,
        altM: Double,
        rumboGrados: Double,
        gimbalPitchGrados: Double,
        xNorm: Double,
        yNorm: Double,
    ): Objetivo? {
        if (altM < 2.0) return null
        // Rayo en el marco de la cámara: x = eje óptico, y = derecha, z = abajo en la imagen
        val u = (xNorm.coerceIn(0.0, 1.0) - 0.5) * 2
        val v = (yNorm.coerceIn(0.0, 1.0) - 0.5) * 2
        val xc = 1.0
        val yc = u * tan(Math.toRadians(HFOV_GRADOS / 2))
        val zc = v * tan(Math.toRadians(vfovGrados() / 2))
        // Inclinación del gimbal: el eje óptico baja `dep` grados desde el
        // horizonte y "abajo en la imagen" gira con él hacia atrás.
        val dep = Math.toRadians(-gimbalPitchGrados)
        val xb = xc * cos(dep) - zc * sin(dep) // adelante
        val yb = yc // derecha
        val zb = xc * sin(dep) + zc * cos(dep) // hacia el suelo
        val largo = hypot(hypot(xb, yb), zb)
        if (zb / largo < sin(Math.toRadians(DEPRESION_MINIMA_GRADOS))) return null
        val horizontal = hypot(xb, yb)
        val distancia = (altM * horizontal / zb).coerceAtMost(DISTANCIA_MAXIMA_M)
        val rumbo = ((rumboGrados + Math.toDegrees(atan2(yb, xb))) % 360.0 + 360.0) % 360.0
        val rad = Math.toRadians(rumbo)
        return Objetivo(
            lat = lat + distancia * cos(rad) / Geo.METROS_POR_GRADO_LAT,
            lon = lon + distancia * sin(rad) / Geo.metrosPorGradoLon(lat),
            distanciaM = distancia,
            rumboGrados = rumbo,
        )
    }

    /**
     * Inclinación del gimbal para que la cámara apunte al centro de una órbita
     * de [radioM] volando a [altM]: la depresión del centro visto desde el
     * círculo. Entre −90 y −10 para que el gimbal lo acepte.
     */
    fun inclinacionParaOrbitar(altM: Double, radioM: Double): Double {
        if (radioM <= 0.0) return -90.0
        return (-Math.toDegrees(atan2(altM, radioM))).coerceIn(-90.0, -10.0)
    }
}
