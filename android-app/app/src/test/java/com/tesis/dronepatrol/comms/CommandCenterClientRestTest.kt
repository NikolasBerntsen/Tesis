package com.tesis.dronepatrol.comms

import com.tesis.dronepatrol.model.DroneBase
import com.tesis.dronepatrol.model.DroneProfile
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.SesionOperador
import com.tesis.dronepatrol.model.Waypoint
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * El REST del Comando Central tal como lo usa la app (docs/PROTOCOLS.md §0.b y
 * §5): el login del operador de campo, el emparejamiento por QR, la ficha del
 * dron, las rutas y el aviso de cierre. Lo que importa es el pedido exacto —la
 * ruta, con qué JWT y con qué cuerpo— y que cada respuesta de error termine en
 * un motivo que el operador entienda. El servidor es un interceptor: nada sale
 * a la red.
 *
 * Robolectric por org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CommandCenterClientRestTest {

    /**
     * Lo que escapa de una corrutina del cliente. En la app no hay quien lo
     * atrape (lifecycleScope no tiene manejador): sería la app cerrándose.
     */
    private val sinAtrapar = CopyOnWriteArrayList<Throwable>()
    private val alcance = CoroutineScope(SupervisorJob() + CoroutineExceptionHandler { _, e -> sinAtrapar += e })
    private val servidor = ServidorFalso()
    private val cliente = CommandCenterClient(alcance, servidor.http)

    @After
    fun cortar() {
        alcance.cancel()
    }

    private fun loginOk(token: String = "jwt-operador") {
        servidor.contestar(
            "/api/auth/login",
            200,
            """{"token":"$token","expiresIn":1200,"user":{"username":"campo1","role":"field_operator"}}""",
        )
        runBlocking { cliente.login("http://comando.test", "campo1", "clave-de-prueba") }
    }

    private fun motivoDe(bloque: suspend () -> Unit): String =
        assertThrows(IllegalStateException::class.java) { runBlocking { bloque() } }.message.orEmpty()

    // --- Login del operador de campo ---------------------------------------

    /** `{username, password}` → `{token, expiresIn, user}` (§5, Sesión). */
    @Test
    fun elLoginMandaLasCredencialesYDevuelveLaSesion() {
        servidor.contestar(
            "/api/auth/login",
            200,
            """{"token":"jwt-operador","expiresIn":1200,"user":{"username":"campo1","role":"field_operator"}}""",
        )

        // Lo que tipea el operador puede traer espacios y la barra final
        val sesion = runBlocking { cliente.login("  http://comando.test:4000/  ", "campo1", "clave-de-prueba") }

        assertEquals(SesionOperador(username = "campo1", role = "field_operator", expiresIn = 1200L), sesion)
        val pedido = servidor.pedidos.single()
        assertEquals("POST", pedido.metodo)
        assertEquals("http://comando.test:4000/api/auth/login", pedido.url)
        assertTrue("va como JSON: ${pedido.tipo}", pedido.tipo.orEmpty().startsWith("application/json"))
        assertNull("el login no lleva JWT", pedido.autorizacion)
        val cuerpo = JSONObject(pedido.cuerpo)
        assertEquals(setOf("username", "password"), cuerpo.keys().asSequence().toSet())
        assertEquals("campo1", cuerpo.getString("username"))
        assertEquals("clave-de-prueba", cuerpo.getString("password"))
    }

    /** El JWT del login es el que va en el pedido siguiente: el del emparejamiento. */
    @Test
    fun elJwtDelLoginEsElQueEmpareja() {
        loginOk("jwt-operador")
        servidor.contestar("/api/drones/pair", 200, """{"token":"jwt-dron","drone":{"hash":"a3f9"}}""")

        runBlocking { cliente.emparejarDron("a3f9") }

        assertEquals("Bearer jwt-operador", servidor.pedidosA("/api/drones/pair").single().autorizacion)
    }

    /** Un backend que no manda la ficha del usuario: el nombre es el que se tipeó. */
    @Test
    fun sinFichaDeUsuarioLaSesionUsaElNombreTipeado() {
        servidor.contestar("/api/auth/login", 200, """{"token":"t"}""")

        val sesion = runBlocking { cliente.login("http://comando.test", "campo1", "clave-de-prueba") }

        assertEquals(SesionOperador(username = "campo1", role = "", expiresIn = 0L), sesion)
    }

    /**
     * Un login rechazado dice por qué: el motivo del backend si lo manda
     * (`{"error": "..."}`), y si no, uno propio según el código.
     */
    @Test
    fun unLoginRechazadoExplicaPorQue() {
        servidor.contestar("/api/auth/login", 401, """{"error":"Cuenta suspendida"}""")
        assertEquals("Cuenta suspendida", motivoDe { cliente.login("http://comando.test", "campo1", "x") })

        servidor.contestar("/api/auth/login", 401, "")
        assertEquals("Usuario o contraseña incorrectos", motivoDe { cliente.login("http://comando.test", "campo1", "x") })

        // Un error en blanco no es un motivo
        servidor.contestar("/api/auth/login", 401, """{"error":"  "}""")
        assertEquals("Usuario o contraseña incorrectos", motivoDe { cliente.login("http://comando.test", "campo1", "x") })

        servidor.contestar("/api/auth/login", 500, """{"error":"La base no responde"}""")
        assertEquals("La base no responde", motivoDe { cliente.login("http://comando.test", "campo1", "x") })

        // Un proxy que contesta HTML en vez del backend
        servidor.contestar("/api/auth/login", 502, "<html>Bad Gateway</html>")
        assertEquals("El login falló: HTTP 502", motivoDe { cliente.login("http://comando.test", "campo1", "x") })
    }

    // --- Emparejamiento por QR ---------------------------------------------

    /**
     * `{hash, lat, lon, accuracyM, deviceModel}` → `{token, drone}` (§0.b paso
     * 4): el hash del QR, con la ubicación del operador en ese momento.
     */
    @Test
    fun elEmparejamientoMandaElQrYLaUbicacionDelOperador() {
        loginOk()
        servidor.contestar(
            "/api/drones/pair",
            200,
            """{"token":"jwt-dron","drone":{"hash":"a3f9c1b27d5e4408f61a9c3e772b7e42","displayName":"Alfa",
               "model":"DJI Mini 4 Pro","base":{"name":"Base Norte","lat":-34.8565,"lon":-56.2075}}}""",
        )

        val emparejamiento = runBlocking {
            cliente.emparejarDron("a3f9c1b27d5e4408f61a9c3e772b7e42", -34.85, -56.2, 12.5, "S23 Ultra")
        }

        val pedido = servidor.pedidosA("/api/drones/pair").single()
        assertEquals("POST", pedido.metodo)
        assertEquals("http://comando.test/api/drones/pair", pedido.url)
        val cuerpo = JSONObject(pedido.cuerpo)
        assertEquals(setOf("hash", "lat", "lon", "accuracyM", "deviceModel"), cuerpo.keys().asSequence().toSet())
        assertEquals("a3f9c1b27d5e4408f61a9c3e772b7e42", cuerpo.getString("hash"))
        assertEquals(-34.85, cuerpo.getDouble("lat"), 0.0)
        assertEquals(-56.2, cuerpo.getDouble("lon"), 0.0)
        assertEquals(12.5, cuerpo.getDouble("accuracyM"), 0.0)
        assertEquals("S23 Ultra", cuerpo.getString("deviceModel"))

        assertEquals("jwt-dron", emparejamiento.token)
        assertEquals(
            DroneProfile(
                hash = "a3f9c1b27d5e4408f61a9c3e772b7e42",
                displayName = "Alfa",
                model = "DJI Mini 4 Pro",
                base = DroneBase("Base Norte", -34.8565, -56.2075),
            ),
            emparejamiento.drone,
        )
    }

    /**
     * Sin permiso de GPS el emparejamiento procede igual: la ubicación viaja
     * en null (presente, no ausente) y el registro queda sin coordenadas.
     */
    @Test
    fun sinGpsElEmparejamientoMandaLaUbicacionEnNull() {
        loginOk()
        servidor.contestar("/api/drones/pair", 200, """{"token":"jwt-dron","drone":{"droneId":"a3f9","displayName":"Alfa"}}""")

        val emparejamiento = runBlocking { cliente.emparejarDron("a3f9") }

        val cuerpo = JSONObject(servidor.pedidosA("/api/drones/pair").single().cuerpo)
        for (campo in listOf("lat", "lon", "accuracyM")) {
            assertTrue("$campo tiene que estar: $cuerpo", cuerpo.has(campo))
            assertTrue("$campo tiene que ir en null: $cuerpo", cuerpo.isNull(campo))
        }
        assertEquals("", cuerpo.getString("deviceModel"))
        // Una ficha sin base y que llega con `droneId` en vez de `hash`
        assertEquals(DroneProfile(hash = "a3f9", displayName = "Alfa", model = "", base = null), emparejamiento.drone)
    }

    /**
     * Cada rechazo del emparejamiento tiene su explicación (§5: 404 si el QR no
     * es de ningún dron, 403 si está eliminado o desactivado). El 401 siempre
     * es la sesión efímera vencida, diga lo que diga el cuerpo.
     */
    @Test
    fun unEmparejamientoRechazadoDiceQuePasoConElQr() {
        loginOk()
        fun motivo(codigo: Int, cuerpo: String): String {
            servidor.contestar("/api/drones/pair", codigo, cuerpo)
            return motivoDe { cliente.emparejarDron("a3f9") }
        }

        assertEquals(
            "La sesión del operador de campo venció: iniciá sesión de nuevo",
            motivo(401, """{"error":"jwt expired"}"""),
        )
        assertEquals("El dron está eliminado", motivo(403, """{"error":"El dron está eliminado"}"""))
        assertEquals("El dron está inactivo o no lo podés emparejar", motivo(403, ""))
        assertEquals("Ese QR no corresponde a ningún dron registrado", motivo(404, ""))
        assertEquals("Dron desconocido", motivo(404, """{"error":"Dron desconocido"}"""))
        assertEquals("El emparejamiento falló: HTTP 500", motivo(500, "<html></html>"))
        assertEquals("Sin espacio", motivo(507, """{"error":"Sin espacio"}"""))
    }

    // --- Ficha del dron y rutas, ya con el JWT del dron --------------------

    /**
     * Tras emparejar, el cliente habla como el dron: el JWT es el del dron y la
     * URL base la que se le pase (sin la barra final).
     */
    @Test
    fun laFichaDelDronSePideConElJwtDelDron() {
        loginOk()
        cliente.usarTokenDeDron("jwt-dron", " https://central.test/ ")
        servidor.contestar(
            "/api/me",
            200,
            """{"role":"drone","username":"a3f9","displayName":"Alfa","model":"DJI Mini 4 Pro","base":null}""",
        )

        val ficha = runBlocking { cliente.fetchProfile() }

        val pedido = servidor.pedidosA("/api/me").single()
        assertEquals("GET", pedido.metodo)
        assertEquals("https://central.test/api/me", pedido.url)
        assertEquals("Bearer jwt-dron", pedido.autorizacion)
        // GET /api/me trae el hash como `username` y la base en null
        assertEquals(DroneProfile(hash = "a3f9", displayName = "Alfa", model = "DJI Mini 4 Pro", base = null), ficha)
    }

    /** `hash`, `droneId` y `username` son el mismo valor; se toma el primero que no esté en blanco. */
    @Test
    fun elIdentificadorDelDronSaleDelPrimerNombreQueLoTraiga() {
        cliente.usarTokenDeDron("jwt-dron", "http://central.test")
        servidor.contestar("/api/me", 200, """{"role":"drone","hash":" ","droneId":"d-1","username":"u-1"}""")
        assertEquals("d-1", runBlocking { cliente.fetchProfile() }.hash)

        servidor.contestar("/api/me", 200, """{"role":"drone","hash":"h-1","droneId":"d-1","username":"u-1"}""")
        assertEquals("h-1", runBlocking { cliente.fetchProfile() }.hash)

        servidor.contestar("/api/me", 200, """{"role":"drone","displayName":"Sin id"}""")
        assertEquals("La ficha del dron no trae su identificador", motivoDe { cliente.fetchProfile() })
    }

    /** Un JWT de humano no puede hacerse pasar por el dron, y un error HTTP se informa con su código. */
    @Test
    fun laFichaRechazaUnTokenQueNoEsDeDronOUnError() {
        cliente.usarTokenDeDron("jwt-dron", "http://central.test")

        servidor.contestar("/api/me", 200, """{"role":"operator","username":"ana"}""")
        assertEquals("El token no es de un dron", motivoDe { cliente.fetchProfile() })

        servidor.contestar("/api/me", 401, """{"error":"jwt expired"}""")
        assertEquals("No se pudo leer la ficha del dron: HTTP 401", motivoDe { cliente.fetchProfile() })
    }

    /** Las rutas con sus waypoints `{lat, lon, alt}` en orden (§0, Rutas); el `label` no se usa. */
    @Test
    fun lasRutasLleganConSusWaypointsEnOrden() {
        cliente.usarTokenDeDron("jwt-dron", "http://central.test")
        servidor.contestar(
            "/api/routes",
            200,
            """[{"id":1,"name":"Perímetro","waypoints":[{"lat":-34.1,"lon":-56.1,"alt":40,"label":"Portón"},
                                                         {"lat":-34.2,"lon":-56.2,"alt":45.5}]},
                {"id":7,"name":"Vacía","waypoints":[]}]""",
        )

        val rutas = runBlocking { cliente.fetchRoutes() }

        val pedido = servidor.pedidosA("/api/routes").single()
        assertEquals("GET", pedido.metodo)
        assertEquals("Bearer jwt-dron", pedido.autorizacion)
        assertEquals(
            listOf(
                PatrolRoute(1, "Perímetro", listOf(Waypoint(-34.1, -56.1, 40.0), Waypoint(-34.2, -56.2, 45.5))),
                PatrolRoute(7, "Vacía", emptyList()),
            ),
            rutas,
        )
    }

    @Test
    fun sinRutasPorUnErrorSeInformaElCodigo() {
        cliente.usarTokenDeDron("jwt-dron", "http://central.test")
        servidor.contestar("/api/routes", 503, "")

        assertEquals("No se pudieron obtener las rutas: HTTP 503", motivoDe { cliente.fetchRoutes() })
    }

    /** Sin URL nueva, el token del dron se usa contra el mismo Comando Central del login. */
    @Test
    fun tomarElTokenDelDronSinUrlConservaLaDelLogin() {
        loginOk()
        cliente.usarTokenDeDron("jwt-dron")
        servidor.contestar("/api/routes", 200, "[]")

        runBlocking { cliente.fetchRoutes() }

        val pedido = servidor.pedidosA("/api/routes").single()
        assertEquals("http://comando.test/api/routes", pedido.url)
        assertEquals("Bearer jwt-dron", pedido.autorizacion)
    }

    // --- Cierre de la sesión efímera ----------------------------------------

    /**
     * Cerrar con motivo deja el cierre en el registro: `POST /api/auth/logout`
     * con `{motivo}` y el JWT que se está descartando. Después el JWT ya no
     * existe: un pedido posterior sale sin token.
     */
    @Test
    fun cerrarConMotivoAvisaAlComandoCentralYTiraElJwt() {
        loginOk("jwt-operador")
        servidor.contestar("/api/auth/logout", 204, "")
        val antes = tareasDe(alcance)

        cliente.cerrarSesion("Terminó el emparejamiento")
        esperarLasNuevas(alcance, antes)

        val aviso = servidor.pedidosA("/api/auth/logout").single()
        assertEquals("POST", aviso.metodo)
        assertEquals("http://comando.test/api/auth/logout", aviso.url)
        assertEquals("Bearer jwt-operador", aviso.autorizacion)
        assertEquals("Terminó el emparejamiento", JSONObject(aviso.cuerpo).getString("motivo"))

        servidor.contestar("/api/routes", 200, "[]")
        runBlocking { cliente.fetchRoutes() }
        assertSinJwt(servidor.pedidosA("/api/routes").single())
    }

    /** "Bearer " sin token: OkHttp recorta el valor del encabezado, así que llega "Bearer" a secas. */
    private fun assertSinJwt(pedido: PedidoRest) {
        assertEquals("el JWT se descartó: $pedido", "Bearer", pedido.autorizacion)
    }

    /** Sin motivo no se avisa: es descartar una sesión que nunca llegó a abrirse. */
    @Test
    fun cerrarSinMotivoNoAvisa() {
        loginOk()
        val antes = tareasDe(alcance)

        cliente.cerrarSesion()
        esperarLasNuevas(alcance, antes)

        assertTrue(servidor.pedidosA("/api/auth/logout").isEmpty())
    }

    /** Sin Comando Central o sin JWT no hay a quién ni con qué avisar. */
    @Test
    fun sinSesionNoHayAvisoDeCierre() {
        val antes = tareasDe(alcance)
        cliente.cerrarSesion("Nunca entró")
        esperarLasNuevas(alcance, antes)
        assertTrue("sin login no hay URL: ${servidor.pedidos}", servidor.pedidos.isEmpty())

        loginOk()
        cliente.cerrarSesion("Primera")
        esperarLasNuevas(alcance, antes)
        // La segunda vez el JWT ya se descartó
        val despues = tareasDe(alcance)
        cliente.cerrarSesion("Segunda")
        esperarLasNuevas(alcance, despues)

        assertEquals(listOf("Primera"), servidor.pedidosA("/api/auth/logout").map { JSONObject(it.cuerpo).getString("motivo") })
    }

    /**
     * El aviso va "a la buena de Dios": si no llega (en el campo la conexión se
     * corta sola) no rompe nada, y la sesión se cierra igual.
     */
    @Test
    fun unAvisoDeCierreQueNoLlegaNoRompeNada() {
        loginOk()
        servidor.cortar("/api/auth/logout")
        val antes = tareasDe(alcance)

        cliente.cerrarSesion("Sin señal")
        esperarLasNuevas(alcance, antes)

        assertEquals("el aviso se intentó", 1, servidor.pedidosA("/api/auth/logout").size)
        assertTrue("el corte del aviso no puede escaparse: $sinAtrapar", sinAtrapar.isEmpty())
        servidor.contestar("/api/routes", 200, "[]")
        runBlocking { cliente.fetchRoutes() }
        assertSinJwt(servidor.pedidosA("/api/routes").single())
    }
}
