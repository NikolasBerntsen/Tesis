package com.tesis.dronepatrol.patrol

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.tesis.dronepatrol.comms.MensajeDelHub
import com.tesis.dronepatrol.drone.EsperaCreciente
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import kotlin.math.sqrt
import org.json.JSONArray
import org.json.JSONObject

/**
 * Dónde guarda la cola de la emergencia lo que tiene pendiente. La cola tiene
 * que sobrevivir a un reinicio de la app (docs/PROTOCOLS.md §1.b, "Cola
 * persistente"): el teléfono se puede apagar justo después de que el dron bajó
 * en un lugar desconocido, y la última posición es lo único que permite ir a
 * buscarlo.
 */
interface AlmacenDeCola {
    /** Lo guardado la última vez, o null si no hay nada. */
    fun leer(): String?

    fun guardar(contenido: String)
}

/** El de la app: un archivo en el directorio privado. */
class AlmacenEnArchivo(private val archivo: File) : AlmacenDeCola {
    override fun leer(): String? = runCatching { archivo.takeIf { it.isFile }?.readText(Charsets.UTF_8) }.getOrNull()

    override fun guardar(contenido: String) {
        // Se escribe en uno temporal y se renombra: un corte a mitad de la
        // escritura no puede dejar la cola a medias y perder la emergencia.
        val temporal = File(archivo.parentFile, archivo.name + ".tmp")
        runCatching {
            temporal.writeText(contenido, Charsets.UTF_8)
            if (!temporal.renameTo(archivo)) {
                archivo.writeText(contenido, Charsets.UTF_8)
                temporal.delete()
            }
        }
    }
}

/** Sin disco: para las pruebas, y el valor por defecto de PatrolManager. */
class AlmacenEnMemoria(@Volatile var contenido: String? = null) : AlmacenDeCola {
    override fun leer(): String? = contenido

    override fun guardar(contenido: String) {
        this.contenido = contenido
    }
}

/**
 * La cola de los mensajes de una emergencia (`emergency_landing`,
 * `emergency_photo`, `emergency_landed`; docs/PROTOCOLS.md §1.b). Cada uno se
 * reintenta con espera creciente, de [REINTENTO_MINIMO_MS] a
 * [REINTENTO_MAXIMO_MS], hasta su acuse, y en este orden por emergencia:
 *
 *  1. `emergency_landing` primero, y nada más de esa emergencia antes de su
 *     acuse: sin él el hub no conoce el `ref` y descartaría el resto.
 *  2. `emergency_landed` antes que las fotos pendientes: la última posición es
 *     lo que el equipo de tierra necesita primero.
 *  3. Las fotos en orden de `seq`, cada una hasta su acuse.
 *
 * Sale de a uno por emergencia: el siguiente recién con el acuse del anterior,
 * así el orden de llegada es el de la cola aunque la red reordene.
 *
 * No tiene reloj propio: el momento lo pasa quien llama.
 */
class ColaDeEmergencia(private val almacen: AlmacenDeCola) {

    companion object {
        const val REINTENTO_MINIMO_MS = 5_000L
        const val REINTENTO_MAXIMO_MS = 60_000L
    }

    /** Lo que queda de una emergencia. */
    private class Emergencia(
        val ref: String,
        var landing: JSONObject?,
        var landingAcusado: Boolean = false,
        var emergencyId: Long? = null,
        var landed: JSONObject? = null,
        var aterrizajeAcusado: Boolean = false,
        val fotos: java.util.TreeMap<Int, JSONObject> = java.util.TreeMap(),
    )

    private val emergencias = mutableListOf<Emergencia>()

    /** La espera de cada mensaje, por clave (`ref`, tipo, seq). No se guarda: al reiniciar sale todo de nuevo. */
    private val esperas = HashMap<String, EsperaCreciente>()

    init {
        cargar()
    }

    /** Hay algo esperando acuse. */
    val hayPendientes: Boolean @Synchronized get() = emergencias.any { siguiente(it) != null }

    /** Una emergencia nueva: su `emergency_landing` ([landing], con su `ref`) queda primero. */
    @Synchronized
    fun abrir(landing: JSONObject) {
        val ref = landing.getString("ref")
        if (emergencias.any { it.ref == ref }) return
        emergencias += Emergencia(ref, JSONObject(landing.toString()))
        guardar()
    }

