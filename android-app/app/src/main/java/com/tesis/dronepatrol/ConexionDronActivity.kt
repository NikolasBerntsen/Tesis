package com.tesis.dronepatrol

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.location.Location
import android.os.Bundle
import android.os.Looper
import android.view.View
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.tesis.dronepatrol.databinding.ActivityConexionDronBinding
import com.tesis.dronepatrol.drone.DronEnCurso
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.SimulatedDroneController
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.Telemetry
import kotlinx.coroutines.launch

/**
 * Entre el emparejamiento y la operación: la pantalla que conecta con el dron
 * FÍSICO. El QR identifica al dron en el Comando Central; acá se verifica que
 * la aeronave de verdad esté enchufada, encendida y enlazada —SDK registrado,
 * control por USB, aeronave con su modelo y número de serie, GPS con punto de
 * retorno— y a qué distancia del teléfono está. Hasta que el enlace no está,
 * no se puede desplegar.
 *
 * La sesión del operador de campo sigue viva por debajo: al terminar la
 * operación se vuelve al menú de campo sin reingresar.
 */
class ConexionDronActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_MODELO_FICHA = "modeloFicha"
        const val EXTRA_BASE_NOMBRE = "baseNombre"
        const val EXTRA_CON_UBICACION = "conUbicacion"

        /** Más lejos que esto, el dron de al lado no es el que está enlazado: se avisa. */
        private const val DISTANCIA_SOSPECHOSA_M = 100.0
    }

    private lateinit var binding: ActivityConexionDronBinding
    private val controller by lazy { DronEnCurso.obtener() }
    private var ubicacionTelefono: Location? = null
    private var ultimaTelemetria: Telemetry? = null
    private var ultimoEstado = EstadoDelDron.DESCONOCIDO
    private var localizacion: FusedLocationProviderClient? = null
    private val alCambiarUbicacion = object : LocationCallback() {
        override fun onLocationResult(resultado: LocationResult) {
            ubicacionTelefono = resultado.lastLocation
            pintarDistancia()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityConexionDronBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val nombre = intent.getStringExtra(MainActivity.EXTRA_DISPLAY_NAME).orEmpty()
        val hash = intent.getStringExtra(MainActivity.EXTRA_DRONE_HASH).orEmpty()
        val modeloFicha = intent.getStringExtra(EXTRA_MODELO_FICHA).orEmpty()
        val base = intent.getStringExtra(EXTRA_BASE_NOMBRE).orEmpty()

        binding.txtNombreDron.text = nombre.ifBlank { hashAbreviado(hash) }
        binding.txtDetalleDron.text = listOf(modeloFicha, hashAbreviado(hash)).filter { it.isNotBlank() }.joinToString(" · ")
        binding.txtBase.text = if (base.isNotBlank()) getString(R.string.conexion_base, base) else ""
        binding.txtBase.visibility = if (base.isNotBlank()) View.VISIBLE else View.GONE
        binding.txtUbicacionDespliegue.setText(
            if (intent.getBooleanExtra(EXTRA_CON_UBICACION, false)) R.string.modo_con_ubicacion else R.string.modo_sin_ubicacion,
        )

        binding.filaSdk.titulo.setText(R.string.conexion_sdk)
        binding.filaControl.titulo.setText(R.string.conexion_control)
        binding.filaAeronave.titulo.setText(R.string.conexion_aeronave)
        binding.filaGps.titulo.setText(R.string.conexion_gps)

        binding.btnDesplegar.setOnClickListener { desplegar("DEPLOY") }
        binding.btnModoPrueba.setOnClickListener { desplegar("TEST") }
        binding.btnVolver.setOnClickListener { abandonar() }
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = abandonar()
            },
        )

        // El simulador arranca y vuelve a la base del dron emparejado
        val lat = intent.getDoubleExtra(MainActivity.EXTRA_BASE_LAT, Double.NaN)
        val lon = intent.getDoubleExtra(MainActivity.EXTRA_BASE_LON, Double.NaN)
        if (!lat.isNaN() && !lon.isNaN()) (controller as? SimulatedDroneController)?.setHome(lat, lon)

        controller.connect()
        observar()
        seguirAlTelefono()
    }

    private fun observar() {
        lifecycleScope.launch {
            controller.estado.collect { estado ->
                ultimoEstado = estado
                pintar(estado)
            }
        }
        lifecycleScope.launch {
            controller.telemetry.collect { t ->
                ultimaTelemetria = t
                binding.txtBateria.text = getString(R.string.main_bateria_pct, t.batteryPct.toInt())
                pintarDistancia()
            }
        }
    }

    private fun pintar(estado: EstadoDelDron) {
        val modeloFicha = intent.getStringExtra(EXTRA_MODELO_FICHA).orEmpty()
        fila(binding.filaSdk.punto, binding.filaSdk.detalle, estado.sdkListo, R.string.conexion_sdk_ok, R.string.conexion_sdk_esperando)
        fila(
            binding.filaControl.punto, binding.filaControl.detalle, estado.controlConectado,
            R.string.conexion_control_ok, R.string.conexion_control_esperando,
        )
        if (estado.conectado) {
            binding.filaAeronave.detalle.text = getString(
                R.string.conexion_aeronave_ok,
                estado.modelo.ifBlank { getString(R.string.main_modelo_desconocido) },
                estado.serie.ifBlank { "—" },
            )
            pintarPunto(binding.filaAeronave.punto, R.color.estado_ok)
        } else {
            binding.filaAeronave.detalle.setText(R.string.conexion_aeronave_esperando)
            pintarPunto(binding.filaAeronave.punto, if (estado.controlConectado) R.color.estado_alerta else R.color.estado_apagado)
        }
        val gpsListo = estado.baseFijada && estado.satelites >= EstadoDelDron.SATELITES_MINIMOS
        binding.filaGps.detalle.text = getString(
            if (gpsListo) R.string.conexion_gps_ok else R.string.conexion_gps_esperando,
            estado.satelites,
        )
        pintarPunto(binding.filaGps.punto, if (gpsListo) R.color.estado_ok else if (estado.conectado) R.color.estado_alerta else R.color.estado_apagado)

        // La ficha del Comando Central dice un modelo; la aeronave enlazada dice
        // el suyo. Si no coinciden, puede ser otro dron: se avisa, no se frena.
        // El simulador no es ningún modelo, así que con él no hay nada que comparar.
        val modeloDistinto = estado.conectado && controller !is SimulatedDroneController &&
            modeloFicha.isNotBlank() && estado.modelo.isNotBlank() &&
            !estado.modelo.contains(modeloFicha.removePrefix("DJI ").trim(), ignoreCase = true) &&
            !modeloFicha.contains(estado.modelo, ignoreCase = true)
        binding.txtAvisoModelo.visibility = if (modeloDistinto) View.VISIBLE else View.GONE
        if (modeloDistinto) binding.txtAvisoModelo.text = getString(R.string.conexion_modelo_distinto, modeloFicha, estado.modelo)

        val listo = estado.sdkListo && estado.conectado
        binding.btnDesplegar.isEnabled = listo
        binding.btnModoPrueba.isEnabled = listo
        binding.txtAyuda.text = if (listo) getString(R.string.conexion_listo) else estado.detalle
        binding.txtAyuda.setTextColor(ContextCompat.getColor(this, if (listo) R.color.estado_ok else R.color.texto_medio))
        pintarDistancia()
    }

    private fun fila(punto: View, texto: android.widget.TextView, ok: Boolean, siOk: Int, siNo: Int) {
        texto.setText(if (ok) siOk else siNo)
        pintarPunto(punto, if (ok) R.color.estado_ok else R.color.estado_apagado)
    }

    private fun pintarPunto(punto: View, color: Int) {
        punto.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(this, color))
    }

    /** Distancia entre el teléfono y la aeronave, por GPS de los dos. */
    private fun pintarDistancia() {
        val telefono = ubicacionTelefono
        val dron = ultimaTelemetria
        if (!ultimoEstado.conectado || telefono == null || dron == null) {
            binding.txtDistancia.setText(R.string.conexion_distancia_sin_dato)
            binding.txtDistancia.setTextColor(ContextCompat.getColor(this, R.color.texto_medio))
            return
        }
        val metros = Geo.distanciaM(telefono.latitude, telefono.longitude, dron.lat, dron.lon)
        binding.txtDistancia.text = getString(R.string.conexion_distancia_m, metros)
        binding.txtDistancia.setTextColor(
            ContextCompat.getColor(this, if (metros > DISTANCIA_SOSPECHOSA_M) R.color.estado_alerta else R.color.texto),
        )
    }

    @SuppressLint("MissingPermission")
    private fun seguirAlTelefono() {
        val conPermiso = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!conPermiso) return
        runCatching {
            val cliente = LocationServices.getFusedLocationProviderClient(this)
            localizacion = cliente
            cliente.requestLocationUpdates(
                LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2_000L).build(),
                alCambiarUbicacion,
                Looper.getMainLooper(),
            )
        }
    }

    /** Conectado: a operar. El controlador sigue vivo en [DronEnCurso] para la pantalla de operación. */
    private fun desplegar(modo: String) {
        startActivity(
            Intent(this, MainActivity::class.java)
                .putExtras(intent)
                .putExtra(MainActivity.EXTRA_MODE, modo),
        )
        finish()
    }

    /** Se abandona antes de operar: el controlador se apaga y se vuelve al menú de campo. */
    private fun abandonar() {
        controller.disconnect()
        DronEnCurso.soltar()
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { localizacion?.removeLocationUpdates(alCambiarUbicacion) }
    }
}
