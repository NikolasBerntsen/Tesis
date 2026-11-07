package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.Navegacion
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
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
 * La velocidad con la que el dron orbita al objetivo: la de fábrica
 * ([Navegacion.VELOCIDAD_ORBITA_MS]) hasta que la consola fije otra desde la
 * vista del dron (`ajustes`, docs/PROTOCOLS.md §2). El espía anota con qué
 * velocidad se le pidió cada órbita.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerOrbitaTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    /** Una persona en el centro del cuadro, con la cámara a 70° hacia abajo. */
    private val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/x", 1L)

    private suspend fun patrullando() {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
    }

    private suspend fun orbitando() {
        patrullando()
        banco.deteccion.onDetection?.invoke(persona)
        delay(80)
        banco.deteccion.onDetection?.invoke(persona)
        esperarA("la órbita") { patrulla.state.value == PatrolState.ORBITING }
    }

    @Test
    fun sinAjustesSeOrbitaALaVelocidadDeFabrica() = runBlocking {
        orbitando()

        assertEquals(Navegacion.VELOCIDAD_ORBITA_MS, dron.ultimaVelocidadDeOrbita, 0.0)
        assertEquals(Navegacion.VELOCIDAD_ORBITA_MS, patrulla.velocidadDeOrbita, 0.0)
    }

    /** La velocidad que fijó la consola vale para la próxima órbita, y queda. */
    @Test
    fun losAjustesCambianLaVelocidadDeLaProximaOrbita() = runBlocking {
        banco.arrancar()
        consola("""{"type":"ajustes","velocidadOrbitaMs":2.5,"by":"op"}""")
        esperarA("el ajuste") { patrulla.velocidadDeOrbita == 2.5 }

        orbitando()

        assertEquals(2.5, dron.ultimaVelocidadDeOrbita, 0.0)
    }

    /** Orbitando, el cambio se aplica en el acto: se vuelve a pedir la órbita con el mismo centro y la velocidad nueva. */
    @Test
    fun orbitandoElAjusteSeAplicaEnElActoSinCorrerElCentro() = runBlocking {
        orbitando()
        val centro = dron.ultimaOrbita
        val i = dron.ordenes.size

        consola("""{"type":"ajustes","velocidadOrbitaMs":6,"by":"op"}""")
        esperarA("la órbita renovada") { dron.ordenes.size > i }

        assertEquals(listOf("startOrbit"), dron.ordenes.drop(i))
        assertEquals(6.0, dron.ultimaVelocidadDeOrbita, 0.0)
        assertEquals(centro, dron.ultimaOrbita)
        assertTrue(patrulla.localLog.replayCache.any { it.contains("Velocidad de órbita: 6,0 m/s") || it.contains("Velocidad de órbita: 6.0 m/s") })
    }

    /** Fuera de órbita (patrullando) el ajuste solo se guarda: no le da ninguna orden al dron. */
    @Test
    fun patrullandoElAjusteSoloSeGuarda() = runBlocking {
        patrullando()
        val i = dron.ordenes.size

        consola("""{"type":"ajustes","velocidadOrbitaMs":3,"by":"op"}""")
        esperarA("el ajuste") { patrulla.velocidadDeOrbita == 3.0 }
        delay(100)

        assertEquals(emptyList<String>(), dron.ordenes.drop(i))
    }

    /** Un valor fuera de rango se recorta; `null` vuelve a la de fábrica. */
    @Test
    fun elAjusteSeRecortaAlRangoYNullVuelveALaDeFabrica() = runBlocking {
        banco.arrancar()
        consola("""{"type":"ajustes","velocidadOrbitaMs":40,"by":"op"}""")
        esperarA("el tope") { patrulla.velocidadDeOrbita == Navegacion.VELOCIDAD_ORBITA_MAXIMA_MS }

        consola("""{"type":"ajustes","velocidadOrbitaMs":0.1,"by":"op"}""")
        esperarA("el piso") { patrulla.velocidadDeOrbita == Navegacion.VELOCIDAD_ORBITA_MINIMA_MS }

        consola("""{"type":"ajustes","velocidadOrbitaMs":null,"by":"op"}""")
        esperarA("la de fábrica") { patrulla.velocidadDeOrbita == Navegacion.VELOCIDAD_ORBITA_MS }
    }
}
