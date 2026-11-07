package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import com.tesis.dronepatrol.model.PatrolState
import com.tesis.dronepatrol.patrol.BancoDeRelevos.Companion.RUTA
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Tomar el control manual desde la consola en cada estado del dron
 * (docs/PROTOCOLS.md §2, `control_taken`). La regla es que la persona manda
 * (RELEVOS §3.9), y tomarlo tiene que ser tomarlo del todo: en los regresos a
 * base el estado decía MANUAL pero el dron seguía con su GoHome (el DJI no
 * acepta el mando virtual con el regreso puesto) y las palancas no hacían
 * nada; y en el regreso por batería la telemetría siguiente volvía a ordenar
 * el regreso medio segundo después. Ahora la toma corta el regreso y, mientras
 * la persona lo tenga, la batería no se lo vuelve a sacar; al soltarlo, sí.
 *
 * Las únicas tomas que no se hacen son las del propio DJI que la app no le
 * discute (RELEVOS §4): el regreso pedido desde el botón del control físico,
 * el aterrizaje por batería crítica y su regreso por batería cuando el único
 * corte del vuelo ya se gastó. Ahí la app lo dice: `control_dropped` al hub,
 * que suelta el lock, y el motivo al registro.
 *
 * El dron es el espía que anota cada orden: lo que se mira es qué le quedó
 * ordenado, el estado y lo que la app le contesta al hub.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PatrolManagerTomaDelControlTest {

    private val banco = BancoDeRelevos()
    private val dron = banco.dron
    private val patrulla = banco.patrulla

    @After
    fun desarmar() = banco.desarmar()

    private fun consola(json: String) = banco.comando.manejarMensaje(json)

    private fun tomarElControl(by: String = "op") = consola("""{"type":"control_taken","by":"$by"}""")

    private fun soltarElControl(by: String = "op") = consola("""{"type":"control_released","by":"$by"}""")

    private fun palanca(pitch: Double) =
        consola("""{"type":"manual_stick","pitch":$pitch,"roll":0.0,"yaw":0.0,"throttle":0.0,"by":"op"}""")

    private fun desde(i: Int): List<String> = dron.ordenes.drop(i)

    private fun soltados(): List<JSONObject> = banco.mensajes("control_dropped")

    private fun problemas(): List<String> = banco.comando.eventos("DRONE_PROBLEM").map { it.getString("message") }

    private fun regresosPorBateria(): Int = banco.comando.eventos("RTH_LOW_BATTERY").size

    private suspend fun patrullando() {
        banco.arrancar()
        banco.telemetria(norteM = 100.0)
        patrulla.availableRoutes = listOf(RUTA)
        consola("""{"type":"start_route","routeId":${RUTA.id},"fromIndex":0,"orderedBy":"op"}""")
        esperarA("la ruta") { patrulla.state.value == PatrolState.PATROLLING }
    }

    /** Patrullando, la batería cae al 20 % y la app manda al dron a casa. */
    private suspend fun volviendoPorBateria() {
        patrullando()
        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
    }

    // ---- Donde el control se toma del todo ----

    @Test
    fun patrullandoSeTomaConElEstacionarioAntesDeAbrirElMando() = runBlocking {
        patrullando()
        val i = dron.ordenes.size

        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        palanca(1.0)
        delay(100)

        assertEquals(listOf("hold", "stick(1.0, 0.0, 0.0, 0.0)"), desde(i))
        assertTrue("no tenía nada que soltar", soltados().isEmpty())
    }

    /**
     * El regreso que pidió una persona (el operador de campo, o el fin de un
     * relevo) es un GoHome del propio dron: con él puesto el DJI rechaza el
     * mando virtual, así que la toma lo corta antes del estacionario. Antes el
     * estado pasaba a MANUAL y el dron seguía volviendo con las palancas mudas.
     */
    @Test
    fun volviendoPorOrdenDeUnaPersonaLaTomaCortaElRegreso() = runBlocking {
        patrullando()
        patrulla.volverABase()
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        val i = dron.ordenes.size

        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        palanca(1.0)
        delay(100)

        assertEquals(listOf("cancelarRegreso", "hold", "stick(1.0, 0.0, 0.0, 0.0)"), desde(i))
        assertTrue(soltados().isEmpty())
    }

    /**
     * El caso que se veía en el campo: la batería al 20 % manda al dron a casa,
     * el operador toma el control y la telemetría siguiente —la batería sigue
     * baja— lo devolvía al regreso medio segundo después: la consola veía
     * "control manual" un instante y el dron no le hacía caso. Ahora la toma
     * corta el regreso y, mientras la persona lo tenga, el dron es suyo.
     */
    @Test
    fun volviendoPorBateriaLaTomaCortaElRegresoYLaBateriaNoSeLoVuelveASacar() = runBlocking {
        volviendoPorBateria()
        assertEquals(1, regresosPorBateria())
        val i = dron.ordenes.size

        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        assertEquals(listOf("cancelarRegreso", "hold"), desde(i))

        // Sigue llegando telemetría con la batería baja: el dron sigue siendo de la persona.
        banco.telemetria(norteM = 100.0, bateria = 19.0)
        banco.telemetria(norteM = 100.0, bateria = 19.0)
        palanca(1.0)
        delay(200)

        assertEquals(PatrolState.MANUAL, patrulla.state.value)
        assertEquals(listOf("cancelarRegreso", "hold", "stick(1.0, 0.0, 0.0, 0.0)"), desde(i))
        assertEquals("un solo regreso por batería", 1, regresosPorBateria())
        assertTrue(soltados().isEmpty())
    }

    /** Al soltar el control con la batería todavía baja, el regreso a tiempo vuelve a mandar. */
    @Test
    fun alSoltarElControlConLaBateriaBajaElRegresoRetoma() = runBlocking {
        volviendoPorBateria()
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }

        soltarElControl()
        esperarA("la salida del control") { patrulla.state.value == PatrolState.PAUSED }
        banco.telemetria(norteM = 100.0, bateria = 19.0)
        esperarA("el regreso de nuevo") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }

        assertEquals(2, regresosPorBateria())
        assertEquals("returnHome", dron.ultimaOrden)
    }

    /** La batería que baja del umbral por primera vez con el control tomado sigue mandando al dron a casa. */
    @Test
    fun laBateriaQueBajaEnManualSigueMandandoAlDronACasa() = runBlocking {
        patrullando()
        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }

        banco.telemetria(norteM = 100.0, bateria = 20.0)
        esperarA("el regreso por batería") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }

        assertEquals("returnHome", dron.ultimaOrden)
    }

    /**
     * El regreso por batería del propio DJI: la persona que toma el control se
     * lo corta con el único corte que hay por vuelo (RELEVOS §4), y el dron es
     * suyo. Si el DJI lo vuelve a arrancar, ya no se le discute: la toma se
     * rechaza y el hub suelta el lock.
     */
    @Test
    fun conSuRegresoPorBateriaLaTomaUsaElUnicoCorteYLaSegundaVezSeRechaza() = runBlocking {
        patrullando()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        esperarA("el regreso del DJI") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        val i = dron.ordenes.size

        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }
        assertEquals(listOf("cancelarRegreso", "hold"), desde(i))
        assertTrue(soltados().isEmpty())

        soltarElControl()
        esperarA("la salida del control") { patrulla.state.value == PatrolState.PAUSED }
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_BATERIA))
        esperarA("el regreso del DJI otra vez") { patrulla.state.value == PatrolState.RETURNING_HOME_BATTERY }
        val j = dron.ordenes.size

        tomarElControl()
        esperarA("el aviso al hub") { soltados().isNotEmpty() }
        palanca(1.0)
        delay(200)

        assertEquals(PatrolState.RETURNING_HOME_BATTERY, patrulla.state.value)
        assertEquals("ni corte ni estacionario ni palanca: ${desde(j)}", emptyList<String>(), desde(j))
        assertTrue(soltados().single().getString("motivo").contains("ya se gastó"))
    }

    /** El dron volviendo solo sin que se sepa por qué (OTRO) no bloquea: la persona que toma el control lo recupera. */
    @Test
    fun conElDronVolviendoPorUnMotivoDesconocidoLaPersonaLoRecupera() = runBlocking {
        patrullando()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.OTRO))
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }

        tomarElControl()
        esperarA("el control manual") { patrulla.state.value == PatrolState.MANUAL }

        assertEquals("hold", dron.ultimaOrden)
        assertTrue(soltados().isEmpty())
    }

    /**
     * Con la señal del dron perdida no hay a quién darle el estacionario: el
     * control queda tomado y se aplica al volver la señal (CONTROL_RESUMED),
     * como cuando se pierde la señal ya en MANUAL. Pasar a MANUAL ahí dejaba
     * al vigía sin su "señal recuperada".
     */
    @Test
    fun conLaSenialPerdidaElControlQuedaTomadoYSeAplicaAlVolver() = runBlocking {
        patrullando()
        banco.relojDeLaSenial.adelantar(PatrolManager.SIGNAL_TIMEOUT_MS + 1_000)
        esperarA("la señal perdida") { patrulla.state.value == PatrolState.RETURNING_HOME_SIGNAL }
        val i = dron.ordenes.size

        tomarElControl()
        delay(200)
        assertEquals("sin señal no se le ordena nada", emptyList<String>(), desde(i))
        assertEquals(PatrolState.RETURNING_HOME_SIGNAL, patrulla.state.value)

        banco.telemetria(norteM = 100.0)
        esperarA("el control manual al volver la señal") { patrulla.state.value == PatrolState.MANUAL }
        assertTrue(banco.comando.eventos("SIGNAL_RECOVERED").isNotEmpty())
        assertTrue(banco.comando.eventos("CONTROL_RESUMED").isNotEmpty())
        assertTrue(soltados().isEmpty())
    }

    // ---- Las tomas del DJI que no se discuten: el control NO se toma, y se dice ----

    /** El botón de regreso del control físico es una persona pidiendo el dron de vuelta: la consola no se lo saca. */
    @Test
    fun conElRegresoPedidoDesdeElControlFisicoNoSeTomaYSeAvisaAlHub() = runBlocking {
        patrullando()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_DEL_CONTROL))
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        val i = dron.ordenes.size

        tomarElControl("op")
        esperarA("el aviso al hub") { soltados().isNotEmpty() }
        palanca(1.0)
        delay(200)

        assertEquals(PatrolState.RETURNING_HOME, patrulla.state.value)
        assertEquals("ni estacionario ni palanca: ${desde(i)}", emptyList<String>(), desde(i))
        val aviso = soltados().single()
        assertEquals("op", aviso.getString("by"))
        assertTrue(aviso.getString("motivo"), aviso.getString("motivo").contains("control físico"))
        assertTrue(problemas().toString(), problemas().any { it.startsWith("No se toma el control manual que pidió op") })
    }

    /**
     * El aterrizaje forzado por batería crítica es del DJI hasta el suelo. Lejos
     * de una base corre el §5 solo con la cámara (fotos y giros del gimbal),
     * así que lo que no puede aparecer es el estacionario ni la palanca.
     */
    @Test
    fun conSuAterrizajePorBateriaCriticaNoSeToma() = runBlocking {
        patrullando()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA))
        esperarA("el aterrizaje del DJI") { patrulla.state.value != PatrolState.PATROLLING }
        val estado = patrulla.state.value
        val i = dron.ordenes.size

        tomarElControl()
        esperarA("el aviso al hub") { soltados().isNotEmpty() }
        palanca(1.0)
        delay(200)

        assertEquals(estado, patrulla.state.value)
        assertFalse("ni estacionario ni palanca: ${desde(i)}", desde(i).any { it == "hold" || it.startsWith("stick") })
        assertTrue(soltados().single().getString("motivo").contains("batería crítica"))
    }

    /** Después de rechazarla, nada queda tomado: la palanca que llegue se descarta y un `resync` del hub se contesta igual. */
    @Test
    fun despuesDelRechazoNadaQuedaTomado() = runBlocking {
        patrullando()
        banco.evento(FlightEvent.ElDronTomoElControl(MotivoDelDron.RTH_DEL_CONTROL))
        esperarA("el regreso") { patrulla.state.value == PatrolState.RETURNING_HOME }
        tomarElControl("op")
        esperarA("el aviso al hub") { soltados().isNotEmpty() }

        consola("""{"type":"control_taken","by":"op","resync":true}""")
        esperarA("el segundo aviso") { soltados().size == 2 }

        assertTrue(soltados()[1].getString("motivo").contains("no tenía el control tomado"))
        assertFalse(dron.ordenes.any { it.startsWith("stick") })
    }
}
