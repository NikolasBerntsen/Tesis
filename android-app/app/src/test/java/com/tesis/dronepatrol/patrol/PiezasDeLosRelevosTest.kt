package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.comms.BaseDelHub
import com.tesis.dronepatrol.comms.MensajeDelHub
import com.tesis.dronepatrol.comms.ObjetivoDelRelevo
import com.tesis.dronepatrol.comms.Participante
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.RastreadorDeObjetivo
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.model.Waypoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Las piezas puras de los relevos (docs/RELEVOS.md §0, §2 y §3): el pedido de
 * A con sus reintentos, la ventana de gracia, el alejamiento, la geometría de
 * B, el interruptor de espera y la disponibilidad. Sin dron ni reloj: cada
 * borde se prueba con el momento exacto.
 */
class PiezasDeLosRelevosTest {

    private companion object {
        const val LAT0 = -34.8565
        const val LON0 = -56.2075
        val ALFA = Participante("a3f9c1b27d5e4408f61a9c3e772b7e42", "Alfa")

        fun punto(norteM: Double, esteM: Double = 0.0): Pair<Double, Double> =
            (LAT0 + norteM / Geo.METROS_POR_GRADO_LAT) to (LON0 + esteM / Geo.metrosPorGradoLon(LAT0))

        fun objetivo(
            norteM: Double,
            vNorte: Double = 0.0,
            vEste: Double = 0.0,
            vistoHaceMs: Long = 0L,
        ): ObjetivoDelRelevo {
            val (lat, lon) = punto(norteM)
            val v = kotlin.math.hypot(vNorte, vEste)
            return ObjetivoDelRelevo(12, "PERSON", lat, lon, v, 0.0, v > 0.1, false, vistoHaceMs, "VALIDATED", vNorte, vEste)
        }
    }

    // ---- El pedido de A ----

    @Test
    fun elPedidoSeRepiteCadaCincoSegundosHastaElRelayStatus() {
        val p = PedidoDeRelevo("ref-1", PedidoDeRelevo.PATRULLA, routeId = 1, fromIndex = 2)
        assertTrue("el primero sale ya", p.debeEnviar(1_000))
        p.enviado(1_000)
        assertFalse(p.debeEnviar(5_999))
        assertTrue(p.debeEnviar(6_000))
        assertTrue("un reloj que vuelve atrás no lo deja mudo", p.debeEnviar(500))
        p.enviado(6_000)
        p.reenviarYa()
        assertTrue("al reconectar sale ya", p.debeEnviar(6_001))

        p.aplicar(MensajeDelHub.EstadoDelPedido("ref-1", 5, "EN_CAMINO", ALFA, 40.0, null), 7_000)
        assertFalse("contestado, no se repite más", p.debeEnviar(20_000))
        assertEquals(5L, p.relayId)
        assertEquals("EN_CAMINO", p.estado)
        assertEquals(ALFA, p.relevo)
        assertEquals(40.0, p.etaS!!, 1e-9)
        assertEquals(7_000L, p.ultimoStatusMs)
    }

    @Test
    fun elRelevoEstaEnCaminoSoloConUnRelayStatusDeHaceMenosDeDiezSegundos() {
        val p = PedidoDeRelevo("r", PedidoDeRelevo.SEGUIMIENTO, alertId = 12)
        assertFalse("sin relay_status", p.relevoEnCamino(0))
        p.aplicar(MensajeDelHub.EstadoDelPedido("r", 7, "EN_CAMINO", ALFA, 30.0, null), 10_000)
        assertTrue(p.relevoEnCamino(19_999))
        assertFalse(p.relevoEnCamino(20_000))
        assertFalse("con el reloj para atrás no se cree", p.relevoEnCamino(9_000))
        p.aplicar(MensajeDelHub.EstadoDelPedido("r", 7, "ORDENADO", ALFA, 30.0, null), 21_000)
        assertFalse("ordenado todavía no salió", p.relevoEnCamino(21_000))
    }

