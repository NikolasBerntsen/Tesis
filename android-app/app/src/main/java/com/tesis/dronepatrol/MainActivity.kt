package com.tesis.dronepatrol

import android.os.Bundle
import android.view.Menu
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
 * lateral. Los datos de conexión llegan desde [LoginActivity].
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_BACKEND_URL = "backendUrl"
        const val EXTRA_DETECTION_URL = "detectionUrl"
        const val EXTRA_USERNAME = "username"
        const val EXTRA_PASSWORD = "password"
        const val EXTRA_DISPLAY_NAME = "displayName"
        const val EXTRA_BASE_LAT = "baseLat"
        const val EXTRA_BASE_LON = "baseLon"
        const val EXTRA_MODE = "mode"

        private const val MAX_LINEAS_LOG = 50

        private val ETIQUETAS_ESTADO = mapOf(
            PatrolState.IDLE to "En base",
            PatrolState.PATROLLING to "Patrullando",
            PatrolState.ORBITING to "Orbitando objetivo",
            PatrolState.RETURNING_HOME_SIGNAL to "Volviendo a base (pérdida de señal)",
            PatrolState.RETURNING_HOME_BATTERY to "Volviendo a base (batería baja)",
            PatrolState.LANDED to "Aterrizado",
            PatrolState.PAUSED to "Patrulla interrumpida",
            PatrolState.MANUAL to "Control manual",
            PatrolState.FORCED to "Desvío a nodo",
        )
    }

    private lateinit var binding: ActivityMainBinding
    private val controller = ControllerFactory.create()
    private lateinit var commandCenter: CommandCenterClient
    private lateinit var detection: DetectionClient
    private lateinit var manager: PatrolManager

    private lateinit var backendUrl: String
    private lateinit var detectionUrl: String
    private lateinit var username: String
    private lateinit var password: String
    private lateinit var modo: String
    private var displayName = ""
    private var routes: List<PatrolRoute> = emptyList()
    private var rutaElegida = 0
    private val lineasLog = ArrayDeque<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        backendUrl = intent.getStringExtra(EXTRA_BACKEND_URL).orEmpty()
        detectionUrl = intent.getStringExtra(EXTRA_DETECTION_URL).orEmpty()
        username = intent.getStringExtra(EXTRA_USERNAME).orEmpty()
        password = intent.getStringExtra(EXTRA_PASSWORD).orEmpty()
        modo = intent.getStringExtra(EXTRA_MODE) ?: "TEST"
        displayName = intent.getStringExtra(EXTRA_DISPLAY_NAME) ?: username

        commandCenter = CommandCenterClient(lifecycleScope)
        detection = DetectionClient(lifecycleScope)
        manager = PatrolManager(controller, commandCenter, detection, lifecycleScope, modo)
        commandCenter.onRenamed = { nombre -> lifecycleScope.launch { aplicarNombre(nombre) } }

        configurarBarraYMenuLateral()
        ubicarBaseDelDron()
        configurarSimulacion()
        binding.btnStartPatrol.setOnClickListener { comenzarPatrullaje() }
        binding.btnRetry.setOnClickListener { conectar() }
        observarEstado()
        conectar()
    }

    private fun configurarBarraYMenuLateral() {
        setSupportActionBar(binding.toolbar)
        supportActionBar?.title = displayName
        supportActionBar?.subtitle =
            "${if (modo == "TEST") "Modo prueba" else "Despliegue"} · $username"

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

    /** El simulador despega y vuelve a la base de la cuenta con la que se inició sesión. */
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
        binding.txtConnStatus.text = "Conectando con el Comando Central…"
        lifecycleScope.launch {
            try {
                commandCenter.login(backendUrl, username, password)
                commandCenter.connect()
                routes = commandCenter.fetchRoutes()
                manager.availableRoutes = routes
                mostrarRutas()
                controller.connect()
                manager.start()
                binding.btnStartPatrol.isEnabled = routes.isNotEmpty()
                observarConexion()
                conectarDeteccion()
            } catch (e: Exception) {
                binding.txtConnStatus.text = "Error de conexión: ${e.message}"
                binding.btnRetry.visibility = View.VISIBLE
                Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * El enlace con la detección es opcional: si no se cargó la URL o es
     * inválida, el patrullaje igual funciona (sin alertas automáticas).
     */
    private fun conectarDeteccion() {
        val ok = detectionUrl.isNotEmpty() && runCatching { detection.connect(detectionUrl) }.isSuccess
        if (!ok) {
            Toast.makeText(this, "Sin enlace con la detección: no se van a generar alertas", Toast.LENGTH_LONG).show()
        }
    }

    private fun mostrarRutas() {
        binding.dropdownRoutes.setSimpleItems(routes.map { it.name }.toTypedArray())
        binding.dropdownRoutes.setOnItemClickListener { _, _, posicion, _ -> elegirRuta(posicion) }
        if (routes.isEmpty()) {
            binding.dropdownRoutes.setText("Sin rutas disponibles", false)
            binding.txtRouteInfo.text = ""
        } else {
            elegirRuta(0)
        }
    }

    private fun elegirRuta(posicion: Int) {
        rutaElegida = posicion
        val ruta = routes[posicion]
        binding.dropdownRoutes.setText(ruta.name, false)
        binding.txtRouteInfo.text = "${ruta.waypoints.size} waypoints"
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
            .setTitle("Renombrar dron")
            .setView(vista)
            .setNegativeButton("Cancelar", null)
            .setPositiveButton("Guardar") { _, _ ->
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
            manager.state.collect { binding.txtState.text = ETIQUETAS_ESTADO[it] }
        }
        lifecycleScope.launch {
            controller.telemetry.collect {
                val pct = it.batteryPct.toInt()
                binding.txtBattery.text = "$pct %"
                binding.progressBattery.setProgressCompat(pct, true)
            }
        }
        lifecycleScope.launch {
            manager.signalOk.combine(manager.signalPct) { ok, pct -> ok to pct }
                .collect { (ok, pct) ->
                    binding.txtSignal.text = if (ok) "OK · $pct %" else "PERDIDA"
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
                    "Comando Central: conectado · ${routes.size} rutas"
                } else {
                    "Comando Central: sin enlace, reintentando…"
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
