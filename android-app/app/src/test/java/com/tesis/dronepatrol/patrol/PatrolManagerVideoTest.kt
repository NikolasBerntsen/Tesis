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
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El reparto del video que fija el contrato §1: TODOS los cuadros al Comando
 * Central —es el video que mira el operador y con el que decide— y uno de cada
 * [PatrolManager.UNO_DE_CADA_N_A_DETECCION] al software de detección, que está
 * del otro lado del enlace más flojo de los tres.
 *
 * Lo que se mide es a cuál de las dos salidas va cada cuadro, así que el dron es
 * de mentira y los cuadros los emite el test: sin esto, dar vuelta los dos
 * destinos dejaba al operador mirando 2,5 fps y a la laptop recibiendo el flujo
 * entero —justo al revés del contrato— y CI pasaba igual.
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

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronDeMentira()
    private val patrulla = PatrolManager(
        dron,
        CommandCenterClient(alcance),
        DetectionClient(alcance),
        alcance,
        "TEST",
    )

    // Los dos destinos los toca el hilo del reparto y los lee el del test
    private val alComandoCentral = mutableListOf<String>()
    private val aLaDeteccion = mutableListOf<String>()

    @After
    fun desarmar() {
        alcance.cancel()
    }

    /**
     * Diez cuadros son dos segundos del dron real (5 por segundo): el operador
     * tiene que recibir los diez y la detección cinco, o sea los 2,5 cuadros por
     * segundo que promete el reparto.
     */
    @Test
    fun elComandoCentralRecibeTodosLosCuadrosYLaDeteccionUnoDeCadaDos() = runBlocking {
        arrancarElReparto()

        repeat(10) { i -> dron.cuadros.emit(byteArrayOf(i.toByte())) }
        esperarA("los 10 cuadros al Comando Central") { recibidos(alComandoCentral).size == 10 }

        assertEquals("el operador mira todos los cuadros", 10, recibidos(alComandoCentral).size)
        assertEquals("a la detección va uno de cada dos", 5, recibidos(aLaDeteccion).size)
    }

    /** Y son los cuadros del flujo, no cinco cualesquiera: el 1°, el 3°, el 5°... */
    @Test
    fun aLaDeteccionVanLosCuadrosImparesDelFlujo() = runBlocking {
        arrancarElReparto()

        repeat(6) { i -> dron.cuadros.emit(byteArrayOf(i.toByte())) }
        esperarA("los 6 cuadros al Comando Central") { recibidos(alComandoCentral).size == 6 }

        val todos = recibidos(alComandoCentral)
        assertEquals(listOf(todos[0], todos[2], todos[4]), recibidos(aLaDeteccion))
    }

    private suspend fun arrancarElReparto() {
        alcance.launch {
            patrulla.repartirVideo(
                alComandoCentral = { cuadro -> synchronized(alComandoCentral) { alComandoCentral += cuadro } },
                aLaDeteccion = { cuadro -> synchronized(aLaDeteccion) { aLaDeteccion += cuadro } },
            )
        }
        // Recién cuando el reparto está suscripto tiene sentido emitir
        withTimeout(5_000) { dron.cuadros.subscriptionCount.first { it > 0 } }
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
