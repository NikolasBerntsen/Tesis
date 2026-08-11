package com.tesis.dronepatrol.comms

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

/**
 * Enlace con el software de detección que corre en la laptop (ver
 * docs/PROTOCOLS.md). Le envía los frames de video y recibe las detecciones.
 */
class DetectionClient(private val scope: CoroutineScope) {

    var onDetection: ((classes: List<String>) -> Unit)? = null
    val connected = MutableStateFlow(false)

    private val http = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null
    private var url = ""
    private var wantConnected = false

    fun connect(laptopUrl: String) {
        if (wantConnected) return
        url = laptopUrl.trimEnd('/') + "/phone"
        wantConnected = true
        open()
    }

    fun disconnect() {
        wantConnected = false
        ws?.close(1000, null)
        ws = null
        connected.value = false
    }

    private fun open() {
        ws = http.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    connected.value = true
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
                    reconnect()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    connected.value = false
                    reconnect()
                }
            },
        )
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
