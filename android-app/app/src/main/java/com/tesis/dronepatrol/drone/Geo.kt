package com.tesis.dronepatrol.drone

import kotlin.math.atan2
import kotlin.math.cos

/**
 * Las cuentas de geografía que comparten el dron simulado y el DJI.
 *
 * Viven acá y no duplicadas en cada controlador porque el mismo error ya se
 * cometió una vez: el rumbo de la órbita del DJI restaba grados de longitud
 * contra grados de latitud sin escalar, la nariz no apuntaba al objetivo y la
 * cámara lo perdía del centro del cuadro — justo en el único modo cuyo propósito
 * es mantenerlo encuadrado. Acá, además, se puede probar sin dron.
 */
object Geo {

    /** Metros que mide un grado de latitud (para la escala que nos importa, constante). */
    const val METROS_POR_GRADO_LAT = 111_320.0

    /**
     * Metros que mide un grado de longitud a la latitud [lat]. Los meridianos se
     * juntan hacia los polos: a la latitud del Obelisco (-34,6°) un grado de
     * longitud mide un 18 % menos que uno de latitud, así que mezclar los dos sin
     * escalar deja errores de rumbo de casi 6° cerca de las diagonales.
     */
    fun metrosPorGradoLon(lat: Double): Double = METROS_POR_GRADO_LAT * cos(Math.toRadians(lat))

    /**
     * Rumbo desde ([lat], [lon]) hacia ([latDestino], [lonDestino]), con el norte
     * en 0 y el este en 90.
     *
     * Devuelve -180..180, que es el rango en el que habla el MSDK (su
     * KeyCompassHeading también); el simulador lo normaliza a 0..360 para su
     * telemetría, que es lo que espera el resto del sistema.
     */
    fun rumboHacia(lat: Double, lon: Double, latDestino: Double, lonDestino: Double): Double {
        val dy = (latDestino - lat) * METROS_POR_GRADO_LAT
        val dx = (lonDestino - lon) * metrosPorGradoLon(lat)
        return Math.toDegrees(atan2(dx, dy))
    }
}