    @Synchronized
    fun agregarFoto(ref: String, foto: JSONObject) {
        val e = emergencias.firstOrNull { it.ref == ref } ?: return
        e.fotos.putIfAbsent(foto.getInt("seq"), JSONObject(foto.toString()))
        guardar()
    }

    @Synchronized
    fun agregarAterrizaje(ref: String, landed: JSONObject) {
        val e = emergencias.firstOrNull { it.ref == ref } ?: return
        if (e.aterrizajeAcusado) return
        e.landed = JSONObject(landed.toString())
        guardar()
    }

    /** Un `emergency_ack`: saca el `emergency_landing` y, con `aterrizada`, el `emergency_landed`. */
    @Synchronized
    fun alAcuse(acuse: MensajeDelHub.AcuseDeEmergencia): Boolean {
        val e = emergencias.firstOrNull { it.ref == acuse.ref } ?: return false
        e.landing = null
        e.landingAcusado = true
        e.emergencyId = acuse.emergencyId
        esperas.remove(clave(e.ref, "landing"))
        if (acuse.aterrizada) {
            e.landed = null
            e.aterrizajeAcusado = true
            esperas.remove(clave(e.ref, "landed"))
        }
        limpiar()
        guardar()
        return true
    }

    /** Un `emergency_photo_ack`: saca esa foto. */
    @Synchronized
    fun alAcuseDeFoto(acuse: MensajeDelHub.AcuseDeFoto): Boolean {
        val e = emergencias.firstOrNull { it.ref == acuse.ref } ?: return false
        if (e.fotos.remove(acuse.seq) == null) return false
        esperas.remove(clave(e.ref, "foto${acuse.seq}"))
        limpiar()
        guardar()
        return true
    }

    /**
     * Lo que toca mandar en [ahoraMs]: el primero pendiente de cada emergencia,
     * si ya pasó su espera. Cada uno que se devuelve cuenta como un intento sin
     * acuse todavía: la espera hasta el próximo se duplica.
     */
    @Synchronized
    fun aEnviar(ahoraMs: Long): List<JSONObject> = emergencias.mapNotNull { e ->
        val (clave, mensaje) = siguiente(e) ?: return@mapNotNull null
        val espera = esperas.getOrPut(clave) { EsperaCreciente(REINTENTO_MINIMO_MS, REINTENTO_MAXIMO_MS) }
        if (!espera.sePuedeIntentar(ahoraMs)) return@mapNotNull null
        espera.fracaso(ahoraMs)
        JSONObject(mensaje.toString())
    }

    /** Volvió el Comando Central: todo lo pendiente sale de nuevo sin esperar. */
    @Synchronized
    fun reconectado() {
        esperas.values.forEach { it.exito() }
    }

    /** Una posición guardada en la cola y si es la del aterrizaje. */
    data class Posicion(val lat: Double, val lon: Double, val aterrizada: Boolean)

    /**
     * La última posición conocida de la emergencia más reciente (la de
     * `emergency_landed` si ya está, si no la de `emergency_landing`), para
     * fijarla en la pantalla también después de un reinicio. null si no hay
     * ninguna o no tiene posición.
     */
    @Synchronized
    fun ultimaPosicion(): Posicion? {
        val e = emergencias.lastOrNull() ?: return null
        val o = e.landed ?: e.landing ?: return null
        if (o.isNull("lat") || o.isNull("lon")) return null
        return Posicion(o.getDouble("lat"), o.getDouble("lon"), aterrizada = e.landed != null)
    }

    private fun siguiente(e: Emergencia): Pair<String, JSONObject>? {
        e.landing?.let { return clave(e.ref, "landing") to it }
        if (!e.landingAcusado) return null
        e.landed?.let { return clave(e.ref, "landed") to it }
        val (seq, foto) = e.fotos.firstEntry()?.let { it.key to it.value } ?: return null
        return clave(e.ref, "foto$seq") to foto
    }

    private fun clave(ref: String, que: String) = "$ref/$que"

    /** Una emergencia aterrizada y con todo acusado ya no tiene nada que hacer en la cola. */
    private fun limpiar() {
        emergencias.removeAll { it.landingAcusado && it.aterrizajeAcusado && it.fotos.isEmpty() }
    }

