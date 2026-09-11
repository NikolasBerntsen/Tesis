package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.drone.SimulatedDroneController
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolState
import kotlin.math.cos
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Mando virtual visto desde la máquina de estados: cuándo se aplica, cuándo se
 * ignora y qué hace el watchdog cuando el mando se calla.
 *
 * El armado es el de la app de verdad —dron simulado y los dos clientes— salvo
 * que ninguno de los clientes se conecta: sin `connect()` su WebSocket es null y
 * todo lo que "mandan" cae al vacío, así que las órdenes del Comando Central se
 * disparan invocando sus callbacks a mano, igual que las manda el socket.
 *
 * Usa Robolectric porque el video del simulado dibuja con android.graphics y el
 * reparto de cuadros codifica en Base64; los tiempos son reales (tick de 500 ms).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerMandoTest {

    private companion object {
        // El punto en el que arranca el dron simulado: el Obelisco.
        const val BASE_LAT = -34.6037
        const val M_POR_GRADO_LAT = 111_320.0
        val M_POR_GRADO_LON = M_POR_GRADO_LAT * cos(Math.toRadians(BASE_LAT))
        const val AVISO_DEL_WATCHDOG = "no llegan órdenes de mando"
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = SimulatedDroneController()
    private val comandoCentral = CommandCenterClient(alcance)
    private val deteccion = DetectionClient(alcance)
    private lateinit var patrulla: PatrolManager

    @Before
    fun armar() {
        patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST")
        patrulla.start()
        dron.connect()
    }

    @After
    fun desarmar() {
        dron.disconnect()
        alcance.cancel()
    }

    /** Sin control tomado no hay mando que valga: el dron sigue en lo suyo. */
    @Test
    fun elMandoSeIgnoraFueraDeManual() = runBlocking {
        val antes = withTimeout(5_000) { dron.telemetry.first() }
        assertEquals(PatrolState.IDLE, patrulla.state.value)

        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 1.0, "operador1")
        delay(1_500)

        val despues = dron.telemetry.first()
        assertEquals("no tendría que haberse movido", antes.lat, despues.lat, 1e-12)
        assertEquals(antes.lon, despues.lon, 1e-12)
        assertEquals("ni haber subido", antes.altM, despues.altM, 1e-12)
    }

    @Test
    fun enManualElMandoLlegaAlDron() = runBlocking {
        tomarElControl()
        val antes = withTimeout(5_000) { dron.telemetry.first() }

        comandoCentral.onManualStick?.invoke(0.0, 0.0, 0.0, 1.0, "operador1")
        delay(1_200)

        val despues = dron.telemetry.first()
        assertTrue("altura antes=${antes.altM} después=${despues.altM}", despues.altM > antes.altM + 1.0)
    }

    /**
     * La red de seguridad: se corta el internet del celular en pleno movimiento
     * y no llega ningún mando más. El dron no puede quedarse con la última
     * velocidad, así que la app le manda ceros por su cuenta.
     */
    @Test
    fun elWatchdogMandaCerosCuandoElMandoSeCalla() = runBlocking {
        tomarElControl()

        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")
        // A partir de acá nadie manda nada: el watchdog tiene que saltar solo
        withTimeout(10_000) { patrulla.localLog.first { it.contains("no llegan órdenes de mando") } }

        delay(1_200) // que termine de frenar el tick en curso
        val frenado = dron.telemetry.first()
        delay(1_500)
        val despues = dron.telemetry.first()
        assertEquals("tendría que haber quedado quieto", frenado.lat, despues.lat, 1e-12)
        assertEquals(frenado.lon, despues.lon, 1e-12)
    }

    /** Mientras el mando siga llegando, el watchdog no tiene nada que hacer. */
    @Test
    fun elWatchdogNoSaltaSiElMandoSigueLlegando() = runBlocking {
        tomarElControl()

        // Cuatro segundos de mando sostenido a 10 Hz, como manda la consola
        repeat(40) {
            comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")
            delay(100)
        }

        assertTrue("el watchdog no tendría que haber saltado: ${avisosDelWatchdog()}", avisosDelWatchdog().isEmpty())
    }

    /**
     * El roll por la cadena real: consola → PatrolManager → dron. Sin este caso
     * se podía borrar el eje de la llamada a `manualStick` y toda la suite seguía
     * verde, con el dron sin desplazamiento lateral.
     */
    @Test
    fun enManualElRollLoMueveDeCostado() = runBlocking {
        tomarElControl()
        val antes = withTimeout(5_000) { dron.telemetry.first() }

        comandoCentral.onManualStick?.invoke(0.0, 1.0, 0.0, 0.0, "operador1")
        delay(1_500)

        val despues = dron.telemetry.first()
        val metrosAlEste = (despues.lon - antes.lon) * M_POR_GRADO_LON
        assertTrue("se corrió $metrosAlEste m al este", metrosAlEste > 3.0)
        assertEquals("no tendría que haber avanzado", antes.lat, despues.lat, 1e-9)
    }

    // ---- Las dos guardas que evitan que el watchdog salte de prepo ----

    /**
     * Recién tomado el control todavía no llegó ningún mando: no hay velocidad
     * que cortar. Sin la guarda de `ultimoMandoMs == 0`, la resta contra el
     * epoch da un número enorme, el watchdog salta a los ~250 ms y escribe un
     * aviso falso de corte de enlace (y saca al dron simulado del vuelo
     * estacionario, que deja de corregir la altura de crucero).
     */
    @Test
    fun elWatchdogNoSaltaSiNuncaLlegoUnMando() = runBlocking {
        tomarElControl()

        delay(PatrolManager.MANDO_TIMEOUT_MS + 1_000) // más que el timeout, sin mandar nada

        assertTrue("el watchdog no tendría que haber saltado: ${avisosDelWatchdog()}", avisosDelWatchdog().isEmpty())
    }

    /** Y si el último mando ya dejaba al dron quieto, tampoco hay nada que corregir. */
    @Test
    fun elWatchdogNoSaltaSiElUltimoMandoYaEraDeCeros() = runBlocking {
        tomarElControl()
        comandoCentral.onManualStick?.invoke(0.0, 0.0, 0.0, 0.0, "operador1")

        delay(PatrolManager.MANDO_TIMEOUT_MS + 1_000)

        assertTrue("el watchdog no tendría que haber saltado: ${avisosDelWatchdog()}", avisosDelWatchdog().isEmpty())
    }

    /**
     * El límite exacto, que adentro del lazo es intestable: el watchdog lee el
     * reloj él mismo y revisa cada 250 ms, así que nunca se lo puede parar en
     * los 1500 ms justos.
     */
    @Test
    fun elLimiteDelWatchdogCaeDelLadoDeEsperar() {
        val ultimo = 10_000L

        assertFalse(
            "justo en el límite todavía no se corta",
            PatrolManager.hayQueCortarElMando(ultimo + PatrolManager.MANDO_TIMEOUT_MS, ultimo, estacionario = false),
        )
        assertTrue(
            "un milisegundo después sí",
            PatrolManager.hayQueCortarElMando(ultimo + PatrolManager.MANDO_TIMEOUT_MS + 1, ultimo, estacionario = false),
        )
    }

    @Test
    fun sinMandoPrevioOConElUltimoEnCeroNoHayNadaQueCortar() {
        assertFalse(
            "nunca llegó un mando",
            PatrolManager.hayQueCortarElMando(ahoraMs = 99_999_999L, ultimoMandoMs = 0L, estacionario = false),
        )
        assertFalse(
            "el último mando ya dejaba al dron quieto",
            PatrolManager.hayQueCortarElMando(ahoraMs = 99_999_999L, ultimoMandoMs = 1L, estacionario = true),
        )
    }

    // ---- Mando virtual contra desplazamiento puntual ----

    /**
     * Manda el último comando DELIBERADO. El mensaje con los cuatro ejes en cero
     * es el que la consola manda al SOLTAR la palanca —el cierre del gesto, no
     * una orden de frenar—, y el pad y las palancas viven en el mismo panel: con
     * la regla vieja, rozar una palanca abandonaba el salto de 25 m a mitad de
     * camino y en silencio, en contra de lo que la propia consola promete.
     */
    @Test
    fun elCierreDeLaPalancaNoAbortaUnDesplazamientoPuntual() = runBlocking {
        tomarElControl()
        val antes = esperarTelemetria()

        comandoCentral.onManualMove?.invoke(0.0, 25.0, "operador1") // 25 m al norte
        delay(300)
        comandoCentral.onManualStick?.invoke(0.0, 0.0, 0.0, 0.0, "operador1")

        val llegada = withTimeoutOrNull(10_000) { dron.flightEvents.first { it is FlightEvent.GotoArrived } }

        assertNotNull("el salto de 25 m se abandonó a mitad de camino", llegada)
        val recorrido = (dron.telemetry.first().lat - antes.lat) * M_POR_GRADO_LAT
        assertTrue("solo recorrió $recorrido m de los 25", recorrido > 18.0)
    }

    /**
     * La otra mitad de la misma regla: un eje fuera de la zona muerta es el
     * operador agarrando la palanca a propósito, y ahí sí el salto se abandona.
     * Si el mando se descartara mientras hay un desplazamiento en curso, el dron
     * seguiría viaje sin que nadie lo pueda parar con la palanca.
     */
    @Test
    fun unMandoDeliberadoSiAbortaElDesplazamientoPuntual() = runBlocking {
        tomarElControl()
        esperarTelemetria()

        comandoCentral.onManualMove?.invoke(0.0, 400.0, "operador1") // lejos: no llega solo
        delay(300)
        comandoCentral.onManualStick?.invoke(0.0, 0.0, 0.0, 1.0, "operador1") // se agarra la palanca
        delay(1_000)
        comandoCentral.onManualStick?.invoke(0.0, 0.0, 0.0, 0.0, "operador1") // y se suelta
        delay(700) // margen para que termine el tick en curso

        val t1 = dron.telemetry.first()
        delay(1_500)
        val t2 = dron.telemetry.first()
        assertEquals("el desplazamiento tendría que haberse abandonado", t1.lat, t2.lat, 1e-12)
    }

    // ---- Salida de MANUAL por pérdida de señal ----

    /**
     * El caso que más caro sale: el dron en MANUAL avanzando a fondo y se corta
     * el enlace de radio. Antes, salir de MANUAL no tocaba el controlador: el
     * dron se quedaba con los últimos 5 m/s y el watchdog —la red de seguridad
     * que existe justo para esto— se apagaba solo porque miraba el estado. Al
     * volver la señal el dron retomaba la marcha con nadie al mando y, sin ruta
     * cargada, el estado quedaba clavado en RETURNING_HOME_SIGNAL para siempre:
     * ningún camino de vuelta lo frenaba.
     */
    @Test
    fun perderLaSenialEnManualDejaAlDronQuietoYConSalida() = runBlocking {
        tomarElControl()
        esperarTelemetria()

        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1") // a fondo adelante
        delay(1_200)
        dron.setSignalLost(true)

        withTimeout(9_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_SIGNAL } }
        // Se devuelve enseguida: pasado el failsafe del propio dron simulado
        // (6 s) el que mueve el dron es el RTH y no el mando viejo, y lo que se
        // quiere medir es el mando.
        dron.setSignalLost(false)

        // El operador nunca soltó el control: vuelve a tenerlo, y no clavado en
        // el regreso a base.
        val estado = withTimeout(6_000) { patrulla.state.first { it != PatrolState.RETURNING_HOME_SIGNAL } }
        assertEquals(PatrolState.MANUAL, estado)

        delay(700) // margen para que termine el tick en curso
        val t1 = dron.telemetry.first()
        delay(1_500)
        val t2 = dron.telemetry.first()
        assertEquals("tendría que haber quedado quieto", t1.lat, t2.lat, 1e-12)
        assertEquals(t1.lon, t2.lon, 1e-12)
    }

    /**
     * Mismo corte, pero el operador suelta el control mientras el dron vuelve a
     * base. Al recuperar la señal no hay ni control tomado ni ruta cargada: el
     * estado tiene que caer en algo de lo que se pueda salir. Antes soltar el
     * control se iba por el guard `estado != MANUAL` y resumePatrol se iba por
     * `route ?: return`: no quedaba un solo botón que sirviera.
     */
    @Test
    fun sinRutaNiControlLaSenialRecuperadaNoDejaElEstadoClavado() = runBlocking {
        tomarElControl()
        esperarTelemetria()

        dron.setSignalLost(true)
        withTimeout(9_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_SIGNAL } }
        comandoCentral.onControlReleased?.invoke("operador1")
        dron.setSignalLost(false)

        val estado = withTimeout(6_000) { patrulla.state.first { it != PatrolState.RETURNING_HOME_SIGNAL } }
        assertEquals(PatrolState.PAUSED, estado)
    }

    /** Deja el patrullaje en MANUAL, que es el único estado que acepta mando. */
    private suspend fun tomarElControl() {
        comandoCentral.onControlTaken?.invoke("operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
    }

    /**
     * Espera la primera telemetría y le da al patrullaje un momento para
     * recibirla: `manual_move` se calcula sobre la última posición conocida y sin
     * ella se descarta.
     */
    private suspend fun esperarTelemetria() = withTimeout(5_000) { dron.telemetry.first() }.also { delay(300) }

    private fun avisosDelWatchdog() = patrulla.localLog.replayCache.filter { it.contains(AVISO_DEL_WATCHDOG) }
}
