package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.BaseDelHub
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.model.Telemetry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Las cuentas de energía de docs/RELEVOS.md y, sobre todo, ADÓNDE vuelve el
 * dron ([Autonomia.decidirRegreso]). La regla que más se cuida acá es la que el
 * usuario pidió explícitamente: el dron vuelve SIEMPRE a su propia base, y se
 * desvía solo cuando de verdad no llega, confirmado durante 10 s.
 */
class AutonomiaTest {

    private companion object {
        const val LAT0 = -34.8565
        const val LON0 = -56.2075
        const val T0 = 1_000_000L

        /** Un punto a [norteM] y [esteM] de la base propia. */
        fun punto(norteM: Double, esteM: Double = 0.0): Pair<Double, Double> =
            (LAT0 + norteM / Geo.METROS_POR_GRADO_LAT) to (LON0 + esteM / Geo.metrosPorGradoLon(LAT0))

        fun base(id: Long, norteM: Double, esteM: Double = 0.0, nombre: String = "Base $id"): BaseDelHub {
            val (lat, lon) = punto(norteM, esteM)
            return BaseDelHub(id, nombre, lat, lon, null, null)
        }

        val PROPIA = base(1, 0.0, nombre = "Norte")
    }

    /** El dron a [norteM] de casa, con la autonomía que informa el DJI. */
    private fun situacion(
        norteM: Double = 1_000.0,
        bateria: Double = 30.0,
        pctParaVolver: Double = 20.0,
        pctParaAterrizar: Double = 2.0,
        alcanceM: Double = Double.NaN,
        umbralCritico: Double = Double.NaN,
        bases: List<BaseDelHub> = listOf(PROPIA),
        ahora: Long = T0,
        esteM: Double = 0.0,
        altM: Double = 40.0,
        consumoPorKm: Double = Double.NaN,
    ): Autonomia.Situacion {
        val (lat, lon) = punto(norteM, esteM)
        return Autonomia.Situacion(
            ahoraMs = ahora,
            bateriaPct = bateria,
            lat = lat,
            lon = lon,
            altM = altM,
            pctParaVolver = pctParaVolver,
            pctParaAterrizar = pctParaAterrizar,
            alcanceM = alcanceM,
            umbralCriticoPct = umbralCritico,
            casaLat = PROPIA.lat,
            casaLon = PROPIA.lon,
            bases = bases,
            propiaId = 1L,
            consumoPctPorKm = consumoPorKm,
        )
    }

    // ---- Umbrales ----

    @Test
    fun sinAutonomiaElPisoEsElUmbralFijo() {
        assertFalse(Autonomia.informada(Double.NaN))
        assertEquals(25.0, Autonomia.piso(Double.NaN), 0.0)
        assertEquals(25.0, Autonomia.umbralDeRegreso(Double.NaN), 0.0)
        assertEquals("max(35, 25 + 10)", 35.0, Autonomia.umbralDeRelevo(Double.NaN), 0.0)
    }

    @Test
    fun conAutonomiaElPisoEsLoQueCuestaVolverMasLaReserva() {
        assertEquals(35.0, Autonomia.piso(30.0), 0.0)
        assertEquals(35.0, Autonomia.umbralDeRegreso(30.0), 0.0)
        assertEquals(45.0, Autonomia.umbralDeRelevo(30.0), 0.0)
        assertEquals(38.0, Autonomia.corteDeLaVentana(30.0), 0.0)
        // Volver barato no baja el umbral fijo: el regreso sigue arrancando al 25 %.
        assertEquals(25.0, Autonomia.umbralDeRegreso(5.0), 0.0)
        assertEquals(35.0, Autonomia.umbralDeRelevo(5.0), 0.0)
    }

    @Test
    fun losSegundosDisponiblesSalenDelConsumoMedido() {
        assertNull("sin autonomía no se informan", Autonomia.segundosDisponibles(50.0, Double.NaN, 0.1))
        // (50 − (20 + 5 + 3)) / 0,1 %/s = 220 s
        assertEquals(220.0, Autonomia.segundosDisponibles(50.0, 20.0, 0.1)!!, 1e-9)
        // Sin consumo medido, el del modelo: 4 %/min
        assertEquals(22.0 / (4.0 / 60.0), Autonomia.segundosDisponibles(50.0, 20.0, Double.NaN)!!, 1e-9)
        assertEquals("nunca negativo", 0.0, Autonomia.segundosDisponibles(20.0, 20.0, 0.1)!!, 0.0)
        assertEquals("con el tope del contrato", 3_600.0, Autonomia.segundosDisponibles(99.0, 1.0, 0.001)!!, 0.0)
    }

