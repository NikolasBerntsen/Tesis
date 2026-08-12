package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.model.DroneBase
import com.tesis.dronepatrol.model.DroneProfile
import com.tesis.dronepatrol.model.Emparejamiento
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.SesionOperador
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
 * Cliente REST + WebSocket contra el Comando Central. Lleva un solo JWT por vez:
 * primero el del operador de campo (efímero, para emparejar) y después el del
 * dron, que es con el que se abre el WebSocket. Reconecta solo si se cae el socket.
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

    /**
     * Autentica al operador de campo y guarda su JWT efímero. No abre el
     * WebSocket: eso pasa recién cuando el cliente toma la identidad del dron.
     */
    suspend fun login(baseUrl: String, username: String, password: String): SesionOperador =
        withContext(Dispatchers.IO) {
            this@CommandCenterClient.baseUrl = baseUrl.trim().trimEnd('/')
            val body = JSONObject().put("username", username).put("password", password)
            val res: Response = http.newCall(
                Request.Builder()
                    .url("${this@CommandCenterClient.baseUrl}/api/auth/login")
                    .post(body.toString().toRequestBody(json))
                    .build(),
            ).execute()
            res.use {
                val cuerpo = it.body?.string().orEmpty()
                if (it.code == 401) error(errorDelCuerpo(cuerpo) ?: "Usuario o contraseña incorrectos")
                if (!it.isSuccessful) error(errorDelCuerpo(cuerpo) ?: "El login falló: HTTP ${it.code}")
                val o = JSONObject(cuerpo)
                token = o.getString("token")
                val usuario = o.optJSONObject("user")
                SesionOperador(
                    username = usuario?.optString("username").orEmpty().ifEmpty { username },
                    role = usuario?.optString("role").orEmpty(),
                    expiresIn = o.optLong("expiresIn", 0L),
                )
            }
        }

    /**
     * Empareja el dron del QR con el JWT del operador de campo. La ubicación es
     * opcional: si el operador no dio permiso de GPS el emparejamiento igual
     * procede y el registro queda sin coordenadas.
     */
    suspend fun emparejarDron(
        hash: String,
        lat: Double? = null,
        lon: Double? = null,
        accuracyM: Double? = null,
        deviceModel: String = "",
    ): Emparejamiento = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("hash", hash)
            .put("lat", lat ?: JSONObject.NULL)
            .put("lon", lon ?: JSONObject.NULL)
            .put("accuracyM", accuracyM ?: JSONObject.NULL)
            .put("deviceModel", deviceModel)
        val res = http.newCall(
            Request.Builder()
                .url("$baseUrl/api/drones/pair")
                .header("Authorization", "Bearer $token")
                .post(body.toString().toRequestBody(json))
                .build(),
        ).execute()
        res.use {
            val cuerpo = it.body?.string().orEmpty()
            when {
                it.code == 401 -> error("La sesión del operador de campo venció: iniciá sesión de nuevo")
                it.code == 403 -> error(errorDelCuerpo(cuerpo) ?: "El dron está inactivo o no lo podés emparejar")
                it.code == 404 -> error(errorDelCuerpo(cuerpo) ?: "Ese QR no corresponde a ningún dron registrado")
                !it.isSuccessful -> error(errorDelCuerpo(cuerpo) ?: "El emparejamiento falló: HTTP ${it.code}")
            }
            val o = JSONObject(cuerpo)
            Emparejamiento(token = o.getString("token"), drone = fichaDeDron(o.getJSONObject("drone")))
        }
    }

    /**
     * El cliente pasa a hablar como el dron recién emparejado y descarta el JWT
     * del operador de campo: su sesión efímera termina acá. [baseUrl] vacía deja
     * la que ya estaba.
     */
    fun usarTokenDeDron(token: String, baseUrl: String = "") {
        if (baseUrl.isNotBlank()) this.baseUrl = baseUrl.trim().trimEnd('/')
        this.token = token
    }

    /**
     * Le avisa al Comando Central que la sesión se cierra, para que el cierre
     * quede en el registro con su motivo. Va a la buena de Dios: en el campo la
     * conexión se corta sola, y si el aviso no llega el JWT se descarta igual y
     * la sesión efímera muere por vencimiento.
     */
    private fun avisarCierre(motivo: String) {
        val urlBase = baseUrl
        val jwt = token
        if (urlBase.isEmpty() || jwt.isEmpty()) return
        scope.launch(Dispatchers.IO) {
            runCatching {
                http.newCall(
                    Request.Builder()
                        .url("$urlBase/api/auth/logout")
                        .header("Authorization", "Bearer $jwt")
                        .post(JSONObject().put("motivo", motivo).toString().toRequestBody(json))
                        .build(),
                ).execute().close()
            }
        }
    }

    /**
     * Cierra la sesión: avisa al Comando Central, corta el socket y tira el JWT.
     * Sin [motivo] no se avisa (sirve para descartar una sesión que nunca llegó
     * a abrirse, como la de un rol sin permiso).
     */
    fun cerrarSesion(motivo: String = "") {
        if (motivo.isNotEmpty()) avisarCierre(motivo)
        disconnect()
        token = ""
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

    /** Ficha del dron autenticado: nombre visible, modelo y base a la que vuelve. */
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
            if (o.optString("role") != "drone") error("El token no es de un dron")
            fichaDeDron(o)
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

    /**
     * El dron llega por `hash`, `droneId` o `username` según de dónde venga la
     * ficha (POST /api/drones/pair o GET /api/me): todos son el mismo hash.
     */
    private fun fichaDeDron(o: JSONObject): DroneProfile {
        val base = o.optJSONObject("base")
        return DroneProfile(
            hash = listOf("hash", "droneId", "username")
                .firstNotNullOfOrNull { clave -> o.optString(clave).takeIf { valor -> valor.isNotBlank() } }
                ?: error("La ficha del dron no trae su identificador"),
            displayName = o.optString("displayName"),
            model = o.optString("model"),
            base = base?.let { b -> DroneBase(b.getString("name"), b.getDouble("lat"), b.getDouble("lon")) },
        )
    }

    /** El backend contesta los errores como {"error": "..."}; si no, null. */
    private fun errorDelCuerpo(cuerpo: String): String? =
        runCatching { JSONObject(cuerpo).optString("error").takeIf { it.isNotBlank() } }.getOrNull()

    /** El socket sigue el esquema de la base: si es https, va por wss. */
    private fun urlDelWebSocket(): String {
        val esquema = if (baseUrl.startsWith("http://", ignoreCase = true)) "ws://" else "wss://"
        return esquema + baseUrl.substringAfter("://", baseUrl) + "/ws?token=$token"
    }

    private fun openWebSocket() {
        ws = http.newWebSocket(
            Request.Builder().url(urlDelWebSocket()).build(),
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
