package com.tesis.dronepatrol.drone

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Vinculacion
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Dron simulado: reproduce el comportamiento del Mini 4 Pro que le importa a la
 * lógica de patrullaje (despegue, vuelo por waypoints, órbita, RTH, aterrizaje,
 * drenaje de batería, failsafe por pérdida de enlace RC) sin necesitar hardware.
 *
 * Arranca **en el suelo con los motores apagados**, igual que el dron real, y
 * solo "Comenzar patrullaje" lo despega: así la pantalla de operación se puede
 * probar entera en el emulador. Las pruebas del vuelo lo crean con
 * [arrancaEnElAire] para no pagar el despegue en cada caso.
 */
class SimulatedDroneController(private val arrancaEnElAire: Boolean = false) : DroneController {

    private companion object {
        // El Obelisco, sobre la 9 de Julio: el mismo punto en el que abren los
        // mapas de la consola y en el que están las bases de demostración.
        const val HOME_LAT = -34.6037
        const val HOME_LON = -58.3816
        const val SPEED_MS = 12.0
        const val TICK_MS = 500L
        // El video simulado sale al MISMO ritmo que el del dron real (5 cuadros
        // por segundo a la consola, uno cada 500 ms a la detección): así el
        // reparto de PatrolManager da los mismos números en el banco de pruebas
        // que en el campo, que es justamente para lo que está el simulador.
        const val FRAME_MS = CuadroDeVideo.INTERVALO_CUADRO_MS
        const val BATTERY_DRAIN_PER_TICK = 0.02 // % por tick volando
        // Igual que el dron real: si pierde el enlace RC por más de este tiempo,
        // el propio dron inicia RTH (failsafe), sin intervención de la app.
        const val FAILSAFE_TIMEOUT_MS = 6_000L
        const val ARRIVE_THRESHOLD_M = 6.0
        const val METERS_PER_DEG_LAT = Geo.METROS_POR_GRADO_LAT
        // Altura a la que patrulla cuando la orden no trae una (ver altM)
        const val ALTURA_CRUCERO_M = 40.0
        // Techo del mando manual: 120 m es el límite legal de vuelo (ANAC).
        const val ALTURA_MAXIMA_M = 120.0
        // Velocidad vertical del despegue, el aterrizaje y el regreso a base: la
        // del dron real en automático. El mando manual va más despacio (MandoVirtual).
        const val VELOCIDAD_VERTICAL_AUTO_MS = 5.0
        // Alcance del enlace RC: a esta distancia de la base la señal ya está al mínimo
        const val SIGNAL_RANGE_M = 1_200.0
        const val SIGNAL_MIN_PCT = 10
        const val SATELITES_SIMULADOS = 14
        const val MODELO = "Simulado"
        const val SERIE = "SIM-0001"
        // Altura a la que deja al dron el despegue en el lugar: la del despegue
        // automático del SDK de DJI.
        const val ALTURA_DESPEGUE_EN_EL_LUGAR_M = 1.2
        // Velocidad tangencial de la órbita: la misma que el dron real.
        const val VELOCIDAD_ORBITA_MS = Navegacion.VELOCIDAD_ORBITA_MS
        // Más allá de esto la estimación del objetivo ya no se extrapola.
        const val EXTRAPOLACION_MAXIMA_MS = 3_000L
        // Hasta dónde llega el gimbal simulado: el rango del contrato
        // (manual_gimbal), del nadir a un poco por arriba del horizonte.
        const val INCLINACION_MINIMA = -90.0
        const val INCLINACION_MAXIMA = 30.0
    }

    /**
     * STICK es el mando virtual del operador; el resto los ordena la patrulla.
     * IDLE con altura cero es "en el suelo, motores apagados"; con altura es
     * vuelo estacionario sin orden (como queda el dron real después de despegar
     * a mano).
     */
    private enum class Mode { IDLE, TAKING_OFF, FLY_ROUTE, ORBIT, FOLLOW, RTH, HOLD, GOTO, STICK, LANDING }

