package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.drone.Navegacion
import com.tesis.dronepatrol.model.AjustesDelDron
import com.tesis.dronepatrol.model.ReaccionADeteccion
import com.tesis.dronepatrol.patrol.BancoDeRelevos
import com.tesis.dronepatrol.patrol.PatrolManager
import com.tesis.dronepatrol.patrol.esperarA
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El archivo compartido del contrato de los ajustes del dron
 * (`docs/contrato/ajustes.json`, docs/PROTOCOLS.md §2 y docs/VUELO.md §10),
 * leído desde las pruebas de la app como lo leen las del hub y las de la
 * consola: los rangos y los valores de fábrica son los de la app, cada ejemplo
 * válido llega tipado al oyente y PatrolManager lo aplica, y cada inválido se
 * descarta entero sin tocar lo que había. Los cuerpos son los del `PATCH`; el
 * mensaje `ajustes` del hub a la app lleva las mismas claves más `by`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ContratoDeAjustesTest {

    private companion object {
        /** Relativa al módulo `android-app/app`, el directorio de trabajo de las pruebas (ver ContratoDeRelevos). */
        const val RUTA = "../../docs/contrato/ajustes.json"

        val raiz: JSONObject by lazy { JSONObject(File(RUTA).readText(Charsets.UTF_8)) }

        fun ajuste(clave: String): JSONObject = raiz.getJSONObject("ajustes").getJSONObject(clave)

        fun ejemplos(clase: String): List<JSONObject> {
            val lista = raiz.getJSONObject("ejemplos").getJSONArray(clase)
            return (0 until lista.length()).map { lista.getJSONObject(it) }
        }

        /** El cuerpo del `PATCH` envuelto como el mensaje `ajustes` que manda el hub. */
        fun mensaje(cuerpo: JSONObject): String =
            JSONObject(cuerpo.toString()).put("type", "ajustes").put("by", "op").toString()

        /** Lo que la app tiene que entender de un cuerpo válido: ausente o `null` es de fábrica. */
        fun esperado(cuerpo: JSONObject) = AjustesDelDron(
            velocidadOrbitaMs = if (cuerpo.isNull("velocidadOrbitaMs")) null else cuerpo.getDouble("velocidadOrbitaMs"),
            reaccionADeteccion = if (cuerpo.isNull("reaccionADeteccion")) {
                null
            } else {
                requireNotNull(ReaccionADeteccion.desdeElProtocolo(cuerpo.getString("reaccionADeteccion")))
            },
            silencioAlRetomarS = if (cuerpo.isNull("silencioAlRetomarS")) null else cuerpo.getInt("silencioAlRetomarS"),
        )
    }

    private val alcance = CoroutineScope(SupervisorJob())
    private val cliente = CommandCenterClient(alcance)

    @After
    fun cortar() {
        alcance.cancel()
    }

    @Test
    fun seLeeDesdeElModuloDeLaApp() {
        assertTrue("no está ${File(RUTA).absolutePath}", File(RUTA).isFile)
        assertEquals(1, raiz.getInt("version"))
        assertTrue("el contrato trae válidos", ejemplos("validos").size >= 5)
        assertTrue("el contrato trae inválidos para probar el rechazo", ejemplos("invalidos").size >= 10)
    }

    /** Si cambia un rango en el contrato, cambia acá y en las tres puntas a la vez. */
    @Test
    fun losRangosYLosDeFabricaSonLosDeLaApp() {
        val velocidad = ajuste("velocidadOrbitaMs")
        assertEquals(Navegacion.VELOCIDAD_ORBITA_MINIMA_MS, velocidad.getDouble("minimo"), 0.0)
        assertEquals(Navegacion.VELOCIDAD_ORBITA_MAXIMA_MS, velocidad.getDouble("maximo"), 0.0)
        assertEquals(Navegacion.VELOCIDAD_ORBITA_MS, velocidad.getDouble("porDefecto"), 0.0)

        val reaccion = ajuste("reaccionADeteccion")
        val valores = reaccion.getJSONArray("valores").let { lista -> (0 until lista.length()).map { lista.getString(it) } }
        assertEquals(ReaccionADeteccion.entries.map { it.enElProtocolo }, valores)
        assertEquals(ReaccionADeteccion.DE_FABRICA.enElProtocolo, reaccion.getString("porDefecto"))
        valores.forEach { assertTrue("sin rótulo para $it", reaccion.getJSONObject("rotulos").getString(it).isNotBlank()) }

        val silencio = ajuste("silencioAlRetomarS")
        assertEquals(AjustesDelDron.SILENCIO_MINIMO_S, silencio.getInt("minimo"))
        assertEquals(AjustesDelDron.SILENCIO_MAXIMO_S, silencio.getInt("maximo"))
        assertEquals(AjustesDelDron.PASO_DEL_SILENCIO_S, silencio.getInt("paso"))
        assertEquals(AjustesDelDron.SILENCIO_DE_FABRICA_S, silencio.getInt("porDefecto"))
        assertEquals(AjustesDelDron.SILENCIO_DE_FABRICA_S * 1_000L, PatrolManager.SILENCIO_AL_RETOMAR_MS)
    }

    @Test
    fun cadaEjemploValidoLlegaTipadoAlOyente() {
        for (ejemplo in ejemplos("validos")) {
            val cuerpo = ejemplo.getJSONObject("cuerpo")
            val recibidos = mutableListOf<AjustesDelDron>()
            val invalidos = mutableListOf<String>()
            cliente.onAjustes = { recibidos += it }
            cliente.onMensajeInvalido = { invalidos += it }

            cliente.manejarMensaje(mensaje(cuerpo))

            assertEquals(ejemplo.getString("caso"), listOf(esperado(cuerpo)), recibidos)
            assertEquals(ejemplo.getString("caso"), emptyList<String>(), invalidos)
        }
    }

    @Test
    fun cadaEjemploInvalidoSeDescartaEnteroYQuedaEnElRegistro() {
        for (ejemplo in ejemplos("invalidos")) {
            val invalidos = mutableListOf<String>()
            cliente.onAjustes = { throw AssertionError("${ejemplo.getString("caso")}: se aplicó $it") }
            cliente.onMensajeInvalido = { invalidos += it }

            cliente.manejarMensaje(mensaje(ejemplo.getJSONObject("cuerpo")))

            assertEquals("${ejemplo.getString("caso")} (${ejemplo.getString("porque")})", 1, invalidos.size)
            assertTrue(invalidos.single(), invalidos.single().startsWith("ajustes"))
        }
    }

    /** PatrolManager aplica cada válido: lo que trae, y de fábrica lo que no trae. */
    @Test
    fun cadaEjemploValidoSeAplicaEnLaPatrulla() = runBlocking {
        val banco = BancoDeRelevos()
        try {
            banco.arrancar()
            for (ejemplo in ejemplos("validos")) {
                val cuerpo = ejemplo.getJSONObject("cuerpo")
                val e = esperado(cuerpo)
                banco.comando.recibir(JSONObject(mensaje(cuerpo)))
                esperarA(ejemplo.getString("caso")) {
                    banco.patrulla.velocidadDeOrbita == (e.velocidadOrbitaMs ?: Navegacion.VELOCIDAD_ORBITA_MS) &&
                        banco.patrulla.reaccionADeteccion == (e.reaccionADeteccion ?: ReaccionADeteccion.DE_FABRICA) &&
                        banco.patrulla.silencioAlRetomar == (e.silencioAlRetomarS ?: AjustesDelDron.SILENCIO_DE_FABRICA_S) * 1_000L
                }
            }
        } finally {
            banco.desarmar()
        }
    }

    /** Un inválido no se aplica a medias: los tres ajustes quedan como estaban, y el registro local lo cuenta. */
    @Test
    fun ningunEjemploInvalidoCambiaLoQueHabia() = runBlocking {
        val banco = BancoDeRelevos()
        try {
            banco.arrancar()
            val registro = mutableListOf<String>()
            banco.alcance.launch { banco.patrulla.localLog.collect { synchronized(registro) { registro += it } } }
            banco.comando.recibir(
                JSONObject().put("type", "ajustes").put("by", "op")
                    .put("velocidadOrbitaMs", 2.5).put("reaccionADeteccion", "detenerse").put("silencioAlRetomarS", 5),
            )
            esperarA("los tres ajustes") {
                banco.patrulla.velocidadDeOrbita == 2.5 && banco.patrulla.reaccionADeteccion == ReaccionADeteccion.DETENERSE &&
                    banco.patrulla.silencioAlRetomar == 5_000L
            }

            var ignorados = 0
            for (ejemplo in ejemplos("invalidos")) {
                banco.comando.recibir(JSONObject(mensaje(ejemplo.getJSONObject("cuerpo"))))
                ignorados++
                esperarA("el registro de ${ejemplo.getString("caso")}") {
                    synchronized(registro) { registro.count { it.contains("no cumplir el contrato: ajustes") } } == ignorados
                }
            }
            delay(200)
            assertEquals(2.5, banco.patrulla.velocidadDeOrbita, 0.0)
            assertEquals(ReaccionADeteccion.DETENERSE, banco.patrulla.reaccionADeteccion)
            assertEquals(5_000L, banco.patrulla.silencioAlRetomar)
        } finally {
            banco.desarmar()
        }
    }

    /** Lo que un mensaje válido no trae vuelve a ser de fábrica: el hub manda siempre los tres. */
    @Test
    fun unMensajeQueNoTraeUnAjusteLoDevuelveAlDeFabrica() = runBlocking {
        val banco = BancoDeRelevos()
        try {
            banco.arrancar()
            banco.comando.recibir(JSONObject("""{"type":"ajustes","velocidadOrbitaMs":2.5,"silencioAlRetomarS":30,"by":"op"}"""))
            esperarA("los ajustes") { banco.patrulla.velocidadDeOrbita == 2.5 && banco.patrulla.silencioAlRetomar == 30_000L }

            banco.comando.recibir(JSONObject("""{"type":"ajustes","reaccionADeteccion":"seguir","by":"op"}"""))
            esperarA("la vuelta a los de fábrica") {
                banco.patrulla.velocidadDeOrbita == Navegacion.VELOCIDAD_ORBITA_MS &&
                    banco.patrulla.silencioAlRetomar == PatrolManager.SILENCIO_AL_RETOMAR_MS &&
                    banco.patrulla.reaccionADeteccion == ReaccionADeteccion.SEGUIR
            }
        } finally {
            banco.desarmar()
        }
    }
}
