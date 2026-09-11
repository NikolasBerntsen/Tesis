package com.tesis.dronepatrol.patrol

import android.util.Base64
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Telemetry
import kotlin.math.cos
import kotlin.math.sin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Máquina de estados del patrullaje. Toda la lógica de la entrega vive acá:
 *
 *   IDLE → PATROLLING → (detección) → ORBITING → (decisión/reanudar) → PATROLLING
 *                     → (señal perdida) → RETURNING_HOME_SIGNAL → (señal vuelve) → PATROLLING
 *                     → (batería baja)  → RETURNING_HOME_BATTERY → LANDED
 */
class PatrolManager(
    private val controller: DroneController,
    private val commandCenter: CommandCenterClient,
    private val detection: DetectionClient,
    private val scope: CoroutineScope,
    /** Modo elegido tras iniciar sesión: "TEST" o "DEPLOY" (viaja en cada status). */
    private val mode: String,
) {
    private companion object {
        // Sin telemetría durante este tiempo => consideramos perdido el enlace RC
        const val SIGNAL_TIMEOUT_MS = 4_000L
        // Umbral de batería para ordenar el regreso a base
        const val LOW_BATTERY_PCT = 25.0
        const val ORBIT_RADIUS_M = 30.0
        const val METERS_PER_DEG_LAT = 111_320.0

        // PAUSED/MANUAL/FORCED también son vuelo: batería baja y pérdida de
        // señal disparan el RTH igual que patrullando
        val ESTADOS_EN_VUELO = setOf(
            PatrolState.PATROLLING,
            PatrolState.ORBITING,
            PatrolState.PAUSED,
            PatrolState.MANUAL,
            PatrolState.FORCED,
        )
        // Estados desde los que un resume_patrol retoma la ruta activa
        val ESTADOS_REANUDABLES = setOf(
            PatrolState.ORBITING,
            PatrolState.RETURNING_HOME_SIGNAL,
            PatrolState.PAUSED,
            PatrolState.MANUAL,
            PatrolState.FORCED,
        )
    }

    private val _state = MutableStateFlow(PatrolState.IDLE)
    val state: StateFlow<PatrolState> = _state

    private val _signalOk = MutableStateFlow(true)
    val signalOk: StateFlow<Boolean> = _signalOk

    /** Intensidad del enlace RC 0..100; 0 mientras la señal está perdida. */
    private val _signalPct = MutableStateFlow(100)
    val signalPct: StateFlow<Int> = _signalPct

    private val _localLog = MutableSharedFlow<String>(replay = 20, extraBufferCapacity = 16)
    val localLog: SharedFlow<String> = _localLog

    /** Rutas descargadas del Comando Central (para resolver start_route/force_goto por id). */
    var availableRoutes: List<PatrolRoute> = emptyList()

    private var route: PatrolRoute? = null
    private var lastReachedWaypoint = 0
    private var resumeWaypoint = 0
    /** Nodo del desvío forzado en curso (solo para el mensaje de llegada). */
    private var forcedIndex = 0
    private var lastTelemetry: Telemetry? = null
    private var lastTelemetryAt = 0L
    private var lastFrame: ByteArray? = null

    private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch { controller.telemetry.collect { onTelemetry(it) } }
        scope.launch { controller.flightEvents.collect { onFlightEvent(it) } }
        scope.launch {
            controller.videoFrames.collect { frame ->
                lastFrame = frame
                val b64 = Base64.encodeToString(frame, Base64.NO_WRAP)
                detection.sendFrame(b64)
                commandCenter.sendVideoFrame(b64)
            }
        }
        detection.onDetection = { classes -> scope.launch { onDetection(classes) } }
        commandCenter.onAlertDecision = { decision, decidedBy ->
            scope.launch { onAlertDecision(decision, decidedBy) }
        }
        commandCenter.onResumePatrol = { fromIndex ->
            scope.launch { resumePatrol("orden del operador", fromIndex) }
        }
        commandCenter.onStartRoute = { routeId, fromIndex, orderedBy ->
            scope.launch { onStartRoute(routeId, fromIndex, orderedBy) }
        }
        commandCenter.onStopPatrol = { orderedBy -> scope.launch { onStopPatrol(orderedBy) } }
        commandCenter.onForceGoto = { routeId, index, orderedBy ->
            scope.launch { onForceGoto(routeId, index, orderedBy) }
        }
        commandCenter.onControlTaken = { by -> scope.launch { onControlTaken(by) } }
        commandCenter.onManualMove = { bearing, distanceM, by ->
            scope.launch { onManualMove(bearing, distanceM, by) }
        }
        commandCenter.onControlReleased = { by -> scope.launch { onControlReleased(by) } }
        scope.launch { signalWatchdog() }
        scope.launch { statusTicker() }
    }

    fun startPatrol(route: PatrolRoute) {
        this.route = route
        lastReachedWaypoint = 0
        resumeWaypoint = 0
        controller.startRoute(route, 0)
        _state.value = PatrolState.PATROLLING
        report("PATROL_STARTED", "Patrullaje iniciado en ruta \"${route.name}\"")
    }

    // ---- Órdenes del Comando Central ----

    /** Busca la ruta entre las descargadas; si no está, re-consulta al Comando Central. */
    private suspend fun buscarRuta(routeId: Int): PatrolRoute? {
        availableRoutes.firstOrNull { it.id == routeId }?.let { return it }
        runCatching { commandCenter.fetchRoutes() }.getOrNull()?.let { availableRoutes = it }
        return availableRoutes.firstOrNull { it.id == routeId }
    }

    private suspend fun onStartRoute(routeId: Int, fromIndex: Int, orderedBy: String) {
        val r = buscarRuta(routeId) ?: run {
            log("Se ordenó patrullar la ruta $routeId pero no existe: se ignora")
            return
        }
        val desde = fromIndex.coerceIn(0, r.waypoints.size - 1)
        route = r
        lastReachedWaypoint = desde
        resumeWaypoint = desde
        controller.startRoute(r, desde)
        _state.value = PatrolState.PATROLLING
        report("PATROL_STARTED", "Patrullaje iniciado en ruta \"${r.name}\" desde el nodo ${desde + 1} (orden de $orderedBy)")
    }

    private fun onStopPatrol(orderedBy: String) {
        if (_state.value !in ESTADOS_EN_VUELO || _state.value == PatrolState.PAUSED) return
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = lastReachedWaypoint
        controller.hold()
        _state.value = PatrolState.PAUSED
        report("PATROL_STOPPED", "Patrullaje interrumpido por $orderedBy: el dron queda en vuelo estacionario")
    }

    private suspend fun onForceGoto(routeId: Int, index: Int, orderedBy: String) {
        val wp = buscarRuta(routeId)?.waypoints?.getOrNull(index) ?: run {
            log("Se ordenó desviar al nodo ${index + 1} de la ruta $routeId pero no existe: se ignora")
            return
        }
        // Ojo: no se pisa resumeWaypoint, así un resume posterior retoma el
        // patrullaje normal desde el último nodo recorrido
        forcedIndex = index
        controller.gotoPoint(wp.lat, wp.lon)
        _state.value = PatrolState.FORCED
        report("FORCED_GOTO", "Desvío forzado hacia el nodo ${index + 1} (orden de $orderedBy)")
    }

    private fun onControlTaken(by: String) {
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = lastReachedWaypoint
        controller.hold()
        _state.value = PatrolState.MANUAL
        // Solo log local: el Comando Central ya registra su propio CONTROL_TAKEN
        log("$by tomó el control manual del dron")
    }

    private fun onManualMove(bearing: Double, distanceM: Double, by: String) {
        if (_state.value != PatrolState.MANUAL) return
        val t = lastTelemetry ?: return
        val rad = Math.toRadians(bearing)
        val dLat = distanceM * cos(rad) / METERS_PER_DEG_LAT
        val dLon = distanceM * sin(rad) / (METERS_PER_DEG_LAT * cos(Math.toRadians(t.lat)))
        controller.gotoPoint(t.lat + dLat, t.lon + dLon)
        log("Movimiento manual de $by: ${distanceM.toInt()} m con rumbo ${bearing.toInt()}°")
    }

    private fun onControlReleased(by: String) {
        if (_state.value != PatrolState.MANUAL) return
        controller.hold()
        // Si a continuación llega un resume_patrol, ese handler lo pone a patrullar
        _state.value = PatrolState.PAUSED
        log("$by liberó el control manual del dron")
    }

    // ---- Detección de pérdida de señal ----
    // El enlace dron↔RC se considera perdido cuando la telemetría deja de llegar
    // por más de SIGNAL_TIMEOUT_MS. El dron real inicia su RTH failsafe por su
    // cuenta; acá reflejamos ese estado y avisamos al Comando Central (el celular
    // sigue online: lo que se cortó es el enlace de radio con el dron).
    private suspend fun signalWatchdog() {
        while (true) {
            delay(1_000)
            val flying = _state.value in ESTADOS_EN_VUELO
            val silent = lastTelemetryAt > 0 && System.currentTimeMillis() - lastTelemetryAt > SIGNAL_TIMEOUT_MS
            if (flying && silent) {
                _signalOk.value = false
                _signalPct.value = 0
                resumeWaypoint = lastReachedWaypoint
                _state.value = PatrolState.RETURNING_HOME_SIGNAL
                report("SIGNAL_LOST", "Se perdió la señal con el dron (sin telemetría hace ${SIGNAL_TIMEOUT_MS / 1000} s)")
                report("RTH_SIGNAL_LOSS", "El dron vuelve a la base por pérdida de señal (failsafe RTH)")
            }
        }
    }

    private suspend fun onTelemetry(t: Telemetry) {
        val recovering = _state.value == PatrolState.RETURNING_HOME_SIGNAL
        lastTelemetry = t
        lastTelemetryAt = System.currentTimeMillis()
        _signalOk.value = true
        _signalPct.value = t.signalPct

        if (recovering) {
            // Requisito: al recuperar la señal, el patrullaje continúa donde quedó
            report("SIGNAL_RECOVERED", "Señal con el dron recuperada")
            resumePatrol("señal recuperada")
            return
        }
        checkLowBattery(t)
    }

    // ---- Detección de batería baja ----
    // Si la batería cae del umbral en pleno vuelo, se ordena RTH y se avisa al
    // Comando Central. No hay reanudación automática: hace falta cambiar batería.
    private suspend fun checkLowBattery(t: Telemetry) {
        val flying = _state.value in ESTADOS_EN_VUELO
        if (flying && t.batteryPct <= LOW_BATTERY_PCT) {
            _state.value = PatrolState.RETURNING_HOME_BATTERY
            controller.returnHome()
            report("RTH_LOW_BATTERY", "Batería al ${t.batteryPct.toInt()}%: el dron vuelve a la base")
        }
    }

    /**
     * Se cambió/recargó la batería. Si el dron había aterrizado por batería baja,
     * vuelve a quedar disponible para arrancar un patrullaje.
     */
    fun onBatteryRecharged() {
        if (_state.value == PatrolState.LANDED) _state.value = PatrolState.IDLE
        report("BATTERY_RECHARGED", "Batería recargada al 100%: el dron queda listo para volar")
    }

    private suspend fun onFlightEvent(e: FlightEvent) {
        when (e) {
            is FlightEvent.WaypointReached -> lastReachedWaypoint = e.index
            is FlightEvent.ArrivedHome -> {
                if (_state.value == PatrolState.RETURNING_HOME_BATTERY) {
                    _state.value = PatrolState.LANDED
                    report("LANDED", "Dron aterrizado en base (batería baja)")
                }
            }
            is FlightEvent.GotoArrived -> {
                if (_state.value == PatrolState.FORCED) {
                    report("GOTO_ARRIVED", "El dron llegó al nodo ${forcedIndex + 1} y queda en vuelo estacionario")
                }
            }
        }
    }

    /** Solo reacciona a detecciones mientras patrulla (evita re-alertar en órbita o RTH). */
    private suspend fun onDetection(classes: List<String>) {
        if (_state.value != PatrolState.PATROLLING) return
        val t = lastTelemetry ?: return
        val alertType = if (classes.contains("VEHICLE")) "VEHICLE" else "PERSON"

        resumeWaypoint = lastReachedWaypoint
        // Simplificación del MVP: se orbita la posición actual del dron (el
        // objetivo está dentro del campo visual). Georreferenciar la detección
        // queda para la etapa del software de visión.
        controller.startOrbit(t.lat, t.lon, ORBIT_RADIUS_M)
        _state.value = PatrolState.ORBITING
        report("ORBIT_STARTED", "Detección de $alertType: el dron pasa a modo órbita")

        val snapshot = lastFrame?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
        commandCenter.sendAlertRequest(alertType, t.lat, t.lon, snapshot)
    }

    private suspend fun onAlertDecision(decision: String, decidedBy: String) {
        if (_state.value != PatrolState.ORBITING) return
        if (decision == "DISMISSED") {
            // Falso positivo: el dron retoma su ruta donde la dejó
            resumePatrol("alerta descartada por $decidedBy")
        } else {
            // Alerta real: se mantiene la órbita sobre el objetivo hasta que el
            // operador ordene reanudar desde la consola
            log("Alerta VALIDADA por $decidedBy: se mantiene la órbita")
        }
    }

    private suspend fun resumePatrol(reason: String, fromIndex: Int? = null) {
        val r = route ?: return
        if (_state.value !in ESTADOS_REANUDABLES) return
        val desde = (fromIndex ?: resumeWaypoint).coerceIn(0, r.waypoints.size - 1)
        resumeWaypoint = desde
        lastReachedWaypoint = desde
        controller.startRoute(r, desde)
        _state.value = PatrolState.PATROLLING
        report("PATROL_RESUMED", "Patrullaje reanudado desde el nodo ${desde + 1} ($reason)")
    }

    private suspend fun statusTicker() {
        while (true) {
            delay(1_000)
            val t = lastTelemetry ?: continue
            commandCenter.sendStatus(
                state = _state.value.name,
                battery = t.batteryPct,
                lat = t.lat,
                lon = t.lon,
                routeId = route?.id,
                waypointIndex = lastReachedWaypoint,
                waypointTotal = route?.waypoints?.size ?: 0,
                signalOk = _signalOk.value,
                signalPct = _signalPct.value,
                heading = t.heading,
                mode = mode,
            )
        }
    }

    /** Registra en el log local y lo reporta como evento al Comando Central. */
    private fun report(eventType: String, message: String) {
        log(message)
        commandCenter.sendEvent(eventType, message)
    }

    private fun log(message: String) {
        _localLog.tryEmit(message)
    }
}
