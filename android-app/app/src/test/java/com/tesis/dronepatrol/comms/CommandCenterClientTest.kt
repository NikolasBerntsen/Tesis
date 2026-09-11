package com.tesis.dronepatrol.comms

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
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

        cliente.manejarMensaje("esto no es json")
        cliente.manejarMensaje("")
        cliente.manejarMensaje("""{"sin":"tipo"}""")
    }
}
