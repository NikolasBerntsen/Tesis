package com.tesis.dronepatrol

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.tesis.dronepatrol.comms.ModoEnlace
import com.tesis.dronepatrol.databinding.ActivityFieldMenuBinding
import com.tesis.dronepatrol.databinding.DialogConfigEnlaceBinding
import com.tesis.dronepatrol.databinding.DialogModoOperacionBinding
import com.tesis.dronepatrol.model.Emparejamiento
import kotlin.coroutines.resume
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Menú de campo: la pantalla donde el operador que ya inició sesión escanea el
 * QR del dron, lo empareja y lo despliega. La sesión es efímera, así que la
 * cuenta regresiva está siempre a la vista y al llegar a cero vuelve al login.
 */
class FieldMenuActivity : AppCompatActivity() {

    private companion object {
        /** Más que esto esperando un fix de GPS es tener al operador parado al pedo. */
        const val ESPERA_GPS_MS = 10_000L

        /**
         * El cliente traduce el 401 del emparejamiento a este texto y no expone
         * el código HTTP; con esto distinguimos "venció la sesión" de un error
         * cualquiera aunque nuestro reloj todavía no haya llegado a cero.
         */
        const val MOTIVO_SESION_VENCIDA = "sesión del operador de campo venció"
    }

    private lateinit var binding: ActivityFieldMenuBinding
    private val preferencias by lazy { PreferenciasEnlace(this) }

    /** Hash escaneado a la espera de que se resuelva el permiso de ubicación. */
    private var hashPendiente = ""

    private val pedirCamara = registerForActivityResult(ActivityResultContracts.RequestPermission()) { concedido ->
        if (concedido) abrirEscaner() else avisar(getString(R.string.permiso_camara_denegado))
    }

    private val escanear = registerForActivityResult(ScanContract()) { resultado ->
        val contenido = resultado.contents
        if (contenido == null) {
            avisar(getString(R.string.qr_cancelado))
            return@registerForActivityResult
        }
        val hash = hashDeDronODescartar(contenido)
        if (hash == null) {
            avisar(getString(R.string.qr_invalido))
            return@registerForActivityResult
        }
        pedirUbicacionYEmparejar(hash)
    }

    // El emparejamiento sigue con o sin permiso: el despliegue no se frena por el GPS.
    private val pedirUbicacion = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        emparejar(hashPendiente)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityFieldMenuBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.txtQuien.text =
            getString(R.string.menu_campo_quien, SesionDeCampo.usuario, etiquetaDeRol(this, SesionDeCampo.rol))
        binding.btnEscanear.setOnClickListener { escanearQr() }
        binding.btnConfiguracion.setOnClickListener { configurarEnlace() }
        binding.btnCerrarSesion.setOnClickListener { volverAlLogin(getString(R.string.aviso_sesion_cerrada), SesionDeCampo.Motivo.MANUAL) }

