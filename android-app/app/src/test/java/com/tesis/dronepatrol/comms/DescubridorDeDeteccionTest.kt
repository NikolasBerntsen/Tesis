package com.tesis.dronepatrol.comms

import android.os.Build
import com.tesis.dronepatrol.patrol.RelojFalso
import java.io.IOException
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import javax.net.SocketFactory
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La lectura de los anuncios UDP de la laptop. En una red Wi-Fi llega de todo
 * por broadcast: solo un JSON con el nombre del servicio y un puerto válido es
 * un anuncio. Robolectric porque el anuncio se lee con org.json, que en la JVM
 * pelada es un stub del SDK de Android.
 *
 * La escucha corre contra un socket UDP de mentira ([SocketUdpFalso]): el
 * "hola" de verdad sale por broadcast a la LAN de la PC de desarrollo, y ahí un
 * servidor de detección abierto lo tomaba por un teléfono. El ritmo del "hola"
 * se mide con un [RelojFalso] que el test adelanta: los 2 s y los 5 s se
 * prueban en su límite exacto y sin esperarlos.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DescubridorDeDeteccionTest {

    private val udp = SocketUdpFalso()
    private val enMarcha = mutableListOf<DescubridorDeDeteccion>()

    /** Un instante cualquiera, lejos del cero: el primer "hola" sale porque "nunca" se oyó a la PC. */
    private val reloj = RelojFalso(1_700_000_000_000L)

    /** La red elegida de mentira: anota qué sockets le pidieron atar. */
    private class RedQueAnota : RedLocal {
        val atados = CopyOnWriteArrayList<DatagramSocket>()
        override fun fabricaDeSockets(): SocketFactory? = null
        override fun atar(socket: DatagramSocket) {
            atados += socket
        }
    }

    private fun descubridor(
        anunciarse: Boolean = false,
        red: RedLocal = RedPorDefecto,
        crearSocket: () -> DatagramSocket = { udp },
    ) = DescubridorDeDeteccion(red = red, anunciarse = anunciarse, crearSocket = crearSocket, reloj = reloj::ahora)
        .also { enMarcha += it }

    @After
    fun parar() {
        enMarcha.forEach { it.parar() }
    }

    @Test
    fun `un anuncio valido da la url del enlace con la direccion de la que vino`() {
        val anuncio = DescubridorDeDeteccion.interpretar(
            """{"service":"dronepatrol-detection","port":8765,"name":"notebook-campo"}""",
            host = "192.168.1.40",
            ahoraMs = 1_000,
        )

        assertEquals("ws://192.168.1.40:8765/phone", anuncio?.url)
        assertEquals("notebook-campo", anuncio?.nombre)
        assertEquals(1_000L, anuncio?.recibidoMs)
    }

    @Test
    fun `sin nombre se usa la direccion`() {
        val anuncio = DescubridorDeDeteccion.interpretar("""{"service":"dronepatrol-detection","port":8765}""", "10.0.0.2", 0)

        assertEquals("10.0.0.2", anuncio?.nombre)
    }

    @Test
    fun `otro servicio, un puerto imposible o basura no son anuncios`() {
        assertNull(DescubridorDeDeteccion.interpretar("""{"service":"otra-cosa","port":8765}""", "10.0.0.2", 0))
        assertNull(DescubridorDeDeteccion.interpretar("""{"service":"dronepatrol-detection","port":0}""", "10.0.0.2", 0))
        assertNull(DescubridorDeDeteccion.interpretar("""{"service":"dronepatrol-detection","port":65536}""", "10.0.0.2", 0))
        assertNull(DescubridorDeDeteccion.interpretar("""{"service":"dronepatrol-detection"}""", "10.0.0.2", 0))
        assertNull(DescubridorDeDeteccion.interpretar("hola", "10.0.0.2", 0))
        assertNull(DescubridorDeDeteccion.interpretar("", "10.0.0.2", 0))
    }

    /** Los extremos del rango de puertos son puertos válidos. */
    @Test
    fun `los puertos de los extremos son validos`() {
        assertEquals(1, DescubridorDeDeteccion.interpretar("""{"service":"dronepatrol-detection","port":1}""", "h", 0)?.puerto)
        assertEquals(65535, DescubridorDeDeteccion.interpretar("""{"service":"dronepatrol-detection","port":65535}""", "h", 0)?.puerto)
    }

    /**
     * Escucha el puerto de los anuncios (8766, §4) en todas las interfaces,
     * compartible con otra escucha (dos arranques seguidos no chocan), con
     * broadcast, y atado a la red elegida: con una Wi-Fi sin internet, un
     * socket sin red asignada sale por los datos móviles.
     */
    @Test
    fun `escucha el puerto de los anuncios atado a la red elegida`() {
        val red = RedQueAnota()
        descubridor(red = red).empezar()

        esperarHasta("que el socket se ate a la red") { red.atados.isNotEmpty() }
        assertSame(udp, red.atados.single())
        assertEquals(InetSocketAddress(8766), udp.atadoA)
        assertTrue(udp.reuseAddress)
        assertTrue(udp.broadcast)
        assertEquals("la espera corta es lo que deja parar la escucha", 1_000, udp.soTimeout)
    }

    /**
     * Un anuncio de la laptop se publica con la dirección de la que vino el
     * datagrama: la laptop solo anuncia el puerto.
     */
    @Test
    fun `un anuncio que llega se publica con la direccion de origen`() {
        val d = descubridor()
        d.empezar()

        udp.llega("""{"service":"dronepatrol-detection","port":8765,"name":"notebook-campo"}""", "192.168.1.40")

        esperarHasta("el anuncio") { d.anuncio.value != null }
        val anuncio = d.anuncio.value!!
        assertEquals("ws://192.168.1.40:8765/phone", anuncio.url)
        assertEquals("notebook-campo", anuncio.nombre)
        assertEquals("se fecha con la hora en que llegó", reloj.ms, anuncio.recibidoMs)
        assertNull(d.fallo.value)
    }

    /**
     * En la red llega de todo: basura, el "hola" de otro teléfono, un anuncio
     * con un puerto imposible o un datagrama sin origen se ignoran, y la
     * escucha sigue hasta el anuncio de verdad.
     */
    @Test
    fun `lo que no es un anuncio se ignora y la escucha sigue`() {
        val d = descubridor()
        d.empezar()

        udp.llega("no es json", "10.0.0.2")
        udp.llega(DescubridorDeDeteccion.hola("Otro teléfono"), "10.0.0.3")
        udp.llega("""{"service":"dronepatrol-detection","port":70000,"name":"puerto-roto"}""", "10.0.0.4")
        udp.llega("""{"service":"dronepatrol-detection","port":8765,"name":"sin-origen"}""", null)
        udp.llega("""{"service":"dronepatrol-detection","port":9000,"name":"la-de-verdad"}""", "10.0.0.7")

        esperarHasta("el anuncio de verdad") { d.anuncio.value != null }
        assertEquals("la-de-verdad", d.anuncio.value?.nombre)
        assertEquals("ws://10.0.0.7:9000/phone", d.anuncio.value?.url)
        assertNull(d.fallo.value)
    }

    /**
     * Mientras no oye a la PC, la app se anuncia ella: un "hola" por broadcast
     * al puerto de los anuncios, cada 2 s (§4), con el modelo del teléfono.
     * Uno por intervalo: a los 2 s justos todavía no toca el siguiente.
     */
    @Test
    fun `mientras no oye a la PC se anuncia cada dos segundos`() {
        descubridor(anunciarse = true).empezar()

        esperarHasta("el primer hola") { udp.enviados.isNotEmpty() }
        val primero = udp.enviados.single()
        assertEquals(InetAddress.getByName("255.255.255.255"), primero.destino)
        assertEquals(8766, primero.puerto)
        val hola = JSONObject(primero.texto)
        assertEquals("dronepatrol-app", hola.getString("service"))
        assertEquals(8766, hola.getInt("port"))
        assertEquals(Build.MODEL, hola.getString("name"))

        reloj.adelantar(DescubridorDeDeteccion.INTERVALO_HOLA_MS)
        udp.esperarUnaVueltaEntera()
        assertEquals("a los 2 s justos todavía no", 1, udp.enviados.size)

        reloj.adelantar(1)
        esperarHasta("el segundo hola") { udp.enviados.size == 2 }
        assertEquals(primero.texto, udp.enviados[1].texto)
        udp.esperarUnaVueltaEntera()
        assertEquals("uno solo por intervalo", 2, udp.enviados.size)
    }

    /**
     * Oír a la PC calla el "hola": no hace falta anunciarse mientras llegan sus
     * anuncios, aunque ya haya pasado el intervalo del "hola". Si pasan más de
     * 5 s sin ninguno, la app vuelve a anunciarse.
     */
    @Test
    fun `un anuncio calla el hola hasta que pasan cinco segundos sin anuncios`() {
        val d = descubridor(anunciarse = true)
        d.empezar()
        esperarHasta("el primer hola") { udp.enviados.isNotEmpty() }

        udp.llega("""{"service":"dronepatrol-detection","port":8765}""", "192.168.1.40")
        udp.esperarQueLoProcese()
        assertEquals("el anuncio se fecha con el reloj", reloj.ms, d.anuncio.value?.recibidoMs)

        reloj.adelantar(DescubridorDeDeteccion.SIN_ANUNCIOS_MS)
        udp.esperarUnaVueltaEntera()
        assertEquals("con la PC oída hace 5 s justos no se anuncia", 1, udp.enviados.size)

        reloj.adelantar(1)
        esperarHasta("que vuelva a anunciarse") { udp.enviados.size == 2 }
    }

    /** Sin red el "hola" no sale, pero la escucha sigue esperando el anuncio de la PC. */
    @Test
    fun `un hola que no sale no corta la escucha`() {
        udp.fallaAlMandar = IOException("Network is unreachable")
        val d = descubridor(anunciarse = true)
        d.empezar()

        udp.llega("""{"service":"dronepatrol-detection","port":8765}""", "192.168.1.40")

        esperarHasta("el anuncio") { d.anuncio.value != null }
        assertNull(d.fallo.value)
        assertTrue(udp.enviados.isEmpty())
    }

    /**
     * Si el puerto no se puede abrir, el motivo queda para mostrarlo, la
     * escucha no queda a medias y se puede volver a empezar.
     */
    @Test
    fun `si no puede abrir el puerto lo dice y se puede volver a empezar`() {
        val intentos = AtomicInteger()
        val d = descubridor(
            crearSocket = {
                if (intentos.incrementAndGet() == 1) throw SocketException("Address already in use: bind")
                udp
            },
        )

        d.empezar()
        esperarHasta("el fallo") { d.fallo.value != null }
        assertEquals(
            "No se puede escuchar los anuncios de la detección en el puerto 8766: Address already in use: bind",
            d.fallo.value,
        )

        // La escucha fallida termina sola; en cuanto terminó, se puede volver a empezar
        esperarHasta("poder volver a empezar") {
            d.empezar()
            intentos.get() == 2
        }
        assertNull("al volver a empezar el fallo viejo se borra", d.fallo.value)
        udp.llega("""{"service":"dronepatrol-detection","port":8765}""", "192.168.1.40")
        esperarHasta("el anuncio tras el segundo intento") { d.anuncio.value != null }
        assertEquals(2, intentos.get())
    }

    /** Si la escucha se corta (la red se cae), lo dice y suelta el socket. */
    @Test
    fun `si se corta la escucha lo avisa y suelta el socket`() {
        val d = descubridor()
        d.empezar()

        udp.seCae(IOException("Network is unreachable"))

        esperarHasta("el fallo") { d.fallo.value != null }
        assertEquals("Se cortó la escucha de anuncios de la detección: Network is unreachable", d.fallo.value)
        esperarHasta("que suelte el socket") { udp.isClosed }
    }

    /** Parar suelta el socket y olvida el anuncio, y que la escucha se corte por eso no es un fallo. */
    @Test
    fun `parar suelta el socket, olvida el anuncio y no es un fallo`() {
        val d = descubridor()
        d.empezar()
        udp.llega("""{"service":"dronepatrol-detection","port":8765}""", "192.168.1.40")
        esperarHasta("el anuncio") { d.anuncio.value != null }

        d.parar()

        assertNull(d.anuncio.value)
        // Lo cierra parar() y lo vuelve a cerrar la escucha al terminar
        esperarHasta("que la escucha termine") { udp.cierres.get() >= 2 }
        assertNull(d.fallo.value)
    }

    @Test
    fun `empezar dos veces abre un solo socket`() {
        val sockets = AtomicInteger()
        val d = descubridor(crearSocket = { sockets.incrementAndGet(); udp })

        d.empezar()
        d.empezar()
        esperarHasta("el socket") { sockets.get() == 1 }
        // Una segunda escucha habría pedido su socket al arrancar, mucho antes
        // de que la primera dé dos vueltas
        udp.esperarUnaVueltaEntera()

        assertEquals(1, sockets.get())
    }
}
