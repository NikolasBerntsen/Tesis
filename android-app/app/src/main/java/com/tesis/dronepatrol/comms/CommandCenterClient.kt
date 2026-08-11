package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.model.DroneBase
import com.tesis.dronepatrol.model.DroneProfile
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
    /** Reanudar el patrullaje; [fromIndex] nulo = desde el último nodo alcanzado. */
    var onResumePatrol: ((fromIndex: Int?) -> Unit)? = null
    var onStartRoute: ((routeId: Int, fromIndex: Int, orderedBy: String) -> Unit)? = null
    var onStopPatrol: ((orderedBy: String) -> Unit)? = null
    var onForceGoto: ((routeId: Int, index: Int, orderedBy: String) -> Unit)? = null
    var onControlTaken: ((by: String) -> Unit)? = null
    var onManualMove: ((bearing: Double, distanceM: Double, by: String) -> Unit)? = null
    var onControlReleased: ((by: String) -> Unit)? = null
    /** El Comando Central renombró al dron. */
    var onRenamed: ((displayName: String) -> Unit)? = null
    val connected = MutableStateFlow(false)

    private val http = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private val json = "application/json".toMediaType()

    private var baseUrl = ""
    private var token = ""
    private var ws: WebSocket? = null
    private var wantConnected = false

    /** Solo autentica y guarda el JWT; el WebSocket se abre aparte con [connect]. */
    suspend fun login(baseUrl: String, username: String, password: String) {
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
                if (it.code == 401) error("Usuario o contraseña incorrectos")
                if (!it.isSuccessful) error("Login falló: HTTP ${it.code}")
                JSONObject(it.body!!.string()).getString("token")
            }
        }
    }

    fun connect() {
        if (wantConnected) return
        wantConnected = true
        openWebSocket()
    }

    fun disconnect() {
        wantConnected = false
        ws?.close(1000, null)
        ws = null
        connected.value = false
    }

    /** Ficha del dron autenticado: nombre visible y base a la que vuelve. */
    suspend fun fetchProfile(): DroneProfile = withContext(Dispatchers.IO) {
        val res = http.newCall(
            Request.Builder()
                .url("$baseUrl/api/me")
                .header("Authorization", "Bearer $token")
                .build(),
        ).execute()
        res.use {
            if (!it.isSuccessful) error("No se pudo leer la ficha del dron: HTTP ${it.code}")
            val o = JSONObject(it.body!!.string())
            if (o.optString("role") != "drone") error("La cuenta no es de un dron")
            val base = o.optJSONObject("base")
            DroneProfile(
                droneId = o.getString("droneId"),
                displayName = o.getString("displayName"),
                base = base?.let { b -> DroneBase(b.getString("name"), b.getDouble("lat"), b.getDouble("lon")) },
            )
        }
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
                        "resume_patrol" -> onResumePatrol?.invoke(
                            if (msg.isNull("fromIndex")) null else msg.optInt("fromIndex"),
                        )
                        "start_route" -> onStartRoute?.invoke(
                            msg.optInt("routeId"),
                            msg.optInt("fromIndex"),
                            msg.optString("orderedBy"),
                        )
                        "stop_patrol" -> onStopPatrol?.invoke(msg.optString("orderedBy"))
                        "force_goto" -> onForceGoto?.invoke(
                            msg.optInt("routeId"),
                            msg.optInt("index"),
                            msg.optString("orderedBy"),
                        )
                        "control_taken" -> onControlTaken?.invoke(msg.optString("by"))
                        "manual_move" -> onManualMove?.invoke(
                            msg.optDouble("bearing"),
                            msg.optDouble("distanceM"),
                            msg.optString("by"),
                        )
                        "control_released" -> onControlReleased?.invoke(msg.optString("by"))
                        "renamed" -> onRenamed?.invoke(msg.optString("displayName"))
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
        waypointTotal: Int,
        signalOk: Boolean,
        signalPct: Int,
        heading: Double,
        mode: String,
    ) = send(
        JSONObject()
            .put("type", "status")
            .put("state", state)
            .put("battery", battery)
            .put("lat", lat)
            .put("lon", lon)
            .put("routeId", routeId ?: JSONObject.NULL)
            .put("waypointIndex", waypointIndex)
            .put("waypointTotal", waypointTotal)
            .put("signal", if (signalOk) "OK" else "LOST")
            .put("signalPct", signalPct)
            .put("heading", heading)
            .put("mode", mode),
    )

    fun sendSetName(displayName: String) =
        send(JSONObject().put("type", "set_name").put("displayName", displayName))

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
