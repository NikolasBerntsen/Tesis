package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.emergencyAck
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.emergencyPhotoAck
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.punto
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
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
 * El protocolo de última ubicación (docs/RELEVOS.md §5) en la máquina de
 * estados: el disparo fuera de base, la secuencia de fotos con su tope de
 * tiempo y su regla de batería, la variante que solo usa la cámara cuando el
 * DJI forzó el aterrizaje, la cola persistente de los mensajes con sus acuses y
 * la última posición fija en la pantalla.
 *
 * El dron está a 1500 m al norte de su base, a 600 m de la otra: fuera de base.
 * El DJI dice que aterrizar le cuesta 2 % y su crítico es 10 %: el disparo es
 * max(2 + 5, 10 + 3) = 13 %.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerUltimaUbicacionTest {

    private val almacen = AlmacenEnMemoria()
    private val banco = BancoDeRelevos(almacen)
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private suspend fun telemetria(norteM: Double = 1_500.0, bateria: Double) =
        banco.telemetria(norteM = norteM, bateria = bateria, pctParaVolver = 20.0, pctParaAterrizar = 2.0)

    /** [confirma] es la cámara; el giro (el mando virtual) se confirma salvo que [gira] diga que no. */
    private suspend fun patrullandoLejos(confirma: Boolean = true, gira: Boolean = true) {
        dron.estado.value = dron.estado.value.copy(umbralCriticoPct = 10.0)
        dron.confirmarCamara = confirma
        dron.confirmarRumbo = gira
        banco.arrancar()
        banco.hub(BancoDeRelevos.basesDeSiempre())
        telemetria(bateria = 60.0)
        patrulla.startPatrol(RUTA)
        esperarA("el patrullaje") { patrulla.state.value == PatrolState.PATROLLING }
    }

    /** La batería cae al disparo lejos de toda base: empieza el protocolo. */
    private suspend fun enEmergencia(bateria: Double = 12.0, confirma: Boolean = true) {
        patrullandoLejos(confirma, gira = confirma)
        telemetria(bateria = bateria)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
    }

    private fun ref(): String = banco.ultimo("emergency_landing").getString("ref")

    @Test
    fun fueraDeBaseEnElDisparoAvisaFotografiaYAterriza() = runBlocking {
        enEmergencia()
        val diverted = banco.ultimo("rth_diverted")
        assertEquals("emergencia", diverted.getString("motivo"))
        assertTrue("con emergencia la base va null", diverted.isNull("baseId"))

        esperarA("el emergency_landing") { banco.mensajes("emergency_landing").isNotEmpty() }
        val aviso = banco.ultimo("emergency_landing")
        assertEquals("autonomia", aviso.getString("motivo"))
        assertEquals(punto(1_500.0).first, aviso.getDouble("lat"), 1e-9)
        assertEquals(40.0, aviso.getDouble("alt"), 1e-9)
        assertEquals(12.0, aviso.getDouble("bateria"), 1e-9)
        assertTrue(aviso.getLong("ts") > 0)
        val fijada = patrulla.ultimaUbicacion.value
        assertNotNull("la posición queda fija en la pantalla", fijada)
        assertFalse(fijada!!.aterrizado)
        esperarA("el aviso de la emergencia") {
            banco.comando.eventos("LANDING").any { it.getString("message").contains("emergencia") }
        }

        esperarA("el aterrizaje al final de la secuencia") { "land" in dron.ordenes }
        val secuencia = dron.ordenes.dropWhile { it != "hold" }.filter { it != "capturarFoto" }
        assertEquals(
            listOf(
                "hold", "failsafeAterrizar(true)",
                "apuntar(-70.0)", "apuntar(-90.0)",
                "apuntar(-30.0)", "girar(0.0)", "apuntar(-30.0)", "girar(90.0)",
                "apuntar(-30.0)", "girar(180.0)", "apuntar(-30.0)", "girar(270.0)",
                "land",
            ),
            secuencia,
        )
        assertEquals("una foto por paso", 6, dron.ordenes.count { it == "capturarFoto" })
        assertTrue("antes del acuse no sale ninguna foto", banco.mensajes("emergency_photo").isEmpty())
    }

    @Test
    fun laColaMandaLasFotosEnOrdenConSusAcusesYElAterrizajeAntes() = runBlocking {
        enEmergencia()
        esperarA("el aterrizaje al final de la secuencia") { "land" in dron.ordenes }
        val ref = ref()
        banco.hub(emergencyAck(ref, 3, aterrizada = false))
        esperarA("la primera foto") { banco.mensajes("emergency_photo").isNotEmpty() }
        val primera = banco.ultimo("emergency_photo")
        assertEquals(0, primera.getInt("seq"))
        assertEquals("oblicua", primera.getString("tipo"))
        assertTrue(primera.getString("jpegBase64").startsWith("/9j/"))
        delay(300)
        assertEquals("de a una: la siguiente con el acuse", 1, banco.mensajes("emergency_photo").size)

        banco.hub(emergencyPhotoAck(ref, 0))
        esperarA("la segunda") { banco.mensajes("emergency_photo").size == 2 }
        assertEquals("cenital", banco.ultimo("emergency_photo").getString("tipo"))
        assertEquals(-90.0, banco.ultimo("emergency_photo").getDouble("inclinacion"), 1e-9)

        // Toca tierra con fotos pendientes: la última posición sale primero.
        telemetria(norteM = 1_500.5, bateria = 11.0)
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.Aterrizado)
        esperarA("el emergency_landed") { banco.mensajes("emergency_landed").isNotEmpty() }
        assertEquals(punto(1_500.5).first, banco.ultimo("emergency_landed").getDouble("lat"), 1e-9)
        esperarA("el aviso de dónde quedó") {
            banco.comando.eventos("LANDED").any { it.getString("message").contains("buscarlo") }
        }
        assertTrue(patrulla.ultimaUbicacion.value!!.aterrizado)
        assertEquals(PatrolState.LANDED, patrulla.state.value)

        banco.hub(emergencyPhotoAck(ref, 1))
        delay(200)
        assertEquals("la foto 2 espera al acuse del aterrizaje", 2, banco.mensajes("emergency_photo").size)
        banco.hub(emergencyAck(ref, 3, aterrizada = true))
        esperarA("la tercera") { banco.mensajes("emergency_photo").size == 3 }
        assertEquals(2, banco.ultimo("emergency_photo").getInt("seq"))
        assertEquals("panoramica", banco.ultimo("emergency_photo").getString("tipo"))

        // Sin acuse se reintenta, con espera creciente.
        banco.pasar(ColaDeEmergencia.REINTENTO_MINIMO_MS)
        esperarA("el reintento") { banco.mensajes("emergency_photo").size == 4 }
        assertEquals(2, banco.ultimo("emergency_photo").getInt("seq"))
    }

    @Test
    fun sinElComandoCentralLaColaEsperaYSaleAlReconectar() = runBlocking {
        patrullandoLejos()
        banco.comando.connected.value = false
        delay(100)
        telemetria(bateria = 12.0)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        delay(200)
        assertTrue(banco.mensajes("emergency_landing").isEmpty())
        banco.comando.connected.value = true
        esperarA("el emergency_landing al reconectar") { banco.mensajes("emergency_landing").isNotEmpty() }
    }

    @Test
    fun laColaSobreviveAUnReinicioDeLaApp() = runBlocking {
        enEmergencia()
        esperarA("el aterrizaje al final de la secuencia") { "land" in dron.ordenes }
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.evento(FlightEvent.Aterrizado)
        esperarA("el aterrizaje") { patrulla.state.value == PatrolState.LANDED }
        assertTrue("sin el acuse del aviso no sale nada más de esa emergencia", banco.mensajes("emergency_landed").isEmpty())
        val ref = ref()
        banco.desarmar()

        val otra = BancoDeRelevos(almacen)
        try {
            val fijada = otra.patrulla.ultimaUbicacion.value
            assertNotNull("la última posición vuelve a la pantalla", fijada)
            assertTrue(fijada!!.aterrizado)
            otra.arrancar()
            esperarA("lo pendiente, de nuevo") { otra.mensajes("emergency_landing").isNotEmpty() }
            assertEquals("con el mismo ref", ref, otra.ultimo("emergency_landing").getString("ref"))
            otra.hub(emergencyAck(ref, 3, aterrizada = false))
            esperarA("el aterrizaje antes que las fotos") { otra.mensajes("emergency_landed").isNotEmpty() }
            assertTrue(otra.mensajes("emergency_photo").isEmpty())
        } finally {
            otra.desarmar()
        }
    }

    @Test
    fun cadaPasoSoloSiDespuesQuedaBateriaSiNoAterrizaEnseguida() = runBlocking {
        // 10,2 % menos lo que cuesta un paso queda debajo de 13 − 3: ninguna foto.
        enEmergencia(bateria = 10.2)
        esperarA("el aterrizaje") { "land" in dron.ordenes }
        assertEquals(listOf("hold", "failsafeAterrizar(true)", "land"), dron.ordenes.dropWhile { it != "hold" })
    }

    @Test
    fun conElTopeDeVeinteSegundosAterrizaConLasFotosQueHaya() = runBlocking {
        // El dron gira, pero el gimbal no confirma nada que no sea la inclinación
        // de patrulla: cada paso espera su tope.
        val inicio = banco.reloj.ms
        patrullandoLejos(confirma = false, gira = true)
        telemetria(bateria = 12.0)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        esperarA("el aterrizaje", topeMs = 10_000) { "land" in dron.ordenes }
        assertEquals("solo la oblicua se confirmó", 1, dron.ordenes.count { it == "capturarFoto" })
        val duro = banco.reloj.ms - inicio
        assertTrue("aterriza al tope duro de 20 s (duró $duro ms)", duro in 19_000L..SecuenciaDeUltimaUbicacion.TOPE_MS + 200)
    }

    @Test
    fun unaPersonaQueTomaElControlCortaLaSecuencia() = runBlocking {
        enEmergencia(confirma = false)
        esperarA("la cenital, que no se confirma") { "apuntar(-90.0)" in dron.ordenes }
        banco.comando.recibir(JSONObject().put("type", "control_taken").put("by", "op"))
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        delay(500)
        assertFalse("ni una orden más de la secuencia", "land" in dron.ordenes)
        assertFalse("apuntar(-30.0)" in dron.ordenes)
        assertEquals("hold", dron.ordenes.last { it == "hold" || it.startsWith("apuntar") || it == "land" })
    }

    @Test
    fun unaFotoQueNoEsUnJpegNoSale() = runBlocking {
        dron.foto = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)
        enEmergencia()
        esperarA("el aterrizaje al final de la secuencia") { "land" in dron.ordenes }
        banco.hub(emergencyAck(ref(), 3, aterrizada = false))
        delay(300)
        assertTrue("no hay foto que mandar", banco.mensajes("emergency_photo").isEmpty())
        assertEquals(6, dron.ordenes.count { it == "capturarFoto" })
    }

    @Test
    fun enUnaBaseNoSeDispara() = runBlocking {
        patrullandoLejos()
        telemetria(norteM = 30.0, bateria = 12.0)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        delay(200)
        assertTrue(banco.mensajes("emergency_landing").isEmpty())
    }

    @Test
    fun siElDjiFuerzaElAterrizajeFueraDeBaseSoloUsaLaCamara() = runBlocking {
        patrullandoLejos()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA))
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        esperarA("el emergency_landing") { banco.mensajes("emergency_landing").isNotEmpty() }
        assertEquals("bateria_critica_dji", banco.ultimo("emergency_landing").getString("motivo"))
        esperarA("las dos fotos") { dron.ordenes.count { it == "capturarFoto" } == 2 }
        val desde = dron.ordenes.indexOf("apuntar(-90.0)")
        assertEquals(listOf("apuntar(-90.0)", "capturarFoto", "apuntar(-30.0)", "capturarFoto"), dron.ordenes.drop(desde))
        delay(200)
        assertFalse("ni una orden de vuelo: el DJI está bajando", dron.ordenes.drop(desde).any { it == "hold" || it == "land" || it.startsWith("girar") })
    }

    @Test
    fun siElDjiFuerzaElAterrizajeEnUnaBaseNoHayEmergencia() = runBlocking {
        patrullandoLejos()
        telemetria(norteM = 905.0, bateria = 60.0)
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA))
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        assertTrue(banco.mensajes("emergency_landing").isEmpty())
    }

    @Test
    fun siElDjiTomaElVueloEnMedioDeLaSecuenciaSigueSoloConLaCamara() = runBlocking {
        enEmergencia(confirma = false)
        esperarA("la cenital, que no se confirma") { "apuntar(-90.0)" in dron.ordenes }
        val antes = dron.ordenes.size
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA))
        esperarA("la variante de la cámara") { dron.ordenes.drop(antes).count { it == "apuntar(-30.0)" } == 1 }
        delay(500)
        assertFalse("land" in dron.ordenes)
        assertEquals(
            "sigue siendo la misma emergencia (el aviso se reintenta, siempre con el mismo ref)",
            1,
            banco.mensajes("emergency_landing").map { it.getString("ref") }.toSet().size,
        )
    }

    /**
     * El DJI toma el vuelo con la secuencia por la mitad (mismo `ref`): las
     * fotos ya sacadas con control (la oblicua y la cenital) y las de la
     * variante de la cámara llegan TODAS al Comando Central, con números
     * distintos. Con los mismos números, la cola descartaba las nuevas y el hub
     * acusaba sin guardar: justo la cenital del lugar donde baja.
     */
    @Test
    fun siElDjiTomaElVueloConFotosYaSacadasNingunaSePierde() = runBlocking {
        val frenada = CompletableDeferred<Unit>()
        // La tercera foto (la primera de la panorámica) queda frenada hasta que el DJI toma el vuelo.
        dron.alCapturar = { n -> if (n == 3) frenada.await() }
        enEmergencia()
        esperarA("la tercera foto, frenada") { dron.ordenes.count { it == "capturarFoto" } == 3 }
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA))
        esperarA("las dos de la variante de la cámara") { dron.ordenes.count { it == "capturarFoto" } == 5 }
        // La secuencia de antes ya se canceló: soltarla no saca la foto frenada ni aterriza.
        frenada.complete(Unit)
        delay(200)
        assertFalse("land" in dron.ordenes)
        assertEquals(5, dron.ordenes.count { it == "capturarFoto" })

        val ref = ref()
        banco.hub(emergencyAck(ref, 3, aterrizada = false))
        val enviadas = mutableListOf<JSONObject>()
        repeat(4) { i ->
            esperarA("la foto ${i + 1}") { banco.mensajes("emergency_photo").size == i + 1 }
            val foto = banco.ultimo("emergency_photo")
            enviadas += foto
            banco.hub(emergencyPhotoAck(ref, foto.getInt("seq")))
        }
        assertEquals(listOf(0, 1, 6, 7), enviadas.map { it.getInt("seq") })
        assertEquals(listOf("oblicua", "cenital", "cenital", "panoramica"), enviadas.map { it.getString("tipo") })
        assertEquals("todas de la misma emergencia", setOf(ref), enviadas.map { it.getString("ref") }.toSet())
        assertEquals(-90.0, enviadas[2].getDouble("inclinacion"), 1e-9)
        banco.pasar(ColaDeEmergencia.REINTENTO_MAXIMO_MS)
        assertEquals("ninguna quedó pendiente", 4, banco.mensajes("emergency_photo").size)
    }

    @Test
    fun conElDjiVolviendoPorBateriaElDisparoUsaElUnicoCorte() = runBlocking {
        patrullandoLejos()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        esperarA("el regreso del DJI") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        telemetria(bateria = 12.0)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        assertEquals(1, dron.ordenes.count { it == "cancelarRegreso" })
    }

    @Test
    fun conElUnicoCorteYaUsadoSeLoDejaSeguir() = runBlocking {
        patrullandoLejos()
        // El DJI arranca su regreso, la app se lo corta para un desvío y lo vuelve a arrancar.
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        telemetria(bateria = 21.0)
        banco.reloj.adelantar(Autonomia.CONFIRMAR_NO_LLEGA_MS)
        telemetria(bateria = 21.0)
        esperarA("el desvío") { banco.mensajes("rth_diverted").isNotEmpty() }
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        val antes = dron.ordenes.size
        telemetria(norteM = 1_400.0, bateria = 12.0)
        delay(200)
        assertEquals("ni el §5: el vuelo es del DJI", antes, dron.ordenes.size)
        assertTrue(banco.mensajes("emergency_landing").isEmpty())
    }

    // ---- El regreso que pidió la app, cuando dispara el §5 (RELEVOS §4 y §5) ----

    /** Volviendo a su base con el regreso que pidió la app (24 %: llega), y la batería cae al disparo. */
    private suspend fun volviendoConElRegresoDeLaApp(confirma: Boolean = true) {
        patrullandoLejos(confirma, gira = confirma)
        telemetria(bateria = 24.0)
        esperarA("el regreso a su base") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        assertEquals("returnHome", dron.ultimaOrden)
        telemetria(bateria = 12.0)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
    }

    /**
     * Con un GoHome en curso el DJI no acepta el mando virtual: el vuelo
     * estacionario y los giros del §5 se ignorarían mientras sigue volando
     * hacia una casa que no alcanza. El regreso se corta ANTES de quedarse
     * quieto.
     */
    @Test
    fun enElRegresoQuePidioLaAppElDisparoLoCortaAntesDeQuedarQuieto() = runBlocking {
        volviendoConElRegresoDeLaApp()
        esperarA("el vuelo estacionario") { "hold" in dron.ordenes }
        val ordenes = dron.ordenes
        val corte = ordenes.indexOf("cancelarRegreso")
        assertTrue(
            "returnHome, después cancelarRegreso y recién ahí hold: $ordenes",
            corte > ordenes.indexOf("returnHome") && corte < ordenes.indexOf("hold"),
        )
        assertEquals("un solo corte", 1, ordenes.count { it == "cancelarRegreso" })
        esperarA("la secuencia entera") { "land" in dron.ordenes }
    }

    @Test
    fun enUnDesvioElDisparoNoVuelveACortarElRegreso() = runBlocking {
        patrullandoLejos()
        telemetria(bateria = 21.0)
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        banco.reloj.adelantar(Autonomia.CONFIRMAR_NO_LLEGA_MS)
        telemetria(bateria = 21.0)
        esperarA("el desvío") { banco.mensajes("rth_diverted").isNotEmpty() }
        assertEquals("el desvío ya lo cortó", 1, dron.ordenes.count { it == "cancelarRegreso" })
        telemetria(norteM = 1_200.0, bateria = 12.0)
        esperarA("el protocolo") { patrulla.state.value == PatrolState.ATERRIZAJE_EMERGENCIA }
        esperarA("el vuelo estacionario") { "hold" in dron.ordenes }
        assertEquals(1, dron.ordenes.count { it == "cancelarRegreso" })
    }

    /**
     * Si el controlador no logra cortar el regreso, el dron sigue volviendo y
     * no se le pelea: la secuencia sigue solo con la cámara, sin una orden de
     * vuelo más (ni giros ni aterrizar).
     */
    @Test
    fun siNoSeCortaElRegresoLaSecuenciaSigueSoloConLaCamara() = runBlocking {
        volviendoConElRegresoDeLaApp(confirma = false)
        esperarA("la cenital, que no se confirma") { "apuntar(-90.0)" in dron.ordenes }
        val antes = dron.ordenes.size
        banco.evento(FlightEvent.Problema("${DroneController.NO_SE_CORTO_EL_REGRESO}: el dron no volvió a IDLE en 3 s"))
        esperarA("la variante de la cámara") { dron.ordenes.drop(antes).count { it == "apuntar(-30.0)" } == 1 }
        delay(500)
        val despues = dron.ordenes.drop(antes)
        assertFalse("land" in dron.ordenes)
        assertFalse("ni una orden de vuelo: $despues", despues.any { it == "hold" || it.startsWith("girar") })
        assertEquals(PatrolState.ATERRIZAJE_EMERGENCIA, patrulla.state.value)
        assertEquals("la misma emergencia", 1, banco.mensajes("emergency_landing").map { it.getString("ref") }.toSet().size)
    }
}
