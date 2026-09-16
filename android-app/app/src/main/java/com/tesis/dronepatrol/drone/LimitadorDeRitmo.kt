package com.tesis.dronepatrol.drone

/**
 * Deja pasar un elemento cada [intervaloMs] y descarta el resto.
 *
 * Se usa en los dos techos del video, que son de cosas distintas:
 *
 *  - sobre el flujo que entrega el decodificador del MSDK, que llega a unos 30
 *    por segundo, para publicar los 5 del contrato
 *    ([CuadroDeVideo.INTERVALO_CUADRO_MS]); y
 *  - sobre el reparto hacia el software de detección, que no puede ver más de
 *    dos por segundo (PatrolManager.repartirVideo).
 *
 * En el segundo caso la entrada ya viene raleada a 200 ms, así que el limitador
 * solo puede aceptar en múltiplos de esos 200 ms y el ritmo que sale queda por
 * DEBAJO del pedido (uno cada 600 ms en vez de cada 500). Es a propósito: lo que
 * se promete afuera es un techo, y errarle por abajo es del lado correcto.
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
