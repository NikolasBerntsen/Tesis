package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.model.Deteccion
import java.io.EOFException
import java.io.IOException
import java.net.ConnectException
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.SocketFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El enlace vivo con el software de detección (docs/PROTOCOLS.md §4): qué
 * hace la app con cada aviso del socket —la apertura, una detección, el cierre
 * que pide el servidor, una caída—, qué le dice al operador cuando se corta
 * según el modo, que se sostenga solo reintentando con la red Wi-Fi del
 * momento, y que los avisos de un socket viejo (la laptop cambió de IP) no
 * toquen al vigente.
 *
 * Nada sale a la red: los WebSocket y el UDP del descubrimiento son de
 * mentira (ver RedFalsa.kt) y el test les hace llegar a mano lo que diría
 * OkHttp. Robolectric por org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DetectionClientEnlaceTest {

    private val alcance = CoroutineScope(SupervisorJob())
    private val sockets = SocketsFalsos()
    private val clientesHttp = CopyOnWriteArrayList<OkHttpClient>()
    private val udp = SocketUdpFalso()
    private val descubridor = DescubridorDeDeteccion(anunciarse = false, crearSocket = { udp })
    private val creados = mutableListOf<DetectionClient>()

    private fun nuevoCliente(red: RedLocal = RedPorDefecto) =
        DetectionClient(alcance, red, descubridor) { http, pedido, oyente ->
            clientesHttp += http
            sockets.newWebSocket(pedido, oyente)
        }.also { creados += it }

    private val cliente = nuevoCliente()

    @After
    fun cortar() {
        creados.forEach { it.disconnect() }
        alcance.cancel()
    }

    /** La red Wi-Fi de mentira: una fábrica de sockets nueva cada vez que se la pide, como si cambiara. */
    private class WifiQueCambia : RedLocal {
        val fabricas = CopyOnWriteArrayList<SocketFactory>()

        override fun fabricaDeSockets(): SocketFactory = FabricaQueNoConecta().also { fabricas += it }
        override fun atar(socket: DatagramSocket) = Unit
    }

    /** Nunca se usa para conectar (el socket es de mentira): solo importa cuál es. */
    private class FabricaQueNoConecta : SocketFactory() {
        override fun createSocket(): Socket = throw IOException("la prueba no conecta")
        override fun createSocket(host: String?, port: Int): Socket = createSocket()
        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = createSocket()
        override fun createSocket(host: InetAddress?, port: Int): Socket = createSocket()
        override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket = createSocket()
    }

    private val unaDeteccion = """{"type":"detection","detected":true,"classes":["PERSON"],"confidence":0.9,"ts":5}"""

    private fun anunciarLaptop(ip: String, nombre: String = "notebook") =
        udp.llega("""{"service":"dronepatrol-detection","port":8765,"name":"$nombre"}""", ip)

    /** Conecta en AUTO y espera el socket que abre el anuncio de la laptop en [ip]. */
    private fun conectadoEnAutoA(ip: String): SocketFalso {
        cliente.connect(ModoEnlace.AUTO)
        anunciarLaptop(ip)
        esperarHasta("el socket a $ip") { sockets.abiertos.size == 1 }
        return sockets.abiertos.single()
    }

    // --- Los avisos del socket vigente --------------------------------------

    @Test
    fun alAbrirseQuedaConectadoYSinFallo() {
        cliente.connect(ModoEnlace.CABLE)
        val socket = sockets.abiertos.single()
        assertFalse("no está conectado hasta que el socket abra", cliente.connected.value)

        socket.abrir()

        assertTrue(cliente.connected.value)
        assertNull(cliente.ultimoFallo.value)
    }

    /**
     * Solo una detección positiva le llega a la app; y si todavía no hay quién
     * la atienda, se pierde: no queda guardada para después.
     */
    @Test
    fun soloLasDeteccionesPositivasLleganAlOyente() {
        cliente.connect(ModoEnlace.CABLE)
        val socket = sockets.abiertos.single()
        socket.abrir()
        socket.oyente.onMessage(socket, unaDeteccion)

        val recibidas = mutableListOf<Deteccion>()
        cliente.onDetection = { recibidas += it }
        socket.oyente.onMessage(socket, """{"type":"detection","detected":false,"classes":[],"ts":6}""")
        socket.oyente.onMessage(socket, "no es json")
        socket.oyente.onMessage(socket, """{"type":"detection","detected":true,"classes":["VEHICLE"],"confidence":0.8,"ts":7}""")

        assertEquals(listOf(listOf("VEHICLE")), recibidas.map { it.clases })
        assertEquals(7L, recibidas.single().ts)
    }

    /** El cierre que pide el servidor se completa: si no, OkHttp deja el socket colgado hasta que vence. */
    @Test
    fun elCierreQuePideElServidorSeCompleta() {
        cliente.connect(ModoEnlace.CABLE)
        val socket = sockets.abiertos.single()

        socket.oyente.onClosing(socket, 1001, "se apaga el servidor")

        assertEquals(1000, socket.codigoDeCierre)
    }

    /** Que el servidor cierre el enlace se avisa con su código, y el enlace se vuelve a intentar. */
    @Test
    fun siElServidorCierraElEnlaceLoDiceYReintenta() {
        cliente.connect(ModoEnlace.CABLE)
        val socket = sockets.abiertos.single()
        socket.abrir()
        val antes = tareasDe(alcance)

        socket.oyente.onClosed(socket, 1011, "error interno")

        assertFalse(cliente.connected.value)
        assertEquals(
            "El software de detección cerró el enlace (código 1011). Fijate que siga corriendo en la laptop.",
            cliente.ultimoFallo.value,
        )
        esperarLasNuevas(alcance, antes)
        assertEquals(2, sockets.abiertos.size)
    }

    // --- Qué se le dice al operador cuando se corta --------------------------

    /** El motivo que queda tras una caída del socket vigente con [error] (y la respuesta del handshake, si hubo). */
    private fun motivoDeLaCaida(error: Throwable, codigoHttp: Int? = null): String {
        val socket = sockets.abiertos.last()
        socket.oyente.onFailure(socket, error, codigoHttp?.let { socket.respuesta(it) })
        assertFalse(cliente.connected.value)
        return cliente.ultimoFallo.value.orEmpty()
    }

    /**
     * En CABLE, que la laptop no conteste es casi siempre el túnel de ADB: el
     * motivo dice qué comando correr.
     */
    @Test
    fun enCableUnaCaidaExplicaElTunelDeAdb() {
        cliente.connect(ModoEnlace.CABLE)
        val adbReverse = "'adb reverse tcp:8765 tcp:8765'"

        for (rechazo in listOf(ConnectException("Connection refused"), SocketTimeoutException("connect timed out"))) {
            val motivo = motivoDeLaCaida(rechazo)
            assertTrue(motivo, motivo.startsWith("La laptop no contesta en ws://127.0.0.1:8765/phone."))
            assertTrue(motivo, motivo.contains("cable USB") && motivo.contains(adbReverse))
        }

        val corte = motivoDeLaCaida(IOException("Connection reset"))
        assertTrue(corte, corte.startsWith("Se cortó el enlace por cable con la detección (Connection reset)."))
        assertTrue(corte, corte.contains(adbReverse))
    }

    /** El detalle técnico sale del código HTTP del handshake, si no del mensaje, y si no del tipo de error. */
    @Test
    fun elDetalleDeLaCaidaEsElMasConcretoQueHaya() {
        cliente.connect(ModoEnlace.CABLE)

        assertTrue(motivoDeLaCaida(IOException("Expected HTTP 101"), codigoHttp = 404).contains("(HTTP 404)"))
        assertTrue(motivoDeLaCaida(EOFException()).contains("(EOFException)"))
        assertTrue(motivoDeLaCaida(IOException("  ")).contains("(IOException)"))
    }

    /** En RED, la URL la tipeó el operador: el motivo le pide revisar la IP y la red. */
    @Test
    fun enRedUnaCaidaPideRevisarLaIpYLaRed() {
        cliente.connect(ModoEnlace.RED, "ws://192.168.1.40:8765")

        val rechazo = motivoDeLaCaida(ConnectException("Connection refused"))
        assertTrue(rechazo, rechazo.startsWith("La laptop no contesta en ws://192.168.1.40:8765/phone."))
        assertTrue(rechazo, rechazo.contains("misma red"))

        assertEquals(
            "Se cortó el enlace con la detección en ws://192.168.1.40:8765/phone (Connection reset).",
            motivoDeLaCaida(IOException("Connection reset")),
        )
    }

    /**
     * En AUTO la laptop se anunció, así que la red llega: si igual no contesta,
     * lo más probable es el firewall de la notebook.
     */
    @Test
    fun enAutoUnaCaidaApuntaAlFirewall() {
        conectadoEnAutoA("192.168.1.40")

        val rechazo = motivoDeLaCaida(ConnectException("Connection refused"))
        assertTrue(rechazo, rechazo.startsWith("La laptop se anunció en ws://192.168.1.40:8765/phone pero no contesta"))
        assertTrue(rechazo, rechazo.contains("firewall"))

        assertEquals(
            "Se cortó el enlace con la detección en ws://192.168.1.40:8765/phone (Connection reset).",
            motivoDeLaCaida(IOException("Connection reset")),
        )
    }

    // --- Reintentos y la red del momento -------------------------------------

    /**
     * Con Wi-Fi, el socket sale por la fábrica de sockets de esa red (con una
     * Wi-Fi sin internet, la red por defecto son los datos móviles). Si se cae,
     * a los 3 s se reintenta a la misma URL, con la red que haya en ESE momento.
     */
    @Test
    fun alCaerseReintentaALosTresSegundosConLaWifiDelMomento() {
        val wifi = WifiQueCambia()
        val conWifi = nuevoCliente(wifi)
        conWifi.connect(ModoEnlace.RED, "ws://192.168.1.40:8765")
        val primero = sockets.abiertos.single()
        assertSame(wifi.fabricas[0], clientesHttp[0].socketFactory)
        assertEquals("el cliente de la red conserva el ping", 15_000, clientesHttp[0].pingIntervalMillis)

        primero.abrir()
        val antes = tareasDe(alcance)
        val caida = System.currentTimeMillis()
        primero.oyente.onFailure(primero, IOException("Software caused connection abort"), null)
        assertEquals("no reintenta en el acto", 1, sockets.abiertos.size)
        esperarLasNuevas(alcance, antes)

        assertTrue("reintentó antes de los 3 s", System.currentTimeMillis() - caida >= 2_900)
        assertEquals(2, sockets.abiertos.size)
        assertEquals(primero.request().url, sockets.abiertos[1].request().url)
        assertSame("la red se vuelve a buscar en cada intento", wifi.fabricas[1], clientesHttp[1].socketFactory)
    }

    /** Sin Wi-Fi cliente (el teléfono hace de hotspot) se usa la red por defecto, sin fábrica propia. */
    @Test
    fun sinWifiSaleConLaRedPorDefecto() {
        cliente.connect(ModoEnlace.CABLE)

        assertSame(SocketFactory.getDefault(), clientesHttp.single().socketFactory)
        assertEquals(15_000, clientesHttp.single().pingIntervalMillis)
    }

    /** Un reintento ya agendado no reabre el enlace si en el medio la app desconectó. */
    @Test
    fun unReintentoPendienteNoReabreTrasDesconectar() {
        cliente.connect(ModoEnlace.CABLE)
        val socket = sockets.abiertos.single()
        val antes = tareasDe(alcance)
        socket.oyente.onFailure(socket, ConnectException("Connection refused"), null)

        cliente.disconnect()
        esperarLasNuevas(alcance, antes)

        assertEquals(1, sockets.abiertos.size)
        assertNull("desconectar borra el fallo", cliente.ultimoFallo.value)
    }

    /**
     * Pasar de CABLE a AUTO con un reintento del cable pendiente: el reintento
     * no reabre la URL del cable (en AUTO todavía no hay URL hasta que la
     * laptop se anuncie).
     */
    @Test
    fun unReintentoDelCableNoSobreviveAlPasarAAuto() {
        cliente.connect(ModoEnlace.CABLE)
        val socket = sockets.abiertos.single()
        val antes = tareasDe(alcance)
        socket.oyente.onFailure(socket, ConnectException("Connection refused"), null)
        val reintento = nuevasDe(alcance, antes)

        cliente.disconnect()
        cliente.connect(ModoEnlace.AUTO)
        esperar(reintento)

        assertEquals(1, sockets.abiertos.size)
        assertEquals("", cliente.urlActual)
    }

    // --- AUTO: la laptop que se anuncia --------------------------------------

    /** El anuncio de la laptop lleva el enlace a `ws://<ip del anuncio>:<port>/phone` (§4). */
    @Test
    fun elAnuncioDeLaLaptopAbreElEnlaceASuDireccion() {
        val socket = conectadoEnAutoA("192.168.1.40")

        assertEquals("ws://192.168.1.40:8765/phone", cliente.urlActual)
        assertEquals("http://192.168.1.40:8765/phone", socket.request().url.toString())
        socket.abrir()
        assertTrue(cliente.connected.value)
        assertNull("el 'buscando' se borra al conectar", cliente.ultimoFallo.value)
    }

    /** La misma laptop anunciándose cada segundo no reabre el enlace. */
    @Test
    fun laMismaLaptopAnunciandoseNoReabreElEnlace() {
        val socket = conectadoEnAutoA("192.168.1.40")
        socket.abrir()

        anunciarLaptop("192.168.1.40", nombre = "otro nombre, misma dirección")
        esperarHasta("el segundo anuncio") { descubridor.anuncio.value?.nombre == "otro nombre, misma dirección" }
        Thread.sleep(200)

        assertEquals(1, sockets.abiertos.size)
        assertNull(socket.codigoDeCierre)
        assertTrue(cliente.connected.value)
    }

    /**
     * Si la laptop aparece en otra dirección, se cierra el socket viejo y se
     * abre uno a la nueva. Los avisos tardíos del viejo (su cierre, una caída,
     * una detección, una apertura) se ignoran: antes marcaban "desconectado" y
     * agendaban un reintento que abría un TERCER socket encima del nuevo.
     */
    @Test
    fun losAvisosDeUnSocketViejoNoTocanAlVigente() {
        val viejo = conectadoEnAutoA("192.168.1.40")
        viejo.abrir()

        anunciarLaptop("192.168.1.41")
        esperarHasta("el socket a la dirección nueva") { sockets.abiertos.size == 2 }
        val nuevo = sockets.abiertos[1]
        assertEquals(1000, viejo.codigoDeCierre)
        assertEquals("ws://192.168.1.41:8765/phone", cliente.urlActual)
        nuevo.abrir()

        val detecciones = mutableListOf<Deteccion>()
        cliente.onDetection = { detecciones += it }
        val antes = tareasDe(alcance)
        viejo.oyente.onClosed(viejo, 1000, "")
        viejo.oyente.onFailure(viejo, IOException("Socket closed"), null)
        viejo.oyente.onMessage(viejo, unaDeteccion)
        esperarLasNuevas(alcance, antes)

        assertTrue("el vigente sigue conectado", cliente.connected.value)
        assertNull(cliente.ultimoFallo.value)
        assertTrue("una detección del socket viejo no cuenta", detecciones.isEmpty())
        assertEquals("ningún reintento por el viejo", 2, sockets.abiertos.size)

        // Y una apertura tardía del viejo no hace pasar por conectado al nuevo caído
        nuevo.oyente.onFailure(nuevo, ConnectException("Connection refused"), null)
        val motivo = cliente.ultimoFallo.value
        viejo.abrir()
        assertFalse(cliente.connected.value)
        assertEquals(motivo, cliente.ultimoFallo.value)
    }

    /**
     * Un reintento agendado para un socket que en el medio fue reemplazado
     * (llegó el anuncio de otra dirección) sobra y no abre nada.
     */
    @Test
    fun unReintentoDeUnSocketReemplazadoNoAbreOtro() {
        val primero = conectadoEnAutoA("192.168.1.40")
        val antes = tareasDe(alcance)
        primero.oyente.onFailure(primero, ConnectException("Connection refused"), null)
        val reintento = nuevasDe(alcance, antes)

        anunciarLaptop("192.168.1.41")
        esperarHasta("el socket a la dirección nueva") { sockets.abiertos.size == 2 }
        esperar(reintento)

        assertEquals(2, sockets.abiertos.size)
    }

    /** Mientras no hay enlace, un problema del descubrimiento es lo que la pantalla tiene que mostrar. */
    @Test
    fun sinEnlaceUnFalloDelDescubrimientoSeMuestra() {
        cliente.connect(ModoEnlace.AUTO)

        udp.seCae(IOException("Network is unreachable"))

        esperarHasta("el fallo en pantalla") { cliente.ultimoFallo.value != DetectionClient.BUSCANDO }
        assertEquals("Se cortó la escucha de anuncios de la detección: Network is unreachable", cliente.ultimoFallo.value)
    }

    /** Con el enlace andando, un problema del descubrimiento no tapa que la detección funciona. */
    @Test
    fun conEnlaceUnFalloDelDescubrimientoNoSeMuestra() {
        val socket = conectadoEnAutoA("192.168.1.40")
        socket.abrir()

        udp.seCae(IOException("Network is unreachable"))
        esperarHasta("el fallo del descubridor") { descubridor.fallo.value != null }
        Thread.sleep(200)

        assertNull(cliente.ultimoFallo.value)
        assertTrue(cliente.connected.value)
    }

    /** Desconectar cierra el enlace, apaga la escucha de anuncios y olvida la laptop. */
    @Test
    fun desconectarCierraElEnlaceYApagaElDescubrimiento() {
        val socket = conectadoEnAutoA("192.168.1.40")
        socket.abrir()

        cliente.disconnect()

        assertEquals(1000, socket.codigoDeCierre)
        assertFalse(cliente.connected.value)
        assertNull(cliente.ultimoFallo.value)
        assertNull(descubridor.anuncio.value)
        assertTrue("la escucha UDP se suelta", udp.isClosed)
    }

    // --- Los cuadros que van a la detección -----------------------------------

    /**
     * `video_frame` con la hora de captura del cuadro (§4): el detector la
     * devuelve como `frameTs` y con ella se busca la pose del dron.
     */
    @Test
    fun elCuadroLlevaLaHoraDeCaptura() {
        cliente.connect(ModoEnlace.CABLE)
        val socket = sockets.abiertos.single()
        socket.abrir()

        cliente.sendFrame("/9j/cuadro", capturaMs = 1_700_000_000_123L)
        val antes = System.currentTimeMillis()
        cliente.sendFrame("/9j/otro")
        val despues = System.currentTimeMillis()

        val (conHora, sinHora) = socket.enviados.map { JSONObject(it) }
        assertEquals(setOf("type", "jpegBase64", "ts"), conHora.keys().asSequence().toSet())
        assertEquals("video_frame", conHora.getString("type"))
        assertEquals("/9j/cuadro", conHora.getString("jpegBase64"))
        assertEquals(1_700_000_000_123L, conHora.getLong("ts"))
        assertTrue("sin hora explícita es la de ahora", sinHora.getLong("ts") in antes..despues)
    }

    /** Sin enlace, un cuadro se pierde sin romper nada (el video no puede frenar el patrullaje). */
    @Test
    fun sinEnlaceElCuadroSePierde() {
        cliente.sendFrame("/9j/cuadro")
        cliente.connect(ModoEnlace.CABLE)
        val socket = sockets.abiertos.single()
        cliente.disconnect()

        cliente.sendFrame("/9j/cuadro")

        assertTrue(socket.enviados.isEmpty())
    }
}
