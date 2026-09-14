package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Waypoint
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
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Qué le queda ordenado al dron cuando se pierde el enlace de radio, desde CADA
 * estado de vuelo y no solo desde el control manual.
 *
 * Es el mismo defecto caro que el del control manual, pero por el otro lado: el
 * dron sostiene la última velocidad comandada, y en el DJI el lazo de la ruta o de
 * la órbita le sigue mandando velocidades a 10 Hz hasta que otra orden lo releve.
 * Si al pasar a RETURNING_HOME_SIGNAL nadie frena, la consola muestra "volviendo
 * a base" mientras el lazo sigue empujando al dron hacia el próximo nodo, y la
 * autoridad del Virtual Stick le pisa el failsafe RTH del propio dron: apenas el
 * enlace se reengancha, el dron retoma la marcha con nadie al mando.
 *
 * El dron es un espía que anota cada orden: es la única forma de distinguir "se lo
 * frenó al salir" de "se quedó quieto de casualidad".
 *
 * Usa Robolectric porque el reparto de cuadros de PatrolManager codifica en
 * Base64, que es de android.util; los tiempos son reales (el corte de señal se
 * declara a los 4 s).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerPerdidaDeSenialTest {

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
        patrulla.availableRoutes = listOf(ruta)
    }

    @After
    fun desarmar() {
        alcance.cancel()
    }

    /** Patrullando: el lazo de la ruta tiene que quedar relevado por el freno. */
    @Test
    fun perderLaSenialPatrullandoDejaAlDronQuieto() = runBlocking {
        arrancarConTelemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }

        esperarElCorteDeSenial()

        assertEquals(
            "al perder la señal patrullando nadie frenó: el lazo de la ruta sigue vivo",
            "hold",
            dron.ultimaOrden,
        )
    }

    /** Orbitando una detección, lo mismo: el lazo de la órbita también hay que frenarlo. */
    @Test
    fun perderLaSenialOrbitandoDejaAlDronQuieto() = runBlocking {
        arrancarConTelemetria()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        deteccion.onDetection?.invoke(listOf("PERSON"))
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }

        esperarElCorteDeSenial()

        assertEquals(
            "al perder la señal orbitando nadie frenó: el lazo de la órbita sigue vivo",
            "hold",
            dron.ultimaOrden,
        )
    }

    /** Y en un desvío forzado, que es el tercer estado en vuelo sin control tomado. */
    @Test
    fun perderLaSenialEnUnDesvioForzadoDejaAlDronQuieto() = runBlocking {
        arrancarConTelemetria()
        comandoCentral.onForceGoto?.invoke(ruta.id, 1, "operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.FORCED } }

        esperarElCorteDeSenial()

        assertEquals(
            "al perder la señal en un desvío nadie frenó: el lazo del desvío sigue vivo",
            "hold",
            dron.ultimaOrden,
        )
    }

    /**
     * Una telemetría y nada más: a partir de acá el silencio ES el corte del
     * enlace de radio, igual que en el campo. Sin la primera, el watchdog de señal
     * no tiene contra qué comparar y no salta nunca.
     */
    private suspend fun arrancarConTelemetria() {
        dron.emitirTelemetria()
        delay(200) // que el patrullaje llegue a verla
    }

    private suspend fun esperarElCorteDeSenial() {
        withTimeout(12_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_SIGNAL } }
        delay(300) // margen para que el freno quede anotado
    }
}
