package com.tesis.dronepatrol.drone

import kotlin.math.abs
import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * La cuenta de cada vuelta del lazo de navegación, que el DJI y el simulador
 * comparten: hacia dónde y a qué velocidad, con el frenado al llegar y el
 * control de altura.
 */
class NavegacionTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        val M_POR_GRADO_LON = Geo.metrosPorGradoLon(LAT)
    }

    @Test
    fun `lejos del objetivo va a velocidad de crucero y con el rumbo correcto`() {
        // 500 m al este
        val paso = Navegacion.hacia(LAT, LON, LAT, LON + 500 / M_POR_GRADO_LON)

        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS, hypot(paso.vNorteMs, paso.vEsteMs), 1e-6)
        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS, paso.vEsteMs, 1e-6)
        assertEquals(0.0, paso.vNorteMs, 1e-6)
        assertEquals(90.0, paso.rumboGrados, 0.5)
        assertEquals(500.0, paso.distanciaM, 1.0)
        assertFalse(paso.llego)
    }

    @Test
    fun `hacia el sur el rumbo es 180 y la velocidad norte negativa`() {
        val paso = Navegacion.hacia(LAT, LON, LAT - 200 / Geo.METROS_POR_GRADO_LAT, LON)

        assertEquals(180.0, paso.rumboGrados, 0.5)
        assertTrue(paso.vNorteMs < 0)
        assertEquals(0.0, paso.vEsteMs, 1e-6)
    }

    /** Cerca del punto frena en proporción: a mitad de la distancia de frenado va a la mitad. */
    @Test
    fun `cerca del objetivo frena en proporcion a lo que falta`() {
        val mitad = Navegacion.DISTANCIA_DE_FRENADO_M / 2
        val paso = Navegacion.hacia(LAT, LON, LAT + mitad / Geo.METROS_POR_GRADO_LAT, LON)

        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS / 2, hypot(paso.vNorteMs, paso.vEsteMs), 0.05)
    }

    @Test
    fun `dentro del umbral de llegada manda cero y avisa que llego`() {
        val paso = Navegacion.hacia(LAT, LON, LAT + 2 / Geo.METROS_POR_GRADO_LAT, LON)

        assertTrue(paso.llego)
        assertEquals(0.0, paso.vNorteMs, 0.0)
        assertEquals(0.0, paso.vEsteMs, 0.0)
    }

    /**
     * Frenando en proporción el dron nunca terminaba de llegar: a 5 m se le
     * pedía 1,3 m/s, a 4,5 m algo menos, y con viento en contra quedaba clavado
     * afuera del umbral. Por debajo del paso de llegada no se le pide.
     */
    @Test
    fun `cerca del nodo nunca pide menos que el paso de llegada`() {
        val paso = Navegacion.hacia(LAT, LON, LAT + 5.0 / Geo.METROS_POR_GRADO_LAT, LON)

        assertEquals(Navegacion.VELOCIDAD_MINIMA_DE_APROXIMACION_MS, hypot(paso.vNorteMs, paso.vEsteMs), 1e-6)
        assertFalse(paso.llego)
    }

    /** El frenado arranca a 30 m: a 8 m del nodo ya pide 2 m/s, que el retraso del dron no convierte en pasarse. */
    @Test
    fun `el frenado arranca lejos y a ocho metros ya va despacio`() {
        assertEquals(30.0, Navegacion.DISTANCIA_DE_FRENADO_M, 0.0)
        val paso = Navegacion.hacia(LAT, LON, LAT + 8.0 / Geo.METROS_POR_GRADO_LAT, LON)

        assertEquals(8.0 * 8.0 / 30.0, hypot(paso.vNorteMs, paso.vEsteMs), 1e-6)
    }

    /** Una velocidad pedida por debajo del paso de llegada se respeta: es la que se pidió. */
    @Test
    fun `una velocidad pedida menor que el paso de llegada se respeta`() {
        val paso = Navegacion.hacia(LAT, LON, LAT + 5.0 / Geo.METROS_POR_GRADO_LAT, LON, vMaxMs = 0.5)

        assertEquals(0.5, hypot(paso.vNorteMs, paso.vEsteMs), 1e-6)
    }

    @Test
    fun `respeta la velocidad maxima que se le pide`() {
        val paso = Navegacion.hacia(LAT, LON, LAT + 1.0, LON, vMaxMs = Navegacion.VELOCIDAD_ORBITA_MS)

        assertEquals(Navegacion.VELOCIDAD_ORBITA_MS, hypot(paso.vNorteMs, paso.vEsteMs), 1e-6)
    }

    @Test
    fun `la altura sube con tope, baja con tope y se queda quieta en el umbral`() {
        assertEquals(Navegacion.VELOCIDAD_VERTICAL_MS, Navegacion.vertical(altM = 1.2, objetivoM = 40.0), 0.0)
        assertEquals(-Navegacion.VELOCIDAD_VERTICAL_MS, Navegacion.vertical(altM = 60.0, objetivoM = 40.0), 0.0)
        assertEquals(0.0, Navegacion.vertical(altM = 40.8, objetivoM = 40.0), 0.0)
        assertEquals(0.0, Navegacion.vertical(altM = 39.4, objetivoM = 40.0), 0.0)
        // y en los últimos metros frena en proporción
        assertEquals(1.0, Navegacion.vertical(altM = 36.0, objetivoM = 40.0), 1e-9)
    }

    @Test
    fun `a la altura se decide con la misma tolerancia que el control`() {
        assertTrue(Navegacion.aLaAltura(40.9, 40.0))
        assertFalse(Navegacion.aLaAltura(42.0, 40.0))
    }

    // ---- Llegar a un nodo: por el umbral o pasando de largo ----

    /** Entrar en el umbral de llegada es llegar, como siempre. */
    @Test
    fun llegaAlEntrarEnElUmbral() {
        val llegada = Navegacion.LlegadaAlNodo()
        assertFalse(llegada.llego(20.0))
        assertFalse(llegada.llego(10.0))
        assertTrue(llegada.llego(3.9))
    }

    /**
     * El caso del campo: el dron pasa a 6 m del nodo, sin pisar los 4, y la
     * distancia vuelve a crecer. Es haber pasado de largo y el nodo se da por
     * alcanzado, en vez de dar la vuelta para pisar un punto que quedó atrás.
     */
    @Test
    fun pasarDeLargoCercaDelNodoCuentaComoLlegar() {
        val llegada = Navegacion.LlegadaAlNodo()
        for (d in listOf(20.0, 15.0, 11.0, 8.5, 6.5, 6.0)) assertFalse("a $d m todavía no", llegada.llego(d))
        // Se aleja: 7,5 no supera el margen de 2,5 m sobre los 6; 8,6 y 9,8 sí, dos lecturas seguidas.
        assertFalse(llegada.llego(7.5))
        assertFalse("la primera lectura alejándose no alcanza", llegada.llego(8.6))
        assertTrue("dos lecturas seguidas a más del margen: pasó de largo", llegada.llego(9.8))
    }

    /** El temblor del GPS (medio metro para arriba y para abajo) no es haber pasado. */
    @Test
    fun elTemblorDelGpsNoCuentaComoPasarDeLargo() {
        val llegada = Navegacion.LlegadaAlNodo()
        for (d in listOf(14.0, 11.0, 10.4, 10.9, 10.6, 11.1, 10.2, 10.7)) assertFalse("a $d m", llegada.llego(d))
        assertEquals(10.2, llegada.distanciaMinimaM, 0.0)
    }

    /** Lejos del nodo alejarse no dice nada: es el viento, o el dron que todavía enfila. */
    @Test
    fun alejarseLejosDelNodoNoCuenta() {
        val llegada = Navegacion.LlegadaAlNodo()
        for (d in listOf(50.0, 40.0, 45.0, 52.0, 60.0)) assertFalse("a $d m", llegada.llego(d))
    }

    /** Una lectura suelta del GPS que salta y vuelve no decide nada: hacen falta dos seguidas. */
    @Test
    fun unaLecturaSueltaQueSaltaNoDecide() {
        val llegada = Navegacion.LlegadaAlNodo()
        for (d in listOf(12.0, 9.0, 7.0)) assertFalse(llegada.llego(d))
        assertFalse(llegada.llego(10.5)) // salto de 3,5 m: una sola lectura
        assertFalse(llegada.llego(6.8)) // y vuelve a acercarse: la cuenta arranca de cero
        assertFalse(llegada.llego(6.5))
    }

    /** Al cambiar de nodo la memoria arranca de cero: la mínima del nodo anterior no cuenta para el siguiente. */
    @Test
    fun reiniciarOlvidaElNodoAnterior() {
        val llegada = Navegacion.LlegadaAlNodo()
        for (d in listOf(20.0, 10.0, 6.0)) assertFalse(llegada.llego(d))
        llegada.reiniciar()
        assertEquals(Double.POSITIVE_INFINITY, llegada.distanciaMinimaM, 0.0)
        // Sin el reinicio, 9 y 10 serían dos lecturas alejándose de los 6 m del nodo anterior.
        assertFalse(llegada.llego(9.0))
        assertFalse(llegada.llego(10.0))
        assertFalse(llegada.llego(11.0))
    }

    @Test
    fun unaDistanciaQueNoEsNumeroNoDecideNada() {
        val llegada = Navegacion.LlegadaAlNodo()
        assertFalse(llegada.llego(Double.NaN))
        assertFalse(llegada.llego(Double.POSITIVE_INFINITY))
    }

    // ---- La velocidad de órbita que se puede pedir ----

    @Test
    fun laVelocidadDeOrbitaSeRecortaAlRangoYSinPedidoEsLaDeFabrica() {
        assertEquals(4.0, Navegacion.VELOCIDAD_ORBITA_MS, 0.0)
        assertEquals(Navegacion.VELOCIDAD_ORBITA_MS, Navegacion.velocidadDeOrbita(null), 0.0)
        assertEquals(Navegacion.VELOCIDAD_ORBITA_MS, Navegacion.velocidadDeOrbita(Double.NaN), 0.0)
        assertEquals(3.5, Navegacion.velocidadDeOrbita(3.5), 0.0)
        assertEquals(Navegacion.VELOCIDAD_ORBITA_MINIMA_MS, Navegacion.velocidadDeOrbita(0.2), 0.0)
        assertEquals(Navegacion.VELOCIDAD_ORBITA_MAXIMA_MS, Navegacion.velocidadDeOrbita(50.0), 0.0)
    }

    // ---- Órbita ----

    private val centroLat = -34.6037
    private val centroLon = -58.3816

    private fun alNorteDelCentro(metros: Double) = centroLat + metros / Geo.METROS_POR_GRADO_LAT

    /** Sobre el círculo, al norte del centro: se mueve hacia el este (horario) y mira al sur, al centro. */
    @Test
    fun sobreElCirculoVaTangenteYMiraAlCentro() {
        val paso = Navegacion.orbitar(alNorteDelCentro(30.0), centroLon, centroLat, centroLon, 30.0)
        assertEquals(0.0, paso.vNorteMs, 1e-6)
        assertEquals(Navegacion.VELOCIDAD_ORBITA_MS, paso.vEsteMs, 1e-6)
        assertEquals(180.0, paso.rumboGrados, 1e-6)
        assertEquals(30.0, paso.distanciaM, 0.01)
    }

    /** La velocidad tangencial es la que se pide: la que el operador fijó desde la consola. */
    @Test
    fun sobreElCirculoVaALaVelocidadPedida() {
        val paso = Navegacion.orbitar(alNorteDelCentro(30.0), centroLon, centroLat, centroLon, 30.0, vTangencialMs = 2.0)
        assertEquals(2.0, paso.vEsteMs, 1e-6)
        assertEquals(0.0, paso.vNorteMs, 1e-6)
    }

    /** Un poco adentro del círculo, la corrección lo empuja hacia afuera; un poco afuera, hacia adentro. */
    @Test
    fun cercaDelCirculoCorrigeElRadio() {
        val adentro = Navegacion.orbitar(alNorteDelCentro(25.0), centroLon, centroLat, centroLon, 30.0)
        org.junit.Assert.assertTrue("adentro tiene que salir (al norte)", adentro.vNorteMs > 0)
        val afuera = Navegacion.orbitar(alNorteDelCentro(35.0), centroLon, centroLat, centroLon, 30.0)
        org.junit.Assert.assertTrue("afuera tiene que entrar (al sur)", afuera.vNorteMs < 0)
    }

    /** Lejos del círculo va derecho hacia él, sin girar todavía. */
    @Test
    fun lejosDelCirculoSeAcercaDerecho() {
        val paso = Navegacion.orbitar(alNorteDelCentro(120.0), centroLon, centroLat, centroLon, 30.0)
        org.junit.Assert.assertTrue(paso.vNorteMs < 0)
        assertEquals(0.0, paso.vEsteMs, 1e-6)
        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS, -paso.vNorteMs, 1e-6)
    }

    /** Recorriendo el círculo con estas velocidades, el radio se mantiene. */
    @Test
    fun integrandoLaOrbitaElRadioSeMantiene() {
        var lat = alNorteDelCentro(30.0)
        var lon = centroLon
        repeat(400) { // 40 s a 10 Hz: más de una vuelta
            val paso = Navegacion.orbitar(lat, lon, centroLat, centroLon, 30.0)
            lat += paso.vNorteMs * 0.1 / Geo.METROS_POR_GRADO_LAT
            lon += paso.vEsteMs * 0.1 / Geo.metrosPorGradoLon(centroLat)
            assertEquals(30.0, Geo.distanciaM(centroLat, centroLon, lat, lon), 1.5)
        }
    }

    // ---- El crucero: la rampa, la nariz y la alineación (Navegacion.Crucero) ----

    private fun aMetros(norteM: Double, esteM: Double) =
        (LAT + norteM / Geo.METROS_POR_GRADO_LAT) to (LON + esteM / M_POR_GRADO_LON)

    private fun rapidez(p: Navegacion.Paso) = hypot(p.vNorteMs, p.vEsteMs)

    @Test
    fun deParadoArrancaEnRampaYNoDeGolpe() {
        val crucero = Navegacion.Crucero()
        val (tLat, tLon) = aMetros(500.0, 0.0)
        val paso = crucero.paso(LAT, LON, tLat, tLon, rumboActualGrados = 0.0, dtS = 0.1)
        assertEquals(Navegacion.ACELERACION_MS2 * 0.1, rapidez(paso), 1e-6)
        assertEquals(0.0, paso.rumboGrados, 1e-6)
    }

    @Test
    fun alineadoYLejosLlegaACruceroEnCuatroSegundos() {
        val crucero = Navegacion.Crucero()
        val (tLat, tLon) = aMetros(500.0, 0.0)
        var paso = crucero.paso(LAT, LON, tLat, tLon, 0.0, 0.1)
        repeat(39) { paso = crucero.paso(LAT, LON, tLat, tLon, 0.0, 0.1) }
        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS, paso.vNorteMs, 1e-6)
        assertEquals(0.0, paso.vEsteMs, 1e-6)
    }

    @Test
    fun conLaNarizCruzadaLaNarizGiraDeAPocoYLaVelocidadQuedaEnElMinimo() {
        val crucero = Navegacion.Crucero()
        val (tLat, tLon) = aMetros(0.0, 500.0) // el nodo al este, la nariz al norte
        val primero = crucero.paso(LAT, LON, tLat, tLon, rumboActualGrados = 0.0, dtS = 0.1)
        // A 45°/s, en una vuelta el rumbo pedido se corre 4,5°, no los 90.
        assertEquals(4.5, primero.rumboGrados, 1e-6)
        var paso = primero
        repeat(20) { paso = crucero.paso(LAT, LON, tLat, tLon, 0.0, 0.1) }
        // El rumbo pedido llegó al del nodo y ahí se queda.
        assertEquals(90.0, paso.rumboGrados, 1e-6)
        // Con la nariz real todavía al norte, hacia el nodo se va al mínimo: no se sale de costado a 8 m/s.
        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS * Navegacion.VELOCIDAD_DESALINEADA, rapidez(paso), 1e-6)
        assertTrue(paso.vEsteMs > 0 && abs(paso.vNorteMs) < 1e-9)
    }

    @Test
    fun cuandoLaNarizSeAlineaAcelera() {
        val crucero = Navegacion.Crucero()
        val (tLat, tLon) = aMetros(0.0, 500.0)
        repeat(10) { crucero.paso(LAT, LON, tLat, tLon, 0.0, 0.1) }
        // La brújula ya dice 90: la velocidad pedida pasa a crucero, en rampa.
        var paso = crucero.paso(LAT, LON, tLat, tLon, 90.0, 0.1)
        val antes = rapidez(paso)
        repeat(10) { paso = crucero.paso(LAT, LON, tLat, tLon, 90.0, 0.1) }
        assertEquals(antes + 10 * Navegacion.ACELERACION_MS2 * 0.1, rapidez(paso), 1e-6)
        assertTrue(rapidez(paso) < Navegacion.VELOCIDAD_CRUCERO_MS)
    }

    @Test
    fun cercaDelNodoLaNarizNoTiemblaConElGps() {
        val crucero = Navegacion.Crucero()
        // A 6 m al sur del nodo con la nariz al norte; el GPS lo corre 1,5 m al este.
        val (tLat, tLon) = aMetros(6.0, 0.0)
        val recto = crucero.paso(LAT, LON, tLat, tLon, 0.0, 0.1)
        val (lat2, lon2) = aMetros(0.0, 1.5)
        val corrido = crucero.paso(lat2, lon2, tLat, tLon, 0.0, 0.1)
        assertEquals(0.0, recto.rumboGrados, 1e-9)
        assertEquals(recto.rumboGrados, corrido.rumboGrados, 1e-9)
        assertTrue(corrido.vNorteMs > 0)
    }

    @Test
    fun alCambiarDeNodoLaVelocidadNoPegaElVolantazo() {
        val crucero = Navegacion.Crucero()
        val (norteLat, norteLon) = aMetros(500.0, 0.0)
        repeat(40) { crucero.paso(LAT, LON, norteLat, norteLon, 0.0, 0.1) } // a crucero hacia el norte
        // El nodo siguiente está al este: la velocidad hacia el norte se deshace de a poco.
        val (esteLat, esteLon) = aMetros(0.0, 500.0)
        val paso = crucero.paso(LAT, LON, esteLat, esteLon, 0.0, 0.1)
        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS - Navegacion.ACELERACION_MS2 * 0.1, paso.vNorteMs, 0.05)
        assertTrue(paso.vEsteMs >= 0.0 && paso.vEsteMs < 0.2)
    }

    @Test
    fun laDiferenciaDeRumboSePliegaYLaAlineacionBajaDeUnoAlMinimo() {
        assertEquals(-20.0, Navegacion.diferenciaDeRumbo(350.0, 10.0), 1e-9)
        assertEquals(20.0, Navegacion.diferenciaDeRumbo(10.0, 350.0), 1e-9)
        assertEquals(-180.0, Navegacion.diferenciaDeRumbo(180.0, 0.0), 1e-9)
        assertEquals(1.0, Navegacion.alineacion(10.0), 1e-9)
        assertEquals(1.0, Navegacion.alineacion(-15.0), 1e-9)
        assertEquals(Navegacion.VELOCIDAD_DESALINEADA, Navegacion.alineacion(90.0), 1e-9)
        assertEquals(Navegacion.VELOCIDAD_DESALINEADA, Navegacion.alineacion(-170.0), 1e-9)
        assertEquals((1.0 + Navegacion.VELOCIDAD_DESALINEADA) / 2, Navegacion.alineacion(52.5), 1e-9)
    }

    @Test
    fun sinBrujulaLaNarizArrancaEnElRumboAlNodoYUnDtRaroSeRecorta() {
        val crucero = Navegacion.Crucero()
        val (tLat, tLon) = aMetros(0.0, 500.0)
        val paso = crucero.paso(LAT, LON, tLat, tLon, rumboActualGrados = Double.NaN, dtS = 5.0)
        assertEquals(90.0, paso.rumboGrados, 1e-6)
        // Un dt de 5 s se recorta a medio segundo: la rampa sube 1 m/s, no 10.
        assertEquals(Navegacion.ACELERACION_MS2 * Navegacion.DT_MAXIMO_S, rapidez(paso), 1e-6)
    }

    @Test
    fun quietoReiniciaLaRampa() {
        val crucero = Navegacion.Crucero()
        val (tLat, tLon) = aMetros(500.0, 0.0)
        repeat(40) { crucero.paso(LAT, LON, tLat, tLon, 0.0, 0.1) }
        crucero.quieto()
        assertEquals(0.0, crucero.velocidadMs, 1e-9)
        val paso = crucero.paso(LAT, LON, tLat, tLon, 0.0, 0.1)
        assertEquals(Navegacion.ACELERACION_MS2 * 0.1, rapidez(paso), 1e-6)
    }
}
