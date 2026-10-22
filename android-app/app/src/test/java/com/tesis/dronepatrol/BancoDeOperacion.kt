package com.tesis.dronepatrol

import android.content.Intent
import android.os.Looper
import androidx.appcompat.app.AlertDialog
import androidx.lifecycle.Lifecycle
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DescubridorDeDeteccion
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.comms.ModoEnlace
import com.tesis.dronepatrol.comms.RedLocal
import com.tesis.dronepatrol.drone.DronEnCurso
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Waypoint
import java.net.ConnectException
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.Socket
import java.time.Duration
import javax.net.SocketFactory
import kotlinx.coroutines.CoroutineScope
import org.json.JSONObject
import org.junit.Assert.fail
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.shadows.ShadowDialog

/**
 * La pantalla de operación armada para las pruebas, sin salir a la red: el dron
 * es el que le pase el test, el Comando Central es de mentira y la detección no
 * tiene por dónde conectarse. Hace falta porque la pantalla se conecta apenas se
 * abre (ver MainActivity.crearComandoCentral), y con los clientes de verdad cada
 * prueba le pegaba al Comando Central de producción con un token inventado.
 */
internal class BancoDeOperacion(private val dron: DroneController) {

    companion object {
        const val HASH = "0123456789abcdef0123456789abcdef"

        fun waypoint(alt: Double) = Waypoint(-34.6037, -58.3816, alt)

        /** Tres nodos a 40 m: la ruta que sale primera en el desplegable. */
        val COSTANERA = PatrolRoute(1, "Costanera", listOf(waypoint(40.0), waypoint(40.0), waypoint(40.0)))

        /** Un solo nodo a 55 m. */
        val RESERVA = PatrolRoute(2, "Reserva", listOf(waypoint(55.0)))
    }

    private val aplicacion get() = RuntimeEnvironment.getApplication()

    // Las fábricas de la app, para dejarlas como estaban: viven en el companion
    // y Robolectric reusa las clases entre una prueba y la siguiente.
    private val crearComandoCentralDeLaApp = MainActivity.crearComandoCentral
    private val crearDeteccionDeLaApp = MainActivity.crearDeteccion

    /** Lo que contesta el Comando Central al pedirle las rutas cuando se abre la pantalla. */
    var rutas: List<PatrolRoute> = emptyList()

    /** Si no es null, pedir las rutas falla con este motivo (el servidor caído, el token rechazado). */
    var falloAlPedirRutas: String? = null

    /** Por dónde se enlaza la detección. Por defecto RED sin URL: ni un socket. */
    var modoEnlace: ModoEnlace = ModoEnlace.RED

    lateinit var comando: ComandoCentralDePrueba
        private set
    lateinit var deteccion: DetectionClient
        private set
    private var controlador: ActivityController<MainActivity>? = null

    fun abrir(
        modo: String? = "TEST",
        nombre: String? = "Alfa",
        baseLat: Double? = null,
        baseLon: Double? = null,
    ): MainActivity {
        DronEnCurso.usar(dron)
        PreferenciasEnlace(aplicacion).apply {
            modoEnlace = this@BancoDeOperacion.modoEnlace
            urlDeteccionRed = ""
        }
        MainActivity.crearComandoCentral = { alcance ->
            ComandoCentralDePrueba(alcance).also {
                it.rutas = rutas
                it.falloAlPedirRutas = falloAlPedirRutas
                comando = it
            }
        }
        MainActivity.crearDeteccion = { alcance, _ ->
            // Puerto 0 y sin "hola": en AUTO se escucha en un puerto cualquiera y
            // no se anuncia nada en la red de la PC de desarrollo.
            DetectionClient(alcance, RedSinSalida, DescubridorDeDeteccion(puerto = 0, red = RedSinSalida, anunciarse = false))
                .also { deteccion = it }
        }
        val intent = Intent(aplicacion, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_DRONE_TOKEN, "token-de-prueba")
            .putExtra(MainActivity.EXTRA_DRONE_HASH, HASH)
        nombre?.let { intent.putExtra(MainActivity.EXTRA_DISPLAY_NAME, it) }
        modo?.let { intent.putExtra(MainActivity.EXTRA_MODE, it) }
        baseLat?.let { intent.putExtra(MainActivity.EXTRA_BASE_LAT, it) }
        baseLon?.let { intent.putExtra(MainActivity.EXTRA_BASE_LON, it) }
        val armado = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        controlador = armado
        correrLaPantalla()
        return armado.get()
    }

