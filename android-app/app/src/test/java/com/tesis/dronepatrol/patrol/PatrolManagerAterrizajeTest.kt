package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La orden de aterrizar, de la consola o del teléfono, se sostiene hasta el
 * suelo (docs/PROTOCOLS.md §2, `land`). Es el defecto de la prueba de campo:
 * la orden llegaba, la consola decía "aterrizando" y el dron quedaba
 * suspendido, porque lo que vino después —el cero de soltar la palanca, el
 * watchdog del mando, el vuelo estacionario de tomar o soltar el control o de
 * la señal perdida— se lo cancelaba.
 *
 * Lo que se mira es qué le queda ordenado al dron (el espía anota cada orden),
 * que `LANDING` sale recién cuando el dron acepta, que un aterrizaje que no se
 * pudo llega SIEMPRE a la consola, y que solo una orden de vuelo de una persona
 * lo corta, y lo corta antes de darse.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerAterrizajeTest {

    private companion object {
        const val NO_SE_PUDO = "${DroneController.NO_SE_PUDO_ATERRIZAR}: el dron no aceptó la orden en 3 intentos (prueba)"
    }

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun palanca(pitch: Double) =
        consola("""{"type":"manual_stick","pitch":$pitch,"roll":0.0,"yaw":0.0,"throttle":0.0,"by":"op"}""")

    private fun tomarElControl() = consola("""{"type":"control_taken","by":"op"}""")

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun registro(texto: String) = patrulla.localLog.replayCache.any { it.contains(texto) }

    private suspend fun enManual() {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
    }

    /** Aterrizando por orden de la consola, con el control tomado; devuelve desde qué orden mirar. */
    private suspend fun aterrizandoDesdeLaConsola(): Int {
        enManual()
        consola("""{"type":"land","by":"op"}""")
        esperarA("el aterrizaje") { "land" in dron.ordenes }
        esperarA("el LANDING") { banco.comando.eventos("LANDING").isNotEmpty() }
        return dron.ordenes.size
    }

    /** Aterrizando por orden del teléfono (PAUSED, sin control tomado); devuelve desde qué orden mirar. */
    private suspend fun aterrizandoDesdeElCampo(patrullando: Boolean = false): Int {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        if (patrullando) {
            patrulla.startPatrol(RUTA)
            esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
        }
        patrulla.aterrizar()
        esperarA("el LANDING") { banco.comando.eventos("LANDING").isNotEmpty() }
        return dron.ordenes.size
    }

    /** El silencio de la telemetría que el vigía de la señal toma por un enlace cortado. */
    private suspend fun perderLaSenial() {
        banco.relojDeLaSenial.adelantar(PatrolManager.SIGNAL_TIMEOUT_MS + 1_000)
        esperarA("la señal perdida") { patrulla.state.value == PatrolState.RETURNING_HOME_SIGNAL }
        delay(200)
    }

    // ---- LANDING quiere decir que el dron aceptó ----

    @Test
    fun elLandingSaleRecienCuandoElDronAceptaElAterrizaje() = runBlocking {
        dron.respuestaAlAterrizar = null
        enManual()
        consola("""{"type":"land","by":"op"}""")
        esperarA("el aterrizaje") { "land" in dron.ordenes }
        delay(200)
        assertTrue("salió LANDING sin que el dron aceptara", banco.comando.eventos("LANDING").isEmpty())
        assertTrue(registro("Orden de aterrizar entregada al dron: falta que la acepte"))

        banco.evento(FlightEvent.AterrizajeAceptado)
        esperarA("el LANDING") { banco.comando.eventos("LANDING").isNotEmpty() }
        val mensaje = banco.comando.eventos("LANDING").single().getString("message")
        assertTrue(mensaje, mensaje.startsWith("Aterrizaje ordenado por op desde el Comando Central: el dron aceptó"))

        banco.evento(FlightEvent.AterrizajeAceptado)
        assertEquals("una vez por orden", 1, banco.comando.eventos("LANDING").size)
    }

    // ---- Nada de lo automático lo corta ----

    /**
     * El cero de soltar la palanca (que viaja por el socket y puede llegar
     * después del `land`), una palanca a fondo y el watchdog: ninguno le habla
     * al dron. El salto de 25 m tampoco sale; la cámara sí se mueve.
     */
    @Test
    fun elMandoElSaltoYElWatchdogNoLeHablanAlDronMientrasAterriza() = runBlocking {
        enManual()
        palanca(1.0)
        consola("""{"type":"land","by":"op"}""")
        esperarA("el aterrizaje") { "land" in dron.ordenes }
        val i = dron.ordenes.size

        palanca(0.0)
        palanca(1.0)
        consola("""{"type":"manual_move","bearing":0,"distanceM":25,"by":"op"}""")
        consola("""{"type":"manual_gimbal","pitch":-20,"by":"op"}""")
        delay(PatrolManager.MANDO_TIMEOUT_MS + 700)

        assertEquals("solo la cámara: ${desde(i)}", listOf("camara(-20.0)"), desde(i))
        assertTrue(registro("Movimiento manual de op ignorado: el dron está aterrizando"))
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
    }

    @Test
    fun tomarYSoltarElControlNoFrenanUnAterrizajeDelCampo() = runBlocking {
        val i = aterrizandoDesdeElCampo()

        tomarElControl()
        esperarA("el aviso de que sigue bajando") { registro("sigue bajando hasta el suelo") }
        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        consola("""{"type":"control_released","by":"op"}""")
        esperarA("de vuelta en pausa") { patrulla.state.value == PatrolState.PAUSED }
        delay(200)

        assertTrue("le frenaron el aterrizaje: ${desde(i)}", desde(i).none { it == "hold" || it.startsWith("stick(") })
    }

    /**
     * Sin señal no se lo frena, y al volver no se le retoma la ruta que estaba
     * en curso antes de aterrizar: vuelve a la pausa del aterrizaje.
     */
    @Test
    fun perderYRecuperarLaSenialAterrizandoNoLoFrenaNiLeRetomaLaRuta() = runBlocking {
        val i = aterrizandoDesdeElCampo(patrullando = true)

        perderLaSenial()
        assertTrue(banco.comando.eventos("SIGNAL_LOST").isNotEmpty())
        assertTrue("no está volviendo a la base: está aterrizando", banco.comando.eventos("RTH_SIGNAL_LOSS").isEmpty())
        banco.telemetria(norteM = 100.0, alt = 12.0)
        esperarA("la señal de vuelta") { patrulla.state.value == PatrolState.PAUSED }
        delay(200)

        assertEquals("ni freno ni ruta: ${desde(i)}", emptyList<String>(), desde(i))
        assertTrue(registro("Vuelve la señal con el dron aterrizando"))
    }

    @Test
    fun conElControlTomadoLaSenialQueVuelveLoDejaEnManualSinOrdenes() = runBlocking {
        val i = aterrizandoDesdeLaConsola()

        perderLaSenial()
        banco.telemetria(norteM = 100.0, alt = 12.0)
        esperarA("la señal de vuelta") { patrulla.state.value == PatrolState.MANUAL }
        delay(200)

        // Lo único es tirar la inclinación de la consola al salir de MANUAL: ni freno ni mando.
        assertEquals(listOf(DronEspia.CANCELAR_CAMARA), desde(i))
    }

    @Test
    fun laBateriaBajaAterrizandoNoLeCambiaElAterrizajePorUnRegreso() = runBlocking {
        val i = aterrizandoDesdeElCampo()

        banco.telemetria(norteM = 100.0, bateria = 20.0, alt = 15.0)
        delay(200)

        assertEquals(PatrolState.PAUSED, patrulla.state.value)
        assertFalse("le pisaron el aterrizaje con un regreso", "returnHome" in desde(i))
        assertTrue(banco.comando.eventos("RTH_LOW_BATTERY").isEmpty())
    }

    /** Lo que ve el detector mientras baja se avisa sin seguimiento: una órbita le cortaría el aterrizaje. */
    @Test
    fun unaDeteccionAterrizandoAlertaSinSeguir() = runBlocking {
        val i = aterrizandoDesdeElCampo()
        val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/x", 1L)

        banco.deteccion.onDetection?.invoke(persona)
        delay(80)
        banco.deteccion.onDetection?.invoke(persona)
        esperarA("la alerta") { banco.comando.alertas.isNotEmpty() }

        assertFalse("startOrbit" in desde(i))
        val deteccion = banco.comando.eventos("DETECTION").single().getString("message")
        assertTrue(deteccion, deteccion.contains("con el dron aterrizando"))
    }

    // ---- Cuando no se puede, la consola se entera siempre ----

    /**
     * La respuesta definitiva sale aunque el techo por minuto ya esté gastado
     * y aunque sea igual a la anterior, y el mando vuelve a ser del operador.
     */
    @Test
    fun unAterrizajeQueNoSePudoSeAvisaSiempreYDevuelveElMando() = runBlocking {
        enManual()
        repeat(PatrolManager.MAX_PROBLEMAS_POR_VENTANA) { banco.evento(FlightEvent.Problema("rechazo $it")) }
        esperarA("el techo gastado") { banco.comando.eventos("DRONE_PROBLEM").size == PatrolManager.MAX_PROBLEMAS_POR_VENTANA }
        dron.respuestaAlAterrizar = FlightEvent.Problema(NO_SE_PUDO)

        consola("""{"type":"land","by":"op"}""")
        esperarA("el aviso") { banco.comando.eventos("DRONE_PROBLEM").size == PatrolManager.MAX_PROBLEMAS_POR_VENTANA + 1 }
        consola("""{"type":"land","by":"op"}""")
        esperarA("el segundo, igual al primero") {
            banco.comando.eventos("DRONE_PROBLEM").size == PatrolManager.MAX_PROBLEMAS_POR_VENTANA + 2
        }

        val aviso = banco.comando.eventos("DRONE_PROBLEM").last().getString("message")
        assertEquals("No se pudo aterrizar: el dron no aceptó la orden en 3 intentos (prueba)", aviso)
        assertTrue(banco.comando.eventos("LANDING").isEmpty())
        val i = dron.ordenes.size
        palanca(1.0)
        assertEquals("el mando volvió a ser del operador", listOf("stick(1.0, 0.0, 0.0, 0.0)"), desde(i))
    }

    // ---- Lo terminan el suelo, el propio DJI o una persona ----

    @Test
    fun alTocarElSueloElControlVuelveAFrenarComoSiempre() = runBlocking {
        aterrizandoDesdeLaConsola()
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.Aterrizado)
        esperarA("el LANDED") { banco.comando.eventos("LANDED").isNotEmpty() }

        // Lo despegan con las palancas del control: es un vuelo nuevo.
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        val i = dron.ordenes.size
        tomarElControl()
        esperarA("el estacionario de siempre") { "hold" in desde(i) }
        palanca(0.5)
        assertEquals("stick(0.5, 0.0, 0.0, 0.0)", dron.ultimaOrden)
    }

    @Test
    fun suRegresoPorBateriaTerminaElAterrizajeQueSeSostenia() = runBlocking {
        aterrizandoDesdeLaConsola()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        esperarA("el regreso del dron") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }

        val i = dron.ordenes.size
        tomarElControl()
        esperarA("el estacionario de una persona que retoma el dron") { "hold" in desde(i) }
    }

    @Test
    fun irAUnNodoCortaElAterrizajeAntesDeIr() = runBlocking {
        val i = aterrizandoDesdeLaConsola()
        patrulla.availableRoutes = listOf(RUTA)

        consola("""{"type":"force_goto","routeId":1,"index":1,"orderedBy":"op"}""")
        esperarA("el desvío") { "gotoPoint" in desde(i) }

        val ordenes = desde(i)
        assertTrue(ordenes.toString(), ordenes.indexOf("cancelarAterrizaje") in 0 until ordenes.indexOf("gotoPoint"))
        assertTrue(registro("op ordenó ir al nodo 2: se corta el aterrizaje en curso"))
    }

    @Test
    fun detenerseCortaElAterrizajeYQuedaEstacionario() = runBlocking {
        val i = aterrizandoDesdeLaConsola()

        consola("""{"type":"stop_patrol","orderedBy":"op"}""")
        esperarA("el estacionario") { "hold" in desde(i) }

        val ordenes = desde(i)
        assertTrue(ordenes.toString(), ordenes.indexOf("cancelarAterrizaje") in 0 until ordenes.indexOf("hold"))
        assertEquals(PatrolState.PAUSED, patrulla.state.value)
    }

    @Test
    fun reanudarLaRutaCortaElAterrizaje() = runBlocking {
        val i = aterrizandoDesdeElCampo(patrullando = true)

        patrulla.reanudarPatrullaje()
        esperarA("la ruta") { desde(i).any { it.startsWith("startRoute") } }

        val ordenes = desde(i)
        assertTrue(ordenes.toString(), ordenes.indexOf("cancelarAterrizaje") in 0 until ordenes.indexOfFirst { it.startsWith("startRoute") })
    }

    @Test
    fun volverALaBaseDesdeElCampoCortaElAterrizaje() = runBlocking {
        val i = aterrizandoDesdeElCampo()

        patrulla.volverABase()

        val ordenes = desde(i)
        assertTrue(ordenes.toString(), ordenes.indexOf("cancelarAterrizaje") in 0 until ordenes.indexOf("returnHome"))
        assertEquals(PatrolState.RETURNING_HOME, patrulla.state.value)
    }

    /**
     * El dron acepta tarde un aterrizaje que una persona ya cortó con otra
     * orden: no se lo vuelve a sostener (dejaría a la app sin mando con el dron
     * yendo a otro lado), ni sale un LANDING que ya no es cierto.
     */
    @Test
    fun unaAceptacionTardeDeUnAterrizajeYaCortadoNoSeAdopta() = runBlocking {
        dron.respuestaAlAterrizar = null
        enManual()
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"land","by":"op"}""")
        esperarA("el aterrizaje") { "land" in dron.ordenes }
        consola("""{"type":"force_goto","routeId":1,"index":0,"orderedBy":"op"}""")
        esperarA("el desvío") { patrulla.state.value == PatrolState.FORCED }

        banco.evento(FlightEvent.AterrizajeAceptado)
        esperarA("la aceptación ignorada") { registro("aceptó un aterrizaje que ya no está en curso") }
        assertTrue(banco.comando.eventos("LANDING").isEmpty())

        val i = dron.ordenes.size
        tomarElControl()
        esperarA("el estacionario de tomar el control") { "hold" in desde(i) }
    }
}
