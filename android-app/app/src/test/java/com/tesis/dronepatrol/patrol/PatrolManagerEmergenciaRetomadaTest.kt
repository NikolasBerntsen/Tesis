package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.CompletableDeferred
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
 * El §5 que una persona cortó en sus fotos (docs/VUELO.md §4: tomar el
 * control, aterrizar u otra orden de vuelo cortan las fotos) queda abierto
 * con el dron en otro estado. Si la batería —o el propio DJI— lo vuelve a
 * pedir, es la MISMA emergencia: con su `ref`, vuelve a ATERRIZAJE_EMERGENCIA
 * y sigue con las fotos que faltaban. Antes no se volvía a armar nunca: la
 * app lo daba por resuelto y el dron se quedaba en la pausa con la batería en
 * el piso, o volviendo a una casa que no alcanzaba.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerEmergenciaRetomadaTest {

    private companion object {
        const val NO_ARRANCO = "${DroneController.NO_SE_PUDO_VOLVER}: el regreso no salió de IDLE en 3 intentos (prueba)"
    }

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun tomarElControl() = consola("""{"type":"control_taken","by":"op"}""")

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun retomadas(): List<String> =
        banco.comando.eventos("LANDING").map { it.getString("message") }.filter { it.contains("se retoma el aterrizaje de emergencia") }

    private suspend fun telemetria(bateria: Double) =
        banco.telemetria(norteM = 1_500.0, bateria = bateria, pctParaVolver = 20.0, pctParaAterrizar = 2.0)

    private suspend fun enLaEmergencia(confirma: Boolean = true) {
        dron.estado.value = dron.estado.value.copy(umbralCriticoPct = 10.0)
        dron.confirmarCamaraYRumbo = confirma
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        telemetria(bateria = 60.0)
        patrulla.startPatrol(RUTA)
        esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
        telemetria(bateria = 12.0)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
    }

    /** En las fotos (la cámara no confirma: se queda en la cenital), una persona toma el control. */
    private suspend fun cortadaAlTomarElControl() {
        enLaEmergencia(confirma = false)
        esperarA("la cenital, que no se confirma") { "apuntar(-90.0)" in dron.ordenes }
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        // De acá en más la cámara confirma: la secuencia retomada no espera de más.
        dron.confirmarCamaraYRumbo = true
    }

    /** Cortada en las fotos y mandada a volver desde la consola: el GoHome de la app, con la emergencia abierta. */
    private suspend fun cortadaYVolviendo() {
        cortadaAlTomarElControl()
        consola("""{"type":"return_home","by":"op"}""")
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME && dron.ultimaOrden == "returnHome" }
    }

    @Test
    fun alSoltarElControlLaBateriaLaVuelveAArmarYSigueConLasFotosQueFaltaban() = runBlocking {
        val frenada = CompletableDeferred<Unit>()
        // La tercera foto (la primera de la panorámica) queda frenada: salieron la oblicua y la cenital.
        dron.alCapturar = { n -> if (n == 3) frenada.await() }
        enLaEmergencia()
        esperarA("la tercera foto, frenada") { dron.ordenes.count { it == "capturarFoto" } == 3 }
        val ref = banco.ultimo("emergency_landing").getString("ref")
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        frenada.complete(Unit)

        // Mientras la persona lo tenga, la batería no se lo saca.
        telemetria(bateria = 11.5)
        delay(200)
        assertEquals(PatrolState.MANUAL, patrulla.state.value)

        consola("""{"type":"control_released","by":"op"}""")
        esperarA("la pausa, estacionario") { patrulla.state.value == PatrolState.PAUSED && dron.ultimaOrden == "hold" }
        val i = dron.ordenes.size
        telemetria(bateria = 11.0)
        esperarA("la emergencia retomada") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        esperarA("el aterrizaje al final", topeMs = 10_000) { "land" in desde(i) }

        val despues = desde(i)
        assertEquals(listOf("hold", "failsafeAterrizar(true)"), despues.take(2))
        assertFalse("la oblicua y la cenital ya salieron: $despues", "apuntar(-70.0)" in despues || "apuntar(-90.0)" in despues)
        assertEquals("las cuatro de la panorámica: $despues", 4, despues.count { it == "capturarFoto" })
        assertEquals("land", despues.last())
        assertEquals("la misma emergencia", setOf(ref), banco.mensajes("emergency_landing").map { it.getString("ref") }.toSet())
        val retomada = retomadas().single()
        assertTrue(retomada, retomada.startsWith("La batería ya no alcanza para ninguna base: se retoma el aterrizaje de emergencia en "))
        assertTrue(retomada, retomada.endsWith(", con las fotos que faltaban"))
        assertEquals("el hub se entera de que vuelve a bajar acá", 2, banco.mensajes("rth_diverted").size)
    }

    /** Cortada y mandada a volver, la batería la vuelve a armar en el regreso: corta el GoHome antes de quedar quieto. */
    @Test
    fun volviendoConLaEmergenciaCortadaLaBateriaLaVuelveAArmar() = runBlocking {
        cortadaYVolviendo()
        val i = dron.ordenes.size

        telemetria(bateria = 11.0)
        esperarA("la emergencia retomada") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        esperarA("el aterrizaje al final", topeMs = 10_000) { "land" in desde(i) }

        assertEquals(listOf("cancelarRegreso", "hold", "failsafeAterrizar(true)"), desde(i).take(3))
        // La oblicua salió antes del corte (la telemetría ya la confirmaba); la cenital no.
        assertFalse("la oblicua no se repite: ${desde(i)}", "apuntar(-70.0)" in desde(i))
        assertEquals("las cinco que faltaban: ${desde(i)}", 5, desde(i).count { it == "capturarFoto" })
        assertEquals(1, retomadas().size)
    }

    /** Su GoHome que no arranca con la emergencia cortada es uno más: estacionario en la pausa, como siempre. */
    @Test
    fun conLaEmergenciaCortadaUnRegresoQueNoArrancaDejaAlDronQuieto() = runBlocking {
        cortadaYVolviendo()
        val i = dron.ordenes.size

        banco.evento(FlightEvent.Problema(NO_ARRANCO))
        esperarA("la pausa, estacionario") { patrulla.state.value == PatrolState.PAUSED && desde(i).isNotEmpty() }

        assertEquals(listOf("hold"), desde(i))
    }

    /** El propio DJI fuerza el aterrizaje con la emergencia cortada: la misma, retomada solo con la cámara. */
    @Test
    fun siElDjiFuerzaElAterrizajeConLaEmergenciaCortadaSeRetomaSoloConLaCamara() = runBlocking {
        cortadaAlTomarElControl()
        val i = dron.ordenes.size

        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA))
        esperarA("la emergencia retomada") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        esperarA("las dos de la cámara") { desde(i).count { it == "capturarFoto" } == 2 }
        delay(200)

        assertFalse("ni una orden de vuelo: el DJI está bajando: ${desde(i)}", desde(i).any { it == "hold" || it == "land" || it.startsWith("girar") })
        // Salir de MANUAL tira la inclinación de la consola; después, solo la cámara.
        assertEquals(listOf(DronEspia.CANCELAR_CAMARA, "apuntar(-90.0)", "capturarFoto", "apuntar(-30.0)", "capturarFoto"), desde(i))
        val retomada = retomadas().single()
        assertTrue(retomada, retomada.startsWith("El propio dron fuerza el aterrizaje por batería crítica: se retoma el aterrizaje de emergencia en "))
    }
}
