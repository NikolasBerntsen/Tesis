package com.tesis.dronepatrol

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.databinding.ActivityLoginBinding
import com.tesis.dronepatrol.model.DroneProfile
import kotlinx.coroutines.launch

/**
 * Pantalla inicial. La app se identifica ante el Comando Central con la cuenta
 * del dron y, una vez validada, se elige el modo de operación (TEST o DEPLOY).
 */
class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding
    private val commandCenter by lazy { CommandCenterClient(lifecycleScope) }
    private var profile: DroneProfile? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnLogin.setOnClickListener { iniciarSesion() }
        binding.btnModoPrueba.setOnClickListener { abrirPantallaPrincipal("TEST") }
        binding.btnModoDespliegue.setOnClickListener { abrirPantallaPrincipal("DEPLOY") }
    }

    private fun iniciarSesion() {
        val backendUrl = binding.editBackendUrl.text.toString().trim()
        val usuario = binding.editUsername.text.toString().trim()
        val password = binding.editPassword.text.toString()
        if (backendUrl.isEmpty() || usuario.isEmpty() || password.isEmpty()) {
            binding.txtLoginStatus.text = "Completá la URL del Comando Central, el usuario y la contraseña."
            return
        }

        binding.btnLogin.isEnabled = false
        binding.txtLoginStatus.text = "Verificando credenciales…"
        lifecycleScope.launch {
            try {
                commandCenter.login(backendUrl, usuario, password)
                profile = commandCenter.fetchProfile()
                mostrarSeleccionDeModo()
            } catch (e: Exception) {
                binding.txtLoginStatus.text = "No se pudo iniciar sesión: ${e.message}"
                binding.btnLogin.isEnabled = true
            }
        }
    }

    private fun mostrarSeleccionDeModo() {
        val p = profile ?: return
        binding.grupoLogin.visibility = View.GONE
        binding.grupoModo.visibility = View.VISIBLE
        binding.txtSubtitulo.text = "Elegí con qué modo arrancar la operación"
        binding.txtSesion.text = "${p.displayName} (${p.droneId})"
        binding.txtBase.text = p.base?.let { "Base: ${it.name}" } ?: "Sin base asignada"
    }

    private fun abrirPantallaPrincipal(modo: String) {
        val p = profile ?: return
        startActivity(
            Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_BACKEND_URL, binding.editBackendUrl.text.toString().trim())
                .putExtra(MainActivity.EXTRA_DETECTION_URL, binding.editDetectionUrl.text.toString().trim())
                .putExtra(MainActivity.EXTRA_USERNAME, p.droneId)
                .putExtra(MainActivity.EXTRA_PASSWORD, binding.editPassword.text.toString())
                .putExtra(MainActivity.EXTRA_DISPLAY_NAME, p.displayName)
                .putExtra(MainActivity.EXTRA_BASE_LAT, p.base?.lat ?: Double.NaN)
                .putExtra(MainActivity.EXTRA_BASE_LON, p.base?.lon ?: Double.NaN)
                .putExtra(MainActivity.EXTRA_MODE, modo),
        )
    }
}
