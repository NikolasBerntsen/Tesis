package com.tesis.dronepatrol

import android.content.Intent
import android.os.Bundle
import android.view.Menu
import android.view.WindowManager
import android.view.MenuItem
import android.view.View
import android.widget.EditText
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.ActionBarDrawerToggle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.GravityCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.comms.ModoEnlace
import com.tesis.dronepatrol.databinding.ActivityMainBinding
import com.tesis.dronepatrol.drone.ControllerFactory
import com.tesis.dronepatrol.drone.SimulatedDroneController
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.PatrolManager
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Pantalla principal: estado del dron, elección de ruta y —solo en modo
 * prueba— los controles de simulación. El registro local vive en el menú
 * lateral. Llega acá con el token que devolvió el emparejamiento por QR
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

        private const val MAX_LINEAS_LOG = 50

        private val ETIQUETAS_ESTADO = mapOf(
            PatrolState.IDLE to R.string.estado_idle,
            PatrolState.PATROLLING to R.string.estado_patrullando,
            PatrolState.ORBITING to R.string.estado_orbitando,
            PatrolState.RETURNING_HOME_SIGNAL to R.string.estado_rth_senal,
            PatrolState.RETURNING_HOME_BATTERY to R.string.estado_rth_bateria,
            PatrolState.LANDED to R.string.estado_aterrizado,
            PatrolState.PAUSED to R.string.estado_pausado,
            PatrolState.MANUAL to R.string.estado_manual,
            PatrolState.FORCED to R.string.estado_forzado,
        )
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

        configurarBarraYMenuLateral()
        configurarMenuLateral()
        ubicarBaseDelDron()
        configurarSimulacion()
        binding.btnStartPatrol.setOnClickListener { comenzarPatrullaje() }
        binding.btnRetry.setOnClickListener { conectar() }
        observarEstado()
        conectar()
        conectarDeteccion()
    }

    /** Las dos vistas del cajón y la salida de la operación. */
    private fun configurarMenuLateral() {
        binding.btnVistaOperativa.setOnClickListener { mostrarPanel(operativo = true) }
        binding.btnVerLogs.setOnClickListener { mostrarPanel(operativo = false) }
        binding.btnSalirOperacion.setOnClickListener { desconectarYVolverAlLogin() }
    }

    private fun mostrarPanel(operativo: Boolean) {
        binding.panelOperativo.visibility = if (operativo) View.VISIBLE else View.GONE
        binding.panelLogs.visibility = if (operativo) View.GONE else View.VISIBLE
        supportActionBar?.subtitle =
            if (operativo) "${if (modo == "TEST") "Modo prueba" else "Despliegue"} · $displayName"
            else getString(R.string.menu_ver_logs)
        binding.drawerLayout.closeDrawer(GravityCompat.START)
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

    private fun configurarBarraYMenuLateral() {
        setSupportActionBar(binding.toolbar)
        supportActionBar?.title = displayName
        supportActionBar?.subtitle = getString(
            R.string.main_subtitulo,
            getString(if (modo == "TEST") R.string.main_modo_prueba else R.string.main_modo_despliegue),
            hashAbreviado(droneHash),
        )

        val toggle = ActionBarDrawerToggle(
            this,
            binding.drawerLayout,
            binding.toolbar,
            R.string.abrir_registro,
            R.string.cerrar_registro,
        )
        binding.drawerLayout.addDrawerListener(toggle)
        toggle.syncState()

        // Con el registro abierto, "atrás" lo cierra en vez de salir de la
        // pantalla (que cortaría la conexión con el Comando Central).
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (binding.drawerLayout.isDrawerOpen(GravityCompat.START)) {
                        binding.drawerLayout.closeDrawer(GravityCompat.START)
                    } else {
                        finish()
                    }
                }
            },
        )
    }

    /** El simulador despega y vuelve a la base que tiene cargada el dron emparejado. */
    private fun ubicarBaseDelDron() {
        val lat = intent.getDoubleExtra(EXTRA_BASE_LAT, Double.NaN)
        val lon = intent.getDoubleExtra(EXTRA_BASE_LON, Double.NaN)
        if (!lat.isNaN() && !lon.isNaN()) {
            (controller as? SimulatedDroneController)?.setHome(lat, lon)
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == R.id.action_renombrar) {
            mostrarDialogoRenombrar()
            return true
        }
        return super.onOptionsItemSelected(item)
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
                binding.btnStartPatrol.isEnabled = routes.isNotEmpty()
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
            if (modoEnlace == ModoEnlace.CABLE) R.string.main_enlace_cable else R.string.main_enlace_red,
        )
        detection.connect(modoEnlace, preferencias.urlDeteccionRed)
        lifecycleScope.launch {
            detection.connected.combine(detection.ultimoFallo) { ok, fallo -> ok to fallo }
                .collect { (ok, fallo) ->
                    binding.txtDetectionStatus.text = when {
                        ok -> getString(R.string.main_deteccion_conectada, etiqueta)
                        fallo != null -> getString(R.string.main_deteccion_fallo, fallo)
                        else -> getString(R.string.main_deteccion_esperando, etiqueta)
                    }
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
        binding.txtRouteInfo.text =
            resources.getQuantityString(R.plurals.main_waypoints, ruta.waypoints.size, ruta.waypoints.size)
    }

    private fun comenzarPatrullaje() {
        val ruta = routes.getOrNull(rutaElegida) ?: return
        manager.startPatrol(ruta)
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

    private fun observarEstado() {
        lifecycleScope.launch {
            manager.state.collect { estado ->
                ETIQUETAS_ESTADO[estado]?.let { binding.txtState.setText(it) }
            }
        }
        lifecycleScope.launch {
            controller.telemetry.collect {
                val pct = it.batteryPct.toInt()
                binding.txtBattery.text = getString(R.string.main_bateria_pct, pct)
                binding.progressBattery.setProgressCompat(pct, true)
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
    }

    private fun observarConexion() {
        lifecycleScope.launch {
            commandCenter.connected.collect { ok ->
                binding.txtConnStatus.text = if (ok) {
                    resources.getQuantityString(R.plurals.main_rutas_conectado, routes.size, routes.size)
                } else {
                    getString(R.string.main_sin_enlace)
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        controller.disconnect()
        commandCenter.disconnect()
        detection.disconnect()
    }
}