    @Test
    fun elDisparoDeLaUltimaUbicacionUsaLoQueSeSepa() {
        assertTrue(Autonomia.disparoDeUltimaUbicacion(Double.NaN, Double.NaN).isNaN())
        assertEquals(8.0, Autonomia.disparoDeUltimaUbicacion(3.0, Double.NaN), 0.0)
        assertEquals(13.0, Autonomia.disparoDeUltimaUbicacion(Double.NaN, 10.0), 0.0)
        assertEquals(13.0, Autonomia.disparoDeUltimaUbicacion(3.0, 10.0), 0.0)
        assertEquals(15.0, Autonomia.disparoDeUltimaUbicacion(10.0, 10.0), 0.0)
    }

    @Test
    fun elVisitanteBajaEnElPuntoDeclaradoOQuinceMetrosAlNorte() {
        val conPunto = PROPIA.copy(aterrizajeLat = -34.85632, aterrizajeLon = -56.2075)
        assertEquals(-34.85632 to -56.2075, Autonomia.puntoDeVisitantes(conPunto))
        val (lat, lon) = Autonomia.puntoDeVisitantes(PROPIA)
        assertEquals(15.0, Geo.distanciaM(PROPIA.lat, PROPIA.lon, lat, lon), 1e-6)
        assertTrue("al norte", lat > PROPIA.lat)
        assertEquals(PROPIA.lon, lon, 0.0)
    }

    @Test
    fun fueraDeBaseEsLejosDeTodaBaseYDeCasa() {
        val (lejosLat, lejosLon) = punto(500.0)
        assertTrue(Autonomia.fueraDeBase(lejosLat, lejosLon, listOf(PROPIA), Double.NaN, Double.NaN))
        val (cercaLat, cercaLon) = punto(40.0)
        assertFalse("a 40 m de una base", Autonomia.fueraDeBase(cercaLat, cercaLon, listOf(PROPIA), Double.NaN, Double.NaN))
        val (casaLat, casaLon) = punto(480.0)
        assertFalse("a 20 m de su punto de retorno", Autonomia.fueraDeBase(lejosLat, lejosLon, listOf(PROPIA), casaLat, casaLon))
        assertFalse("sin GPS no se sabe: no", Autonomia.fueraDeBase(Double.NaN, Double.NaN, listOf(PROPIA), Double.NaN, Double.NaN))
        assertFalse("0,0 no es una posición", Autonomia.fueraDeBase(0.0, 0.0, emptyList(), Double.NaN, Double.NaN))
    }

    @Test
    fun enLaBaseEsAMenosDeCincuentaMetros() {
        val (lat, lon) = punto(49.0)
        assertTrue(Autonomia.enLaBase(lat, lon, PROPIA))
        val (latLejos, lonLejos) = punto(51.0)
        assertFalse(Autonomia.enLaBase(latLejos, lonLejos, PROPIA))
        assertFalse(Autonomia.enLaBase(lat, lon, null))
        assertFalse(Autonomia.enLaBase(Double.NaN, Double.NaN, PROPIA))
    }

    // ---- Adónde vuelve ----

    /** Una base a 100 m del dron, barata y dentro del enlace: la tentación de desviarse sin necesidad. */
    private val tentadora = base(2, 900.0, nombre = "Sur")

    @Test
    fun siLlegaASuBaseVuelveASuBaseAunqueHayaOtraMasCerca() {
        val d = Autonomia.decidirRegreso(situacion(bateria = 22.5, bases = listOf(PROPIA, tentadora)), Autonomia.Memoria())
        assertSame(Autonomia.Destino.BasePropia, d.destino)
        assertNull(d.memoria.comprometida)
    }

    /**
     * Sin autonomía informada (todo NaN, y sin el crítico del DJI) no hay desvío
     * ni §5, ni con la batería en el piso: vuelve a su base y el respaldo es el
     * regreso inteligente del propio DJI.
     */
    @Test
    fun sinAutonomiaNoHayDesvioNunca() {
        val s = situacion(bateria = 2.0, pctParaVolver = Double.NaN, pctParaAterrizar = Double.NaN, bases = listOf(PROPIA, tentadora))
        var memoria = Autonomia.Memoria()
        for (paso in 0..30) {
            val d = Autonomia.decidirRegreso(s.copy(ahoraMs = T0 + paso * 1_000L), memoria)
            assertSame(Autonomia.Destino.BasePropia, d.destino)
            memoria = d.memoria
        }
    }

