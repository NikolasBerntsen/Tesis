package com.tesis.dronepatrol

import android.content.Context
import android.os.SystemClock
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.model.SesionOperador
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Sesión efímera del operador de campo. Vive en el proceso y no en una Activity
 * porque el mismo JWT lo comparten el login, el menú de campo y el
 * emparejamiento, y un token no tiene por qué andar viajando en los Intent.
 */
object SesionDeCampo {

    /** Roles que el Comando Central deja emparejar drones (ver contrato). */
    val ROLES_HABILITADOS = setOf("field_operator", "supervisor", "admin")

    /** Si el backend no informa expiresIn asumimos los 20 minutos del contrato. */
    private const val DURACION_POR_DEFECTO_S = 20L * 60

    // Alcance propio: el cliente reintenta en segundo plano y no puede morir con
    // la Activity que lo creó, porque el JWT sobrevive a los cambios de pantalla.
    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Cliente con el JWT del operador cargado; null si no hay sesión abierta. */
    var cliente: CommandCenterClient? = null
        private set
    var usuario = ""
        private set
    var rol = ""
        private set

    // Reloj monótono: si el operador cambia la hora del teléfono, la cuenta
    // regresiva no se desmadra.
    private var venceEnMs = 0L

    fun nuevoCliente(): CommandCenterClient = CommandCenterClient(alcance)

    fun abrir(cliente: CommandCenterClient, sesion: SesionOperador) {
        this.cliente = cliente
        usuario = sesion.username
        rol = sesion.role
        val segundos = if (sesion.expiresIn > 0) sesion.expiresIn else DURACION_POR_DEFECTO_S
        venceEnMs = SystemClock.elapsedRealtime() + segundos * 1_000
    }

    fun cerrar() {
        cliente?.cerrarSesion()
        cliente = null
        usuario = ""
        rol = ""
        venceEnMs = 0L
    }

    /** Milisegundos que le quedan al JWT; 0 si venció o si no hay sesión. */
    fun restanteMs(): Long =
        if (cliente == null) 0L else (venceEnMs - SystemClock.elapsedRealtime()).coerceAtLeast(0L)

    val vigente: Boolean get() = restanteMs() > 0
}

/** Nombre del rol para mostrárselo al operador; si no lo conocemos, va crudo. */
fun etiquetaDeRol(context: Context, rol: String): String = when (rol) {
    "field_operator" -> context.getString(R.string.rol_operador_campo)
    "operator" -> context.getString(R.string.rol_operador)
    "supervisor" -> context.getString(R.string.rol_supervisor)
    "admin" -> context.getString(R.string.rol_admin)
    "drone" -> context.getString(R.string.rol_dron)
    else -> rol
}

/** El hash del dron nunca se muestra entero: solo la punta y la cola. */
fun hashAbreviado(hash: String): String =
    if (hash.length <= 12) hash else "${hash.take(6)}…${hash.takeLast(4)}"

/** El QR del dron trae solo su hash: 16 bytes en hexadecimal, sin adornos. */
private val HASH_DE_DRON = Regex("^[0-9a-f]{32}$")

/**
 * Normaliza lo que devolvió el escáner y lo acepta solo si es el hash de un
 * dron. Cualquier otro QR —el de una wifi, el de la caja del dron— se descarta
 * acá y no llega a golpear el Comando Central.
 */
fun hashDeDronODescartar(contenidoDelQr: String): String? =
    contenidoDelQr.trim().lowercase().takeIf { HASH_DE_DRON.matches(it) }