    private fun guardar() {
        val lista = JSONArray()
        emergencias.forEach { e ->
            lista.put(
                JSONObject()
                    .put("ref", e.ref)
                    .put("landing", e.landing ?: JSONObject.NULL)
                    .put("landingAcusado", e.landingAcusado)
                    .put("emergencyId", e.emergencyId ?: JSONObject.NULL)
                    .put("landed", e.landed ?: JSONObject.NULL)
                    .put("aterrizajeAcusado", e.aterrizajeAcusado)
                    .put("fotos", JSONArray(e.fotos.values.toList())),
            )
        }
        almacen.guardar(JSONObject().put("emergencias", lista).toString())
    }

    /** Lo guardado se lee entero o no se lee: un archivo roto no puede tirar la app en pleno vuelo. */
    private fun cargar() {
        val texto = almacen.leer() ?: return
        val lista = runCatching { JSONObject(texto).getJSONArray("emergencias") }.getOrNull() ?: return
        val leidas = runCatching {
            (0 until lista.length()).map { i ->
                val o = lista.getJSONObject(i)
                val fotos = o.getJSONArray("fotos")
                Emergencia(
                    ref = o.getString("ref"),
                    landing = o.optJSONObject("landing"),
                    landingAcusado = o.getBoolean("landingAcusado"),
                    emergencyId = if (o.isNull("emergencyId")) null else o.getLong("emergencyId"),
                    landed = o.optJSONObject("landed"),
                    aterrizajeAcusado = o.getBoolean("aterrizajeAcusado"),
                ).also { e ->
                    (0 until fotos.length()).forEach { j ->
                        val f = fotos.getJSONObject(j)
                        e.fotos[f.getInt("seq")] = f
                    }
                }
            }
        }.getOrNull() ?: return
        emergencias += leidas
    }
}

/**
 * La foto de una emergencia en el formato del contrato: un JPEG en base64 de
 * hasta [TOPE_CARACTERES] caracteres que empieza con `/9j/`. Sale del cuadro
 * para la detección (1280 px), y si no entra se reescala y se recomprime hasta
 * que entre (docs/PROTOCOLS.md §1.b, `jpegBase64`).
 */
object FotoDeEmergencia {

    const val TOPE_CARACTERES = 400_000
    private const val CALIDAD = 70
    private const val INTENTOS = 5

    /**
     * null si [jpeg] no es un JPEG o no hubo forma de que entre. [reescalar]
     * achica el JPEG a una escala (0..1) y lo recomprime; es un parámetro para
     * probar los reintentos sin decodificar imágenes de verdad.
     */
    fun aBase64(
        jpeg: ByteArray?,
        tope: Int = TOPE_CARACTERES,
        reescalar: (ByteArray, Double) -> ByteArray? = ::reescalarConBitmap,
    ): String? {
        if (jpeg == null || jpeg.size < 3 || jpeg[0] != 0xFF.toByte() || jpeg[1] != 0xD8.toByte()) return null
        val directo = Base64.getEncoder().encodeToString(jpeg)
        if (directo.length <= tope) return directo
        // Cada intento achica un 30 % más el lado: el tamaño baja con el área.
        var escala = sqrt(tope.toDouble() / directo.length) * 0.9
        repeat(INTENTOS) {
            val texto = reescalar(jpeg, escala)?.let { Base64.getEncoder().encodeToString(it) }
            if (texto != null && texto.length <= tope && texto.startsWith(PREFIJO)) return texto
            escala *= 0.7
        }
        return null
    }

    /** El prefijo de un JPEG en base64 (FF D8 FF): el hub lo exige. */
    private const val PREFIJO = "/9j/"

    private fun reescalarConBitmap(jpeg: ByteArray, escala: Double): ByteArray? {
        val original = runCatching { BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) }.getOrNull() ?: return null
        val ancho = (original.width * escala).toInt().coerceAtLeast(16)
        val alto = (original.height * escala).toInt().coerceAtLeast(16)
        val salida = ByteArrayOutputStream()
        Bitmap.createScaledBitmap(original, ancho, alto, true).compress(Bitmap.CompressFormat.JPEG, CALIDAD, salida)
        return salida.toByteArray()
    }
}