    override val estado: StateFlow<EstadoDelDron>
        get() = _estado
    private val _estado = MutableStateFlow(
        EstadoDelDron(
            sdkListo = true,
            conectado = false,
            modelo = MODELO,
            enVuelo = false,
            satelites = SATELITES_SIMULADOS,
            baseFijada = true,
            detalle = "Simulador sin conectar",
            vinculacion = Vinculacion.VINCULADA,
        ),
    )
    override val telemetry = MutableSharedFlow<Telemetry>(replay = 1, extraBufferCapacity = 8)
    override val videoFrames = MutableSharedFlow<ByteArray>(extraBufferCapacity = 4)
    override val cuadrosParaDeteccion = MutableSharedFlow<ByteArray>(extraBufferCapacity = 2)
    override val flightEvents = MutableSharedFlow<FlightEvent>(extraBufferCapacity = 8)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var loops: Job? = null

    // El modo lo escribe el hilo que comanda (hold/gotoPoint/...) y lo lee el
    // lazo de vuelo: volátil para que el cambio se vea enseguida.
    @Volatile
    private var mode = Mode.IDLE
    private var homeLat = HOME_LAT
    private var homeLon = HOME_LON
    private var lat = HOME_LAT
    private var lon = HOME_LON
    // Altura sobre la base. Cero es el suelo. El mando manual es el único que
    // la mueve a gusto; los modos autónomos van a [alturaObjetivo].
    @Volatile
    private var altM = 0.0
    // A qué altura quiere estar la orden en curso: la del waypoint en ruta, la
    // de crucero en el resto. Sube o baja hacia ella en cada tick.
    @Volatile
    private var alturaObjetivo = ALTURA_CRUCERO_M
    private var battery = 100.0
    private var route: PatrolRoute? = null
    private var targetWaypoint = 0
    private var orbitCenterLat = 0.0
    private var orbitCenterLon = 0.0
    private var orbitRadiusM = 30.0
    private var orbitAngle = 0.0
    private var gotoLat = 0.0
    private var gotoLon = 0.0

    // Objetivo que se sigue en FOLLOW: la última estimación que mandó la
    // patrulla y cuándo, para extrapolarla con su velocidad entre una y otra.
    // Se guarda el objeto entero para que el lazo nunca vea media estimación.
    private class ObjetivoSeguido(val lat: Double, val lon: Double, val vNorteMs: Double, val vEsteMs: Double, val desdeMs: Long)

    @Volatile
    private var objetivoSeguido: ObjetivoSeguido? = null

    // El despegue en curso es el del mando manual (queda suspendido a ~1 m y
    // obedece al mando) y no el de una ruta.
    @Volatile
    private var despegueEnElLugar = false
    // Rumbo hacia el objetivo mientras se mueve; estacionario conserva el último
    private var heading = 0.0

    // Inclinación de la cámara: la de patrulla, salvo en órbita y siguiendo,
    // donde apunta al objetivo, y salvo que el operador la mueva desde la
    // consola (igual que el dron real).
    @Volatile
    private var gimbalPitch = Telemetry.GIMBAL_PATRULLA

    // Últimos ejes del mando virtual, ya convertidos a velocidades. Los escribe
    // el hilo del WebSocket y los lee el lazo de vuelo: se guarda el objeto
    // entero (y no cuatro campos sueltos) para que el lazo nunca vea media
    // orden aplicada.
    @Volatile
    private var ejesMando = MandoVirtual.NEUTRO

    /** Mientras es true no llega telemetría ni video a la app (enlace RC cortado). */
    @Volatile
    var signalLost = false
        private set
    private var signalLostAt = 0L

    /** Último motivo rechazado, para avisar por transición y no por intento. */
    @Volatile
    private var ultimoRechazo: String? = null

    fun setSignalLost(lost: Boolean) {
        signalLost = lost
        if (lost) signalLostAt = System.currentTimeMillis()
    }

    fun forceLowBattery() {
        battery = 24.0
    }

    fun rechargeBattery() {
        battery = 100.0
    }

    /** Base real del dron que inició sesión (la simulación arranca y vuelve ahí). */
    fun setHome(lat: Double, lon: Double) {
        homeLat = lat
        homeLon = lon
        if (mode == Mode.IDLE && altM == 0.0) {
            this.lat = lat
            this.lon = lon
        }
    }

    /** true con el dron en el suelo y los motores apagados. */
    private val enElSuelo: Boolean get() = mode == Mode.IDLE && altM <= 0.0

