package com.tesis.dronepatrol

import android.net.wifi.WifiManager
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.google.android.material.materialswitch.MaterialSwitch
import com.tesis.dronepatrol.BancoDeOperacion.Companion.COSTANERA
import com.tesis.dronepatrol.BancoDeOperacion.Companion.RESERVA
import com.tesis.dronepatrol.comms.DetectionClient
import com.tesis.dronepatrol.comms.ModoEnlace
import com.tesis.dronepatrol.drone.SimulatedDroneController
import com.tesis.dronepatrol.patrol.DronEspia
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

/**
 * Los dos enlaces de la pantalla de operación —Comando Central y detección— y
 * los controles del simulador. Un enlace que no engancha tiene que decirlo con
 * el motivo, nunca fallar mudo: en el campo es lo único que le dice al operador
 * qué ir a revisar.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityEnlacesTest {

    private var banco = BancoDeOperacion(DronEspia())

    @After
    fun desarmar() = banco.desarmar()

    private fun MainActivity.texto(id: Int): String = findViewById<TextView>(id).text.toString()

    private fun MainActivity.colorDelTexto(id: Int): Int = findViewById<TextView>(id).currentTextColor

    private fun MainActivity.color(id: Int): Int = ContextCompat.getColor(this, id)

    // ---- Comando Central ----

    /**
     * Si el Comando Central no contesta, la pantalla lo dice con el motivo y
     * ofrece reintentar; sin rutas no se le habla al dron. Al reintentar con el
     * servidor de vuelta, carga las rutas y arranca.
     */
    @Test
    fun siElComandoCentralNoContestaLoDiceYAlReintentarArranca() {
        val dron = DronEspia()
        banco = BancoDeOperacion(dron).apply { falloAlPedirRutas = "No se pudieron obtener las rutas: HTTP 503" }
        val pantalla = banco.abrir()

        assertEquals(
            pantalla.getString(R.string.main_error_conexion, "No se pudieron obtener las rutas: HTTP 503"),
            pantalla.texto(R.id.txtConnStatus),
        )
        assertEquals(View.VISIBLE, pantalla.findViewById<View>(R.id.btnRetry).visibility)
        assertEquals("No se pudieron obtener las rutas: HTTP 503", ShadowToast.getTextOfLatestToast())
        assertFalse("sin Comando Central no se enciende el dron", dron.ordenes.contains("connect"))

        banco.comando.falloAlPedirRutas = null
        banco.comando.rutas = listOf(COSTANERA, RESERVA)
        pantalla.findViewById<Button>(R.id.btnRetry).performClick()
        correrLaPantalla()

        assertEquals(View.GONE, pantalla.findViewById<View>(R.id.btnRetry).visibility)
        assertEquals("Costanera", pantalla.texto(R.id.dropdownRoutes))
        assertTrue(dron.ordenes.contains("connect"))
        assertEquals("se reintenta abriendo el socket de nuevo", 2, banco.comando.conexionesPedidas)
        // Las rutas llegaron pero el socket todavía no abrió
        assertEquals(pantalla.getString(R.string.main_sin_enlace), pantalla.texto(R.id.txtConnStatus))
        assertEquals(pantalla.color(R.color.estado_alerta), pantalla.colorDelTexto(R.id.txtConnStatus))
    }

    @Test
    fun conElSocketAbiertoDiceCuantasRutasHayYAlCaerseQueReintenta() {
        banco.rutas = listOf(COSTANERA, RESERVA)
        val pantalla = banco.abrir()

        banco.comando.connected.value = true
        correrLaPantalla()
        assertEquals(pantalla.resources.getQuantityString(R.plurals.main_rutas_conectado, 2, 2), pantalla.texto(R.id.txtConnStatus))
        assertEquals(pantalla.color(R.color.estado_ok), pantalla.colorDelTexto(R.id.txtConnStatus))

        banco.comando.connected.value = false
        correrLaPantalla()
        assertEquals(pantalla.getString(R.string.main_sin_enlace), pantalla.texto(R.id.txtConnStatus))
        assertEquals(pantalla.color(R.color.estado_alerta), pantalla.colorDelTexto(R.id.txtConnStatus))
    }

    // ---- Detección ----

    private fun cantidadDeCandados(): Int =
        shadowOf(RuntimeEnvironment.getApplication().getSystemService(WifiManager::class.java)).activeLockCount

    /**
     * En AUTO la app busca la laptop por los anuncios de la Wi-Fi, y para que
     * los broadcast lleguen toma el candado de multicast, que suelta al cerrar.
     */
    @Test
    fun enAutomaticoBuscaLaLaptopConElCandadoDeMulticastTomado() {
        banco.modoEnlace = ModoEnlace.AUTO
        val pantalla = banco.abrir()

        assertEquals(pantalla.getString(R.string.main_deteccion_fallo, DetectionClient.BUSCANDO), pantalla.texto(R.id.txtDetectionStatus))
        assertEquals(1, cantidadDeCandados())

        banco.deteccion.connected.value = true
        correrLaPantalla()
        val etiqueta = pantalla.getString(R.string.main_enlace_auto)
        assertEquals(pantalla.getString(R.string.main_deteccion_conectada, etiqueta), pantalla.texto(R.id.txtDetectionStatus))
        assertEquals(pantalla.color(R.color.estado_ok), pantalla.colorDelTexto(R.id.txtDetectionStatus))

        // Se cayó y todavía no hay motivo: se dice que se está enlazando
        banco.deteccion.connected.value = false
        banco.deteccion.ultimoFallo.value = null
        correrLaPantalla()
        assertEquals(pantalla.getString(R.string.main_deteccion_esperando, etiqueta), pantalla.texto(R.id.txtDetectionStatus))
        assertEquals(pantalla.color(R.color.texto_medio), pantalla.colorDelTexto(R.id.txtDetectionStatus))

        banco.cerrar()
        assertEquals("al cerrar se suelta el candado", 0, cantidadDeCandados())
    }

    @Test
    fun enDireccionManualSinUrlDiceQueFalta() {
        banco.modoEnlace = ModoEnlace.RED
        val pantalla = banco.abrir()

        val texto = pantalla.texto(R.id.txtDetectionStatus)
        assertEquals(pantalla.getString(R.string.main_deteccion_fallo, banco.deteccion.ultimoFallo.value), texto)
        assertTrue(texto, texto.contains("Falta la URL del software de detección"))
        assertEquals("fuera de AUTO no hace falta el candado", 0, cantidadDeCandados())
    }

    /** Por cable, sin el túnel de adb la pantalla dice qué correr en la laptop. */
    @Test
    fun porCableSinElTunelDiceQueCorrerEnLaLaptop() {
        banco.modoEnlace = ModoEnlace.CABLE
        val pantalla = banco.abrir()

        esperarEnLaPantalla("el motivo del fallo por cable") {
            pantalla.texto(R.id.txtDetectionStatus).contains("adb reverse tcp:8765 tcp:8765")
        }
        assertEquals(
            pantalla.getString(R.string.main_deteccion_fallo, banco.deteccion.ultimoFallo.value),
            pantalla.texto(R.id.txtDetectionStatus),
        )

        banco.deteccion.connected.value = true
        correrLaPantalla()
        assertEquals(
            pantalla.getString(R.string.main_deteccion_conectada, pantalla.getString(R.string.main_enlace_cable)),
            pantalla.texto(R.id.txtDetectionStatus),
        )
    }

    // ---- Simulación ----

    /** Los controles de la demo actúan sobre el dron simulado, y recargar avisa al Comando Central. */
    @Test
    fun enModoPruebaLosControlesDeSimulacionMandanSobreElSimulador() {
        val sim = SimulatedDroneController()
        banco = BancoDeOperacion(sim)
        val pantalla = banco.abrir(modo = "TEST")
        assertEquals(View.VISIBLE, pantalla.findViewById<View>(R.id.cardSim).visibility)

        pantalla.findViewById<Button>(R.id.btnLowBattery).performClick()
        esperarEnLaPantalla("la batería forzada en la telemetría") {
            pantalla.texto(R.id.txtBattery) == pantalla.getString(R.string.main_bateria_pct, 24)
        }

        pantalla.findViewById<Button>(R.id.btnRecharge).performClick()
        correrLaPantalla()
        assertEquals(1, banco.comando.eventos("BATTERY_RECHARGED").size)
        esperarEnLaPantalla("la batería recargada en la telemetría") {
            pantalla.texto(R.id.txtBattery) == pantalla.getString(R.string.main_bateria_pct, 100)
        }

        val perdida = pantalla.findViewById<MaterialSwitch>(R.id.switchSignalLoss)
        perdida.isChecked = true
        assertTrue(sim.signalLost)
        perdida.isChecked = false
        assertFalse(sim.signalLost)
    }

    @Test
    fun enDespliegueNoHayControlesDeSimulacion() {
        banco = BancoDeOperacion(SimulatedDroneController())
        val pantalla = banco.abrir(modo = "DEPLOY")

        assertEquals(View.GONE, pantalla.findViewById<View>(R.id.cardSim).visibility)
    }

    @Test
    fun conUnDronQueNoEsElSimuladorNoHayControlesDeSimulacion() {
        val pantalla = banco.abrir(modo = "TEST")

        assertEquals(View.GONE, pantalla.findViewById<View>(R.id.cardSim).visibility)
    }

    /** El simulador despega y vuelve a la base que tiene cargada el dron emparejado. */
    @Test
    fun elSimuladorArrancaEnLaBaseDelDronEmparejado() {
        banco = BancoDeOperacion(SimulatedDroneController())
        val pantalla = banco.abrir(baseLat = -31.4201, baseLon = -64.1888)

        val esperada = pantalla.getString(R.string.main_posicion_valor, -31.4201, -64.1888)
        esperarEnLaPantalla("la posición de la base de Córdoba") { pantalla.texto(R.id.txtPosition) == esperada }
    }

    /**
     * Con el dron real la base la registra la propia aeronave al despegar: abrir
     * la pantalla solo lo conecta, aunque el emparejamiento traiga una base.
     */
    @Test
    fun conElDronRealAbrirLaPantallaSoloLoConecta() {
        val dron = DronEspia()
        banco = BancoDeOperacion(dron)
        banco.abrir(baseLat = -31.4201, baseLon = -64.1888)

        assertEquals(listOf("connect"), dron.ordenes)
    }

    /** Media coordenada no es una base: el simulador se queda en la suya. */
    @Test
    fun sinLaLongitudDeLaBaseElSimuladorSeQuedaEnLaSuya() {
        banco = BancoDeOperacion(SimulatedDroneController())
        val pantalla = banco.abrir(baseLat = -31.4201)

        val obelisco = pantalla.getString(R.string.main_posicion_valor, -34.6037, -58.3816)
        esperarEnLaPantalla("la posición de la base del simulador") { pantalla.texto(R.id.txtPosition) == obelisco }
    }
}
