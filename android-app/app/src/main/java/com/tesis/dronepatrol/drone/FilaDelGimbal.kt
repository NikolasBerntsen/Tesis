package com.tesis.dronepatrol.drone

/**
 * El único camino hacia el gimbal del dron real: las inclinaciones que pide la
 * consola (`manual_gimbal`) y las que pone la app en los modos autónomos (la de
 * patrulla al arrancar la ruta, la que acompaña a la órbita y al seguimiento)
 * salen todas por acá, de a una y en el orden en que se pidieron.
 *
 * Es uno solo por el orden. La inclinación de la consola espera su turno
 * ([UltimoPedido]): hasta 300 ms entre orden y orden, o hasta el tope si el SDK
 * tarda en contestar. Mientras la cámara autónoma iba directo al SDK, esa espera
 * la dejaba llegar DESPUÉS: el operador soltaba el control con la rueda en
 * movimiento, la ruta apuntaba la cámara a −70° y un rato más tarde salía el 0°
 * que estaba esperando. La patrulla seguía mirando al horizonte —la ruta apunta
 * una sola vez, y la órbita solo vuelve a apuntar si lo que quiere se corre más
 * de 3°— y ninguna detección se podía ubicar en el terreno. Por la misma fila,
 * la orden de la app pisa a la de la consola que esperaba y sale recién cuando
 * el gimbal contestó la que estaba cumpliendo: no hay forma de que la adelanten.
 *
 * Al salir de MANUAL, además, se tira la de la consola que seguía esperando
 * ([descartarLaDeLaConsola]): fuera de MANUAL la cámara no es del operador, y
 * en los estados que no la vuelven a apuntar (estacionario, regreso a base) esa
 * inclinación llegaría tarde y sin nadie al control. La que el gimbal ya está
 * cumpliendo no se puede retirar —el SDK ya la tiene—: termina, y lo que la app
 * pida después sale detrás de ella. Si no contesta, se la da por perdida al
 * [topeMs] y su respuesta tardía no toca nada.
 */
class FilaDelGimbal(
    intervaloMs: Long,
    topeMs: Long,
    girar: suspend (Orden) -> Unit,
    alVencerse: (Orden) -> Unit,
) {

    /**
     * Una inclinación (0 horizonte, −90 nadir) y de quién vino. El origen no es
     * solo para el descarte: el dron real gira distinto según quién la pidió
     * (más rápido para la rueda del operador) y avisa el rechazo con otro texto.
     */
    class Orden(val pitchGrados: Double, val deLaConsola: Boolean)

    private val pedidos = UltimoPedido(intervaloMs, topeMs, girar, alVencerse)

    /** La que pide el titular del control desde la consola. */
    fun inclinarDesdeLaConsola(pitchGrados: Double) = pedidos.pedir(Orden(pitchGrados, deLaConsola = true))

    /** La que pone un modo autónomo. Pisa a la que estuviera esperando, sea de quien sea. */
    fun apuntarDesdeLaApp(pitchGrados: Double) = pedidos.pedir(Orden(pitchGrados, deLaConsola = false))

    /** Al salir de MANUAL: tira la de la consola que esperaba. Una de la app que espera, sigue. */
    fun descartarLaDeLaConsola() = pedidos.descartarPendiente { it.deLaConsola }

    /** Al reconectar: lo que quedó de antes era de un vuelo que ya terminó, venga de quien venga. */
    fun descartarTodo() = pedidos.descartarPendiente()

    /** Le pasa las órdenes al gimbal hasta que se cancele la corrutina que lo llama (ver [UltimoPedido.atender]). */
    suspend fun atender() = pedidos.atender()
}
