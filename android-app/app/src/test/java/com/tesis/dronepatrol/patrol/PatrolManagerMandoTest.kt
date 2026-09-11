package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.SimulatedDroneController
import com.tesis.dronepatrol.model.PatrolState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Mando virtual visto desde la máquina de estados: cuándo se aplica, cuándo se
 * ignora y qué hace el watchdog cuando el mando se calla.
 *
 * El armado es el de la app de verdad —dron simulado y los dos clientes— salvo
 * que ninguno de los clientes se conecta: sin `connect()` su WebSocket es null y
 * todo lo que "mandan" cae al vacío, así que las órdenes del Comando Central se
 * disparan invocando sus callbacks a mano, igual que las manda el socket.
 *
 * Usa Robolectric porque el video del simulado dibuja con android.graphics y el
 * reparto de cuadros codifica en Base64; los tiempos son reales (tick de 500 ms).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerMandoTest {

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = SimulatedDroneController()
    private val comandoCentral = CommandCenterClient(alcance)
    private val deteccion = DetectionClient(alcance)
    private lateinit var patrulla: PatrolManager

    @Before
    fun armar() {
        patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST")
        patrulla.start()
        dron.connect()
    }

    @After
    fun desarmar() {
        dron.disconnect()
        alcance.cancel()
    }

    /** Sin control tomado no hay mando que valga: el dron sigue en lo suyo. */
    @Test
    fun elMandoSeIgnoraFueraDeManual() = runBlocking {
        val antes = withTimeout(5_000) { dron.telemetry.first() }
        assertEquals(PatrolState.IDLE, patrulla.state.value)

        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 1.0, "operador1")
        delay(1_500)

        val despues = dron.telemetry.first()
        assertEquals("no tendría que haberse movido", antes.lat, despues.lat, 1e-12)
        assertEquals(antes.lon, despues.lon, 1e-12)
        assertEquals("ni haber subido", antes.altM, despues.altM, 1e-12)
    }

    @Test
    fun enManualElMandoLlegaAlDron() = runBlocking {
        tomarElControl()
        val antes = withTimeout(5_000) { dron.telemetry.first() }

        comandoCentral.onManualStick?.invoke(0.0, 0.0, 0.0, 1.0, "operador1")
        delay(1_200)

        val despues = dron.telemetry.first()
        assertTrue("altura antes=${antes.altM} después=${despues.altM}", despues.altM > antes.altM + 1.0)
    }

    /**
     * La red de seguridad: se corta el internet del celular en pleno movimiento
     * y no llega ningún mando más. El dron no puede quedarse con la última
     * velocidad, así que la app le manda ceros por su cuenta.
     */
    @Test
    fun elWatchdogMandaCerosCuandoElMandoSeCalla() = runBlocking {
        tomarElControl()

        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")
        // A partir de acá nadie manda nada: el watchdog tiene que saltar solo
        withTimeout(10_000) { patrulla.localLog.first { it.contains("no llegan órdenes de mando") } }

        delay(1_200) // que termine de frenar el tick en curso
        val frenado = dron.telemetry.first()
        delay(1_500)
        val despues = dron.telemetry.first()
        assertEquals("tendría que haber quedado quieto", frenado.lat, despues.lat, 1e-12)
        assertEquals(frenado.lon, despues.lon, 1e-12)
    }

    /** Mientras el mando siga llegando, el watchdog no tiene nada que hacer. */
    @Test
    fun elWatchdogNoSaltaSiElMandoSigueLlegando() = runBlocking {
        tomarElControl()

        // Cuatro segundos de mando sostenido a 10 Hz, como manda la consola
        repeat(40) {
            comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")
            delay(100)
        }

        val avisos = patrulla.localLog.replayCache.filter { it.contains("no llegan órdenes de mando") }
        assertTrue("el watchdog no tendría que haber saltado: $avisos", avisos.isEmpty())
    }

    /** Deja el patrullaje en MANUAL, que es el único estado que acepta mando. */
    private suspend fun tomarElControl() {
        comandoCentral.onControlTaken?.invoke("operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
    }
}