    override fun connect() {
        if (loops != null) return
        lat = homeLat
        lon = homeLon
        altM = if (arrancaEnElAire) ALTURA_CRUCERO_M else 0.0
        alturaObjetivo = ALTURA_CRUCERO_M
        battery = 100.0
        mode = Mode.IDLE
        ejesMando = MandoVirtual.NEUTRO
        ultimoRechazo = null
        publicarEstado()
        loops = scope.launch {
            launch { flightLoop() }
            launch { frameLoop() }
        }
    }

    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) {
        despegueEnElLugar = false
        this.route = route
        targetWaypoint = fromWaypoint.coerceIn(0, route.waypoints.size - 1)
        gimbalPitch = Telemetry.GIMBAL_PATRULLA
        if (enElSuelo) {
            // Despegue automático: sube derecho a la altura del primer waypoint
            // y recién ahí arranca la ruta (ver DroneController.startRoute).
            alturaObjetivo = route.waypoints[targetWaypoint].alt.coerceIn(2.0, ALTURA_MAXIMA_M)
            mode = Mode.TAKING_OFF
            emitEvent(FlightEvent.Despegando)
            publicarEstado()
            return
        }
        mode = Mode.FLY_ROUTE
    }

    override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double) {
        if (rechazarEnElSuelo("orbitar")) return
        orbitCenterLat = centerLat
        orbitCenterLon = centerLon
        orbitRadiusM = radiusM
        // Arranca (o sigue, si ya orbitaba y solo se corrió el centro) desde el
        // punto del círculo que tiene más cerca: con el ángulo fijo en cero el
        // dron cruzaba por encima del objetivo para ir al punto norte.
        orbitAngle = anguloDesdeElCentro(centerLat, centerLon)
        alturaObjetivo = ALTURA_CRUCERO_M
        gimbalPitch = Georreferencia.inclinacionParaOrbitar(altM, radiusM)
        mode = Mode.ORBIT
    }

    override fun seguirObjetivo(lat: Double, lon: Double, vNorteMs: Double, vEsteMs: Double) {
        if (rechazarEnElSuelo("seguir al objetivo")) return
        objetivoSeguido = ObjetivoSeguido(lat, lon, vNorteMs, vEsteMs, System.currentTimeMillis())
        if (mode != Mode.FOLLOW) alturaObjetivo = ALTURA_CRUCERO_M
        mode = Mode.FOLLOW
    }

    override fun despegarEnElLugar() {
        if (!enElSuelo) return
        alturaObjetivo = ALTURA_DESPEGUE_EN_EL_LUGAR_M
        despegueEnElLugar = true
        mode = Mode.TAKING_OFF
        emitEvent(FlightEvent.Despegando)
        publicarEstado()
    }

    override fun hold() {
        if (enElSuelo) return // en el suelo ya está quieto
        alturaObjetivo = ALTURA_CRUCERO_M
        mode = Mode.HOLD
    }

    override fun gotoPoint(lat: Double, lon: Double) {
        if (rechazarEnElSuelo("ir a un punto")) return
        gotoLat = lat
        gotoLon = lon
        alturaObjetivo = ALTURA_CRUCERO_M
        mode = Mode.GOTO
    }

    override fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) {
        if (rechazarEnElSuelo("el mando manual")) return
        ejesMando = MandoVirtual.velocidades(pitch, roll, yaw, throttle)
        // Con los cuatro ejes en cero el modo igual pasa a STICK: el dron queda
        // en vuelo estacionario obedeciendo al mando, no volviendo a lo anterior.
        mode = Mode.STICK
    }

    /**
     * La cámara queda en la inclinación pedida en el acto, en el suelo o en el
     * aire, y sale así en la próxima telemetría. El gimbal real tarda menos de
     * un segundo y la telemetría simulada sale cada medio: simular el recorrido
     * no le agregaría nada a lo que la consola ve. El modo no cambia; la órbita
     * y el seguimiento la vuelven a apuntar en su próximo tick, como el real.
     */
    override fun inclinarCamara(pitchGrados: Double) {
        if (!pitchGrados.isFinite()) return
        gimbalPitch = pitchGrados.coerceIn(INCLINACION_MINIMA, INCLINACION_MAXIMA)
    }

    override fun returnHome() {
        if (enElSuelo) return
        alturaObjetivo = ALTURA_CRUCERO_M
        mode = Mode.RTH
    }

    override fun land() {
        if (enElSuelo) return
        mode = Mode.LANDING
    }

    /** El simulador no tiene control físico: nace vinculado y no hay nada que hacer. */
    override fun vincularControl() = Unit

    override fun cancelarVinculacion() = Unit

    override fun disconnect() {
        scope.coroutineContext.cancelChildren()
        loops = null
        mode = Mode.IDLE
        _estado.update { it.copy(conectado = false, controlConectado = false, enVuelo = false, detalle = "Simulador desconectado") }
    }

    /**
     * Las órdenes que no despegan se rechazan con el dron en el suelo, igual que
     * hace el dron real: el aviso sale una vez por motivo, no una por intento
     * (el mando llega diez veces por segundo).
     */
    private fun rechazarEnElSuelo(que: String): Boolean {
        if (!enElSuelo) return false
        val motivo = "el dron está en el suelo: no se puede $que hasta despegar (arrancá un patrullaje)"
        if (ultimoRechazo != motivo) {
            ultimoRechazo = motivo
            emitEvent(FlightEvent.Problema(motivo))
        }
        return true
    }

    private fun publicarEstado() {
        _estado.update {
            it.copy(
                conectado = true,
                controlConectado = true,
                serie = SERIE,
                enVuelo = !enElSuelo,
                detalle = when {
                    enElSuelo -> "En el suelo, listo para despegar"
                    mode == Mode.TAKING_OFF -> "Despegando"
                    mode == Mode.LANDING -> "Aterrizando"
                    else -> "En vuelo"
                },
            )
        }
    }

    private suspend fun flightLoop() {
        while (true) {
            delay(TICK_MS)
            val dt = TICK_MS / 1000.0

            // Failsafe del propio dron ante pérdida prolongada del enlace RC
            if (signalLost && mode != Mode.RTH && mode != Mode.IDLE && mode != Mode.LANDING &&
                System.currentTimeMillis() - signalLostAt > FAILSAFE_TIMEOUT_MS
            ) {
                alturaObjetivo = ALTURA_CRUCERO_M
                mode = Mode.RTH
            }

            when (mode) {
                Mode.TAKING_OFF -> {
                    // Sube derecho, sin moverse en el plano, hasta la altura de
                    // trabajo; después la ruta arranca sola.
                    acercarAltura(alturaObjetivo, dt, VELOCIDAD_VERTICAL_AUTO_MS)
                    if (Navegacion.aLaAltura(altM, alturaObjetivo)) {
                        // El despegue del mando manual deja al dron suspendido
                        // obedeciendo al mando (en cero = quieto); el de una ruta
                        // arranca la ruta.
                        if (despegueEnElLugar) {
                            despegueEnElLugar = false
                            ejesMando = MandoVirtual.NEUTRO
                            mode = Mode.STICK
                        } else {
                            mode = Mode.FLY_ROUTE
                        }
                        ultimoRechazo = null
                        emitEvent(FlightEvent.EnElAire)
                    }
                    drainBattery()
                }
                Mode.FLY_ROUTE -> {
                    val wp = route?.waypoints?.getOrNull(targetWaypoint) ?: continue
                    alturaObjetivo = wp.alt.coerceIn(2.0, ALTURA_MAXIMA_M)
                    if (moveToward(wp.lat, wp.lon, dt)) {
                        emitEvent(FlightEvent.WaypointReached(targetWaypoint))
                        targetWaypoint = (targetWaypoint + 1) % route!!.waypoints.size
                    }
                    drainBattery()
                }
                Mode.ORBIT -> {
                    // Círculo alrededor del objetivo a velocidad constante. El
                    // dron va hacia el punto que sigue en el círculo (no salta a
                    // él): si arranca lejos, primero se acerca.
                    orbitAngle += (VELOCIDAD_ORBITA_MS / orbitRadiusM) * dt
                    val tLat = orbitCenterLat + (orbitRadiusM * cos(orbitAngle)) / METERS_PER_DEG_LAT
                    val tLon = orbitCenterLon + (orbitRadiusM * sin(orbitAngle)) / Geo.metrosPorGradoLon(orbitCenterLat)
                    moveToward(tLat, tLon, dt)
                    // En órbita la cámara mira al objetivo
                    heading = bearingTo(orbitCenterLat, orbitCenterLon)
                    gimbalPitch = Georreferencia.inclinacionParaOrbitar(
                        altM,
                        Geo.distanciaM(lat, lon, orbitCenterLat, orbitCenterLon),
                    )
                    drainBattery()
                }
                Mode.FOLLOW -> {
                    val o = objetivoSeguido
                    if (o != null) {
                        // La estimación se extrapola con su velocidad hasta la
                        // próxima, como hace el dron real.
                        val edadS = (System.currentTimeMillis() - o.desdeMs).coerceIn(0L, EXTRAPOLACION_MAXIMA_MS) / 1_000.0
                        val oLat = o.lat + o.vNorteMs * edadS / METERS_PER_DEG_LAT
                        val oLon = o.lon + o.vEsteMs * edadS / Geo.metrosPorGradoLon(o.lat)
                        val orden = Persecucion.calcular(lat, lon, altM, oLat, oLon, o.vNorteMs, o.vEsteMs)
                        lat += orden.vNorteMs * dt / METERS_PER_DEG_LAT
                        lon += orden.vEsteMs * dt / metersPerDegLon()
                        heading = orden.rumboGrados
                        gimbalPitch = orden.gimbalPitch
                    }
                    drainBattery()
                }
                Mode.GOTO -> {
                    if (moveToward(gotoLat, gotoLon, dt)) {
                        mode = Mode.HOLD
                        emitEvent(FlightEvent.GotoArrived)
                    }
                    drainBattery()
                }
                Mode.HOLD -> drainBattery() // vuelo estacionario: gasta batería igual
                Mode.RTH -> {
                    // Llega a la base a altura de crucero y recién ahí baja: el
                    // dron real hace lo mismo.
                    if (moveToward(homeLat, homeLon, dt)) {
                        acercarAltura(0.0, dt, VELOCIDAD_VERTICAL_AUTO_MS)
                        if (altM <= 0.0) {
                            mode = Mode.IDLE
                            emitEvent(FlightEvent.ArrivedHome)
                        }
                    }
                    drainBattery()
                }
                Mode.LANDING -> {
                    acercarAltura(0.0, dt, VELOCIDAD_VERTICAL_AUTO_MS)
                    if (altM <= 0.0) {
                        mode = Mode.IDLE
                        emitEvent(FlightEvent.Aterrizado)
                    }
                    drainBattery()
                }
                Mode.STICK -> {
                    val v = ejesMando
                    // El yaw es velocidad de giro: mueve la nariz y con ella el
                    // "adelante" del propio mando.
                    heading = (heading + v.giroGradosS * dt + 360.0) % 360.0
                    val sobreTerreno = MandoVirtual.aTerreno(v, heading)
                    lat += (sobreTerreno.norteMs * dt) / METERS_PER_DEG_LAT
                    lon += (sobreTerreno.esteMs * dt) / metersPerDegLon()
                    altM = (altM + v.subidaMs * dt).coerceIn(0.5, ALTURA_MAXIMA_M)
                    drainBattery()
                }
                Mode.IDLE -> Unit
            }

            // El mando manual es el único que elige la altura; en cuanto el dron
            // vuelve a volar solo (ruta, órbita, goto o estacionario) sube o baja
            // a la de la orden, así el operador no lo deja a ras del suelo.
            if (mode == Mode.FLY_ROUTE || mode == Mode.ORBIT || mode == Mode.FOLLOW || mode == Mode.GOTO || mode == Mode.HOLD ||
                (mode == Mode.RTH && !llegoABase())
            ) {
                acercarAltura(alturaObjetivo, dt, MandoVirtual.MAX_VERTICAL_MS)
            }

            publicarEstado()
            if (!signalLost) {
                telemetry.tryEmit(
                    Telemetry(lat, lon, altM, battery, signalPct(), heading, System.currentTimeMillis(), gimbalPitch),
                )
            }
        }
    }

    /** Avanza hacia el punto dado; devuelve true si llegó. */
    private fun moveToward(tLat: Double, tLon: Double, dt: Double): Boolean {
        val dy = (tLat - lat) * METERS_PER_DEG_LAT
        val dx = (tLon - lon) * metersPerDegLon()
        val dist = hypot(dx, dy)
        if (dist < ARRIVE_THRESHOLD_M) return true
        heading = bearingTo(tLat, tLon)
        val step = (SPEED_MS * dt).coerceAtMost(dist)
        lat += (dy / dist) * step / METERS_PER_DEG_LAT
        lon += (dx / dist) * step / metersPerDegLon()
        return false
    }

    private fun llegoABase(): Boolean {
        val dy = (homeLat - lat) * METERS_PER_DEG_LAT
        val dx = (homeLon - lon) * metersPerDegLon()
        return hypot(dx, dy) < ARRIVE_THRESHOLD_M
    }

    /** Sube o baja hacia [objetivoM] a [velocidadMs] como mucho. */
    private fun acercarAltura(objetivoM: Double, dt: Double, velocidadMs: Double) {
        val paso = velocidadMs * dt
        altM = when {
            altM < objetivoM -> (altM + paso).coerceAtMost(objetivoM)
            altM > objetivoM -> (altM - paso).coerceAtLeast(objetivoM)
            else -> altM
        }
    }

    /**
     * Ángulo de la posición actual vista desde el centro, en la convención de
     * la órbita (lat = centro + r·cos, lon = centro + r·sin).
     */
    private fun anguloDesdeElCentro(centroLat: Double, centroLon: Double): Double {
        val norte = (lat - centroLat) * METERS_PER_DEG_LAT
        val este = (lon - centroLon) * Geo.metrosPorGradoLon(centroLat)
        return kotlin.math.atan2(este, norte)
    }

    /** Rumbo 0..360° desde la posición actual hacia el punto dado (norte = 0, este = 90). */
    private fun bearingTo(tLat: Double, tLon: Double): Double =
        (Geo.rumboHacia(lat, lon, tLat, tLon) + 360.0) % 360.0

    private fun metersPerDegLon() = Geo.metrosPorGradoLon(lat)

    /** La señal se degrada de forma lineal con la distancia a la base. */
    private fun signalPct(): Int {
        val dy = (lat - homeLat) * METERS_PER_DEG_LAT
        val dx = (lon - homeLon) * metersPerDegLon()
        val pct = 100 * (1 - hypot(dx, dy) / SIGNAL_RANGE_M)
        return pct.toInt().coerceIn(SIGNAL_MIN_PCT, 100)
    }

    private fun drainBattery() {
        battery = (battery - BATTERY_DRAIN_PER_TICK).coerceAtLeast(0.0)
    }

    private fun emitEvent(e: FlightEvent) {
        flightEvents.tryEmit(e)
    }

    // ---- Video simulado ----

    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.US)
    private val limitadorDeDeteccion = LimitadorDeRitmo(CuadroDeVideo.INTERVALO_DETECCION_MS)

    private suspend fun frameLoop() {
        val paint = Paint().apply { isAntiAlias = true }
        var t = 0.0
        while (true) {
            delay(FRAME_MS)
            if (signalLost) continue // el video también viaja por el enlace RC
            t += 0.35
            videoFrames.tryEmit(cuadro(CuadroDeVideo.ANCHO_MAXIMO, t, paint, CuadroDeVideo.CALIDAD_JPEG))
            // El cuadro para la detección sale más grande y más espaciado, como
            // con el dron real (ver DroneController.cuadrosParaDeteccion).
            if (limitadorDeDeteccion.aceptar(System.currentTimeMillis())) {
                cuadrosParaDeteccion.tryEmit(
                    cuadro(CuadroDeVideo.ANCHO_DETECCION, t, paint, CuadroDeVideo.CALIDAD_JPEG_DETECCION),
                )
            }
        }
    }

    /** Un "campo" visto desde arriba con un objeto que deambula, a la escala pedida. */
    private fun cuadro(ancho: Int, t: Double, paint: Paint, calidad: Int): ByteArray {
        val escala = ancho / 640f
        val alto = (360 * escala).toInt()
        val bmp = Bitmap.createBitmap(ancho, alto, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.scale(escala, escala)
        c.drawColor(Color.rgb(24, 46, 32))
        paint.color = Color.rgb(40, 70, 50)
        paint.strokeWidth = 1f
        for (i in 0..8) c.drawLine(i * 80f, 0f, i * 80f, 360f, paint)
        for (i in 0..5) c.drawLine(0f, i * 72f, 640f, i * 72f, paint)
        // Un "objeto" que deambula, para que el software de detección tenga algo que mirar
        paint.color = Color.WHITE
        val ox = 320f + (220 * sin(t * 0.7)).toFloat()
        val oy = 180f + (120 * cos(t * 0.4)).toFloat()
        c.drawRect(ox, oy, ox + 14f, oy + 28f, paint)
        paint.textSize = 18f
        c.drawText("DRONE SIM  ${timeFmt.format(Date())}", 12f, 24f, paint)
        c.drawText("bat %.0f%%  %s  alt %.0f m".format(battery, mode.name, altM), 12f, 48f, paint)
        c.drawText("pos %.5f, %.5f".format(lat, lon), 12f, 348f, paint)

        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, calidad, out)
        bmp.recycle()
        return out.toByteArray()
    }
}
