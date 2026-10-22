package com.tesis.dronepatrol

import android.content.Intent
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import com.tesis.dronepatrol.ComandoCentralFalso.Companion.RUTA_LOGIN
import com.tesis.dronepatrol.ComandoCentralFalso.Companion.RUTA_LOGOUT
import java.net.ConnectException
import java.util.concurrent.CountDownLatch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Smoke test de arranque: si la pantalla inicial revienta al crearse, este test
 * falla con el stack trace real en vez de un cierre silencioso en el dispositivo.
 * Se corre en el rango de APIs que abarca minSdk 26 .. targetSdk 34.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 30, 34])
class LoginActivityLaunchTest {

    private companion object {
        /** La del contrato: es la que tiene que aparecer sola en el campo. */
        const val URL_POR_DEFECTO = "https://tesis.144-22-138-149.sslip.io"
    }

    private val app get() = RuntimeEnvironment.getApplication()

    /** El cliente del login es el de verdad; el Comando Central del otro lado no (ver ComandoCentralFalso). */
    private val comando = ComandoCentralFalso()
    private val fabricaOriginal = SesionDeCampo.fabricaDeClientes

    @Before
    fun conectarAlComandoCentralDeMentira() {
        SesionDeCampo.fabricaDeClientes = { comando.cliente(it) }
    }

    // La sesión vive en el proceso: sin esto un login exitoso se filtra al test siguiente
    @After
    fun desarmar() {
        comando.retencion?.countDown()
        SesionDeCampo.cerrar()
        SesionDeCampo.fabricaDeClientes = fabricaOriginal
    }

    private fun completar(
        actividad: LoginActivity,
        url: String = ComandoCentralFalso.URL,
        usuario: String = "operador.campo",
        clave: String = "clave-de-prueba",
    ) {
        actividad.findViewById<EditText>(R.id.editBackendUrl).setText(url)
        actividad.findViewById<EditText>(R.id.editUsername).setText(usuario)
        actividad.findViewById<EditText>(R.id.editPassword).setText(clave)
    }

    private fun LoginActivity.boton(): Button = findViewById(R.id.btnLogin)

    private fun LoginActivity.estado(): String = findViewById<TextView>(R.id.txtLoginStatus).text.toString()

    /** Toca "Iniciar sesión" y espera a que el Comando Central conteste (el botón vuelve o la pantalla se va). */
    private fun entrar(actividad: LoginActivity) {
        actividad.boton().performClick()
        esperarEnElHiloPrincipal("la respuesta del login") { actividad.boton().isEnabled || actividad.isFinishing }
    }

    @Test
    fun laPantallaDeLoginArrancaSinCrashear() {
        val controller = Robolectric.buildActivity(LoginActivity::class.java).setup()
        assertNotNull(controller.get())
    }

    /**
     * La pantalla principal se crea con lo que devuelve el emparejamiento por
     * QR. El token es de mentira: acá solo interesa que inflar y cablear la UI
     * no rompa.
     */
    @Test
    fun laPantallaPrincipalArrancaSinCrashear() {
        val intent = Intent(RuntimeEnvironment.getApplication(), MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_DRONE_TOKEN, "token-de-prueba")
            .putExtra(MainActivity.EXTRA_DRONE_HASH, "0123456789abcdef0123456789abcdef")
            .putExtra(MainActivity.EXTRA_DISPLAY_NAME, "Alfa")
            .putExtra(MainActivity.EXTRA_BASE_LAT, -34.6037)
            .putExtra(MainActivity.EXTRA_BASE_LON, -58.3816)
            .putExtra(MainActivity.EXTRA_MODE, "TEST")

        val controller = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        assertNotNull(controller.get())
    }

    // De acá para abajo va comportamiento, que no depende de la versión de
    // Android: alcanza con una sola API y el arranque ya se probó en las tres.

