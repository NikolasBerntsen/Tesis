package com.tesis.dronepatrol

import android.Manifest
import android.app.Activity
import android.content.DialogInterface
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Looper.getMainLooper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.RadioButton
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import com.google.android.material.textfield.TextInputLayout
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.CaptureActivity
import com.tesis.dronepatrol.ComandoCentralFalso.Companion.RUTA_EMPAREJAR
import com.tesis.dronepatrol.ComandoCentralFalso.Companion.RUTA_LOGOUT
import com.tesis.dronepatrol.comms.ModoEnlace
import com.tesis.dronepatrol.model.DroneBase
import java.time.Duration
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.shadows.ShadowToast

/**
 * Menú de campo: la cuenta regresiva de la sesión efímera y las cuatro acciones.
 * Nada de esto pide GPS ni cámara —eso recién pasa al escanear—, así que la
 * pantalla se puede armar entera en Robolectric.
 *
 * Del otro lado está [ComandoCentralFalso]: el cliente es el de verdad, pero
 * el Comando Central contesta sin red. Los permisos y el escáner se resuelven
 * como los resolvería el sistema, entregándole a la pantalla la respuesta.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FieldMenuActivityTest {

    private companion object {
        const val VEINTE_MINUTOS_S = 20L * 60
        const val HASH = "0123456789abcdef0123456789abcdef"
        val BASE = DroneBase("Base Obelisco", -34.6037, -58.3816)
    }

    private val app get() = RuntimeEnvironment.getApplication()
    private val comando = ComandoCentralFalso()
    private val fabricaOriginal = SesionDeCampo.fabricaDeClientes

    @Before
    fun conectarAlComandoCentralDeMentira() {
        SesionDeCampo.fabricaDeClientes = { comando.cliente(it) }
    }

    // La sesión vive en el proceso: sin esto se filtra de un test al siguiente
    @After
    fun cerrarSesion() {
        comando.retencion?.countDown()
        SesionDeCampo.cerrar()
        SesionDeCampo.fabricaDeClientes = fabricaOriginal
    }

    /** El login de verdad contra el Comando Central de mentira: deja el JWT y la URL en el cliente. */
    private fun abrirSesion(segundos: Long = VEINTE_MINUTOS_S, rol: String = "field_operator") {
        comando.aceptarLogin(rol = rol, segundos = segundos)
        val cliente = SesionDeCampo.nuevoCliente()
        val sesion = runBlocking { cliente.login(ComandoCentralFalso.URL, "operador.campo", "clave-de-prueba") }
        SesionDeCampo.abrir(cliente, sesion)
    }

    private fun menu(): ActivityController<FieldMenuActivity> =
        Robolectric.buildActivity(FieldMenuActivity::class.java).setup()

    private fun FieldMenuActivity.estado(): String = findViewById<TextView>(R.id.txtEstado).text.toString()

    private fun FieldMenuActivity.botonEscanear(): Button = findViewById(R.id.btnEscanear)

    private fun permitir(vararg permisos: String) = shadowOf(app).grantPermissions(*permisos)

    /** Lo que contesta el operador en el diálogo de permisos del sistema. */
    @Suppress("DEPRECATION") // es el camino por el que el sistema le entrega la respuesta al registro de resultados
    private fun contestarPermisos(actividad: FieldMenuActivity, concedido: Boolean): List<String> {
        val pedido = shadowOf(actividad).lastRequestedPermission
        assertNotNull("la pantalla no pidió ningún permiso", pedido)
        val respuesta = if (concedido) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED
        actividad.onRequestPermissionsResult(
            pedido.requestCode,
            pedido.requestedPermissions,
            IntArray(pedido.requestedPermissions.size) { respuesta },
        )
        return pedido.requestedPermissions.toList()
    }

    /** El escáner vuelve con lo que leyó, o sin nada si el operador lo canceló. */
    private fun devolverEscaneo(actividad: FieldMenuActivity, contenido: String?) {
        val escaner = shadowOf(actividad).nextStartedActivityForResult
        assertNotNull("no se abrió el escáner", escaner)
        val datos = Intent().apply { if (contenido != null) putExtra(Intents.Scan.RESULT, contenido) }
        shadowOf(actividad).receiveResult(
            escaner.intent,
            if (contenido != null) Activity.RESULT_OK else Activity.RESULT_CANCELED,
            datos,
        )
    }

    /** Todas las pantallas que se abrieron desde la última vez, el escáner incluido. */
    private fun pantallasAbiertas(): List<Intent> = generateSequence { shadowOf(app).nextStartedActivity }.toList()

    private fun abrioLa(clase: Class<*>, abiertas: List<Intent> = pantallasAbiertas()): Intent? =
        abiertas.lastOrNull { it.component?.className == clase.name }

    private fun campoDeTexto(vista: View): EditText? = when (vista) {
        is EditText -> vista
        is ViewGroup -> (0 until vista.childCount).firstNotNullOfOrNull { campoDeTexto(vista.getChildAt(it)) }
        else -> null
    }

    private fun escribirIdentificador(actividad: FieldMenuActivity, texto: String): AlertDialog {
        actividad.findViewById<Button>(R.id.btnIdentificador).performClick()
        shadowOf(getMainLooper()).idle()
        val dialogo = ShadowDialog.getLatestDialog() as AlertDialog
        campoDeTexto(dialogo.window!!.decorView)!!.setText(texto)
        return dialogo
    }

    private fun AlertDialog.tocar(boton: Int) {
        getButton(boton).performClick()
        shadowOf(getMainLooper()).idle()
    }

    private fun abrirConfiguracion(actividad: FieldMenuActivity): AlertDialog {
        actividad.findViewById<Button>(R.id.btnConfiguracion).performClick()
        shadowOf(getMainLooper()).idle()
        return ShadowDialog.getLatestDialog() as AlertDialog
    }

    private fun motivoDelCierre(): String {
        esperarEnElHiloPrincipal("el aviso de cierre al Comando Central") { comando.pedidos(RUTA_LOGOUT).isNotEmpty() }
        val aviso = comando.pedidos(RUTA_LOGOUT).single()
        assertEquals("Bearer ${ComandoCentralFalso.JWT_OPERADOR}", aviso.autorizacion)
        return aviso.cuerpo!!.getString("motivo")
    }

    @Test
    fun muestraQuienEsYCuantoLeQuedaDeSesion() {
        abrirSesion()
        val actividad = Robolectric.buildActivity(FieldMenuActivity::class.java).setup().get()

        val quien = actividad.findViewById<TextView>(R.id.txtQuien).text.toString()
        assertEquals("operador.campo · operador de campo", quien)
        assertEquals("20:00", actividad.findViewById<TextView>(R.id.txtCuentaRegresiva).text.toString())
    }

    @Test
    fun laCuentaRegresivaBajaConElReloj() {
        abrirSesion()
        val actividad = Robolectric.buildActivity(FieldMenuActivity::class.java).setup().get()

        shadowOf(getMainLooper()).idleFor(Duration.ofSeconds(65))

        assertEquals("18:55", actividad.findViewById<TextView>(R.id.txtCuentaRegresiva).text.toString())
    }

    @Test
    fun tieneAManoLasCuatroAccionesDelCampo() {
        abrirSesion()
        val actividad = Robolectric.buildActivity(FieldMenuActivity::class.java).setup().get()

        assertEquals(
            actividad.getString(R.string.menu_campo_escanear),
            actividad.findViewById<Button>(R.id.btnEscanear).text.toString(),
        )
        assertEquals(
            actividad.getString(R.string.menu_campo_identificador),
            actividad.findViewById<Button>(R.id.btnIdentificador).text.toString(),
        )
        assertEquals(
            actividad.getString(R.string.menu_campo_configuracion),
            actividad.findViewById<Button>(R.id.btnConfiguracion).text.toString(),
        )
        assertEquals(
            actividad.getString(R.string.menu_campo_cerrar_sesion),
            actividad.findViewById<Button>(R.id.btnCerrarSesion).text.toString(),
        )
    }

    /**
     * Escribir el identificador y configurar el enlace son botones vecinos que
     * hacen cosas distintas: con la misma etiqueta el operador no puede saber
     * cuál está tocando.
     */
    @Test
    fun escribirElIdentificadorYConfigurarElEnlaceNoSeLlamanIgual() {
        abrirSesion()
        val actividad = Robolectric.buildActivity(FieldMenuActivity::class.java).setup().get()

        val identificador = actividad.findViewById<Button>(R.id.btnIdentificador).text.toString()
        val configuracion = actividad.findViewById<Button>(R.id.btnConfiguracion).text.toString()

        assertNotEquals(identificador, configuracion)
    }

    /** El JWT del operador no puede quedar vivo en el proceso después del cierre. */
    @Test
    fun cerrarSesionDescartaElTokenYVuelveAlLogin() {
        abrirSesion()
        val controller = Robolectric.buildActivity(FieldMenuActivity::class.java).setup()
        val actividad = controller.get()

        actividad.findViewById<Button>(R.id.btnCerrarSesion).performClick()

        assertNull(SesionDeCampo.cliente)
        assertTrue(actividad.isFinishing)
        val siguiente = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertEquals(LoginActivity::class.java.name, siguiente.component?.className)
        assertEquals(
            actividad.getString(R.string.aviso_sesion_cerrada),
            siguiente.getStringExtra(LoginActivity.EXTRA_AVISO),
        )
        // El cierre queda en el registro del Comando Central con su motivo
        assertEquals(SesionDeCampo.Motivo.MANUAL, motivoDelCierre())
    }

    @Test
    fun conLaSesionVencidaVuelveAlLoginConElAviso() {
        // Sin sesión abierta el reloj ya está en cero: es el mismo camino que
        // cuando la cuenta regresiva llega al final estando la app abierta.
        val actividad = Robolectric.buildActivity(FieldMenuActivity::class.java).setup().get()

        assertTrue(actividad.isFinishing)
        val siguiente = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertNotNull(siguiente)
        assertEquals(LoginActivity::class.java.name, siguiente.component?.className)
        assertEquals(
            actividad.getString(R.string.aviso_sesion_vencida),
            siguiente.getStringExtra(LoginActivity.EXTRA_AVISO),
        )
    }

    @Test
    fun elRolSeMuestraTraducido() {
        abrirSesion(rol = "supervisor")
        val actividad = Robolectric.buildActivity(FieldMenuActivity::class.java).setup().get()

        assertEquals(
            "operador.campo · supervisor",
            actividad.findViewById<TextView>(R.id.txtQuien).text.toString(),
        )
    }

    // ---- La sesión efímera ----

    /** Con la pantalla a la vista, llegar a cero manda al login y el cierre se registra como vencimiento. */
    @Test
    fun alLlegarACeroLaCuentaRegresivaVuelveAlLogin() {
        abrirSesion(segundos = 3)
        val actividad = menu().get()
        assertFalse(actividad.isFinishing)

        shadowOf(getMainLooper()).idleFor(Duration.ofSeconds(4))

        assertTrue(actividad.isFinishing)
        val login = abrioLa(LoginActivity::class.java)
        assertNotNull(login)
        assertEquals(actividad.getString(R.string.aviso_sesion_vencida), login!!.getStringExtra(LoginActivity.EXTRA_AVISO))
        assertTrue((login.flags and Intent.FLAG_ACTIVITY_CLEAR_TOP) != 0)
        assertNull(SesionDeCampo.cliente)
        assertEquals(SesionDeCampo.Motivo.VENCIDA, motivoDelCierre())
    }

    /**
     * Con la operación encima, el menú está atrás: si la sesión vence en ese
     * momento, saltar al login cortaría la operación. Se espera a que el
     * operador vuelva al menú, y recién ahí se lo manda a iniciar sesión.
     */
    @Test
    fun siLaSesionVenceConOtraPantallaEncimaNoLaCortaYAvisaAlVolver() {
        abrirSesion(segundos = 3)
        val pantalla = menu()
        pantalla.pause().stop()

        shadowOf(getMainLooper()).idleFor(Duration.ofSeconds(5))

        assertFalse(pantalla.get().isFinishing)
        assertNull("con la operación encima no se salta al login", abrioLa(LoginActivity::class.java))

        pantalla.restart().resume()

        assertTrue(pantalla.get().isFinishing)
        val login = abrioLa(LoginActivity::class.java)
        assertEquals(pantalla.get().getString(R.string.aviso_sesion_vencida), login?.getStringExtra(LoginActivity.EXTRA_AVISO))
    }

    /**
     * Entre un tic y otro de la cuenta regresiva la sesión puede vencer: tocar
     * "Escanear" en ese hueco no puede abrir la cámara para un emparejamiento
     * que el Comando Central va a rechazar.
     */
    @Test
    fun escanearConLaSesionRecienVencidaVuelveAlLoginSinAbrirLaCamara() {
        abrirSesion(segundos = 3)
        permitir(Manifest.permission.CAMERA)
        val actividad = menu().get()
        ShadowSystemClock.advanceBy(Duration.ofSeconds(4))

        actividad.botonEscanear().performClick()

        assertTrue(actividad.isFinishing)
        val abiertas = pantallasAbiertas()
        assertNull(abrioLa(CaptureActivity::class.java, abiertas))
        assertEquals(actividad.getString(R.string.aviso_sesion_vencida), abrioLa(LoginActivity::class.java, abiertas)?.getStringExtra(LoginActivity.EXTRA_AVISO))
    }

    /** Salir con "atrás" cierra la sesión, pero no es "volver al login": la app se va. */
    @Test
    fun atrasCierraLaSesionYSaleSinPasarPorElLogin() {
        abrirSesion()
        val actividad = menu().get()

        actividad.onBackPressedDispatcher.onBackPressed()

        assertTrue(actividad.isFinishing)
        assertNull(SesionDeCampo.cliente)
        assertNull(abrioLa(LoginActivity::class.java))
        assertEquals(SesionDeCampo.Motivo.SALIDA, motivoDelCierre())
    }

    // ---- Escaneo del QR ----

    /**
     * El escáner se abre solo para QR, con el sticker como pista, vertical y
     * trabado (girar el teléfono mientras se apunta es lo que no se quiere) y
     * sin pitido.
     */
    @Test
    fun conPermisoDeCamaraAbreElEscanerDeQr() {
        abrirSesion()
        permitir(Manifest.permission.CAMERA)
        val actividad = menu().get()

        actividad.botonEscanear().performClick()

        val escaner = shadowOf(actividad).nextStartedActivityForResult?.intent
        assertNotNull(escaner)
        assertEquals(CaptureActivity::class.java.name, escaner!!.component?.className)
        assertEquals("QR_CODE", escaner.getStringExtra(Intents.Scan.FORMATS))
        assertEquals(actividad.getString(R.string.qr_pista), escaner.getStringExtra(Intents.Scan.PROMPT_MESSAGE))
        assertTrue(escaner.getBooleanExtra(Intents.Scan.ORIENTATION_LOCKED, false))
        assertFalse(escaner.getBooleanExtra(Intents.Scan.BEEP_ENABLED, true))
    }

    @Test
    fun sinPermisoDeCamaraLoPideYSiSeLoNieganLoDice() {
        abrirSesion()
        val actividad = menu().get()

        actividad.botonEscanear().performClick()
        val pedidos = contestarPermisos(actividad, concedido = false)

        assertEquals(listOf(Manifest.permission.CAMERA), pedidos)
        val aviso = actividad.getString(R.string.permiso_camara_denegado)
        assertEquals(aviso, actividad.estado())
        assertEquals(aviso, ShadowToast.getTextOfLatestToast())
        // El pedido de permiso también queda anotado "para resultado": se mira que no haya escáner entre ellos
        val paraResultado = generateSequence { shadowOf(actividad).nextStartedActivityForResult }.toList()
        assertTrue(
            "sin permiso no hay escáner",
            paraResultado.none { it.intent.component?.className == CaptureActivity::class.java.name },
        )
    }

    @Test
    fun alConcederElPermisoDeCamaraAbreElEscaner() {
        abrirSesion()
        val actividad = menu().get()

        actividad.botonEscanear().performClick()
        contestarPermisos(actividad, concedido = true)

        assertEquals(
            CaptureActivity::class.java.name,
            shadowOf(actividad).nextStartedActivityForResult?.intent?.component?.className,
        )
    }

    @Test
    fun siCancelaElEscaneoLoDice() {
        abrirSesion()
        permitir(Manifest.permission.CAMERA)
        val actividad = menu().get()

        actividad.botonEscanear().performClick()
        devolverEscaneo(actividad, contenido = null)

        assertEquals(actividad.getString(R.string.qr_cancelado), actividad.estado())
        assertTrue(comando.pedidos(RUTA_EMPAREJAR).isEmpty())
    }

    /** El QR de la wifi, el de la caja del dron: se descartan sin golpear el Comando Central. */
    @Test
    fun unQrQueNoEsDeUnDronNoLlegaAlComandoCentral() {
        abrirSesion()
        permitir(Manifest.permission.CAMERA)
        val actividad = menu().get()

        actividad.botonEscanear().performClick()
        devolverEscaneo(actividad, contenido = "WIFI:S:galpon;T:WPA;P:clave-de-la-red;;")

        assertEquals(actividad.getString(R.string.qr_invalido), actividad.estado())
        assertNull("ni siquiera pide la ubicación", shadowOf(actividad).lastRequestedPermission)
        assertTrue(comando.pedidos(RUTA_EMPAREJAR).isEmpty())
    }

    // ---- Emparejamiento ----

    /**
     * El flujo completo del campo: QR leído, el operador niega el GPS y el
     * despliegue NO se frena. El emparejamiento sale sin coordenadas y la
     * pantalla siguiente —conectar el dron físico— recibe la ficha entera.
     */
    @Test
    fun unQrDeDronEmparejaAunqueNieguenElGpsYPasaAConectarElDron() {
        abrirSesion()
        permitir(Manifest.permission.CAMERA)
        comando.aceptarEmparejamiento(HASH, "Alfa", "DJI Mini 4 Pro", BASE)
        val actividad = menu().get()

        actividad.botonEscanear().performClick()
        devolverEscaneo(actividad, contenido = HASH)
        val pedidos = contestarPermisos(actividad, concedido = false)
        esperarEnElHiloPrincipal("el emparejamiento") {
            comando.pedidos(RUTA_EMPAREJAR).isNotEmpty() && actividad.botonEscanear().isEnabled
        }

        assertEquals(listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), pedidos)
        val pedido = comando.pedidos(RUTA_EMPAREJAR).single()
        assertEquals("Bearer ${ComandoCentralFalso.JWT_OPERADOR}", pedido.autorizacion)
        assertEquals(HASH, pedido.cuerpo!!.getString("hash"))
        assertTrue(pedido.cuerpo.isNull("lat"))
        assertTrue(pedido.cuerpo.isNull("lon"))
        assertTrue(pedido.cuerpo.isNull("accuracyM"))
        assertEquals("${Build.MANUFACTURER} ${Build.MODEL}", pedido.cuerpo.getString("deviceModel"))
        assertEquals(actividad.getString(R.string.gps_sin_ubicacion), ShadowToast.getTextOfLatestToast())
        assertEquals("", actividad.estado())

        val conexion = abrioLa(ConexionDronActivity::class.java)
        assertNotNull(conexion)
        assertEquals(ComandoCentralFalso.TOKEN_DRON, conexion!!.getStringExtra(MainActivity.EXTRA_DRONE_TOKEN))
        assertEquals(HASH, conexion.getStringExtra(MainActivity.EXTRA_DRONE_HASH))
        assertEquals("Alfa", conexion.getStringExtra(MainActivity.EXTRA_DISPLAY_NAME))
        assertEquals(BASE.lat, conexion.getDoubleExtra(MainActivity.EXTRA_BASE_LAT, Double.NaN), 0.0)
        assertEquals(BASE.lon, conexion.getDoubleExtra(MainActivity.EXTRA_BASE_LON, Double.NaN), 0.0)
        assertEquals("DJI Mini 4 Pro", conexion.getStringExtra(ConexionDronActivity.EXTRA_MODELO_FICHA))
        assertEquals("Base Obelisco", conexion.getStringExtra(ConexionDronActivity.EXTRA_BASE_NOMBRE))
        assertFalse(conexion.getBooleanExtra(ConexionDronActivity.EXTRA_CON_UBICACION, true))

        // La sesión sigue viva por debajo: al terminar se vuelve al menú sin reingresar
        assertTrue(SesionDeCampo.vigente)
        assertFalse(actividad.isFinishing)
    }

    /**
     * Con el permiso de GPS dado pero sin ubicación, el despliegue no se frena:
     * el emparejamiento sale igual, sin coordenadas. Acá el proveedor de Google
     * falla enseguida (en Robolectric no hay Play Services, como en un teléfono
     * que no los tiene al día); el reloj se adelanta además los 10 s de espera
     * para que valga también si el proveedor se colgara sin contestar.
     */
    @Test
    fun conPermisoDeUbicacionPeroSinUbicacionEmparejaIgual() {
        abrirSesion()
        permitir(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION)
        comando.aceptarEmparejamiento(HASH, "Alfa", "DJI Mini 4 Pro", BASE)
        val actividad = menu().get()

        actividad.botonEscanear().performClick()
        devolverEscaneo(actividad, contenido = HASH)

        assertNull("con el permiso ya dado no lo vuelve a pedir", shadowOf(actividad).lastRequestedPermission)
        assertEquals(actividad.getString(R.string.gps_buscando), actividad.estado())
        assertFalse(actividad.botonEscanear().isEnabled)

        shadowOf(getMainLooper()).idleFor(Duration.ofSeconds(10))
        esperarEnElHiloPrincipal("el emparejamiento") {
            comando.pedidos(RUTA_EMPAREJAR).isNotEmpty() && actividad.botonEscanear().isEnabled
        }

        assertTrue(comando.pedidos(RUTA_EMPAREJAR).single().cuerpo!!.isNull("lat"))
        val conexion = abrioLa(ConexionDronActivity::class.java)
        assertNotNull(conexion)
        assertFalse(conexion!!.getBooleanExtra(ConexionDronActivity.EXTRA_CON_UBICACION, true))
    }

    /** Mientras el Comando Central no contesta, un segundo escaneo no puede salir. */
    @Test
    fun mientrasEmparejaNoSePuedeVolverAEscanear() {
        abrirSesion()
        permitir(Manifest.permission.CAMERA)
        comando.aceptarEmparejamiento(HASH, "Alfa", "DJI Mini 4 Pro", BASE)
        comando.retencion = CountDownLatch(1)
        val actividad = menu().get()

        actividad.botonEscanear().performClick()
        devolverEscaneo(actividad, contenido = HASH)
        contestarPermisos(actividad, concedido = false)
        esperarEnElHiloPrincipal("el pedido de emparejamiento") { comando.pedidos(RUTA_EMPAREJAR).isNotEmpty() }

        assertFalse(actividad.botonEscanear().isEnabled)
        assertEquals(actividad.getString(R.string.emparejando), actividad.estado())

        comando.retencion!!.countDown()
        esperarEnElHiloPrincipal("la respuesta del emparejamiento") { actividad.botonEscanear().isEnabled }
        assertNotNull(abrioLa(ConexionDronActivity::class.java))
    }

    /**
     * Sticker rayado o ilegible: el identificador se escribe a mano, con el
     * teclado en mayúsculas si viene así, y sale normalizado. Un dron sin base
     * asignada pasa sin coordenadas de base.
     */
    @Test
    fun elIdentificadorEscritoAManoSeNormalizaYEmpareja() {
        abrirSesion()
        comando.aceptarEmparejamiento(HASH, "Bravo", "DJI Mini 4 Pro", base = null)
        val actividad = menu().get()

        escribirIdentificador(actividad, HASH.uppercase()).tocar(DialogInterface.BUTTON_POSITIVE)
        contestarPermisos(actividad, concedido = false)
        esperarEnElHiloPrincipal("el emparejamiento") { comando.pedidos(RUTA_EMPAREJAR).isNotEmpty() && actividad.botonEscanear().isEnabled }

        assertEquals(HASH, comando.pedidos(RUTA_EMPAREJAR).single().cuerpo!!.getString("hash"))
        val conexion = abrioLa(ConexionDronActivity::class.java)
        assertNotNull(conexion)
        assertEquals("Bravo", conexion!!.getStringExtra(MainActivity.EXTRA_DISPLAY_NAME))
        assertTrue(conexion.getDoubleExtra(MainActivity.EXTRA_BASE_LAT, 0.0).isNaN())
        assertTrue(conexion.getDoubleExtra(MainActivity.EXTRA_BASE_LON, 0.0).isNaN())
        assertEquals("", conexion.getStringExtra(ConexionDronActivity.EXTRA_BASE_NOMBRE))
    }

    @Test
    fun unIdentificadorMalEscritoSeRechazaSinPreguntarAlComandoCentral() {
        abrirSesion()
        val actividad = menu().get()

        escribirIdentificador(actividad, "a3f9c1b2").tocar(DialogInterface.BUTTON_POSITIVE)

        assertEquals(actividad.getString(R.string.qr_invalido), actividad.estado())
        assertNull(shadowOf(actividad).lastRequestedPermission)
        assertTrue(comando.pedidos(RUTA_EMPAREJAR).isEmpty())
    }

    /** El campo no deja pasar más que los 32 caracteres del identificador. */
    @Test
    fun elCampoDelIdentificadorSeCortaEnTreintaYDosCaracteres() {
        abrirSesion()
        val actividad = menu().get()

        val dialogo = escribirIdentificador(actividad, HASH + "ffff")

        val campo = campoDeTexto(dialogo.window!!.decorView)!!
        assertEquals(HASH, campo.text.toString())
        assertEquals(actividad.getString(R.string.identificador_pista), campo.hint.toString())
    }

    @Test
    fun cancelarElIdentificadorNoHaceNada() {
        abrirSesion()
        val actividad = menu().get()

        escribirIdentificador(actividad, HASH).tocar(DialogInterface.BUTTON_NEGATIVE)

        assertNull(shadowOf(actividad).lastRequestedPermission)
        assertTrue(comando.pedidos(RUTA_EMPAREJAR).isEmpty())
        assertEquals("", actividad.estado())
    }

    /** Un QR que el Comando Central no conoce: se dice por qué y se puede volver a probar. */
    @Test
    fun siElDronNoEstaRegistradoLoDiceYDejaReintentar() {
        abrirSesion()
        comando.responder(RUTA_EMPAREJAR, 404, "")
        val actividad = menu().get()

        escribirIdentificador(actividad, HASH).tocar(DialogInterface.BUTTON_POSITIVE)
        contestarPermisos(actividad, concedido = false)
        esperarEnElHiloPrincipal("el rechazo del emparejamiento") { comando.pedidos(RUTA_EMPAREJAR).isNotEmpty() && actividad.botonEscanear().isEnabled }

        assertEquals(
            actividad.getString(R.string.emparejamiento_fallo, "Ese QR no corresponde a ningún dron registrado"),
            actividad.estado(),
        )
        assertNull(abrioLa(ConexionDronActivity::class.java))
        assertFalse(actividad.isFinishing)
        assertTrue(SesionDeCampo.vigente)
    }

    /**
     * El Comando Central rechaza el JWT aunque nuestro reloj todavía no llegó a
     * cero (el del servidor manda): eso es "se venció la sesión", no un error
     * cualquiera, y el operador tiene que volver a entrar.
     */
    @Test
    fun siElComandoCentralDiceQueVencioLaSesionVuelveAlLogin() {
        abrirSesion()
        comando.responder(RUTA_EMPAREJAR, 401, "")
        val actividad = menu().get()

        escribirIdentificador(actividad, HASH).tocar(DialogInterface.BUTTON_POSITIVE)
        contestarPermisos(actividad, concedido = false)
        esperarEnElHiloPrincipal("la vuelta al login") { actividad.isFinishing }

        val login = abrioLa(LoginActivity::class.java)
        assertEquals(actividad.getString(R.string.aviso_sesion_vencida), login?.getStringExtra(LoginActivity.EXTRA_AVISO))
        assertNull(SesionDeCampo.cliente)
        assertEquals(SesionDeCampo.Motivo.VENCIDA, motivoDelCierre())
    }

    /**
     * El operador tardó con el escáner y la sesión venció mientras tanto (el
     * menú estaba atrás, así que la cuenta regresiva no lo mandó al login).
     * Cualquier error del emparejamiento es entonces por la sesión: al login.
     */
    @Test
    fun siLaSesionVencioMientrasEscaneabaCualquierErrorVuelveAlLogin() {
        abrirSesion(segundos = 3)
        permitir(Manifest.permission.CAMERA)
        comando.responder(RUTA_EMPAREJAR, 500, JSONObject().put("error", "falla interna").toString())
        val pantalla = menu()
        val actividad = pantalla.get()

        actividad.botonEscanear().performClick()
        pantalla.pause()
        shadowOf(getMainLooper()).idleFor(Duration.ofSeconds(5))
        assertFalse(actividad.isFinishing)

        devolverEscaneo(actividad, contenido = HASH)
        contestarPermisos(actividad, concedido = false)
        esperarEnElHiloPrincipal("la vuelta al login") { actividad.isFinishing }

        val login = abrioLa(LoginActivity::class.java)
        assertEquals(actividad.getString(R.string.aviso_sesion_vencida), login?.getStringExtra(LoginActivity.EXTRA_AVISO))
    }

    // ---- Configuración del enlace ----

    /** El diálogo arranca con lo guardado, y la URL de la laptop solo se edita en modo RED. */
    @Test
    fun laConfiguracionMuestraLoGuardado() {
        PreferenciasEnlace(app).apply {
            urlComandoCentral = "https://otro.comando"
            modoEnlace = ModoEnlace.RED
            urlDeteccionRed = "ws://192.168.0.10:8765"
        }
        abrirSesion()
        val dialogo = abrirConfiguracion(menu().get())

        assertEquals("https://otro.comando", dialogo.findViewById<EditText>(R.id.editBackendUrl)!!.text.toString())
        assertEquals("ws://192.168.0.10:8765", dialogo.findViewById<EditText>(R.id.editUrlDeteccion)!!.text.toString())
        assertEquals(com.tesis.dronepatrol.Config.PLANTILLA_URL_DETECCION_RED, dialogo.findViewById<EditText>(R.id.editUrlDeteccion)!!.hint.toString())
        assertTrue(dialogo.findViewById<RadioButton>(R.id.radioRed)!!.isChecked)
        val urlLaptop = dialogo.findViewById<TextInputLayout>(R.id.layoutUrlDeteccion)!!
        assertTrue(urlLaptop.isEnabled)

        dialogo.findViewById<RadioButton>(R.id.radioAuto)!!.performClick()
        assertFalse("en AUTO la URL la anuncia la laptop", urlLaptop.isEnabled)
        dialogo.findViewById<RadioButton>(R.id.radioRed)!!.performClick()
        assertTrue(urlLaptop.isEnabled)
    }

    @Test
    fun enCableLaUrlDeLaLaptopNoSeEdita() {
        PreferenciasEnlace(app).modoEnlace = ModoEnlace.CABLE
        abrirSesion()
        val dialogo = abrirConfiguracion(menu().get())

        assertTrue(dialogo.findViewById<RadioButton>(R.id.radioCable)!!.isChecked)
        assertFalse(dialogo.findViewById<TextInputLayout>(R.id.layoutUrlDeteccion)!!.isEnabled)
    }

    /** RED sin URL se guarda igual, pero se avisa: sin URL no hay detección. */
    @Test
    fun guardarEnRedSinUrlAvisaQueNoHabraDeteccion() {
        abrirSesion()
        val actividad = menu().get()
        val dialogo = abrirConfiguracion(actividad)
        assertTrue("de fábrica, AUTO", dialogo.findViewById<RadioButton>(R.id.radioAuto)!!.isChecked)

        dialogo.findViewById<RadioButton>(R.id.radioRed)!!.performClick()
        dialogo.tocar(DialogInterface.BUTTON_POSITIVE)

        assertEquals(ModoEnlace.RED, PreferenciasEnlace(app).modoEnlace)
        val aviso = actividad.getString(R.string.enlace_falta_url_red)
        assertEquals(aviso, actividad.estado())
        assertEquals(aviso, ShadowToast.getTextOfLatestToast())
        assertFalse(actividad.isFinishing)
    }

    @Test
    fun guardarEnRedConLaUrlDeLaLaptopLaRecuerda() {
        abrirSesion()
        val actividad = menu().get()
        val dialogo = abrirConfiguracion(actividad)

        dialogo.findViewById<RadioButton>(R.id.radioRed)!!.performClick()
        dialogo.findViewById<EditText>(R.id.editUrlDeteccion)!!.setText(" ws://192.168.0.10:8765 ")
        dialogo.tocar(DialogInterface.BUTTON_POSITIVE)

        val preferencias = PreferenciasEnlace(app)
        assertEquals(ModoEnlace.RED, preferencias.modoEnlace)
        assertEquals("ws://192.168.0.10:8765", preferencias.urlDeteccionRed)
        assertEquals("", actividad.estado())
    }

    /** Cambiar solo el modo no toca el Comando Central: la sesión sigue. */
    @Test
    fun cambiarSoloElModoNoCierraLaSesion() {
        abrirSesion()
        val actividad = menu().get()
        val dialogo = abrirConfiguracion(actividad)

        dialogo.findViewById<RadioButton>(R.id.radioCable)!!.performClick()
        dialogo.tocar(DialogInterface.BUTTON_POSITIVE)

        assertEquals(ModoEnlace.CABLE, PreferenciasEnlace(app).modoEnlace)
        assertEquals(com.tesis.dronepatrol.Config.URL_COMANDO_CENTRAL_POR_DEFECTO, PreferenciasEnlace(app).urlComandoCentral)
        assertFalse(actividad.isFinishing)
        assertTrue(SesionDeCampo.vigente)
        assertNull(abrioLa(LoginActivity::class.java))
    }

    /**
     * El JWT vale contra el Comando Central donde se pidió: con otra dirección
     * la sesión en la mano ya no sirve, y se vuelve a entrar. El cierre se le
     * avisa al Comando Central viejo, que es donde estaba abierta.
     */
    @Test
    fun cambiarElComandoCentralCierraLaSesionYVuelveAlLogin() {
        abrirSesion()
        val actividad = menu().get()
        val dialogo = abrirConfiguracion(actividad)

        dialogo.findViewById<EditText>(R.id.editBackendUrl)!!.setText("  https://nuevo.comando  ")
        dialogo.tocar(DialogInterface.BUTTON_POSITIVE)

        assertEquals("https://nuevo.comando", PreferenciasEnlace(app).urlComandoCentral)
        assertTrue(actividad.isFinishing)
        assertNull(SesionDeCampo.cliente)
        val login = abrioLa(LoginActivity::class.java)
        assertEquals(actividad.getString(R.string.aviso_cambio_comando_central), login?.getStringExtra(LoginActivity.EXTRA_AVISO))
        assertEquals(SesionDeCampo.Motivo.CAMBIO_SERVIDOR, motivoDelCierre())
        assertTrue(comando.pedidos(RUTA_LOGOUT).single().url.startsWith(ComandoCentralFalso.URL))
    }

    /** Borrar la URL sin querer no deja a la app sin Comando Central. */
    @Test
    fun dejarLaUrlVaciaConservaLaQueEstaba() {
        PreferenciasEnlace(app).urlComandoCentral = "https://otro.comando"
        abrirSesion()
        val actividad = menu().get()
        val dialogo = abrirConfiguracion(actividad)

        dialogo.findViewById<EditText>(R.id.editBackendUrl)!!.setText("   ")
        dialogo.tocar(DialogInterface.BUTTON_POSITIVE)

        assertEquals("https://otro.comando", PreferenciasEnlace(app).urlComandoCentral)
        assertFalse(actividad.isFinishing)
        assertTrue(SesionDeCampo.vigente)
    }

    @Test
    fun cancelarLaConfiguracionNoGuardaNada() {
        abrirSesion()
        val actividad = menu().get()
        val dialogo = abrirConfiguracion(actividad)

        dialogo.findViewById<RadioButton>(R.id.radioRed)!!.performClick()
        dialogo.findViewById<EditText>(R.id.editBackendUrl)!!.setText("https://nuevo.comando")
        dialogo.tocar(DialogInterface.BUTTON_NEGATIVE)

        val preferencias = PreferenciasEnlace(app)
        assertEquals(ModoEnlace.AUTO, preferencias.modoEnlace)
        assertEquals(com.tesis.dronepatrol.Config.URL_COMANDO_CENTRAL_POR_DEFECTO, preferencias.urlComandoCentral)
        assertFalse(actividad.isFinishing)
    }
}
