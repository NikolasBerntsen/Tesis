package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.model.DroneBase
import com.tesis.dronepatrol.model.DroneProfile
import com.tesis.dronepatrol.model.Emparejamiento
import com.tesis.dronepatrol.model.ObjetivoReportado
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
 *
 * `open` por una sola razón: sin socket abierto, todo lo que esta clase manda cae
 * al vacío y no hay forma de ver qué se le pidió. El banco de pruebas necesita
 * distinguir lo que va al Comando Central de lo que va a la detección —dar vuelta
 * los dos destinos del video es un defecto que CI no veía— y para eso hereda y
 * pisa el envío.
 *
 * Por lo mismo son `open` [connect] y [fetchRoutes]: la pantalla de operación
 * abre el socket y baja las rutas apenas se crea, y su banco de pruebas los
 * reemplaza para no salir a la red (ver MainActivity.crearComandoCentral).
 */
open class CommandCenterClient(
    private val scope: CoroutineScope,
    /**
     * El cliente del REST y, salvo que se pase otro, el del WebSocket. Es
     * parámetro solo para las pruebas: con un interceptor que contesta en lugar
     * del servidor se ve el pedido exacto (ruta, JWT, cuerpo) sin salir a la
     * red. La app usa siempre el de por defecto.
     */
    private val http: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .build(),
    /**
     * Quién abre el WebSocket; por defecto, [http]. Parámetro por lo mismo: un
     * interceptor no alcanza para abrir un socket sin servidor del otro lado, y
     * las pruebas necesitan hacerle llegar a mano la apertura, los mensajes y
     * las caídas para ver la reconexión.
     */
    private val abrirSocket: WebSocket.Factory = http,
) {

    /**
     * Decisión del operador sobre una alerta. [alertId] es null solo si el
     * mensaje no lo trae (un hub viejo): PatrolManager aplica la decisión
     * únicamente si es la alerta del objetivo en curso.
     */
    var onAlertDecision: ((alertId: Long?, decision: String, decidedBy: String, reenvio: Boolean) -> Unit)? = null

    /** El hub registró la alerta pedida con [ref] y le dio este id (ver sendAlertRequest). */
    var onAlertAck: ((ref: String, alertId: Long) -> Unit)? = null

    /** Despegue en el lugar pedido desde la consola por el titular del control. */
    var onTakeoff: ((by: String) -> Unit)? = null

    /** Aterrizaje pedido desde la consola por el titular del control. */
    var onLand: ((by: String) -> Unit)? = null
    /** Reanudar el patrullaje; [fromIndex] nulo = desde el último nodo alcanzado. */
    var onResumePatrol: ((fromIndex: Int?) -> Unit)? = null
    var onStartRoute: ((routeId: Int, fromIndex: Int, orderedBy: String) -> Unit)? = null
    var onStopPatrol: ((orderedBy: String) -> Unit)? = null
    var onForceGoto: ((routeId: Int, index: Int, orderedBy: String) -> Unit)? = null
    var onControlTaken: ((by: String) -> Unit)? = null
    var onManualMove: ((bearing: Double, distanceM: Double, by: String) -> Unit)? = null

    /**
     * Mando virtual: los cuatro ejes en [-1, 1] tal como los manda la consola,
     * a unos 10 por segundo mientras el operador tiene la palanca tomada.
     */
    var onManualStick: ((pitch: Double, roll: Double, yaw: Double, throttle: Double, by: String) -> Unit)? = null

    /**
     * Inclinación ABSOLUTA de la cámara en grados (0 horizonte, negativo hacia
     * abajo), tal como la manda la consola: hasta 10 por segundo mientras el
     * operador la arrastra. Siempre llega un número finito (ver manejarMensaje).
     */
    var onManualGimbal: ((pitch: Double, by: String) -> Unit)? = null
    var onControlReleased: ((by: String) -> Unit)? = null
    /** El Comando Central renombró al dron. */
    var onRenamed: ((displayName: String) -> Unit)? = null
    val connected = MutableStateFlow(false)

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

    open fun connect() {
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

    /**
     * Rutas del dron autenticado. `open` por lo mismo que [send]: PatrolManager
     * la vuelve a consultar cuando la consola ordena una ruta que la app no
     * tiene descargada (una que se creó después de abrir la sesión), y sin un
     * Comando Central de verdad el banco de pruebas no tiene otra forma de
     * contestarle esa segunda consulta.
     */
    open suspend fun fetchRoutes(): List<PatrolRoute> = withContext(Dispatchers.IO) {
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
        ws = abrirSocket.newWebSocket(
            Request.Builder().url(urlDelWebSocket()).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    connected.value = true
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    manejarMensaje(text)
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

    /**
     * Traduce un mensaje del Comando Central a la orden que le corresponde.
     *
     * Vive afuera del WebSocketListener para poder probarlo sin levantar un
     * socket: es el ÚNICO lugar donde el JSON del protocolo se convierte en los
     * argumentos que recibe la app, y confundir dos nombres acá manda el dron
     * para el lado equivocado sin que nada se queje.
     */
    internal fun manejarMensaje(text: String) {
        val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (msg.optString("type")) {
            "alert_decision" -> onAlertDecision?.invoke(
                if (msg.has("alertId") && !msg.isNull("alertId")) msg.optLong("alertId") else null,
                msg.optString("decision"),
                msg.optString("decidedBy"),
                // El hub reenvía las decisiones recientes al reconectarse el dron
                msg.optBoolean("resent", false),
            )
            // Sin ref o sin id no hay nada que asociar: se ignora.
            "alert_ack" -> {
                val ref = msg.optString("ref")
                val id = msg.optLong("alertId", -1L)
                if (ref.isNotEmpty() && id >= 0) onAlertAck?.invoke(ref, id)
            }
            "takeoff" -> onTakeoff?.invoke(msg.optString("by"))
            "land" -> onLand?.invoke(msg.optString("by"))
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
            // Los ejes ausentes valen 0 y no NaN (que es lo que devuelve
            // optDouble sin defecto): un NaN metido en una velocidad sería una
            // orden sin sentido para el dron.
            "manual_stick" -> onManualStick?.invoke(
                msg.optDouble("pitch", 0.0),
                msg.optDouble("roll", 0.0),
                msg.optDouble("yaw", 0.0),
                msg.optDouble("throttle", 0.0),
                msg.optString("by"),
            )
            "manual_gimbal" -> inclinacionPedida(msg.opt("pitch"))?.let { pitch ->
                onManualGimbal?.invoke(pitch, msg.optString("by"))
            }
            "control_released" -> onControlReleased?.invoke(msg.optString("by"))
            "renamed" -> onRenamed?.invoke(msg.optString("displayName"))
        }
    }

    /**
     * La inclinación de un `manual_gimbal` a partir del `pitch` tal como vino en
     * el JSON, o null si no es un número finito.
     *
     * A diferencia de un eje del mando, acá un valor ausente NO vale cero: el
     * cero de la cámara es el horizonte, una orden concreta que nadie dio, y el
     * mensaje entero se descarta. Se exige que sea un número del JSON y no se usa
     * optDouble a secas porque ese convierte el texto ("-30") —el hub ya lo
     * descarta, y la app no tiene por qué ser más permisiva que él— y devuelve
     * NaN si falta, que metido en el gimbal es una orden sin sentido.
     *
     * Recibe el valor suelto y no el mensaje porque org.json no deja entrar un
     * NaN ni un infinito al parsear: el control de "finito" no depende de ese
     * detalle de la librería, y así se puede probar.
     */
    internal fun inclinacionPedida(valor: Any?): Double? {
        val grados = (valor as? Number)?.toDouble() ?: return null
        return grados.takeIf { it.isFinite() }
    }

    private fun scheduleReconnect() {
        if (!wantConnected) return
        scope.launch {
            delay(3_000)
            if (wantConnected) openWebSocket()
        }
    }

    /**
     * Lo que sale por el socket. `protected open` para que el banco de pruebas
     * vea el JSON exacto de cada mensaje (los nombres del contrato son lo que
     * hay que verificar), sin levantar un socket.
     */
    protected open fun send(obj: JSONObject) {
        ws?.send(obj.toString())
    }

    /**
     * Estado del dron, una vez por segundo. Sin GPS [lat]/[lon] llegan en NaN y
     * salen como null con `gpsFix: false` (docs/PROTOCOLS.md §1): el status
     * tiene que salir igual, porque es lo único que le dice a la consola si el
     * dron vuela, cuánta batería tiene y si ya entró en control manual.
     *
     * Ningún número sale como NaN o infinito: org.json los rechaza con una
     * excepción, y en el lazo del status eso es la app cerrándose en pleno vuelo.
     */
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
        /** Altura sobre el punto de despegue, en metros. */
        altM: Double = 0.0,
        /** Satélites GPS en uso; 0 si el dron no lo informa. */
        satellites: Int = 0,
        /** true con el dron en el aire (motores encendidos y despegado). */
        flying: Boolean = false,
        /** Modo de vuelo que informa la aeronave; vacío si no lo informa. */
        flightMode: String = "",
        /** El objetivo que se orbita o se sigue; null si no hay. */
        target: ObjetivoReportado? = null,
        /**
         * Inclinación actual de la cámara en grados (0 horizonte, −90 nadir); NaN
         * si el dron todavía no la informó, y entonces el campo no sale: la
         * consola sabe qué suponer cuando falta, y no hay que inventarle un valor.
         */
        gimbalPitch: Double = Double.NaN,
    ) {
        val gpsFix = lat.isFinite() && lon.isFinite()
        send(
            JSONObject()
                .put("type", "status")
                .put("state", state)
                .put("battery", numero(battery))
                .put("lat", if (gpsFix) lat else JSONObject.NULL)
                .put("lon", if (gpsFix) lon else JSONObject.NULL)
                .put("gpsFix", gpsFix)
                .put("routeId", routeId ?: JSONObject.NULL)
                .put("waypointIndex", waypointIndex)
                .put("waypointTotal", waypointTotal)
                .put("signal", if (signalOk) "OK" else "LOST")
                .put("signalPct", signalPct)
                .put("heading", numero(heading))
                .put("mode", mode)
                .put("alt", numero(altM))
                .put("satellites", satellites)
                .put("flying", flying)
                .put("flightMode", flightMode)
                // Opcional en el contrato (§1): ausente y no null, que es como lo
                // manda una app vieja y lo que la consola ya sabe interpretar.
                .apply { if (gimbalPitch.isFinite()) put("gimbalPitch", gimbalPitch) }
                .put("target", target?.let(::objetivoEnJson) ?: JSONObject.NULL),
        )
    }

    /** El objetivo con los nombres del contrato (§1, `target`). */
    internal fun objetivoEnJson(o: ObjetivoReportado): JSONObject = JSONObject()
        .put("alertId", o.alertId ?: JSONObject.NULL)
        .put("type", o.tipo)
        .put("lat", numero(o.lat))
        .put("lon", numero(o.lon))
        .put("speedMs", numero(o.velocidadMs))
        .put("courseDeg", numero(o.rumboGrados))
        .put("moving", o.enMovimiento)
        .put("lost", o.perdido)
        .put("lastSeenMs", o.vistoHaceMs)
        .put("decision", o.decision)

    /** Un número para el JSON, o null si no es finito (org.json no acepta NaN). */
    private fun numero(valor: Double): Any = if (valor.isFinite()) valor else JSONObject.NULL

    fun sendSetName(displayName: String) =
        send(JSONObject().put("type", "set_name").put("displayName", displayName))

    /**
     * Un evento para el registro. Los de seguimiento llevan el [alertId] de su
     * alerta (el hub encadena la fila a ella) y la posición del OBJETIVO, que
     * es la que queda en el registro para el equipo de tierra.
     */
    fun sendEvent(eventType: String, message: String, alertId: Long? = null, lat: Double? = null, lon: Double? = null) {
        val o = JSONObject().put("type", "event").put("eventType", eventType).put("message", message)
        if (alertId != null) o.put("alertId", alertId)
        if (lat != null && lon != null && lat.isFinite() && lon.isFinite()) o.put("lat", lat).put("lon", lon)
        send(o)
    }

    /** `open` para poder verificar el cableado del reparto de video (ver la clase). */
    open fun sendVideoFrame(jpegBase64: String) =
        send(JSONObject().put("type", "video_frame").put("jpegBase64", jpegBase64).put("ts", System.currentTimeMillis()))

    /**
     * `open` para que el banco de pruebas vea qué captura y qué posición se
     * mandan: la alerta tiene que llevar el cuadro anotado que disparó la
     * detección y el lugar del objetivo, no el último cuadro y el dron.
     */
    open fun sendAlertRequest(
        alertType: String,
        lat: Double,
        lon: Double,
        snapshotBase64: String?,
        confidence: Double = 0.0,
        classes: List<String> = listOf(alertType),
        /** Identificador propio: vuelve en el `alert_ack` con el id de la alerta. */
        ref: String? = null,
        /** Pose del dron cuando se detectó: queda en el registro de la alerta. */
        droneLat: Double = Double.NaN,
        droneLon: Double = Double.NaN,
        droneAlt: Double = Double.NaN,
    ) = send(
        JSONObject()
            .put("type", "alert_request")
            .put("alertType", alertType)
            .put("lat", numero(lat))
            .put("lon", numero(lon))
            .put("snapshotBase64", snapshotBase64 ?: JSONObject.NULL)
            .put("confidence", numero(confidence))
            .put("classes", JSONArray(classes))
            .put("ref", ref ?: JSONObject.NULL)
            .put("droneLat", numero(droneLat))
            .put("droneLon", numero(droneLon))
            .put("droneAlt", numero(droneAlt)),
    )
}
