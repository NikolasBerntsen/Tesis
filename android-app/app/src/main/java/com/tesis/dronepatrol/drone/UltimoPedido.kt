package com.tesis.dronepatrol.drone

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Le lleva a un componente lento los pedidos que llegan más rápido de lo que él
 * puede cumplirlos, quedándose siempre con el ÚLTIMO.
 *
 * Existe por la inclinación de la cámara que pide la consola (`manual_gimbal`):
 * mientras el operador arrastra llega una cada 100 ms, y en el DJI cada una es
 * una acción del SDK con su ida y vuelta que, encima, interrumpe el recorrido de
 * la anterior. Pasarlas todas era pelearse con el gimbal, lo mismo que evita
 * `GimbalQueAcompania` en los modos autónomos.
 *
 * Los pedidos que llegan mientras uno está en curso se pisan entre sí (el canal
 * es CONFLATED) y, cuando el componente termina, se le pasa el último: los de
 * en medio son posiciones por las que la cámara ya no necesita pasar. Eso solo
 * funciona si [cumplir] vuelve recién cuando el componente CONTESTÓ: con uno que
 * vuelve en el acto, el canal se vacía apenas llega cada pedido y no se tira
 * ninguno. Por eso [cumplir] es suspend.
 *
 * Además, entre el comienzo de un pedido y el del siguiente pasa al menos
 * [intervaloMs], por si el componente contesta apenas acepta la orden y no
 * cuando la terminó. Y un pedido que no termina en [topeMs] se da por perdido
 * ([alVencerse]): un callback del SDK que no llega nunca no puede dejar mudos a
 * los que vienen atrás.
 *
 * El último pedido nunca se pierde: queda en el canal hasta que le toca.
 */
class UltimoPedido<T>(
    private val intervaloMs: Long,
    private val topeMs: Long,
    private val cumplir: suspend (T) -> Unit,
    private val alVencerse: (T) -> Unit,
) {

    private val pedidos = Channel<T>(Channel.CONFLATED)

    /** Deja [valor] como el próximo a cumplir, pisando al que estuviera esperando. No bloquea nunca. */
    fun pedir(valor: T) {
        pedidos.trySend(valor)
    }

    /** Tira el pedido que estuviera esperando, si había uno; el que está en curso sigue. */
    fun descartarPendiente() {
        pedidos.tryReceive()
    }

    /**
     * Atiende los pedidos de a uno, en orden, hasta que se cancele la corrutina
     * que lo llama. [cumplir] no tiene que tirar: una excepción corta la
     * atención, igual que en cualquier otra corrutina.
     */
    suspend fun atender() {
        for (valor in pedidos) {
            coroutineScope {
                // El espaciado corre a la par del pedido y no después: si el
                // componente tarda más que el intervalo, el siguiente sale apenas
                // termina, sin sumarle otra espera.
                val espaciado = launch { delay(intervaloMs) }
                if (withTimeoutOrNull(topeMs) { cumplir(valor) } == null) alVencerse(valor)
                espaciado.join()
            }
        }
    }
}
