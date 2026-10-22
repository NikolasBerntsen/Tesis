package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.model.PatrolRoute
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import org.json.JSONObject
import org.junit.Assert.fail

/**
 * Comando Central de mentira: anota cada mensaje que la app le manda, con el
 * JSON exacto que saldría por el socket. Los nombres de los campos son el
 * contrato (docs/PROTOCOLS.md), así que es eso lo que las pruebas miran.
 */
internal class ComandoCentralEspia(alcance: CoroutineScope) : CommandCenterClient(alcance) {

    private val enviados = mutableListOf<JSONObject>()

    override fun send(obj: JSONObject) {
        synchronized(enviados) { enviados += JSONObject(obj.toString()) }
    }

    fun mensajes(tipo: String): List<JSONObject> =
        synchronized(enviados) { enviados.filter { it.optString("type") == tipo } }

    fun eventos(tipo: String): List<JSONObject> = mensajes("event").filter { it.optString("eventType") == tipo }

    val alertas: List<JSONObject> get() = mensajes("alert_request")

    /**
     * Lo que contesta el Comando Central si la app vuelve a pedirle las rutas.
     * null es "sin Comando Central": la consulta falla, igual que la del
     * cliente real sin sesión, y PatrolManager se queda con las que tenía.
     */
    @Volatile
    var rutasDelServidor: List<PatrolRoute>? = null

    override suspend fun fetchRoutes(): List<PatrolRoute> =
        rutasDelServidor ?: error("sin Comando Central del otro lado")
}

/** Reloj del seguimiento que el test adelanta a mano (ver PatrolManager.reloj). */
internal class RelojFalso(@Volatile var ms: Long = System.currentTimeMillis()) {
    fun ahora(): Long = ms

    fun adelantar(deltaMs: Long) {
        ms += deltaMs
    }
}

/** Espera activa con tope: las órdenes de PatrolManager salen en corrutinas. */
internal suspend fun esperarA(que: String, topeMs: Long = 5_000, condicion: () -> Boolean) {
    val limite = System.currentTimeMillis() + topeMs
    while (!condicion()) {
        if (System.currentTimeMillis() > limite) fail("se agotó la espera de $que")
        delay(20)
    }
}
