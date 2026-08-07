package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Waypoint
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

/**
 * Cliente REST + WebSocket contra el Comando Central. Se autentica con JWT
 * (usuario con rol "drone") y reconecta solo si se cae el socket.
 */
class CommandCenterClient(private val scope: CoroutineScope) {

    var onAlertDecision: ((decision: String, decidedBy: String) -> Unit)? = null
    var onResumePatrol: (() -> Unit)? = null
    val connected = MutableStateFlow(false)

    private val http = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private val json = "application/json".toMediaType()

    private var baseUrl = ""
    private var token = ""
    private var ws: WebSocket? = null
    private var wantConnected = false

    suspend fun loginAndConnect(baseUrl: String, username: String, password: String) {
        this.baseUrl = baseUrl.trimEnd('/')
        token = withContext(Dispatchers.IO) {
            val body = JSONObject().put("username", username).put("password", password)
            val res: Response = http.newCall(
                Request.Builder()
                    .url("${this@CommandCenterClient.baseUrl}/api/auth/login")
                    .post(body.toString().toRequestBody(json))
                    .build(),
            ).execute()
            res.use {
                if (!it.isSuccessful) error("Login falló: HTTP ${it.code}")
                JSONObject(it.body!!.string()).getString("token")
            }
        }
        wantConnected = true
        openWebSocket()
    }

    suspend fun fetchRoutes(): List<PatrolRoute> = withContext(Dispatchers.IO) {
        val res = http.newCall(
            Request.Builder()
                .url("$baseUrl/api/routes")
                .header("Authorization", "Bearer $token")
                .build(),
        ).execute()
        res.use {
            if (!it.isSuccessful) error("No se pudieron obtener las rutas: HTTP ${it.code}")
            val arr = JSONArray(it.body!!.string())
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                val wps = o.getJSONArray("waypoints")
                PatrolRoute(
                    id = o.getInt("id"),
                    name = o.getString("name"),
                    waypoints = (0 until wps.length()).map { j ->
                        val w = wps.getJSONObject(j)
                        Waypoint(w.getDouble("lat"), w.getDouble("lon"), w.getDouble("alt"))
                    },
                )
            }
        }
    }

    private fun openWebSocket() {
        val wsUrl = baseUrl.replaceFirst("http", "ws") + "/ws?token=$token"
        ws = http.newWebSocket(
            Request.Builder().url(wsUrl).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    connected.value = true
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
                    when (msg.optString("type")) {
                        "alert_decision" -> onAlertDecision?.invoke(
                            msg.optString("decision"),
                            msg.optString("decidedBy"),
                        )
                        "resume_patrol" -> onResumePatrol?.invoke()
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    connected.value = false
                    scheduleReconnect()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    connected.value = false
                    scheduleReconnect()
                }
            },
        )
    }

    private fun scheduleReconnect() {
        if (!wantConnected) return
        scope.launch {
            delay(3_000)
            if (wantConnected) openWebSocket()
        }
    }

    private fun send(obj: JSONObject) {
        ws?.send(obj.toString())
    }

    fun sendStatus(
        state: String,
        battery: Double,
        lat: Double,
        lon: Double,
        routeId: Int?,
        waypointIndex: Int,
        signalOk: Boolean,
    ) = send(
        JSONObject()
            .put("type", "status")
            .put("state", state)
            .put("battery", battery)
            .put("lat", lat)
            .put("lon", lon)
            .put("routeId", routeId ?: JSONObject.NULL)
            .put("waypointIndex", waypointIndex)
            .put("signal", if (signalOk) "OK" else "LOST"),
    )

    fun sendEvent(eventType: String, message: String) =
        send(JSONObject().put("type", "event").put("eventType", eventType).put("message", message))

    fun sendVideoFrame(jpegBase64: String) =
        send(JSONObject().put("type", "video_frame").put("jpegBase64", jpegBase64).put("ts", System.currentTimeMillis()))

    fun sendAlertRequest(alertType: String, lat: Double, lon: Double, snapshotBase64: String?) =
        send(
            JSONObject()
                .put("type", "alert_request")
                .put("alertType", alertType)
                .put("lat", lat)
                .put("lon", lon)
                .put("snapshotBase64", snapshotBase64 ?: JSONObject.NULL),
        )
}
