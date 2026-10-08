package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.Config
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/** Por dónde llega la app al software de detección que corre en la laptop. */
enum class ModoEnlace {
    /**
     * La laptop se descubre sola en la red Wi-Fi por sus anuncios UDP (ver
     * [DescubridorDeDeteccion]). Es el modo del campo: el puerto USB del
     * teléfono lo ocupa el control, así que el enlace es por red sí o sí.
     */
    AUTO,

    /** Túnel de ADB sobre el cable USB (`adb reverse`). Para el banco de pruebas y el emulador. */
    CABLE,

    /** URL manual contra la IP de la laptop; respaldo si los anuncios no llegan. */
    RED,
}

/**
 * Enlace con el software de detección que corre en la laptop (ver
 * docs/PROTOCOLS.md). Le envía los cuadros de video y recibe las detecciones.
 *
 * `open` por lo mismo que [com.tesis.dronepatrol.comms.CommandCenterClient]: sin
 * socket no se puede ver qué cuadro se le mandó a cada destino, y el banco de
 * pruebas tiene que poder distinguirlos.
 */
open class DetectionClient(
    private val scope: CoroutineScope,
    private val descubridor: DescubridorDeDeteccion = DescubridorDeDeteccion(),
) {

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
    private var escuchaDeAnuncios: Job? = null

    /** URL efectiva del enlace, para mostrarla en la pantalla de configuración. */
    val urlActual: String get() = url

    /**
     * Abre el enlace y lo sostiene reintentando. En [ModoEnlace.CABLE] la URL es
     * fija ([Config.URL_DETECCION_CABLE]); en [ModoEnlace.RED] se usa [urlManual];
     * en [ModoEnlace.AUTO] se espera el anuncio de la laptop y se va a esa
     * dirección. Nunca tira excepción: los problemas quedan en [ultimoFallo].
     * Para cambiar de modo hay que llamar antes a [disconnect].
     */
    fun connect(modo: ModoEnlace, urlManual: String = "") {
        if (wantConnected) return
        this.modo = modo
        if (modo == ModoEnlace.AUTO) {
            wantConnected = true
            url = ""
            ultimoFallo.value = BUSCANDO
            descubridor.empezar()
            escuchaDeAnuncios = scope.launch {
                descubridor.anuncio.filterNotNull().collect { anuncio ->
                    if (anuncio.url != url) {
                        // Otra laptop (o la misma con otra IP): se cambia de destino
                        url = anuncio.url
                        ws?.close(1000, null)
                        ws = null
                        connected.value = false
                        open()
                    }
                }
            }
            scope.launch {
                descubridor.fallo.filterNotNull().collect { if (wantConnected && !connected.value) ultimoFallo.value = it }
            }
            return
        }
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
        escuchaDeAnuncios?.cancel()
        escuchaDeAnuncios = null
        descubridor.parar()
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
            modo == ModoEnlace.AUTO && rechazada ->
                "La laptop se anunció en $url pero no contesta: revisá el firewall de la notebook y que el " +
                    "servidor de detección siga corriendo."
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
            if (wantConnected && url.isNotEmpty()) open()
        }
    }

    /** `open` para poder verificar el cableado del reparto de video (ver la clase). */
    open fun sendFrame(jpegBase64: String) {
        ws?.send(
            JSONObject()
                .put("type", "video_frame")
                .put("jpegBase64", jpegBase64)
                .put("ts", System.currentTimeMillis())
                .toString(),
        )
    }

    companion object {
        /** Lo que se muestra en AUTO mientras no llegó ningún anuncio. */
        const val BUSCANDO = "Buscando el software de detección en la red Wi-Fi… (la laptop tiene que estar en la misma red y con el servidor corriendo)"
    }
}
