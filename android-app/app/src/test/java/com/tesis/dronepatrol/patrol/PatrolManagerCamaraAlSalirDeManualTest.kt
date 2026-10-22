package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Waypoint
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
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
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Lo que pasa con la inclinación de la consola (`manual_gimbal`) cuando el
 * patrullaje SALE de MANUAL: PatrolManager le pide al controlador que tire la
 * que tenga esperando ([DronEspia.CANCELAR_CAMARA]), y se lo pide ANTES de darle
 * la orden del estado siguiente.
 *
 * Hace falta porque el controlador real no le pasa la inclinación al gimbal en
 * el acto: la deja esperando hasta que el gimbal termine la anterior. En el
 * campo, con el operador moviendo la rueda, un supervisor le sacaba el control,
 * el hub mandaba soltar y retomar la ruta, la ruta apuntaba la cámara a la de
 * patrulla y 300 ms después salía el 0° que esperaba: la patrulla seguía
 * mirando al horizonte y ninguna detección se podía ubicar en el terreno. Qué
 * hace el controlador con el descarte se prueba en FilaDelGimbalTest; acá, que
 * se lo pidan y en qué orden.
 *
 * Usa Robolectric por lo mismo que el resto de las pruebas de PatrolManager: el
 * reparto de cuadros codifica en Base64 (android.util) y el Comando Central
 * espía arma el JSON con org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerCamaraAlSalirDeManualTest {

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
    private val ruta = PatrolRoute(
        1,
        "Manzana",
        listOf(Waypoint(LAT + 0.002, LON, ALT), Waypoint(LAT, LON + 0.002, ALT)),
    )

    @Before
    fun armar() {
        patrulla.start()
    }

    @After
    fun desarmar() {
        alcance.cancel()
    }

    private fun mensaje(json: String) = comandoCentral.manejarMensaje(json)

    private suspend fun esperarEstado(estado: PatrolState) {
        withTimeout(5_000) { patrulla.state.first { it == estado } }
    }

    private suspend fun telemetria(bateria: Double = 100.0) {
        dron.emitirTelemetria(LAT, LON, bateria = bateria, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        delay(60)
    }

    private suspend fun tomarElControl() {
        mensaje("""{"type":"control_taken","by":"op"}""")
        esperarEstado(PatrolState.MANUAL)
    }

    /** El operador mueve la rueda: una inclinación y, enseguida, otra. */
    private fun moverLaRueda() {
        mensaje("""{"type":"manual_gimbal","pitch":-30,"by":"op"}""")
        mensaje("""{"type":"manual_gimbal","pitch":0,"by":"op"}""")
    }

    /**
     * Lo que importa del orden: el descarte sale después de la última
     * inclinación de la consola y antes de [ordenSiguiente], y sale una sola
     * vez desde que se tomó el control.
     */
    private fun assertDescarteEntreLaCamaraY(ordenSiguiente: (String) -> Boolean, desde: Int) {
        val ordenes = dron.ordenes.drop(desde)
        val descartes = ordenes.withIndex().filter { it.value == DronEspia.CANCELAR_CAMARA }
        assertEquals("tenía que tirarse la inclinación una sola vez al salir de MANUAL: $ordenes", 1, descartes.size)
        val descarte = descartes.single().index
        assertTrue(
            "el descarte tiene que salir después de la última inclinación: $ordenes",
            ordenes.indexOfLast { it.startsWith("camara(") } < descarte,
        )
        val siguiente = ordenes.indexOfFirst(ordenSiguiente)
        assertTrue("nunca salió la orden del estado siguiente: $ordenes", siguiente >= 0)
        assertTrue("el descarte tiene que salir antes de la orden del estado siguiente: $ordenes", descarte < siguiente)
    }

    /**
     * El caso del campo: el supervisor le saca el control al operador con la
     * rueda en movimiento y el hub manda, uno atrás del otro, soltar y retomar
     * la ruta. Los dos se atienden en corrutinas aparte y el orden entre ellos
     * no está garantizado; el descarte antes de la ruta, sí.
     */
    @Test
    fun soltarYRetomarLaRutaTiraLaInclinacionAntesDeApuntarLaDePatrulla() = runBlocking {
        telemetria()
        patrulla.startPatrol(ruta)
        esperarEstado(PatrolState.PATROLLING)
        tomarElControl()
        val desde = dron.ordenes.size
        moverLaRueda()

        mensaje("""{"type":"control_released","by":"supervisor"}""")
        mensaje("""{"type":"resume_patrol","orderedBy":"supervisor"}""")
        // Se espera la orden y no el estado: lo que se prueba es el orden de las
        // órdenes, sea cual sea el de los dos mensajes.
        esperarA("la ruta retomada") { dron.ordenes.drop(desde).any { it.startsWith("startRoute") } }

        assertDescarteEntreLaCamaraY({ it.startsWith("startRoute") }, desde)
    }

    /** Soltar sin otra orden: queda estacionario y nadie vuelve a apuntar la cámara, pero igual se tira. */
    @Test
    fun soltarSinObjetivoTiraLaInclinacionAntesDelVueloEstacionario() = runBlocking {
        telemetria()
        tomarElControl()
        val desde = dron.ordenes.size
        moverLaRueda()

        mensaje("""{"type":"control_released","by":"op"}""")
        esperarEstado(PatrolState.PAUSED)
        esperarA("el vuelo estacionario") { dron.ordenes.drop(desde).contains("hold") }

        assertDescarteEntreLaCamaraY({ it == "hold" }, desde)
    }

    /** "Retomar ruta" o "patrullar otra" sin soltar el control también sale de MANUAL. */
    @Test
    fun patrullarOtraRutaSinSoltarElControlTiraLaInclinacionAntesDeLaRuta() = runBlocking {
        patrulla.availableRoutes = listOf(ruta)
        telemetria()
        tomarElControl()
        val desde = dron.ordenes.size
        moverLaRueda()

        mensaje("""{"type":"start_route","routeId":1,"fromIndex":0,"orderedBy":"op"}""")
        esperarEstado(PatrolState.PATROLLING)
        esperarA("la ruta") { dron.ordenes.drop(desde).any { it.startsWith("startRoute") } }

        assertDescarteEntreLaCamaraY({ it.startsWith("startRoute") }, desde)
    }

    /**
     * Con un objetivo en seguimiento, soltar vuelve a orbitarlo: la órbita apunta
     * la cámara y solo la vuelve a apuntar si lo que quiere se corre más de 3°,
     * así que una inclinación vieja que le llegara después le quedaría puesta.
     */
    @Test
    fun alVolverAlObjetivoTiraLaInclinacionAntesDeLaOrbita() = runBlocking {
        telemetria()
        tomarElControl()
        val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), null, 1L)
        deteccion.onDetection?.invoke(persona)
        delay(60)
        deteccion.onDetection?.invoke(persona)
        esperarA("el objetivo en seguimiento") { patrulla.objetivo != null }
        val desde = dron.ordenes.size
        moverLaRueda()

        mensaje("""{"type":"control_released","by":"op"}""")
        esperarEstado(PatrolState.ORBITING)
        esperarA("la órbita") { dron.ordenes.drop(desde).contains("startOrbit") }

        assertDescarteEntreLaCamaraY({ it == "startOrbit" || it == "seguirObjetivo" }, desde)
    }

    /** Batería baja con el control tomado: el regreso a base es del dron, y la cámara deja de ser del operador. */
    @Test
    fun elRegresoPorBateriaTiraLaInclinacionAntesDelRegreso() = runBlocking {
        telemetria()
        tomarElControl()
        val desde = dron.ordenes.size
        moverLaRueda()

        telemetria(bateria = 20.0)
        esperarEstado(PatrolState.RETURNING_HOME_BATTERY)
        esperarA("el regreso a base") { dron.ordenes.drop(desde).contains("returnHome") }

        assertDescarteEntreLaCamaraY({ it == "returnHome" }, desde)
    }

    /** El operador de campo manda aterrizar: le saca el dron a la consola, cámara incluida. */
    @Test
    fun aterrizarDesdeElCampoTiraLaInclinacionAntesDeAterrizar() = runBlocking {
        telemetria()
        tomarElControl()
        val desde = dron.ordenes.size
        moverLaRueda()

        patrulla.aterrizar()

        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertDescarteEntreLaCamaraY({ it == "land" }, desde)
    }

    /**
     * Aterrizar desde la CONSOLA no sale de MANUAL (el control sigue tomado, en
     * el suelo): la cámara sigue siendo del operador y su inclinación no se tira.
     */
    @Test
    fun aterrizarDesdeLaConsolaNoSaleDeManualYNoTiraLaInclinacion() = runBlocking {
        telemetria()
        tomarElControl()
        moverLaRueda()

        mensaje("""{"type":"land","by":"op"}""")
        esperarA("el aterrizaje") { dron.ordenes.contains("land") }
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        dron.flightEvents.emit(FlightEvent.Aterrizado)
        esperarA("LANDED") { comandoCentral.eventos("LANDED").isNotEmpty() }
        mensaje("""{"type":"manual_gimbal","pitch":-15,"by":"op"}""")

        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertTrue("en MANUAL no se tira nada: ${dron.ordenes}", DronEspia.CANCELAR_CAMARA !in dron.ordenes)
        assertEquals("camara(-15.0)", dron.ultimaOrden)
    }

    /**
     * La carrera de verdad: la inclinación llega por el hilo lector del
     * WebSocket justo cuando se suelta el control, que corre en una corrutina.
     * La que pasó la puerta tiene que estar en el controlador ANTES del
     * descarte, o el descarte no la ve y sale igual: el test la para adentro del
     * controlador y mira que soltar no pueda completarse en el medio.
     */
    @Test
    fun unaInclinacionAMitadDeCaminoQuedaAntesDelDescarte() = runBlocking {
        telemetria()
        tomarElControl()
        val desde = dron.ordenes.size
        val inclinacionAdentroDelDron = CountDownLatch(1)
        val dejarSalirLaInclinacion = CountDownLatch(1)
        dron.alRecibirLaOrden = { orden ->
            if (orden == "camara(0.0)") {
                inclinacionAdentroDelDron.countDown()
                dejarSalirLaInclinacion.await(10, TimeUnit.SECONDS)
            }
        }
        val hiloDelWebSocket = thread(name = "camara-de-la-consola") {
            mensaje("""{"type":"manual_gimbal","pitch":0,"by":"op"}""")
        }
        assertTrue("la inclinación nunca llegó al dron", inclinacionAdentroDelDron.await(10, TimeUnit.SECONDS))

        mensaje("""{"type":"control_released","by":"supervisor"}""")
        delay(500) // sin exclusión, para acá la salida de MANUAL ya pasó entera
        assertEquals("salió de MANUAL con una inclinación a mitad de camino", PatrolState.MANUAL, patrulla.state.value)
        assertTrue("se tiró antes de que la inclinación llegara: ${dron.ordenes}", DronEspia.CANCELAR_CAMARA !in dron.ordenes)

        dejarSalirLaInclinacion.countDown()
        hiloDelWebSocket.join()
        dron.alRecibirLaOrden = null
        esperarEstado(PatrolState.PAUSED)
        esperarA("el vuelo estacionario") { dron.ordenes.drop(desde).contains("hold") }

        assertDescarteEntreLaCamaraY({ it == "hold" }, desde)
    }
}
