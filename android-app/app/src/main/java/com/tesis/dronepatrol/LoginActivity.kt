package com.tesis.dronepatrol

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.tesis.dronepatrol.databinding.ActivityLoginBinding
import kotlinx.coroutines.launch

/**
 * Pantalla inicial. Acá entra la **persona** que despliega el dron —el operador
 * de campo, o un supervisor/admin— con su cuenta del Comando Central. El dron no
 * tiene cuenta: se identifica con el QR que se escanea en el menú de campo.
 */
class LoginActivity : AppCompatActivity() {

    companion object {
        /** Motivo por el que se volvió al login (sesión vencida, cierre, etc.). */
        const val EXTRA_AVISO = "aviso"
    }

    private lateinit var binding: ActivityLoginBinding
    private val preferencias by lazy { PreferenciasEnlace(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.editBackendUrl.setText(preferencias.urlComandoCentral)
        binding.txtLoginStatus.text = intent.getStringExtra(EXTRA_AVISO).orEmpty()
        binding.btnLogin.setOnClickListener { iniciarSesion() }
    }

    private fun iniciarSesion() {
        val url = binding.editBackendUrl.text.toString().trim()
        val usuario = binding.editUsername.text.toString().trim()
        val password = binding.editPassword.text.toString()
        if (url.isEmpty() || usuario.isEmpty() || password.isEmpty()) {
            binding.txtLoginStatus.text = getString(R.string.login_faltan_datos)
            return
        }

        binding.btnLogin.isEnabled = false
        binding.txtLoginStatus.text = getString(R.string.login_verificando)
        lifecycleScope.launch {
            val cliente = SesionDeCampo.nuevoCliente()
            try {
                val sesion = cliente.login(url, usuario, password)
                if (sesion.role !in SesionDeCampo.ROLES_HABILITADOS) {
                    cliente.cerrarSesion()
                    binding.txtLoginStatus.text =
                        getString(R.string.login_rol_sin_permiso, etiquetaDeRol(this@LoginActivity, sesion.role))
                    binding.btnLogin.isEnabled = true
                    return@launch
                }
                // Con guantes y a la intemperie nadie quiere retipear la URL
                preferencias.urlComandoCentral = url
                SesionDeCampo.abrir(cliente, sesion)
                startActivity(Intent(this@LoginActivity, FieldMenuActivity::class.java))
                finish()
            } catch (e: Exception) {
                binding.txtLoginStatus.text = getString(R.string.login_fallo, e.message.orEmpty())
                binding.btnLogin.isEnabled = true
            }
        }
    }
}
