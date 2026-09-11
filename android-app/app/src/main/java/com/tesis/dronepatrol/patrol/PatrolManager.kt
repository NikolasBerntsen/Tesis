package com.tesis.dronepatrol.patrol

import android.util.Base64
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.drone.MandoVirtual
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
    // internal y no private: el banco de pruebas necesita el límite exacto del
    // watchdog y el reparto de cuadros, que adentro de un lazo con reloj propio
    // no hay forma de pararse a mirar.
    internal companion object {
        // Sin telemetría durante este tiempo => consideramos perdido el enlace RC
        const val SIGNAL_TIMEOUT_MS = 4_000L
        // Umbral de batería para ordenar el regreso a base
        const val LOW_BATTERY_PCT = 25.0
        const val ORBIT_RADIUS_M = 30.0
        const val METERS_PER_DEG_LAT = 111_320.0
        // Al software de detección se le manda uno de cada tantos cuadros; al
        // Comando Central le va todo lo que emite el controlador (ver
        // repartirVideo(), que explica por qué se cuentan cuadros y no
        // milisegundos).
        const val UNO_DE_CADA_N_A_DETECCION = 2
        // Estando en MANUAL, sin órdenes de mando por más de este tiempo la app
        // manda ceros por su cuenta (ver mandoWatchdog()).
        const val MANDO_TIMEOUT_MS = 1_500L
        const val REVISION_MANDO_MS = 250L

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

        /**
         * Decide si el watchdog del mando tiene que mandar ceros. Es una función
         * aparte, sin reloj propio, para poder probar el límite exacto de los
         * [MANDO_TIMEOUT_MS]: adentro del lazo el tiempo lo pone
         * System.currentTimeMillis() y no hay forma de pararse en el borde.
         *
         * [ultimoMandoMs] en 0 significa "todavía no llegó ningún mando desde
         * que se tomó el control": no hay velocidad que cortar, y sin esta
         * guarda la resta contra el epoch daría un número enorme y el watchdog
         * saltaría de prepo apenas alguien toma el control. Y si el último mando
         * ya dejaba al dron quieto ([estacionario]) tampoco hay nada que
         * corregir.
         */
        internal fun hayQueCortarElMando(ahoraMs: Long, ultimoMandoMs: Long, estacionario: Boolean): Boolean {
            if (ultimoMandoMs == 0L || estacionario) return false
            return ahoraMs - ultimoMandoMs > MANDO_TIMEOUT_MS
        }
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

    /**
     * Momento del último `manual_stick`; 0 = ninguno desde que se tomó el
     * control. Lo escribe el hilo del WebSocket y lo lee el watchdog del mando,
     * que corre en otra corrutina: de ahí el volátil.
     */
    @Volatile
    private var ultimoMandoMs = 0L

    /** Si el último mando recibido ya dejaba al dron quieto, no hay nada que cortar. */
    @Volatile
    private var ultimoMandoEstacionario = true

    /**
     * true desde que el operador toma el control manual hasta que lo suelta,
     * pase lo que pase con el estado en el medio. Es lo que arma el watchdog del
     * mando: atarlo a `_state == MANUAL` lo apagaba justo en la transición que
     * lo necesita (ver mandoWatchdog()).
     *
     * Lo escriben el hilo del WebSocket y las corrutinas de los watchdogs: de
     * ahí el volátil.
     */
    @Volatile
    private var controlTomado = false

    /**
     * true mientras corre un desplazamiento puntual pedido con `manual_move`.
     * Se apaga sola al llegar (FlightEvent.GotoArrived) y la usa onManualStick()
     * para no dejar que el mensaje de cierre de la palanca aborte el salto.
     */
    @Volatile
    private var saltoManualEnCurso = false

    private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch { controller.telemetry.collect { onTelemetry(it) } }
        scope.launch { controller.flightEvents.collect { onFlightEvent(it) } }
        // Los dos destinos van por nombre: si alguna vez se dan vuelta, el
        // cambio se ve acá y no queda escondido adentro del reparto.
        scope.launch {
            repartirVideo(
                alComandoCentral = { cuadro -> commandCenter.sendVideoFrame(cuadro) },
                aLaDeteccion = { cuadro -> detection.sendFrame(cuadro) },
            )
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
        // A diferencia del resto de las órdenes, esta no se lanza en una
        // corrutina: llegan diez por segundo y no hace nada que pueda bloquear,
        // así que abrir una corrutina por mensaje sería puro costo.
        commandCenter.onManualStick = { pitch, roll, yaw, throttle, _ ->
            onManualStick(pitch, roll, yaw, throttle)
        }
        commandCenter.onControlReleased = { by -> scope.launch { onControlReleased(by) } }
        scope.launch { signalWatchdog() }
        scope.launch { mandoWatchdog() }
        scope.launch { statusTicker() }
    }

    /**
     * Reparto del video. El Comando Central recibe TODOS los cuadros que emite
     * el controlador —5 por segundo, tanto con el dron real como con el
     * simulado ([com.tesis.dronepatrol.drone.CuadroDeVideo.INTERVALO_CUADRO_MS])—:
     * es el video que mira el operador y con el que decide. Al software de
     * detección se le manda uno de cada [UNO_DE_CADA_N_A_DETECCION], o sea
     * **2,5 cuadros por segundo**: el enlace con la laptop es el más flojo de
     * los tres y detectar una persona o un vehículo no necesita más.
     *
     * Se cuentan CUADROS y no milisegundos a propósito. El flujo que llega acá
     * ya viene raleado a 200 ms, así que un limitador de tiempo solo puede
     * aceptar en múltiplos de esos 200 ms: pedirle 500 ms daba 600 (1,67 fps) y
     * cualquier temblor en la entrega lo corría a 700 (1,43 fps). Contando sale
     * un ritmo exacto, estable y explicable — 2,5 fps, la mitad de 5— y no hay
     * un borde en el que un cuadro entero se pierda por un milisegundo.
     *
     * Los dos destinos llegan por parámetro para poder probar el reparto sin
     * sockets: quién recibe qué es justamente lo que hay que verificar.
     */
    internal suspend fun repartirVideo(
        alComandoCentral: (String) -> Unit,
        aLaDeteccion: (String) -> Unit,
    ) {
        var cuadrosVistos = 0
        controller.videoFrames.collect { frame ->
            lastFrame = frame
            val b64 = Base64.encodeToString(frame, Base64.NO_WRAP)
            alComandoCentral(b64)
            if (cuadrosVistos % UNO_DE_CADA_N_A_DETECCION == 0) aLaDeteccion(b64)
            cuadrosVistos++
        }
    }

    fun startPatrol(route: PatrolRoute) {
        this.route = route
        lastReachedWaypoint = 0
        resumeWaypoint = 0
        controller.startRoute(route, 0)
        pasarA(PatrolState.PATROLLING)
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
        pasarA(PatrolState.PATROLLING)
        report("PATROL_STARTED", "Patrullaje iniciado en ruta \"${r.name}\" desde el nodo ${desde + 1} (orden de $orderedBy)")
    }

    private fun onStopPatrol(orderedBy: String) {
        if (_state.value !in ESTADOS_EN_VUELO || _state.value == PatrolState.PAUSED) return
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = lastReachedWaypoint
        // Primero el estado y después la orden, como en pasarA(): si no, un
        // mando que viene en camino se cuela entre las dos y lo vuelve a mover.
        pasarA(PatrolState.PAUSED)
        controller.hold()
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
        pasarA(PatrolState.FORCED)
        report("FORCED_GOTO", "Desvío forzado hacia el nodo ${index + 1} (orden de $orderedBy)")
    }

    private fun onControlTaken(by: String) {
        if (_state.value == PatrolState.PATROLLING) resumeWaypoint = lastReachedWaypoint
        controller.hold()
        // Arranca sin mando previo: el watchdog no tiene que arrastrar lo que
        // haya quedado de la vez anterior que alguien tomó el control.
        ultimoMandoMs = 0L
        ultimoMandoEstacionario = true
        saltoManualEnCurso = false
        controlTomado = true
        pasarA(PatrolState.MANUAL)
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
        // Queda marcado hasta que llegue (FlightEvent.GotoArrived): mientras
        // tanto, el mensaje de cierre de la palanca no lo puede abandonar a
        // mitad de camino (ver onManualStick()).
        saltoManualEnCurso = true
        log("Movimiento manual de $by: ${distanceM.toInt()} m con rumbo ${bearing.toInt()}°")
    }

    /**
     * Mando virtual del operador. Solo se aplica en [PatrolState.MANUAL]: en
     * cualquier otro estado el dron está patrullando, orbitando o volviendo a
     * base y nadie tiene el control tomado, así que el mando se descarta.
     *
     * No se registra nada: a diez mensajes por segundo, el log local sería
     * ilegible. Lo que sí queda registrado es tomar y soltar el control.
     */
    private fun onManualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) {
        if (_state.value != PatrolState.MANUAL) return
        // Se mira el mando ya traducido: una palanca apenas movida cae en la
        // zona muerta y es vuelo estacionario, no una velocidad que cortar.
        val v = MandoVirtual.velocidades(pitch, roll, yaw, throttle)
        ultimoMandoMs = System.currentTimeMillis()
        ultimoMandoEstacionario = v.estacionario
        // Regla: manda el último comando DELIBERADO. Un mensaje con los cuatro
        // ejes en cero es el que la consola manda al SOLTAR la palanca —el
        // cierre del gesto, no una orden de frenar—, así que no puede abortar un
        // `manual_move` que está a mitad de camino: el pad y las palancas viven
        // en el mismo panel de la consola y rozar una palanca dejaba el salto de
        // 25 m tirado en cualquier lado, en silencio. Cualquier eje fuera de la
        // zona muerta, en cambio, es el operador agarrando la palanca a
        // propósito: ahí sí el salto se abandona y manda la palanca.
        if (v.estacionario && saltoManualEnCurso) return
        saltoManualEnCurso = false
        controller.manualStick(pitch, roll, yaw, throttle)
    }

    /**
     * ÚNICO lugar donde cambia el estado del patrullaje, y por eso el único que
     * puede garantizar que salir de MANUAL suelte el mando. Hace falta porque el
     * dron sostiene la última velocidad comandada hasta que le llegue otra: si el
     * estado se va de MANUAL y nadie le habla al controlador, el dron sigue
     * andando con nadie al mando (y el watchdog sigue armado, listo para cortarle
     * la orden nueva a los 1,5 s). Repartido por cada transición, la próxima que
     * se agregue se iba a olvidar.
     *
     * El estado se pisa ANTES de frenar, nunca después: el estado es la puerta
     * que mira [onManualStick] desde el hilo del WebSocket, y frenar con la
     * puerta abierta deja que un mando en camino vuelva a darle velocidad.
     *
     * [frenar] es para las transiciones que NO le dan otra orden al dron; con una
     * ruta, un desvío o un regreso a base en camino, un vuelo estacionario acá se
     * la comería, así que por defecto no frena.
     */
    private fun pasarA(nuevo: PatrolState, frenar: Boolean = false) {
        val salimosDeManual = _state.value == PatrolState.MANUAL && nuevo != PatrolState.MANUAL
        _state.value = nuevo
        if (!salimosDeManual) return
        ultimoMandoMs = 0L
        ultimoMandoEstacionario = true
        saltoManualEnCurso = false
        if (frenar) controller.hold()
    }

    /**
     * Watchdog del mando manual. El dron sostiene la última velocidad que le
     * mandaron hasta que le llegue otra: si el celular se queda sin internet en
     * medio de un movimiento, el dron seguiría andando con nadie al mando. Por
     * eso, cuando el mando se calla más de [MANDO_TIMEOUT_MS], la app manda los
     * ejes en cero por su cuenta.
     *
     * Vigila mientras el control esté TOMADO y no mientras el estado sea MANUAL.
     * Atarlo al estado apagaba la red de seguridad justo en el momento que la
     * necesita: al perderse la señal el estado pasa a RETURNING_HOME_SIGNAL y el
     * watchdog hacía `continue` para siempre, con el dron todavía comandado a la
     * última velocidad. Las salidas de MANUAL ya frenan por su cuenta (ver
     * [pasarA]); esto cubre el mando que alcanzó a cruzarse con la transición.
     *
     * Queda solo en el registro local y no se reporta como evento: el enlace con
     * el Comando Central es justamente el que se sospecha caído.
     */
    private suspend fun mandoWatchdog() {
        while (true) {
            delay(REVISION_MANDO_MS)
            if (!controlTomado) continue
            if (!hayQueCortarElMando(System.currentTimeMillis(), ultimoMandoMs, ultimoMandoEstacionario)) continue
            ultimoMandoMs = 0L
            ultimoMandoEstacionario = true
            saltoManualEnCurso = false
            controller.manualStick(0.0, 0.0, 0.0, 0.0)
            log(
                "Hace más de ${MANDO_TIMEOUT_MS / 1_000.0} s que no llegan órdenes de mando: " +
                    "el dron queda en vuelo estacionario",
            )
        }
    }

    private fun onControlReleased(by: String) {
        // El guard es el control y ya no el estado: se puede haber salido de
        // MANUAL por pérdida de señal o batería baja con el control todavía
        // tomado, y soltarlo ahí igual tiene que dejar al dron quieto y desarmar
        // el watchdog. Sin control tomado esto no es nuestro: tocar el dron
        // sería pisarle la orden a otro (una patrulla, un regreso a base).
        if (!controlTomado) return
        controlTomado = false
        // Si el dron ya salió de MANUAL (pérdida de señal, batería baja) el mando
        // ya quedó soltado ahí y hay otra orden en curso que no se pisa.
        // Si a continuación llega un resume_patrol, ese handler lo pone a patrullar.
        if (_state.value == PatrolState.MANUAL) pasarA(PatrolState.PAUSED, frenar = true)
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
                // Frena: acá nadie más le habla al dron. Sin esto quedaba con la
                // última velocidad del operador (hasta 5 m/s) y el lazo de
                // Virtual Stick repitiéndosela a 10 Hz, así que apenas el enlace
                // se reenganchaba retomaba la marcha con nadie al mando.
                pasarA(PatrolState.RETURNING_HOME_SIGNAL, frenar = true)
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
            report("SIGNAL_RECOVERED", "Señal con el dron recuperada")
            alRecuperarLaSenial()
            return
        }
        checkLowBattery(t)
    }

    /**
     * Qué hacer cuando vuelve la señal. Tiene tres salidas porque a
     * RETURNING_HOME_SIGNAL se llega desde cualquier estado en vuelo y antes
     * había una sola, la de la ruta: si el dron llegaba ahí SIN ruta cargada
     * —el caso normal de "lo quiero volar a mano", que se toma desde IDLE—,
     * [resumePatrol] se iba en el primer renglón y el estado quedaba clavado en
     * RETURNING_HOME_SIGNAL para siempre, sin un solo camino de vuelta.
     */
    private suspend fun alRecuperarLaSenial() {
        when {
            // El operador nunca soltó el control: sigue siendo suyo. El dron ya
            // quedó estacionario al perderse la señal, así que vuelve a la
            // palanca sin arrancar nada por su cuenta.
            controlTomado -> {
                pasarA(PatrolState.MANUAL)
                report("CONTROL_RESUMED", "Vuelve la señal con el control manual todavía tomado: el dron espera órdenes del operador")
            }
            // Requisito: al recuperar la señal, el patrullaje continúa donde quedó
            route != null -> resumePatrol("señal recuperada")
            // Sin ruta y sin control tomado no hay nada que reanudar: queda en
            // vuelo estacionario y disponible, en vez de clavado.
            else -> {
                pasarA(PatrolState.PAUSED)
                controller.hold()
                report("PATROL_STOPPED", "Señal recuperada sin ruta cargada: el dron queda en vuelo estacionario")
            }
        }
    }

    // ---- Detección de batería baja ----
    // Si la batería cae del umbral en pleno vuelo, se ordena RTH y se avisa al
    // Comando Central. No hay reanudación automática: hace falta cambiar batería.
    private suspend fun checkLowBattery(t: Telemetry) {
        val flying = _state.value in ESTADOS_EN_VUELO
        if (flying && t.batteryPct <= LOW_BATTERY_PCT) {
            // Sin frenar: el regreso a base de abajo ya es la orden que manda y
            // un vuelo estacionario acá se la comería. Lo que importa es soltar
            // el mando, para que el watchdog no le corte el RTH a los 1,5 s.
            pasarA(PatrolState.RETURNING_HOME_BATTERY)
            controller.returnHome()
            report("RTH_LOW_BATTERY", "Batería al ${t.batteryPct.toInt()}%: el dron vuelve a la base")
        }
    }

    /**
     * Se cambió/recargó la batería. Si el dron había aterrizado por batería baja,
     * vuelve a quedar disponible para arrancar un patrullaje.
     */
    fun onBatteryRecharged() {
        if (_state.value == PatrolState.LANDED) pasarA(PatrolState.IDLE)
        report("BATTERY_RECHARGED", "Batería recargada al 100%: el dron queda listo para volar")
    }

    private suspend fun onFlightEvent(e: FlightEvent) {
        when (e) {
            is FlightEvent.WaypointReached -> lastReachedWaypoint = e.index
            is FlightEvent.ArrivedHome -> {
                if (_state.value == PatrolState.RETURNING_HOME_BATTERY) {
                    pasarA(PatrolState.LANDED)
                    report("LANDED", "Dron aterrizado en base (batería baja)")
                }
            }
            is FlightEvent.GotoArrived -> {
                // El salto puntual terminó: desde acá el mando vuelve a mandar
                // sin condiciones (ver onManualStick()).
                saltoManualEnCurso = false
                if (_state.value == PatrolState.FORCED) {
                    report("GOTO_ARRIVED", "El dron llegó al nodo ${forcedIndex + 1} y queda en vuelo estacionario")
                }
            }
            // Un rechazo del dron no puede quedar mudo: el operador mueve la
            // palanca, el dron no se mueve y sin esto no hay ni una pista.
            is FlightEvent.Problema -> report("DRONE_PROBLEM", "El dron rechazó una orden: ${e.motivo}")
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
        pasarA(PatrolState.ORBITING)
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
        pasarA(PatrolState.PATROLLING)
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
