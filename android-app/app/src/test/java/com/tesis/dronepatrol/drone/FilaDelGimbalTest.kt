package com.tesis.dronepatrol.drone

import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * El camino hacia el gimbal del DJI, sin el SDK: que la cámara que apunta la
 * app no la pueda pisar una inclinación de la consola que seguía en la fila.
 *
 * El caso del campo: el operador mueve la rueda (una inclinación en curso y otra
 * esperando), un supervisor le saca el control y el hub manda soltar y
 * retomar la ruta; la ruta apunta la cámara a la de patrulla en unos
 * milisegundos. Si la inclinación que esperaba sale después, la patrulla sigue
 * mirando al horizonte —la ruta apunta una sola vez— y ninguna detección se
 * puede ubicar en el terreno.
 *
 * Corre en la JVM pelada con el bucle de runBlocking, como UltimoPedidoTest:
 * el gimbal "contesta" cuando el test lo dice, y el orden es exacto.
 */
class FilaDelGimbalTest {

    /** Las órdenes que el gimbal empezó a cumplir, en orden. */
    private val empezadas = Channel<String>(Channel.UNLIMITED)

    /** Cada vez que el test manda algo acá, el gimbal contesta la orden en curso. */
    private val contestar = Channel<Unit>(Channel.UNLIMITED)

    private val vencidas = mutableListOf<String>()

    private fun FilaDelGimbal.Orden.comoTexto() = (if (deLaConsola) "consola " else "app ") + pitchGrados

    private fun fila() = FilaDelGimbal(
        intervaloMs = 0,
        topeMs = 5_000,
        girar = { orden ->
            empezadas.send(orden.comoTexto())
            contestar.receive()
        },
        alVencerse = { vencidas += it.comoTexto() },
    )

    private suspend fun laQueEmpieza(): String = withTimeout(2_000) { empezadas.receive() }

    private suspend fun ningunaMas(): String? = withTimeoutOrNull(200) { empezadas.receive() }

    @Test
    fun alSalirDeManualLaQueEsperabaNoSaleYLaDeLaAppVaDetrasDeLaQueEstabaEnCurso() = runBlocking {
        val gimbal = fila()
        val atencion = launch { gimbal.atender() }
        gimbal.inclinarDesdeLaConsola(-30.0)
        assertEquals("consola -30.0", laQueEmpieza())
        gimbal.inclinarDesdeLaConsola(0.0)

        // Sale de MANUAL y la ruta apunta la cámara a la de patrulla
        gimbal.descartarLaDeLaConsola()
        gimbal.apuntarDesdeLaApp(-70.0)
        // Con la de la consola todavía en curso, la de la app espera: si saliera
        // ya, el gimbal la podría cumplir antes que la que ya tenía.
        assertNull(ningunaMas())

        contestar.send(Unit)
        assertEquals("app -70.0", laQueEmpieza())
        contestar.send(Unit)
        // Y el 0° que esperaba no llega nunca: la última es la de patrulla.
        assertNull(ningunaMas())
        atencion.cancel()
    }

    /**
     * Soltar el control sin otra orden (queda estacionario): nadie vuelve a
     * apuntar la cámara, y la inclinación que esperaba igual no sale. Fuera de
     * MANUAL la cámara no es del operador.
     */
    @Test
    fun alSalirDeManualSinOtraOrdenLaQueEsperabaTampocoSale() = runBlocking {
        val gimbal = fila()
        val atencion = launch { gimbal.atender() }
        gimbal.inclinarDesdeLaConsola(-30.0)
        assertEquals("consola -30.0", laQueEmpieza())
        gimbal.inclinarDesdeLaConsola(0.0)

        gimbal.descartarLaDeLaConsola()
        contestar.send(Unit)

        assertNull("la que esperaba salió después de salir de MANUAL", ningunaMas())
        atencion.cancel()
    }

    /**
     * Aun sin el descarte, ir por la misma fila ya alcanza para el orden: la de
     * la app pisa a la de la consola que esperaba. Es lo que protege a la órbita
     * y al seguimiento, que vuelven a apuntar solo si lo que quieren se corre.
     */
    @Test
    fun laDeLaAppPisaALaDeLaConsolaQueEsperaba() = runBlocking {
        val gimbal = fila()
        val atencion = launch { gimbal.atender() }
        gimbal.inclinarDesdeLaConsola(-30.0)
        assertEquals("consola -30.0", laQueEmpieza())
        gimbal.inclinarDesdeLaConsola(0.0)

        gimbal.apuntarDesdeLaApp(-40.0)
        contestar.send(Unit)

        assertEquals("app -40.0", laQueEmpieza())
        contestar.send(Unit)
        assertNull(ningunaMas())
        atencion.cancel()
    }

    /** El descarte es solo de la consola: la cámara que puso la app y espera su turno, sale. */
    @Test
    fun descartarLaDeLaConsolaNoTiraLaDeLaApp() = runBlocking {
        val gimbal = fila()
        val atencion = launch { gimbal.atender() }
        gimbal.apuntarDesdeLaApp(-70.0)
        assertEquals("app -70.0", laQueEmpieza())
        gimbal.apuntarDesdeLaApp(-55.0)

        gimbal.descartarLaDeLaConsola()
        contestar.send(Unit)

        assertEquals("app -55.0", laQueEmpieza())
        contestar.send(Unit)
        atencion.cancel()
    }

    /** Al reconectar se tira lo que quedó, venga de quien venga: era de un vuelo que terminó. */
    @Test
    fun descartarTodoTiraTambienLaDeLaApp() = runBlocking {
        val gimbal = fila()
        gimbal.apuntarDesdeLaApp(-70.0)
        gimbal.descartarTodo()
        gimbal.inclinarDesdeLaConsola(-10.0)
        gimbal.descartarTodo()

        val atencion = launch { gimbal.atender() }

        assertNull(ningunaMas())
        atencion.cancel()
    }

    /**
     * El SDK lento: la de la consola en curso no contesta nunca. La de la app no
     * sale antes de darla por perdida —sería mandarle al gimbal dos órdenes a la
     * vez, sin saber cuál cumple último—, y sale apenas se vence.
     */
    @Test
    fun conElGimbalSinContestarLaDeLaAppSaleAlVencerseLaDeLaConsola() = runBlocking {
        val gimbal = FilaDelGimbal(
            intervaloMs = 0,
            topeMs = 300,
            girar = { orden ->
                empezadas.send(orden.comoTexto())
                if (orden.deLaConsola) awaitCancellation()
            },
            alVencerse = { vencidas += it.comoTexto() },
        )
        val atencion = launch { gimbal.atender() }
        gimbal.inclinarDesdeLaConsola(0.0)
        assertEquals("consola 0.0", laQueEmpieza())

        gimbal.descartarLaDeLaConsola()
        gimbal.apuntarDesdeLaApp(-70.0)

        assertEquals("app -70.0", laQueEmpieza())
        assertEquals("salió recién con la de la consola vencida", listOf("consola 0.0"), vencidas)
        atencion.cancel()
    }
}