    @Test
    fun noLlegarTieneQueSostenerseDiezSegundos() {
        val bases = listOf(PROPIA, tentadora)
        // 21 % < 20 + 2: no llega
        val d0 = Autonomia.decidirRegreso(situacion(bateria = 21.0, bases = bases), Autonomia.Memoria())
        assertSame(Autonomia.Destino.BasePropia, d0.destino)
        assertEquals(T0, d0.memoria.noLlegaDesdeMs)

        val d1 = Autonomia.decidirRegreso(situacion(bateria = 21.0, bases = bases, ahora = T0 + 9_999), d0.memoria)
        assertSame("a los 9,999 s todavía vuelve a la propia", Autonomia.Destino.BasePropia, d1.destino)

        val d2 = Autonomia.decidirRegreso(situacion(bateria = 21.0, bases = bases, ahora = T0 + 10_000), d1.memoria)
        assertEquals(Autonomia.Destino.OtraBase(tentadora, alcanzable = true), d2.destino)
        assertEquals(tentadora, d2.memoria.comprometida)
    }

    @Test
    fun unaLecturaQueVuelveALlegarReiniciaLaConfirmacion() {
        val bases = listOf(PROPIA, tentadora)
        val d0 = Autonomia.decidirRegreso(situacion(bateria = 21.0, bases = bases), Autonomia.Memoria())
        val d1 = Autonomia.decidirRegreso(situacion(bateria = 23.0, bases = bases, ahora = T0 + 5_000), d0.memoria)
        assertNull("volvió a llegar: se olvida", d1.memoria.noLlegaDesdeMs)
        val d2 = Autonomia.decidirRegreso(situacion(bateria = 21.0, bases = bases, ahora = T0 + 10_000), d1.memoria)
        assertSame(Autonomia.Destino.BasePropia, d2.destino)
        assertEquals("la cuenta arranca de nuevo", T0 + 10_000, d2.memoria.noLlegaDesdeMs)
    }

    @Test
    fun elAlcanceTambienDiceQueNoLlega() {
        val bases = listOf(PROPIA, tentadora)
        val sobra = situacion(bateria = 60.0, alcanceM = 800.0, bases = bases)
        val d0 = Autonomia.decidirRegreso(sobra, Autonomia.Memoria())
        assertEquals("a 1000 m con 800 m de alcance no llega", T0, d0.memoria.noLlegaDesdeMs)
        val d1 = Autonomia.decidirRegreso(sobra.copy(ahoraMs = T0 + 10_000), d0.memoria)
        assertTrue(d1.destino is Autonomia.Destino.OtraBase)
    }

    /** Lo confirma y decide en [ahoraFinal]; devuelve la decisión final. */
    private fun confirmado(s: Autonomia.Situacion): Autonomia.Decision {
        val d0 = Autonomia.decidirRegreso(s, Autonomia.Memoria())
        return Autonomia.decidirRegreso(s.copy(ahoraMs = s.ahoraMs + Autonomia.CONFIRMAR_NO_LLEGA_MS), d0.memoria)
    }

    @Test
    fun laCandidataTieneQueEstarDentroDelEnlaceConLaPropia() {
        // Dron a 2500 m al norte; la base candidata a 1999 m de la propia (o a 2001)
        val dentro = base(2, 1_999.0)
        val fuera = base(3, 2_001.0)
        val conDentro = confirmado(situacion(norteM = 2_500.0, bateria = 21.0, bases = listOf(PROPIA, dentro)))
        assertEquals(Autonomia.Destino.OtraBase(dentro, alcanzable = true), conDentro.destino)
        val conFuera = confirmado(situacion(norteM = 2_500.0, bateria = 21.0, bases = listOf(PROPIA, fuera)))
        assertSame("fuera del enlace no es candidata", Autonomia.Destino.BasePropia, conFuera.destino)
    }

    @Test
    fun unaBaseMasLejosQueCasaNoEsCandidata() {
        val lejos = base(2, 1_500.0, esteM = 1_500.0)
        val d = confirmado(situacion(bateria = 21.0, bases = listOf(PROPIA, lejos)))
        assertSame(Autonomia.Destino.BasePropia, d.destino)
    }

