package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
 * Los avisos nuevos del dron para los relevos (docs/RELEVOS.md §2.3 y §4)
 * cuando no hay nada que hacer con ellos: el descenso en la base sin un relevo
 * de patrulla pedido, y el propio DJI tomando el control con el dron en el
 * suelo. Se anotan con su texto para el operador y nada más: no mueven al dron,
 * no cambian el estado y no van al Comando Central. Lo que sí hacen en vuelo
 * está en PatrolManagerTomaDelDronTest y PatrolManagerOrigenTest.
 *
 * Usa Robolectric porque el reparto de cuadros de PatrolManager codifica en
 * Base64, que es de android.util.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerAvisosDelRelevoTest {

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia(conRelevos = true)
    private val comandoCentral = ComandoCentralEspia(alcance)
    private lateinit var patrulla: PatrolManager

    @Before
    fun armar() {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla = PatrolManager(dron, comandoCentral, DetectionClient(alcance), alcance, "TEST")
        patrulla.start()
    }

    @After
    fun desarmar() {
        alcance.cancel()
    }

    /**
     * Los avisos del dron no se guardan: uno emitido antes de que PatrolManager
     * empiece a escuchar se pierde, y la prueba esperaría su línea para siempre.
     */
    private suspend fun esperarQueEscuche() {
        withTimeout(5_000) { dron.flightEvents.subscriptionCount.first { it > 0 } }
    }

    @Test
    fun elDescensoEnLaBaseSinRelevoPedidoSoloQuedaEnElRegistroLocal() = runBlocking {
        esperarQueEscuche()
        dron.flightEvents.emit(FlightEvent.DescendiendoEnBase)
        withTimeout(5_000) { patrulla.localLog.first { it == "El dron empezó a descender en la base" } }

        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertEquals("no se le ordenó nada al dron", emptyList<String>(), dron.ordenes)
        assertTrue("no salió ningún landing_at_base", comandoCentral.mensajes("landing_at_base").isEmpty())
        assertEquals("no salió ningún evento", 0, comandoCentral.mensajes("event").size)
    }

    /** Cada motivo se anota con su texto para el operador, no con el nombre del enumerado. */
    @Test
    fun conElDronEnElSueloLaTomaDelDjiSoloSeAnota() = runBlocking {
        esperarQueEscuche()
        for (motivo in MotivoDelDron.entries) {
            dron.flightEvents.emit(FlightEvent.ElDronTomoElControl(motivo))
            withTimeout(5_000) {
                patrulla.localLog.first { it == "El propio dron tomó el control: ${motivo.descripcion}" }
            }
        }

        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertEquals("no se le ordenó nada al dron", emptyList<String>(), dron.ordenes)
        assertEquals("no salió ningún evento", 0, comandoCentral.mensajes("event").size)
        assertTrue(
            "los textos son para el operador y no se repiten",
            MotivoDelDron.entries.map { it.descripcion }.toSet().size == MotivoDelDron.entries.size,
        )
    }

    /** Fuera de un desvío o de una emergencia, el aterrizaje se confirma como siempre. */
    @Test
    fun unPedidoDeConfirmarElAterrizajeFueraDeUnDesvioSeConfirma() = runBlocking {
        esperarQueEscuche()
        dron.flightEvents.emit(FlightEvent.AterrizajePideConfirmacion)
        esperarA("la confirmación") { "confirmarAterrizaje" in dron.ordenes }
        assertEquals(listOf("confirmarAterrizaje"), dron.ordenes)
    }
}
