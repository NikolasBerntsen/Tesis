package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Las órdenes que llegan del Comando Central, sobre todo en los estados en los
 * que NO corresponden: interrumpir sin un patrullaje en vuelo, retomar sin ruta
 * o volviendo a base, una ruta o un nodo que no existen, despegar un dron que ya
 * vuela o que no tiene enlace, aterrizar sin el control tomado. Cada una de esas
 * es un botón que alguien aprieta en la consola en el peor momento, y lo que se
 * verifica es qué le queda ordenado al dron —que es lo que sale caro— y qué se
 * entera la consola.
 *
 * El dron es el espía que anota cada orden; las órdenes del Comando Central
 * entran como entrarían por el socket ([CommandCenterClient.manejarMensaje]).
 * Usa Robolectric porque el reparto de cuadros de PatrolManager codifica en
 * Base64 (android.util) y el Comando Central espía arma el JSON con org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerOrdenesDeLaConsolaTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val ALT = 45.0
        const val DETENER = """{"type":"stop_patrol","orderedBy":"op"}"""
        const val REANUDAR = """{"type":"resume_patrol","orderedBy":"op"}"""
        const val DESPEGAR = """{"type":"takeoff","by":"op"}"""
        const val ATERRIZAR = """{"type":"land","by":"op"}"""
        const val SALTO_AL_NORTE = """{"type":"manual_move","bearing":0,"distanceM":25,"by":"op"}"""
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private val comandoCentral = ComandoCentralEspia(alcance)
    private val deteccion = DetectionClient(alcance)
    private val patrulla = PatrolManager(dron, comandoCentral, deteccion, alcance, "TEST")
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

    private suspend fun esperarElRegistro(texto: String) {
        withTimeout(5_000) { patrulla.localLog.first { it.contains(texto) } }
    }

    private suspend fun telemetria(bateria: Double = 100.0) {
        dron.emitirTelemetria(LAT, LON, bateria = bateria, alt = ALT, rumbo = 90.0, gimbal = -70.0)
        delay(60)
    }

    private suspend fun patrullando() {
        patrulla.start()
        telemetria()
        patrulla.startPatrol(ruta)
        esperarEstado(PatrolState.PATROLLING)
    }

    private suspend fun tomarElControl() {
        mensaje("""{"type":"control_taken","by":"op"}""")
        esperarEstado(PatrolState.MANUAL)
    }

    private fun mensajeDe(tipo: String): String = comandoCentral.eventos(tipo).last().getString("message")

    // ---- Interrumpir y retomar ----

    /**
     * "Detener" desde la consola: el dron queda en vuelo estacionario y, al
     * retomar, sigue hacia el nodo que tenía por delante, no hacia el que ya
     * había pasado (eso era dar la vuelta y repetir el tramo entero).
     */
    @Test
    fun detenerLoDejaEstacionarioYReanudarSigueHaciaElNodoQueTeniaPorDelante() = runBlocking {
        patrullando()
        dron.flightEvents.emit(FlightEvent.WaypointReached(0))
        delay(100)

        mensaje(DETENER)
        esperarEstado(PatrolState.PAUSED)
        esperarA("el aviso de la interrupción") { comandoCentral.eventos("PATROL_STOPPED").isNotEmpty() }
        assertEquals("hold", dron.ultimaOrden)
        assertTrue(mensajeDe("PATROL_STOPPED"), mensajeDe("PATROL_STOPPED").contains("por op"))

        mensaje(REANUDAR)
        esperarEstado(PatrolState.PATROLLING)
        esperarA("la ruta retomada hacia el segundo nodo") { dron.ultimaOrden == "startRoute(1, 1)" }
    }

    /**
     * Sin un patrullaje en vuelo no hay nada que interrumpir, y un dron ya
     * detenido no se vuelve a detener: ni otro vuelo estacionario que pise lo
     * que tenga, ni otra fila en el registro.
     */
    @Test
    fun detenerSinUnPatrullajeEnVueloOYaDetenidoNoHaceNada() = runBlocking {
        patrulla.start()
        telemetria()
        mensaje(DETENER)
        delay(300)
        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertTrue("se le ordenó algo a un dron sin patrullaje: ${dron.ordenes}", dron.ordenes.isEmpty())
        assertTrue(comandoCentral.eventos("PATROL_STOPPED").isEmpty())

        patrulla.startPatrol(ruta)
        mensaje(DETENER)
        esperarA("la interrupción") { comandoCentral.eventos("PATROL_STOPPED").size == 1 }
        mensaje(DETENER)
        delay(300)
        assertEquals(1, comandoCentral.eventos("PATROL_STOPPED").size)
        assertEquals(1, dron.ordenes.count { it == "hold" })
    }

    /**
     * Detener mientras orbita una detección termina el seguimiento —queda en el
     * registro con quién lo pidió— y no le pisa al retorno el nodo que la ruta
     * tenía por delante cuando apareció el objetivo.
     */
    @Test
    fun detenerOrbitandoTerminaElSeguimientoYGuardaElNodoDeLaRuta() = runBlocking {
        patrullando()
        dron.flightEvents.emit(FlightEvent.WaypointReached(0))
        delay(100)
        val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/x", 1L)
        deteccion.onDetection?.invoke(persona)
        delay(80)
        deteccion.onDetection?.invoke(persona)
        esperarEstado(PatrolState.ORBITING)

        mensaje(DETENER)
        esperarEstado(PatrolState.PAUSED)
        esperarA("el fin del seguimiento") { comandoCentral.eventos("TRACKING_ENDED").isNotEmpty() }
        assertTrue(mensajeDe("TRACKING_ENDED"), mensajeDe("TRACKING_ENDED").contains("orden de op"))
        assertNull(patrulla.objetivo)

        mensaje(REANUDAR)
        esperarA("la ruta retomada hacia el segundo nodo") { dron.ultimaOrden == "startRoute(1, 1)" }
    }

    /**
     * La consola puede pedir retomar desde un nodo puntual. Un índice fuera de
     * la ruta (la ruta se editó, la consola quedó vieja) se recorta al nodo que
     * existe más cerca en vez de reventar el patrullaje.
     */
    @Test
    fun reanudarDesdeUnNodoPedidoVaAEseNodoYSoloAUnoQueExista() = runBlocking {
        patrullando()
        for ((pedido, esperado) in listOf(2 to 2, 99 to 2, -3 to 0)) {
            mensaje(DETENER)
            esperarEstado(PatrolState.PAUSED)
            mensaje("""{"type":"resume_patrol","fromIndex":$pedido,"orderedBy":"op"}""")
            esperarEstado(PatrolState.PATROLLING)
            esperarA("la ruta desde el nodo $esperado (pedido: $pedido)") { dron.ultimaOrden == "startRoute(1, $esperado)" }
        }
        esperarA("los tres avisos de la reanudación") { comandoCentral.eventos("PATROL_RESUMED").size == 3 }
        assertTrue(mensajeDe("PATROL_RESUMED"), mensajeDe("PATROL_RESUMED").contains("hacia el nodo 1"))
    }

    /**
     * Retomar sin una ruta cargada no tiene a dónde ir, y volviendo a base no
     * se retoma: el regreso que pidió el operador de campo manda.
     */
    @Test
    fun reanudarSinRutaOVolviendoABaseNoHaceNada() = runBlocking {
        patrulla.start()
        telemetria()
        assertFalse(patrulla.tieneRuta)
        mensaje(REANUDAR)
        delay(300)
        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertTrue(dron.ordenes.none { it.startsWith("startRoute") })

        patrulla.startPatrol(ruta)
        assertTrue(patrulla.tieneRuta)
        patrulla.volverABase()
        esperarEstado(PatrolState.RETURNING_HOME)
        mensaje(REANUDAR)
        delay(300)
        assertEquals(PatrolState.RETURNING_HOME, patrulla.state.value)
        assertEquals("returnHome", dron.ultimaOrden)
        assertEquals(1, dron.ordenes.count { it.startsWith("startRoute") })
    }

    // ---- Rutas y nodos ----

    /**
     * Una ruta creada en la consola después de que la app bajó la lista: la app
     * no la tiene, se la vuelve a pedir al Comando Central y la vuela. El nodo
     * pedido fuera de la ruta queda en el último.
     */
    @Test
    fun unaRutaQueLaAppNoTieneSeLaPideAlComandoCentralYSeVuela() = runBlocking {
        patrulla.start()
        telemetria()
        comandoCentral.rutasDelServidor = listOf(ruta)

        mensaje("""{"type":"start_route","routeId":1,"fromIndex":7,"orderedBy":"op"}""")
        esperarEstado(PatrolState.PATROLLING)
        esperarA("la ruta desde su último nodo") { dron.ultimaOrden == "startRoute(1, 2)" }
        assertEquals(listOf(ruta), patrulla.availableRoutes)
        esperarA("PATROL_STARTED") { comandoCentral.eventos("PATROL_STARTED").isNotEmpty() }
        assertTrue(mensajeDe("PATROL_STARTED"), mensajeDe("PATROL_STARTED").contains("desde el nodo 3 (orden de op)"))
    }

    /** Ni una ruta ni un nodo que no existen (tampoco en el Comando Central) mueven al dron. */
    @Test
    fun unaRutaOUnNodoQueNoExistenSeIgnoran() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.availableRoutes = listOf(ruta)

        mensaje("""{"type":"start_route","routeId":42,"fromIndex":0,"orderedBy":"op"}""")
        esperarElRegistro("patrullar la ruta 42 pero no existe")
        mensaje("""{"type":"force_goto","routeId":42,"index":0,"orderedBy":"op"}""")
        esperarElRegistro("nodo 1 de la ruta 42 pero no existe")
        mensaje("""{"type":"force_goto","routeId":1,"index":9,"orderedBy":"op"}""")
        esperarElRegistro("nodo 10 de la ruta 1 pero no existe")

        assertEquals(PatrolState.IDLE, patrulla.state.value)
        assertTrue("se movió al dron por algo que no existe: ${dron.ordenes}", dron.ordenes.isEmpty())
        assertEquals("la lista de rutas no se pisa con una consulta fallida", listOf(ruta), patrulla.availableRoutes)
    }

    /** El desvío forzado avisa cuando llega, con el número de nodo que ve el operador (desde 1). */
    @Test
    fun elDesvioForzadoAvisaCuandoLlegaAlNodo() = runBlocking {
        patrulla.start()
        telemetria()
        patrulla.availableRoutes = listOf(ruta)

        mensaje("""{"type":"force_goto","routeId":1,"index":1,"orderedBy":"op"}""")
        esperarEstado(PatrolState.FORCED)
        esperarA("FORCED_GOTO") { comandoCentral.eventos("FORCED_GOTO").isNotEmpty() }
        assertEquals("gotoPoint", dron.ultimaOrden)
        assertTrue(mensajeDe("FORCED_GOTO"), mensajeDe("FORCED_GOTO").contains("nodo 2 (orden de op)"))

        dron.flightEvents.emit(FlightEvent.GotoArrived)
        esperarA("GOTO_ARRIVED") { comandoCentral.eventos("GOTO_ARRIVED").isNotEmpty() }
        assertTrue(mensajeDe("GOTO_ARRIVED"), mensajeDe("GOTO_ARRIVED").contains("llegó al nodo 2"))
    }

    // ---- Despegar y aterrizar desde la consola ----

    /**
     * Despegar un dron que ya vuela no hace nada (y no es un problema que
     * avisar); uno sin enlace, sí: el que apretó "Despegar" está en la consola y
     * tiene que saber por qué no pasa nada, con el detalle del controlador si lo
     * hay y uno genérico si no.
     */
    @Test
    fun laConsolaNoDespegaUnDronQueYaVuelaNiUnoSinEnlace() = runBlocking {
        patrulla.start()
        telemetria()
        tomarElControl()

        mensaje(DESPEGAR)
        esperarElRegistro("pidió despegar pero el dron ya está en el aire")
        assertTrue(comandoCentral.eventos("DRONE_PROBLEM").isEmpty())

        dron.estado.value = dron.estado.value.copy(enVuelo = false, conectado = false, detalle = "")
        mensaje(DESPEGAR)
        esperarA("el aviso genérico") { comandoCentral.eventos("DRONE_PROBLEM").size == 1 }
        assertTrue(mensajeDe("DRONE_PROBLEM"), mensajeDe("DRONE_PROBLEM").contains("sin enlace con la aeronave"))

        dron.estado.value = dron.estado.value.copy(detalle = "el control está apagado")
        mensaje(DESPEGAR)
        esperarA("el aviso con el detalle") { comandoCentral.eventos("DRONE_PROBLEM").size == 2 }
        assertTrue(mensajeDe("DRONE_PROBLEM"), mensajeDe("DRONE_PROBLEM").contains("el control está apagado"))
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /**
     * La prueba de mandos en interior: sin GPS el despegue en el lugar desde la
     * consola sale igual, y el registro dice con qué se sostiene el dron. Vale
     * sin telemetría todavía y con telemetría sin posición.
     */
    @Test
    fun laConsolaDespegaSinGpsYElRegistroLoDice() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        patrulla.start()
        tomarElControl()

        mensaje(DESPEGAR)
        esperarA("el primer despegue") { comandoCentral.eventos("TAKEOFF").size == 1 }
        assertTrue(mensajeDe("TAKEOFF"), mensajeDe("TAKEOFF").contains("desde el Comando Central"))
        assertTrue(mensajeDe("TAKEOFF"), mensajeDe("TAKEOFF").contains("sin GPS"))

        dron.emitirTelemetria(Double.NaN, Double.NaN, alt = 0.0)
        delay(100)
        mensaje(DESPEGAR)
        esperarA("el segundo despegue") { comandoCentral.eventos("TAKEOFF").size == 2 }
        assertTrue(mensajeDe("TAKEOFF"), mensajeDe("TAKEOFF").contains("sin GPS"))
        assertEquals(2, dron.ordenes.count { it == "despegarEnElLugar" })
    }

    /**
     * El control sigue tomado pero el dron vuelve solo por batería baja: ni
     * "Despegar" ni "Aterrizar" de la consola le pisan el regreso, y el rechazo
     * del despegue dice en qué estado está.
     */
    @Test
    fun volviendoPorBateriaConElControlTomadoLaConsolaNoDespegaNiAterriza() = runBlocking {
        patrulla.start()
        telemetria()
        tomarElControl()
        telemetria(bateria = 20.0)
        esperarEstado(PatrolState.RETURNING_HOME_BATTERY)
        esperarA("el regreso a base") { dron.ordenes.contains("returnHome") }

        mensaje(DESPEGAR)
        esperarA("el rechazo del despegue") {
            comandoCentral.eventos("DRONE_PROBLEM").any { it.getString("message").contains("estado RETURNING_HOME_BATTERY") }
        }
        mensaje(ATERRIZAR)
        esperarElRegistro("pidió aterrizar sin el control manual tomado")

        assertEquals("returnHome", dron.ultimaOrden)
        assertFalse(dron.ordenes.contains("land"))
        assertFalse(dron.ordenes.contains("despegarEnElLugar"))
    }

    /** Aterrizar es del titular del control y de un dron que vuela: lo demás se ignora. */
    @Test
    fun laConsolaNoAterrizaSinElControlNiUnDronQueYaEstaEnElSuelo() = runBlocking {
        patrulla.start()
        telemetria()
        mensaje(ATERRIZAR)
        esperarElRegistro("pidió aterrizar sin el control manual tomado")

        tomarElControl()
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        mensaje(ATERRIZAR)
        esperarElRegistro("pidió aterrizar pero el dron ya está en el suelo")

        assertFalse(dron.ordenes.contains("land"))
        assertTrue(comandoCentral.eventos("LANDING").isEmpty())
    }

    // ---- Control manual ----

    /**
     * Que la consola vuelva a mandar "control tomado" con el control ya tomado
     * (otro operador que lo toma, el hub que lo repite) no es salir de MANUAL:
     * el dron queda quieto para el nuevo titular, pero la inclinación de la
     * cámara que ya tenía no se tira.
     */
    @Test
    fun volverATomarElControlYaTomadoNoSueltaLaCamara() = runBlocking {
        patrulla.start()
        telemetria()
        tomarElControl()
        mensaje("""{"type":"manual_gimbal","pitch":-30,"by":"op"}""")
        val desde = dron.ordenes.size

        mensaje("""{"type":"control_taken","by":"op2"}""")
        esperarElRegistro("op2 tomó el control manual")

        assertEquals(listOf("hold"), dron.ordenes.drop(desde))
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        mensaje("""{"type":"manual_gimbal","pitch":-10,"by":"op2"}""")
        assertEquals("camara(-10.0)", dron.ultimaOrden)
    }

    /**
     * El salto de 25 m del pad se mide desde la posición del dron: sin
     * telemetría o sin GPS no hay desde dónde, y sin el control tomado no es de
     * la consola. En ninguno de los tres casos el dron se mueve.
     */
    @Test
    fun elSaltoDe25mPideLaPosicionDelDronYElControlTomado() = runBlocking {
        patrulla.start()
        tomarElControl()
        mensaje(SALTO_AL_NORTE)
        delay(300)
        assertFalse("saltó sin saber dónde está", dron.ordenes.contains("gotoPoint"))

        dron.emitirTelemetria(Double.NaN, Double.NaN, alt = ALT)
        delay(100)
        mensaje(SALTO_AL_NORTE)
        esperarElRegistro("no tiene posición GPS")
        assertFalse("saltó sin GPS", dron.ordenes.contains("gotoPoint"))

        mensaje("""{"type":"control_released","by":"op"}""")
        esperarEstado(PatrolState.PAUSED)
        telemetria()
        mensaje(SALTO_AL_NORTE)
        delay(300)
        assertFalse("saltó sin el control tomado", dron.ordenes.contains("gotoPoint"))
    }

    // ---- Arranque ----

    /**
     * Arrancar dos veces (la pantalla de operación que se recrea) no duplica a
     * los que escuchan al dron: cada aviso de vuelo queda UNA vez en el
     * registro del Comando Central.
     */
    @Test
    fun arrancarDosVecesNoDuplicaLosAvisos() = runBlocking {
        patrulla.start()
        patrulla.start()
        withTimeout(5_000) { dron.flightEvents.subscriptionCount.first { it > 0 } }
        delay(200)

        dron.flightEvents.emit(FlightEvent.Despegando)
        esperarA("el despegue") { comandoCentral.eventos("TAKEOFF").isNotEmpty() }
        delay(300)

        assertEquals(1, comandoCentral.eventos("TAKEOFF").size)
        assertEquals(1, dron.flightEvents.subscriptionCount.value)
    }
}