    @Test
    fun unaBaseQueNoAlcanzaConLaReservaNoEsCandidata() {
        // A ~980 m del dron: 20 × 980/1000 + subida + 2 ≈ 22 %, y con la reserva no entra en 21 %.
        // Igual es la más cercana: vuela hacia ella sabiendo que no alcanza.
        val cara = base(2, 50.0, esteM = 300.0)
        val d = confirmado(situacion(bateria = 21.0, bases = listOf(PROPIA, cara)))
        assertEquals(Autonomia.Destino.OtraBase(cara, alcanzable = false), d.destino)
    }

    @Test
    fun entreVariasCandidatasLaMasCercana() {
        val cerca = base(2, 950.0)
        val masLejos = base(3, 800.0)
        val d = confirmado(situacion(bateria = 21.0, bases = listOf(PROPIA, masLejos, cerca)))
        assertEquals(Autonomia.Destino.OtraBase(cerca, alcanzable = true), d.destino)
    }

    @Test
    fun elCostoEscalaLaCifraDelDji() {
        val b = base(2, 900.0)
        val s = situacion(norteM = 1_000.0, pctParaVolver = 20.0, pctParaAterrizar = 2.0, altM = 60.0)
        val (vLat, vLon) = Autonomia.puntoDeVisitantes(b)
        val dOtra = Geo.distanciaM(s.lat, s.lon, vLat, vLon)
        // A 60 m no hay subida: 20 × dOtra / 1000 + 2
        assertEquals(20.0 * dOtra / 1_000.0 + 2.0, Autonomia.costoDeOtraBase(s, b)!!, 1e-6)
        // A 40 m suma la subida a 60 m con el consumo por defecto
        val subida = 20.0 / Autonomia.VELOCIDAD_DE_SUBIDA_MS * Autonomia.CONSUMO_POR_DEFECTO_PCT_POR_S
        assertEquals(20.0 * dOtra / 1_000.0 + 2.0 + subida, Autonomia.costoDeOtraBase(s.copy(altM = 40.0), b)!!, 1e-6)
    }

    @Test
    fun cercaDeCasaElCostoSaleDelConsumoConUnMinimoDeOchoPorKm() {
        val b = base(2, 150.0, esteM = 100.0)
        val s = situacion(norteM = 150.0, altM = 60.0, pctParaAterrizar = 0.0)
        val (vLat, vLon) = Autonomia.puntoDeVisitantes(b)
        val km = Geo.distanciaM(s.lat, s.lon, vLat, vLon) / 1_000.0
        assertEquals("sin consumo medido, 8 %/km", 8.0 * km, Autonomia.costoDeOtraBase(s, b)!!, 1e-6)
        assertEquals("con el medido, si es mayor", 30.0 * km, Autonomia.costoDeOtraBase(s.copy(consumoPctPorKm = 30.0), b)!!, 1e-6)
        assertEquals("nunca menos de 8", 8.0 * km, Autonomia.costoDeOtraBase(s.copy(consumoPctPorKm = 2.0), b)!!, 1e-6)
        assertNull("sin autonomía no hay costo", Autonomia.costoDeOtraBase(s.copy(pctParaVolver = Double.NaN), b))
    }

    @Test
    fun elDesvioEsDeUnaSolaVia() {
        val desviado = confirmado(situacion(bateria = 21.0, bases = listOf(PROPIA, tentadora)))
        // Una lectura que diría que sí llega a casa no lo hace volver a la propia.
        val despues = Autonomia.decidirRegreso(
            situacion(bateria = 60.0, bases = listOf(PROPIA, tentadora), ahora = T0 + 20_000),
            desviado.memoria,
        )
        assertEquals(Autonomia.Destino.OtraBase(tentadora, alcanzable = true), despues.destino)
    }

    @Test
    fun elDestinoComprometidoSeMantieneAunqueSalgaDeLaLista() {
        val desviado = confirmado(situacion(bateria = 21.0, bases = listOf(PROPIA, tentadora)))
        val sinEsaBase = Autonomia.decidirRegreso(
            situacion(bateria = 21.0, bases = listOf(PROPIA), ahora = T0 + 11_000),
            desviado.memoria,
        )
        assertEquals(Autonomia.Destino.OtraBase(tentadora, alcanzable = true), sinEsaBase.destino)
    }