    @Test
    @Config(sdk = [34])
    fun traeLaUrlDelComandoCentralPrecargada() {
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()

        val url = actividad.findViewById<EditText>(R.id.editBackendUrl).text.toString()
        assertEquals(URL_POR_DEFECTO, url)
    }

    /** Con guantes y a la intemperie nadie quiere retipear la URL. */
    @Test
    @Config(sdk = [34])
    fun recuerdaLaUltimaUrlDelComandoCentral() {
        PreferenciasEnlace(RuntimeEnvironment.getApplication()).urlComandoCentral = "https://otro.comando.central"

        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()

        assertEquals(
            "https://otro.comando.central",
            actividad.findViewById<EditText>(R.id.editBackendUrl).text.toString(),
        )
    }

    /** Volver al login sin decir por qué deja al operador probando de nuevo a ciegas. */
    @Test
    @Config(sdk = [34])
    fun muestraElAvisoConElQueVolvioAlLogin() {
        val aviso = RuntimeEnvironment.getApplication().getString(R.string.aviso_sesion_vencida)
        val intent = Intent(RuntimeEnvironment.getApplication(), LoginActivity::class.java)
            .putExtra(LoginActivity.EXTRA_AVISO, aviso)

        val actividad = Robolectric.buildActivity(LoginActivity::class.java, intent).setup().get()

        assertEquals(aviso, actividad.findViewById<TextView>(R.id.txtLoginStatus).text.toString())
    }

    @Test
    @Config(sdk = [34])
    fun sinCredencialesNiSiquieraSaleAPreguntar() {
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()

        actividad.findViewById<Button>(R.id.btnLogin).performClick()

        assertEquals(
            actividad.getString(R.string.login_faltan_datos),
            actividad.findViewById<TextView>(R.id.txtLoginStatus).text.toString(),
        )
    }

    /** Cualquiera de los tres datos que falte frena el login antes de salir a la red. */
    @Test
    @Config(sdk = [34])
    fun sinUrlOSinContrasenaTampocoSaleAPreguntar() {
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()

        completar(actividad, url = "   ")
        actividad.boton().performClick()
        assertEquals(actividad.getString(R.string.login_faltan_datos), actividad.estado())

        completar(actividad, clave = "")
        actividad.boton().performClick()
        assertEquals(actividad.getString(R.string.login_faltan_datos), actividad.estado())

        assertTrue(actividad.boton().isEnabled)
        assertTrue(comando.pedidos(RUTA_LOGIN).isEmpty())
    }

    /**
     * Credenciales buenas: abre la sesión efímera con lo que dice el Comando
     * Central, pasa al menú de campo y recuerda la URL. Usuario y URL se limpian
     * de espacios (el teclado del teléfono los agrega solo); la contraseña va
     * tal cual, porque un espacio puede ser parte de ella.
     */
    @Test
    @Config(sdk = [34])
    fun conCredencialesValidasAbreLaSesionYPasaAlMenuDeCampo() {
        comando.aceptarLogin(usuario = "operador.campo", rol = "supervisor", segundos = 600)
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()
        completar(actividad, url = "  https://comando.prueba/  ", usuario = " operador.campo ", clave = " clave de prueba ")

        entrar(actividad)

        val pedido = comando.pedidos(RUTA_LOGIN).single()
        assertEquals("https://comando.prueba/api/auth/login", pedido.url)
        assertEquals("operador.campo", pedido.cuerpo!!.getString("username"))
        assertEquals(" clave de prueba ", pedido.cuerpo.getString("password"))

        assertTrue(actividad.isFinishing)
        val siguiente = shadowOf(app).nextStartedActivity
        assertEquals(FieldMenuActivity::class.java.name, siguiente?.component?.className)
        assertTrue(SesionDeCampo.vigente)
        assertEquals("operador.campo", SesionDeCampo.usuario)
        assertEquals("supervisor", SesionDeCampo.rol)
        // Los 10 minutos que informó el Comando Central, no los 20 por defecto
        // (con margen: el reloj corre unos milisegundos mientras vuelve el login)
        assertTrue(SesionDeCampo.restanteMs() in 590_000L..600_000L)
        assertEquals("https://comando.prueba/", PreferenciasEnlace(app).urlComandoCentral)
    }

