package com.tesis.dronepatrol

import android.content.Intent
import android.os.Looper.getMainLooper
import android.widget.Button
import android.widget.TextView
import com.tesis.dronepatrol.drone.DronEnCurso
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.SesionOperador
import com.tesis.dronepatrol.patrol.DronEspia
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * La pantalla que conecta con el dron físico: hasta que la aeronave no está
 * enlazada no se puede desplegar, y al desplegar la sesión del operador de
 * campo sigue viva.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConexionDronActivityTest {

    private val dron = DronEspia()

    @After
    fun desarmar() {
        DronEnCurso.soltar()
        SesionDeCampo.cerrar()
    }

    private fun abrir(): ConexionDronActivity {
        DronEnCurso.usar(dron)
        val intent = Intent(RuntimeEnvironment.getApplication(), ConexionDronActivity::class.java)
            .putExtra(MainActivity.EXTRA_DRONE_TOKEN, "token-de-prueba")
            .putExtra(MainActivity.EXTRA_DRONE_HASH, "0123456789abcdef0123456789abcdef")
            .putExtra(MainActivity.EXTRA_DISPLAY_NAME, "Alfa")
            .putExtra(ConexionDronActivity.EXTRA_MODELO_FICHA, "DJI Mini 4 Pro")
            .putExtra(ConexionDronActivity.EXTRA_BASE_NOMBRE, "Base Obelisco")
        return Robolectric.buildActivity(ConexionDronActivity::class.java, intent).setup().get()
    }

    @Test
    fun sinElDronConectadoNoSePuedeDesplegar() {
        dron.estado.value = EstadoDelDron.DESCONOCIDO.copy(detalle = "Conectá el control al teléfono por USB y encendé el dron")
        val actividad = abrir()
        shadowOf(getMainLooper()).idle()

        assertFalse(actividad.findViewById<Button>(R.id.btnDesplegar).isEnabled)
        assertFalse(actividad.findViewById<Button>(R.id.btnModoPrueba).isEnabled)
        assertEquals(
            "Conectá el control al teléfono por USB y encendé el dron",
            actividad.findViewById<TextView>(R.id.txtAyuda).text.toString(),
        )
        assertEquals("Alfa", actividad.findViewById<TextView>(R.id.txtNombreDron).text.toString())
        assertTrue(dron.ordenes.contains("connect"))
    }

    @Test
    fun conElDronEnlazadoSeHabilitaYMuestraModeloYSerie() {
        val actividad = abrir()
        dron.estado.value = EstadoDelDron(
            sdkListo = true, conectado = true, modelo = "MINI 4 PRO", enVuelo = false,
            satelites = 12, baseFijada = true, controlConectado = true, serie = "1581F7",
        )
        shadowOf(getMainLooper()).idle()

        assertTrue(actividad.findViewById<Button>(R.id.btnDesplegar).isEnabled)
        assertTrue(actividad.findViewById<Button>(R.id.btnModoPrueba).isEnabled)
        val aeronave = actividad.findViewById<android.view.View>(R.id.filaAeronave).findViewById<TextView>(R.id.detalle)
        assertEquals("MINI 4 PRO · serie 1581F7", aeronave.text.toString())
        assertEquals(actividad.getString(R.string.conexion_listo), actividad.findViewById<TextView>(R.id.txtAyuda).text.toString())
    }

    /** Si la ficha dice un modelo y la aeronave otro, se avisa (puede ser otro dron). */
    @Test
    fun avisaSiLaAeronaveNoEsDelModeloDeLaFicha() {
        val actividad = abrir()
        dron.estado.value = EstadoDelDron(
            sdkListo = true, conectado = true, modelo = "MINI 3", enVuelo = false,
            satelites = 12, baseFijada = true, controlConectado = true, serie = "X",
        )
        shadowOf(getMainLooper()).idle()

        val aviso = actividad.findViewById<TextView>(R.id.txtAvisoModelo)
        assertEquals(android.view.View.VISIBLE, aviso.visibility)
        assertTrue(aviso.text.toString().contains("MINI 3"))
    }

    @Test
    fun desplegarVaALaOperacionSinCerrarLaSesionDelOperador() {
        SesionDeCampo.abrir(SesionDeCampo.nuevoCliente(), SesionOperador("operador.campo", "field_operator", 1200))
        val actividad = abrir()
        dron.estado.value = EstadoDelDron(
            sdkListo = true, conectado = true, modelo = "MINI 4 PRO", enVuelo = false,
            satelites = 12, baseFijada = true, controlConectado = true,
        )
        shadowOf(getMainLooper()).idle()

        actividad.findViewById<Button>(R.id.btnDesplegar).performClick()

        val siguiente = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertNotNull(siguiente)
        assertEquals(MainActivity::class.java.name, siguiente.component?.className)
        assertEquals("DEPLOY", siguiente.getStringExtra(MainActivity.EXTRA_MODE))
        assertEquals("token-de-prueba", siguiente.getStringExtra(MainActivity.EXTRA_DRONE_TOKEN))
        assertTrue("la sesión de campo tiene que seguir viva", SesionDeCampo.vigente)
        assertTrue(actividad.isFinishing)
        // El controlador sigue encendido para la pantalla de operación
        assertFalse(dron.ordenes.contains("disconnect"))
    }

    @Test
    fun volverApagaElControladorYNoVaAlLogin() {
        SesionDeCampo.abrir(SesionDeCampo.nuevoCliente(), SesionOperador("operador.campo", "field_operator", 1200))
        val actividad = abrir()

        actividad.findViewById<Button>(R.id.btnVolver).performClick()

        assertTrue(actividad.isFinishing)
        assertTrue(dron.ordenes.contains("disconnect"))
        assertEquals(null, shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity)
        assertTrue(SesionDeCampo.vigente)
    }
}
