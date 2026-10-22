package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.model.FlightEvent
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Los botones de la pantalla de operación: las mismas órdenes que la consola,
 * pero desde el teléfono que está al lado del dron ("Detener", "Reanudar",
 * "Volver a base", "Aterrizar", "Recargar"). Lo que se verifica es qué le queda
 * ordenado al dron, sobre todo cuando el botón no corresponde —el dron ya en el
 * suelo— y cuando le saca el dron a la consola: el que está al lado manda.
 *
 * Usa Robolectric por lo mismo que el resto de las pruebas de PatrolManager: el
 * reparto de cuadros codifica en Base64 (android.util) y el Comando Central
 * espía arma el JSON con org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerOrdenesDelCampoTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = ComandoCentralEspia(alcance)
    private val patrulla = PatrolManager(dron, comandoCentral, DetectionClient(alcance), alcance, "TEST")
    private val ruta = PatrolRoute(
        1,
        "Manzana",
        listOf(Waypoint(LAT + 0.002, LON, ALT), Waypoint(LAT, LON + 0.002, ALT), Waypoint(LAT - 0.002, LON, ALT)),
    )

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private fun mensaje(json: String) = comandoCentral.manejarMensaje(json)

    private suspend fun esperarEstado(estado: PatrolState) {
        withTimeout(5_000) { patrulla.state.first { it == estado } }
    }

    private suspend fun telemetria(bateria: Double = 100.0, alt: Double = ALT) {
        dron.emitirTelemetria(LAT, LON, bateria = bateria, alt = alt, rumbo = 90.0, gimbal = -70.0)
        delay(60)
    }

    /** Patrullando, ya pasado el nodo [alcanzado]: el que tiene por delante es el siguiente. */
    private suspend fun patrullandoDespuesDelNodo(alcanzado: Int) {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        esperarEstado(PatrolState.PATROLLING)
        dron.flightEvents.emit(FlightEvent.WaypointReached(alcanzado))
        delay(100)
    }

    /**
     * "Detener" en el teléfono queda en el registro con quién lo pidió, y
     * "Reanudar" retoma hacia el nodo que tenía por delante.
     */
    @Test
    fun detenerYReanudarDesdeElCampoSigueHaciaElNodoQueTeniaPorDelante() = runBlocking {
        patrullandoDespuesDelNodo(1)

        patrulla.detenerPatrullaje()
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals("hold", dron.ultimaOrden)
        assertTrue(comandoCentral.eventos("PATROL_STOPPED").single().getString("message").contains("el operador de campo"))

        patrulla.reanudarPatrullaje()
        esperarEstado(PatrolState.PATROLLING)
        esperarA("la ruta hacia el tercer nodo") { dron.ultimaOrden == "startRoute(1, 2)" }
        esperarA("PATROL_RESUMED") { comandoCentral.eventos("PATROL_RESUMED").isNotEmpty() }
        assertTrue(comandoCentral.eventos("PATROL_RESUMED").single().getString("message").contains("operador de campo"))
    }

    /** Aterrizar a mitad de ruta y retomarla sigue hacia el nodo que tenía por delante. */
    @Test
    fun aterrizarPatrullandoYReanudarSigueHaciaElNodoQueTeniaPorDelante() = runBlocking {
        patrullandoDespuesDelNodo(0)

        patrulla.aterrizar()
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertEquals("land", dron.ultimaOrden)
        assertTrue(comandoCentral.eventos("LANDING").single().getString("message").contains("operador de campo"))

        patrulla.reanudarPatrullaje()
        esperarA("la ruta hacia el segundo nodo") { dron.ultimaOrden == "startRoute(1, 1)" }
    }

    /**
     * Con el dron en el suelo, "Volver a base" y "Aterrizar" no tienen nada que
     * hacer: no se le ordena nada al dron ni se ensucia el registro de la consola.
     */
    @Test
    fun enElSueloVolverABaseYAterrizarNoOrdenanNada() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetria(alt = 0.0)

        patrulla.volverABase()
        patrulla.aterrizar()

        withTimeout(5_000) { patrulla.localLog.first { it.contains("no hay a dónde volver") } }
        withTimeout(5_000) { patrulla.localLog.first { it.contains("ya está en el suelo") } }
        assertTrue("se le ordenó algo a un dron en el suelo: ${dron.ordenes}", dron.ordenes.isEmpty())
        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertTrue(comandoCentral.eventos("RTH_MANUAL").isEmpty())
        assertTrue(comandoCentral.eventos("LANDING").isEmpty())
    }

    /**
     * "Volver a base" le saca el dron a la consola aunque tenga el control
     * tomado. Que la consola lo suelte DESPUÉS ya no es asunto suyo: no puede
     * frenar al dron ni pisarle el regreso con un vuelo estacionario, y el mando
     * que siga llegando tampoco le llega.
     */
    @Test
    fun volverABaseConElControlTomadoNoSeLoDevuelveALaConsola() = runBlocking {
        patrulla.start()
        telemetria()
        mensaje("""{"type":"control_taken","by":"op"}""")
        esperarEstado(PatrolState.MANUAL)

        patrulla.volverABase()
        assertEquals(PatrolState.RETURNING_HOME, patrulla.state.value)
        assertEquals("returnHome", dron.ultimaOrden)

        mensaje("""{"type":"manual_stick","pitch":1.0,"roll":0.0,"yaw":0.0,"throttle":0.0,"by":"op"}""")
        mensaje("""{"type":"control_released","by":"op"}""")
        delay(300)
        assertEquals(PatrolState.RETURNING_HOME, patrulla.state.value)
        assertEquals("le pisaron el regreso a base: ${dron.ordenes}", "returnHome", dron.ultimaOrden)
        assertTrue(patrulla.localLog.replayCache.none { it.contains("liberó el control") })
    }

    /**
     * "Recargar" del simulador con el dron en base por batería baja: deja de
     * esperar la batería nueva, queda en reposo y vuelve a poder despegar. La
     * lectura al 100 % que manda el simulador después no es un segundo cambio
     * de batería: el registro lo dice una sola vez.
     */
    @Test
    fun recargarLaBateriaEnBaseLaDejaListaParaVolar() = runBlocking {
        patrullandoDespuesDelNodo(0)
        telemetria(bateria = 20.0)
        esperarEstado(PatrolState.RETURNING_HOME_BATTERY)
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.ArrivedHome)
        esperarEstado(PatrolState.LANDED)

        patrulla.onBatteryRecharged()
        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertTrue(comandoCentral.eventos("BATTERY_RECHARGED").single().getString("message").contains("100%"))

        telemetria(bateria = 100.0, alt = 0.0)
        patrulla.despegarAqui()
        esperarA("el despegue") { dron.ordenes.contains("despegarEnElLugar") }
        assertEquals(1, comandoCentral.eventos("BATTERY_RECHARGED").size)
    }
}
