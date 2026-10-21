package com.tesis.dronepatrol.comms

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import java.net.DatagramSocket
import javax.net.SocketFactory

/**
 * Por qué red salen los sockets del enlace con la detección (docs/PROTOCOLS.md
 * §4). Existe por un caso de campo concreto: con la Wi-Fi del lugar SIN salida
 * a internet, Android pasa la red por defecto a los datos móviles, y un socket
 * sin red asignada sale por ahí y nunca llega a la notebook, que está en la
 * Wi-Fi. Atado a la Wi-Fi llega.
 */
interface RedLocal {
    /** Fábrica de sockets TCP de la red a usar; null para la red por defecto. */
    fun fabricaDeSockets(): SocketFactory?

    /** Ata un socket UDP a la red a usar; sin red particular lo deja como está. */
    fun atar(socket: DatagramSocket)
}

/** La red por defecto del sistema: lo de siempre, y lo que usan las pruebas. */
object RedPorDefecto : RedLocal {
    override fun fabricaDeSockets(): SocketFactory? = null
    override fun atar(socket: DatagramSocket) = Unit
}

/**
 * La Wi-Fi a la que está conectado el teléfono, si hay una. Con el teléfono
 * haciendo de hotspot no hay Wi-Fi cliente y se usa la red por defecto, que en
 * ese caso ya rutea la red del hotspot.
 *
 * Se busca la red en cada uso y no una vez: el teléfono puede cambiar de Wi-Fi
 * o perderla en medio de la operación.
 */
class RedWifi(context: Context) : RedLocal {

    private val conectividad = context.applicationContext.getSystemService(ConnectivityManager::class.java)

    @Suppress("DEPRECATION") // allNetworks: la alternativa es un callback, y acá alcanza con preguntar
    private fun wifi(): Network? = runCatching {
        conectividad?.allNetworks?.firstOrNull { red ->
            val capacidades = conectividad.getNetworkCapabilities(red) ?: return@firstOrNull false
            capacidades.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                !capacidades.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        }
    }.getOrNull()

    override fun fabricaDeSockets(): SocketFactory? = wifi()?.socketFactory

    override fun atar(socket: DatagramSocket) {
        val red = wifi() ?: return
        // Si no se puede atar (la red se fue entre la búsqueda y el bind), el
        // socket queda en la red por defecto: peor no puede estar.
        runCatching { red.bindSocket(socket) }
    }
}