    @Test
    fun laVentanaDeGraciaPideTodoAlMismoTiempo() {
        val p = PedidoDeRelevo("r", PedidoDeRelevo.SEGUIMIENTO, alertId = 12)
        p.aplicar(MensajeDelHub.EstadoDelPedido("r", 7, "EN_CAMINO", ALFA, 60.0, null), 0)
        val consumo = 0.1 // %/s
        // pctParaVolver 10: piso 15, corte 18. A los 25 % quedan (25 − 18) / 0,1 = 70 s ≥ 60.
        assertTrue(VentanaDeGracia.puedeSeguir(p, 1_000, 25.0, 10.0, consumo, null))
        assertFalse("sin pedido", VentanaDeGracia.puedeSeguir(null, 1_000, 25.0, 10.0, consumo, null))
        assertFalse("sin autonomía", VentanaDeGracia.puedeSeguir(p, 1_000, 25.0, Double.NaN, consumo, null))
        assertFalse("vencida", VentanaDeGracia.puedeSeguir(p, 61_000, 25.0, 10.0, consumo, 61_000))
        assertTrue("todavía abierta", VentanaDeGracia.puedeSeguir(p, 5_000, 25.0, 10.0, consumo, 61_000))
        assertFalse("en el corte", VentanaDeGracia.puedeSeguir(p, 1_000, 18.0, 10.0, consumo, null))
        assertFalse("no llega a tiempo: 65 s no alcanzan para 60 + nada", VentanaDeGracia.puedeSeguir(p, 1_000, 23.9, 10.0, consumo, null))
        assertFalse("relay_status viejo", VentanaDeGracia.puedeSeguir(p, 10_000, 25.0, 10.0, consumo, null))
        val sinEta = PedidoDeRelevo("s", PedidoDeRelevo.SEGUIMIENTO, alertId = 12)
        sinEta.aplicar(MensajeDelHub.EstadoDelPedido("s", 7, "EN_CAMINO", ALFA, null, null), 0)
        assertFalse("sin etaS no se sabe si llega", VentanaDeGracia.puedeSeguir(sinEta, 1_000, 25.0, 10.0, consumo, null))
    }

    @Test
    fun aSeAlejaHaciaCasaOHaciaDondeEsta() {
        val (oLat, oLon) = punto(1_000.0)
        val (casaLat, casaLon) = punto(0.0)
        val (aLat, aLon) = punto(1_000.0, 50.0)
        val haciaCasa = Alejamiento.punto(oLat, oLon, aLat, aLon, casaLat, casaLon)
        assertEquals(Alejamiento.DESTINO_M, Geo.distanciaM(oLat, oLon, haciaCasa.first, haciaCasa.second), 0.5)
        assertTrue("hacia el sur, donde está casa", haciaCasa.first < oLat)

        val sinCasa = Alejamiento.punto(oLat, oLon, aLat, aLon, Double.NaN, Double.NaN)
        assertTrue("hacia el este, donde ya está A", sinCasa.second > oLon)
        assertEquals(oLat, sinCasa.first, 1e-6)

        val encima = Alejamiento.punto(oLat, oLon, oLat, oLon, Double.NaN, Double.NaN)
        assertTrue("encima y sin casa: hacia el sur", encima.first < oLat)

        assertFalse(Alejamiento.seAlejo(oLat, oLon, aLat, aLon))
        val lejos = punto(899.0)
        assertTrue(Alejamiento.seAlejo(oLat, oLon, lejos.first, lejos.second))
        assertFalse("sin posición no se sabe", Alejamiento.seAlejo(oLat, oLon, Double.NaN, Double.NaN))
    }

    // ---- La geometría de B ----

    @Test
    fun laAlturaDeTransitoQuedaVeinteMetrosSobreA() {
        assertEquals(60.0, Aproximacion.alturaDeTransito(null), 1e-9)
        assertEquals(60.0, Aproximacion.alturaDeTransito(30.0), 1e-9)
        assertEquals(75.0, Aproximacion.alturaDeTransito(55.0), 1e-9)
        assertEquals("tope de 120", 120.0, Aproximacion.alturaDeTransito(110.0), 1e-9)
        assertEquals(60.0, Aproximacion.alturaDeTransito(Double.NaN), 1e-9)
    }

    @Test
    fun laAlturaDeSeguimientoEsLaDeA() {
        assertEquals(35.0, Aproximacion.alturaDeSeguimiento(35.0, 60.0), 1e-9)
        assertEquals(40.0, Aproximacion.alturaDeSeguimiento(null, 60.0), 1e-9)
        assertEquals("nunca a ras del suelo", 15.0, Aproximacion.alturaDeSeguimiento(4.0, 60.0), 1e-9)
        assertEquals("nunca más arriba que el tránsito", 60.0, Aproximacion.alturaDeSeguimiento(90.0, 60.0), 1e-9)
        assertEquals(40.0, Aproximacion.alturaDeSeguimiento(Double.NaN, 60.0), 1e-9)
    }

