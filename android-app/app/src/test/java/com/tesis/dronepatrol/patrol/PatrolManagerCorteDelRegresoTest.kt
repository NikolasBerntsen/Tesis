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
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Las órdenes de una persona que cortan el regreso de la app (docs/VUELO.md
 * §4, la fila «Regreso por orden o batería»): tomar el control, aterrizar,
 * otra ruta, un desvío a un nodo y «Comenzar» del teléfono le cortan el
 * GoHome ANTES de su orden, porque con él puesto el DJI no acepta otra. Si el
 * dron avisa que no lo cortó (`NO_SE_CORTO_EL_REGRESO`), sigue volviendo: la
 * orden quedó descartada, la app vuelve al regreso que había y, si era una
 * toma, la deshace (`control_dropped`). Antes la consola quedaba en MANUAL
 * con las palancas mudas y el dron yéndose a su casa. Con una toma del propio
 * DJI que no se discute, la ruta y el desvío no se cumplen y se dice por qué.
 *
 * El dron es el espía: lo que se mira es qué le queda ordenado y en qué orden.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerCorteDelRegresoTest {

    private companion object {
        const val NO_SE_CORTO = "${DroneController.NO_SE_CORTO_EL_REGRESO}: el dron no volvió a IDLE en 3 s (prueba)"
        const val RUTA_POR_ANA = """{"type":"start_route","routeId":1,"fromIndex":1,"orderedBy":"ana"}"""
        const val NODO_POR_ANA = """{"type":"force_goto","routeId":1,"index":2,"orderedBy":"ana"}"""
    }

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun tomarElControl(by: String = "op") = consola("""{"type":"control_taken","by":"$by"}""")

    private fun soltarElControl(by: String = "op") = consola("""{"type":"control_released","by":"$by"}""")

    private fun palanca(pitch: Double) =
        consola("""{"type":"manual_stick","pitch":$pitch,"roll":0.0,"yaw":0.0,"throttle":0.0,"by":"op"}""")

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun eventos(tipo: String) = banco.comando.eventos(tipo)

    private fun problemas(): List<String> = eventos("DRONE_PROBLEM").map { it.getString("message") }

    private fun noSeCortaron(): Int = problemas().count { it.contains(DroneController.NO_SE_CORTO_EL_REGRESO) }

    private fun soltados(): List<JSONObject> = banco.mensajes("control_dropped")

    private fun registro(texto: String) = patrulla.localLog.replayCache.any { it.contains(texto) }

    private val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/x", 1L)

    private suspend fun detectar() {
        banco.deteccion.onDetection?.invoke(persona)
        delay(80)
    }

    private suspend fun patrullando() {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
    }

    private suspend fun volviendoPorOrden() {
        patrullando()
        patrulla.volverABase()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
    }

    private suspend fun volviendoPorBateria() {
        patrullando()
        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
    }

    private suspend fun noSeCorto() {
        val antes = noSeCortaron()
        banco.evento(FlightEvent.Problema(NO_SE_CORTO))
        esperarA("el aviso del corte que no salió") { noSeCortaron() == antes + 1 }
    }

    // ---- La toma que no cortó el regreso se deshace ----

    @Test
    fun siLaTomaNoCortaElRegresoSeDeshaceConSuAvisoYElDronSigueVolviendo() = runBlocking {
        volviendoPorOrden()
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        val i = dron.ordenes.size

        noSeCorto()
        esperarA("el regreso otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME }
        palanca(1.0)
        delay(200)

        val aviso = soltados().single()
        assertEquals("op", aviso.getString("by"))
        assertEquals("no se tomó el control: el dron no aceptó cortar el regreso: sigue volviendo", aviso.getString("motivo"))
        assertTrue(problemas().toString(), "No se toma el control manual que pidió op: el dron no aceptó cortar el regreso: sigue volviendo" in problemas())
        // Salir de MANUAL tira la inclinación de la consola, y nada más: ni estacionario ni la palanca.
        assertEquals(listOf(DronEspia.CANCELAR_CAMARA), desde(i))
        assertTrue(registro("La orden que cortaba el regreso queda descartada: el dron sigue volviendo (RETURNING_HOME)"))

        // La app ya no tiene el control: si el hub pregunta, se lo dice.
        consola("""{"type":"control_taken","by":"op","resync":true}""")
        esperarA("el segundo aviso") { soltados().size == 2 }
    }

    @Test
    fun conElRegresoPorBateriaVuelveAlRegresoPorBateriaSinPedirloOtraVez() = runBlocking {
        volviendoPorBateria()
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        val i = dron.ordenes.size

        noSeCorto()
        esperarA("el regreso por batería otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        banco.telemetria(norteM = 100.0, bateria = 19.0)
        delay(100)

        assertEquals("el dron ya vuelve: ni otro returnHome", listOf(DronEspia.CANCELAR_CAMARA), desde(i))
        assertEquals(1, soltados().size)
        assertEquals(PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)
    }

    /** Si el control ya se soltó cuando llega el aviso, no hay lock que soltar: solo vuelve al regreso. */
    @Test
    fun conElControlYaSueltoSoloVuelveAlRegreso() = runBlocking {
        volviendoPorOrden()
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        soltarElControl()
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }

        noSeCorto()
        esperarA("el regreso otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME }
        assertTrue("no tenía el control: nada que soltar", soltados().isEmpty())
    }

    // ---- El aterrizaje que no cortó el regreso se olvida ----

    @Test
    fun siElAterrizajeNoCortaElRegresoSeOlvidaYElDronSigueVolviendo() = runBlocking {
        volviendoPorOrden()
        // La respuesta del dron a land() llega a mano: tarde, después del aviso del corte.
        dron.respuestaAlAterrizar = null
        consola("""{"type":"land","by":"op"}""")
        esperarA("el aterrizaje ordenado") { "land" in dron.ordenes }
        assertEquals(listOf("cancelarRegreso", "land"), dron.ordenes.takeLast(2))
        assertEquals(PatrolState.PAUSED, patrulla.state.value)

        noSeCorto()
        esperarA("el regreso otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME }
        banco.evento(FlightEvent.AterrizajeAceptado)
        esperarA("el aviso tardío ignorado") { registro("El dron aceptó un aterrizaje que ya no está en curso") }
        assertTrue("ese aterrizaje no salió", eventos("LANDING").isEmpty())

        // Llega como cualquier regreso.
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.ArrivedHome)
        esperarA("el reposo") { patrulla.state.value == PatrolState.IDLE }
    }

    /** Con el control tomado desde antes del regreso, el aterrizaje que no cortó no se lo saca: sigue tomado. */
    @Test
    fun conElControlTomadoElAterrizajeQueNoCortoNoSueltaElControl() = runBlocking {
        patrullando()
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        // La batería que baja por primera vez con el control tomado lo manda a casa igual.
        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        consola("""{"type":"land","by":"op"}""")
        esperarA("el aterrizaje ordenado") { "land" in dron.ordenes }
        assertEquals(PatrolState.PAUSED, patrulla.state.value)

        noSeCorto()
        esperarA("el regreso por batería otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        assertTrue(soltados().isEmpty())
        consola("""{"type":"control_taken","by":"op","resync":true}""")
        esperarA("la confirmación") { registro("El Comando Central confirma que op sigue con el control manual") }
    }

    // ---- Otra ruta, un desvío y «Comenzar» cortan el regreso antes ----

    @Test
    fun otraRutaCortaElRegresoAntesYSiNoSeCortaVuelveAlRegreso() = runBlocking {
        volviendoPorOrden()
        val i = dron.ordenes.size

        consola(RUTA_POR_ANA)
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        assertEquals(listOf("cancelarRegreso", "startRoute(1, 1)"), desde(i))

        noSeCorto()
        esperarA("el regreso otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME }
        assertEquals("ni una orden más: el regreso es del dron", listOf("cancelarRegreso", "startRoute(1, 1)"), desde(i))
    }

    @Test
    fun unDesvioAUnNodoCortaElRegresoPorBateriaAntes() = runBlocking {
        volviendoPorBateria()
        val i = dron.ordenes.size

        consola(NODO_POR_ANA)
        esperarA("el desvío") { patrulla.state.value == PatrolState.FORCED }
        assertEquals(listOf("cancelarRegreso", "gotoPoint"), desde(i))

        noSeCorto()
        esperarA("el regreso por batería otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
    }

    /** El aviso puede llegar con el dron ya de vuelta en su regreso (la batería lo mandó): queda ahí, sin otra orden. */
    @Test
    fun siElAvisoLlegaConElDronYaDeVueltaEnElRegresoQuedaAhi() = runBlocking {
        volviendoPorBateria()
        consola(RUTA_POR_ANA)
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        banco.telemetria(norteM = 100.0, bateria = 19.0)
        esperarA("el regreso por batería otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        val i = dron.ordenes.size

        noSeCorto()
        delay(100)
        assertEquals(PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
    }

    @Test
    fun comenzarDesdeElTelefonoDuranteElRegresoTambienLoCorta() = runBlocking {
        volviendoPorOrden()
        val i = dron.ordenes.size

        patrulla.startPatrol(RUTA)
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }

        assertEquals(listOf("cancelarRegreso", "startRoute(1, 0)"), desde(i))
    }

    // ---- Con una toma del DJI que no se discute, no se cumplen ----

    @Test
    fun conElRegresoDelBotonDelControlNiLaRutaNiElDesvioNiComenzarSeCumplen() = runBlocking {
        patrullando()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_DEL_CONTROL))
        esperarA("el regreso del control físico") { patrulla.state.value == PatrolState.RETURNING_HOME }
        val i = dron.ordenes.size
        val motivo = "alguien pidió el regreso a base desde el control físico, y el que está al lado del dron manda"

        consola(RUTA_POR_ANA)
        val ruta = "No se cumple la orden (ana ordenó patrullar la ruta \"Perímetro norte\"): $motivo"
        esperarA("el rechazo de la ruta") { ruta in problemas() }
        consola(NODO_POR_ANA)
        val nodo = "No se cumple la orden (ana ordenó ir al nodo 3): $motivo"
        esperarA("el rechazo del desvío") { nodo in problemas() }
        patrulla.startPatrol(RUTA)
        val comenzar = "No se cumple la orden (el operador de campo ordenó patrullar la ruta \"Perímetro norte\"): $motivo"
        esperarA("el rechazo de «Comenzar»") { comenzar in problemas() }

        assertEquals(PatrolState.RETURNING_HOME, patrulla.state.value)
        assertEquals("ni corte ni orden: ${desde(i)}", emptyList<String>(), desde(i))
    }

    /** Su regreso por batería se corta una sola vez por vuelo (RELEVOS §4): la ruta lo gasta, y la siguiente ya no sale. */
    @Test
    fun conSuRegresoPorBateriaLaRutaUsaElUnicoCorteYLaSiguienteNoSeCumple() = runBlocking {
        patrullando()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        esperarA("el regreso del DJI") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        val i = dron.ordenes.size

        consola(RUTA_POR_ANA)
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        assertEquals(listOf("cancelarRegreso", "startRoute(1, 1)"), desde(i))

        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        esperarA("el regreso del DJI otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        val j = dron.ordenes.size
        consola(RUTA_POR_ANA)
        esperarA("el rechazo") { problemas().any { it.startsWith("No se cumple la orden (ana ordenó patrullar") && it.contains("ya se gastó") } }
        assertEquals(emptyList<String>(), desde(j))
    }

    // ---- El aviso del corte que no salió va siempre ----

    @Test
    fun elCorteQueNoSalioSeAvisaSiempreAunqueElTechoEsteGastado() = runBlocking {
        volviendoPorOrden()
        repeat(PatrolManager.MAX_PROBLEMAS_POR_VENTANA) { banco.evento(FlightEvent.Problema("rechazo $it")) }
        esperarA("el techo gastado") { problemas().size == PatrolManager.MAX_PROBLEMAS_POR_VENTANA }

        noSeCorto()
        // El mismo motivo, otra vez: tampoco lo frena el filtro de repetidos.
        noSeCorto()

        assertEquals("El dron rechazó una orden: $NO_SE_CORTO", problemas().last())
    }

    /** Con el vuelo en manos del DJI una detección no arranca un seguimiento (le rechazaría la órbita): solo alerta. */
    @Test
    fun conElVueloEnManosDelDjiUnaDeteccionAlertaSinSeguimiento() = runBlocking {
        patrullando()
        // Un corte que no salió, sin una orden de una persona que deshacer: el vuelo queda del DJI.
        noSeCorto()
        val i = dron.ordenes.size

        detectar()
        detectar()
        esperarA("la alerta") { banco.comando.alertas.isNotEmpty() }

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals("ni órbita ni seguimiento: ${desde(i)}", emptyList<String>(), desde(i))
        assertTrue(eventos("DETECTION").single().getString("message").contains("con el vuelo en manos del propio dron"))
    }
}