        // Salir con "atrás" también cierra la sesión: el JWT del operador no se
        // queda vivo en el proceso esperando a que alguien reabra la app.
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    SesionDeCampo.cerrar(SesionDeCampo.Motivo.SALIDA)
                    finish()
                }
            },
        )

        llevarLaCuentaRegresiva()
    }

    /** La sesión puede haber vencido mientras la pantalla estaba en segundo plano. */
    override fun onResume() {
        super.onResume()
        if (!SesionDeCampo.vigente) volverAlLogin(getString(R.string.aviso_sesion_vencida), SesionDeCampo.Motivo.VENCIDA)
    }

    private fun llevarLaCuentaRegresiva() {
        lifecycleScope.launch {
            while (isActive) {
                val restante = SesionDeCampo.restanteMs()
                if (restante == 0L) {
                    volverAlLogin(getString(R.string.aviso_sesion_vencida), SesionDeCampo.Motivo.VENCIDA)
                    return@launch
                }
                val segundos = restante / 1_000
                binding.txtCuentaRegresiva.text = "%02d:%02d".format(segundos / 60, segundos % 60)
                delay(1_000)
            }
        }
    }

    private fun escanearQr() {
        if (!SesionDeCampo.vigente) return volverAlLogin(getString(R.string.aviso_sesion_vencida), SesionDeCampo.Motivo.VENCIDA)
        if (tienePermiso(Manifest.permission.CAMERA)) abrirEscaner() else pedirCamara.launch(Manifest.permission.CAMERA)
    }

    private fun abrirEscaner() {
        binding.txtEstado.text = ""
        escanear.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.qr_pista))
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
    }

    private fun pedirUbicacionYEmparejar(hash: String) {
        hashPendiente = hash
        if (tienePermiso(Manifest.permission.ACCESS_FINE_LOCATION)) {
            emparejar(hash)
        } else {
            pedirUbicacion.launch(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
            )
        }
    }

    private fun emparejar(hash: String) {
        val cliente = SesionDeCampo.cliente ?: return volverAlLogin(getString(R.string.aviso_sesion_vencida), SesionDeCampo.Motivo.VENCIDA)
        binding.btnEscanear.isEnabled = false
        binding.txtEstado.text = getString(R.string.gps_buscando)
        lifecycleScope.launch {
            val donde = instantaneaGps()
            if (donde == null) avisar(getString(R.string.gps_sin_ubicacion))
            binding.txtEstado.text = getString(R.string.emparejando)
            try {
                val emparejamiento = cliente.emparejarDron(
                    hash = hash,
                    lat = donde?.latitude,
                    lon = donde?.longitude,
                    accuracyM = donde?.accuracy?.toDouble(),
                    deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}",
                )
                binding.txtEstado.text = ""
                elegirModoDeOperacion(emparejamiento, donde != null)
            } catch (e: Exception) {
                val motivo = e.message.orEmpty()
                if (!SesionDeCampo.vigente || motivo.contains(MOTIVO_SESION_VENCIDA)) {
                    volverAlLogin(getString(R.string.aviso_sesion_vencida), SesionDeCampo.Motivo.VENCIDA)
                } else {
                    binding.txtEstado.text = getString(R.string.emparejamiento_fallo, motivo)
                }
            } finally {
                binding.btnEscanear.isEnabled = true
            }
        }
    }

    /**
     * Ubicación del momento del emparejamiento. Devuelve null si el operador no
     * dio el permiso o si no hay fix a tiempo: eso no frena el despliegue, solo
     * deja el registro sin coordenadas.
     */
    @SuppressLint("MissingPermission")
    private suspend fun instantaneaGps(): Location? {
        if (!tienePermiso(Manifest.permission.ACCESS_FINE_LOCATION) &&
            !tienePermiso(Manifest.permission.ACCESS_COARSE_LOCATION)
        ) {
            return null
        }
        return withTimeoutOrNull(ESPERA_GPS_MS) {
            suspendCancellableCoroutine { continuacion ->
                val cancelacion = CancellationTokenSource()
                continuacion.invokeOnCancellation { cancelacion.cancel() }
                LocationServices.getFusedLocationProviderClient(this@FieldMenuActivity)
                    .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cancelacion.token)
                    .addOnSuccessListener { if (continuacion.isActive) continuacion.resume(it) }
                    .addOnFailureListener { if (continuacion.isActive) continuacion.resume(null) }
            }
        }
    }

    private fun elegirModoDeOperacion(emparejamiento: Emparejamiento, conUbicacion: Boolean) {
        val dron = emparejamiento.drone
        val vista = DialogModoOperacionBinding.inflate(layoutInflater)
        vista.txtDron.text = dron.displayName
        vista.txtDetalleDron.text = listOf(dron.model, hashAbreviado(dron.hash))
            .filter { it.isNotBlank() }
            .joinToString(" · ")
        vista.txtUbicacion.setText(
            if (conUbicacion) R.string.modo_con_ubicacion else R.string.modo_sin_ubicacion,
        )

        val dialogo = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.modo_titulo)
            .setView(vista.root)
            .setNegativeButton(R.string.cancelar, null)
            .create()
        vista.btnModoPrueba.setOnClickListener {
            dialogo.dismiss()
            desplegar(emparejamiento, "TEST")
        }
        vista.btnModoDespliegue.setOnClickListener {
            dialogo.dismiss()
            desplegar(emparejamiento, "DEPLOY")
        }
        dialogo.show()
    }

    /**
     * Arranca la operación con el token del dron. La sesión del operador de
     * campo termina acá: de la pantalla principal para adelante la app habla
     * como máquina, no como persona.
     */
    private fun desplegar(emparejamiento: Emparejamiento, modo: String) {
        val dron = emparejamiento.drone
        SesionDeCampo.cerrar(SesionDeCampo.Motivo.EMPAREJAMIENTO)
        startActivity(
            Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_DRONE_TOKEN, emparejamiento.token)
                .putExtra(MainActivity.EXTRA_DRONE_HASH, dron.hash)
                .putExtra(MainActivity.EXTRA_DISPLAY_NAME, dron.displayName)
                .putExtra(MainActivity.EXTRA_BASE_LAT, dron.base?.lat ?: Double.NaN)
                .putExtra(MainActivity.EXTRA_BASE_LON, dron.base?.lon ?: Double.NaN)
                .putExtra(MainActivity.EXTRA_MODE, modo),
        )
        finish()
    }

    private fun configurarEnlace() {
        val vista = DialogConfigEnlaceBinding.inflate(layoutInflater)
        val urlPrevia = preferencias.urlComandoCentral
        vista.editBackendUrl.setText(urlPrevia)
        vista.editUrlDeteccion.setText(preferencias.urlDeteccionRed)
        vista.editUrlDeteccion.hint = Config.PLANTILLA_URL_DETECCION_RED

        val porCable = preferencias.modoEnlace == ModoEnlace.CABLE
        vista.radioCable.isChecked = porCable
        vista.radioRed.isChecked = !porCable
        // En CABLE la URL es fija, así que el campo no tiene nada que hacer
        vista.layoutUrlDeteccion.isEnabled = !porCable
        vista.grupoModo.setOnCheckedChangeListener { _, elegido ->
            vista.layoutUrlDeteccion.isEnabled = elegido == R.id.radioRed
        }

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.enlace_titulo)
            .setView(vista.root)
            .setNegativeButton(R.string.cancelar, null)
            .setPositiveButton(R.string.guardar) { _, _ -> guardarEnlace(vista, urlPrevia) }
            .show()
    }

    private fun guardarEnlace(vista: DialogConfigEnlaceBinding, urlPrevia: String) {
        val modo = if (vista.radioRed.isChecked) ModoEnlace.RED else ModoEnlace.CABLE
        preferencias.modoEnlace = modo
        preferencias.urlDeteccionRed = vista.editUrlDeteccion.text.toString()
        if (modo == ModoEnlace.RED && preferencias.urlDeteccionRed.isEmpty()) {
            avisar(getString(R.string.enlace_falta_url_red))
        }

        val url = vista.editBackendUrl.text.toString().trim()
        if (url.isNotEmpty()) preferencias.urlComandoCentral = url
        // El JWT vale contra el Comando Central donde se pidió: si cambia la
        // dirección, la sesión que tenemos en la mano ya no sirve.
        if (url.isNotEmpty() && url != urlPrevia) {
            volverAlLogin(getString(R.string.aviso_cambio_comando_central), SesionDeCampo.Motivo.CAMBIO_SERVIDOR)
        }
    }

    private fun volverAlLogin(aviso: String, motivo: String) {
        SesionDeCampo.cerrar(motivo)
        startActivity(
            Intent(this, LoginActivity::class.java)
                .putExtra(LoginActivity.EXTRA_AVISO, aviso)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
        finish()
    }

    private fun tienePermiso(permiso: String): Boolean =
        ContextCompat.checkSelfPermission(this, permiso) == PackageManager.PERMISSION_GRANTED

    private fun avisar(texto: String) {
        binding.txtEstado.text = texto
        Toast.makeText(this, texto, Toast.LENGTH_LONG).show()
    }
}