    /** Cierra la pantalla como lo hace Android al salir de ella. */
    fun cerrar() {
        val armado = controlador ?: return
        when (armado.get().lifecycle.currentState) {
            Lifecycle.State.RESUMED -> armado.pause().stop().destroy()
            Lifecycle.State.STARTED -> armado.stop().destroy()
            Lifecycle.State.CREATED -> armado.destroy()
            else -> Unit
        }
        correrLaPantalla()
    }

    /**
     * Cierra la pantalla —corta los hilos del simulador y de la escucha de
     * anuncios, que si no siguen vivos en las pruebas siguientes— y deja todo
     * como estaba.
     */
    fun desarmar() {
        cerrar()
        DronEnCurso.soltar()
        SesionDeCampo.cerrar()
        MainActivity.crearComandoCentral = crearComandoCentralDeLaApp
        MainActivity.crearDeteccion = crearDeteccionDeLaApp
    }
}

/** Corre lo que está pendiente en el hilo principal (las corrutinas de la pantalla viven ahí). */
internal fun correrLaPantalla() {
    shadowOf(Looper.getMainLooper()).idle()
}

/** Adelanta el reloj del hilo principal: los `delay` de la pantalla y del patrullaje. */
internal fun adelantarElReloj(segundos: Long) {
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(segundos))
}

/**
 * Corre el hilo principal hasta que se cumpla [condicion]. Es para lo que vuelve
 * de otro hilo —el cuadro que se decodifica aparte, el socket que falla, la
 * telemetría del simulador—: llega a la pantalla recién cuando el hilo principal
 * procesa lo que le dejaron.
 */
internal fun esperarEnLaPantalla(que: String, topeMs: Long = 5_000, condicion: () -> Boolean) {
    val limite = System.currentTimeMillis() + topeMs
    while (true) {
        correrLaPantalla()
        if (condicion()) return
        if (System.currentTimeMillis() > limite) fail("se agotó la espera de $que")
        Thread.sleep(10)
    }
}

/** La última confirmación que abrió la pantalla, o null si no abrió ninguna. */
internal fun ultimaConfirmacion(): AlertDialog? = ShadowDialog.getLatestDialog() as AlertDialog?

/**
 * Comando Central de mentira para la pantalla de operación: no abre el socket,
 * contesta las rutas que le cargue la prueba (o falla como un servidor caído) y
 * anota cada mensaje que la app le manda, con el JSON exacto que saldría.
 */
internal class ComandoCentralDePrueba(alcance: CoroutineScope) : CommandCenterClient(alcance) {

    @Volatile
    var rutas: List<PatrolRoute> = emptyList()

    @Volatile
    var falloAlPedirRutas: String? = null

    /** Cuántas veces se le pidió abrir el socket. */
    @Volatile
    var conexionesPedidas = 0
        private set

    private val enviados = mutableListOf<JSONObject>()

    override fun connect() {
        conexionesPedidas++
    }

    override suspend fun fetchRoutes(): List<PatrolRoute> {
        falloAlPedirRutas?.let { error(it) }
        return rutas
    }

    override fun send(obj: JSONObject) {
        synchronized(enviados) { enviados += JSONObject(obj.toString()) }
    }

    fun mensajes(tipo: String): List<JSONObject> =
        synchronized(enviados) { enviados.filter { it.optString("type") == tipo } }

    fun eventos(tipo: String): List<JSONObject> = mensajes("event").filter { it.optString("eventType") == tipo }
}

/**
 * Red por la que no sale nada: todo socket TCP se rechaza en el acto, igual que
 * el puerto del túnel de adb cuando nadie corrió `adb reverse`. Así el enlace con
 * la detección falla con el mismo motivo que en el campo, sin que la prueba toque
 * la red de la PC.
 */
internal object RedSinSalida : RedLocal {

    private val rechazaTodo = object : SocketFactory() {
        private fun rechazar(): Nothing = throw ConnectException("Connection refused")

        override fun createSocket(): Socket = rechazar()

        override fun createSocket(host: String?, port: Int): Socket = rechazar()

        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = rechazar()

        override fun createSocket(host: InetAddress?, port: Int): Socket = rechazar()

        override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket =
            rechazar()
    }

    override fun fabricaDeSockets(): SocketFactory = rechazaTodo

    override fun atar(socket: DatagramSocket) = Unit
}
