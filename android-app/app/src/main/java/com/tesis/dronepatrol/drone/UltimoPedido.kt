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
 * Los pedidos que llegan mientras uno está en curso se pisan entre sí (hay un
 * solo lugar de espera) y, cuando el componente termina, se le pasa el último:
 * los de en medio son posiciones por las que la cámara ya no necesita pasar.
 * Eso solo funciona si [cumplir] vuelve recién cuando el componente CONTESTÓ:
 * con uno que vuelve en el acto, el lugar se vacía apenas llega cada pedido y no
 * se tira ninguno. Por eso [cumplir] es suspend.
 *
 * Además, entre el comienzo de un pedido y el del siguiente pasa al menos
 * [intervaloMs], por si el componente contesta apenas acepta la orden y no
 * cuando la terminó. Y un pedido que no termina en [topeMs] se da por perdido
 * ([alVencerse]): un callback del SDK que no llega nunca no puede dejar mudos a
 * los que vienen atrás.
 *
 * El último pedido no se pierde: espera hasta que le toca, salvo que alguien lo
 * descarte a propósito ([descartarPendiente]).
 */
class UltimoPedido<T : Any>(
    private val intervaloMs: Long,
    private val topeMs: Long,
    private val cumplir: suspend (T) -> Unit,
    private val alVencerse: (T) -> Unit,
) {

    /**
     * El lugar de espera, con [cerrojo]. Un campo y no un canal CONFLATED, que
     * era lo que había: el canal deja tirar lo que espera pero no tirarlo SOLO SI
     * es de cierta clase. Sacarlo, mirarlo y devolverlo no sirve: un pedido nuevo
     * que entrara en el medio quedaba pisado por el viejo devuelto.
     */
    private var pendiente: T? = null
    private val cerrojo = Any()

    /**
     * Despierta a [atender] cuando hay algo en [pendiente]. Con un aviso alcanza
     * aunque lleguen diez pedidos: el que atiende siempre se lleva el último, y
     * un aviso que lo encuentra vacío (porque ya se lo llevó o porque se
     * descartó) no hace nada.
     */
    private val hayPedido = Channel<Unit>(Channel.CONFLATED)

    /** Deja [valor] como el próximo a cumplir, pisando al que estuviera esperando. No bloquea nunca. */
    fun pedir(valor: T) {
        // Primero el valor y después el aviso: al revés, el que atiende podía
        // despertarse, encontrar el lugar vacío y volver a dormirse con el
        // pedido ya puesto y sin otro aviso en camino.
        synchronized(cerrojo) { pendiente = valor }
        hayPedido.trySend(Unit)
    }

    /**
     * Tira el pedido que estuviera esperando si cumple [si] (cualquiera, si no
     * se dice). El que está en curso sigue: el componente ya lo tiene y no hay
     * forma de retirárselo. Mirar y tirar es un solo paso contra [pedir], así
     * que un pedido nuevo que entra justo ahí nunca se tira por error.
     */
    fun descartarPendiente(si: (T) -> Boolean = { true }) {
        synchronized(cerrojo) {
            val esperando = pendiente
            if (esperando != null && si(esperando)) pendiente = null
        }
    }

    /**
     * Atiende los pedidos de a uno, en orden, hasta que se cancele la corrutina
     * que lo llama. [cumplir] no tiene que tirar: una excepción corta la
     * atención, igual que en cualquier otra corrutina.
     */
    suspend fun atender() {
        while (true) {
            hayPedido.receive()
            val valor = synchronized(cerrojo) { pendiente.also { pendiente = null } } ?: continue
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
