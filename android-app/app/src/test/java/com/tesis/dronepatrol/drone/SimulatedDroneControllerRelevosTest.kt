package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Waypoint
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El dron simulado en lo que piden los relevos, el desvío a otra base y la
 * última ubicación (docs/RELEVOS.md): su batería y su autonomía, las órdenes
 * nuevas (despegar hasta una altura, volar hacia un punto a la altura en que
 * está, girar en el lugar, apuntar la cámara, cortar el regreso, fijar el punto
 * de retorno, los failsafes) y lo que el propio DJI decide por su cuenta.
 *
 * Corre con el reloj virtual de la prueba: minutos de vuelo en milisegundos, sin
 * dormir. No necesita Robolectric porque nadie mira el video, y sin nadie
 * mirando el simulador no dibuja cuadros (si dibujara, android.graphics
 * reventaría acá y la prueba fallaría).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SimulatedDroneControllerRelevosTest {

    private companion object {
        // El punto en el que arranca el dron simulado: el Obelisco.
        const val LAT = -34.6037
        const val LON = -58.3816

        /** Consumo por tick de 500 ms con el modelo por defecto (4 %/min). */
        const val GASTO_POR_TICK = 4.0 / 60.0 * 0.5

        fun alNorte(metros: Double) = LAT + metros / Geo.METROS_POR_GRADO_LAT

        fun alEste(metros: Double) = LON + metros / Geo.metrosPorGradoLon(LAT)

        val RUTA = PatrolRoute(1, "Manzana", listOf(Waypoint(alNorte(20.0), LON, 12.0), Waypoint(LAT, LON, 12.0)))
    }

    /** Lo que tiene a mano cada prueba: el dron y todo lo que avisó, en orden. */
    private class Banco(val dron: SimulatedDroneController, val eventos: List<FlightEvent>) {
        val ultima: Telemetry get() = dron.telemetry.replayCache.last()

        val problemas: List<String> get() = eventos.filterIsInstance<FlightEvent.Problema>().map { it.motivo }

        fun cuantos(evento: FlightEvent) = eventos.count { it == evento }

        fun tomas() = eventos.filterIsInstance<FlightEvent.ElDronTomoElControl>().map { it.motivo }
    }

    /**
     * Un simulador conectado con el reloj de la prueba; al terminar se
     * desconecta pase lo que pase (sus lazos no son hijos de la prueba).
     */
    private fun conDron(
        enElAire: Boolean = true,
        modelo: ModeloDeBateria = ModeloDeBateria(),
        cuerpo: suspend TestScope.(Banco) -> Unit,
    ) = runTest {
        val dron = SimulatedDroneController(enElAire, modelo, StandardTestDispatcher(testScheduler)) { testScheduler.currentTime }
        val eventos = mutableListOf<FlightEvent>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { dron.flightEvents.collect { eventos += it } }
        dron.connect()
        try {
            cuerpo(Banco(dron, eventos))
        } finally {
            dron.disconnect()
        }
    }

    private fun TestScope.volar(ms: Long) {
        advanceTimeBy(ms)
        runCurrent()
    }

    private fun metrosAlNorte(t: Telemetry) = (t.lat - LAT) * Geo.METROS_POR_GRADO_LAT

    private fun metrosAlEste(t: Telemetry) = (t.lon - LON) * Geo.metrosPorGradoLon(LAT)

    // ---- Batería y autonomía ----

    @Test
    fun enElAireGastaElConsumoDelModelo() = conDron { b ->
        b.dron.hold()
        volar(60_000)

        assertEquals("4 % en un minuto", 96.0, b.ultima.batteryPct, 1e-6)
    }

    /** Suspendido sin orden (como queda un dron después de despegar a mano) también gasta. */
    @Test
    fun suspendidoSinOrdenTambienGasta() = conDron { b ->
        volar(30_000)

        assertEquals(98.0, b.ultima.batteryPct, 1e-6)
    }

    @Test
    fun enElSueloNoGasta() = conDron(enElAire = false) { b ->
        volar(60_000)

        assertEquals(100.0, b.ultima.batteryPct, 0.0)
    }

    @Test
    fun unModeloMasGastadorBajaMasRapido() = conDron(modelo = ModeloDeBateria(consumoPctPorMinuto = 60.0)) { b ->
        volar(10_000)

        assertEquals(90.0, b.ultima.batteryPct, 1e-6)
    }

    /**
     * A 1 km de casa y 40 m de altura: lo que cuesta volver (125 s de crucero y
     * 8 s de descenso), lo que cuesta aterrizar ahí (los 8 s) y el radio que
     * todavía puede volar, como el DJI lo informa en `KeyLowBatteryRTHInfo`.
     */
    @Test
    fun laTelemetriaInformaLaAutonomiaDelModelo() = conDron { b ->
        // En el aire, mudar la base no mueve al dron: solo cambia a dónde vuelve.
        b.dron.setHome(alNorte(1_000.0), LON)
        volar(500)

        val t = b.ultima
        val porSegundo = 4.0 / 60.0
        val bateria = 100.0 - GASTO_POR_TICK
        assertEquals(bateria, t.batteryPct, 1e-9)
        assertEquals(133.0, t.segundosParaVolver, 1e-6)
        assertEquals(133.0 * porSegundo, t.pctParaVolver, 1e-6)
        assertEquals(8.0 * porSegundo, t.pctParaAterrizar, 1e-9)
        val metrosDisponibles = (bateria - 8.0 * porSegundo) / (125.0 * porSegundo) * 1_000.0
        assertEquals((metrosDisponibles + 1_000.0) / 2.0, t.alcanceM, 1e-3)
    }

    /** Un DJI que todavía no la informó: NaN, y la app se queda sin desvío ni ventana de gracia. */
    @Test
    fun sinAutonomiaInformadaSaleEnNaNPeroLaBateriaSigueBajando() = conDron { b ->
        b.dron.informarAutonomia(false)
        volar(1_000)

        val t = b.ultima
        assertTrue(t.pctParaVolver.isNaN() && t.pctParaAterrizar.isNaN() && t.alcanceM.isNaN() && t.segundosParaVolver.isNaN())
        assertEquals(100.0 - 2 * GASTO_POR_TICK, t.batteryPct, 1e-9)

        b.dron.informarAutonomia(true)
        volar(500)
        assertFalse(b.ultima.pctParaVolver.isNaN())
    }

    @Test
    fun fijarLaBateriaLaRecortaYSeVeEnLaTelemetria() = conDron(enElAire = false) { b ->
        b.dron.fijarBateria(150.0)
        volar(500)
        assertEquals(100.0, b.ultima.batteryPct, 0.0)

        b.dron.fijarBateria(-3.0)
        volar(500)
        assertEquals(0.0, b.ultima.batteryPct, 0.0)

        b.dron.fijarBateria(Double.NaN)
        volar(500)
        assertEquals("un NaN no la toca", 0.0, b.ultima.batteryPct, 0.0)
    }

    @Test
    fun elEstadoTraeElPuntoDeRetornoYElUmbralCritico() = conDron(modelo = ModeloDeBateria(umbralCriticoPct = 15.0)) { b ->
        assertEquals(LAT, b.dron.estado.value.puntoDeRetornoLat, 0.0)
        assertEquals(LON, b.dron.estado.value.puntoDeRetornoLon, 0.0)
        assertEquals(15.0, b.dron.estado.value.umbralCriticoPct, 0.0)

        b.dron.setHome(alNorte(300.0), alEste(100.0))

        assertEquals(alNorte(300.0), b.dron.estado.value.puntoDeRetornoLat, 0.0)
        assertEquals(alEste(100.0), b.dron.estado.value.puntoDeRetornoLon, 0.0)
    }

    // ---- despegarHasta ----

    /** El despegue de B en un relevo: derecho por su columna y estacionario arriba, sin ruta. */
    @Test
    fun despegarHastaSubeDerechoYQuedaEstacionarioALaAltura() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(25.0)
        assertEquals(listOf<FlightEvent>(FlightEvent.Despegando), b.eventos)
        assertTrue(b.dron.estado.value.enVuelo)

        volar(4_500) // 22,5 m a 5 m/s: todavía subiendo
        assertEquals(listOf<FlightEvent>(FlightEvent.Despegando), b.eventos)
        volar(500)
        assertEquals(listOf(FlightEvent.Despegando, FlightEvent.EnElAire), b.eventos)
        assertEquals(25.0, b.ultima.altM, 1e-9)

        volar(10_000)
        val t = b.ultima
        assertEquals("se quedó a la altura pedida", 25.0, t.altM, 1e-9)
        assertEquals("se movió en el plano", LAT, t.lat, 0.0)
        assertEquals(LON, t.lon, 0.0)
        assertEquals("arrancó algo después de subir", listOf(FlightEvent.Despegando, FlightEvent.EnElAire), b.eventos)
    }

    @Test
    fun despegarHastaEnElAireNoHaceNada() = conDron { b ->
        b.dron.despegarHasta(80.0)
        volar(5_000)

        assertTrue(b.eventos.isEmpty())
        assertEquals(40.0, b.ultima.altM, 1e-9)
    }

    @Test
    fun despegarHastaRecortaLaAlturaAlTecho() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(500.0)
        volar(30_000)

        assertEquals(120.0, b.ultima.altM, 1e-9)
        assertEquals(1, b.cuantos(FlightEvent.EnElAire))
    }

    @Test
    fun despegarHastaUnaAlturaSinSentidoNoDespega() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(Double.NaN)
        volar(2_000)

        assertTrue(b.eventos.isEmpty())
        assertFalse(b.dron.estado.value.enVuelo)
    }

    // ---- volarHacia ----

    /** Va a la altura de tránsito en la que está, no a la de crucero como gotoPoint. */
    @Test
    fun volarHaciaVaALaAlturaEnQueEstaYAvisaAlLlegar() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(60.0)
        volar(12_000)
        assertEquals(60.0, b.ultima.altM, 1e-9)

        b.dron.volarHacia(alNorte(200.0), LON)
        volar(20_000)
        assertEquals("200 m a 8 m/s no se hacen en 20 s", 0, b.cuantos(FlightEvent.GotoArrived))
        assertEquals(60.0, b.ultima.altM, 1e-9)
        volar(6_000)

        assertEquals(1, b.cuantos(FlightEvent.GotoArrived))
        val llegada = b.ultima
        assertEquals(200.0, metrosAlNorte(llegada), 6.0)
        assertEquals(60.0, llegada.altM, 1e-9)
        // Y queda estacionario ahí.
        volar(5_000)
        assertEquals(llegada.lat, b.ultima.lat, 0.0)
        assertEquals(60.0, b.ultima.altM, 1e-9)
    }

    /** B corrige el objetivo con cada relay_target: solo cambia a dónde va, sin parar. */
    @Test
    fun volarHaciaDeNuevoEnCaminoSoloCorrigeElDestino() = conDron { b ->
        b.dron.volarHacia(alNorte(400.0), LON)
        volar(10_000)
        assertEquals(80.0, metrosAlNorte(b.ultima), 1e-6)

        b.dron.volarHacia(alNorte(80.0), alEste(300.0))
        volar(45_000)

        assertEquals("el primer destino no se alcanzó nunca", 1, b.cuantos(FlightEvent.GotoArrived))
        assertEquals(80.0, metrosAlNorte(b.ultima), 6.0)
        assertEquals(300.0, metrosAlEste(b.ultima), 6.0)
        assertEquals(40.0, b.ultima.altM, 1e-9)
    }

    @Test
    fun reenviarElPuntoAlQueYaLlegoNoRepiteElAvisoYUnoNuevoSi() = conDron { b ->
        b.dron.volarHacia(alNorte(40.0), LON)
        volar(8_000)
        assertEquals(1, b.cuantos(FlightEvent.GotoArrived))

        b.dron.volarHacia(alNorte(40.0), LON)
        volar(3_000)
        assertEquals(1, b.cuantos(FlightEvent.GotoArrived))

        b.dron.volarHacia(alNorte(40.0), alEste(50.0))
        volar(10_000)
        assertEquals(2, b.cuantos(FlightEvent.GotoArrived))
    }

    @Test
    fun volarHaciaEnElSueloSeRechazaYUnPuntoSinSentidoSeIgnora() = conDron(enElAire = false) { b ->
        b.dron.volarHacia(alNorte(100.0), LON)
        assertTrue(b.problemas.single().contains("en el suelo"))
        assertFalse(b.dron.estado.value.enVuelo)
    }

    @Test
    fun volarHaciaUnPuntoSinSentidoNoMueveAlDron() = conDron { b ->
        b.dron.hold()
        b.dron.volarHacia(Double.NaN, LON)
        b.dron.volarHacia(0.0, 0.0)
        volar(3_000)

        assertEquals(LAT, b.ultima.lat, 0.0)
        assertEquals(LON, b.ultima.lon, 0.0)
        assertTrue(b.eventos.isEmpty())
    }

    // ---- girarEnElLugar y apuntarCamara ----

    /** La panorámica: gira por el lado corto (0 → 270 es −90), sin moverse ni cambiar de altura. */
    @Test
    fun girarEnElLugarGiraPorElLadoCortoSinMoverse() = conDron { b ->
        b.dron.girarEnElLugar(270.0)

        volar(500)
        assertEquals("un tick a 90°/s", 315.0, b.ultima.heading, 1e-9)
        volar(500)
        assertEquals(270.0, b.ultima.heading, 1e-9)
        volar(2_000)

        val t = b.ultima
        assertEquals(270.0, t.heading, 1e-9)
        assertEquals(LAT, t.lat, 0.0)
        assertEquals(LON, t.lon, 0.0)
        assertEquals(40.0, t.altM, 1e-9)
    }

    @Test
    fun unGiroCortoLlegaEnUnTickYUnRumboFueraDeRangoSePliega() = conDron { b ->
        b.dron.girarEnElLugar(-315.0) // es 45°
        volar(500)

        assertEquals(45.0, b.ultima.heading, 1e-9)
    }

    /** girar sostiene la altura en la que está: no vuelve a la de crucero como hold(). */
    @Test
    fun girarSostieneLaAlturaEnLaQueEsta() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(70.0)
        volar(15_000)
        b.dron.girarEnElLugar(90.0)
        volar(5_000)

        assertEquals(90.0, b.ultima.heading, 1e-9)
        assertEquals(70.0, b.ultima.altM, 1e-9)
    }

    @Test
    fun girarEnElSueloSeRechazaYUnRumboSinSentidoSeIgnora() = conDron(enElAire = false) { b ->
        b.dron.girarEnElLugar(Double.NaN)
        assertTrue(b.eventos.isEmpty())

        b.dron.girarEnElLugar(90.0)
        assertTrue(b.problemas.single().contains("en el suelo"))
    }

    /** Para la app la cámara no pasa del horizonte; la consola sí puede (inclinarCamara). */
    @Test
    fun apuntarCamaraNoPasaDelHorizonte() = conDron { b ->
        b.dron.apuntarCamara(-90.0)
        volar(500)
        assertEquals(-90.0, b.ultima.gimbalPitch, 0.0)

        b.dron.apuntarCamara(20.0)
        volar(500)
        assertEquals(0.0, b.ultima.gimbalPitch, 0.0)

        b.dron.apuntarCamara(Double.NaN)
        volar(500)
        assertEquals(0.0, b.ultima.gimbalPitch, 0.0)

        b.dron.inclinarCamara(20.0)
        volar(500)
        assertEquals(20.0, b.ultima.gimbalPitch, 0.0)
    }

    // ---- El descenso en la base ----

    /** El aviso que dispara landing_at_base: una vez, al EMPEZAR a bajar (todavía a la altura de regreso). */
    @Test
    fun elRegresoDeLaAppAvisaElDescensoAlEmpezarABajar() = conDron { b ->
        var alturaAlAvisar = Double.NaN
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            b.dron.flightEvents.collect { if (it == FlightEvent.DescendiendoEnBase) alturaAlAvisar = b.ultima.altM }
        }
        b.dron.setHome(alNorte(100.0), LON)

        b.dron.returnHome()
        volar(25_000)

        assertEquals(listOf(FlightEvent.DescendiendoEnBase, FlightEvent.ArrivedHome), b.eventos)
        assertEquals(40.0, alturaAlAvisar, 1e-9)
        assertEquals(100.0, metrosAlNorte(b.ultima), 6.0)
        assertFalse(b.dron.estado.value.enVuelo)
    }

    @Test
    fun pedirElRegresoDosVecesNoRepiteElDescenso() = conDron { b ->
        b.dron.setHome(alNorte(100.0), LON)
        b.dron.returnHome()
        volar(14_000)
        assertEquals(1, b.cuantos(FlightEvent.DescendiendoEnBase))

        b.dron.returnHome()
        volar(10_000)

        assertEquals(1, b.cuantos(FlightEvent.DescendiendoEnBase))
        assertEquals(1, b.cuantos(FlightEvent.ArrivedHome))
    }

    /** Un regreso que nadie pidió no es el de un relevo: no avisa el descenso. */
    @Test
    fun unRegresoPropioNoAvisaElDescenso() = conDron { b ->
        b.dron.setHome(alNorte(100.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)
        volar(25_000)

        assertEquals(
            listOf(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA), FlightEvent.ArrivedHome),
            b.eventos,
        )
    }

    /** La app adopta el regreso propio con returnHome(): sigue sin cortes y el descenso se avisa. */
    @Test
    fun adoptarUnRegresoPropioAvisaElDescenso() = conDron { b ->
        b.dron.setHome(alNorte(100.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_DEL_CONTROL)
        volar(5_000)
        val enCamino = metrosAlNorte(b.ultima)

        b.dron.returnHome()
        volar(500)
        assertTrue("siguió volviendo", metrosAlNorte(b.ultima) > enCamino)
        volar(20_000)

        assertEquals(
            listOf(
                FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_DEL_CONTROL),
                FlightEvent.DescendiendoEnBase,
                FlightEvent.ArrivedHome,
            ),
            b.eventos,
        )
    }

    // ---- El propio DJI toma el control ----

    @Test
    fun laTomaPorBateriaRechazaLasOrdenesDeVueloHastaAterrizar() = conDron { b ->
        b.dron.setHome(alNorte(60.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)
        assertEquals(listOf(MotivoDelDron.RTH_BATERIA), b.tomas())

        b.dron.gotoPoint(LAT, alEste(300.0))
        b.dron.volarHacia(LAT, alEste(300.0))
        b.dron.hold()
        b.dron.girarEnElLugar(90.0)
        b.dron.manualStick(1.0, 0.0, 0.0, 0.0)
        b.dron.startOrbit(LAT, LON, 30.0)
        b.dron.seguirObjetivo(LAT, LON, 1.0, 0.0)
        b.dron.startRoute(RUTA, 0)

        assertEquals(8, b.problemas.size)
        assertTrue(b.problemas.all { it.startsWith("el propio dron tomó el control (regreso propio por batería baja)") })
        volar(3_000)
        assertTrue("siguió volviendo a la base", metrosAlNorte(b.ultima) > 10.0)
        assertEquals("no fue al este", 0.0, metrosAlEste(b.ultima), 1e-6)

        volar(20_000)
        assertEquals(FlightEvent.ArrivedHome, b.eventos.last())
        // En el suelo el vuelo siguiente vuelve a ser de la app.
        b.dron.startRoute(RUTA, 0)
        assertEquals(FlightEvent.Despegando, b.eventos.last())
    }

    /** El regreso por señal no deja a la app sin mando: al volver el enlace decide ella. */
    @Test
    fun laTomaPorSenialNoBloqueaLasOrdenes() = conDron { b ->
        b.dron.setHome(alNorte(300.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_SENIAL)

        b.dron.gotoPoint(LAT, alEste(200.0))
        volar(5_000)

        assertEquals(listOf(MotivoDelDron.RTH_SENIAL), b.tomas())
        assertTrue(b.problemas.isEmpty())
        assertTrue("fue al este", metrosAlEste(b.ultima) > 20.0)
    }

    @Test
    fun elAterrizajeForzadoBajaDondeEstaYNoSeConvierteEnRegreso() = conDron { b ->
        b.dron.setHome(alNorte(300.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA)

        b.dron.returnHome()
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)
        assertTrue(b.problemas.single().contains("aterrizando por batería crítica"))
        volar(10_000)

        assertEquals(listOf(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA), b.tomas())
        assertEquals(FlightEvent.Aterrizado, b.eventos.last())
        assertEquals(LAT, b.ultima.lat, 0.0)
        assertEquals(0.0, b.ultima.altM, 0.0)
        assertFalse(b.dron.estado.value.enVuelo)
    }

    @Test
    fun otraTomaLoDejaEstacionarioSinBloquear() = conDron { b ->
        b.dron.gotoPoint(alNorte(400.0), LON)
        volar(2_000)
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)
        volar(500)
        val quieto = b.ultima
        volar(2_000)

        assertEquals(listOf(MotivoDelDron.OTRO), b.tomas())
        assertEquals(quieto.lat, b.ultima.lat, 0.0)
        b.dron.gotoPoint(alNorte(400.0), LON)
        assertTrue(b.problemas.isEmpty())
    }

    @Test
    fun enElSueloNingunaTomaHaceNada() = conDron(enElAire = false) { b ->
        MotivoDelDron.entries.forEach { b.dron.simularTomaDelDron(it) }
        volar(2_000)

        assertTrue(b.eventos.isEmpty())
        assertFalse(b.dron.estado.value.enVuelo)
    }

    // ---- Lo que el DJI decide solo con su batería ----

    /**
     * A 1 km de casa volver cuesta unos 8,9 %: con la reserva crítica de 10 %
     * encima, el DJI arranca su regreso al cruzar 18,9 %.
     */
    @Test
    fun elRegresoInteligenteArrancaCuandoLaBateriaSoloAlcanzaParaVolver() = conDron { b ->
        b.dron.setHome(alNorte(1_000.0), LON)
        b.dron.fijarBateria(19.0)
        volar(1_000)
        assertTrue("todavía le sobra", b.tomas().isEmpty())

        volar(4_000)

        assertEquals(listOf(MotivoDelDron.RTH_BATERIA), b.tomas())
        volar(2_000)
        assertTrue("vuelve a casa", metrosAlNorte(b.ultima) > 5.0)
    }

    /** Durante un desvío la app se lo niega: no vuelve, y no vuelve a preguntar en ese vuelo. */
    @Test
    fun conElRegresoPropioNegadoNoVuelveSoloNiVuelveAPreguntar() = conDron { b ->
        b.dron.setHome(alNorte(1_000.0), LON)
        b.dron.permitirRthPropioPorBateria(false)
        b.dron.fijarBateria(19.0)
        volar(10_000)

        assertTrue(b.tomas().isEmpty())
        assertEquals(LAT, b.ultima.lat, 0.0)

        b.dron.permitirRthPropioPorBateria(true)
        volar(10_000)
        assertTrue("ya le contestaron que no en este vuelo", b.tomas().isEmpty())
    }

    @Test
    fun conLaBateriaCriticaAterrizaDondeEsta() = conDron { b ->
        b.dron.permitirRthPropioPorBateria(false)
        b.dron.fijarBateria(10.05)
        volar(1_000)

        assertEquals(listOf(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA), b.tomas())
        volar(10_000)
        assertEquals(FlightEvent.Aterrizado, b.eventos.last())
        assertEquals(LAT, b.ultima.lat, 0.0)
        assertEquals(LON, b.ultima.lon, 0.0)
    }

    /** Si la app ya lo está aterrizando, la batería crítica no es una toma: bajar es lo pedido. */
    @Test
    fun laBateriaCriticaConElAterrizajeYaPedidoNoEsUnaToma() = conDron { b ->
        b.dron.permitirRthPropioPorBateria(false)
        b.dron.land()
        b.dron.fijarBateria(10.0)
        volar(10_000)

        assertTrue(b.tomas().isEmpty())
        assertEquals(listOf<FlightEvent>(FlightEvent.Aterrizado), b.eventos)
    }

    // ---- Failsafe de señal ----

    /** Con el failsafe en aterrizar (desvío, emergencia), sin señal baja donde está en vez de volver. */
    @Test
    fun conElFailsafeEnAterrizarLaPerdidaDeSenialLoBajaDondeEsta() = conDron { b ->
        b.dron.setHome(alNorte(60.0), LON)
        b.dron.hold()
        b.dron.fijarFailsafeAterrizar(true)
        b.dron.setSignalLost(true)
        volar(7_000)

        assertEquals(listOf(MotivoDelDron.RTH_SENIAL), b.tomas())
        assertEquals("Aterrizando", b.dron.estado.value.detalle)

        b.dron.setSignalLost(false)
        volar(10_000)
        assertEquals(FlightEvent.Aterrizado, b.eventos.last())
        assertEquals("no fue hacia la base", LAT, b.ultima.lat, 0.0)
    }

    @Test
    fun apagadoElFailsafeVuelveAVolverALaBase() = conDron { b ->
        b.dron.setHome(alNorte(60.0), LON)
        b.dron.hold()
        b.dron.fijarFailsafeAterrizar(true)
        b.dron.fijarFailsafeAterrizar(false)
        b.dron.setSignalLost(true)
        volar(7_000)
        b.dron.setSignalLost(false)
        volar(2_000)

        assertEquals(listOf(MotivoDelDron.RTH_SENIAL), b.tomas())
        assertTrue("vuelve hacia la base", metrosAlNorte(b.ultima) > 1.0)
    }

    // ---- cancelarRegreso ----

    @Test
    fun cortarElRegresoDeLaAppLoDejaEstacionarioDondeEstaYSePuedeRepetir() = conDron { b ->
        b.dron.setHome(alNorte(500.0), LON)
        repeat(2) { vez ->
            b.dron.returnHome()
            volar(3_000)
            b.dron.cancelarRegreso()
            volar(500)
            val cortado = b.ultima
            volar(3_000)
            assertEquals("vez ${vez + 1}: siguió volviendo", cortado.lat, b.ultima.lat, 0.0)
            assertEquals(40.0, b.ultima.altM, 1e-9)
        }
        assertTrue(metrosAlNorte(b.ultima) > 30.0)
        assertTrue(b.problemas.isEmpty())
    }

    /**
     * Un regreso propio se corta una vez (y la app recupera el mando); si el DJI
     * lo vuelve a arrancar, se lo deja seguir avisando: no se pelea en lazo.
     */
    @Test
    fun unRegresoPropioSeCortaUnaSolaVezPorVuelo() = conDron { b ->
        b.dron.setHome(alNorte(500.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)
        volar(2_000)

        b.dron.cancelarRegreso()
        volar(500)
        val cortado = b.ultima
        b.dron.volarHacia(cortado.lat, alEste(30.0))
        assertTrue("la app recuperó el mando", b.problemas.isEmpty())

        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)
        assertEquals("la nueva toma se avisa", listOf(MotivoDelDron.RTH_BATERIA, MotivoDelDron.RTH_BATERIA), b.tomas())
        b.dron.cancelarRegreso()
        volar(2_000)

        val negativa = b.problemas.single()
        assertTrue(negativa, negativa.startsWith(DroneController.NO_SE_CORTO_EL_REGRESO))
        assertTrue(negativa.contains("se lo deja seguir"))
        assertTrue("siguió volviendo", b.ultima.lat > cortado.lat)
    }

    @Test
    fun cortarSinRegresoEnCursoNoHaceNada() = conDron { b ->
        b.dron.hold()
        b.dron.cancelarRegreso()
        volar(2_000)

        assertTrue(b.eventos.isEmpty())
        assertEquals(LAT, b.ultima.lat, 0.0)
    }

    // ---- fijarPuntoDeRetornoAqui ----

    /** Llegó a la base del desvío: el punto de retorno pasa a ser ahí y el regreso baja ahí mismo. */
    @Test
    fun fijarElPuntoDeRetornoAquiMudaLaBaseADondeEsta() = conDron { b ->
        b.dron.volarHacia(LAT, alEste(100.0))
        volar(15_000)
        val aca = b.ultima

        b.dron.fijarPuntoDeRetornoAqui()

        assertEquals(aca.lat, b.dron.estado.value.puntoDeRetornoLat, 0.0)
        assertEquals(aca.lon, b.dron.estado.value.puntoDeRetornoLon, 0.0)
        b.dron.returnHome()
        volar(10_000)
        assertEquals(listOf(FlightEvent.GotoArrived, FlightEvent.DescendiendoEnBase, FlightEvent.ArrivedHome), b.eventos)
        assertEquals(aca.lon, b.ultima.lon, 0.0)
    }

    /**
     * Al decidir un desvío se prueba fijar el retorno en la base destino, lejos
     * de donde está (RELEVOS §4). El simulador no tiene el límite de distancia
     * del MSDK y lo acepta: un regreso posterior va ahí. Una posición inválida
     * no cambia nada.
     */
    @Test
    fun fijarElPuntoDeRetornoEnOtroLadoMudaLaBaseAEsePunto() = conDron { b ->
        b.dron.fijarPuntoDeRetornoEn(Double.NaN, LON)
        assertEquals(LAT, b.dron.estado.value.puntoDeRetornoLat, 0.0)

        b.dron.fijarPuntoDeRetornoEn(alNorte(120.0), LON)

        assertEquals(alNorte(120.0), b.dron.estado.value.puntoDeRetornoLat, 0.0)
        assertEquals(LON, b.dron.estado.value.puntoDeRetornoLon, 0.0)
        b.dron.returnHome()
        volar(60_000)
        assertEquals(FlightEvent.ArrivedHome, b.eventos.last())
        assertEquals("baja en la base nueva (con el margen de llegada)", 120.0, metrosAlNorte(b.ultima), 5.0)
    }

    // ---- cambiarAltura: la separación vertical y la altura de tránsito (RELEVOS §3.5 y §4) ----

    /** Sube en vertical a 2 m/s, sin moverse en el plano, y queda ahí. */
    @Test
    fun cambiarAlturaSubeEnVerticalYQuedaAhi() = conDron { b ->
        b.dron.cambiarAltura(80.0)
        volar(10_000)
        assertEquals("a mitad de camino", 60.0, b.ultima.altM, 1e-9)
        volar(10_000)
        assertEquals(80.0, b.ultima.altM, 1e-9)
        volar(10_000)

        val t = b.ultima
        assertEquals(80.0, t.altM, 1e-9)
        assertEquals(LAT, t.lat, 0.0)
        assertEquals(LON, t.lon, 0.0)
        assertTrue(b.eventos.isEmpty())
    }

    @Test
    fun cambiarAlturaBajaEnVertical() = conDron { b ->
        b.dron.cambiarAltura(20.0)
        volar(15_000)

        assertEquals(20.0, b.ultima.altM, 1e-9)
        assertEquals(LAT, b.ultima.lat, 0.0)
    }

    /**
     * El desvío (§4): sube a la altura de tránsito, espera que la telemetría lo
     * confirme y recién ahí va a la otra base, a esa altura.
     */
    @Test
    fun elDesvioSubeALaDeTransitoYVaALaOtraBaseAEsaAltura() = conDron { b ->
        b.dron.cambiarAltura(60.0)
        volar(10_000)
        assertEquals(60.0, b.ultima.altM, 1e-9)
        assertEquals("subió sin moverse", LAT, b.ultima.lat, 0.0)

        b.dron.volarHacia(alNorte(200.0), LON)
        volar(30_000)

        assertEquals(listOf<FlightEvent>(FlightEvent.GotoArrived), b.eventos)
        assertEquals(200.0, metrosAlNorte(b.ultima), 6.0)
        assertEquals(60.0, b.ultima.altM, 1e-9)
    }

    /** volarHacia vuela a la altura PEDIDA: dada a mitad de la subida, la termina en el camino (no se queda a media altura). */
    @Test
    fun volarHaciaDadaAMitadDeLaSubidaLaTerminaEnElCamino() = conDron { b ->
        b.dron.cambiarAltura(60.0)
        volar(2_000)
        b.dron.volarHacia(alNorte(400.0), LON)
        volar(3_000)
        assertTrue("ya va hacia el punto", metrosAlNorte(b.ultima) > 10.0)
        volar(20_000)

        assertEquals(60.0, b.ultima.altM, 1e-9)
    }

    /**
     * El traspaso (§3.5): B va a la de tránsito y, en camino, se pone a la
     * altura de A + 20 sin frenar; llega y queda ahí.
     */
    @Test
    fun enCaminoAlTraspasoCambiaDeAlturaSinFrenar() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(60.0)
        volar(12_000)
        b.dron.volarHacia(alNorte(300.0), LON)
        volar(10_000)
        val antes = metrosAlNorte(b.ultima)

        b.dron.cambiarAltura(80.0) // A está a 60 m
        volar(5_000)
        assertEquals("siguió a 8 m/s", antes + 40.0, metrosAlNorte(b.ultima), 1e-6)
        volar(30_000)

        assertEquals(1, b.cuantos(FlightEvent.GotoArrived))
        assertEquals(300.0, metrosAlNorte(b.ultima), 6.0)
        assertEquals(80.0, b.ultima.altM, 1e-9)
    }

    /** Ya en el punto de traspaso, B baja a la de seguimiento y el giro posterior la sostiene. */
    @Test
    fun bajarALaDeSeguimientoYGirarSostieneEsaAltura() = conDron { b ->
        b.dron.cambiarAltura(30.0)
        b.dron.girarEnElLugar(180.0)
        volar(6_000)

        assertEquals(30.0, b.ultima.altM, 1e-9)
        assertEquals(180.0, b.ultima.heading, 1e-9)
    }

    /** La panorámica ya girando: cambiar la altura no la corta. */
    @Test
    fun cambiarAlturaMientrasGiraSigueGirando() = conDron { b ->
        b.dron.girarEnElLugar(180.0)
        volar(500)
        b.dron.cambiarAltura(50.0)
        volar(6_000)

        assertEquals(180.0, b.ultima.heading, 1e-9)
        assertEquals(50.0, b.ultima.altM, 1e-9)
        assertEquals(LAT, b.ultima.lat, 0.0)
    }

    /** Durante el despegue de un relevo, cambiar la altura cambia hasta dónde sube. */
    @Test
    fun cambiarAlturaDuranteElDespegueCambiaHastaDondeSube() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(60.0)
        volar(2_000)
        b.dron.cambiarAltura(30.0)
        volar(4_000)

        assertEquals(listOf(FlightEvent.Despegando, FlightEvent.EnElAire), b.eventos)
        assertEquals(30.0, b.ultima.altM, 1e-9)
    }

    /** Las otras órdenes tienen su altura: la pedida se olvida. */
    @Test
    fun otraOrdenOlvidaLaAlturaPedida() = conDron { b ->
        b.dron.cambiarAltura(70.0)
        volar(15_000)
        b.dron.gotoPoint(alNorte(30.0), LON)
        volar(15_000)

        assertEquals("gotoPoint va a la de crucero", 40.0, b.ultima.altM, 1e-9)
        b.dron.volarHacia(alNorte(60.0), LON)
        volar(10_000)
        assertEquals("y volarHacia sin altura pedida, a la que tiene", 40.0, b.ultima.altM, 1e-9)
    }

    /** Fuera de un vuelo de relevo, cambiar la altura reemplaza la orden: queda estacionario donde está. */
    @Test
    fun cambiarAlturaYendoAUnPuntoConGotoLoDejaEstacionario() = conDron { b ->
        b.dron.gotoPoint(alNorte(400.0), LON)
        volar(5_000)
        b.dron.cambiarAltura(50.0)
        volar(500)
        val quieto = b.ultima
        volar(10_000)

        assertEquals(quieto.lat, b.ultima.lat, 0.0)
        assertEquals(50.0, b.ultima.altM, 1e-9)
        assertEquals(0, b.cuantos(FlightEvent.GotoArrived))
    }

    /** El despegue de una ruta no es el de un relevo: cambiar la altura lo deja estacionario, sin ruta. */
    @Test
    fun cambiarAlturaDuranteElDespegueDeUnaRutaLaReemplaza() = conDron(enElAire = false) { b ->
        b.dron.startRoute(RUTA, 0)
        volar(1_000)
        b.dron.cambiarAltura(30.0)
        volar(20_000)

        assertEquals(listOf<FlightEvent>(FlightEvent.Despegando), b.eventos)
        assertEquals(30.0, b.ultima.altM, 1e-9)
        assertEquals(LAT, b.ultima.lat, 0.0)
    }

    @Test
    fun cambiarAlturaSeRecortaYSinSentidoSeIgnora() = conDron { b ->
        b.dron.cambiarAltura(Double.NaN)
        b.dron.cambiarAltura(Double.POSITIVE_INFINITY)
        volar(1_000)
        assertEquals(40.0, b.ultima.altM, 1e-9)

        b.dron.cambiarAltura(500.0)
        volar(60_000)
        assertEquals(120.0, b.ultima.altM, 1e-9)
        assertTrue(b.problemas.isEmpty())
    }

    @Test
    fun cambiarAlturaEnElSueloOConElVueloTomadoSeRechaza() = conDron(enElAire = false) { b ->
        b.dron.cambiarAltura(30.0)
        assertTrue(b.problemas.single().contains("en el suelo"))

        b.dron.despegarHasta(20.0)
        volar(5_000)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)
        b.dron.cambiarAltura(60.0)

        assertTrue(b.problemas.last().startsWith("el propio dron tomó el control"))
    }

    /** B sube por su columna: volarHacia durante el despegue no lo saca a volar bajo. */
    @Test
    fun volarHaciaDuranteElDespegueSeRechaza() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(60.0)
        volar(2_000)
        b.dron.volarHacia(alNorte(200.0), LON)
        volar(2_000)

        assertTrue(b.problemas.single().contains("todavía está despegando"))
        assertEquals(LAT, b.ultima.lat, 0.0)
    }

    // ---- Abortar un despegue (RELEVOS §0: ante la duda en el suelo, el dron no despega) ----

    @Test
    fun aterrizarConElDespegueRecienOrdenadoNoDespega() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(60.0)
        b.dron.land()

        assertEquals(listOf(FlightEvent.Despegando, FlightEvent.Aterrizado), b.eventos)
        assertFalse(b.dron.estado.value.enVuelo)
        volar(10_000)
        assertEquals(0.0, b.ultima.altM, 0.0)
        assertEquals(2, b.eventos.size)
    }

    /** El relevo se canceló con B ya subiendo: baja y aterriza, sin avisar nunca que está en el aire. */
    @Test
    fun aterrizarDuranteLaSubidaBajaSinAvisarEnElAire() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(60.0)
        volar(3_000)
        assertEquals(15.0, b.ultima.altM, 1e-9)

        b.dron.land()
        volar(10_000)

        assertEquals(listOf(FlightEvent.Despegando, FlightEvent.Aterrizado), b.eventos)
        assertEquals(0.0, b.ultima.altM, 0.0)
        assertFalse(b.dron.estado.value.enVuelo)
    }

    @Test
    fun quedarseQuietoConElDespegueRecienOrdenadoEsNoDespegar() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(60.0)
        b.dron.hold()
        b.dron.startRoute(RUTA, 0)
        b.dron.hold()
        volar(5_000)

        assertEquals(
            listOf(FlightEvent.Despegando, FlightEvent.Aterrizado, FlightEvent.Despegando, FlightEvent.Aterrizado),
            b.eventos,
        )
        assertEquals(0.0, b.ultima.altM, 0.0)
    }

    /** A media subida, quieto es quieto: no sigue subiendo (como el real) ni avisa que llegó. */
    @Test
    fun quedarseQuietoAMediaSubidaQuedaDondeEsta() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(60.0)
        volar(3_000)
        b.dron.hold()
        volar(10_000)

        assertEquals(15.0, b.ultima.altM, 1e-9)
        assertEquals(listOf<FlightEvent>(FlightEvent.Despegando), b.eventos)
    }

    @Test
    fun volverConElDespegueRecienOrdenadoNoDespegaYYaEstaEnLaBase() = conDron(enElAire = false) { b ->
        b.dron.despegarHasta(60.0)
        b.dron.returnHome()
        volar(5_000)

        assertEquals(listOf(FlightEvent.Despegando, FlightEvent.ArrivedHome), b.eventos)
        assertEquals(0.0, b.ultima.altM, 0.0)
    }

    // ---- prepararDespegue: el Virtual Stick al aceptar el relevo (RELEVOS §2.4 y §3.3) ----

    @Test
    fun prepararElDespegueEnElSueloSeAceptaYDespuesDespega() = conDron(enElAire = false) { b ->
        assertTrue(b.dron.prepararDespegue())
        b.dron.soltarDespegue()
        assertTrue(b.dron.prepararDespegue())

        b.dron.despegarHasta(20.0)
        volar(5_000)
        assertEquals(listOf(FlightEvent.Despegando, FlightEvent.EnElAire), b.eventos)
        assertFalse("en el aire no hay despegue que preparar", b.dron.prepararDespegue())
    }

    /** Un control en S o C se descubre al aceptar, no cuando A ya aterrizó: ni se prepara ni despega. */
    @Test
    fun conUnControlQueNoCedeElMandoNiSePreparaNiDespega() = conDron(enElAire = false) { b ->
        b.dron.rechazarElMandoVirtual(true)

        assertFalse(b.dron.prepararDespegue())
        b.dron.despegarHasta(60.0)
        volar(5_000)

        assertTrue(b.problemas.single().contains("modo N"))
        assertFalse(b.dron.estado.value.enVuelo)
        assertEquals(0.0, b.ultima.altM, 0.0)

        b.dron.rechazarElMandoVirtual(false)
        assertTrue(b.dron.prepararDespegue())
    }

    @Test
    fun sinConectarNoHayDespegueQuePreparar() = runTest {
        assertFalse(SimulatedDroneController(despachador = StandardTestDispatcher(testScheduler)).prepararDespegue())
    }

    // ---- cancelarRegreso y el botón del control (RELEVOS §4) ----

    /** El regreso que pidió una persona con el control no se corta: ni de entrada, ni adoptado, ni dos veces. */
    @Test
    fun elRegresoDelBotonDelControlNoSeCorta() = conDron { b ->
        b.dron.setHome(alNorte(500.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_DEL_CONTROL)
        volar(2_000)

        b.dron.cancelarRegreso()
        b.dron.returnHome()
        b.dron.cancelarRegreso()
        val enCamino = metrosAlNorte(b.ultima)
        volar(2_000)

        assertEquals(2, b.problemas.size)
        assertTrue(b.problemas.all { it.startsWith(DroneController.NO_SE_CORTO_EL_REGRESO) && it.contains("control") })
        assertTrue("siguió volviendo", metrosAlNorte(b.ultima) > enCamino)
    }

    /** Un regreso por batería que el DJI anuncia durante el del control no lo vuelve cortable. */
    @Test
    fun laBateriaDuranteElRegresoDelControlNoLoVuelveCortable() = conDron { b ->
        b.dron.setHome(alNorte(500.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_DEL_CONTROL)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)

        b.dron.cancelarRegreso()

        assertEquals(listOf(MotivoDelDron.RTH_BATERIA, MotivoDelDron.RTH_DEL_CONTROL), b.tomas())
        assertTrue(b.problemas.single().contains("control"))
    }

    // ---- Los avisos de toma, por motivo y por episodio ----

    /**
     * Una toma sin regreso (un estacionario) ocupaba el lugar del aviso todo el
     * vuelo: el regreso por batería que el DJI arrancaba después bloqueaba a la
     * app sin avisar. Ahora se avisa, y su único corte está entero.
     */
    @Test
    fun unaTomaSinRegresoNoTapaElRegresoPorBateriaQueSigue() = conDron { b ->
        b.dron.setHome(alNorte(1_000.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)
        b.dron.fijarBateria(18.5)
        volar(500)

        assertEquals(listOf(MotivoDelDron.OTRO, MotivoDelDron.RTH_BATERIA), b.tomas())
        b.dron.cancelarRegreso()
        b.dron.volarHacia(b.ultima.lat, alEste(50.0))
        volar(3_000)
        assertTrue(b.problemas.isEmpty())
        assertTrue("la app volvió a mandar", metrosAlEste(b.ultima) > 10.0)
    }

    /** La app cortando SU regreso no gasta el corte que RELEVOS §4 guarda para el del DJI. */
    @Test
    fun cortarElRegresoDeLaAppNoGastaElCorteDelRegresoPorBateria() = conDron { b ->
        b.dron.setHome(alNorte(1_000.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)
        b.dron.returnHome()
        volar(1_000)
        b.dron.cancelarRegreso()

        b.dron.fijarBateria(18.5)
        volar(500)
        assertEquals(MotivoDelDron.RTH_BATERIA, b.tomas().last())
        b.dron.cancelarRegreso()
        b.dron.volarHacia(b.ultima.lat, alEste(50.0))

        assertTrue(b.problemas.isEmpty())
    }

    @Test
    fun deLaSenialALaBateriaSeAvisanLasDos() = conDron { b ->
        b.dron.fijarFailsafeAterrizar(true)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_SENIAL)
        b.dron.simularTomaDelDron(MotivoDelDron.RTH_BATERIA)

        assertEquals(listOf(MotivoDelDron.RTH_SENIAL, MotivoDelDron.RTH_BATERIA), b.tomas())
    }

    /** Retomado el mando, una toma nueva por el mismo motivo es otra noticia. */
    @Test
    fun laMismaTomaDespuesDeRetomarElMandoSeVuelveAAvisar() = conDron { b ->
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)
        assertEquals("el mismo episodio", listOf(MotivoDelDron.OTRO), b.tomas())

        b.dron.gotoPoint(alNorte(100.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)

        assertEquals(listOf(MotivoDelDron.OTRO, MotivoDelDron.OTRO), b.tomas())
    }

    /**
     * Una orden de la app que saca al dron de su regreso lo termina, como en el
     * real (`KeyGoHomeStatus` vuelve a IDLE): la pérdida de señal siguiente es
     * otra toma y se avisa. Antes el episodio quedaba abierto hasta aterrizar y
     * la segunda toma por señal pasaba muda.
     */
    @Test
    fun retomarElVueloDespuesDeUnRegresoPorSenialCierraLaToma() = conDron { b ->
        b.dron.setHome(alNorte(1_000.0), LON)
        b.dron.hold()
        b.dron.setSignalLost(true)
        volar(7_000)
        assertEquals(listOf(MotivoDelDron.RTH_SENIAL), b.tomas())

        b.dron.setSignalLost(false)
        b.dron.startRoute(RUTA, 0)
        volar(1_000)
        b.dron.setSignalLost(true)
        volar(7_000)

        assertEquals(listOf(MotivoDelDron.RTH_SENIAL, MotivoDelDron.RTH_SENIAL), b.tomas())
    }

    /** Sin enlace la orden no llega: no es la app retomando el mando. */
    @Test
    fun unaOrdenSinEnlaceNoTerminaLaToma() = conDron { b ->
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)
        b.dron.setSignalLost(true)
        b.dron.gotoPoint(alNorte(100.0), LON)
        b.dron.simularTomaDelDron(MotivoDelDron.OTRO)

        assertEquals(listOf(MotivoDelDron.OTRO), b.tomas())
    }

    // ---- La carrera entre la toma y el corte (el aviso sale con el bloqueo ya escrito) ----

    /**
     * La patrulla contesta la toma EN EL ACTO con su único corte (RELEVOS §4).
     * El colector corre en el mismo hilo que el tick, adentro del aviso: es
     * exactamente la intercalación en la que el bloqueo, escrito después del
     * aviso, pisaba el corte y dejaba al dron estacionario con todas las órdenes
     * rechazadas hasta el aterrizaje forzado.
     */
    @Test
    fun quienRecibeLaTomaPuedeCortarlaEnElActo() = conDron { b ->
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            b.dron.flightEvents.collect { evento ->
                if (evento == FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA)) b.dron.cancelarRegreso()
            }
        }
        b.dron.setHome(alNorte(1_000.0), LON)
        b.dron.fijarBateria(18.5)
        volar(500)
        assertEquals(listOf(MotivoDelDron.RTH_BATERIA), b.tomas())

        b.dron.volarHacia(b.ultima.lat, alEste(100.0))
        volar(5_000)

        assertTrue(b.problemas.toString(), b.problemas.isEmpty())
        assertTrue("fue al este", metrosAlEste(b.ultima) > 30.0)
    }

    // ---- Lo del desvío vuelve solo al tocar el suelo (RELEVOS §4) ----

    /**
     * Un `permitir(true)` o un `fijarFailsafeAterrizar(false)` que la app no
     * llegó a mandar no dejan al vuelo siguiente sin el respaldo del DJI: al
     * tocar el suelo, el regreso por batería vuelve a estar permitido.
     */
    @Test
    fun alTocarElSueloVuelveElRegresoInteligente() = conDron { b ->
        b.dron.permitirRthPropioPorBateria(false)
        b.dron.land()
        volar(10_000)
        assertEquals(FlightEvent.Aterrizado, b.eventos.last())

        b.dron.despegarHasta(40.0)
        volar(9_000)
        b.dron.setHome(alNorte(1_000.0), LON)
        b.dron.fijarBateria(18.5)
        volar(500)

        assertEquals(listOf(MotivoDelDron.RTH_BATERIA), b.tomas())
    }

    @Test
    fun alTocarElSueloVuelveElFailsafeDeVolverACasa() = conDron { b ->
        b.dron.fijarFailsafeAterrizar(true)
        b.dron.land()
        volar(10_000)

        b.dron.despegarHasta(40.0)
        volar(9_000)
        b.dron.setHome(alNorte(300.0), LON)
        b.dron.setSignalLost(true)
        volar(7_000)
        b.dron.setSignalLost(false)
        volar(2_000)

        assertEquals(listOf(MotivoDelDron.RTH_SENIAL), b.tomas())
        assertTrue("vuelve a casa en vez de aterrizar", metrosAlNorte(b.ultima) > 5.0)
        assertEquals("En vuelo", b.dron.estado.value.detalle)
    }
}
