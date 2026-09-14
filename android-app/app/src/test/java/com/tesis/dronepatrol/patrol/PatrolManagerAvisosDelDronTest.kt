package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.CommandCenterClient
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.model.FlightEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Cómo se reportan los rechazos del dron. Un rechazo mudo es lo peor que puede
 * pasar en vuelo —el operador mueve la palanca, el dron no se mueve y no hay una
 * sola pista de por qué—, pero el aviso tampoco puede inundar el Comando Central:
 * el controlador reintenta la habilitación del mando virtual en CADA vuelta de su
 * lazo de comandos, que corre a 10 Hz, así que el mismo rechazo llegaba diez veces
 * por segundo y cada uno era una fila en la tabla `events` más un broadcast a cada
 * consola abierta, indefinidamente y por un solo dron. El contrato lo prohíbe con
 * nombre y apellido.
 *
 * Usa Robolectric porque el reparto de cuadros de PatrolManager codifica en
 * Base64, que es de android.util.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerAvisosDelDronTest {

    private companion object {
        const val RECHAZO = "el dron no aceptó el mando virtual (sin punto de home)"
        const val OTRO_RECHAZO = "la aeronave le sacó la autoridad de vuelo a la app"
    }

    private val alcance = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dron = DronEspia()
    private lateinit var patrulla: PatrolManager

    @Before
    fun armar() {
        patrulla = PatrolManager(dron, CommandCenterClient(alcance), DetectionClient(alcance), alcance, "TEST")
        patrulla.start()
    }

    @After
    fun desarmar() {
        alcance.cancel()
    }

    /**
     * Treinta rechazos iguales son tres segundos del lazo a 10 Hz: tienen que
     * quedar en UN aviso. El motivo distinto que va al final es el que deja ver
     * que los treinta ya se procesaron —el colector es uno y en orden— y, de
     * paso, que un problema NUEVO sí se avisa.
     */
    @Test
    fun elMismoRechazoSeAvisaUnaVezYNoTreinta() = runBlocking {
        repeat(30) { dron.flightEvents.emit(FlightEvent.Problema(RECHAZO)) }
        dron.flightEvents.emit(FlightEvent.Problema(OTRO_RECHAZO))
        withTimeout(5_000) { patrulla.localLog.first { it.contains(OTRO_RECHAZO) } }

        assertEquals(
            "el mismo rechazo inundó el registro: ${avisos(RECHAZO)}",
            1,
            avisos(RECHAZO).size,
        )
        assertEquals("un rechazo distinto sí tiene que avisarse", 1, avisos(OTRO_RECHAZO).size)
    }

    /**
     * El borde exacto, que adentro del colector es intestable: el reloj lo lee él
     * mismo. Un problema que sigue ahí no puede quedar mudo para siempre, pero
     * tampoco puede volver antes del minuto.
     */
    @Test
    fun elMismoMotivoVuelveAAvisarseReciénPasadoElMinuto() {
        val avisado = 10_000L

        assertFalse(
            "el mismo motivo no puede volver antes del minuto",
            PatrolManager.hayQueAvisarElProblema(
                RECHAZO,
                RECHAZO,
                avisado + PatrolManager.REPETIR_PROBLEMA_MS - 1,
                avisado,
                1,
            ),
        )
        assertTrue(
            "cumplido el minuto vuelve a avisarse",
            PatrolManager.hayQueAvisarElProblema(
                RECHAZO,
                RECHAZO,
                avisado + PatrolManager.REPETIR_PROBLEMA_MS,
                avisado,
                1,
            ),
        )
        assertTrue(
            "un motivo distinto avisa enseguida, sin esperar nada",
            PatrolManager.hayQueAvisarElProblema(OTRO_RECHAZO, RECHAZO, avisado + 1, avisado, 1),
        )
        assertTrue(
            "y el primero de todos también",
            PatrolManager.hayQueAvisarElProblema(RECHAZO, null, 0, 0, 0),
        )
        assertFalse(
            "gastado el presupuesto de la ventana, un motivo nuevo espera",
            PatrolManager.hayQueAvisarElProblema(
                OTRO_RECHAZO,
                RECHAZO,
                avisado + 1,
                avisado,
                PatrolManager.MAX_PROBLEMAS_POR_VENTANA,
            ),
        )
    }

    /**
     * Deduplicar solo por igualdad de motivo deja abierta la misma inundación que
     * el filtro vino a cerrar. El motivo lleva adentro la descripción del error
     * que devuelve el SDK, y esa no es una sola: si la aeronave alterna entre dos
     * rechazos, ninguno es igual al anterior y los dos pasan, diez veces por
     * segundo, que es una fila por mensaje en la tabla `events` del Comando
     * Central más un broadcast a cada consola abierta.
     */
    @Test
    fun dosMotivosAlternadosNoAtraviesanElFiltro() {
        val arranque = 10_000L
        var ultimoMotivo: String? = null
        var ultimoAviso = 0L
        var enLaVentana = 0
        var avisos = 0
        // Diez segundos de rechazos alternados a 10 Hz: cien intentos
        for (i in 0 until 100) {
            val ahora = arranque + i * 100L
            val motivo = if (i % 2 == 0) RECHAZO else OTRO_RECHAZO
            if (PatrolManager.hayQueAvisarElProblema(motivo, ultimoMotivo, ahora, ultimoAviso, enLaVentana)) {
                avisos++
                val ventanaNueva = (ahora - ultimoAviso) !in 0 until PatrolManager.REPETIR_PROBLEMA_MS
                enLaVentana = if (ventanaNueva) 1 else enLaVentana + 1
                ultimoMotivo = motivo
                ultimoAviso = ahora
            }
        }
        // El presupuesto de la ventana es el techo, y el primero entra por el
        // silencio previo: no más de uno y el presupuesto.
        assertEquals(
            "cien intentos alternados generaron $avisos avisos",
            PatrolManager.MAX_PROBLEMAS_POR_VENTANA,
            avisos,
        )
    }

    /**
     * El reloj del celular acomodándose hacia atrás (NTP, cambio de hora) no puede
     * dejar los avisos mudos hasta que recupere la diferencia.
     */
    @Test
    fun elRelojParaAtrasNoDejaLosAvisosMudos() {
        assertTrue(
            PatrolManager.hayQueAvisarElProblema(RECHAZO, RECHAZO, ahoraMs = 5_000, ultimoAvisoMs = 1_000_000, avisosEnLaVentana = 3),
        )
    }

    private fun avisos(motivo: String) = patrulla.localLog.replayCache.filter { it.contains(motivo) }
}
