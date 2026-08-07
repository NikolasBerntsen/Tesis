package com.tesis.dronepatrol.patrol

import android.util.Base64
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Telemetry
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
) {
    private companion object {
        // Sin telemetría durante este tiempo => consideramos perdido el enlace RC
        const val SIGNAL_TIMEOUT_MS = 4_000L
        // Umbral de batería para ordenar el regreso a base
        const val LOW_BATTERY_PCT = 25.0
        const val ORBIT_RADIUS_M = 30.0
    }

    private val _state = MutableStateFlow(PatrolState.IDLE)
    val state: StateFlow<PatrolState> = _state

    private val _signalOk = MutableStateFlow(true)
    val signalOk: StateFlow<Boolean> = _signalOk

    private val _localLog = MutableSharedFlow<String>(replay = 20, extraBufferCapacity = 16)
    val localLog: SharedFlow<String> = _localLog

    private var route: PatrolRoute? = null
    private var lastReachedWaypoint = 0
    private var resumeWaypoint = 0
    private var lastTelemetry: Telemetry? = null
    private var lastTelemetryAt = 0L
    private var lastFrame: ByteArray? = null

    fun start() {
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
        commandCenter.onResumePatrol = { scope.launch { resumePatrol("orden del operador") } }
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

    // ---- Detección de pérdida de señal ----
    // El enlace dron↔RC se considera perdido cuando la telemetría deja de llegar
    // por más de SIGNAL_TIMEOUT_MS. El dron real inicia su RTH failsafe por su
    // cuenta; acá reflejamos ese estado y avisamos al Comando Central (el celular
    // sigue online: lo que se cortó es el enlace de radio con el dron).
    private suspend fun signalWatchdog() {
        while (true) {
            delay(1_000)
            val flying = _state.value == PatrolState.PATROLLING || _state.value == PatrolState.ORBITING
            val silent = lastTelemetryAt > 0 && System.currentTimeMillis() - lastTelemetryAt > SIGNAL_TIMEOUT_MS
            if (flying && silent) {
                _signalOk.value = false
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
        val flying = _state.value == PatrolState.PATROLLING || _state.value == PatrolState.ORBITING
        if (flying && t.batteryPct <= LOW_BATTERY_PCT) {
            _state.value = PatrolState.RETURNING_HOME_BATTERY
            controller.returnHome()
            report("RTH_LOW_BATTERY", "Batería al ${t.batteryPct.toInt()}%: el dron vuelve a la base")
        }
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

    private suspend fun resumePatrol(reason: String) {
        val r = route ?: return
        if (_state.value != PatrolState.ORBITING && _state.value != PatrolState.RETURNING_HOME_SIGNAL) return
        controller.startRoute(r, resumeWaypoint)
        _state.value = PatrolState.PATROLLING
        report("PATROL_RESUMED", "Patrullaje reanudado desde waypoint $resumeWaypoint ($reason)")
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
                signalOk = _signalOk.value,
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
