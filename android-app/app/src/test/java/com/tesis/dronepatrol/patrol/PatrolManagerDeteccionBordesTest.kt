package com.tesis.dronepatrol.patrol

import android.graphics.Bitmap
import android.util.Base64
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Waypoint
import java.io.ByteArrayOutputStream
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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Los bordes de una detección antes de que se vuelva alerta: la confirmación
 * (la segunda detección tiene que llegar a tiempo y caer cerca de la primera,
 * salvo que el GPS vaya y venga en el medio), la georreferencia con la pose del
 * instante del cuadro y no la última, la caja que define al objetivo cuando hay
 * varias, y la captura que viaja con la alerta cuando el detector no manda la
 * suya.
 *
 * Las ventanas de tiempo corren con el reloj falso de la patrulla: "llegó 2,6 s
 * después" no se prueba durmiendo el test. Usa Robolectric porque el reparto de
 * cuadros codifica en Base64 (android.util) y el Comando Central espía arma el
 * JSON con org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerDeteccionBordesTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
        // Rumbo este y la cámara 70° hacia abajo: el centro del cuadro cae
        // ALT / tan(70°) ≈ 16 m al este del dron.
        val ADELANTE_M = ALT / tan(Math.toRadians(70.0))
        val CIEN_M_AL_NORTE = 100.0 / Geo.METROS_POR_GRADO_LAT
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = ComandoCentralEspia(alcance)
    private val deteccion = DetectionClient(alcance)
    private val reloj = RelojFalso()
    private val patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST", reloj::ahora)
    private val ruta = PatrolRoute(1, "Manzana", listOf(Waypoint(LAT + 0.002, LON, ALT), Waypoint(LAT, LON + 0.002, ALT)))

    private val personaEnElCentro = Deteccion(
        clases = listOf("PERSON"),
        confianza = 0.9,
        cajas = listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)),
        snapshotBase64 = "/9j/captura",
        ts = 1L,
    )

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private suspend fun telemetria(lat: Double = LAT, lon: Double = LON, alt: Double = ALT, ts: Long = System.currentTimeMillis()) {
        dron.emitirTelemetria(lat, lon, alt = alt, rumbo = 90.0, gimbal = -70.0, ts = ts)
        delay(80)
    }

    private suspend fun detectar(d: Deteccion = personaEnElCentro) {
        deteccion.onDetection?.invoke(d)
        delay(80)
    }

    /**
     * Arranca la patrulla y espera a que su colector de telemetría esté
     * escuchando: el flujo del dron repite solo la última lectura, y las pruebas
     * de la historia de poses necesitan que lleguen todas.
     */
    private suspend fun arrancarEscuchando() {
        patrulla.start()
        dron.emitirTelemetria(LAT, LON, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        withTimeout(5_000) { patrulla.signalPct.first { it == 90 } }
    }

    private suspend fun patrullando() {
        arrancarEscuchando()
        patrulla.startPatrol(ruta)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
    }

    private fun metrosAlNorteDe(lat: Double, deLat: Double = LAT) = (lat - deLat) * Geo.METROS_POR_GRADO_LAT
    private fun metrosAlEsteDe(lon: Double) = (lon - LON) * Geo.metrosPorGradoLon(LAT)

    // ---- Confirmación ----

    /**
     * La segunda detección tiene que llegar dentro de la ventana: una que llega
     * tarde no confirma la vieja, pasa a ser la candidata nueva, y la que sigue
     * a tiempo sí alerta.
     */
    @Test
    fun unaSegundaDeteccionFueraDeLaVentanaNoConfirmaPeroQuedaComoCandidata() = runBlocking<Unit> {
        patrullando()

        detectar()
        reloj.adelantar(PatrolManager.CONFIRMACION_VENTANA_MS + 1)
        detectar()
        delay(200)
        assertTrue("alertó con dos detecciones separadas de más: ${comandoCentral.alertas}", comandoCentral.alertas.isEmpty())
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)

        reloj.adelantar(100)
        detectar()
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }
    }

    /**
     * Y tiene que caer cerca: si el dron avanzó 100 m entre una y otra, son dos
     * cosas distintas (o el mismo reflejo en dos lugares) y no se confirman. La
     * alerta sale con la siguiente, en el lugar nuevo.
     */
    @Test
    fun unaSegundaDeteccionLejosDeLaPrimeraNoConfirma() = runBlocking {
        patrullando()

        detectar()
        telemetria(lat = LAT + CIEN_M_AL_NORTE)
        detectar()
        delay(200)
        assertTrue(comandoCentral.alertas.isEmpty())

        detectar()
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        assertEquals(100.0, metrosAlNorteDe(comandoCentral.alertas.single().getDouble("lat")), 1.0)
    }

    /**
     * Sin GPS en la primera detección no hay distancia que comparar: con la
     * misma clase a tiempo alcanza, y si el GPS ya volvió en la segunda, el
     * dron sigue al objetivo.
     */
    @Test
    fun laConfirmacionQueCruzaLaVueltaDelGpsVale() = runBlocking {
        arrancarEscuchando()
        telemetria(lat = Double.NaN, lon = Double.NaN)
        patrulla.startPatrol(ruta)

        detectar()
        telemetria()
        detectar()

        withTimeout(5_000) { patrulla.state.first { it == PatrolState.ORBITING } }
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        assertEquals(ADELANTE_M, metrosAlEsteDe(comandoCentral.alertas.single().getDouble("lon")), 0.5)
    }

    /**
     * Al revés: el GPS se pierde entre las dos. La segunda confirma igual, pero
     * sin posición del objetivo no hay a qué orbitar: se alerta sin seguimiento
     * y el registro dice por qué.
     */
    @Test
    fun laConfirmacionQueCruzaLaPerdidaDelGpsAlertaSinSeguimiento() = runBlocking {
        patrullando()

        detectar()
        telemetria(lat = Double.NaN, lon = Double.NaN)
        detectar()

        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        assertTrue(comandoCentral.alertas.single().isNull("lat"))
        esperarA("el registro") { comandoCentral.eventos("DETECTION").isNotEmpty() }
        assertTrue(comandoCentral.eventos("DETECTION").single().getString("message").contains("sin GPS"))
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertNull(dron.ultimaOrbita)
    }

    /**
     * Sin GPS y sin cajas (el detector de respaldo) la alerta es del tipo más
     * urgente que se vio: un vehículo manda sobre una persona.
     */
    @Test
    fun sinGpsNiCajasLaAlertaEsDelTipoMasUrgente() = runBlocking {
        arrancarEscuchando()
        telemetria(lat = Double.NaN, lon = Double.NaN)
        patrulla.startPatrol(ruta)

        val ambas = Deteccion(listOf("PERSON", "VEHICLE"), 0.8, emptyList(), "/9j/x", 1L)
        detectar(ambas)
        detectar(ambas)

        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        val alerta = comandoCentral.alertas.single()
        assertEquals("VEHICLE", alerta.getString("alertType"))
        assertEquals(0.8, alerta.getDouble("confidence"), 1e-9)
        assertTrue(alerta.isNull("lat"))
    }

    /** Con varias cajas, el objetivo es la más segura y no la primera de la lista. */
    @Test
    fun conVariasCajasElObjetivoEsLaMasSegura() = runBlocking {
        patrullando()
        val dos = Deteccion(
            clases = listOf("PERSON"),
            confianza = 0.95,
            cajas = listOf(Caja("PERSON", 0.6, 0.2, 0.2, 0.05, 0.1), Caja("PERSON", 0.95, 0.5, 0.5, 0.05, 0.1)),
            snapshotBase64 = null,
            ts = 1L,
        )

        detectar(dos)
        detectar(dos)

        esperarA("la órbita") { dron.ultimaOrbita != null }
        val (lat, lon) = dron.ultimaOrbita!!
        assertEquals(ADELANTE_M, metrosAlEsteDe(lon), 0.5)
        assertEquals(0.0, metrosAlNorteDe(lat), 0.5)
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        assertEquals(0.95, comandoCentral.alertas.single().getDouble("confidence"), 1e-9)
    }

    // ---- Georreferencia con la pose del cuadro ----

    /**
     * La respuesta del detector llega hasta un segundo después de su cuadro,
     * con el dron ya en otro lado. Con la hora del cuadro se usa la pose de ESE
     * instante: el objetivo queda adelante de donde estaba el dron, no 200 m
     * más allá.
     */
    @Test
    fun cadaDeteccionSeUbicaConLaPoseDelInstanteDeSuCuadro() = runBlocking {
        arrancarEscuchando()
        val t0 = System.currentTimeMillis()
        telemetria(ts = t0)
        telemetria(lat = LAT + 2 * CIEN_M_AL_NORTE, ts = t0 + 1_000)
        patrulla.startPatrol(ruta)

        val delCuadro = personaEnElCentro.copy(frameTs = t0 + 100)
        detectar(delCuadro)
        detectar(delCuadro)

        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        val alerta = comandoCentral.alertas.single()
        assertEquals(LAT, alerta.getDouble("droneLat"), 1e-9)
        assertEquals(0.0, metrosAlNorteDe(alerta.getDouble("lat")), 0.5)
        assertEquals(ADELANTE_M, metrosAlEsteDe(alerta.getDouble("lon")), 0.5)
    }

    /**
     * La historia de poses es de los últimos segundos y no de todo el vuelo:
     * una pose más vieja que eso se descarta, y un cuadro de esa época se ubica
     * con la más vieja que quedó.
     */
    @Test
    fun laHistoriaDePosesSoloGuardaLosUltimosSegundos() = runBlocking {
        arrancarEscuchando()
        val t0 = System.currentTimeMillis()
        telemetria(ts = t0)
        telemetria(lat = LAT + 2 * CIEN_M_AL_NORTE, ts = t0 + PatrolManager.HISTORIA_DE_POSES_MS + 500)
        patrulla.startPatrol(ruta)

        val viejo = personaEnElCentro.copy(frameTs = t0)
        detectar(viejo)
        detectar(viejo)

        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        assertEquals(200.0, metrosAlNorteDe(comandoCentral.alertas.single().getDouble("droneLat")), 1e-6)
    }

    /**
     * Sin una sola telemetría no hay pose con la que ubicar nada: no se alerta,
     * venga o no la hora del cuadro. Las cajas igual se dibujan sobre el video.
     */
    @Test
    fun sinTelemetriaNoSeAlertaPeroLasCajasSeDibujan() = runBlocking {
        patrulla.start()

        detectar(personaEnElCentro.copy(frameTs = 123L))
        detectar()
        detectar()
        delay(200)

        assertEquals(personaEnElCentro.cajas, patrulla.cajasRecientes.value)
        assertTrue(comandoCentral.alertas.isEmpty())
        assertEquals(PatrolState.IDLE, patrulla.state.value)
    }

    // ---- La captura y el video ----

    /** Espera a que el reparto escuche el video: el flujo del dron no repite cuadros viejos. */
    private suspend fun mandarUnCuadro(cuadro: ByteArray, cuantosVanAlComandoCentral: Int) {
        withTimeout(5_000) { dron.videoFrames.subscriptionCount.first { it > 0 } }
        dron.videoFrames.emit(cuadro)
        esperarA("el cuadro en el Comando Central") { comandoCentral.mensajes("video_frame").size == cuantosVanAlComandoCentral }
    }

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

    /** Si el detector no manda su captura (el mock), la alerta lleva el último cuadro que vio la consola. */
    @Test
    fun sinCapturaDelDetectorLaAlertaConSeguimientoLlevaElUltimoCuadro() = runBlocking {
        patrullando()
        val cuadro = byteArrayOf(1, 2, 3, 4)
        mandarUnCuadro(cuadro, 1)

        detectar(personaEnElCentro.copy(snapshotBase64 = null))
        detectar(personaEnElCentro.copy(snapshotBase64 = null))

        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertEquals(b64(cuadro), comandoCentral.alertas.single().getString("snapshotBase64"))
    }

    /** Lo mismo para la alerta sin seguimiento (el dron en el suelo). */
    @Test
    fun sinCapturaDelDetectorLaAlertaSinSeguimientoLlevaElUltimoCuadro() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        telemetria(alt = 0.0)
        val cuadro = byteArrayOf(5, 6, 7, 8)
        mandarUnCuadro(cuadro, 1)

        detectar(personaEnElCentro.copy(snapshotBase64 = null))
        detectar(personaEnElCentro.copy(snapshotBase64 = null))

        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        assertEquals(b64(cuadro), comandoCentral.alertas.single().getString("snapshotBase64"))
    }

    /**
     * Mientras las cajas de una detección están vigentes, el video que mira el
     * operador sale anotado; antes de la detección, el mismo cuadro sale tal
     * cual.
     */
    @Test
    fun elVideoDeLaConsolaSaleAnotadoMientrasLasCajasEstanVigentes() = runBlocking {
        patrulla.start()
        val cuadro = unJpeg()
        mandarUnCuadro(cuadro, 1)
        val limpio = comandoCentral.mensajes("video_frame")[0].getString("jpegBase64")
        assertEquals(b64(cuadro), limpio)

        // La vigencia de las cajas se mide contra el reloj de la patrulla, y el
        // reparto mira el del teléfono: se los alinea antes de detectar.
        reloj.ms = System.currentTimeMillis()
        detectar()
        mandarUnCuadro(cuadro, 2)

        assertNotEquals("el cuadro salió sin las cajas", limpio, comandoCentral.mensajes("video_frame")[1].getString("jpegBase64"))
    }

    private fun unJpeg(): ByteArray {
        val mapa = Bitmap.createBitmap(64, 36, Bitmap.Config.ARGB_8888)
        val salida = ByteArrayOutputStream()
        mapa.compress(Bitmap.CompressFormat.JPEG, 60, salida)
        return salida.toByteArray()
    }
}
