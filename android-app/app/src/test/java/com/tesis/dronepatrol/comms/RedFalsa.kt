package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.patrol.esperarA
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import okio.ByteString

/*
 * La red de mentira de las pruebas de comms. Ninguna prueba sale a la red: el
 * REST lo contesta un interceptor, los WebSocket los abre una fábrica que no
 * conecta nada, y el UDP del descubrimiento es un socket que nunca se ata. Lo
 * que se verifica es el contrato (docs/PROTOCOLS.md), que es lo que estos
 * falsos dejan ver: la ruta, el JWT, el cuerpo y el JSON exacto de cada lado.
 */

/** Un pedido REST tal como lo armó el cliente. */
internal data class PedidoRest(
    val metodo: String,
    val url: String,
    val autorizacion: String?,
    val tipo: String?,
    val cuerpo: String,
)

/**
 * El Comando Central de mentira para el REST: un interceptor de OkHttp que
 * contesta en lugar del servidor, así el pedido nunca llega a abrir una
 * conexión. Anota cada pedido y contesta lo que el test cargó para su ruta;
 * una ruta sin cargar da 404, como el backend.
 */
internal class ServidorFalso : Interceptor {

    private val respuestas = ConcurrentHashMap<String, Pair<Int, String>>()
    private val caidas = ConcurrentHashMap.newKeySet<String>()
    val pedidos = CopyOnWriteArrayList<PedidoRest>()

    /** El cliente HTTP que pasa por este servidor y por ningún otro lado. */
    val http: OkHttpClient = OkHttpClient.Builder().addInterceptor(this).build()

    fun contestar(ruta: String, codigo: Int, cuerpo: String) {
        respuestas[ruta] = codigo to cuerpo
    }

    /** El pedido a [ruta] falla como si se hubiera cortado la red. */
    fun cortar(ruta: String) {
        caidas += ruta
    }

    fun pedidosA(ruta: String): List<PedidoRest> = pedidos.filter { it.url.substringBefore('?').endsWith(ruta) }

    override fun intercept(chain: Interceptor.Chain): Response {
        val pedido = chain.request()
        val cuerpo = pedido.body?.let { b -> Buffer().also { b.writeTo(it) }.readUtf8() }.orEmpty()
        pedidos += PedidoRest(
            metodo = pedido.method,
            url = pedido.url.toString(),
            autorizacion = pedido.header("Authorization"),
            tipo = pedido.body?.contentType()?.toString(),
            cuerpo = cuerpo,
        )
        val ruta = pedido.url.encodedPath
        if (ruta in caidas) throw IOException("sin red")
        val (codigo, texto) = respuestas[ruta] ?: (404 to """{"error":"No existe $ruta"}""")
        return Response.Builder()
            .request(pedido)
            .protocol(Protocol.HTTP_1_1)
            .code(codigo)
            .message("falso")
            .body(texto.toResponseBody("application/json".toMediaType()))
            .build()
    }
}

/**
 * Un WebSocket que no conecta nada: anota lo que se le manda y cómo lo
 * cierran, y guarda el oyente para que el test le haga llegar a mano lo que
 * diría OkHttp (la apertura, un mensaje, una caída).
 */
internal class SocketFalso(private val pedido: Request, val oyente: WebSocketListener) : WebSocket {

    val enviados = CopyOnWriteArrayList<String>()

    @Volatile
    var codigoDeCierre: Int? = null

    override fun request(): Request = pedido
    override fun queueSize(): Long = 0L

    override fun send(text: String): Boolean {
        enviados += text
        return true
    }

    override fun send(bytes: ByteString): Boolean = false

    override fun close(code: Int, reason: String?): Boolean {
        codigoDeCierre = code
        return true
    }

    override fun cancel() = Unit

    /** La respuesta del handshake, que es lo que acompaña a la apertura y a algunas caídas. */
    fun respuesta(codigo: Int = 101): Response = Response.Builder()
        .request(pedido)
        .protocol(Protocol.HTTP_1_1)
        .code(codigo)
        .message("falso")
        .build()

    fun abrir() = oyente.onOpen(this, respuesta())
}