    @Test
    fun siLaComprometidaDejaDeAlcanzarSeCambiaAOtraSostenidoYNuncaALaPropia() {
        val comprometida = base(2, 300.0)
        val otra = base(3, 980.0)
        val memoria = Autonomia.Memoria(noLlegaDesdeMs = T0, comprometida = comprometida)
        // Con 8 % la comprometida (a ~700 m) ya no alcanza; la de 20 m sí.
        val s = situacion(bateria = 8.0, pctParaVolver = 20.0, pctParaAterrizar = 0.0, altM = 60.0, bases = listOf(PROPIA, comprometida, otra))
        val d0 = Autonomia.decidirRegreso(s, memoria)
        assertEquals(Autonomia.Destino.OtraBase(comprometida, alcanzable = false), d0.destino)
        assertEquals(T0, d0.memoria.inalcanzableDesdeMs)
        val d1 = Autonomia.decidirRegreso(s.copy(ahoraMs = T0 + 9_999), d0.memoria)
        assertEquals("todavía no se confirma", comprometida, d1.memoria.comprometida)
        val d2 = Autonomia.decidirRegreso(s.copy(ahoraMs = T0 + 10_000), d1.memoria)
        assertEquals(Autonomia.Destino.OtraBase(otra, alcanzable = true), d2.destino)
        assertEquals(otra, d2.memoria.comprometida)
        assertNull(d2.memoria.inalcanzableDesdeMs)
    }

    @Test
    fun siNoLlegaANingunaYLaMasCercanaEsOtraVuelaHaciaElla() {
        // Sin lo que cuesta aterrizar no hay disparo del §5: se ve la decisión del desvío sola.
        val masCerca = base(2, 700.0)
        val d = confirmado(situacion(bateria = 4.0, pctParaAterrizar = Double.NaN, bases = listOf(PROPIA, masCerca)))
        assertEquals(Autonomia.Destino.OtraBase(masCerca, alcanzable = false), d.destino)
        assertEquals(masCerca, d.memoria.comprometida)
    }

    @Test
    fun siNoLlegaANingunaYLaMasCercanaEsLaPropiaSigueElRegresoDelDji() {
        // La otra base queda del otro lado de casa: más lejos que la propia.
        val lejos = base(2, -600.0)
        val d = confirmado(situacion(bateria = 4.0, pctParaAterrizar = Double.NaN, bases = listOf(PROPIA, lejos)))
        assertSame(Autonomia.Destino.BasePropia, d.destino)
        assertNull(d.memoria.comprometida)
        assertEquals("el no llega queda sostenido", T0, d.memoria.noLlegaDesdeMs)
    }

    @Test
    fun conLaBateriaEnElDisparoYFueraDeBaseEsLaUltimaUbicacion() {
        val d = Autonomia.decidirRegreso(
            situacion(bateria = 13.0, pctParaAterrizar = 3.0, umbralCritico = 10.0, bases = listOf(PROPIA, tentadora)),
            Autonomia.Memoria(),
        )
        assertSame(Autonomia.Destino.UltimaUbicacion, d.destino)
        val unPocoMas = Autonomia.decidirRegreso(
            situacion(bateria = 13.5, pctParaAterrizar = 3.0, umbralCritico = 10.0),
            Autonomia.Memoria(),
        )
        assertTrue(unPocoMas.destino !is Autonomia.Destino.UltimaUbicacion)
    }

    @Test
    fun enUnaBaseNoSeDisparaLaUltimaUbicacion() {
        val d = Autonomia.decidirRegreso(
            situacion(norteM = 30.0, bateria = 5.0, pctParaAterrizar = 3.0, umbralCritico = 10.0),
            Autonomia.Memoria(),
        )
        assertSame(Autonomia.Destino.BasePropia, d.destino)
    }

    @Test
    fun sinAutonomiaPeroConElCriticoDelDjiTambienSeDispara() {
        val d = Autonomia.decidirRegreso(
            situacion(bateria = 12.0, pctParaVolver = Double.NaN, pctParaAterrizar = Double.NaN, umbralCritico = 10.0),
            Autonomia.Memoria(),
        )
        assertSame(Autonomia.Destino.UltimaUbicacion, d.destino)
    }

