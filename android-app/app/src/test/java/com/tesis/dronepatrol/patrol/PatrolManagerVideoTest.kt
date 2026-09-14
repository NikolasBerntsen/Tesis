package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
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
 * El reparto del video que fija el contrato §1: TODOS los cuadros al Comando
 * Central —es el video que mira el operador y con el que decide— y a la detección
 * uno cada [PatrolManager.INTERVALO_DETECCION_MS], dos por segundo como techo,
 * porque está del otro lado del enlace más flojo de los tres.
 *
 * Dos cosas se prueban acá y son distintas:
 *
 *  - el REPARTO, con el reloj en la mano del test (el techo es por tiempo y sin
 *    un reloj de mentira no hay forma de pararse en el borde); y
 *  - el CABLEADO de `start()`, que es dónde se decide quién es quién. Los dos
 *    casos del reparto le pasaban lambdas propias al helper, así que dar vuelta
 *    los dos destinos adentro de `start()` —el operador mirando el flujo raleado
 *    y la laptop recibiéndolo entero, justo al revés del contrato— los dejaba
 *    verdes igual. Por eso el último caso arranca el patrullaje de verdad y mira
 *    lo que cada cliente intenta mandar.
 *
 * Usa Robolectric porque el reparto codifica cada cuadro en Base64, que es de
 * android.util.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerVideoTest {

    /** Dron de mentira: lo único que hace es dejar que el test emita cuadros. */
    private class DronDeMentira : DroneController {
        val cuadros = MutableSharedFlow<ByteArray>(extraBufferCapacity = 64)
        override val telemetry = MutableSharedFlow<Telemetry>(replay = 1)
        override val videoFrames: SharedFlow<ByteArray> get() = cuadros
        override val flightEvents = MutableSharedFlow<FlightEvent>(extraBufferCapacity = 8)

        override fun connect() = Unit
        override fun startRoute(route: PatrolRoute, fromWaypoint: Int) = Unit
        override fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double) = Unit
        override fun hold() = Unit
        override fun gotoPoint(lat: Double, lon: Double) = Unit
        override fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double) = Unit
        override fun returnHome() = Unit
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

    /**
     * Diez cuadros del dron real son dos segundos (5 por segundo): el operador
     * tiene que recibir los diez y la detección los que entren en el techo de uno
     * cada 500 ms. Sobre un flujo de 200 ms eso es uno de cada tres: el techo se
     * respeta por abajo, que es del lado que hay que errar.
     */
    @Test
    fun elComandoCentralRecibeTodosLosCuadrosYLaDeteccionUnoCada500Ms() = runBlocking {
        arrancarElReparto()

        emitirCuadros(cantidad = 10, cadaMs = 200)
        esperarA("los 10 cuadros al Comando Central") { recibidos(alComandoCentral).size == 10 }

        val todos = recibidos(alComandoCentral)
        assertEquals("el operador mira todos los cuadros", 10, todos.size)
        // Aceptados en 0, 600, 1200 y 1800 ms: el limitador solo puede aceptar en
        // múltiplos de los 200 ms de origen.
        assertEquals(listOf(todos[0], todos[3], todos[6], todos[9]), recibidos(aLaDeteccion))
    }

    /**
     * El techo es del enlace con la laptop y no una fracción del ritmo del
     * controlador: si mañana el dron emitiera el doble, la detección NO puede
     * recibir el doble. Contando cuadros —uno de cada dos— este mismo flujo de 10
     * por segundo le mandaba 5, dos veces y media el techo pactado, sin que nada
     * lo frene.
     */
    @Test
    fun elTechoDeLaDeteccionNoSeMueveSiElControladorEmiteElDoble() = runBlocking {
        arrancarElReparto()

        emitirCuadros(cantidad = 20, cadaMs = 100) // 10 por segundo durante 2 s
        esperarA("los 20 cuadros al Comando Central") { recibidos(alComandoCentral).size == 20 }

        assertEquals("el operador sigue mirando todo", 20, recibidos(alComandoCentral).size)
        // Aceptados en 0, 500, 1000 y 1500 ms
        assertEquals(
            "a la detección le entró más que el techo de dos por segundo",
            4,
            recibidos(aLaDeteccion).size,
        )
    }

    /**
     * El cableado real, el que decide quién es quién: `start()` y los dos clientes
     * de verdad. Si se dan vuelta los dos destinos (PatrolManager.start()), el
     * Comando Central pasa a recibir el flujo raleado y la detección el entero, y
     * este caso es el único que lo ve.
     */
    @Test
    fun startLeMandaTodoAlComandoCentralYSoloLoRaleadoALaDeteccion() = runBlocking {
        patrulla.start()
        withTimeout(5_000) { dron.cuadros.subscriptionCount.first { it > 0 } }

        // Los diez cuadros salen de corrido, así que el techo de 500 ms del reloj
        // real deja pasar uno solo a la detección: alcanza para distinguir quién
        // recibe el flujo entero y quién el raleado, que es lo único que se mide acá.
        repeat(10) { i -> dron.cuadros.emit(byteArrayOf(i.toByte())) }
        esperarA("los 10 cuadros al Comando Central") { comandoCentral.cuadros.size == 10 }

        assertEquals("el operador tiene que recibir el flujo entero", 10, comandoCentral.cuadros.size)
        assertTrue(
            "a la detección le llegó el flujo entero: los destinos están al revés",
            deteccion.cuadros.size < 10,
        )
        assertTrue("a la detección no le llegó ni un cuadro", deteccion.cuadros.isNotEmpty())
    }

    private suspend fun arrancarElReparto() {
        alcance.launch {
            patrulla.repartirVideo(
                alComandoCentral = { cuadro -> synchronized(alComandoCentral) { alComandoCentral += cuadro } },
                aLaDeteccion = { cuadro -> synchronized(aLaDeteccion) { aLaDeteccion += cuadro } },
                ahoraMs = { relojMs },
            )
        }
        // Recién cuando el reparto está suscripto tiene sentido emitir
        withTimeout(5_000) { dron.cuadros.subscriptionCount.first { it > 0 } }
    }

    /**
     * Emite [cantidad] cuadros separados [cadaMs] en el reloj de mentira. Se
     * espera a que cada uno se reparta antes de adelantar el reloj: el reparto
     * corre en otra corrutina y sin eso el tiempo que ve no es el que el test cree.
     */
    private suspend fun emitirCuadros(cantidad: Int, cadaMs: Long) {
        repeat(cantidad) { i ->
            relojMs = i * cadaMs
            dron.cuadros.emit(byteArrayOf(i.toByte()))
            esperarA("el cuadro ${i + 1}") { recibidos(alComandoCentral).size == i + 1 }
        }
    }

    private fun recibidos(destino: MutableList<String>): List<String> = synchronized(destino) { destino.toList() }

    private suspend fun esperarA(que: String, condicion: () -> Boolean) {
        val limite = System.currentTimeMillis() + 5_000
        while (!condicion()) {
            if (System.currentTimeMillis() > limite) fail("se agotó la espera de $que")
            delay(20)
        }
    }
}
