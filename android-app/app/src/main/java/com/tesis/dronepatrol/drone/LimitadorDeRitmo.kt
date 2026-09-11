package com.tesis.dronepatrol.drone

/**
 * Deja pasar un elemento cada [intervaloMs] y descarta el resto.
 *
 * Se usa sobre el flujo de cuadros que entrega el decodificador del MSDK, que
 * llega a unos 30 por segundo: de ahí salen los 5 que se publican
 * ([CuadroDeVideo.INTERVALO_CUADRO_MS]). El reparto entre el Comando Central y
 * la detección NO usa esto y cuenta cuadros: sobre un flujo que ya viene
 * raleado, un limitador de tiempo solo puede aceptar en múltiplos del intervalo
 * de origen y el ritmo que sale no es el que se pidió (ver
 * PatrolManager.repartirVideo).
 *
 * No tiene reloj propio a propósito: el momento lo pasa quien llama. Así se
 * prueba sin dormir el test y el mismo limitador sirve para el hilo del SDK y
 * para una corrutina.
 */
class LimitadorDeRitmo(private val intervaloMs: Long) {

    private var ultimoMs = SIN_ANTECEDENTE

    /**
     * true si el elemento que llega en [ahoraMs] se acepta; false si hay que
     * tirarlo porque todavía no pasó el intervalo.
     *
     * Está sincronizado porque el listener de cuadros del MSDK llama desde su
     * propio hilo, que no es el que arma el resto del enlace.
     */
    @Synchronized
    fun aceptar(ahoraMs: Long): Boolean {
        val transcurrido = ahoraMs - ultimoMs
        // Un transcurrido negativo es el reloj del celular acomodándose hacia
        // atrás (NTP, cambio de hora). Se acepta y se vuelve a anclar: si no, el
        // limitador quedaría mudo hasta que el reloj recupere la diferencia.
        if (ultimoMs != SIN_ANTECEDENTE && transcurrido in 0 until intervaloMs) return false
        ultimoMs = ahoraMs
        return true
    }

    private companion object {
        /** Todavía no pasó nada: el primero siempre se acepta. */
        const val SIN_ANTECEDENTE = Long.MIN_VALUE
    }
}
