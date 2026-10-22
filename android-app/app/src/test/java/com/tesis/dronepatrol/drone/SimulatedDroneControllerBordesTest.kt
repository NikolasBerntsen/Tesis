package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.Vinculacion
import com.tesis.dronepatrol.patrol.PatrolManager
import java.util.Collections
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Los bordes del dron simulado que la pantalla de operación usa en el
 * emulador: el failsafe del propio dron cuando se corta el enlace RC (y cuándo
 * NO salta), las órdenes que en el suelo no tienen nada que hacer, los botones
 * del simulador (batería baja, recargar, cortar la señal) y lo que no tiene
 * que reiniciarse al reconectar o al cambiar la base.
 *
 * Usa Robolectric porque el video simulado dibuja con android.graphics; el
 * vuelo corre con tiempos reales (tick de 500 ms, 12 m/s, failsafe a los 6 s).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SimulatedDroneControllerBordesTest {

    private companion object {
        // El punto en el que arranca el dron simulado: el Obelisco.
        const val LAT = -34.6037
        const val LON = -58.3816
        // Una base 60 m al norte: si el dron vuelve a ella, se lo ve avanzar.
        val BASE_AL_NORTE = LAT + 60.0 / Geo.METROS_POR_GRADO_LAT
    }

    private val dron = SimulatedDroneController()
    private val enElAire = SimulatedDroneController(arrancaEnElAire = true)
    private val escuchas = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun bajarDrones() {
        escuchas.cancel()
        dron.disconnect()
        enElAire.disconnect()
    }

    /** Anota todos los avisos de vuelo de [controlador] desde ahora. */
    private suspend fun anotarAvisos(controlador: SimulatedDroneController): List<FlightEvent> {
        val avisos = Collections.synchronizedList(mutableListOf<FlightEvent>())
        val antes = controlador.flightEvents.subscriptionCount.value
        escuchas.launch { controlador.flightEvents.collect { avisos += it } }
        withTimeout(5_000) { controlador.flightEvents.subscriptionCount.first { it > antes } }
        return avisos
    }

    private fun metrosAlNorte(lat: Double) = (lat - LAT) * Geo.METROS_POR_GRADO_LAT

    // ---- Failsafe por pérdida del enlace RC ----

    /**
     * Igual que el Mini 4 Pro: sin enlace RC por más de 6 s el propio dron
     * vuelve a la base, sin que nadie se lo ordene (la app no le puede hablar,
     * el enlace es justamente lo que se cortó). Mientras dura el corte no llega
     * telemetría, y al volver el enlace el dron ya está en camino.
     */
    @Test
    fun sinEnlaceMasDeSeisSegundosVuelveSoloALaBase() = runBlocking {
        enElAire.connect()
        // La base se muda al norte con el dron en el aire: él no se mueve, pero
        // ahora tiene a dónde volver.
        enElAire.setHome(BASE_AL_NORTE, LON)
        enElAire.hold()
        delay(700)

        enElAire.setSignalLost(true)
        assertTrue(enElAire.signalLost)
        delay(700) // que termine el tick en curso
        val ultimaAntesDelCorte = enElAire.telemetry.first()
        assertEquals("se movió antes del corte", 0.0, metrosAlNorte(ultimaAntesDelCorte.lat), 1e-6)

        delay(6_500)
        assertEquals("llegó telemetría con el enlace cortado", ultimaAntesDelCorte.ts, enElAire.telemetry.first().ts)
        enElAire.setSignalLost(false)
        assertFalse(enElAire.signalLost)
        delay(1_200)

        val t = enElAire.telemetry.first()
        assertTrue("no salió hacia la base: ${metrosAlNorte(t.lat)} m al norte", metrosAlNorte(t.lat) > 10.0)
        assertTrue("rumbo ${t.heading}: tendría que ir al norte", t.heading < 1.0 || t.heading > 359.0)
    }

    /**
     * En el suelo o aterrizando, el corte no dispara el regreso: el dron en
     * tierra no despega solo, y el que aterriza termina de aterrizar donde está
     * en vez de volver a subir y salir hacia la base. El aterrizaje (8 s desde
     * 40 m) dura más que el umbral del failsafe, así que lo cruza entero.
     */
    @Test
    fun sinEnlaceEnElSueloOAterrizandoNoVuelveALaBase() = runBlocking {
        dron.connect()
        enElAire.connect()
        enElAire.setHome(BASE_AL_NORTE, LON)
        val avisosEnTierra = anotarAvisos(dron)
        val avisosAterrizando = anotarAvisos(enElAire)

        enElAire.land()
        dron.setSignalLost(true)
        enElAire.setSignalLost(true)
        withTimeout(15_000) { while (avisosAterrizando.isEmpty()) delay(100) }
        delay(1_200) // ya en tierra, con el enlace todavía cortado
        dron.setSignalLost(false)
        enElAire.setSignalLost(false)
        delay(700)

        assertEquals(listOf<FlightEvent>(FlightEvent.Aterrizado), avisosAterrizando.toList())
        val aterrizado = enElAire.telemetry.first()
        assertEquals(0.0, aterrizado.altM, 0.0)
        assertEquals("salió hacia la base", 0.0, metrosAlNorte(aterrizado.lat), 1e-6)

        assertTrue("el dron en tierra hizo algo: $avisosEnTierra", avisosEnTierra.isEmpty())
        assertEquals(0.0, dron.telemetry.first().altM, 0.0)
        assertFalse(dron.estado.value.enVuelo)
    }

    // ---- Órdenes que en el suelo no tienen nada que hacer ----

    /**
     * Quedarse quieto, volver a base y aterrizar, con el dron en el suelo: no lo
     * despegan (el estacionario lo subiría a la altura de crucero), no inventan
     * un aterrizaje ni una llegada a base, y tampoco son un rechazo que avisar.
     */
    @Test
    fun enElSueloQuietoVolverYAterrizarNoHacenNada() = runBlocking {
        dron.connect()
        val avisos = anotarAvisos(dron)

        dron.hold()
        dron.returnHome()
        dron.land()
        delay(1_200)

        assertTrue("avisó algo: $avisos", avisos.isEmpty())
        assertFalse(dron.estado.value.enVuelo)
        val t = dron.telemetry.first()
        assertEquals(0.0, t.altM, 0.0)
        assertEquals(LAT, t.lat, 1e-9)
    }

    // ---- Botones del simulador ----

    /**
     * "Batería baja" la deja apenas debajo del umbral con el que la patrulla
     * ordena el regreso, y "Recargar" la vuelve al 100 %; las dos se ven en la
     * telemetría siguiente.
     */
    @Test
    fun forzarLaBateriaBajaYRecargarlaSeVeEnLaTelemetria() = runBlocking {
        enElAire.connect()

        enElAire.forceLowBattery()
        delay(700)
        val baja = enElAire.telemetry.first().batteryPct
        assertTrue("batería al $baja %", baja <= PatrolManager.LOW_BATTERY_PCT)
        assertEquals(24.0, baja, 0.1)

        enElAire.rechargeBattery()
        delay(700)
        assertEquals(100.0, enElAire.telemetry.first().batteryPct, 0.1)
    }

    /**
     * Volver a conectar un simulador que ya corre (la pantalla que se recrea)
     * no lo reinicia: no vuelve a la base, no le carga la batería y no arranca
     * un segundo lazo de vuelo.
     */
    @Test
    fun conectarDosVecesNoReiniciaLaSimulacion() = runBlocking {
        enElAire.connect()
        enElAire.forceLowBattery()
        enElAire.gotoPoint(LAT + 500.0 / Geo.METROS_POR_GRADO_LAT, LON)
        delay(1_200)

        enElAire.connect()
        delay(700)

        val t = enElAire.telemetry.first()
        assertEquals("la batería se recargó al reconectar", 24.0, t.batteryPct, 0.5)
        assertTrue("volvió a la base al reconectar: ${metrosAlNorte(t.lat)} m", metrosAlNorte(t.lat) > 5.0)
    }

    /**
     * La base del dron que inició sesión: en el suelo, el simulado está parado
     * en ella; en el aire, cambiarla no lo teletransporta (solo cambia a dónde
     * vuelve).
     */
    @Test
    fun cambiarLaBaseEnElSueloMueveAlDronYEnElAireNo() = runBlocking {
        dron.connect()
        val otraLat = LAT + 0.01
        val otraLon = LON + 0.01
        dron.setHome(otraLat, otraLon)
        delay(700)
        val enTierra = dron.telemetry.first()
        assertEquals(otraLat, enTierra.lat, 1e-9)
        assertEquals(otraLon, enTierra.lon, 1e-9)

        enElAire.connect()
        enElAire.hold()
        delay(700)
        enElAire.setHome(otraLat, otraLon)
        delay(700)
        val volando = enElAire.telemetry.first()
        assertEquals(LAT, volando.lat, 1e-9)
        assertEquals(LON, volando.lon, 1e-9)
    }

    /**
     * El simulador no tiene un control físico que vincular: nace vinculado, y
     * pedirle vincular o cancelar no lo deja "vinculando", que en la pantalla de
     * conexión sería esperar para siempre una aeronave que no existe.
     */
    @Test
    fun elSimuladorNaceVinculadoYVincularNoLoCambia() {
        dron.vincularControl()
        assertEquals(Vinculacion.VINCULADA, dron.estado.value.vinculacion)
        dron.cancelarVinculacion()
        assertEquals(Vinculacion.VINCULADA, dron.estado.value.vinculacion)
    }
}
