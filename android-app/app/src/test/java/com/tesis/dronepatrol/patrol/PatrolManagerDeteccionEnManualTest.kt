package com.tesis.dronepatrol.patrol

import android.graphics.Bitmap
import android.util.Base64
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Waypoint
import java.io.ByteArrayOutputStream
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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Lo que el detector ve mientras una persona maneja el dron desde la consola
 * (docs/PROTOCOLS.md §4, "Qué hace la app con una detección"): las cajas siguen
 * dibujadas sobre el video, pero NO sale ninguna alerta —ni `alert_request`, ni
 * seguimiento nuevo, ni evento—. El que maneja está mirando ese mismo video, y
 * la tarjeta de la alerta le tapaba la pantalla para avisarle lo que ya veía.
 *
 * Lo que de verdad hay que cuidar es la salida: al soltar el control, nada de lo
 * visto mientras tanto sale de golpe, y la próxima detección confirmada alerta
 * como siempre (hacen falta dos de nuevo). La puerta es el estado MANUAL y no el
 * lock: con el control tomado y el dron volando solo se alerta, y al volver a
 * MANUAL por un aterrizaje o una señal recuperada con el control tomado, no.
 *
 * El reloj del seguimiento es falso y queda quieto, así que dos detecciones
 * siempre caen dentro de la ventana de confirmación: lo que decide si alertan
 * es el estado, no cuánto tardó el test. El de la señal también es falso, para
 * cortarla sin esperar los 4 s.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerDeteccionEnManualTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = ComandoCentralEspia(alcance)
    private val deteccion = DetectionClient(alcance)
    private val reloj = RelojFalso()
    private val relojDeLaSenial = RelojFalso()
    private val patrulla = PatrolManager(
        dron, comandoCentral, deteccion, alcance, "TEST",
        reloj = reloj::ahora,
        relojDeLaSenial = relojDeLaSenial::ahora,
    )
    private val ruta = PatrolRoute(1, "Manzana", listOf(Waypoint(LAT + 0.002, LON, ALT), Waypoint(LAT, LON + 0.002, ALT)))

    /** Una persona en el centro del cuadro: con la cámara a 70° hacia abajo, a 16 m adelante del dron. */
    private val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/captura", 1L)

    @Before
    fun armar() {
        patrulla.start()
        patrulla.availableRoutes = listOf(ruta)
    }

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private fun mensaje(json: String) = comandoCentral.manejarMensaje(json)

    private suspend fun esperarEstado(estado: PatrolState) {
        withTimeout(5_000) { patrulla.state.first { it == estado } }
    }

    private suspend fun telemetria(alt: Double = ALT, bateria: Double = 100.0) {
        dron.emitirTelemetria(LAT, LON, bateria = bateria, alt = alt, rumbo = 90.0, gimbal = -70.0)
        delay(80)
    }

    private suspend fun patrullando() {
        telemetria()
        patrulla.startPatrol(ruta)
        esperarEstado(PatrolState.PATROLLING)
    }

    private suspend fun tomarElControl() {
        mensaje("""{"type":"control_taken","by":"op"}""")
        esperarEstado(PatrolState.MANUAL)
    }

    private fun soltarElControl() = mensaje("""{"type":"control_released","by":"op"}""")

    private suspend fun detectar(d: Deteccion = persona) {
        deteccion.onDetection?.invoke(d)
        delay(80)
    }

    /** Dos detecciones seguidas del mismo objetivo: afuera de MANUAL, la segunda confirma la primera. */
    private suspend fun detectarDosVeces(d: Deteccion = persona) {
        detectar(d)
        detectar(d)
    }

    /** Ninguna alerta ni nada que la acompañe: ni la orden de orbitar, ni el objetivo, ni el evento. */
    private fun sinAlertas(cuando: String) {
        assertTrue("$cuando no tendría que salir ninguna alerta: ${comandoCentral.alertas}", comandoCentral.alertas.isEmpty())
        assertTrue("$cuando tampoco el registro sin seguimiento", comandoCentral.eventos("DETECTION").isEmpty())
        assertTrue("$cuando ni la detección del control manual de antes", comandoCentral.eventos("TARGET_DETECTED").isEmpty())
        assertTrue("$cuando ni una órbita", comandoCentral.eventos("ORBIT_STARTED").isEmpty())
        assertNull("$cuando ni un objetivo en seguimiento", patrulla.objetivo)
    }

    private fun unJpeg(): ByteArray {
        val mapa = Bitmap.createBitmap(64, 36, Bitmap.Config.ARGB_8888)
        val salida = ByteArrayOutputStream()
        mapa.compress(Bitmap.CompressFormat.JPEG, 60, salida)
        return salida.toByteArray()
    }

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun cuadrosALaConsola(): List<String> = comandoCentral.mensajes("video_frame").map { it.getString("jpegBase64") }

    @Test
    fun enManualLasDeteccionesNoAlertanPeroLasCajasSiguenEnElVideo() = runBlocking {
        patrullando()
        tomarElControl()
        assertTrue(
            "el teléfono avisa una vez, al tomar el control, que no va a alertar",
            patrulla.localLog.replayCache.any { it.contains("op tomó el control") && it.contains("no alerta") },
        )
        withTimeout(5_000) { dron.videoFrames.subscriptionCount.first { it > 0 } }
        val cuadro = unJpeg()
        dron.videoFrames.emit(cuadro)
        esperarA("el cuadro sin cajas") { cuadrosALaConsola().size == 1 }
        assertEquals("sin nada detectado el cuadro sale tal cual", b64(cuadro), cuadrosALaConsola()[0])

        repeat(3) { detectarDosVeces() }
        // El reparto mide la vigencia de las cajas con el reloj de verdad: se
        // alinea justo antes de la última, y el cuadro sale enseguida, para que
        // de los 1,5 s de vigencia el test gaste una sola detección.
        reloj.ms = System.currentTimeMillis()
        detectar()
        dron.videoFrames.emit(cuadro)
        assertEquals("las cajas quedan para dibujarlas", persona.cajas, patrulla.cajasRecientes.value)
        assertEquals(persona.cajas, patrulla.cajasVigentes(reloj.ahora()))
        esperarA("el cuadro con las cajas") { cuadrosALaConsola().size == 2 }
        assertNotEquals("con cajas vigentes el cuadro sale anotado, también en MANUAL", b64(cuadro), cuadrosALaConsola()[1])

        delay(200)
        sinAlertas("con el control tomado")
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertFalse("el dron sigue siendo del operador: ${dron.ordenes}", dron.ordenes.contains("startOrbit"))
    }

    /**
     * Al soltar no sale nada de lo que se vio mientras manejaba, ni siquiera
     * como la primera de una confirmación: la primera detección después de
     * soltar es una candidata nueva, y la segunda alerta y arranca la órbita.
     *
     * La tanda en MANUAL termina en una cantidad IMPAR a propósito: con una par,
     * una confirmación que corriera en MANUAL (y solo callara la alerta) dejaba
     * la candidata vacía igual, y el test no la veía. Con la impar, la última
     * quedaría de candidata y la primera después de soltar alertaría.
     */
    @Test
    fun alSoltarLaProximaDeteccionConfirmadaAlertaComoSiempreYSinRafaga() = runBlocking {
        patrullando()
        tomarElControl()
        repeat(5) { detectarDosVeces() }
        detectar()
        delay(200)
        sinAlertas("manejando")

        soltarElControl()
        esperarEstado(PatrolState.PAUSED)
        delay(300)
        sinAlertas("al soltar")

        detectar()
        delay(300)
        sinAlertas("con una sola detección después de soltar")
        assertEquals(PatrolState.PAUSED, patrulla.state.value)

        detectar()
        esperarEstado(PatrolState.ORBITING)
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
        esperarA("la órbita sobre el objetivo") { comandoCentral.eventos("ORBIT_STARTED").size == 1 }
        delay(300)
        assertEquals("una sola alerta: la de la detección nueva", 1, comandoCentral.alertas.size)
        assertEquals("/9j/captura", comandoCentral.alertas.single().getString("snapshotBase64"))
    }

    /** Tomado en el suelo también es MANUAL: no alerta; suelto, en reposo, alerta sin seguimiento. */
    @Test
    fun conElControlTomadoEnElSueloTampocoAlertaYAlSoltarloSi() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        telemetria(alt = 0.0)
        tomarElControl()

        detectarDosVeces()
        delay(300)
        sinAlertas("en el suelo con el control tomado")

        soltarElControl()
        esperarEstado(PatrolState.IDLE)
        detectarDosVeces()
        esperarA("la alerta sin seguimiento") { comandoCentral.alertas.size == 1 }
        esperarA("el registro de la detección") { comandoCentral.eventos("DETECTION").isNotEmpty() }
        assertTrue(comandoCentral.eventos("DETECTION").single().getString("message").contains("suelo"))
    }

    /**
     * Una ruta pedida desde la consola sin soltar el control: el lock sigue
     * tomado, pero el dron vuela solo (el mando ya no le llega) y nadie lo
     * maneja. Ahí una persona en el cuadro alerta y el dron la orbita.
     */
    @Test
    fun unaOrdenQueLoSacaDeManualSinSoltarElControlVuelveAAlertar() = runBlocking {
        patrullando()
        tomarElControl()
        mensaje("""{"type":"manual_stick","pitch":0.5,"roll":0,"yaw":0,"throttle":0,"by":"op"}""")
        esperarA("el mando en MANUAL") { dron.ordenes.any { it.startsWith("stick(0.5") } }
        detectarDosVeces()
        delay(200)
        sinAlertas("manejando")

        mensaje("""{"type":"start_route","routeId":1,"fromIndex":0,"orderedBy":"op"}""")
        esperarEstado(PatrolState.PATROLLING)
        mensaje("""{"type":"manual_stick","pitch":0.3,"roll":0,"yaw":0,"throttle":0,"by":"op"}""")
        delay(100)
        assertFalse("con la ruta el mando ya no le llega al dron: ${dron.ordenes}", dron.ordenes.any { it.startsWith("stick(0.3") })

        detectarDosVeces()
        esperarEstado(PatrolState.ORBITING)
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
    }

    /**
     * Batería baja con el control tomado: vuelve a base (ahí nunca se alertó),
     * toca tierra y queda en MANUAL en el suelo sin que nadie haya vuelto a
     * tomar el control. Sigue sin alertar; recién al soltarlo, en el suelo y con
     * la batería por cambiar, alerta sin seguimiento.
     */
    @Test
    fun despuesDeLaBateriaBajaYElAterrizajeConElControlTomadoSigueSinAlertar() = runBlocking {
        patrullando()
        tomarElControl()
        telemetria(bateria = 20.0)
        esperarEstado(PatrolState.RETURNING_HOME_BATTERY)
        detectarDosVeces()
        delay(200)
        sinAlertas("volviendo por batería")

        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        telemetria(alt = 0.0, bateria = 20.0)
        dron.flightEvents.emit(FlightEvent.ArrivedHome)
        esperarEstado(PatrolState.MANUAL)
        detectarDosVeces()
        delay(300)
        sinAlertas("aterrizado con el control tomado")

        soltarElControl()
        esperarEstado(PatrolState.LANDED)
        detectarDosVeces()
        esperarA("la alerta sin seguimiento") { comandoCentral.alertas.size == 1 }
        esperarA("el registro de la detección") { comandoCentral.eventos("DETECTION").isNotEmpty() }
        assertTrue(comandoCentral.eventos("DETECTION").single().getString("message").contains("suelo"))
    }

    /** La señal vuelve con el control todavía tomado: el dron vuelve a MANUAL por su cuenta, y tampoco alerta. */
    @Test
    fun alVolverLaSenialConElControlTomadoSigueSinAlertar() = runBlocking {
        patrullando()
        tomarElControl()
        relojDeLaSenial.adelantar(PatrolManager.SIGNAL_TIMEOUT_MS + 1_000)
        esperarEstado(PatrolState.RETURNING_HOME_SIGNAL)

        telemetria()
        esperarEstado(PatrolState.MANUAL)
        esperarA("CONTROL_RESUMED") { comandoCentral.eventos("CONTROL_RESUMED").isNotEmpty() }
        detectarDosVeces()
        delay(300)
        sinAlertas("con la señal de vuelta y el control tomado")
    }

    /**
     * Se corta el enlace con el Comando Central con el control tomado y el hub
     * registra el cierre: borra el lock sin poder avisarle a la app, que queda
     * en MANUAL con nadie al mando. Al reconectar, el hub se lo suelta él
     * (`by: "Comando Central"`, PROTOCOLS "Control manual — bloqueo exclusivo"):
     * el dron sale de MANUAL y lo que vea desde ahí vuelve a alertar, que es
     * justo el caso de "nadie lo está manejando".
     */
    @Test
    fun siAlReconectarElHubLeSueltaElControlHuerfanoVuelveAAlertar() = runBlocking {
        patrullando()
        tomarElControl()
        comandoCentral.connected.value = false
        delay(100)
        detectarDosVeces()
        delay(200)
        sinAlertas("sin enlace y en MANUAL")

        comandoCentral.connected.value = true
        mensaje("""{"type":"control_released","by":"Comando Central"}""")
        esperarEstado(PatrolState.PAUSED)
        assertTrue(
            "el teléfono anota quién lo soltó",
            patrulla.localLog.replayCache.any { it.contains("Comando Central liberó el control") },
        )
        detectarDosVeces()
        esperarEstado(PatrolState.ORBITING)
        esperarA("la alerta") { comandoCentral.alertas.size == 1 }
    }
}
