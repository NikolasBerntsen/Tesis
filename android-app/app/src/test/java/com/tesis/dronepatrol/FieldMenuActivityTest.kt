package com.tesis.dronepatrol

import android.os.Looper.getMainLooper
import android.widget.Button
import android.widget.TextView
import com.tesis.dronepatrol.model.SesionOperador
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Menú de campo: la cuenta regresiva de la sesión efímera y las cuatro acciones.
 * Nada de esto pide GPS ni cámara —eso recién pasa al escanear—, así que la
 * pantalla se puede armar entera en Robolectric.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FieldMenuActivityTest {

    private companion object {
        const val VEINTE_MINUTOS_S = 20L * 60
    }

    private fun abrirSesion(segundos: Long = VEINTE_MINUTOS_S, rol: String = "field_operator") {
        SesionDeCampo.abrir(
            SesionDeCampo.nuevoCliente(),
            SesionOperador(username = "operador.campo", role = rol, expiresIn = segundos),
        )
    }

    // La sesión vive en el proceso: sin esto se filtra de un test al siguiente
    @After
    fun cerrarSesion() {
        SesionDeCampo.cerrar()
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
}
