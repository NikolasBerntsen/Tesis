package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * Dron de mentira que anota TODAS las órdenes que recibe, en orden.
 *
 * Existe porque el dron simulado no alcanza para las pruebas del mando: con él
 * se puede ver dónde termina el dron, pero no QUÉ se le ordenó ni cuándo, y la
 * diferencia entre "quedó quieto porque se lo frenó al salir de MANUAL" y "quedó
 * quieto porque saltó el watchdog un segundo y medio más tarde" es justamente lo
 * que hay que poder distinguir.
 *
 * La telemetría la empuja el test: dejar de empujarla es el corte del enlace de
 * radio con el dron, igual que en el campo.
 */
internal class DronEspia(
    /** Si anota las órdenes de los relevos o las deja con el cuerpo por defecto (ver abajo). */
    private val conRelevos: Boolean = false,
) : DroneController {

    companion object {
        /** Cómo queda anotado [cancelarInclinacionManual]. */
        const val CANCELAR_CAMARA = "cancelarInclinacionManual"

        /** Cómo queda anotado [devolverElMandoAlControl] (con [conRelevos]; sin él, es el `hold` por defecto). */
        const val DEVOLVER_EL_MANDO = "devolverElMandoAlControl"

        /** Un JPEG mínimo (empieza con FF D8): lo que devuelve [capturarFoto] por defecto. */
        val FOTO = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0x00, 0x10, 0x4A, 0x46)
    }

    private val telemetria = MutableSharedFlow<Telemetry>(replay = 1, extraBufferCapacity = 8)
    override val telemetry: SharedFlow<Telemetry> get() = telemetria
    override val videoFrames = MutableSharedFlow<ByteArray>(extraBufferCapacity = 4)
    override val cuadrosParaDeteccion = MutableSharedFlow<ByteArray>(extraBufferCapacity = 4)
    override val flightEvents = MutableSharedFlow<FlightEvent>(extraBufferCapacity = 8)

    /** Siempre en el aire y listo: lo que se prueba con este dron es el mando, no el despegue. */
    override val estado = MutableStateFlow(
        EstadoDelDron(sdkListo = true, conectado = true, modelo = "Espía", enVuelo = true, satelites = 14, baseFijada = true),
    )

    /** Cada orden como texto, que es lo que los tests comparan. */
    private val recibidas = mutableListOf<String>()

    val ordenes: List<String> get() = synchronized(recibidas) { recibidas.toList() }

    val ultimaOrden: String get() = synchronized(recibidas) { recibidas.lastOrNull() ?: "ninguna" }

    /**
     * Órdenes que dejan al dron quieto donde está: el vuelo estacionario, el
     * mando con los cuatro ejes en cero y el mando devuelto al control físico
     * (sin Virtual Stick el DJI frena solo).
     */
    fun laUltimaOrdenLoDejaQuieto(): Boolean =
        ultimaOrden == "hold" || ultimaOrden == "stick(0.0, 0.0, 0.0, 0.0)" || ultimaOrden == DEVOLVER_EL_MANDO

    /**
     * [ts] es la hora del dron en esa lectura. Por defecto, ahora; las pruebas de
     * la georreferencia la fijan a mano para armar una historia de poses (qué
     * pose corresponde al cuadro de cada detección) sin dormir el test.
     */
    suspend fun emitirTelemetria(
        lat: Double = -34.6037,
        lon: Double = -58.3816,
        bateria: Double = 100.0,
        alt: Double = 40.0,
        rumbo: Double = 0.0,
        gimbal: Double = Telemetry.GIMBAL_PATRULLA,
        ts: Long = System.currentTimeMillis(),
        // La autonomía que informa el DJI (docs/RELEVOS.md §0); NaN es "no se sabe".
        pctParaVolver: Double = Double.NaN,
        pctParaAterrizar: Double = Double.NaN,
        alcanceM: Double = Double.NaN,
    ) {
        val t = Telemetry(
            lat, lon, alt, bateria, 90, rumbo, ts, gimbal,
            pctParaVolver = pctParaVolver,
            pctParaAterrizar = pctParaAterrizar,
            alcanceM = alcanceM,
        )
        ultimaTelemetria = t
        telemetria.emit(t)
    }

    /** La última telemetría empujada: la base de la que confirma la cámara y el giro (ver [confirmarCamaraYRumbo]). */
    @Volatile
    var ultimaTelemetria: Telemetry? = null
        private set

    /**
     * Si son true, apuntar la cámara ([confirmarCamara]) y girar en el lugar
     * ([confirmarRumbo]) emiten en el acto la telemetría que lo confirma, como
     * haría el dron: la secuencia de última ubicación espera esa confirmación
     * antes de cada foto. Van por separado porque un giro que no se confirma
     * es un mando virtual que no está, y eso corta la panorámica; una cámara
     * que no confirma, no.
     */
    @Volatile
    var confirmarCamara = false

    @Volatile
    var confirmarRumbo = false

    /** Las dos confirmaciones juntas (ver [confirmarCamara] y [confirmarRumbo]). */
    var confirmarCamaraYRumbo: Boolean
        get() = confirmarCamara && confirmarRumbo
        set(valor) {
            confirmarCamara = valor
            confirmarRumbo = valor
        }

    /** Lo que contesta [prepararDespegue]. */
    @Volatile
    var mandoVirtualEnTierra = true

    /** Lo que devuelve [capturarFoto]; null es la cámara que no manda nada. */
    @Volatile
    var foto: ByteArray? = FOTO

    /** El último punto que se le pidió con [volarHacia]. */
    @Volatile
    var ultimoDestino: Pair<Double, Double>? = null

    private fun confirmar(si: Boolean, cambio: (Telemetry) -> Telemetry) {
        if (!si) return
        val t = cambio(ultimaTelemetria ?: return).copy(ts = System.currentTimeMillis())
        ultimaTelemetria = t
        telemetria.tryEmit(t)
    }

    /**
     * Gancho que corre al recibir cada orden, ANTES de anotarla. Los tests de
     * carrera lo usan para pararse en el medio de una orden y soltar al otro hilo
     * justo ahí: la ventana entre "leo el estado" y "le hablo al dron" es de
     * microsegundos, así que sin un punto de parada un test de esa carrera no
     * podría fallar de forma repetible — y un test que no puede fallar no prueba
     * nada.
     *
     * Se invoca FUERA del candado de [recibidas]: el gancho bloquea a propósito, y
     * con el candado tomado dejaría colgado al hilo que viene a leer las órdenes.
     */
    @Volatile
    var alRecibirLaOrden: ((String) -> Unit)? = null

    private fun anotar(orden: String) {
        alRecibirLaOrden?.invoke(orden)
        synchronized(recibidas) { recibidas += orden }
    }

    override fun connect() = anotar("connect")
    override fun startRoute(route: PatrolRoute, fromWaypoint: Int) = anotar("startRoute(${route.id}, $fromWaypoint)")
    /** Centro de la última órbita ordenada: es lo que dice si se orbita al objetivo o al dron. */
    @Volatile
    var ultimaOrbita: Pair<Double, Double>? = null

    override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double) {
        ultimaOrbita = centerLat to centerLon
        anotar("startOrbit")
    }
    override fun hold() = anotar("hold")
    override fun devolverElMandoAlControl() =
        if (conRelevos) anotar(DEVOLVER_EL_MANDO) else super.devolverElMandoAlControl()
    override fun gotoPoint(lat: Double, lon: Double) = anotar("gotoPoint")
    override fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) =
        anotar("stick($pitch, $roll, $yaw, $throttle)")
    override fun inclinarCamara(pitchGrados: Double) = anotar("camara($pitchGrados)")
    /** Va en la lista con las demás: lo que se mira es que salga ANTES de la orden del estado siguiente. */
    override fun cancelarInclinacionManual() = anotar(CANCELAR_CAMARA)
    override fun returnHome() = anotar("returnHome")

    /**
     * Lo que el dron contesta a [land], como lo haría el de verdad: por defecto
     * lo acepta en el acto ([FlightEvent.AterrizajeAceptado]). Con null no
     * contesta nada y la prueba empuja la respuesta a mano (la aceptación tarde,
     * el [FlightEvent.Problema] de un aterrizaje que no se pudo).
     */
    @Volatile
    var respuestaAlAterrizar: FlightEvent? = FlightEvent.AterrizajeAceptado

    override fun land() {
        anotar("land")
        respuestaAlAterrizar?.let { flightEvents.tryEmit(it) }
    }

    override fun cancelarAterrizaje() =
        if (conRelevos) anotar("cancelarAterrizaje") else super.cancelarAterrizaje()
    override fun seguirObjetivo(lat: Double, lon: Double, vNorteMs: Double, vEsteMs: Double) {
        ultimoSeguimiento = lat to lon
        anotar("seguirObjetivo")
    }

    /** Última estimación del objetivo que se le pidió seguir. */
    @Volatile
    var ultimoSeguimiento: Pair<Double, Double>? = null

    override fun despegarEnElLugar() = anotar("despegarEnElLugar")
    override fun vincularControl() = anotar("vincularControl")
    override fun cancelarVinculacion() = anotar("cancelarVinculacion")
    override fun disconnect() = anotar("disconnect")

    // ---- Relevos, desvío y última ubicación (docs/RELEVOS.md) ----
    // Con [conRelevos] en false (el valor por defecto) estas órdenes quedan con
    // el cuerpo por defecto de DroneController: es el controlador viejo, el que
    // DroneControllerPorDefectoTest prueba. Las pruebas de los relevos lo crean
    // con true y ven cada orden anotada.

    override fun despegarHasta(alturaM: Double) =
        if (conRelevos) anotar("despegarHasta($alturaM)") else super.despegarHasta(alturaM)

    override fun volarHacia(lat: Double, lon: Double) {
        if (!conRelevos) return super.volarHacia(lat, lon)
        ultimoDestino = lat to lon
        anotar("volarHacia")
    }

    override fun girarEnElLugar(rumboGrados: Double) {
        if (!conRelevos) return super.girarEnElLugar(rumboGrados)
        anotar("girar($rumboGrados)")
        confirmar(confirmarRumbo) { it.copy(heading = rumboGrados, rumboCamara = rumboGrados) }
    }

    override fun apuntarCamara(pitchGrados: Double) {
        if (!conRelevos) return super.apuntarCamara(pitchGrados)
        anotar("apuntar($pitchGrados)")
        confirmar(confirmarCamara) { it.copy(gimbalPitch = pitchGrados) }
    }

    override fun cambiarAltura(alturaM: Double) =
        if (conRelevos) anotar("cambiarAltura(${alturaM.toInt()})") else super.cambiarAltura(alturaM)

    override fun cancelarRegreso() = if (conRelevos) anotar("cancelarRegreso") else super.cancelarRegreso()

    override fun fijarPuntoDeRetornoAqui() =
        if (conRelevos) anotar("fijarPuntoDeRetornoAqui") else super.fijarPuntoDeRetornoAqui()

    override fun permitirRthPropioPorBateria(permitir: Boolean) =
        if (conRelevos) anotar("permitirRthPropio($permitir)") else super.permitirRthPropioPorBateria(permitir)

    override fun fijarFailsafeAterrizar(activo: Boolean) =
        if (conRelevos) anotar("failsafeAterrizar($activo)") else super.fijarFailsafeAterrizar(activo)

    override suspend fun capturarFoto(): ByteArray? {
        if (!conRelevos) return super.capturarFoto()
        anotar("capturarFoto")
        alCapturar?.invoke(capturas.incrementAndGet())
        return foto
    }

    private val capturas = java.util.concurrent.atomic.AtomicInteger()

    /**
     * Se llama en cada [capturarFoto] con su número (1, 2, …) antes de
     * devolver la foto: una prueba puede frenar ahí la secuencia de última
     * ubicación, en un punto exacto, sin depender de cuánto tarda.
     */
    @Volatile
    var alCapturar: (suspend (Int) -> Unit)? = null

    /** Si no es null, [prepararDespegue] lo tira: el SDK que falla en vez de contestar. */
    @Volatile
    var fallaDelMandoVirtual: Exception? = null

    override suspend fun prepararDespegue(): Boolean {
        if (!conRelevos) return super.prepararDespegue()
        anotar("prepararDespegue")
        fallaDelMandoVirtual?.let { throw it }
        return mandoVirtualEnTierra
    }

    override fun soltarDespegue() = if (conRelevos) anotar("soltarDespegue") else super.soltarDespegue()

    override fun fijarPuntoDeRetornoEn(lat: Double, lon: Double) =
        if (conRelevos) anotar("fijarPuntoDeRetornoEn") else super.fijarPuntoDeRetornoEn(lat, lon)
}
