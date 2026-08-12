package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.Config
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/** Por dónde llega la app al software de detección que corre en la laptop. */
enum class ModoEnlace {
    /** Túnel de ADB sobre el cable USB. Es el recomendado: no depende de la red. */
    CABLE,

    /** URL manual contra la IP de la laptop; respaldo si no hay depuración USB. */
    RED,
}

/**
 * Enlace con el software de detección que corre en la laptop (ver
 * docs/PROTOCOLS.md). Le envía los frames de video y recibe las detecciones.
 */
class DetectionClient(private val scope: CoroutineScope) {

    var onDetection: ((classes: List<String>) -> Unit)? = null
    val connected = MutableStateFlow(false)

    /**
     * Motivo del último fallo, redactado para el operador; null mientras el
     * enlace anda. Un error mudo en el campo no le avisa a nadie que falta
     * correr 'adb reverse' en la laptop.
     */
    val ultimoFallo = MutableStateFlow<String?>(null)

    private val http = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null
    private var url = ""
    private var modo = ModoEnlace.CABLE
    private var wantConnected = false

    /** URL efectiva del enlace, para mostrarla en la pantalla de configuración. */
    val urlActual: String get() = url

    /**
     * Abre el enlace y lo sostiene reintentando. En [ModoEnlace.CABLE] la URL es
     * fija ([Config.URL_DETECCION_CABLE]); en [ModoEnlace.RED] se usa [urlManual].
     * Nunca tira excepción: los problemas quedan en [ultimoFallo]. Para cambiar
     * de modo hay que llamar antes a [disconnect].
     */
    fun connect(modo: ModoEnlace, urlManual: String = "") {
        if (wantConnected) return
        this.modo = modo
        val destino = if (modo == ModoEnlace.CABLE) Config.URL_DETECCION_CABLE else conPath(urlManual)
        if (destino.isEmpty()) {
            ultimoFallo.value =
                "Falta la URL del software de detección (por ejemplo ${Config.PLANTILLA_URL_DETECCION_RED})."
            return
        }
        url = destino
        wantConnected = true
        ultimoFallo.value = null
        open()
    }

    fun disconnect() {
        wantConnected = false
        ws?.close(1000, null)
        ws = null
        connected.value = false
        ultimoFallo.value = null
    }

    private fun open() {
        val pedido = runCatching { Request.Builder().url(url).build() }.getOrElse {
            wantConnected = false
            ultimoFallo.value =
                "La dirección '$url' no es válida: escribila como ${Config.PLANTILLA_URL_DETECCION_RED}."
            return
        }
        ws = http.newWebSocket(
            pedido,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    connected.value = true
                    ultimoFallo.value = null
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
                    if (msg.optString("type") == "detection" && msg.optBoolean("detected")) {
                        val arr = msg.optJSONArray("classes")
                        val classes = if (arr == null) emptyList() else (0 until arr.length()).map { arr.getString(it) }
                        onDetection?.invoke(classes)
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    connected.value = false
                    ultimoFallo.value = motivo(t, response)
                    reconnect()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    connected.value = false
                    if (wantConnected) {
                        ultimoFallo.value =
                            "El software de detección cerró el enlace (código $code). Fijate que siga corriendo en la laptop."
                    }
                    reconnect()
                }
            },
        )
    }

    /** Traduce el error de red a algo que el operador pueda ir a resolver. */
    private fun motivo(t: Throwable, response: Response?): String {
        val detalle = response?.let { "HTTP ${it.code}" }
            ?: t.message?.takeIf { it.isNotBlank() }
            ?: t.javaClass.simpleName
        val adbReverse = "adb reverse tcp:${Config.PUERTO_DETECCION} tcp:${Config.PUERTO_DETECCION}"
        val rechazada = t is ConnectException || t is SocketTimeoutException
        return when {
            modo == ModoEnlace.CABLE && rechazada ->
                "La laptop no contesta en $url. Revisá que el cable USB esté enchufado, que la depuración " +
                    "USB esté activada y que en la laptop hayas corrido '$adbReverse'."
            modo == ModoEnlace.CABLE ->
                "Se cortó el enlace por cable con la detección ($detalle). Revisá el cable USB y volvé a " +
                    "correr '$adbReverse' en la laptop."
            rechazada ->
                "La laptop no contesta en $url. Revisá que esa sea su IP, que el celular esté en la misma " +
                    "red y que el software de detección esté corriendo."
            else -> "Se cortó el enlace con la detección en $url ($detalle)."
        }
    }

    /** El contrato del enlace vive en el path /phone (ver docs/PROTOCOLS.md). */
    private fun conPath(urlManual: String): String {
        val limpia = urlManual.trim().trimEnd('/')
        return when {
            limpia.isEmpty() -> ""
            limpia.endsWith("/phone") -> limpia
            else -> "$limpia/phone"
        }
    }

    private fun reconnect() {
        if (!wantConnected) return
        scope.launch {
            delay(3_000)
            if (wantConnected) open()
        }
    }

    fun sendFrame(jpegBase64: String) {
        ws?.send(
            JSONObject()
                .put("type", "video_frame")
                .put("jpegBase64", jpegBase64)
                .put("ts", System.currentTimeMillis())
                .toString(),
        )
    }
}
