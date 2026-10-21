package com.tesis.dronepatrol.comms

import android.os.Build
import android.util.Log
import com.tesis.dronepatrol.Config
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
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
 *
 * El descubrimiento es de ida y vuelta: mientras no llega ningún anuncio, la
 * app también se anuncia ("hola", cada [INTERVALO_HOLA_MS]) por broadcast al
 * mismo puerto, y el servidor le contesta por unicast. El broadcast de la PC se
 * pierde fácil —Windows lo manda por una sola interfaz, una VPN se lo lleva, el
 * router no lo reenvía—, y la respuesta unicast al teléfono llega igual.
 */
class DescubridorDeDeteccion(
    private val puerto: Int = Config.PUERTO_ANUNCIO_DETECCION,
    /** Por qué red escuchar y anunciarse (ver [RedLocal]). */
    private val red: RedLocal = RedPorDefecto,
    /**
     * Si la app se anuncia ("hola"). Las pruebas lo apagan: corren en la PC de
     * desarrollo y sus broadcasts llegaban a la LAN de verdad, donde un servidor
     * de detección abierto los tomaba por un teléfono.
     */
    private val anunciarse: Boolean = true,
) {

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
            }.also { red.atar(it) }
        } catch (e: Exception) {
            _fallo.value = "No se puede escuchar los anuncios de la detección en el puerto $puerto: ${e.message}"
            vivo = false
            return
        }
        socket = s
        val buffer = ByteArray(1024)
        var ultimoAnuncioMs = 0L
        var ultimoHolaMs = 0L
        try {
            while (vivo) {
                val ahora = System.currentTimeMillis()
                // Mientras no se oye a la PC, la app se anuncia ella.
                if (anunciarse && ahora - ultimoAnuncioMs > SIN_ANUNCIOS_MS && ahora - ultimoHolaMs > INTERVALO_HOLA_MS) {
                    ultimoHolaMs = ahora
                    mandarHola(s)
                }
                val paquete = DatagramPacket(buffer, buffer.size)
                try {
                    s.receive(paquete)
                } catch (e: SocketTimeoutException) {
                    continue
                }
                val texto = String(paquete.data, paquete.offset, paquete.length, Charsets.UTF_8)
                val host = paquete.address?.hostAddress ?: continue
                interpretar(texto, host, System.currentTimeMillis())?.let {
                    ultimoAnuncioMs = it.recibidoMs
                    _anuncio.value = it
                }
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

    /**
     * El "hola" de la app. Un fallo al mandarlo no corta la escucha: sin red
     * no sale, y la escucha sigue esperando el anuncio de la PC.
     */
    private fun mandarHola(s: DatagramSocket) {
        runCatching {
            val datos = hola(Build.MODEL ?: "telefono").toByteArray(Charsets.UTF_8)
            s.send(DatagramPacket(datos, datos.size, InetAddress.getByName("255.255.255.255"), puerto))
        }.onFailure { Log.d(TAG, "No salió el anuncio de la app: ${it.message}") }
    }

    companion object {
        private const val TAG = "DescubridorDeDeteccion"
        private const val ESPERA_MS = 1_000

        /** Cada cuánto se anuncia la app mientras no oye a la PC. */
        const val INTERVALO_HOLA_MS = 2_000L

        /** Sin anuncios de la PC durante esto, la app vuelve a anunciarse. */
        const val SIN_ANUNCIOS_MS = 5_000L

        /** El servicio con el que se anuncia la app (contrato §4). */
        const val SERVICIO_APP = "dronepatrol-app"

        /** El JSON del "hola" de la app. */
        fun hola(nombre: String): String =
            JSONObject().put("service", SERVICIO_APP).put("port", Config.PUERTO_ANUNCIO_DETECCION).put("name", nombre).toString()

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
