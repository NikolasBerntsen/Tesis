package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Waypoint
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
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
 * Qué le queda ordenado al dron cuando el patrullaje SALE del control manual.
 *
 * Es el defecto más caro que encontró el contraste: el dron sostiene la última
 * velocidad comandada hasta que le llegue otra, así que salir de MANUAL sin
 * frenarlo —por pérdida de señal, por batería, por lo que sea— lo deja andando
 * con nadie al mando. Acá el dron es un espía que anota cada orden: es la única
 * forma de distinguir "se lo frenó al salir" de "se quedó quieto de casualidad".
 *
 * Usa Robolectric porque el reparto de cuadros de PatrolManager codifica en
 * Base64, que es de android.util; los tiempos son reales (el corte de señal se
 * declara a los 4 s).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerSalidasDeManualTest {

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
    }

    @After
    fun desarmar() {
        alcance.cancel()
    }

    /**
     * El corte del enlace de radio dron↔control con el operador manteniendo la
     * palanca a fondo. Ojo: el celular sigue online, así que la consola SIGUE
     * mandando el mando a 10 Hz — por eso el watchdog no tiene de qué quejarse y
     * la única forma de que el dron quede quieto es que la salida de MANUAL lo
     * frene. Sin eso, el lazo de Virtual Stick le repetía los últimos 5 m/s para
     * siempre y el dron retomaba la marcha apenas se reenganchaba el enlace.
     */
    @Test
    fun perderLaSenialConLaPalancaTomadaDejaAlDronQuieto() = runBlocking {
        tomarElControl()
        val palanca = mantenerLaPalanca(pitch = 1.0)

        // Se deja de emitir telemetría: eso es el corte del enlace de radio
        withTimeout(12_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_SIGNAL } }
        palanca.cancel()

        assertTrue(
            "al salir de MANUAL el dron quedó comandado a la última velocidad: ${dron.ultimaOrden}",
            dron.laUltimaOrdenLoDejaQuieto(),
        )
    }

    /** Soltar el control también lo deja quieto, y con un estado del que se puede salir. */
    @Test
    fun soltarElControlDejaAlDronQuieto() = runBlocking {
        tomarElControl()
        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")

        comandoCentral.onControlReleased?.invoke("operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PAUSED } }

        assertTrue("quedó andando después de soltar el control: ${dron.ultimaOrden}", dron.laUltimaOrdenLoDejaQuieto())
    }

    /**
     * Y la vuelta: el watchdog no puede cortarle una orden que ya no es del
     * mando. Si al salir de MANUAL el mando queda colgado, un segundo y medio
     * después el watchdog manda ejes en cero y eso —en el DJI— cancela el lazo
     * de la ruta que se acaba de ordenar.
     */
    @Test
    fun reanudarLaRutaDesdeManualNoSeLaCortaElWatchdog() = runBlocking {
        patrulla.availableRoutes = listOf(ruta)
        tomarElControl()
        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")

        comandoCentral.onStartRoute?.invoke(ruta.id, 0, "operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        val hastaAca = dron.ordenes.size
        delay(PatrolManager.MANDO_TIMEOUT_MS + 1_000)

        val despues = dron.ordenes.drop(hastaAca)
        assertTrue("el watchdog le pisó la ruta con esto: $despues", despues.none { it.startsWith("stick") })
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
    }

    /**
     * Lo mismo con el regreso a base por batería: si el watchdog le manda ejes
     * en cero al rato, le cancela el RTH y el dron se queda donde está con la
     * batería al 20 %.
     */
    @Test
    fun elRegresoPorBateriaNoSeLoCortaElWatchdog() = runBlocking {
        tomarElControl()
        comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")

        dron.emitirTelemetria(bateria = 20.0)
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_BATTERY } }
        val hastaAca = dron.ordenes.size
        delay(PatrolManager.MANDO_TIMEOUT_MS + 1_000)

        val despues = dron.ordenes.drop(hastaAca)
        assertTrue("el watchdog le pisó el regreso a base con esto: $despues", despues.none { it.startsWith("stick") })
    }

    /**
     * La misma carrera que el caso de arriba pero con el mando llegando DESDE OTRO
     * HILO mientras se dispara la transición, que es como pasa en el campo: los
     * `manual_stick` los ejecuta el hilo lector de OkHttp —a propósito, sin abrir
     * una corrutina por mensaje— y las transiciones corren en corrutinas.
     *
     * El test para el mando JUSTO adentro de la orden al dron y desde ahí baja la
     * batería. Lo que se mide es que la transición NO pueda completarse mientras
     * hay un mando a mitad de camino: sin exclusión mutua entre "leo el estado" y
     * "le hablo al dron", el regreso a base sale primero y el mando le llega
     * después y se lo releva (en el DJI, `manualStick` cancela el lazo de
     * navegación), o sea el dron yéndose a 5 m/s con la batería al 20 %. Los dos
     * casos de arriba invocan el mando una sola vez y estrictamente antes de la
     * transición, así que no pueden ver esto.
     */
    @Test
    fun unMandoAMitadDeCaminoNoDejaPasarElRegresoPorBateria() = runBlocking {
        tomarElControl()
        val mandoAdentroDelDron = CountDownLatch(1)
        val dejarSalirAlMando = CountDownLatch(1)
        dron.alRecibirLaOrden = { orden ->
            if (orden.startsWith("stick(1.0")) {
                mandoAdentroDelDron.countDown()
                dejarSalirAlMando.await(10, TimeUnit.SECONDS)
            }
        }
        val hiloDelWebSocket = thread(name = "mando-de-la-consola") {
            comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")
        }
        assertTrue("el mando nunca llegó al dron", mandoAdentroDelDron.await(10, TimeUnit.SECONDS))

        // Con el mando parado a mitad de camino, la batería cae al 20 %
        dron.emitirTelemetria(bateria = 20.0)
        delay(500) // sin exclusión, para acá la transición ya pasó entera

        assertEquals(
            "la transición corrió con un mando a mitad de camino: el mando le llega " +
                "al dron DESPUÉS del regreso a base y se lo releva",
            PatrolState.MANUAL,
            patrulla.state.value,
        )
        assertTrue("el regreso a base ya se le ordenó al dron: ${dron.ordenes}", "returnHome" !in dron.ordenes)

        // Soltado el mando, el regreso a base tiene que salir igual
        dejarSalirAlMando.countDown()
        hiloDelWebSocket.join()
        dron.alRecibirLaOrden = null
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.RETURNING_HOME_BATTERY } }
        delay(PatrolManager.MANDO_TIMEOUT_MS + 1_000) // y el watchdog tampoco lo corta después

        val ordenes = dron.ordenes
        val regreso = ordenes.indexOf("returnHome")
        assertTrue("nunca se ordenó el regreso a base: $ordenes", regreso >= 0)
        assertTrue(
            "un mando le llegó al dron después del regreso a base: $ordenes",
            ordenes.indexOfLast { it.startsWith("stick") } < regreso,
        )
    }

    /**
     * Y la otra mitad de la misma carrera: la orden al dron tiene que salir
     * DESPUÉS de pisar el estado, nunca antes. El operador puede apretar "Retomar
     * ruta" sin soltar el control, así que mientras corre la reanudación hay un
     * mando a 10 Hz golpeando la puerta: con la orden primero, un mando colado en
     * el medio ve MANUAL, pasa el guard y le releva el lazo de la ruta recién
     * ordenada. El estado reporta PATROLLING, la ruta está muerta y el dron se va
     * con los últimos ejes del operador. El cerrojo no alcanza para esto: la orden
     * y el estado son dos pasos distintos del mismo handler.
     */
    @Test
    fun elMandoNoSeCuelaEntreLaOrdenDeRutaYElEstado() = runBlocking {
        patrulla.availableRoutes = listOf(ruta)
        tomarElControl()
        val ordenDeRutaEnCurso = CountDownLatch(1)
        val dejarSalirLaRuta = CountDownLatch(1)
        dron.alRecibirLaOrden = { orden ->
            if (orden.startsWith("startRoute")) {
                ordenDeRutaEnCurso.countDown()
                dejarSalirLaRuta.await(10, TimeUnit.SECONDS)
            }
        }

        comandoCentral.onStartRoute?.invoke(ruta.id, 0, "operador1")
        assertTrue("nunca se ordenó la ruta", ordenDeRutaEnCurso.await(10, TimeUnit.SECONDS))
        // La orden de ruta está a mitad de camino y el operador —que nunca soltó el
        // control— sigue moviendo la palanca desde el hilo del WebSocket
        thread(name = "mando-de-la-consola") {
            comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")
        }.join()

        assertTrue(
            "un mando se coló entre la orden de ruta y el estado y le relevó la ruta: ${dron.ordenes}",
            dron.ordenes.none { it.startsWith("stick(1.0") },
        )

        dejarSalirLaRuta.countDown()
        dron.alRecibirLaOrden = null
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.PATROLLING } }
        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
    }

    /**
     * La tercera carrera del mismo panel: el pad de 25 m y las palancas conviven
     * en la consola y llegan por hilos distintos —el pad por el hilo principal y
     * el mando por el lector del WebSocket—, así que el salto tiene que marcarse
     * y ordenarse como UN solo paso.
     *
     * Suelto se perdía una actualización: un mando que caía entre la orden y la
     * marca relevaba el salto y la línea siguiente volvía a marcarlo como vivo.
     * Con esa marca espuria, el mensaje de cierre de la palanca —los cuatro ejes
     * en cero, el que manda la consola al soltar— se descartaba por "no abandonar
     * un salto en curso" y nunca llegaba al dron: el Virtual Stick le seguía
     * repitiendo los últimos 5 m/s a 10 Hz, sin nadie al mando, y el watchdog no
     * lo cortaba porque la marca decía "estacionario".
     */
    @Test
    fun unMandoAMitadDelSaltoDe25mNoDejaLaMarcaViva() = runBlocking {
        tomarElControl()
        val saltoEnCurso = CountDownLatch(1)
        val dejarSalirElSalto = CountDownLatch(1)
        dron.alRecibirLaOrden = { orden ->
            if (orden == "gotoPoint") {
                saltoEnCurso.countDown()
                dejarSalirElSalto.await(10, TimeUnit.SECONDS)
            }
        }

        val hiloDelPad = thread(name = "pad-de-la-consola") {
            comandoCentral.onManualMove?.invoke(0.0, 25.0, "operador1")
        }
        assertTrue("nunca se ordenó el salto de 25 m", saltoEnCurso.await(10, TimeUnit.SECONDS))
        // El operador no soltó la palanca mientras tocaba el pad: el mando sigue
        // llegando por el otro hilo, justo con el salto a mitad de camino.
        val hiloDelMando = thread(name = "mando-de-la-consola") {
            comandoCentral.onManualStick?.invoke(1.0, 0.0, 0.0, 0.0, "operador1")
        }
        delay(200) // que el hilo del mando llegue hasta el cerrojo
        dejarSalirElSalto.countDown()
        hiloDelPad.join()
        hiloDelMando.join()
        dron.alRecibirLaOrden = null

        // Y ahora sí suelta la palanca: la consola manda UN mensaje de cierre en
        // cero, y ese tiene que llegarle al dron.
        comandoCentral.onManualStick?.invoke(0.0, 0.0, 0.0, 0.0, "operador1")
        assertTrue(
            "el mensaje de cierre de la palanca se perdió por una marca de salto espuria: ${dron.ordenes}",
            dron.ordenes.contains("stick(0.0, 0.0, 0.0, 0.0)"),
        )
    }

    /** Deja el patrullaje en MANUAL con una posición conocida, como en el campo. */
    private suspend fun tomarElControl() {
        dron.emitirTelemetria()
        delay(200) // que el patrullaje llegue a verla: sin posición no hay manual_move
        comandoCentral.onControlTaken?.invoke("operador1")
        withTimeout(5_000) { patrulla.state.first { it == PatrolState.MANUAL } }
    }

    /**
     * La consola con la palanca tomada: diez mensajes por segundo. Va en su
     * propia corrutina porque tiene que seguir mandando mientras el enlace de
     * radio con el dron se cae — el que se corta es ese, no el del celular.
     */
    private fun mantenerLaPalanca(pitch: Double): Job = alcance.launch {
        while (true) {
            comandoCentral.onManualStick?.invoke(pitch, 0.0, 0.0, 0.0, "operador1")
            delay(100)
        }
    }
}
