package com.tesis.dronepatrol.drone

import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El camino de la inclinación que pide la consola hacia el gimbal del DJI, sin
 * el SDK: mientras una orden está en curso los pedidos se pisan y llega el
 * último; entre orden y orden hay un mínimo; y una orden que no contesta no
 * traba a las que vienen. Corre en la JVM pelada, con el bucle de runBlocking:
 * los pedidos y la atención se turnan en un solo hilo y el orden es exacto.
 */
class UltimoPedidoTest {

    /** Los valores que [cumplir] empezó, en orden, para esperarlos sin dormir. */
    private val empezados = Channel<Int>(Channel.UNLIMITED)

    @Test
    fun losPedidosQueLleganConUnoEnCursoSePisanYSeCumpleElUltimo() = runBlocking {
        val terminar = Channel<Unit>(Channel.UNLIMITED)
        val cumplidos = mutableListOf<Int>()
        val pedido = UltimoPedido<Int>(
            intervaloMs = 0,
            topeMs = 5_000,
            cumplir = { v ->
                cumplidos += v
                empezados.send(v)
                terminar.receive()
            },
            alVencerse = {},
        )
        val atencion = launch { pedido.atender() }

        pedido.pedir(1)
        assertEquals(1, withTimeout(2_000) { empezados.receive() })
        // Con el 1 en curso llegan tres más: son posiciones por las que la
        // cámara ya no necesita pasar, salvo la última.
        pedido.pedir(2)
        pedido.pedir(3)
        pedido.pedir(4)
        terminar.send(Unit)

        assertEquals(4, withTimeout(2_000) { empezados.receive() })
        terminar.send(Unit)
        atencion.cancel()
        assertEquals(listOf(1, 4), cumplidos)
    }

    @Test
    fun unPedidoQueNoContestaATiempoSeDaPorPerdidoYNoTrabaAlSiguiente() = runBlocking {
        val vencidos = mutableListOf<Int>()
        val pedido = UltimoPedido<Int>(
            intervaloMs = 0,
            topeMs = 50,
            cumplir = { v ->
                empezados.send(v)
                // El callback del SDK que no llega nunca
                if (v == 1) awaitCancellation()
            },
            alVencerse = { vencidos += it },
        )
        val atencion = launch { pedido.atender() }

        pedido.pedir(1)
        assertEquals(1, withTimeout(2_000) { empezados.receive() })
        pedido.pedir(2)

        assertEquals(2, withTimeout(2_000) { empezados.receive() })
        atencion.cancel()
        assertEquals(listOf(1), vencidos)
    }

    /** Por si el SDK contesta apenas acepta la orden: igual no salen más de una cada intervalo. */
    @Test
    fun entreElComienzoDeUnPedidoYElDelSiguientePasaAlMenosElIntervalo() = runBlocking {
        val comienzos = mutableListOf<Long>()
        val pedido = UltimoPedido<Int>(
            intervaloMs = 150,
            topeMs = 5_000,
            cumplir = { v ->
                comienzos += System.nanoTime()
                empezados.send(v)
            },
            alVencerse = {},
        )
        val atencion = launch { pedido.atender() }

        pedido.pedir(1)
        withTimeout(2_000) { empezados.receive() }
        pedido.pedir(2)
        withTimeout(2_000) { empezados.receive() }
        atencion.cancel()

        val entreUnoYOtroMs = (comienzos[1] - comienzos[0]) / 1_000_000
        assertTrue("salieron con $entreUnoYOtroMs ms entre uno y otro", entreUnoYOtroMs >= 150)
    }

    /** Lo que quedó encolado de antes (de un control que ya terminó) no se aplica al volver a atender. */
    @Test
    fun descartarPendienteTiraElQueEsperabaYNoElSiguiente() = runBlocking {
        val cumplidos = mutableListOf<Int>()
        val pedido = UltimoPedido<Int>(
            intervaloMs = 0,
            topeMs = 5_000,
            cumplir = { v ->
                cumplidos += v
                empezados.send(v)
            },
            alVencerse = {},
        )
        pedido.pedir(1)
        pedido.descartarPendiente()
        // Sin nada esperando, descartar no hace nada
        pedido.descartarPendiente()

        val atencion = launch { pedido.atender() }
        pedido.pedir(2)

        assertEquals(2, withTimeout(2_000) { empezados.receive() })
        atencion.cancel()
        assertEquals(listOf(2), cumplidos)
    }
}
