package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El reparto del video que fija el contrato §1: el flujo de la consola
 * ([DroneController.videoFrames]) va ENTERO al Comando Central —es el video que
 * mira el operador y con el que decide— y el de la detección
 * ([DroneController.cuadrosParaDeteccion]) va al software de detección con un
 * techo de uno cada [PatrolManager.INTERVALO_DETECCION_MS], dos por segundo,
 * porque está del otro lado del enlace más flojo de los tres.
 *
 * Tres cosas se prueban acá y son distintas:
 *
 *  - que cada flujo va a SU destino y no al otro;
 *  - el TECHO, con el reloj en la mano del test (es por tiempo y sin un reloj
 *    de mentira no hay forma de pararse en el borde); y
 *  - el CABLEADO de `start()`, que es dónde se decide quién es quién. Los casos
 *    del reparto le pasan lambdas propias al helper, así que dar vuelta los dos
 *    destinos adentro de `start()` los dejaba verdes igual. Por eso el último
 *    caso arranca el patrullaje de verdad y mira lo que cada cliente intenta
 *    mandar.
 *
 * Usa Robolectric porque el reparto codifica cada cuadro en Base64, que es de
 * android.util.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerVideoTest {

    /** Dron de mentira: lo único que hace es dejar que el test emita cuadros en los dos flujos. */
    private class DronDeMentira : DroneController {
        val cuadros = MutableSharedFlow<ByteArray>(extraBufferCapacity = 64)
        val cuadrosDeteccion = MutableSharedFlow<ByteArray>(extraBufferCapacity = 64)
        override val estado = MutableStateFlow(
            EstadoDelDron(sdkListo = true, conectado = true, modelo = "Mentira", enVuelo = true, satelites = 14, baseFijada = true),
        )
        override val telemetry = MutableSharedFlow<Telemetry>(replay = 1)
        override val videoFrames: SharedFlow<ByteArray> get() = cuadros
        override val cuadrosParaDeteccion: SharedFlow<ByteArray> get() = cuadrosDeteccion
        override val flightEvents = MutableSharedFlow<FlightEvent>(extraBufferCapacity = 8)

        override fun connect() = Unit
        override fun startRoute(route: PatrolRoute, fromWaypoint: Int) = Unit
        override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double) = Unit
        override fun hold() = Unit
        override fun gotoPoint(lat: Double, lon: Double) = Unit
        override fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) = Unit
        override fun returnHome() = Unit
        override fun land() = Unit
        override fun disconnect() = Unit
    }

    /**
     * Los dos clientes de verdad, con el envío anotado en vez de puesto en un
     * socket que no existe. Es la única forma de ver a cuál de los dos destinos
     * cableó `start()` cada cuadro.
     */
    private class ComandoCentralQueAnota(alcance: CoroutineScope) : CommandCenterClient(alcance) {
        private val recibidos = mutableListOf<String>()
        val cuadros: List<String> get() = synchronized(recibidos) { recibidos.toList() }
        override fun sendVideoFrame(jpegBase64: String) {
            synchronized(recibidos) { recibidos += jpegBase64 }
        }
    }

    private class DeteccionQueAnota(alcance: CoroutineScope) : DetectionClient(alcance) {
        private val recibidos = mutableListOf<String>()
        val cuadros: List<String> get() = synchronized(recibidos) { recibidos.toList() }
        override fun sendFrame(jpegBase64: String) {
            synchronized(recibidos) { recibidos += jpegBase64 }
        }
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronDeMentira()
    private val comandoCentral = ComandoCentralQueAnota(alcance)
    private val deteccion = DeteccionQueAnota(alcance)
    private val patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST")

    // Los dos destinos los toca el hilo del reparto y los lee el del test
    private val alComandoCentral = mutableListOf<String>()
    private val aLaDeteccion = mutableListOf<String>()

    /** Reloj de mentira: lo adelanta el test, un paso por cuadro emitido. */
    @Volatile
    private var relojMs = 0L

    @After
    fun desarmar() {
        alcance.cancel()
    }

    /** Diez cuadros de la consola son dos segundos (5 por segundo): el operador recibe los diez y la detección ninguno. */
    @Test
    fun elComandoCentralRecibeTodosLosCuadrosDeLaConsolaYLaDeteccionNinguno() = runBlocking {
        arrancarElReparto()

        emitirCuadrosDeConsola(cantidad = 10, cadaMs = 200)

        assertEquals("el operador mira todos los cuadros", 10, recibidos(alComandoCentral).size)
        assertTrue("la detección no recibe el flujo de la consola", recibidos(aLaDeteccion).isEmpty())
    }

    /**
     * El flujo de la detección llega ya raleado a uno cada 500 ms y pasa
     * entero: el techo se cumple justo. Y no se cruza al Comando Central.
     */
    @Test
    fun losCuadrosDeDeteccionVanALaDeteccionYNoAlComandoCentral() = runBlocking {
        arrancarElReparto()

        emitirCuadrosDeDeteccion(cantidad = 4, cadaMs = 500)

        assertEquals(4, recibidos(aLaDeteccion).size)
        assertTrue("el Comando Central no recibe el flujo de la detección", recibidos(alComandoCentral).isEmpty())
    }

    /**
     * El techo es del enlace con la laptop y no una promesa del controlador: si
     * uno emitiera cinco por segundo, la detección NO puede recibir cinco. Sobre
     * cuadros cada 200 ms el limitador acepta en múltiplos de 200: 0, 600, 1200 y
     * 1800 ms, uno de cada tres. Por abajo del techo, que es del lado que hay que
     * errar.
     */
    @Test
    fun elTechoDeLaDeteccionSeSostieneAunqueElControladorEmitaDeMas() = runBlocking {
        arrancarElReparto()

        emitirCuadrosDeDeteccion(cantidad = 10, cadaMs = 200)

        val todos = emitidosADeteccion
        assertEquals(listOf(todos[0], todos[3], todos[6], todos[9]), recibidos(aLaDeteccion))
    }

    /**
     * El cableado real, el que decide quién es quién: `start()` y los dos clientes
     * de verdad. Si se dan vuelta los dos destinos (PatrolManager.start()), el
     * Comando Central pasa a recibir los cuadros de la detección y la laptop los
     * de la consola, y este caso es el único que lo ve.
     */
    @Test
    fun startLeMandaLaConsolaAlComandoCentralYLaDeteccionALaLaptop() = runBlocking {
        patrulla.start()
        withTimeout(5_000) { dron.cuadros.subscriptionCount.first { it > 0 } }
        withTimeout(5_000) { dron.cuadrosDeteccion.subscriptionCount.first { it > 0 } }

        repeat(10) { i -> dron.cuadros.emit(byteArrayOf(i.toByte())) }
        dron.cuadrosDeteccion.emit(byteArrayOf(100))
        esperarA("los 10 cuadros al Comando Central") { comandoCentral.cuadros.size == 10 }
        esperarA("el cuadro a la detección") { deteccion.cuadros.size == 1 }

        assertEquals("el operador tiene que recibir el flujo de la consola entero", 10, comandoCentral.cuadros.size)
        assertEquals(listOf(b64(byteArrayOf(100))), deteccion.cuadros)
    }

    private suspend fun arrancarElReparto() {
        alcance.launch {
            patrulla.repartirVideo(
                alComandoCentral = { cuadro -> synchronized(alComandoCentral) { alComandoCentral += cuadro } },
                aLaDeteccion = { cuadro -> synchronized(aLaDeteccion) { aLaDeteccion += cuadro } },
                ahoraMs = { relojMs },
            )
        }
        // Recién cuando el reparto está suscripto a los dos flujos tiene sentido emitir
        withTimeout(5_000) { dron.cuadros.subscriptionCount.first { it > 0 } }
        withTimeout(5_000) { dron.cuadrosDeteccion.subscriptionCount.first { it > 0 } }
    }

    private suspend fun emitirCuadrosDeConsola(cantidad: Int, cadaMs: Long) {
        repeat(cantidad) { i ->
            relojMs = i * cadaMs
            dron.cuadros.emit(byteArrayOf(i.toByte()))
            esperarA("el cuadro ${i + 1}") { recibidos(alComandoCentral).size == i + 1 }
        }
    }

    /** Lo que se emitió a la detección, ya en Base64, para comparar con lo que llegó. */
    private val emitidosADeteccion = mutableListOf<String>()

    /**
     * Emite [cantidad] cuadros separados [cadaMs] en el reloj de mentira. Como
     * el limitador descarta sin avisar, después de cada emisión se le da al
     * reparto un instante para procesarla antes de adelantar el reloj: el reparto
     * corre en otra corrutina y sin eso el tiempo que ve no es el que el test cree.
     */
    private suspend fun emitirCuadrosDeDeteccion(cantidad: Int, cadaMs: Long) {
        repeat(cantidad) { i ->
            relojMs = i * cadaMs
            val cuadro = byteArrayOf((50 + i).toByte())
            emitidosADeteccion += b64(cuadro)
            dron.cuadrosDeteccion.emit(cuadro)
            delay(30)
        }
    }

    private fun b64(bytes: ByteArray): String = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)

    private fun recibidos(destino: MutableList<String>): List<String> = synchronized(destino) { destino.toList() }

    private suspend fun esperarA(que: String, condicion: () -> Boolean) {
        val limite = System.currentTimeMillis() + 5_000
        while (!condicion()) {
            if (System.currentTimeMillis() > limite) fail("se agotó la espera de $que")
            delay(20)
        }
    }
}
