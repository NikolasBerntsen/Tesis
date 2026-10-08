package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Waypoint
import kotlin.math.tan
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
 * Qué pasa cuando el detector ve algo: el dron orbita ALREDEDOR DEL OBJETIVO
 * —la caja proyectada al terreno, no la posición del dron—, la alerta lleva la
 * captura anotada que disparó la detección y la posición del objetivo, y las
 * cajas quedan para dibujarlas sobre el video mientras están vigentes. Y en
 * órbita no se vuelve a alertar.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerDeteccionTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
    }

    /** Anota cada alerta tal cual se manda. */
    private class ComandoCentralQueAnota(alcance: CoroutineScope) : CommandCenterClient(alcance) {
        data class Alerta(val tipo: String, val lat: Double, val lon: Double, val snapshot: String?, val confianza: Double)
        val alertas = mutableListOf<Alerta>()
        override fun sendAlertRequest(
            alertType: String,
            lat: Double,
            lon: Double,
            snapshotBase64: String?,
            confidence: Double,
            classes: List<String>,
        ) {
            synchronized(alertas) { alertas += Alerta(alertType, lat, lon, snapshotBase64, confidence) }
        }
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = ComandoCentralQueAnota(alcance)
    private val deteccion = DetectionClient(alcance)
    private val patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST")
    private val ruta = PatrolRoute(1, "Manzana", listOf(Waypoint(LAT + 0.001, LON, ALT), Waypoint(LAT, LON + 0.001, ALT)))

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private suspend fun patrullandoConLaCamaraAlEste() {
        patrulla.start()
        // Rumbo este, gimbal a 70° hacia abajo, 45 m de altura
        dron.emitirTelemetria(LAT, LON, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        delay(100)
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
    }

    private fun deteccionEnElCentro(snapshot: String? = "/9j/captura") = Deteccion(
        clases = listOf("PERSON"),
        confianza = 0.87,
        cajas = listOf(Caja("PERSON", 0.87, 0.5, 0.5, 0.02, 0.05)),
        snapshotBase64 = snapshot,
        ts = 1L,
    )

    @Test
    fun orbitaAlrededorDelObjetivoProyectadoYNoDelDron() = runBlocking {
        patrullandoConLaCamaraAlEste()

        deteccion.onDetection?.invoke(deteccionEnElCentro())
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }
        esperarA("la orden de órbita") { dron.ultimaOrbita != null }

        val (lat, lon) = dron.ultimaOrbita!!
        val metrosEste = (lon - LON) * Geo.metrosPorGradoLon(LAT)
        val metrosNorte = (lat - LAT) * Geo.METROS_POR_GRADO_LAT
        // El centro del cuadro con la cámara a 70° está a 45 / tan(70°) ≈ 16 m
        // adelante, y adelante es el este.
        assertEquals(ALT / tan(Math.toRadians(70.0)), metrosEste, 0.5)
        assertEquals(0.0, metrosNorte, 0.5)
    }

    @Test
    fun laAlertaLlevaLaCapturaAnotadaDelDetectorYLaPosicionDelObjetivo() = runBlocking {
        patrullandoConLaCamaraAlEste()

        deteccion.onDetection?.invoke(deteccionEnElCentro())
        esperarA("la alerta") { synchronized(comandoCentral.alertas) { comandoCentral.alertas.size } == 1 }

        val alerta = synchronized(comandoCentral.alertas) { comandoCentral.alertas.single() }
        assertEquals("PERSON", alerta.tipo)
        assertEquals("/9j/captura", alerta.snapshot)
        assertEquals(0.87, alerta.confianza, 1e-9)
        assertEquals(dron.ultimaOrbita!!.first, alerta.lat, 1e-12)
        assertEquals(dron.ultimaOrbita!!.second, alerta.lon, 1e-12)
    }

    /** Sin cajas (el mock) ni captura se orbita la posición del dron, con la captura que haya. */
    @Test
    fun sinCajasOrbitaLaPosicionDelDron() = runBlocking {
        patrullandoConLaCamaraAlEste()

        deteccion.onDetection?.invoke(Deteccion(listOf("VEHICLE"), 0.9, emptyList(), null, 1L))
        esperarA("la orden de órbita") { dron.ultimaOrbita != null }

        assertEquals(LAT, dron.ultimaOrbita!!.first, 1e-12)
        assertEquals(LON, dron.ultimaOrbita!!.second, 1e-12)
        esperarA("la alerta") { synchronized(comandoCentral.alertas) { comandoCentral.alertas.size } == 1 }
        assertEquals("VEHICLE", synchronized(comandoCentral.alertas) { comandoCentral.alertas.single().tipo })
    }

    @Test
    fun enOrbitaNoSeVuelveAAlertarPeroLasCajasSiguenActualizandose() = runBlocking {
        patrullandoConLaCamaraAlEste()
        deteccion.onDetection?.invoke(deteccionEnElCentro())
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }

        val otra = Deteccion(listOf("PERSON"), 0.5, listOf(Caja("PERSON", 0.5, 0.2, 0.2, 0.1, 0.1)), null, 2L)
        deteccion.onDetection?.invoke(otra)
        esperarA("las cajas nuevas") { patrulla.cajasRecientes.value == otra.cajas }

        delay(300)
        assertEquals(1, synchronized(comandoCentral.alertas) { comandoCentral.alertas.size })
    }

    @Test
    fun lasCajasVencenSolas() = runBlocking {
        patrullandoConLaCamaraAlEste()
        deteccion.onDetection?.invoke(deteccionEnElCentro())
        esperarA("las cajas") { patrulla.cajasRecientes.value.isNotEmpty() }

        val ahora = System.currentTimeMillis()
        assertTrue(patrulla.cajasVigentes(ahora).isNotEmpty())
        assertTrue(patrulla.cajasVigentes(ahora + PatrolManager.VIGENCIA_CAJAS_MS + 1).isEmpty())
        assertTrue(patrulla.cajasRecientes.value.isEmpty())
    }

    private suspend fun esperarA(que: String, condicion: () -> Boolean) {
        val limite = System.currentTimeMillis() + 5_000
        while (!condicion()) {
            if (System.currentTimeMillis() > limite) org.junit.Assert.fail("se agotó la espera de $que")
            delay(20)
        }
    }
}
