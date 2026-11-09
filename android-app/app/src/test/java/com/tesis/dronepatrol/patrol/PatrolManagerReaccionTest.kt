package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.Georreferencia
import com.tesis.dronepatrol.drone.RastreadorDeObjetivo
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.ReaccionADeteccion
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.objetivo
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.punto
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayTarget
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.relayTracking
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La reacción a una detección confirmada (docs/VUELO.md §5, la tabla): qué le
 * ordena la app al dron al confirmar, cuando el objetivo se mueve, cuando se
 * detiene y cuando se lo pierde de vista, con cada una de las cuatro
 * reacciones; que los avisos `TARGET_*` salen en todas; que un cambio del
 * ajuste con un objetivo en curso se aplica en la evaluación siguiente; y que
 * al soltar el control manual, o al tomar el objetivo de un relevo, el dron
 * vuelve a él con la reacción vigente.
 *
 * El dron es el espía que anota cada orden: lo que se mira es que `orbitar`
 * nunca pida seguir y conserve el centro, que `seguir` nunca orbite, y que
 * `detenerse` solo vigile, sin una sola orden que lo mueva del lugar. El
 * objetivo se mueve corriendo la telemetría con la detección en el centro del
 * cuadro, como en PatrolManagerSeguimientoTest; el reloj del seguimiento es el
 * falso del banco.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerReaccionTest {

    private companion object {
        /** Las órdenes que mueven al dron de donde está: ninguna puede salir vigilando. */
        val TRASLADAN = setOf("startOrbit", "seguirObjetivo", "gotoPoint", "volarHacia", "startRoute")
    }

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    /** Una persona en el centro del cuadro, con la cámara a 70° hacia abajo. */
    private val persona = Deteccion(listOf("PERSON"), 0.9, listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.02, 0.05)), "/9j/x", 1L)

    /** Dónde cae esa persona en el terreno con el dron en [norteM]/[esteM] de la base, a 40 m, con la nariz al norte. */
    private fun objetivoEnElTerreno(norteM: Double, esteM: Double = 0.0): Pair<Double, Double> {
        val (lat, lon) = punto(norteM, esteM)
        val o = requireNotNull(Georreferencia.proyectar(lat, lon, 40.0, 0.0, -70.0, 0.5, 0.5))
        return o.lat to o.lon
    }

    private suspend fun detectar() {
        banco.deteccion.onDetection?.invoke(persona)
        delay(80)
    }

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun eventos(tipo: String) = banco.comando.eventos(tipo)

    private fun mensajeDe(tipo: String): String = eventos(tipo).last().getString("message")

    private suspend fun conLaReaccion(r: ReaccionADeteccion) {
        consola("""{"type":"ajustes","reaccionADeteccion":"${r.enElProtocolo}","by":"op"}""")
        esperarA("la reacción ${r.enElProtocolo}") { patrulla.reaccionADeteccion == r }
    }

    private suspend fun patrullando() {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
    }

    /** Confirma una persona y devuelve desde qué orden mirar (la primera de la reacción). */
    private suspend fun confirmada(): Int {
        val i = dron.ordenes.size
        val alertas = banco.comando.alertas.size
        detectar()
        detectar()
        esperarA("el seguimiento") { patrulla.state.value in PatrolManager.ESTADOS_DE_SEGUIMIENTO }
        esperarA("la alerta") { banco.comando.alertas.size == alertas + 1 }
        return i
    }

    private var este = 0.0

    /** El dron (y con él la persona, siempre en el centro del cuadro) se corre 8 m al este por detección: 16 m/s. */
    private suspend fun moverElObjetivo(pasos: Int = 6) {
        repeat(pasos) {
            este += 8.0
            banco.telemetria(norteM = 100.0, esteM = este)
            banco.reloj.adelantar(500)
            detectar()
        }
        esperarA("el objetivo en movimiento") { patrulla.objetivo?.enMovimiento == true }
    }

    /** El objetivo queda quieto: se lo sigue viendo en el mismo lugar hasta que el rastreador lo da por detenido. */
    private suspend fun detenerElObjetivo() {
        var vueltas = 0
        while (patrulla.objetivo?.enMovimiento == true && vueltas < 60) {
            banco.telemetria(norteM = 100.0, esteM = este)
            banco.reloj.adelantar(500)
            detectar()
            vueltas++
        }
        assertEquals(false, patrulla.objetivo?.enMovimiento)
    }

    private suspend fun perderElObjetivo() {
        banco.reloj.adelantar(RastreadorDeObjetivo.SIN_VER_PARA_PERDIDO_MS + 1_000)
        esperarA("TARGET_LOST") { eventos("TARGET_LOST").isNotEmpty() }
    }

    // ---- seguir_y_orbitar: lo de siempre ----

    @Test
    fun deFabricaOrbitaSigueAlQueSeMueveYVuelveAOrbitarAlQueSeDetiene() = runBlocking {
        patrullando()
        assertEquals(ReaccionADeteccion.SEGUIR_Y_ORBITAR, patrulla.reaccionADeteccion)
        val i = confirmada()

        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertEquals(listOf("startOrbit"), desde(i))
        assertTrue(mensajeDe("ORBIT_STARTED"), mensajeDe("ORBIT_STARTED").endsWith("el dron pasa a modo órbita sobre el objetivo"))

        moverElObjetivo()
        esperarA("seguirlo") { patrulla.state.value == PatrolState.FOLLOWING }
        esperarA("TARGET_MOVING") { eventos("TARGET_MOVING").isNotEmpty() }
        assertTrue(mensajeDe("TARGET_MOVING"), mensajeDe("TARGET_MOVING").endsWith("el dron deja la órbita y lo sigue"))

        detenerElObjetivo()
        esperarA("volver a orbitarlo") { patrulla.state.value == PatrolState.ORBITING }
        esperarA("TARGET_STOPPED") { eventos("TARGET_STOPPED").isNotEmpty() }
        assertEquals("El objetivo se detuvo: el dron vuelve a orbitarlo donde quedó", mensajeDe("TARGET_STOPPED"))

        perderElObjetivo()
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertTrue(mensajeDe("TARGET_LOST"), mensajeDe("TARGET_LOST").contains("el dron orbita su última posición conocida"))
    }

    // ---- orbitar: el lugar de la detección, con el centro fijo ----

    @Test
    fun orbitarOrbitaElLugarDeLaDeteccionYNuncaLoSigue() = runBlocking {
        patrullando()
        conLaReaccion(ReaccionADeteccion.ORBITAR)
        val i = confirmada()

        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertEquals(listOf("startOrbit"), desde(i))
        val centro = requireNotNull(dron.ultimaOrbita)
        val (oLat, oLon) = objetivoEnElTerreno(100.0)
        assertEquals("el centro es donde se lo detectó", 0.0, Geo.distanciaM(oLat, oLon, centro.first, centro.second), 1.0)
        assertTrue(mensajeDe("ORBIT_STARTED"), mensajeDe("ORBIT_STARTED").endsWith("el dron pasa a orbitar el lugar de la detección, sin seguirlo"))

        // El objetivo se va 48 m al este: el dron sigue orbitando donde estaba, y se avisa igual.
        moverElObjetivo()
        esperarA("TARGET_MOVING") { eventos("TARGET_MOVING").isNotEmpty() }
        delay(700)
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertEquals("el centro no se corre", centro, dron.ultimaOrbita)
        assertEquals("una sola órbita, la del principio: ${desde(i)}", listOf("startOrbit"), desde(i))
        assertTrue(mensajeDe("TARGET_MOVING"), mensajeDe("TARGET_MOVING").contains("sigue orbitando el lugar de la detección"))
        assertTrue("la estimación sí acompaña al objetivo", requireNotNull(patrulla.objetivo).lon > oLon)

        detenerElObjetivo()
        esperarA("TARGET_STOPPED") { eventos("TARGET_STOPPED").isNotEmpty() }
        assertEquals("El objetivo se detuvo: el dron sigue orbitando el lugar de la detección", mensajeDe("TARGET_STOPPED"))
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertEquals("el centro sigue fijo", centro, dron.ultimaOrbita)

        perderElObjetivo()
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        assertEquals(listOf("startOrbit"), desde(i))
        assertTrue(mensajeDe("TARGET_LOST"), mensajeDe("TARGET_LOST").contains("sigue orbitando el lugar de la detección"))

        detectar()
        esperarA("TARGET_REACQUIRED") { eventos("TARGET_REACQUIRED").isNotEmpty() }
        assertEquals(listOf("startOrbit"), desde(i))
    }

    // ---- seguir: a 25 m, quieto o en movimiento, sin orbitar jamás ----

    @Test
    fun seguirSeAcercaA25mYNuncaOrbita() = runBlocking {
        patrullando()
        conLaReaccion(ReaccionADeteccion.SEGUIR)
        val i = confirmada()

        assertEquals(PatrolState.FOLLOWING, patrulla.state.value)
        assertEquals("seguirObjetivo", desde(i).first())
        assertEquals("con el objetivo quieto, sin velocidad", 0.0 to 0.0, dron.ultimaVelocidadSeguida)
        val (oLat, oLon) = objetivoEnElTerreno(100.0)
        val seguido = requireNotNull(dron.ultimoSeguimiento)
        assertEquals(0.0, Geo.distanciaM(oLat, oLon, seguido.first, seguido.second), 1.0)
        assertTrue(mensajeDe("ORBIT_STARTED"), mensajeDe("ORBIT_STARTED").endsWith("el dron pasa a seguirlo a 25 m, sin orbitar"))

        moverElObjetivo()
        esperarA("TARGET_MOVING") { eventos("TARGET_MOVING").isNotEmpty() }
        assertEquals(PatrolState.FOLLOWING, patrulla.state.value)
        assertTrue(mensajeDe("TARGET_MOVING"), mensajeDe("TARGET_MOVING").endsWith("el dron lo sigue a 25 m"))
        val v = requireNotNull(dron.ultimaVelocidadSeguida)
        assertTrue("sigue con la velocidad del objetivo: $v", v.second > 1.0)

        detenerElObjetivo()
        esperarA("TARGET_STOPPED") { eventos("TARGET_STOPPED").isNotEmpty() }
        assertEquals("se queda a 25 m, sin pasar a orbitar", PatrolState.FOLLOWING, patrulla.state.value)
        assertEquals("El objetivo se detuvo: el dron se queda a 25 m, quieto", mensajeDe("TARGET_STOPPED"))

        perderElObjetivo()
        assertEquals(PatrolState.FOLLOWING, patrulla.state.value)
        assertEquals("perdido, se queda donde la última estimación", 0.0 to 0.0, dron.ultimaVelocidadSeguida)
        assertTrue(mensajeDe("TARGET_LOST"), mensajeDe("TARGET_LOST").contains("se queda a 25 m de su última posición conocida"))

        assertTrue("ni una órbita en todo el seguimiento: ${desde(i)}", desde(i).all { it == "seguirObjetivo" })
    }

    // ---- detenerse: vigila desde donde está, sin moverse ----

    @Test
    fun detenerseVigilaConLaNarizYLaCamaraSinMoverseNunca() = runBlocking {
        patrullando()
        conLaReaccion(ReaccionADeteccion.DETENERSE)
        val i = confirmada()

        assertEquals(PatrolState.VIGILANDO, patrulla.state.value)
        assertEquals("vigilar", desde(i).first())
        val (oLat, oLon) = objetivoEnElTerreno(100.0)
        val vigilado = requireNotNull(dron.ultimaVigilancia)
        assertEquals("mira a donde se lo detectó", 0.0, Geo.distanciaM(oLat, oLon, vigilado.first, vigilado.second), 1.0)
        assertTrue(mensajeDe("ORBIT_STARTED"), mensajeDe("ORBIT_STARTED").endsWith("el dron se detiene donde está y lo vigila con la cámara"))
        esperarA("el status") { banco.mensajes("status").lastOrNull()?.optString("state") == "VIGILANDO" }

        moverElObjetivo()
        esperarA("TARGET_MOVING") { eventos("TARGET_MOVING").isNotEmpty() }
        assertEquals(PatrolState.VIGILANDO, patrulla.state.value)
        assertTrue("la mirada acompaña al objetivo", requireNotNull(dron.ultimaVigilancia).second > vigilado.second)
        assertTrue(mensajeDe("TARGET_MOVING"), mensajeDe("TARGET_MOVING").endsWith("sin moverse"))

        detenerElObjetivo()
        esperarA("TARGET_STOPPED") { eventos("TARGET_STOPPED").isNotEmpty() }
        assertEquals(PatrolState.VIGILANDO, patrulla.state.value)

        perderElObjetivo()
        assertEquals(PatrolState.VIGILANDO, patrulla.state.value)
        assertTrue(mensajeDe("TARGET_LOST"), mensajeDe("TARGET_LOST").contains("el dron queda mirando su última posición conocida"))

        detectar()
        esperarA("TARGET_REACQUIRED") { eventos("TARGET_REACQUIRED").isNotEmpty() }
        assertTrue("solo vigilar, nada que lo traslade: ${desde(i)}", desde(i).all { it == "vigilar" })
        assertFalse(desde(i).any { it in TRASLADAN })
    }

    // ---- El ajuste cambia con un objetivo en curso ----

    @Test
    fun cambiarLaReaccionConUnObjetivoEnCursoSeAplicaEnLaEvaluacionSiguiente() = runBlocking {
        patrullando()
        confirmada()
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        val origen = requireNotNull(dron.ultimaOrbita)

        conLaReaccion(ReaccionADeteccion.DETENERSE)
        esperarA("vigilar") { patrulla.state.value == PatrolState.VIGILANDO }
        esperarA("la orden de vigilar") { dron.ultimaOrden == "vigilar" }

        conLaReaccion(ReaccionADeteccion.SEGUIR)
        esperarA("seguir") { patrulla.state.value == PatrolState.FOLLOWING }
        esperarA("la orden de seguir") { dron.ultimaOrden == "seguirObjetivo" }

        // Después de seguirlo, volver a `orbitar` es orbitar donde se lo detectó.
        moverElObjetivo()
        dron.ultimaOrbita = null
        conLaReaccion(ReaccionADeteccion.ORBITAR)
        esperarA("orbitar") { patrulla.state.value == PatrolState.ORBITING }
        esperarA("la órbita en el origen") { dron.ultimaOrbita == origen }
        assertNotNull(patrulla.objetivo)
    }

    // ---- Al soltar el control, el dron vuelve al objetivo con la reacción vigente ----

    private suspend fun alSoltarElControlVuelveCon(reaccion: ReaccionADeteccion, estado: PatrolState, orden: String) {
        patrullando()
        conLaReaccion(reaccion)
        confirmada()
        consola("""{"type":"control_taken","by":"op"}""")
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        val i = dron.ordenes.size

        consola("""{"type":"control_released","by":"op"}""")
        esperarA("la vuelta al objetivo") { patrulla.state.value == estado }
        esperarA("TRACKING_RESUMED") { eventos("TRACKING_RESUMED").isNotEmpty() }

        // Al salir de MANUAL se tira la inclinación de la consola y sale la orden de la
        // reacción; lo que siga es el lazo del seguimiento renovando esa misma orden.
        assertEquals(listOf(DronEspia.CANCELAR_CAMARA, orden), desde(i).take(2))
        delay(300)
        assertTrue("solo la orden de la reacción: ${desde(i)}", desde(i).drop(2).all { it == orden })
        assertTrue("volver no es noticia del movimiento", eventos("TARGET_MOVING").isEmpty())
    }

    @Test
    fun alSoltarElControlVuelveAOrbitarConSeguirYOrbitar() = runBlocking {
        alSoltarElControlVuelveCon(ReaccionADeteccion.SEGUIR_Y_ORBITAR, PatrolState.ORBITING, "startOrbit")
    }

    @Test
    fun alSoltarElControlVuelveAOrbitarElLugarConOrbitar() = runBlocking {
        alSoltarElControlVuelveCon(ReaccionADeteccion.ORBITAR, PatrolState.ORBITING, "startOrbit")
    }

    @Test
    fun alSoltarElControlVuelveASeguirConSeguir() = runBlocking {
        alSoltarElControlVuelveCon(ReaccionADeteccion.SEGUIR, PatrolState.FOLLOWING, "seguirObjetivo")
    }

    @Test
    fun alSoltarElControlVuelveAVigilarConDetenerse() = runBlocking {
        alSoltarElControlVuelveCon(ReaccionADeteccion.DETENERSE, PatrolState.VIGILANDO, "vigilar")
    }

    // ---- Vigilando también valen las órdenes de siempre ----

    @Test
    fun vigilandoElDescarteRetomaLaRutaYDetenerLoPausa() = runBlocking {
        patrullando()
        conLaReaccion(ReaccionADeteccion.DETENERSE)
        confirmada()

        consola("""{"type":"alert_decision","decision":"DISMISSED","decidedBy":"op"}""")
        esperarA("la ruta retomada") { patrulla.state.value == PatrolState.PATROLLING }
        esperarA("TRACKING_ENDED") { eventos("TRACKING_ENDED").isNotEmpty() }

        banco.reloj.adelantar(PatrolManager.SILENCIO_AL_RETOMAR_MS + 1_000)
        banco.telemetria(norteM = 400.0)
        confirmada()
        assertEquals(PatrolState.VIGILANDO, patrulla.state.value)
        consola("""{"type":"stop_patrol","orderedBy":"op"}""")
        esperarA("la pausa") { patrulla.state.value == PatrolState.PAUSED }
        assertEquals("hold", dron.ultimaOrden)
        assertEquals(2, eventos("TRACKING_ENDED").size)
    }

    // ---- B toma el objetivo de un relevo con SU reacción (RELEVOS §3.5) ----

    @Test
    fun bTomaElObjetivoDelRelevoConSuReaccion() = runBlocking {
        banco.enElSuelo()
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        banco.telemetria(norteM = 5.0, bateria = 95.0, alt = 0.0)
        assertTrue(patrulla.ponerEnEspera(true))
        conLaReaccion(ReaccionADeteccion.DETENERSE)
        val quieto = objetivo(12, 600.0)
        banco.hub(relayTracking(7, 12, quieto, ts = 1_000))
        esperarA("la cuenta regresiva") { patrulla.cuentaRegresiva.value?.habilitando == false }
        banco.hub(relayTarget(7, 12, quieto, ts = 2_000, aNorteM = 600.0, aAlt = 40.0))
        banco.pasar(10_000)
        esperarA("el despegue") { dron.ordenes.any { it.startsWith("despegarHasta") } }
        dron.estado.value = dron.estado.value.copy(enVuelo = true)
        banco.evento(FlightEvent.Despegando)
        banco.telemetria(norteM = 5.0, bateria = 94.0, alt = 60.0)
        banco.evento(FlightEvent.EnElAire)
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 60.0)
        banco.pasar(200)
        esperarA("el relay_ready") { banco.mensajes("relay_ready").isNotEmpty() }

        // A ya está lejos: B baja y, al llegar a la altura, toma el objetivo vigilándolo.
        banco.hub(relayTarget(7, 12, quieto, ts = 4_000, aNorteM = 720.0))
        banco.pasar(300)
        esperarA("la bajada") { "cambiarAltura(40)" in dron.ordenes }
        banco.telemetria(norteM = 545.0, bateria = 90.0, alt = 41.5)
        banco.pasar(300)
        esperarA("la vigilancia") { patrulla.state.value == PatrolState.VIGILANDO }
        esperarA("TRACKING_RESUMED") { eventos("TRACKING_RESUMED").isNotEmpty() }
        assertEquals("vigilar", dron.ultimaOrden)
        assertFalse("B no orbita ni sigue: vigila", dron.ordenes.any { it == "startOrbit" || it == "seguirObjetivo" })
        assertEquals(12L, patrulla.objetivo?.alertId)
    }

    // ---- Un cambio de reacción con el objetivo perdido de vista ----

    /**
     * Perdido de vista, la orden sale una sola vez; un cambio del ajuste en ese
     * rato también se aplica: la orden del perdido vuelve a salir con la
     * reacción nueva, una vez, y sin otro `TARGET_LOST` (sigue perdido).
     */
    @Test
    fun cambiarLaReaccionConElObjetivoPerdidoVuelveADarLaOrdenDelPerdido() = runBlocking {
        patrullando()
        confirmada()
        perderElObjetivo()
        assertEquals(PatrolState.ORBITING, patrulla.state.value)
        val i = dron.ordenes.size

        conLaReaccion(ReaccionADeteccion.DETENERSE)
        esperarA("la vigilancia") { patrulla.state.value == PatrolState.VIGILANDO }
        // Un par de evaluaciones más: la orden no se repite.
        delay(1_100)

        assertEquals(listOf("vigilar"), desde(i))
        assertEquals("sigue perdido: un solo aviso", 1, eventos("TARGET_LOST").size)
        assertTrue(patrulla.localLog.replayCache.any { it.contains("Reacción nueva con el objetivo perdido de vista (detenerse)") })
    }
}
