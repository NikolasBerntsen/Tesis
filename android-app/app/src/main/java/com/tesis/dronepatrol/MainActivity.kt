package com.tesis.dronepatrol

import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.BitmapFactory
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.SystemClock
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.comms.ModoEnlace
import com.tesis.dronepatrol.databinding.ActivityMainBinding
import com.tesis.dronepatrol.drone.ControllerFactory
import com.tesis.dronepatrol.drone.SimulatedDroneController
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.PatrolManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Pantalla de operación: lo que el operador de campo mira mientras el dron
 * vuela. Arriba el estado del aparato (enlace, GPS, en vuelo), después el video
 * en vivo con el estado del patrullaje encima, la telemetría, los enlaces y las
 * acciones de vuelo. El registro local vive en la segunda pestaña.
 *
 * Llega acá con el token que devolvió el emparejamiento por QR
 * ([FieldMenuActivity]): de este punto en adelante la app habla como el dron.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        /** JWT de rol `drone` que devolvió POST /api/drones/pair. */
        const val EXTRA_DRONE_TOKEN = "droneToken"
        const val EXTRA_DRONE_HASH = "droneHash"
        const val EXTRA_DISPLAY_NAME = "displayName"
        const val EXTRA_BASE_LAT = "baseLat"
        const val EXTRA_BASE_LON = "baseLon"
        const val EXTRA_MODE = "mode"

        private const val MAX_LINEAS_LOG = 80

        /** Sin un cuadro nuevo durante este tiempo, el visor dice que no hay video. */
        private const val SIN_VIDEO_MS = 2_500L

        /** Cuánto queda a la vista un aviso de vuelo que no es un problema. */
        private const val DURACION_AVISO_MS = 8_000L

        private val ETIQUETAS_ESTADO = mapOf(
            PatrolState.IDLE to R.string.estado_idle,
            PatrolState.PATROLLING to R.string.estado_patrullando,
            PatrolState.ORBITING to R.string.estado_orbitando,
            PatrolState.RETURNING_HOME_SIGNAL to R.string.estado_rth_senal,
            PatrolState.RETURNING_HOME_BATTERY to R.string.estado_rth_bateria,
            PatrolState.RETURNING_HOME to R.string.estado_rth_manual,
            PatrolState.LANDED to R.string.estado_aterrizado,
            PatrolState.PAUSED to R.string.estado_pausado,
            PatrolState.MANUAL to R.string.estado_manual,
            PatrolState.FORCED to R.string.estado_forzado,
        )

        /** Estados en los que "Detener" tiene algo que detener. */
        private val ESTADOS_DETENIBLES = setOf(
            PatrolState.PATROLLING,
            PatrolState.ORBITING,
            PatrolState.FORCED,
            PatrolState.MANUAL,
        )

        /** Estados desde los que "Reanudar" retoma la ruta. */
        private val ESTADOS_REANUDABLES = setOf(PatrolState.PAUSED, PatrolState.ORBITING, PatrolState.MANUAL)
    }

    private lateinit var binding: ActivityMainBinding
    private val controller = ControllerFactory.create()
    private lateinit var commandCenter: CommandCenterClient
    private lateinit var detection: DetectionClient
    private lateinit var manager: PatrolManager
    private val preferencias by lazy { PreferenciasEnlace(this) }

    private lateinit var droneToken: String
    private lateinit var droneHash: String
    private lateinit var modo: String
    private var displayName = ""
    private var routes: List<PatrolRoute> = emptyList()
    private var rutaElegida = 0
    private val lineasLog = ArrayDeque<String>()

    private var ultimoEstadoDron = EstadoDelDron.DESCONOCIDO
    private var ultimoCuadroMs = 0L
    private var avisoJob: Job? = null

    /**
     * Para que los anuncios UDP de la laptop lleguen al teléfono: sin este lock
     * algunos equipos filtran los broadcast en el chip de Wi-Fi para ahorrar
     * batería y la app nunca encuentra la detección.
     */
    private var multicastLock: WifiManager.MulticastLock? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        // En operación el operador mira el video y casi no toca la pantalla:
        // dejarla apagarse cortaría justo lo que vino a vigilar.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        droneToken = intent.getStringExtra(EXTRA_DRONE_TOKEN).orEmpty()
        droneHash = intent.getStringExtra(EXTRA_DRONE_HASH).orEmpty()
        modo = intent.getStringExtra(EXTRA_MODE) ?: "TEST"
        displayName = intent.getStringExtra(EXTRA_DISPLAY_NAME) ?: hashAbreviado(droneHash)

        commandCenter = CommandCenterClient(lifecycleScope)
        detection = DetectionClient(lifecycleScope)
        manager = PatrolManager(controller, commandCenter, detection, lifecycleScope, modo)
        commandCenter.onRenamed = { nombre -> lifecycleScope.launch { aplicarNombre(nombre) } }

        configurarBarra()
        configurarVistas()
        ubicarBaseDelDron()
        configurarSimulacion()
        configurarAccionesDeVuelo()
        observarEstado()
        conectar()
        conectarDeteccion()
    }

    private fun configurarBarra() {
        setSupportActionBar(binding.toolbar)
        supportActionBar?.title = displayName
        supportActionBar?.subtitle = getString(
            R.string.main_subtitulo,
            getString(if (modo == "TEST") R.string.main_modo_prueba else R.string.main_modo_despliegue),
            hashAbreviado(droneHash),
        )
    }

    /** Las dos vistas: operación y registro. */
    private fun configurarVistas() {
        binding.grupoVistas.addOnButtonCheckedListener { _, id, marcado ->
            if (marcado) mostrarPanel(operativo = id == R.id.btnVistaOperativa)
        }
    }

    private fun mostrarPanel(operativo: Boolean) {
        binding.panelOperativo.visibility = if (operativo) View.VISIBLE else View.GONE
        binding.panelLogs.visibility = if (operativo) View.GONE else View.VISIBLE
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_renombrar -> {
            mostrarDialogoRenombrar()
            true
        }
        R.id.action_cerrar_sesion -> {
            desconectarYVolverAlLogin()
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    /**
     * Corta el enlace del dron y vuelve al login. La sesión de máquina termina
     * acá: el token del dron no queda vivo esperando a que alguien reabra.
     */
    private fun desconectarYVolverAlLogin() {
        controller.disconnect()
        commandCenter.disconnect()
        detection.disconnect()
        startActivity(
            Intent(this, LoginActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK,
            ),
        )
        finish()
    }

    /** El simulador despega y vuelve a la base que tiene cargada el dron emparejado. */
    private fun ubicarBaseDelDron() {
        val lat = intent.getDoubleExtra(EXTRA_BASE_LAT, Double.NaN)
        val lon = intent.getDoubleExtra(EXTRA_BASE_LON, Double.NaN)
        if (!lat.isNaN() && !lon.isNaN()) {
            (controller as? SimulatedDroneController)?.setHome(lat, lon)
        }
    }

    private fun conectar() {
        binding.btnRetry.visibility = View.GONE
        binding.txtConnStatus.text = getString(R.string.main_conectando)
        lifecycleScope.launch {
            try {
                commandCenter.usarTokenDeDron(droneToken, preferencias.urlComandoCentral)
                commandCenter.connect()
                routes = commandCenter.fetchRoutes()
                manager.availableRoutes = routes
                mostrarRutas()
                controller.connect()
                manager.start()
                actualizarBotones()
                observarConexion()
            } catch (e: Exception) {
                binding.txtConnStatus.text = getString(R.string.main_error_conexion, e.message.orEmpty())
                binding.btnRetry.visibility = View.VISIBLE
                Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * El enlace con la detección es opcional: si no engancha, el patrullaje
     * sigue andando (sin alertas automáticas). Lo que no puede pasar es que
     * falle mudo, así que lo que diga el cliente se muestra tal cual.
     */
    private fun conectarDeteccion() {
        val modoEnlace = preferencias.modoEnlace
        val etiqueta = getString(
            when (modoEnlace) {
                ModoEnlace.AUTO -> R.string.main_enlace_auto
                ModoEnlace.CABLE -> R.string.main_enlace_cable
                ModoEnlace.RED -> R.string.main_enlace_red
            },
        )
        if (modoEnlace == ModoEnlace.AUTO) tomarMulticastLock()
        detection.connect(modoEnlace, preferencias.urlDeteccionRed)
        lifecycleScope.launch {
            detection.connected.combine(detection.ultimoFallo) { ok, fallo -> ok to fallo }
                .collect { (ok, fallo) ->
                    binding.txtDetectionStatus.text = when {
                        ok -> getString(R.string.main_deteccion_conectada, etiqueta)
                        fallo != null -> getString(R.string.main_deteccion_fallo, fallo)
                        else -> getString(R.string.main_deteccion_esperando, etiqueta)
                    }
                    binding.txtDetectionStatus.setTextColor(
                        ContextCompat.getColor(this@MainActivity, if (ok) R.color.estado_ok else R.color.texto_medio),
                    )
                }
        }
    }

    private fun tomarMulticastLock() {
        runCatching {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicastLock = wifi.createMulticastLock("dronepatrol-deteccion").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun mostrarRutas() {
        binding.dropdownRoutes.setSimpleItems(routes.map { it.name }.toTypedArray())
        binding.dropdownRoutes.setOnItemClickListener { _, _, posicion, _ -> elegirRuta(posicion) }
        if (routes.isEmpty()) {
            binding.dropdownRoutes.setText(getString(R.string.main_sin_rutas), false)
            binding.txtRouteInfo.text = ""
        } else {
            elegirRuta(0)
        }
    }

    private fun elegirRuta(posicion: Int) {
        rutaElegida = posicion
        val ruta = routes[posicion]
        binding.dropdownRoutes.setText(ruta.name, false)
        val altura = ruta.waypoints.firstOrNull()?.alt
        binding.txtRouteInfo.text = buildString {
            append(resources.getQuantityString(R.plurals.main_waypoints, ruta.waypoints.size, ruta.waypoints.size))
            if (altura != null) append(" · ").append(getString(R.string.main_altura_m, altura))
        }
    }

    // ---- Acciones de vuelo ----

    private fun configurarAccionesDeVuelo() {
        binding.btnStartPatrol.setOnClickListener { comenzarPatrullaje() }
        binding.btnStopPatrol.setOnClickListener { manager.detenerPatrullaje() }
        binding.btnResumePatrol.setOnClickListener { manager.reanudarPatrullaje() }
        binding.btnReturnHome.setOnClickListener {
            confirmar(R.string.main_confirmar_rth_titulo, getString(R.string.main_confirmar_rth_texto), R.string.main_volver_base) {
                manager.volverABase()
            }
        }
        binding.btnLand.setOnClickListener {
            confirmar(R.string.main_confirmar_aterrizar_titulo, getString(R.string.main_confirmar_aterrizar_texto), R.string.main_aterrizar) {
                manager.aterrizar()
            }
        }
        binding.btnRetry.setOnClickListener { conectar() }
    }

    /**
     * Con el dron en el suelo, comenzar es despegar: eso se confirma siempre.
     * En el aire la ruta arranca directo.
     */
    private fun comenzarPatrullaje() {
        val ruta = routes.getOrNull(rutaElegida) ?: return
        if (ultimoEstadoDron.enVuelo) {
            manager.startPatrol(ruta)
            return
        }
        confirmar(
            R.string.main_confirmar_despegue_titulo,
            getString(R.string.main_confirmar_despegue_texto, ruta.name),
            R.string.main_confirmar_despegue_boton,
        ) { manager.startPatrol(ruta) }
    }

    private fun confirmar(titulo: Int, texto: String, boton: Int, accion: () -> Unit) {
        MaterialAlertDialogBuilder(this)
            .setTitle(titulo)
            .setMessage(texto)
            .setNegativeButton(R.string.cancelar, null)
            .setPositiveButton(boton) { _, _ -> accion() }
            .show()
    }

    /** Qué botón tiene sentido ahora, según el patrullaje y el dron. */
    private fun actualizarBotones() {
        val estado = manager.state.value
        val dron = ultimoEstadoDron
        binding.btnStartPatrol.isEnabled =
            routes.isNotEmpty() && estado == PatrolState.IDLE && (dron.enVuelo || dron.listoParaDespegar)
        binding.btnStartPatrol.setText(
            if (dron.enVuelo) R.string.main_comenzar_patrullaje else R.string.main_despegar_y_patrullar,
        )
        binding.btnStopPatrol.isEnabled = estado in ESTADOS_DETENIBLES
        binding.btnResumePatrol.isEnabled = manager.tieneRuta && estado in ESTADOS_REANUDABLES
        binding.btnReturnHome.isEnabled =
            dron.enVuelo && estado != PatrolState.RETURNING_HOME && estado != PatrolState.RETURNING_HOME_BATTERY
        binding.btnLand.isEnabled = dron.enVuelo
    }

    private fun configurarSimulacion() {
        val sim = controller as? SimulatedDroneController
        // En despliegue (o con el dron real) no hay controles de simulación
        if (sim == null || modo != "TEST") {
            binding.cardSim.visibility = View.GONE
            return
        }
        binding.btnLowBattery.setOnClickListener { sim.forceLowBattery() }
        binding.btnRecharge.setOnClickListener {
            sim.rechargeBattery()
            manager.onBatteryRecharged()
        }
        binding.switchSignalLoss.setOnCheckedChangeListener { _, activado -> sim.setSignalLost(activado) }
    }

    private fun mostrarDialogoRenombrar() {
        val vista = layoutInflater.inflate(R.layout.dialog_renombrar, null)
        val campo = vista.findViewById<EditText>(R.id.editDisplayName)
        campo.setText(displayName)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.main_renombrar)
            .setView(vista)
            .setNegativeButton(R.string.cancelar, null)
            .setPositiveButton(R.string.guardar) { _, _ ->
                val nuevo = campo.text.toString().trim()
                if (nuevo.isNotEmpty()) {
                    commandCenter.sendSetName(nuevo)
                    aplicarNombre(nuevo)
                }
            }
            .show()
    }

    private fun aplicarNombre(nombre: String) {
        displayName = nombre
        supportActionBar?.title = nombre
    }

    // ---- Lo que se mira ----

    private fun observarEstado() {
        lifecycleScope.launch {
            manager.state.collect { estado ->
                ETIQUETAS_ESTADO[estado]?.let { binding.txtState.setText(it) }
                actualizarBotones()
            }
        }
        lifecycleScope.launch {
            controller.estado.collect { dron ->
                ultimoEstadoDron = dron
                pintarDron(dron)
                actualizarBotones()
            }
        }
        lifecycleScope.launch {
            controller.telemetry.collect { t ->
                val pct = t.batteryPct.toInt()
                binding.txtBattery.text = getString(R.string.main_bateria_pct, pct)
                binding.txtBattery.setTextColor(colorDeBateria(pct))
                binding.progressBattery.setProgressCompat(pct, true)
                binding.progressBattery.setIndicatorColor(colorDeBateria(pct))
                binding.txtAltitude.text = getString(R.string.main_altura_m, t.altM)
                binding.txtHeading.text = getString(R.string.main_rumbo_grados, t.heading)
                binding.txtPosition.text = getString(R.string.main_posicion_valor, t.lat, t.lon)
            }
        }
        lifecycleScope.launch {
            manager.signalOk.combine(manager.signalPct) { ok, pct -> ok to pct }
                .collect { (ok, pct) ->
                    binding.txtSignal.text = if (ok) {
                        getString(R.string.main_senal_ok, pct)
                    } else {
                        getString(R.string.main_senal_perdida)
                    }
                    binding.txtSignal.setTextColor(
                        ContextCompat.getColor(this@MainActivity, if (ok) R.color.texto else R.color.estado_peligro),
                    )
                    binding.progressSignal.setProgressCompat(pct, true)
                }
        }
        lifecycleScope.launch {
            manager.localLog.collect { linea ->
                lineasLog.addFirst(linea)
                while (lineasLog.size > MAX_LINEAS_LOG) lineasLog.removeLast()
                binding.txtLocalLog.text = lineasLog.joinToString("\n")
            }
        }
        lifecycleScope.launch {
            controller.videoFrames.collect { jpeg ->
                // Se decodifica fuera del hilo principal: cinco por segundo, y la
                // pantalla tiene que seguir respondiendo a los botones de vuelo.
                val cuadro = withContext(Dispatchers.Default) {
                    runCatching { BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) }.getOrNull()
                } ?: return@collect
                binding.imgVideo.setImageBitmap(cuadro)
                ultimoCuadroMs = SystemClock.elapsedRealtime()
                mostrarChipDeVideo(enVivo = true)
            }
        }
        lifecycleScope.launch {
            while (isActive) {
                delay(1_000)
                if (SystemClock.elapsedRealtime() - ultimoCuadroMs > SIN_VIDEO_MS) mostrarChipDeVideo(enVivo = false)
                // Las cajas vencen solas aunque no llegue más video
                manager.cajasVigentes(System.currentTimeMillis())
            }
        }
        lifecycleScope.launch {
            manager.cajasRecientes.collect { cajas -> binding.vistaCajas.cajas = cajas }
        }
        lifecycleScope.launch {
            controller.flightEvents.collect { evento ->
                when (evento) {
                    FlightEvent.Despegando -> avisar(getString(R.string.main_aviso_despegando), R.color.estado_alerta, fijo = true)
                    FlightEvent.EnElAire -> avisar(getString(R.string.main_aviso_en_el_aire), R.color.estado_ok)
                    is FlightEvent.Problema -> avisar(evento.motivo, R.color.estado_peligro)
                    else -> Unit
                }
            }
        }
    }

    private fun pintarDron(dron: EstadoDelDron) {
        binding.txtDroneStatus.text = dron.detalle
        val color = when {
            !dron.sdkListo || !dron.conectado -> R.color.estado_apagado
            dron.enVuelo -> R.color.estado_info
            dron.listoParaDespegar -> R.color.estado_ok
            else -> R.color.estado_alerta
        }
        binding.puntoDron.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(this, color))
        binding.txtModelo.text = dron.modelo.ifBlank { getString(R.string.main_modelo_desconocido) }
        binding.txtGps.text = getString(R.string.main_gps_sat, dron.satelites)
        binding.txtGps.setTextColor(
            ContextCompat.getColor(
                this,
                if (dron.satelites >= EstadoDelDron.SATELITES_MINIMOS) R.color.estado_ok else R.color.estado_alerta,
            ),
        )
        binding.txtVuelo.setText(if (dron.enVuelo) R.string.main_en_vuelo else R.string.main_en_suelo)
        binding.txtVuelo.setTextColor(
            ContextCompat.getColor(this, if (dron.enVuelo) R.color.estado_info else R.color.texto_medio),
        )
    }

    private fun mostrarChipDeVideo(enVivo: Boolean) {
        binding.chipVideo.setText(if (enVivo) R.string.main_video_en_vivo else R.string.main_video_sin_senal)
        binding.chipVideo.setTextColor(
            ContextCompat.getColor(this, if (enVivo) R.color.estado_ok else R.color.texto_medio),
        )
    }

    /**
     * Muestra el aviso de vuelo. Los que no son problemas se van solos a los
     * segundos; un despegue en curso ([fijo]) queda hasta el próximo aviso.
     */
    private fun avisar(texto: String, color: Int, fijo: Boolean = false) {
        avisoJob?.cancel()
        binding.txtAviso.text = texto
        binding.txtAviso.setTextColor(ContextCompat.getColor(this, color))
        binding.txtAviso.visibility = View.VISIBLE
        if (!fijo) {
            avisoJob = lifecycleScope.launch {
                delay(DURACION_AVISO_MS)
                binding.txtAviso.visibility = View.GONE
            }
        }
    }

    private fun colorDeBateria(pct: Int): Int = ContextCompat.getColor(
        this,
        when {
            pct <= 25 -> R.color.estado_peligro
            pct <= 40 -> R.color.estado_alerta
            else -> R.color.texto
        },
    )

    private fun observarConexion() {
        lifecycleScope.launch {
            commandCenter.connected.collect { ok ->
                binding.txtConnStatus.text = if (ok) {
                    resources.getQuantityString(R.plurals.main_rutas_conectado, routes.size, routes.size)
                } else {
                    getString(R.string.main_sin_enlace)
                }
                binding.txtConnStatus.setTextColor(
                    ContextCompat.getColor(this@MainActivity, if (ok) R.color.estado_ok else R.color.estado_alerta),
                )
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { multicastLock?.release() }
        controller.disconnect()
        commandCenter.disconnect()
        detection.disconnect()
    }
}