    /** Mientras el Comando Central no contesta no se puede tocar dos veces "Iniciar sesión". */
    @Test
    @Config(sdk = [34])
    fun mientrasVerificaNoSePuedeVolverATocarIniciarSesion() {
        comando.aceptarLogin()
        comando.retencion = CountDownLatch(1)
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()
        completar(actividad)

        actividad.boton().performClick()
        esperarEnElHiloPrincipal("el pedido de login") { comando.pedidos(RUTA_LOGIN).isNotEmpty() }

        assertFalse(actividad.boton().isEnabled)
        assertEquals(actividad.getString(R.string.login_verificando), actividad.estado())

        comando.retencion!!.countDown()
        esperarEnElHiloPrincipal("el menú de campo") { actividad.isFinishing }
        assertEquals(1, comando.pedidos(RUTA_LOGIN).size)
    }

    /**
     * Un operador de consola no despliega drones: el login le dice qué rol
     * tiene y con quién entrar, y no queda NADA de esa sesión —ni el JWT ni la
     * URL—. Tampoco se avisa un cierre: la sesión nunca llegó a abrirse.
     */
    @Test
    @Config(sdk = [34])
    fun unRolSinPermisoNoAbreSesionNiRecuerdaLaUrl() {
        comando.aceptarLogin(rol = "operator")
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()
        completar(actividad)

        entrar(actividad)

        assertEquals(actividad.getString(R.string.login_rol_sin_permiso, "operador"), actividad.estado())
        assertTrue(actividad.boton().isEnabled)
        assertFalse(actividad.isFinishing)
        assertNull(shadowOf(app).nextStartedActivity)
        assertNull(SesionDeCampo.cliente)
        assertEquals(URL_POR_DEFECTO, PreferenciasEnlace(app).urlComandoCentral)
        assertTrue(comando.pedidos(RUTA_LOGOUT).isEmpty())
    }

    @Test
    @Config(sdk = [34])
    fun conCredencialesIncorrectasLoDiceYDejaReintentar() {
        comando.responder(RUTA_LOGIN, 401, "")
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()
        completar(actividad)

        entrar(actividad)

        assertEquals(actividad.getString(R.string.login_fallo, "Usuario o contraseña incorrectos"), actividad.estado())
        assertTrue(actividad.boton().isEnabled)
        assertNull(shadowOf(app).nextStartedActivity)
        assertNull(SesionDeCampo.cliente)
    }

    /**
     * Sin señal o con la URL mal escrita el Comando Central no contesta: se
     * dice por qué, el botón vuelve y el segundo intento —ya con conexión—
     * entra sin tener que reabrir la app.
     */
    @Test
    @Config(sdk = [34])
    fun sinComandoCentralAlAlcanceAvisaYElReintentoEntra() {
        comando.cortar(RUTA_LOGIN, ConnectException("Failed to connect to comando.prueba"))
        val actividad = Robolectric.buildActivity(LoginActivity::class.java).setup().get()
        completar(actividad)

        entrar(actividad)

        assertEquals(actividad.getString(R.string.login_fallo, "Failed to connect to comando.prueba"), actividad.estado())
        assertTrue(actividad.boton().isEnabled)
        assertNull(SesionDeCampo.cliente)
        assertEquals("la URL no se recuerda si no se pudo entrar", URL_POR_DEFECTO, PreferenciasEnlace(app).urlComandoCentral)

        comando.aceptarLogin()
        entrar(actividad)

        assertTrue(actividad.isFinishing)
        assertEquals(FieldMenuActivity::class.java.name, shadowOf(app).nextStartedActivity?.component?.className)
        assertNotNull(SesionDeCampo.cliente)
    }
}
