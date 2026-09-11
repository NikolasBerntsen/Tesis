package com.tesis.dronepatrol.drone

/**
 * Deja pasar un elemento cada [intervaloMs] y descarta el resto.
 *
 * Se usa dos veces sobre el mismo flujo de video: a 200 ms hacia el Comando
 * Central (5 cuadros por segundo, que es lo que mira el operador) y a 500 ms
 * hacia el software de detección (2 por segundo: el enlace con la laptop es el
 * más flojo de los tres y detectar no necesita más).
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