/** Abre [SocketFalso]s y los guarda en el orden en que se pidieron. */
internal class SocketsFalsos : WebSocket.Factory {
    val abiertos = CopyOnWriteArrayList<SocketFalso>()

    override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
        SocketFalso(request, listener).also { abiertos += it }
}

/** Un datagrama que mandó el descubridor: texto, destino y cuándo. */
internal data class DatagramaEnviado(val texto: String, val destino: InetAddress?, val puerto: Int, val ms: Long)

/**
 * El socket UDP del descubrimiento, de mentira: nunca se ata a un puerto ni
 * manda nada a la red. Entrega los datagramas que el test le encola (y, si no
 * hay, el timeout de la espera, como el real), anota lo que se manda y deja
 * simular un corte. Hereda de DatagramSocket porque es lo que el descubridor
 * maneja; el socket de la JDK que hay debajo queda sin atar y se cierra.
 */
internal class SocketUdpFalso : DatagramSocket(null as SocketAddress?) {

    private val entrantes = LinkedBlockingQueue<Any>()
    val enviados = CopyOnWriteArrayList<DatagramaEnviado>()
    val cierres = AtomicInteger()

    @Volatile
    var atadoA: SocketAddress? = null

    /** Si se carga, mandar falla con este error (sin red, por ejemplo). */
    @Volatile
    var fallaAlMandar: IOException? = null

    /** Llega un datagrama con [texto] desde [desde] (null: sin dirección de origen). */
    fun llega(texto: String, desde: String?) {
        entrantes += DatagramaEntrante(texto.toByteArray(Charsets.UTF_8), desde?.let(InetAddress::getByName))
    }

    /** La próxima espera se corta con este error, como un socket que se cae. */
    fun seCae(error: IOException) {
        entrantes += error
    }

    override fun bind(addr: SocketAddress?) {
        atadoA = addr
    }

    override fun receive(p: DatagramPacket) {
        if (isClosed) throw SocketException("Socket closed")
        when (val x = entrantes.poll(20, TimeUnit.MILLISECONDS)) {
            null -> throw SocketTimeoutException("Receive timed out")
            is IOException -> throw x
            is DatagramaEntrante -> {
                System.arraycopy(x.datos, 0, p.data, p.offset, x.datos.size)
                p.length = x.datos.size
                if (x.origen != null) p.address = x.origen
            }
        }
    }

    override fun send(p: DatagramPacket) {
        fallaAlMandar?.let { throw it }
        enviados += DatagramaEnviado(String(p.data, p.offset, p.length, Charsets.UTF_8), p.address, p.port, System.currentTimeMillis())
    }

    override fun close() {
        cierres.incrementAndGet()
        super.close()
    }

    private class DatagramaEntrante(val datos: ByteArray, val origen: InetAddress?)
}

/** Las corrutinas que [alcance] tiene en curso, para después esperar solo las nuevas. */
internal fun tareasDe(alcance: CoroutineScope): Set<Job> = alcance.coroutineContext.job.children.toSet()

/** Las corrutinas que [alcance] lanzó después de [antes]: un reintento agendado, por ejemplo. */
internal fun nuevasDe(alcance: CoroutineScope, antes: Set<Job>): List<Job> =
    alcance.coroutineContext.job.children.filter { it !in antes }.toList()

/**
 * Espera a que terminen las corrutinas que [alcance] lanzó después de [antes]:
 * los reintentos agendados. Es exacto y no depende de un tope de tiempo: si el
 * cliente agendó un reintento, esto espera a que corra; si no agendó ninguno,
 * vuelve en el acto. Ojo: no sirve si en el medio se lanzó algo que no
 * termina nunca (las escuchas del modo AUTO); para eso, [nuevasDe] y [esperar].
 */
internal fun esperarLasNuevas(alcance: CoroutineScope, antes: Set<Job>) = esperar(nuevasDe(alcance, antes))

internal fun esperar(tareas: List<Job>) = runBlocking { tareas.forEach { it.join() } }

/** [esperarA] de las pruebas del patrullaje, para usar fuera de una corrutina. */
internal fun esperarHasta(que: String, topeMs: Long = 5_000, condicion: () -> Boolean) =
    runBlocking { esperarA(que, topeMs, condicion) }
