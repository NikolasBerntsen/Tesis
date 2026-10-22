package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.Config
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A dónde apunta el enlace con la detección, que es lo que decide si el modo
 * CABLE del contrato funciona. No hay laptop del otro lado y nada sale a la
 * red: los sockets son de mentira (ver RedFalsa.kt) y acá se mira la URL
 * efectiva, el socket que se pidió y el motivo del fallo.
 */
class DetectionClientTest {

    private val alcance = CoroutineScope(SupervisorJob())
    private val sockets = SocketsFalsos()

    // Sin "hola" y con un UDP de mentira: la prueba corre en la PC de
    // desarrollo, y el broadcast saldría a la LAN de verdad
    private val cliente = DetectionClient(
        alcance,
        descubridor = DescubridorDeDeteccion(anunciarse = false, crearSocket = { SocketUdpFalso() }),
    ) { _, pedido, oyente -> sockets.newWebSocket(pedido, oyente) }

    @After
    fun cortar() {
        cliente.disconnect()
        alcance.cancel()
    }

    @Test
    fun enCableVaAlTunelDeAdbReverse() {
        cliente.connect(ModoEnlace.CABLE)

        assertEquals("ws://127.0.0.1:8765/phone", cliente.urlActual)
        assertEquals(Config.URL_DETECCION_CABLE, cliente.urlActual)
        // OkHttp guarda la URL del WebSocket con su esquema HTTP equivalente
        assertEquals("http://127.0.0.1:8765/phone", sockets.abiertos.single().request().url.toString())
    }

    /** En CABLE la URL es fija: lo que haya quedado escrito para el modo RED no cuenta. */
    @Test
    fun enCableIgnoraLaUrlManual() {
        cliente.connect(ModoEnlace.CABLE, "ws://192.168.42.129:8765")

        assertEquals(Config.URL_DETECCION_CABLE, cliente.urlActual)
    }

    @Test
    fun enRedUsaLaUrlManualYLeAgregaElPath() {
        cliente.connect(ModoEnlace.RED, "ws://127.0.0.1:8766")

        assertEquals("ws://127.0.0.1:8766/phone", cliente.urlActual)
    }

    @Test
    fun enRedNoDuplicaElPathNiLaBarraFinal() {
        cliente.connect(ModoEnlace.RED, "  ws://127.0.0.1:8766/phone/  ")

        assertEquals("ws://127.0.0.1:8766/phone", cliente.urlActual)
    }

    @Test
    fun enRedSinUrlAvisaEnVezDeConectar() {
        cliente.connect(ModoEnlace.RED)

        assertEquals("", cliente.urlActual)
        assertFalse(cliente.connected.value)
        assertTrue(cliente.ultimoFallo.value.orEmpty().contains(Config.PLANTILLA_URL_DETECCION_RED))
        assertTrue("sin URL no se abre nada", sockets.abiertos.isEmpty())
    }

    @Test
    fun conUnaUrlInvalidaExplicaElProblemaSinTirarExcepcion() {
        cliente.connect(ModoEnlace.RED, "la ip de la laptop")

        assertFalse(cliente.connected.value)
        assertTrue(cliente.ultimoFallo.value.orEmpty().contains("no es válida"))
        assertTrue(sockets.abiertos.isEmpty())
    }

    /** Una URL inválida no deja el enlace "queriendo conectarse": se puede corregir y volver a conectar sin desconectar. */
    @Test
    fun trasUnaUrlInvalidaSePuedeConectarConOtra() {
        cliente.connect(ModoEnlace.RED, "la ip de la laptop")

        cliente.connect(ModoEnlace.RED, "ws://192.168.1.40:8765")

        assertEquals("ws://192.168.1.40:8765/phone", cliente.urlActual)
        assertEquals(1, sockets.abiertos.size)
    }

    /** Para cambiar de modo hay que desconectar primero; si no, sigue el enlace en curso. */
    @Test
    fun cambiarDeModoExigeDesconectarAntes() {
        cliente.connect(ModoEnlace.CABLE)
        cliente.connect(ModoEnlace.RED, "ws://127.0.0.1:8766")
        assertEquals(Config.URL_DETECCION_CABLE, cliente.urlActual)

        cliente.disconnect()
        cliente.connect(ModoEnlace.RED, "ws://127.0.0.1:8766")
        assertEquals("ws://127.0.0.1:8766/phone", cliente.urlActual)
    }

    /**
     * En AUTO no hay URL hasta que la laptop se anuncie: mientras tanto la app
     * dice que está buscando, que no es lo mismo que un fallo.
     */
    @Test
    fun enAutoEsperaElAnuncioDeLaLaptopYLoDice() {
        cliente.connect(ModoEnlace.AUTO)

        assertEquals("", cliente.urlActual)
        assertFalse(cliente.connected.value)
        assertEquals(DetectionClient.BUSCANDO, cliente.ultimoFallo.value)
        assertTrue(sockets.abiertos.isEmpty())
    }

    @Test
    fun desconectarBorraElUltimoFallo() {
        cliente.connect(ModoEnlace.RED)
        assertNotNull(cliente.ultimoFallo.value)

        cliente.disconnect()
        assertNull(cliente.ultimoFallo.value)
    }
}
