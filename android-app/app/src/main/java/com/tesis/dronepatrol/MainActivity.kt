package com.tesis.dronepatrol

import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.databinding.ActivityMainBinding
import com.tesis.dronepatrol.drone.ControllerFactory
import com.tesis.dronepatrol.drone.SimulatedDroneController
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.PatrolManager
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    // Credenciales del usuario "drone" sembrado en el backend (MVP; luego se
    // moverán a una pantalla de configuración)
    private companion object {
        const val DRONE_USERNAME = "drone1"
        const val DRONE_PASSWORD = "drone123"
        val STATE_LABELS = mapOf(
            PatrolState.IDLE to "En base",
            PatrolState.PATROLLING to "Patrullando",
            PatrolState.ORBITING to "Orbitando objetivo",
            PatrolState.RETURNING_HOME_SIGNAL to "Volviendo a base (pérdida de señal)",
            PatrolState.RETURNING_HOME_BATTERY to "Volviendo a base (batería baja)",
            PatrolState.LANDED to "Aterrizado",
        )
    }

    private lateinit var binding: ActivityMainBinding
    private val controller = ControllerFactory.create()
    private lateinit var commandCenter: CommandCenterClient
    private lateinit var detection: DetectionClient
    private lateinit var manager: PatrolManager
    private var routes: List<PatrolRoute> = emptyList()
    private val logLines = ArrayDeque<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        commandCenter = CommandCenterClient(lifecycleScope)
        detection = DetectionClient(lifecycleScope)
        manager = PatrolManager(controller, commandCenter, detection, lifecycleScope)

        binding.btnConnect.setOnClickListener { connect() }
        binding.btnStartPatrol.setOnClickListener { startPatrol() }
        setupSimControls()
        observeState()
    }

    private fun connect() {
        binding.btnConnect.isEnabled = false
        lifecycleScope.launch {
            try {
                commandCenter.loginAndConnect(
                    binding.editBackendUrl.text.toString().trim(),
                    DRONE_USERNAME,
                    DRONE_PASSWORD,
                )
                detection.connect(binding.editLaptopUrl.text.toString().trim())
                routes = commandCenter.fetchRoutes()
                binding.spinnerRoutes.adapter = ArrayAdapter(
                    this@MainActivity,
                    android.R.layout.simple_spinner_dropdown_item,
                    routes.map { it.name },
                )
                controller.connect()
                manager.start()
                binding.txtConnStatus.text = "Conectado como $DRONE_USERNAME (${routes.size} rutas)"
                binding.btnStartPatrol.isEnabled = true
            } catch (e: Exception) {
                binding.txtConnStatus.text = "Error: ${e.message}"
                binding.btnConnect.isEnabled = true
                Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun startPatrol() {
        val idx = binding.spinnerRoutes.selectedItemPosition
        val route = routes.getOrNull(idx) ?: return
        manager.startPatrol(route)
    }

    private fun setupSimControls() {
        val sim = controller as? SimulatedDroneController
        if (sim == null) {
            // Build "dji": los controles de simulación no aplican
            binding.sectionSim.visibility = View.GONE
            return
        }
        binding.switchSignalLoss.setOnCheckedChangeListener { _, checked -> sim.setSignalLost(checked) }
        binding.btnLowBattery.setOnClickListener { sim.forceLowBattery() }
    }

    private fun observeState() {
        lifecycleScope.launch {
            manager.state.collect { binding.txtState.text = "Estado: ${STATE_LABELS[it]}" }
        }
        lifecycleScope.launch {
            manager.signalOk.collect {
                binding.txtSignal.text = if (it) "Señal RC: OK" else "Señal RC: PERDIDA"
            }
        }
        lifecycleScope.launch {
            controller.telemetry.collect {
                binding.txtBattery.text = "Batería: ${it.batteryPct.toInt()}%"
            }
        }
        lifecycleScope.launch {
            manager.localLog.collect { line ->
                logLines.addFirst(line)
                while (logLines.size > 12) logLines.removeLast()
                binding.txtLocalLog.text = logLines.joinToString("\n")
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        controller.disconnect()
    }
}
