package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.BaseDelHub
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.PatrolState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * El interruptor «En espera para relevos» del teléfono (docs/RELEVOS.md §0).
 * Sin él un dron NUNCA despega solo: el operador de campo lo prende después de
 * revisar el aparato y su zona de despegue, y es lo único que deja que una
 * orden que llega por la red encienda los motores.
 *
 * **Se apaga solo**, y a propósito por cualquier cosa que cambie lo que el
 * operador revisó: al despegar (vale una vez), al aterrizar, al cambiar la
 * batería, al perder el dron o el Comando Central, al cerrar la pantalla de
 * operación y a los [VENCIMIENTO_MS]. Quien lo apaga dice por qué, y el motivo
 * queda a la vista del operador.
 *
 * No tiene reloj propio: el momento lo pasa quien llama, para probar el
 * vencimiento sin dormir el test.
 */
class EsperaParaRelevos {

    companion object {
        /** VENCIMIENTO_ESPERA_MIN = 30: pasado esto, lo que se revisó ya es viejo. */
        const val VENCIMIENTO_MS = 30 * 60_000L
    }

    private val _prendido = MutableStateFlow(false)

    /** El interruptor, para la pantalla. */
    val prendido: StateFlow<Boolean> = _prendido

    private var desdeMs = 0L

    /** Lo prende el operador. Devuelve true si cambió. */
    @Synchronized
    fun prender(ahoraMs: Long): Boolean {
        if (_prendido.value) return false
        desdeMs = ahoraMs
        _prendido.value = true
        return true
    }

    /** Lo apaga el operador o una de las reglas. Devuelve true si estaba prendido. */
    @Synchronized
    fun apagar(): Boolean {
        if (!_prendido.value) return false
        _prendido.value = false
        return true
    }

    /** true si ya se cumplió el vencimiento (y entonces hay que apagarlo). */
    @Synchronized
    fun vencido(ahoraMs: Long): Boolean = _prendido.value && ahoraMs - desdeMs >= VENCIMIENTO_MS
}

/**
 * Si un dron puede salir de relevo (docs/RELEVOS.md §0, "Disponible para
 * relevo"). Se evalúa ENTERO en cada status y otra vez al recibir una orden y
 * antes de despegar: despegar es la única orden de un relevo que sale de la app
 * sin una persona que la apriete en ese momento, así que ante cualquier duda la
 * respuesta es no.
 *
 * Es pura: devuelve el primer motivo por el que NO está disponible (redactado
 * para el registro y para el `detalle` del rechazo), o null si lo está.
 */
object Disponibilidad {

    /** BATERIA_MINIMA_RELEVO_PCT: un dron con menos no sale a relevar a nadie. */
    const val BATERIA_MINIMA_PCT = 60.0

    /**
     * Modos de vuelo normales (`P-GPS`/`N`). Vacío es un controlador que no
     * informa modos (el simulado); el real lo informa apenas enlaza.
     */
    private val MODOS_NORMALES = setOf("", "GPS", "P-GPS", "P_GPS", "N", "NORMAL", "POSITION")

    data class Condiciones(
        val enEspera: Boolean,
        val dron: EstadoDelDron,
        val estado: PatrolState,
        val controlTomado: Boolean,
        val bateriaPorCambiar: Boolean,
        val bateriaPct: Double,
        val lat: Double,
        val lon: Double,
        /** La base propia según el último `bases`; null si no se sabe. */
        val basePropia: BaseDelHub?,
        /** Ya participa de un relevo (en cualquier rol). */
        val enUnRelevo: Boolean = false,
    )

    fun motivoParaNo(c: Condiciones): String? = when {
        !c.enEspera -> "el interruptor «En espera para relevos» está apagado"
        !c.dron.conectado -> "sin enlace con la aeronave"
        c.dron.enVuelo -> "el dron está en el aire"
        c.estado != PatrolState.IDLE -> "el patrullaje no está en reposo (${c.estado})"
        c.controlTomado -> "hay un control manual tomado"
        !c.dron.listoParaDespegar -> "el dron no está listo para despegar: ${c.dron.detalle.ifBlank { "sin GPS o sin punto de retorno" }}"
        c.dron.modoDeVuelo.trim().uppercase() !in MODOS_NORMALES -> "modo de vuelo ${c.dron.modoDeVuelo}, no el normal"
        c.bateriaPorCambiar -> "la batería está por cambiar"
        !c.bateriaPct.isFinite() -> "sin dato de batería"
        c.bateriaPct < BATERIA_MINIMA_PCT -> "batería al ${c.bateriaPct.toInt()} %"
        c.basePropia == null -> "no se sabe cuál es su base"
        !Autonomia.enLaBase(c.lat, c.lon, c.basePropia) -> "no está en su base"
        c.enUnRelevo -> "ya participa de un relevo"
        else -> null
    }

    fun disponible(c: Condiciones): Boolean = motivoParaNo(c) == null
}
