package com.tesis.dronepatrol

import android.view.View
import android.widget.TextView
import com.google.android.material.materialswitch.MaterialSwitch
import com.tesis.dronepatrol.comms.MensajesDeLaApp
import com.tesis.dronepatrol.patrol.ColaDeEmergencia
import com.tesis.dronepatrol.patrol.DronEspia
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
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
 * Lo que la pantalla de operación muestra de los relevos y las emergencias
 * (docs/RELEVOS.md §0, §2.4 y §5): el interruptor «En espera para relevos», que
 * solo se prende con el dron en el suelo y vuelve a apagado si no se pudo; la
 * cuenta regresiva de un despegue de relevo, con «Cancelar»; y la última
 * posición de un aterrizaje de emergencia, fija aunque la app se reinicie.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityRelevosTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
    }

    private val dron = DronEspia(conRelevos = true)
    private val banco = BancoDeOperacion(dron)

    @After
    fun desarmar() = banco.desarmar()

    private fun MainActivity.interruptor(): MaterialSwitch = findViewById(R.id.switchEnEspera)

    private fun MainActivity.texto(id: Int): String = findViewById<TextView>(id).text.toString()

    private fun MainActivity.visible(id: Int): Boolean = findViewById<View>(id).visibility == View.VISIBLE

    /** El dron en el suelo, en su base, con la batería llena y el Comando Central conectado. */
    private fun enTierra() = runBlocking {
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        banco.comando.connected.value = true
        banco.comando.manejarMensaje(
            JSONObject()
                .put("type", "bases")
                .put("propiaId", 1)
                .put(
                    "bases",
                    JSONArray().put(
                        JSONObject().put("id", 1).put("nombre", "Norte").put("lat", LAT).put("lon", LON)
                            .put("aterrizajeLat", JSONObject.NULL).put("aterrizajeLon", JSONObject.NULL),
                    ),
                )
                .toString(),
        )
        dron.emitirTelemetria(LAT, LON, bateria = 95.0, alt = 0.0)
        correrLaPantalla()
    }

    @Test
    fun elInterruptorSePrendeSoloConElDronEnElSuelo() {
        val pantalla = banco.abrir()
        assertFalse("en el aire no se puede", pantalla.interruptor().isEnabled)

        enTierra()
        esperarEnLaPantalla("el interruptor habilitado") { pantalla.interruptor().isEnabled }
        pantalla.interruptor().isChecked = true
        correrLaPantalla()
        assertTrue(pantalla.interruptor().isChecked)
        // El status sale una vez por segundo.
        adelantarElReloj(2)
        assertTrue(banco.comando.mensajes("status").last().getJSONObject("relevo").getBoolean("enEspera"))

        pantalla.interruptor().isChecked = false
        correrLaPantalla()
        assertFalse(pantalla.interruptor().isChecked)
    }

    @Test
    fun siNoSePudoPrenderVuelveAApagado() {
        val pantalla = banco.abrir()
        enTierra()
        banco.comando.connected.value = false
        correrLaPantalla()
        esperarEnLaPantalla("el interruptor habilitado") { pantalla.interruptor().isEnabled }
        pantalla.interruptor().isChecked = true
        correrLaPantalla()
        assertFalse("sin el Comando Central no queda prendido", pantalla.interruptor().isChecked)
    }

    @Test
    fun laCuentaRegresivaSeVeYCancelarNoDespega() {
        val pantalla = banco.abrir()
        enTierra()
        esperarEnLaPantalla("el interruptor habilitado") { pantalla.interruptor().isEnabled }
        pantalla.interruptor().isChecked = true
        correrLaPantalla()
        assertFalse(pantalla.visible(R.id.cardCuentaRegresiva))

        val ruta = JSONObject().put("id", 1).put("name", "Costanera").put(
            "waypoints",
            JSONArray()
                .put(JSONObject().put("lat", LAT + 0.001).put("lon", LON).put("alt", 40))
                .put(JSONObject().put("lat", LAT).put("lon", LON + 0.001).put("alt", 40)),
        )
        banco.comando.manejarMensaje(
            JSONObject().put("type", "relay_start").put("relayId", 5).put("motivo", "patrulla").put("ruta", ruta)
                .put("fromIndex", 1)
                .put("de", JSONObject().put("droneId", "a3f9c1b27d5e4408f61a9c3e772b7e42").put("displayName", "Alfa"))
                .toString(),
        )
        esperarEnLaPantalla("la cuenta regresiva") {
            pantalla.visible(R.id.cardCuentaRegresiva) &&
                pantalla.texto(R.id.txtCuentaRegresiva) == pantalla.getString(R.string.main_relevo_cuenta, 10)
        }
        assertTrue(pantalla.texto(R.id.txtCuentaRegresivaDetalle).contains("Alfa"))
        assertEquals(1, banco.comando.mensajes("relay_accept").size)

        // Terminada la cuenta, un relevo de patrulla espera que A esté abajo.
        banco.adelantoDelRelojMs += 10_000
        adelantarElReloj(1)
        esperarEnLaPantalla("la espera del go") {
            pantalla.texto(R.id.txtCuentaRegresiva) == pantalla.getString(R.string.main_relevo_esperando, "Alfa")
        }

        pantalla.findViewById<View>(R.id.btnCancelarRelevo).performClick()
        esperarEnLaPantalla("el rechazo") { banco.comando.mensajes("relay_reject").isNotEmpty() }
        assertEquals("cancelado_en_campo", banco.comando.mensajes("relay_reject").last().getString("motivo"))
        esperarEnLaPantalla("la cuenta escondida") { !pantalla.visible(R.id.cardCuentaRegresiva) }
    }

    @Test
    fun laUltimaPosicionDeUnaEmergenciaQuedaFijaAunqueLaAppSeReinicie() {
        val cola = ColaDeEmergencia(banco.almacenDeEmergencias)
        cola.abrir(MensajesDeLaApp.emergencyLanding("ref-1", "autonomia", -34.870210, -56.190180, 38.0, 9.0, 1_000L))
        val pantalla = banco.abrir()
        assertTrue(pantalla.visible(R.id.cardUltimaUbicacion))
        assertEquals(pantalla.getString(R.string.main_emergencia_bajando), pantalla.texto(R.id.txtUltimaUbicacionEstado))
        assertEquals(pantalla.getString(R.string.main_emergencia_posicion, -34.870210, -56.190180), pantalla.texto(R.id.txtUltimaUbicacion))
    }

    @Test
    fun conElAterrizajeDiceDondeQuedo() {
        val cola = ColaDeEmergencia(banco.almacenDeEmergencias)
        cola.abrir(MensajesDeLaApp.emergencyLanding("ref-1", "autonomia", -34.870210, -56.190180, 38.0, 9.0, 1_000L))
        cola.agregarAterrizaje("ref-1", MensajesDeLaApp.emergencyLanded("ref-1", -34.870300, -56.190100, 0.2, 2_000L))
        val pantalla = banco.abrir()
        assertEquals(pantalla.getString(R.string.main_emergencia_aterrizo), pantalla.texto(R.id.txtUltimaUbicacionEstado))
        assertEquals(pantalla.getString(R.string.main_emergencia_posicion, -34.870300, -56.190100), pantalla.texto(R.id.txtUltimaUbicacion))
    }

    @Test
    fun sinEmergenciaNoHayTarjeta() {
        val pantalla = banco.abrir()
        assertFalse(pantalla.visible(R.id.cardUltimaUbicacion))
        assertFalse(pantalla.visible(R.id.cardCuentaRegresiva))
    }
}
