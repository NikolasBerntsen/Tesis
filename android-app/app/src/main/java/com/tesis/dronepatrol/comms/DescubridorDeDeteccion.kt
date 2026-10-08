package com.tesis.dronepatrol.comms

import android.util.Log
import com.tesis.dronepatrol.Config
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject

/**
 * Encuentra solo al software de detección en la red Wi-Fi. La laptop anuncia
 * cada segundo, por UDP a toda la red ([Config.PUERTO_ANUNCIO_DETECCION]), un
 * JSON `{"service": "dronepatrol-detection", "port": 8765, "name": "..."}`;
 * acá se escucha y se publica el último anuncio con la dirección de la que
 * vino. Así en el campo nadie tipea IPs: con el celular y la notebook en la
 * misma red (el hotspot del celular o la Wi-Fi del lugar) la app engancha sola.
 *
 * Es un hilo y no una corrutina porque `DatagramSocket.receive` bloquea y no
 * hay versión suspendida en la JDK; el tiempo de espera corto es lo que deja
 * que [parar] lo corte.
 */
class DescubridorDeDeteccion(private val puerto: Int = Config.PUERTO_ANUNCIO_DETECCION) {

    /** Un anuncio de la laptop, con la dirección de la que llegó. */
    data class Anuncio(val host: String, val puerto: Int, val nombre: String, val recibidoMs: Long) {
        /** URL del WebSocket del enlace: la laptop solo anuncia el puerto. */
        val url: String get() = "ws://$host:$puerto/phone"
    }

    val anuncio: StateFlow<Anuncio?> get() = _anuncio
    private val _anuncio = MutableStateFlow<Anuncio?>(null)

    /** Motivo por el que no se puede escuchar (el puerto tomado, sin red); null mientras anda. */
    val fallo: StateFlow<String?> get() = _fallo
    private val _fallo = MutableStateFlow<String?>(null)

    @Volatile
    private var vivo = false
    private var hilo: Thread? = null
    private var socket: DatagramSocket? = null

    fun empezar() {
        if (vivo) return
        vivo = true
        _anuncio.value = null
        _fallo.value = null
        hilo = Thread({ escuchar() }, "descubridor-deteccion").apply {
            isDaemon = true
            start()
        }
    }

    fun parar() {
        vivo = false
        runCatching { socket?.close() }
        hilo = null
        _anuncio.value = null
    }

    private fun escuchar() {
        val s = try {
            DatagramSocket(null).apply {
                // Varias apps (o dos arranques seguidos) pueden escuchar el mismo
                // puerto; sin esto el segundo falla con "Address already in use".
                reuseAddress = true
                broadcast = true
                soTimeout = ESPERA_MS
                bind(InetSocketAddress(puerto))
            }
        } catch (e: Exception) {
            _fallo.value = "No se puede escuchar los anuncios de la detección en el puerto $puerto: ${e.message}"
            vivo = false
            return
        }
        socket = s
        val buffer = ByteArray(1024)
        try {
            while (vivo) {
                val paquete = DatagramPacket(buffer, buffer.size)
                try {
                    s.receive(paquete)
                } catch (e: SocketTimeoutException) {
                    continue
                }
                val texto = String(paquete.data, paquete.offset, paquete.length, Charsets.UTF_8)
                val host = paquete.address?.hostAddress ?: continue
                interpretar(texto, host, System.currentTimeMillis())?.let { _anuncio.value = it }
            }
        } catch (e: Exception) {
            if (vivo) {
                Log.w(TAG, "Se cortó la escucha de anuncios", e)
                _fallo.value = "Se cortó la escucha de anuncios de la detección: ${e.message}"
            }
        } finally {
            runCatching { s.close() }
        }
    }

    companion object {
        private const val TAG = "DescubridorDeDeteccion"
        private const val ESPERA_MS = 1_000

        /**
         * Convierte un datagrama en un [Anuncio], o null si no es un anuncio de
         * la detección (en la red puede haber de todo). Va aparte y puro para
         * poder probarlo sin sockets.
         */
        fun interpretar(texto: String, host: String, ahoraMs: Long): Anuncio? {
            val o = runCatching { JSONObject(texto) }.getOrNull() ?: return null
            if (o.optString("service") != Config.SERVICIO_DETECCION) return null
            val puerto = o.optInt("port", 0)
            if (puerto !in 1..65535) return null
            return Anuncio(host, puerto, o.optString("name").ifBlank { host }, ahoraMs)
        }
    }
}
