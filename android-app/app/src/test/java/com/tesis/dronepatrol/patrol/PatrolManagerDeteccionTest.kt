package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Qué pasa cuando el detector ve algo: hace falta una SEGUNDA detección que lo
 * confirme, y entonces SIEMPRE se avisa al Comando Central (salvo despegando o
 * volviendo a base). En el aire, a la altura de trabajo y con GPS, el dron
 * orbita ALREDEDOR DEL OBJETIVO —la caja proyectada al terreno, no la posición
 * del dron—; en el suelo, a baja altura, sin GPS o fuera de un patrullaje, la
 * alerta sale sin seguimiento y con techo de una por minuto. La alerta lleva la
 * captura anotada que disparó la detección, la posición del objetivo y la pose
 * del dron. Las cajas quedan para dibujarlas sobre el video mientras están
 * vigentes.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerDeteccionTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = ComandoCentralEspia(alcance)
    private val deteccion = DetectionClient(alcance)
    private val patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST")
    private val ruta = PatrolRoute(1, "Manzana", listOf(Waypoint(LAT + 0.001, LON, ALT), Waypoint(LAT, LON + 0.001, ALT)))

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private suspend fun patrullandoConLaCamaraAlEste(alt: Double = ALT) {
        patrulla.start()
        // Rumbo este, gimbal a 70° hacia abajo
        dron.emitirTelemetria(LAT, LON, alt = alt, rumbo = 90.0, gimbal = -70.0)
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

    /** Dos detecciones seguidas del mismo objetivo: la segunda confirma la primera. */
    private suspend fun detectarDosVeces(d: Deteccion) {
        deteccion.onDetection?.invoke(d)
        delay(80)
        deteccion.onDetection?.invoke(d)
    }

    @Test
    fun unaSolaDeteccionNoAlertaYLaSegundaSi() = runBlocking {
        patrullandoConLaCamaraAlEste()

        deteccion.onDetection?.invoke(deteccionEnElCentro())
        delay(300)
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertTrue(comandoCentral.alertas.isEmpty())

        deteccion.onDetection?.invoke(deteccionEnElCentro())
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
    }

    @Test
    fun orbitaAlrededorDelObjetivoProyectadoYNoDelDron() = runBlocking {
        patrullandoConLaCamaraAlEste()

        detectarDosVeces(deteccionEnElCentro())
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
    fun laAlertaLlevaLaCapturaLaPosicionDelObjetivoLaPoseDelDronYUnRef() = runBlocking {
        patrullandoConLaCamaraAlEste()

        detectarDosVeces(deteccionEnElCentro())
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }

        val alerta = comandoCentral.alertas.single()
        assertEquals("PERSON", alerta.getString("alertType"))
        assertEquals("/9j/captura", alerta.getString("snapshotBase64"))
        assertEquals(0.87, alerta.getDouble("confidence"), 1e-9)
        assertEquals(dron.ultimaOrbita!!.first, alerta.getDouble("lat"), 1e-9)
        assertEquals(dron.ultimaOrbita!!.second, alerta.getDouble("lon"), 1e-9)
        assertEquals(LAT, alerta.getDouble("droneLat"), 1e-9)
        assertEquals(LON, alerta.getDouble("droneLon"), 1e-9)
        assertEquals(ALT, alerta.getDouble("droneAlt"), 1e-9)
        assertTrue("la alerta lleva su ref", alerta.getString("ref").isNotBlank())
        // Y el comienzo de la órbita queda en el registro con la posición del objetivo
        esperarA("ORBIT_STARTED") { comandoCentral.eventos("ORBIT_STARTED").isNotEmpty() }
        assertEquals(alerta.getDouble("lat"), comandoCentral.eventos("ORBIT_STARTED").single().getDouble("lat"), 1e-9)
    }

    /** Sin cajas (el detector de respaldo) ni captura se orbita la posición del dron. */
    @Test
    fun sinCajasOrbitaLaPosicionDelDron() = runBlocking {
        patrullandoConLaCamaraAlEste()

        detectarDosVeces(Deteccion(listOf("VEHICLE"), 0.9, emptyList(), null, 1L))
        esperarA("la orden de órbita") { dron.ultimaOrbita != null }

        assertEquals(LAT, dron.ultimaOrbita!!.first, 1e-12)
        assertEquals(LON, dron.ultimaOrbita!!.second, 1e-12)
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        assertEquals("VEHICLE", comandoCentral.alertas.single().getString("alertType"))
    }

    /** Dos detecciones de clases distintas no se confirman entre sí. */
    @Test
    fun laConfirmacionTieneQueSerDeLaMismaClase() = runBlocking {
        patrullandoConLaCamaraAlEste()

        deteccion.onDetection?.invoke(deteccionEnElCentro())
        delay(80)
        deteccion.onDetection?.invoke(
            Deteccion(listOf("VEHICLE"), 0.8, listOf(Caja("VEHICLE", 0.8, 0.5, 0.5, 0.1, 0.1)), null, 2L),
        )
        delay(300)
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertTrue(comandoCentral.alertas.isEmpty())
    }

    /** Despegando, lo que se ve es el equipo de tierra: no se alerta hasta llegar a la altura de trabajo. */
    @Test
    fun duranteElDespegueNoSeAlerta() = runBlocking {
        patrullandoConLaCamaraAlEste()
        dron.flightEvents.emit(FlightEvent.Despegando)
        delay(100)

        detectarDosVeces(deteccionEnElCentro())
        delay(300)
        assertTrue(comandoCentral.alertas.isEmpty())

        dron.flightEvents.emit(FlightEvent.EnElAire)
        delay(100)
        detectarDosVeces(deteccionEnElCentro())
        esperarA("la alerta, ya a la altura de trabajo") { comandoCentral.alertas.size == 1 }
    }

    /** A baja altura se alerta, pero sin órbita: la proyección no sirve y orbitar a ras del suelo es peligroso. */
    @Test
    fun aBajaAlturaSeAlertaSinSeguimiento() = runBlocking {
        patrullandoConLaCamaraAlEste(alt = 5.0)

        detectarDosVeces(deteccionEnElCentro())
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        delay(200)
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertTrue(dron.ultimaOrbita == null)
        assertTrue(comandoCentral.eventos("DETECTION").single().getString("message").contains("baja altura"))
    }

    /** Sin GPS se alerta igual, sin posición (no se orbita a ciegas). */
    @Test
    fun sinGpsSeAlertaSinPosicion() = runBlocking {
        patrullandoConLaCamaraAlEste()
        dron.emitirTelemetria(Double.NaN, Double.NaN, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        delay(150)

        detectarDosVeces(deteccionEnElCentro())
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        val alerta = comandoCentral.alertas.single()
        assertTrue(alerta.isNull("lat"))
        assertTrue(alerta.isNull("lon"))
        assertEquals("/9j/captura", alerta.getString("snapshotBase64"))
        assertTrue(dron.ultimaOrbita == null)
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
    }

    @Test
    fun enOrbitaNoSeVuelveAAlertarPeroLasCajasSiguenActualizandose() = runBlocking {
        patrullandoConLaCamaraAlEste()
        detectarDosVeces(deteccionEnElCentro())
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }

        val otra = Deteccion(listOf("PERSON"), 0.5, listOf(Caja("PERSON", 0.5, 0.2, 0.2, 0.1, 0.1)), null, 2L)
        detectarDosVeces(otra)
        esperarA("las cajas nuevas") { patrulla.cajasRecientes.value == otra.cajas }

        delay(300)
        assertEquals(1, comandoCentral.alertas.size)
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

    /** En el suelo se avisa al Comando Central (alerta y registro), sin mover al dron. */
    @Test
    fun enElSueloSeAlertaSinSeguimiento() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        dron.emitirTelemetria(LAT, LON, alt = 0.0, rumbo = 90.0, gimbal = -70.0)
        delay(100)

        detectarDosVeces(deteccionEnElCentro())
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        esperarA("el registro de la detección") { comandoCentral.eventos("DETECTION").isNotEmpty() }
        assertTrue(comandoCentral.eventos("DETECTION").single().getString("message").contains("suelo"))
        assertFalse(patrulla.state.value == PatrolState.ORBITING)
        assertTrue(dron.ultimaOrbita == null)
        assertTrue(patrulla.objetivo == null)
        // A ras del suelo no hay proyección: el objetivo va sin posición, en vez
        // de con la del dron, y la del dron va aparte, en su pose.
        val alerta = comandoCentral.alertas.single()
        assertTrue("sin posición del objetivo: $alerta", alerta.isNull("lat"))
        assertEquals(LAT, alerta.getDouble("droneLat"), 1e-9)
    }

    /**
     * En el aire sin patrullar (la app abierta con el dron ya volando) no se
     * sigue al objetivo, pero se lo ubica, y el registro dice por qué no se lo
     * sigue en vez de hablar de una "baja altura" a 45 m.
     */
    @Test
    fun enElAireSinPatrullarSeAlertaSinSeguimientoYConElObjetivoUbicado() = runBlocking {
        patrulla.start()
        dron.emitirTelemetria(LAT, LON, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        delay(100)

        detectarDosVeces(deteccionEnElCentro())
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        esperarA("el registro de la detección") { comandoCentral.eventos("DETECTION").isNotEmpty() }

        assertTrue(comandoCentral.eventos("DETECTION").single().getString("message").contains("fuera de un patrullaje"))
        val metrosEste = (comandoCentral.alertas.single().getDouble("lon") - LON) * Geo.metrosPorGradoLon(LAT)
        assertEquals(ALT / tan(Math.toRadians(70.0)), metrosEste, 0.5)
        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertTrue(dron.ultimaOrbita == null)
    }

    /** Sin seguimiento no hay "objetivo en curso": el techo de una por minuto evita la inundación. */
    @Test
    fun lasAlertasSinSeguimientoTienenTecho() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        dron.emitirTelemetria(LAT, LON, alt = 0.0, rumbo = 90.0, gimbal = -70.0)
        delay(100)

        // De a un par por vez: en la app las detecciones se atienden en el hilo
        // principal, de a una; acá el alcance es multihilo y sin pausa se pisan.
        repeat(4) {
            detectarDosVeces(deteccionEnElCentro())
            delay(150)
        }
        esperarA("la primera alerta") { comandoCentral.alertas.size == 1 }
        delay(300)
        assertEquals(1, comandoCentral.alertas.size)
    }

    /** Volviendo a base no se alerta: el dron no puede quedarse sobre nada. */
    @Test
    fun volviendoABaseNoSeAlerta() = runBlocking {
        patrullandoConLaCamaraAlEste()
        patrulla.volverABase()
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME } }

        detectarDosVeces(deteccionEnElCentro())
        delay(300)
        assertTrue(comandoCentral.alertas.isEmpty())
    }
}
