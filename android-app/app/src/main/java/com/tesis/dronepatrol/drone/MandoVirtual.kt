package com.tesis.dronepatrol.drone

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * Traducción de los ejes del mando virtual de la consola a velocidades para el
 * dron. Cada eje llega en [-1, 1], como una palanca física, y es relativo al
 * cuerpo del dron: adelante es hacia donde mira la cámara, que es lo que el
 * operador tiene delante en el video.
 *
 * La escala vive acá y no en cada controlador para que el dron simulado y el
 * DJI se muevan igual de rápido con el mismo gesto del operador.
 */
object MandoVirtual {

    /** Velocidad horizontal a fondo de palanca. Andar más rápido que esto en
     * manual, mirando un video con retardo, no es manejable. */
    const val MAX_HORIZONTAL_MS = 5.0

    /** Velocidad de subida/bajada a fondo de palanca. */
    const val MAX_VERTICAL_MS = 2.0

    /** Velocidad de giro a fondo de palanca. */
    const val MAX_YAW_GRADOS_S = 45.0

    /**
     * Por debajo de esto el eje se toma como cero. El mando de la consola es un
     * dedo sobre una pantalla: sin zona muerta, soltar despacio deja al dron con
     * una deriva de la que nadie se hace cargo.
     */
    const val ZONA_MUERTA = 0.05

    /**
     * Velocidades relativas al cuerpo del dron, que son las que el MSDK acepta
     * con el marco de coordenadas BODY (FlightCoordinateSystem.BODY).
     */
    data class VelocidadesCuerpo(
        /** m/s hacia la nariz; negativo es hacia atrás. */
        val adelanteMs: Double,
        /** m/s hacia la derecha del dron; negativo es hacia la izquierda. */
        val derechaMs: Double,
        /** grados/s en sentido horario; negativo es antihorario. */
        val giroGradosS: Double,
        /** m/s hacia arriba; negativo es bajar. */
        val subidaMs: Double,
    ) {
        /** Los cuatro ejes en cero: el dron se queda en vuelo estacionario. */
        val estacionario: Boolean
            get() = adelanteMs == 0.0 && derechaMs == 0.0 && giroGradosS == 0.0 && subidaMs == 0.0
    }

    /** Velocidades en el marco del terreno (norte/este), las que usa el simulador. */
    data class VelocidadesTerreno(val norteMs: Double, val esteMs: Double)

    /** Ejes en cero: el valor con el que se arranca y al que se vuelve al soltar. */
    val NEUTRO = VelocidadesCuerpo(0.0, 0.0, 0.0, 0.0)

    /**
     * Normaliza un eje: recorta a [-1, 1] y aplica la zona muerta. Un NaN
     * cuenta como cero — puede llegar uno si el mensaje viene sin el campo, y
     * un NaN metido en una velocidad es una orden sin sentido para el dron.
     */
    fun eje(valor: Double): Double {
        if (valor.isNaN()) return 0.0
        val recortado = valor.coerceIn(-1.0, 1.0)
        return if (abs(recortado) < ZONA_MUERTA) 0.0 else recortado
    }

    /** Ejes del mando (ver `manual_stick` en docs/PROTOCOLS.md) → velocidades. */
    fun velocidades(pitch: Double, roll: Double, yaw: Double, throttle: Double) = VelocidadesCuerpo(
        adelanteMs = eje(pitch) * MAX_HORIZONTAL_MS,
        derechaMs = eje(roll) * MAX_HORIZONTAL_MS,
        giroGradosS = eje(yaw) * MAX_YAW_GRADOS_S,
        subidaMs = eje(throttle) * MAX_VERTICAL_MS,
    )

    /**
     * Pasa las velocidades del cuerpo del dron al marco del terreno, sabiendo
     * que la nariz apunta a [rumboGrados] (norte = 0, este = 90).
     *
     * La necesita el simulador, que mueve latitud y longitud; el DJI no, porque
     * comanda en coordenadas BODY y la rotación la hace el propio dron.
     */
    fun aTerreno(v: VelocidadesCuerpo, rumboGrados: Double): VelocidadesTerreno {
        val rumbo = Math.toRadians(rumboGrados)
        // "Adelante" es el versor del rumbo; "derecha" es ese mismo versor
        // girado 90° en sentido horario.
        return VelocidadesTerreno(
            norteMs = v.adelanteMs * cos(rumbo) - v.derechaMs * sin(rumbo),
            esteMs = v.adelanteMs * sin(rumbo) + v.derechaMs * cos(rumbo),
        )
    }
}