    @Test
    fun laEstimacionSeExtrapolaConLaVelocidadHastaUnTope() {
        val quieto = objetivo(500.0)
        assertEquals(quieto.lat to quieto.lon, Aproximacion.estimacion(quieto, 0, 10_000))
        val corre = objetivo(500.0, vNorte = 2.0)
        val (lat, _) = Aproximacion.estimacion(corre, 0, 10_000)
        assertEquals("20 m al norte en 10 s", 20.0, (lat - corre.lat) * Geo.METROS_POR_GRADO_LAT, 0.01)
        val (latTope, _) = Aproximacion.estimacion(corre, 0, 100_000)
        assertEquals("no más de 30 s", 60.0, (latTope - corre.lat) * Geo.METROS_POR_GRADO_LAT, 0.01)
        val (latAntes, _) = Aproximacion.estimacion(corre, 10_000, 5_000)
        assertEquals("un reloj para atrás no la mueve", corre.lat, latAntes, 1e-12)
    }

    @Test
    fun elPuntoDeTomaQuedaASesentaMetrosDelLadoDeB() {
        val (oLat, oLon) = punto(500.0)
        val (bLat, bLon) = punto(0.0, 100.0)
        val (tLat, tLon) = Aproximacion.puntoDeToma(oLat, oLon, bLat, bLon)
        assertEquals(60.0, Geo.distanciaM(oLat, oLon, tLat, tLon), 0.1)
        assertTrue(tLat < oLat)
        val (sLat, _) = Aproximacion.puntoDeToma(oLat, oLon, oLat, oLon)
        assertTrue("encima: del sur", sLat < oLat)

        assertTrue(Aproximacion.llegoALaToma(oLat, oLon, tLat, tLon))
        val (lejosLat, lejosLon) = punto(400.0)
        assertFalse(Aproximacion.llegoALaToma(oLat, oLon, lejosLat, lejosLon))
    }

    @Test
    fun elTransitoApuntaADondeVaAEstarElObjetivo() {
        val corre = objetivo(1_000.0, vEste = 4.0)
        val (bLat, bLon) = punto(0.0)
        val (dLat, dLon) = Aproximacion.destinoDeTransito(corre, 0, 0, bLat, bLon)
        assertTrue("adelante del objetivo, hacia donde va", dLon > corre.lon)
        assertTrue(dLat < corre.lat)
    }

    @Test
    fun bPuedeBajarConALejosORetirado() {
        val r = RelevoAsignado(7, ALFA, null, 0, 12, 0)
        assertFalse("sin objetivo", Aproximacion.puedeBajar(r))
        r.objetivo = objetivo(500.0)
        assertFalse("sin la posición de A", Aproximacion.puedeBajar(r))
        val (aLat, aLon) = punto(450.0)
        r.aLat = aLat
        r.aLon = aLon
        assertFalse("A a 50 m", Aproximacion.puedeBajar(r))
        val (lejosLat, lejosLon) = punto(390.0)
        r.aLat = lejosLat
        r.aLon = lejosLon
        assertTrue("A a 110 m", Aproximacion.puedeBajar(r))

        val retirado = RelevoAsignado(7, ALFA, null, 0, 12, 0)
        retirado.anotarOrigen("retirado")
        assertTrue(Aproximacion.puedeBajar(retirado))
        retirado.anotarOrigen("en_linea")
        assertEquals("retirado es para siempre", "retirado", retirado.origen)
        assertTrue(retirado.aRetirado)
    }

    @Test
    fun elRastreadorDeBArrancaConLaEstimacionDeA() {
        val corre = objetivo(500.0, vNorte = 2.0, vistoHaceMs = 1_000)
        val r = Aproximacion.sembrar(corre, 10_000, 12_000)
        val e = r.estimar(12_000)
        assertEquals("la misma velocidad", 2.0, e.vNorteMs, 1e-6)
        assertEquals("visto hace 1 s por A más los 2 s desde que llegó", 3_000L, e.vistoHaceMs)
        assertTrue(e.enMovimiento)
        assertEquals(0, r.detecciones)
        // Lo que A ya extrapoló no se vuelve a sumar: adelanta los 2 s que faltan hasta el tope del rastreador.
        val adelanto = (e.lat - corre.lat) * Geo.METROS_POR_GRADO_LAT
        assertTrue("adelantó como mucho lo que falta del tope ($adelanto m)", adelanto in 3.9..8.1)

        val quieto = Aproximacion.sembrar(objetivo(500.0), 0, 5_000).estimar(5_000)
        assertEquals(objetivo(500.0).lat, quieto.lat, 1e-9)
        assertFalse(quieto.enMovimiento)
        assertTrue(RastreadorDeObjetivo.PREDICCION_MAXIMA_MS > 0)
    }

