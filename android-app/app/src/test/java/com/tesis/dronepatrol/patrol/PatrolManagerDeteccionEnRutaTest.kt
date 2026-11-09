package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Lo que una detección le hace —y lo que NO le hace— a la ruta que el dron está
 * volando (docs/PROTOCOLS.md §4). La regla: la ruta sigue intacta salvo que el
 * protocolo pida otra cosa, y lo único que lo pide es una detección CONFIRMADA
 * (dos de la misma clase, seguidas y cerca), que pasa a la órbita. Una sola, una
 * de otra clase que la candidata, una parcial sin cajas que no se puede ubicar o
 * una dentro de una zona descartada no le dan al dron ni una orden: ni un
 * estacionario, ni un desvío, ni un cambio de cámara. En el campo el dron se
 * desviaba de la ruta "solo"; esto es lo que lo fija.
 *
 * El dron es el espía, que anota cada orden: después de la ruta no puede
 * aparecer ninguna otra. El reloj del seguimiento es falso y queda quieto, así
 * que lo que decide es la clase y la posición de cada detección, no el tiempo.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerDeteccionEnRutaTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun deteccion(clase: String, x: Double = 0.5, confianza: Double = 0.9, conCajas: Boolean = true) = Deteccion(
        listOf(clase), confianza,
        if (conCajas) listOf(Caja(clase, confianza, x, 0.5, 0.02, 0.05)) else emptyList(),
        "/9j/x", 1L,
    )

    private suspend fun detectar(d: Deteccion) {
        banco.deteccion.onDetection?.invoke(d)
        delay(80)
    }

    /** Patrullando, con una posición conocida; devuelve desde qué orden mirar. */
    private suspend fun patrullando(): Int {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
        return dron.ordenes.size
    }

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    @Test
    fun unaSolaDeteccionNoLeDaNingunaOrdenAlDron() = runBlocking {
        val i = patrullando()

        detectar(deteccion("PERSON"))
        delay(300)

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals("la ruta tiene que seguir intacta: ${desde(i)}", emptyList<String>(), desde(i))
        assertTrue(banco.comando.alertas.isEmpty())
        // Las cajas sí se dibujan: es lo único que una detección sin confirmar deja.
        assertEquals(1, patrulla.cajasRecientes.value.size)
    }

    /** La confirmación es de la misma clase: persona y después vehículo no confirman nada. */
    @Test
    fun dosDeteccionesDeDistintaClaseNoConfirman() = runBlocking {
        val i = patrullando()

        detectar(deteccion("PERSON"))
        detectar(deteccion("VEHICLE"))
        detectar(deteccion("PERSON"))
        delay(300)

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
        assertTrue(banco.comando.alertas.isEmpty())
    }

    /** Dos detecciones de la misma clase pero lejos una de otra (más de 25 m) tampoco. */
    @Test
    fun dosDeteccionesLejosUnaDeOtraNoConfirman() = runBlocking {
        val i = patrullando()

        // Con la cámara a 70° hacia abajo y 40 m de altura, el borde izquierdo
        // del cuadro y el derecho caen a decenas de metros uno del otro.
        detectar(deteccion("PERSON", x = 0.02))
        detectar(deteccion("PERSON", x = 0.98))
        delay(300)

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
        assertTrue(banco.comando.alertas.isEmpty())
    }

    /** La detección parcial del detector de respaldo (sin cajas) tampoco corta la ruta por sí sola. */
    @Test
    fun unaDeteccionSinCajasSinConfirmarNoCortaLaRuta() = runBlocking {
        val i = patrullando()

        detectar(deteccion("VEHICLE", conCajas = false))
        delay(300)

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
    }

    /** Lo que el protocolo sí pide: la segunda detección confirma, y la ruta pasa a la órbita con una sola orden. */
    @Test
    fun laDeteccionConfirmadaPasaALaOrbitaYNadaMas() = runBlocking {
        val i = patrullando()

        detectar(deteccion("PERSON"))
        detectar(deteccion("PERSON"))
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }

        assertEquals(listOf("startOrbit"), desde(i))
        assertEquals(1, banco.comando.alertas.size)
    }

    /** Un nodo alcanzado en el medio no borra la candidata ni la convierte en alerta. */
    @Test
    fun pasarUnNodoEntreDosDeteccionesNoCambiaNada() = runBlocking {
        val i = patrullando()

        detectar(deteccion("PERSON"))
        banco.evento(FlightEvent.WaypointReached(0))
        delay(100)

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
        assertTrue(banco.comando.alertas.isEmpty())
    }

    /** Después de un descarte, lo que se ve durante el silencio al retomar (15 s de fábrica) no corta la ruta retomada. */
    @Test
    fun trasUnDescarteLasDeteccionesNoVuelvenACortarLaRutaEnseguida() = runBlocking {
        patrullando()
        detectar(deteccion("PERSON"))
        detectar(deteccion("PERSON"))
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
        consola("""{"type":"alert_decision","alertId":1,"decision":"DISMISSED","decidedBy":"op"}""")
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }
        val i = dron.ordenes.size

        detectar(deteccion("PERSON"))
        detectar(deteccion("PERSON"))
        delay(300)

        assertEquals(PatrolState.PATROLLING, patrulla.state.value)
        assertEquals(emptyList<String>(), desde(i))
        assertEquals("una sola alerta, la descartada", 1, banco.comando.alertas.size)
    }
}
