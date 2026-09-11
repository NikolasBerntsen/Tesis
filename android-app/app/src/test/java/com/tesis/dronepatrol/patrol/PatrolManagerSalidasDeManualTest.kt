package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Waypoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
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
 * Qué le queda ordenado al dron cuando el patrullaje SALE del control manual.
 *
 * Es el defecto más caro que encontró el contraste: el dron sostiene la última
 * velocidad comandada hasta que le llegue otra, así que salir de MANUAL sin
 * frenarlo —por pérdida de señal, por batería, por lo que sea— lo deja andando
 * con nadie al mando. Acá el dron es un espía que anota cada orden: es la única
 * forma de distinguir "se lo frenó al salir" de "se quedó quieto de casualidad".
 *
 * Usa Robolectric porque el reparto de cuadros de PatrolManager codifica en
 * Base64, que es de android.util; los tiempos son reales (el corte de señal se
 * declara a los 4 s).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerSalidasDeManualTest {

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = CommandCenterClient(alcance)
    private val deteccion = DetectionClient(alcance)
    private lateinit var patrulla: PatrolManager

    private val ruta = PatrolRoute(
        id = 7,
        name = "De prueba",
        waypoints = listOf(Waypoint(-34.60, -58.38, 40.0), Waypoint(-34.61, -58.39, 40.0)),
    )

    @Before
    fun armar() {
        patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST")
        patrulla.start()
    }

    @After
    fun desarmar() {
        alcance.cancel()
    }

    /**
     * El corte del enlace de radio dron↔control con el operador manteniendo la
     * palanca a fondo. Ojo: el celular sigue online, así que la consola SIGUE
     * mandando el mando a 10 Hz — por eso el watchdog no tiene de qué quejarse y
     * la única forma de que el dron quede quieto es que la salida de MANUAL lo
     * frene. Sin eso, el lazo de Virtual Stick le repetía los últimos 5 m/s para
     * siempre y el dron retomaba la marcha apenas se reenganchaba el enlace.
     */
    @Test
    fun perderLaSenialConLaPalancaTomadaDejaAlDronQuieto() = runBlocking {
        tomarElControl()
        val palanca = mantenerLaPalanca(pitch = 1.0)

        // Se deja de emitir telemetría: eso es el corte del enlace de radio
        withTimeout(12_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_SIGNAL } }
        palanca.cancel()

        assertTrue(
            "al salir de MANUAL el dron quedó comandado a la última velocidad: ${dron.ultimaOrden}",
            dron.laUltimaOrdenLoDejaQuieto(),
        )
    }

    /** Soltar el control también lo deja quieto, y con un estado del que se puede salir. */
    @Test
    fun soltarElControlDejaAlDronQuieto() = runBlocking {
        tomarElControl()
        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")

        comandoCentral.onControlReleased?.invoke("operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PAUSED } }

        assertTrue("quedó andando después de soltar el control: ${dron.ultimaOrden}", dron.laUltimaOrdenLoDejaQuieto())
    }

    /**
     * Y la vuelta: el watchdog no puede cortarle una orden que ya no es del
     * mando. Si al salir de MANUAL el mando queda colgado, un segundo y medio
     * después el watchdog manda ejes en cero y eso —en el DJI— cancela el lazo
     * de la ruta que se acaba de ordenar.
     */
    @Test
    fun reanudarLaRutaDesdeManualNoSeLaCortaElWatchdog() = runBlocking {
        patrulla.availableRoutes = listOf(ruta)
        tomarElControl()
        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")

        comandoCentral.onStartRoute?.invoke(ruta.id, 0, "operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        val hastaAca = dron.ordenes.size
        delay(PatrolManager.MANDO_TIMEOUT_MS + 1_000)

        val despues = dron.ordenes.drop(hastaAca)
        assertTrue("el watchdog le pisó la ruta con esto: $despues", despues.none { it.startsWith("stick") })
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
    }

    /**
     * Lo mismo con el regreso a base por batería: si el watchdog le manda ejes
     * en cero al rato, le cancela el RTH y el dron se queda donde está con la
     * batería al 20 %.
     */
    @Test
    fun elRegresoPorBateriaNoSeLoCortaElWatchdog() = runBlocking {
        tomarElControl()
        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")

        dron.emitirTelemetria(bateria = 20.0)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_BATTERY } }
        val hastaAca = dron.ordenes.size
        delay(PatrolManager.MANDO_TIMEOUT_MS + 1_000)

        val despues = dron.ordenes.drop(hastaAca)
        assertTrue("el watchdog le pisó el regreso a base con esto: $despues", despues.none { it.startsWith("stick") })
    }

    /** Deja el patrullaje en MANUAL con una posición conocida, como en el campo. */
    private suspend fun tomarElControl() {
        dron.emitirTelemetria()
        delay(200) // que el patrullaje llegue a verla: sin posición no hay manual_move
        comandoCentral.onControlTaken?.invoke("operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
    }

    /**
     * La consola con la palanca tomada: diez mensajes por segundo. Va en su
     * propia corrutina porque tiene que seguir mandando mientras el enlace de
     * radio con el dron se cae — el que se corta es ese, no el del celular.
     */
    private fun mantenerLaPalanca(pitch: Double): Job = alcance.launch {
        while (true) {
            comandoCentral.onManualStick?.invoke(pitch, 0.0, 0.0, 0.0, "operador1")
            delay(100)
        }
    }
}