    @Test
    fun elRelevoAsignadoSaleDeLaOrden() {
        val ruta = PatrolRoute(1, "R", listOf(Waypoint(LAT0, LON0, 40.0), Waypoint(LAT0 + 0.001, LON0, 40.0)))
        val patrulla = RelevoAsignado.de(MensajeDelHub.OrdenDePatrulla(5, ruta, 1, ALFA), 100)
        assertFalse(patrulla.esSeguimiento)
        assertEquals(1, patrulla.fromIndex)
        assertEquals(FaseDelRelevo.CUENTA_REGRESIVA, patrulla.fase)

        val o = objetivo(500.0)
        val seguimiento = RelevoAsignado.de(MensajeDelHub.OrdenDeSeguimiento(7, 12, "VALIDATED", o, ALFA, 99), 100)
        assertTrue(seguimiento.esSeguimiento)
        assertEquals(o, seguimiento.objetivo)
        assertEquals("VALIDATED", seguimiento.decision)
        assertEquals(99L, seguimiento.ultimoTs)
        assertEquals("cuenta_regresiva", FaseDelRelevo.CUENTA_REGRESIVA.texto)
        assertEquals("soltando", FaseDelOrigen.SOLTANDO.texto)
    }

    // ---- El interruptor y la disponibilidad ----

    @Test
    fun elInterruptorVenceALosTreintaMinutos() {
        val e = EsperaParaRelevos()
        assertFalse(e.vencido(0))
        assertTrue(e.prender(1_000))
        assertFalse("ya prendido", e.prender(2_000))
        assertTrue(e.prendido.value)
        assertFalse(e.vencido(1_000 + EsperaParaRelevos.VENCIMIENTO_MS - 1))
        assertTrue(e.vencido(1_000 + EsperaParaRelevos.VENCIMIENTO_MS))
        assertTrue(e.apagar())
        assertFalse("ya apagado", e.apagar())
        assertFalse(e.vencido(1_000 + EsperaParaRelevos.VENCIMIENTO_MS))
    }

    private val base = BaseDelHub(1, "Norte", LAT0, LON0, null, null)

    private val listo = Disponibilidad.Condiciones(
        enEspera = true,
        dron = EstadoDelDron(sdkListo = true, conectado = true, modelo = "Mini", enVuelo = false, satelites = 14, baseFijada = true),
        estado = PatrolState.IDLE,
        controlTomado = false,
        bateriaPorCambiar = false,
        bateriaPct = 80.0,
        lat = LAT0,
        lon = LON0,
        basePropia = base,
    )

    @Test
    fun disponibleEsTodoALaVez() {
        assertNull(Disponibilidad.motivoParaNo(listo))
        assertTrue(Disponibilidad.disponible(listo))
        assertTrue(Disponibilidad.disponible(listo.copy(dron = listo.dron.copy(modoDeVuelo = "P-GPS"))))
        val casos = mapOf(
            "interruptor" to listo.copy(enEspera = false),
            "enlace" to listo.copy(dron = listo.dron.copy(conectado = false)),
            "aire" to listo.copy(dron = listo.dron.copy(enVuelo = true)),
            "reposo" to listo.copy(estado = PatrolState.LANDED),
            "control" to listo.copy(controlTomado = true),
            "listo" to listo.copy(dron = listo.dron.copy(satelites = 3)),
            "modo" to listo.copy(dron = listo.dron.copy(modoDeVuelo = "ATTI")),
            "cambiar" to listo.copy(bateriaPorCambiar = true),
            "dato" to listo.copy(bateriaPct = Double.NaN),
            "%" to listo.copy(bateriaPct = 59.0),
            "su base" to listo.copy(basePropia = null),
            "en su base" to listo.copy(lat = LAT0 + 0.001),
            "relevo" to listo.copy(enUnRelevo = true),
        )
        for ((que, c) in casos) {
            val motivo = Disponibilidad.motivoParaNo(c)
            assertTrue("$que: $motivo", motivo?.contains(que) == true)
        }
    }

    @Test
    fun laDiferenciaDeRumboEsPorElLadoCorto() {
        assertEquals(10.0, diferenciaDeRumbo(355.0, 5.0), 1e-9)
        assertEquals(10.0, diferenciaDeRumbo(5.0, 355.0), 1e-9)
        assertEquals(180.0, diferenciaDeRumbo(0.0, 180.0), 1e-9)
        assertEquals(0.0, diferenciaDeRumbo(720.0, 0.0), 1e-9)
    }
}
