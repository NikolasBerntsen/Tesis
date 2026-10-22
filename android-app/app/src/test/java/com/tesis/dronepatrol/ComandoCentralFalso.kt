package com.tesis.dronepatrol

import android.os.Looper
import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.model.DroneBase
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.fail
import org.robolectric.Shadows.shadowOf

/**
 * Comando Central de mentira para las pantallas del login y del menú de campo.
 *
 * Es un interceptor de OkHttp que contesta él mismo, sin abrir ningún socket: el
 * cliente de verdad hace todo lo demás —arma el pedido, interpreta el código
 * HTTP, redacta el error—. Por eso no se reemplaza el cliente entero: lo que se
 * quiere ver es lo que la PANTALLA entiende de cada respuesta, y eso depende
 * del texto que el cliente arma. Que un 401 del emparejamiento termine en "se
 * venció la sesión" es justo un acople entre los dos que un cliente de mentira
 * escondería.
 */
internal class ComandoCentralFalso : Interceptor {

    companion object {
        const val URL = "https://comando.prueba"
        const val RUTA_LOGIN = "/api/auth/login"
        const val RUTA_LOGOUT = "/api/auth/logout"
        const val RUTA_EMPAREJAR = "/api/drones/pair"
        const val JWT_OPERADOR = "jwt-del-operador"
        const val TOKEN_DRON = "token-del-dron"
    }

    /** Lo que la app mandó: ruta, cuerpo JSON y el encabezado con el JWT. */
    data class Pedido(val url: String, val ruta: String, val cuerpo: JSONObject?, val autorizacion: String?)

    private class Respuesta(val codigo: Int, val cuerpo: String, val corte: IOException? = null)

    private val respuestas = ConcurrentHashMap<String, Respuesta>()
    private val recibidos = CopyOnWriteArrayList<Pedido>()

    /**
     * Si está puesta, cada pedido queda esperando a que el test la suelte: es
     * la forma de mirar la pantalla MIENTRAS el Comando Central no contestó.
     */
    @Volatile
    var retencion: CountDownLatch? = null

    /** El cliente de verdad, pero con este Comando Central del otro lado. */
    fun cliente(alcance: CoroutineScope): CommandCenterClient =
        CommandCenterClient(alcance, OkHttpClient.Builder().addInterceptor(this).build())

    fun responder(ruta: String, codigo: Int, cuerpo: String) {
        respuestas[ruta] = Respuesta(codigo, cuerpo)
    }

    /** El Comando Central no responde: la conexión se cae antes de llegar. */
    fun cortar(ruta: String, error: IOException) {
        respuestas[ruta] = Respuesta(0, "", error)
    }

    fun aceptarLogin(usuario: String = "operador.campo", rol: String = "field_operator", segundos: Long = 20L * 60) =
        responder(
            RUTA_LOGIN,
            200,
            JSONObject()
                .put("token", JWT_OPERADOR)
                .put("user", JSONObject().put("username", usuario).put("role", rol))
                .put("expiresIn", segundos)
                .toString(),
        )

    fun aceptarEmparejamiento(hash: String, nombre: String, modelo: String, base: DroneBase?) {
        val dron = JSONObject().put("hash", hash).put("displayName", nombre).put("model", modelo)
        if (base != null) dron.put("base", JSONObject().put("name", base.name).put("lat", base.lat).put("lon", base.lon))
        responder(RUTA_EMPAREJAR, 200, JSONObject().put("token", TOKEN_DRON).put("drone", dron).toString())
    }

    fun pedidos(ruta: String): List<Pedido> = recibidos.filter { it.ruta == ruta }

    override fun intercept(chain: Interceptor.Chain): Response {
        val pedido = chain.request()
        val cuerpo = pedido.body?.let { b -> Buffer().also { b.writeTo(it) }.readUtf8() }
        recibidos += Pedido(
            url = pedido.url.toString(),
            ruta = pedido.url.encodedPath,
            cuerpo = cuerpo?.takeIf { it.isNotBlank() }?.let { JSONObject(it) },
            autorizacion = pedido.header("Authorization"),
        )
        retencion?.await(10, TimeUnit.SECONDS)

        // El aviso de cierre sale "a la buena de Dios": cualquier 2xx le alcanza.
        val respuesta = respuestas[pedido.url.encodedPath]
            ?: if (pedido.url.encodedPath == RUTA_LOGOUT) Respuesta(204, "") else Respuesta(
                501,
                JSONObject().put("error", "el test no preparó respuesta para ${pedido.url.encodedPath}").toString(),
            )
        respuesta.corte?.let { throw it }
        return Response.Builder()
            .request(pedido)
            .protocol(Protocol.HTTP_1_1)
            .code(respuesta.codigo)
            .message("respuesta de prueba")
            .body(respuesta.cuerpo.toResponseBody("application/json".toMediaType()))
            .build()
    }
}

/**
 * Las llamadas al Comando Central salen por Dispatchers.IO y vuelven al hilo
 * principal, que en Robolectric no avanza solo: hay que hacerlo correr mientras
 * se espera. No adelanta el reloj, así que la cuenta regresiva de la sesión no
 * se mueve por esperar. El tope es holgado porque solo cuenta si algo falla: en
 * una máquina cargada el hilo de red puede tardar en tomar el pedido.
 */
internal fun esperarEnElHiloPrincipal(que: String, topeMs: Long = 10_000, condicion: () -> Boolean) {
    val limite = System.currentTimeMillis() + topeMs
    while (true) {
        shadowOf(Looper.getMainLooper()).idle()
        if (condicion()) return
        if (System.currentTimeMillis() > limite) fail("se agotó la espera de $que")
        Thread.sleep(10)
    }
}