    @Test
    fun sinPosicionNiCasaNoHayDesvio() {
        val s = situacion(bateria = 21.0, bases = listOf(PROPIA, tentadora)).copy(lat = Double.NaN, lon = Double.NaN)
        assertSame(Autonomia.Destino.BasePropia, confirmado(s).destino)
        val sinCasa = situacion(bateria = 21.0, bases = listOf(tentadora)).copy(casaLat = Double.NaN, casaLon = Double.NaN)
        assertSame("sin casa ni base propia no hay con qué comparar", Autonomia.Destino.BasePropia, confirmado(sinCasa).destino)
    }

    @Test
    fun sinPuntoDeRetornoCasaEsLaBasePropia() {
        val s = situacion(bateria = 21.0, bases = listOf(PROPIA, tentadora)).copy(casaLat = Double.NaN, casaLon = Double.NaN)
        assertEquals(Autonomia.Destino.OtraBase(tentadora, alcanzable = true), confirmado(s).destino)
    }

    @Test
    fun laSituacionSeArmaDesdeLaTelemetria() {
        val t = Telemetry(
            -34.85, -56.2, 40.0, 33.0, 90, 0.0, 5L,
            pctParaVolver = 12.0, pctParaAterrizar = 3.0, alcanceM = 2_000.0, segundosParaVolver = 80.0,
        )
        val s = Autonomia.Situacion.desde(7L, t, 10.0, -34.86, -56.21, listOf(PROPIA), 1L, 9.0, 0.05)
        assertEquals(7L, s.ahoraMs)
        assertEquals(33.0, s.bateriaPct, 0.0)
        assertEquals(12.0, s.pctParaVolver, 0.0)
        assertEquals(3.0, s.pctParaAterrizar, 0.0)
        assertEquals(2_000.0, s.alcanceM, 0.0)
        assertEquals(10.0, s.umbralCriticoPct, 0.0)
        assertEquals(-34.86, s.casaLat, 0.0)
        assertEquals(9.0, s.consumoPctPorKm, 0.0)
        assertEquals(0.05, s.consumoPctPorS, 0.0)
    }

    // ---- Consumo medido ----

    private fun lectura(norteM: Double, bateria: Double, ts: Long): Telemetry {
        val (lat, lon) = punto(norteM)
        return Telemetry(lat, lon, 40.0, bateria, 90, 0.0, ts)
    }

    @Test
    fun elConsumoSeMideEnElVueloEnCurso() {
        val c = ConsumoMedido()
        c.registrar(lectura(0.0, 90.0, 0L), enVuelo = true)
        assertTrue("sin datos todavía", c.pctPorKm.isNaN() && c.pctPorS.isNaN())
        c.registrar(lectura(200.0, 89.0, 20_000L), enVuelo = true)
        assertTrue("200 m no alcanzan", c.pctPorKm.isNaN())
        assertTrue("20 s no alcanzan", c.pctPorS.isNaN())
        c.registrar(lectura(500.0, 88.0, 40_000L), enVuelo = true)
        assertEquals(2.0 / 0.5, c.pctPorKm, 1e-6)
        assertEquals(2.0 / 40.0, c.pctPorS, 1e-9)
    }

    @Test
    fun elConsumoArrancaDeCeroAlAterrizarOConOtraBateria() {
        val c = ConsumoMedido()
        c.registrar(lectura(0.0, 90.0, 0L), enVuelo = true)
        c.registrar(lectura(500.0, 88.0, 40_000L), enVuelo = true)
        c.registrar(lectura(500.0, 88.0, 41_000L), enVuelo = false)
        assertTrue("en el suelo se olvida", c.pctPorS.isNaN())

        c.registrar(lectura(0.0, 60.0, 50_000L), enVuelo = true)
        c.registrar(lectura(500.0, 58.0, 90_000L), enVuelo = true)
        c.registrar(lectura(500.0, 95.0, 91_000L), enVuelo = true)
        assertTrue("una batería que sube es otra batería", c.pctPorKm.isNaN())
        c.registrar(lectura(500.0, Double.NaN, 92_000L), enVuelo = true)
        assertTrue(c.pctPorS.isNaN())
    }

    @Test
    fun sinGastoNoHayConsumo() {
        val c = ConsumoMedido()
        c.registrar(lectura(0.0, 90.0, 0L), enVuelo = true)
        c.registrar(lectura(800.0, 90.0, 60_000L), enVuelo = true)
        assertTrue(c.pctPorKm.isNaN())
        assertTrue(c.pctPorS.isNaN())
    }
}
