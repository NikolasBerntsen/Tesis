package com.tesis.dronepatrol.comms

import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El WebSocket con el Comando Central (docs/PROTOCOLS.md §1): a qué URL se
 * abre, con qué token, y que se sostenga solo —si se cae, a los 3 s vuelve a
 * abrirse— salvo que la app lo haya cerrado a propósito. Los sockets son de
 * mentira: el test les hace llegar a mano lo que diría OkHttp.
 *
 * Robolectric por org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CommandCenterClientSocketTest {

    private val alcance = CoroutineScope(SupervisorJob())
    private val sockets = SocketsFalsos()
    private val cliente = CommandCenterClient(alcance, ServidorFalso().http, sockets)

    @After
    fun cortar() {
        cliente.disconnect()
        alcance.cancel()
    }

    private fun conectado(): SocketFalso {
        cliente.usarTokenDeDron("jwt-dron", "http://central.test:4000/")
        cliente.connect()
        return sockets.abiertos.single()
    }

    /**
     * `ws://<backend>:4000/ws?token=<JWT>` con el JWT del dron (§1). OkHttp
     * guarda las URL de WebSocket con su esquema HTTP equivalente (ws → http,
     * wss → https), así que es eso lo que se mira.
     */
    @Test
    fun conectarAbreElSocketDelDronConSuToken() {
        val socket = conectado()

        val url = socket.request().url
        assertEquals("http", url.scheme)
        assertEquals("central.test", url.host)
        assertEquals(4000, url.port)
        assertEquals("/ws", url.encodedPath)
        assertEquals("jwt-dron", url.queryParameter("token"))
        assertFalse("no está conectado hasta que el socket abra", cliente.connected.value)
    }

    /** Con el Comando Central detrás de HTTPS el socket va cifrado (wss). */
    @Test
    fun conHttpsElSocketVaPorWss() {
        cliente.usarTokenDeDron("jwt-dron", "https://central.test")
        cliente.connect()

        val url = sockets.abiertos.single().request().url
        assertEquals("https", url.scheme)
        assertEquals("/ws", url.encodedPath)
    }

    /** Una URL sin esquema no se manda en claro: por defecto va cifrado. */
    @Test
    fun sinEsquemaElSocketVaCifrado() {
        cliente.usarTokenDeDron("jwt-dron", "central.test")
        cliente.connect()

        val url = sockets.abiertos.single().request().url
        assertEquals("https", url.scheme)
        assertEquals("central.test", url.host)
    }

    @Test
    fun conectarDosVecesNoAbreDosSockets() {
        conectado()
        cliente.connect()

        assertEquals(1, sockets.abiertos.size)
    }

    /** Abierto el socket queda conectado, y cada mensaje que llega es una orden para la app. */
    @Test
    fun alAbrirQuedaConectadoYLosMensajesSonOrdenes() {
        val socket = conectado()
        val despegues = mutableListOf<String>()
        cliente.onTakeoff = { por -> despegues += por }

        socket.abrir()
        socket.oyente.onMessage(socket, """{"type":"takeoff","by":"ana"}""")

        assertTrue(cliente.connected.value)
        assertEquals(listOf("ana"), despegues)
    }

    /**
     * Si el socket se cae (falla o lo cierra el servidor), el cliente queda
     * desconectado y lo vuelve a abrir solo, a la misma URL, después de 3 s:
     * ni en el acto, que sería martillar al servidor, ni nunca.
     */
    @Test
    fun siSeCaeElSocketVuelveAAbrirloALosTresSegundos() {
        val primero = conectado()
        primero.abrir()
        val antes = tareasDe(alcance)
        val caida = System.currentTimeMillis()

        primero.oyente.onFailure(primero, IOException("se cortó"), null)

        assertFalse(cliente.connected.value)
        assertEquals("no reabre en el acto", 1, sockets.abiertos.size)
        esperarLasNuevas(alcance, antes)
        assertTrue("reabrió antes de los 3 s", System.currentTimeMillis() - caida >= 2_900)
        assertEquals(2, sockets.abiertos.size)
        val segundo = sockets.abiertos[1]
        assertEquals(primero.request().url, segundo.request().url)

        // Un cierre del lado del servidor también se reintenta
        segundo.abrir()
        val antesDelCierre = tareasDe(alcance)
        segundo.oyente.onClosed(segundo, 1001, "reinicio")
        assertFalse(cliente.connected.value)
        esperarLasNuevas(alcance, antesDelCierre)
        assertEquals(3, sockets.abiertos.size)
    }

    /** Desconectar cierra el socket normalmente y no deja un reintento vivo. */
    @Test
    fun desconectarCierraElSocketYNoReintenta() {
        val socket = conectado()
        socket.abrir()
        val antes = tareasDe(alcance)

        cliente.disconnect()
        // El cierre que pidió la app vuelve como onClosed: no es una caída
        socket.oyente.onClosed(socket, 1000, "")
        esperarLasNuevas(alcance, antes)

        assertEquals(1000, socket.codigoDeCierre)
        assertFalse(cliente.connected.value)
        assertEquals(1, sockets.abiertos.size)
    }

    /** Un reintento ya agendado no reabre el socket si en el medio la app desconectó. */
    @Test
    fun unReintentoPendienteNoReabreTrasDesconectar() {
        val socket = conectado()
        val antes = tareasDe(alcance)
        socket.oyente.onFailure(socket, IOException("se cortó"), null)

        cliente.disconnect()
        esperarLasNuevas(alcance, antes)

        assertEquals(1, sockets.abiertos.size)
    }

    /** Cerrar la sesión también corta el socket. */
    @Test
    fun cerrarLaSesionCortaElSocket() {
        val socket = conectado()
        socket.abrir()

        cliente.cerrarSesion()

        assertEquals(1000, socket.codigoDeCierre)
        assertFalse(cliente.connected.value)
    }

    /** Lo que la app manda sale por el socket abierto, como texto JSON. */
    @Test
    fun loQueSeMandaSalePorElSocket() {
        val socket = conectado()
        socket.abrir()

        cliente.sendSetName("Alfa")

        val enviado = JSONObject(socket.enviados.single())
        assertEquals("set_name", enviado.getString("type"))
        assertEquals("Alfa", enviado.getString("displayName"))
    }

    /** Sin socket (antes de conectar o ya desconectado) lo que se manda se pierde sin romper nada. */
    @Test
    fun sinSocketLoQueSeMandaSePierde() {
        cliente.sendSetName("Antes")
        val socket = conectado()
        cliente.disconnect()

        cliente.sendSetName("Después")

        assertTrue(socket.enviados.isEmpty())
    }
}
