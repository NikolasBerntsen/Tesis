package com.tesis.dronepatrol.comms

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El único punto donde un mensaje del Comando Central se convierte en una orden
 * para el dron. Se prueba el mapeo a mano, sin levantar el socket: no hay nada
 * del otro lado y lo que importa es que cada campo del JSON caiga en el
 * argumento que le corresponde. Confundir dos nombres acá manda el dron para el
 * costado cuando el operador pidió adelante, y sin estos casos pasa CI igual.
 *
 * Usa Robolectric porque org.json lo aporta el framework de Android.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CommandCenterClientTest {

    private val alcance = CoroutineScope(SupervisorJob())
    private val cliente = CommandCenterClient(alcance)

    @After
    fun cortar() {
        alcance.cancel()
    }

    /** El mensaje exacto del contrato §2.2, eje por eje y en orden. */
    @Test
    fun elMandoVirtualLlegaConCadaEjeEnSuLugar() {
        var recibido: List<Any>? = null
        cliente.onManualStick = { pitch, roll, yaw, throttle, by ->
            recibido = listOf(pitch, roll, yaw, throttle, by)
        }

        cliente.manejarMensaje(
            """{"type":"manual_stick","pitch":0.6,"roll":0,"yaw":-0.3,"throttle":0,"by":"operador1"}""",
        )

        assertEquals(listOf(0.6, 0.0, -0.3, 0.0, "operador1"), recibido)
    }

    /**
     * Un eje que falta vale cero y no NaN, que es lo que devuelve optDouble sin
     * defecto: un NaN metido en una velocidad es una orden sin sentido para el
     * dron.
     */
    @Test
    fun unEjeAusenteLlegaComoCeroYNoComoNaN() {
        var ejes: List<Double>? = null
        cliente.onManualStick = { pitch, roll, yaw, throttle, _ -> ejes = listOf(pitch, roll, yaw, throttle) }

        cliente.manejarMensaje("""{"type":"manual_stick","pitch":1.0,"by":"operador1"}""")

        assertEquals(listOf(1.0, 0.0, 0.0, 0.0), ejes)
        assertTrue("ningún eje puede llegar en NaN: $ejes", ejes!!.none { it.isNaN() })
    }

    /** Soltar la palanca manda los cuatro ejes en cero, y así tienen que llegar. */
    @Test
    fun alSoltarLaPalancaLleganLosCuatroEjesEnCero() {
        var ejes: List<Double>? = null
        cliente.onManualStick = { pitch, roll, yaw, throttle, _ -> ejes = listOf(pitch, roll, yaw, throttle) }

        cliente.manejarMensaje(
            """{"type":"manual_stick","pitch":0,"roll":0,"yaw":0,"throttle":0,"by":"operador1"}""",
        )

        assertEquals(listOf(0.0, 0.0, 0.0, 0.0), ejes)
    }

    /** Una orden de otro tipo no puede mover el dron por el camino del mando. */
    @Test
    fun otroTipoDeMensajeNoTocaElMando() {
        var mandos = 0
        var tomas = 0
        cliente.onManualStick = { _, _, _, _, _ -> mandos++ }
        cliente.onControlTaken = { tomas++ }

        cliente.manejarMensaje("""{"type":"control_taken","by":"operador1"}""")

        assertEquals("tendría que haber tomado el control", 1, tomas)
        assertEquals("y no haber tocado el mando", 0, mandos)
    }

    /** Un mensaje roto se descarta sin tirar nada: el socket no se puede caer por esto. */
    @Test
    fun unMensajeRotoSeDescartaSinRomperNada() {
        cliente.onManualStick = { _, _, _, _, _ -> fail("no tendría que haberse invocado") }
        cliente.onManualGimbal = { _, _ -> fail("no tendría que haberse invocado") }

        cliente.manejarMensaje("esto no es json")
        cliente.manejarMensaje("")
        cliente.manejarMensaje("""{"sin":"tipo"}""")
    }

    /** El `manual_gimbal` del contrato §2: la inclinación en grados y quién la pidió. */
    @Test
    fun laInclinacionDeLaCamaraLlegaConQuienLaPidio() {
        val recibidas = mutableListOf<Pair<Double, String>>()
        cliente.onManualGimbal = { pitch, by -> recibidas += pitch to by }

        cliente.manejarMensaje("""{"type":"manual_gimbal","pitch":-45.5,"by":"operador1"}""")
        // Un entero del JSON también es un número: el horizonte llega como 0.0
        cliente.manejarMensaje("""{"type":"manual_gimbal","pitch":0,"by":"operador1"}""")
        cliente.manejarMensaje("""{"type":"manual_gimbal","pitch":-90,"by":"supervisor"}""")

        assertEquals(listOf(-45.5 to "operador1", 0.0 to "operador1", -90.0 to "supervisor"), recibidas)
    }

    /**
     * Sin un número no hay inclinación: un pitch ausente NO vale cero (el cero
     * de la cámara es el horizonte, una orden que nadie dio), y un texto no se
     * convierte, igual que en el hub.
     */
    @Test
    fun unaInclinacionQueNoEsNumeroSeDescarta() {
        cliente.onManualGimbal = { pitch, _ -> fail("no tendría que haberse invocado con $pitch") }

        cliente.manejarMensaje("""{"type":"manual_gimbal","by":"operador1"}""")
        cliente.manejarMensaje("""{"type":"manual_gimbal","pitch":null,"by":"operador1"}""")
        cliente.manejarMensaje("""{"type":"manual_gimbal","pitch":"-30","by":"operador1"}""")
        cliente.manejarMensaje("""{"type":"manual_gimbal","pitch":{},"by":"operador1"}""")
        cliente.manejarMensaje("""{"type":"manual_gimbal","pitch":true,"by":"operador1"}""")
    }

    /**
     * org.json no deja entrar un NaN ni un infinito al parsear, así que este
     * control se prueba con el valor suelto: "finito" es parte del contrato, no
     * un detalle de la librería que hoy lo impide.
     */
    @Test
    fun unaInclinacionNoFinitaNoEsUnaInclinacion() {
        for (noFinita in listOf<Any>(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, Float.NaN)) {
            assertNull("$noFinita", cliente.inclinacionPedida(noFinita))
        }
        assertNull(cliente.inclinacionPedida(null))
        assertNull(cliente.inclinacionPedida("-30"))
        assertEquals(-30.0, cliente.inclinacionPedida(-30)!!, 0.0)
        assertEquals(12.5, cliente.inclinacionPedida(12.5f)!!, 0.0)
    }

    /** La cámara y las palancas no se cruzan: el `pitch` de una no es el de la otra. */
    @Test
    fun laCamaraNoTocaElMandoNiElMandoLaCamara() {
        var mandos = 0
        var camaras = 0
        cliente.onManualStick = { _, _, _, _, _ -> mandos++ }
        cliente.onManualGimbal = { _, _ -> camaras++ }

        cliente.manejarMensaje("""{"type":"manual_gimbal","pitch":-30,"by":"operador1"}""")
        assertEquals(listOf(0, 1), listOf(mandos, camaras))

        cliente.manejarMensaje("""{"type":"manual_stick","pitch":0.5,"roll":0,"yaw":0,"throttle":0,"by":"operador1"}""")
        assertEquals(listOf(1, 1), listOf(mandos, camaras))
    }

    /** Sin nadie escuchando (la app todavía no arrancó el patrullaje) no pasa nada. */
    @Test
    fun sinOyenteLaInclinacionSePierdeSinRomperNada() {
        cliente.onManualGimbal = null
        cliente.manejarMensaje("""{"type":"manual_gimbal","pitch":-30,"by":"operador1"}""")
    }

    /** Un mensaje de cada tipo del contrato §2, con el nombre del oyente que le corresponde. */
    private val unaOrdenDeCadaTipo = listOf(
        """{"type":"alert_decision","alertId":4,"decision":"VALIDATED","decidedBy":"ana"}""" to "alert_decision",
        """{"type":"alert_ack","ref":"r-1","alertId":4}""" to "alert_ack",
        """{"type":"takeoff","by":"ana"}""" to "takeoff",
        """{"type":"land","by":"ana"}""" to "land",
        """{"type":"resume_patrol","orderedBy":"ana"}""" to "resume_patrol",
        """{"type":"start_route","routeId":1,"fromIndex":0,"orderedBy":"ana"}""" to "start_route",
        """{"type":"stop_patrol","orderedBy":"ana"}""" to "stop_patrol",
        """{"type":"force_goto","routeId":1,"index":2,"orderedBy":"ana"}""" to "force_goto",
        """{"type":"control_taken","by":"ana"}""" to "control_taken",
        """{"type":"manual_move","bearing":90,"distanceM":25,"by":"ana"}""" to "manual_move",
        """{"type":"manual_stick","pitch":0.5,"roll":0,"yaw":0,"throttle":0,"by":"ana"}""" to "manual_stick",
        """{"type":"manual_gimbal","pitch":-30,"by":"ana"}""" to "manual_gimbal",
        """{"type":"control_released","by":"ana"}""" to "control_released",
        // Los del control que se reparten según un campo (§2): no son los de siempre.
        """{"type":"control_released","by":"Comando Central","motivo":"inactividad"}""" to "control_inactividad",
        """{"type":"control_released","by":"Comando Central","motivo":"app"}""" to "control_released",
        """{"type":"control_released","by":"Comando Central","resync":true}""" to "control_al_reconectar",
        """{"type":"resume_patrol","orderedBy":"ana","alSoltar":true}""" to "resume_al_soltar",
        """{"type":"resume_patrol","orderedBy":"ana","alSoltar":false}""" to "resume_patrol",
        """{"type":"control_taken","by":"ana","resync":true}""" to "control_resync",
        """{"type":"control_taken","by":"ana","resync":false}""" to "control_taken",
        """{"type":"control_transferred","by":"beto","de":"ana"}""" to "control_transferred",
        """{"type":"renamed","displayName":"Beta"}""" to "renamed",
    )

    /** Engancha un oyente en cada orden y devuelve la lista donde cada una anota su nombre. */
    private fun oirTodo(): MutableList<String> {
        val oidas = mutableListOf<String>()
        cliente.onAlertDecision = { _, _, _, _ -> oidas += "alert_decision" }
        cliente.onAlertAck = { _, _ -> oidas += "alert_ack" }
        cliente.onTakeoff = { oidas += "takeoff" }
        cliente.onLand = { oidas += "land" }
        cliente.onResumePatrol = { oidas += "resume_patrol" }
        cliente.onReanudacionAlSoltar = { oidas += "resume_al_soltar" }
        cliente.onStartRoute = { _, _, _ -> oidas += "start_route" }
        cliente.onStopPatrol = { oidas += "stop_patrol" }
        cliente.onForceGoto = { _, _, _ -> oidas += "force_goto" }
        cliente.onControlTaken = { oidas += "control_taken" }
        cliente.onManualMove = { _, _, _ -> oidas += "manual_move" }
        cliente.onManualStick = { _, _, _, _, _ -> oidas += "manual_stick" }
        cliente.onManualGimbal = { _, _ -> oidas += "manual_gimbal" }
        cliente.onControlReleased = { oidas += "control_released" }
        cliente.onControlSoltadoPorInactividad = { oidas += "control_inactividad" }
        cliente.onControlSoltadoAlReconectar = { oidas += "control_al_reconectar" }
        cliente.onControlResync = { oidas += "control_resync" }
        cliente.onControlTransferred = { _, _ -> oidas += "control_transferred" }
        cliente.onRenamed = { oidas += "renamed" }
        return oidas
    }

    /**
     * Cada tipo del contrato llega a su oyente y a ningún otro: una orden que
     * cae en el oyente equivocado (un `land` tomado por `takeoff`) mueve el dron
     * sin que nada se queje.
     */
    @Test
    fun cadaOrdenCaeEnSuOyenteYEnNingunOtro() {
        val oidas = oirTodo()

        for ((mensaje, oyente) in unaOrdenDeCadaTipo) {
            oidas.clear()
            cliente.manejarMensaje(mensaje)
            assertEquals(mensaje, listOf(oyente), oidas)
        }
    }

    /**
     * Lo que el hub manda a las consolas (§3) o un tipo que la app no conoce
     * no es una orden para el dron.
     */
    @Test
    fun unTipoQueNoEsUnaOrdenNoLlegaANingunOyente() {
        val oidas = oirTodo()

        cliente.manejarMensaje("""{"type":"status","state":"IDLE"}""")
        cliente.manejarMensaje("""{"type":"drone_online","drone":{}}""")
        cliente.manejarMensaje("""{"type":"TAKEOFF","by":"ana"}""")
        cliente.manejarMensaje("""["takeoff"]""")

        assertEquals(emptyList<String>(), oidas)
    }

    /**
     * Una orden que llega antes de que haya quién la atienda (la app todavía
     * no armó el patrullaje) se pierde: no queda encolada para ejecutarse
     * cuando aparezca el oyente, que sería un despegue fuera de tiempo.
     */
    @Test
    fun sinOyentesLasOrdenesSePierdenYNoQuedanPendientes() {
        for ((mensaje, _) in unaOrdenDeCadaTipo) cliente.manejarMensaje(mensaje)

        val oidas = oirTodo()
        assertEquals("nada quedó pendiente", emptyList<String>(), oidas)

        cliente.manejarMensaje("""{"type":"land","by":"ana"}""")
        assertEquals(listOf("land"), oidas)
    }

    /** `resume_patrol` con `fromIndex` va a ese nodo; sin él (ausente o null), desde el último alcanzado. */
    @Test
    fun reanudarSinIndiceEsDesdeElUltimoNodo() {
        val desde = mutableListOf<Int?>()
        cliente.onResumePatrol = { desde += it }

        cliente.manejarMensaje("""{"type":"resume_patrol","orderedBy":"ana","fromIndex":2}""")
        cliente.manejarMensaje("""{"type":"resume_patrol","orderedBy":"ana"}""")
        cliente.manejarMensaje("""{"type":"resume_patrol","orderedBy":"ana","fromIndex":null}""")
        // El nodo 0 es un nodo, no "sin índice"
        cliente.manejarMensaje("""{"type":"resume_patrol","orderedBy":"ana","fromIndex":0}""")

        assertEquals(listOf(2, null, null, 0), desde)
    }

    /** El que acompaña a un soltar (`alSoltar`) lee el nodo igual que la orden de reanudar. */
    @Test
    fun laReanudacionDeUnSoltarLlegaConSuNodo() {
        val desde = mutableListOf<Int?>()
        cliente.onReanudacionAlSoltar = { desde += it }

        cliente.manejarMensaje("""{"type":"resume_patrol","orderedBy":"ana","alSoltar":true,"fromIndex":1}""")
        cliente.manejarMensaje("""{"type":"resume_patrol","orderedBy":"ana","alSoltar":true}""")

        assertEquals(listOf(1, null), desde)
    }

    /**
     * `start_route` lee `fromIndex` y `force_goto` lee `index`: los dos llevan
     * ruta y nodo, y cruzar los nombres manda el dron a otro lado.
     */
    @Test
    fun comenzarRutaYDesvioLeenCadaUnoSuIndice() {
        var ruta: List<Any>? = null
        var desvio: List<Any>? = null
        cliente.onStartRoute = { routeId, fromIndex, por -> ruta = listOf(routeId, fromIndex, por) }
        cliente.onForceGoto = { routeId, index, por -> desvio = listOf(routeId, index, por) }

        cliente.manejarMensaje("""{"type":"start_route","routeId":3,"fromIndex":1,"index":9,"orderedBy":"ana"}""")
        cliente.manejarMensaje("""{"type":"force_goto","routeId":5,"index":2,"fromIndex":9,"orderedBy":"supervisor"}""")

        assertEquals(listOf(3, 1, "ana"), ruta)
        assertEquals(listOf(5, 2, "supervisor"), desvio)
    }

    /** Las órdenes que solo dicen quién las dio llegan con ese nombre, de su campo. */
    @Test
    fun cadaOrdenLlegaConQuienLaDio() {
        val oidas = mutableListOf<String>()
        cliente.onStopPatrol = { oidas += "stop:$it" }
        cliente.onControlTaken = { oidas += "taken:$it" }
        cliente.onControlReleased = { oidas += "released:$it" }
        cliente.onRenamed = { oidas += "renamed:$it" }

        cliente.manejarMensaje("""{"type":"stop_patrol","orderedBy":"ana","by":"otro"}""")
        cliente.manejarMensaje("""{"type":"control_taken","by":"beto"}""")
        cliente.manejarMensaje("""{"type":"control_released","by":"carla"}""")
        cliente.manejarMensaje("""{"type":"renamed","displayName":"Alfa 2"}""")

        assertEquals(listOf("stop:ana", "taken:beto", "released:carla", "renamed:Alfa 2"), oidas)
    }

    /** Los del control dicen quién lo tiene y, el traspaso, de quién venía (§2). */
    @Test
    fun losDelControlLleganConQuienLoTieneYDeQuienVenia() {
        val oidas = mutableListOf<String>()
        cliente.onControlSoltadoPorInactividad = { oidas += "inactividad:$it" }
        cliente.onControlSoltadoAlReconectar = { oidas += "al_reconectar:$it" }
        cliente.onControlResync = { oidas += "resync:$it" }
        cliente.onControlTransferred = { by, de -> oidas += "traspaso:$de->$by" }

        cliente.manejarMensaje("""{"type":"control_released","by":"Comando Central","motivo":"inactividad"}""")
        cliente.manejarMensaje("""{"type":"control_released","by":"Comando Central","resync":true}""")
        cliente.manejarMensaje("""{"type":"control_taken","by":"ana","resync":true}""")
        cliente.manejarMensaje("""{"type":"control_transferred","by":"beto","de":"ana"}""")

        assertEquals(
            listOf("inactividad:Comando Central", "al_reconectar:Comando Central", "resync:ana", "traspaso:ana->beto"),
            oidas,
        )
    }

    /** `manual_move`: el rumbo absoluto y la distancia en metros, cada uno en su lugar (§2). */
    @Test
    fun elDesplazamientoPuntualLlegaConRumboYDistancia() {
        var recibido: List<Any>? = null
        cliente.onManualMove = { rumbo, metros, por -> recibido = listOf(rumbo, metros, por) }

        cliente.manejarMensaje("""{"type":"manual_move","bearing":270,"distanceM":25.5,"by":"ana"}""")

        assertEquals(listOf(270.0, 25.5, "ana"), recibido)
    }

    /** Un `alertId` en null es lo mismo que ausente: la decisión no trae id. */
    @Test
    fun unaDecisionConAlertIdNullNoTraeId() {
        var recibido: List<Any?>? = null
        cliente.onAlertDecision = { id, decision, por, reenvio -> recibido = listOf(id, decision, por, reenvio) }

        cliente.manejarMensaje("""{"type":"alert_decision","alertId":null,"decision":"DISMISSED","decidedBy":"ana"}""")

        assertEquals(listOf(null, "DISMISSED", "ana", false), recibido)
    }
}
