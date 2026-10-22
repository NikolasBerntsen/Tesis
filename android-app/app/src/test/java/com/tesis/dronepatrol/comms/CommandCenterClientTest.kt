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
}
