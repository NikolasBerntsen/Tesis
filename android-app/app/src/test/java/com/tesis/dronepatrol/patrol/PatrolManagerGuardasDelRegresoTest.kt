package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Las guardas que docs/RELEVOS.md §1 le suma al regreso: al recuperar la señal
 * nunca se retoma una ruta con la batería en el umbral de regreso, ni se le
 * pelea el vuelo al propio DJI si lo tiene; y `resume_patrol` exige un
 * patrullaje en curso (una ruta que quedó cargada de antes no es una que
 * alguien pidió volar).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerGuardasDelRegresoTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private suspend fun patrullando() {
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 300.0, bateria = 60.0)
        patrulla.startPatrol(RUTA)
        esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
    }

    private suspend fun sinSenial() {
        banco.relojDeLaSenial.adelantar(PatrolManager.SIGNAL_TIMEOUT_MS + 1_000)
        esperarA("la señal perdida", topeMs = 3_000) { patrulla.state.value == PatrolState.RETURNING_HOME_SIGNAL }
    }

    @Test
    fun conLaBateriaEnElUmbralLaSenialQueVuelveNoRetomaLaRuta() = runBlocking {
        patrullando()
        sinSenial()
        banco.telemetria(norteM = 250.0, bateria = 25.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        esperarA("la orden de volver") { dron.ultimaOrden == "returnHome" }
        assertFalse("ni un startRoute después de perder la señal", dron.ordenes.count { it.startsWith("startRoute") } > 1)
    }

    @Test
    fun alVolverLaSenialConElDjiYaVolviendoQuedaEnSuRegreso() = runBlocking {
        patrullando()
        sinSenial()
        // Mientras no había señal el DJI arrancó a bajar por batería crítica (en la base: sin emergencia).
        banco.telemetria(norteM = 3.0, bateria = 60.0)
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }
        sinSenial()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA))
        assertEquals("sigue esperando la señal", PatrolState.RETURNING_HOME_SIGNAL, patrulla.state.value)
        val antes = dron.ordenes.size
        banco.telemetria(norteM = 3.0, bateria = 60.0)
        esperarA("el regreso del DJI") { patrulla.state.value == PatrolState.RETURNING_HOME }
        assertEquals(antes, dron.ordenes.size)
    }

    @Test
    fun reanudarSinUnPatrullajeEnCursoNoVuelaUnaRutaVieja() = runBlocking {
        patrullando()
        // El patrullaje termina (aterriza y queda en reposo), pero la ruta queda cargada.
        banco.evento(FlightEvent.Aterrizado)
        esperarA("el reposo") { patrulla.state.value == PatrolState.IDLE }
        // Despegado otra vez a mano y sin señal: al volver queda en pausa, no en la ruta vieja.
        banco.telemetria(norteM = 10.0, bateria = 80.0)
        sinSenial()
        banco.telemetria(norteM = 10.0, bateria = 80.0)
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }
        val rutas = dron.ordenes.count { it.startsWith("startRoute") }
        banco.comando.recibir(JSONObject().put("type", "resume_patrol").put("orderedBy", "op"))
        delay(200)
        assertEquals("no hay patrullaje en curso que reanudar", rutas, dron.ordenes.count { it.startsWith("startRoute") })
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertFalse(patrulla.puedeReanudar)
    }
}
