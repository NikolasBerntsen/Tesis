package com.tesis.dronepatrol.comms

import java.io.File
import org.json.JSONObject

/**
 * Los ejemplos del contrato de relevos y emergencias
 * (`docs/contrato/relevos.json`, docs/PROTOCOLS.md §1.b, §2.b, §3 y §5). Es el
 * MISMO archivo que leen las pruebas del backend: si una punta cambia un nombre
 * y la otra no, las dos se enteran por acá y no en el campo.
 *
 * La ruta es relativa al módulo `android-app/app`, que es el directorio de
 * trabajo de las pruebas unitarias. Usa org.json, así que la prueba que lo lea
 * tiene que correr con Robolectric (el org.json de android.jar es de mentira).
 */
internal object ContratoDeRelevos {

    const val RUTA = "../../docs/contrato/relevos.json"

    const val APP_AL_HUB = "app_al_hub"
    const val HUB_A_LA_APP = "hub_a_la_app"
    const val HUB_A_LA_CONSOLA = "hub_a_la_consola"

    /** Un ejemplo inválido y por qué lo es. */
    data class Invalido(val caso: String, val porque: String, val mensaje: JSONObject)

    val raiz: JSONObject by lazy { JSONObject(File(RUTA).readText(Charsets.UTF_8)) }

    /** Los mensajes de una dirección, por `type`. */
    fun mensajes(direccion: String): JSONObject = raiz.getJSONObject("mensajes").getJSONObject(direccion)

    fun tipos(direccion: String): Set<String> = mensajes(direccion).keys().asSequence().toSet()

    fun validos(direccion: String, tipo: String): List<JSONObject> {
        val lista = mensajes(direccion).getJSONObject(tipo).getJSONArray("validos")
        return (0 until lista.length()).map { lista.getJSONObject(it).getJSONObject("mensaje") }
    }

    fun invalidos(direccion: String, tipo: String): List<Invalido> {
        val lista = mensajes(direccion).getJSONObject(tipo).optJSONArray("invalidos") ?: return emptyList()
        return (0 until lista.length()).map {
            val o = lista.getJSONObject(it)
            Invalido(o.getString("caso"), o.getString("porque"), o.getJSONObject("mensaje"))
        }
    }

    /** Un valor de `limites` o de `plazos`. */
    fun limite(nombre: String): Long = raiz.getJSONObject("limites").getLong(nombre)

    fun plazoMs(nombre: String): Long = raiz.getJSONObject("plazos").getLong(nombre)

    /** Una lista de `enumerados` (las que son listas planas de texto). */
    fun enumerado(nombre: String): List<String> {
        val lista = raiz.getJSONObject("enumerados").getJSONArray(nombre)
        return (0 until lista.length()).map { lista.getString(it) }
    }
}
