package com.tesis.dronepatrol

import android.content.DialogInterface
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import com.google.android.material.textfield.MaterialAutoCompleteTextView
import com.tesis.dronepatrol.BancoDeOperacion.Companion.COSTANERA
import com.tesis.dronepatrol.BancoDeOperacion.Companion.RESERVA
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.patrol.DronEspia
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowListPopupWindow

/**
 * Las rutas y los botones de vuelo de la pantalla de operación. Cada botón se
 * prende solo cuando su orden tiene sentido, el estado del patrullaje se lee
 * arriba del video, y las órdenes que no tienen vuelta atrás desde el teléfono
 * (despegar, volver a base, aterrizar) se confirman antes de llegar al dron.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityPatrullajeTest {

    private val dron = DronEspia()
    private val banco = BancoDeOperacion(dron).apply { rutas = listOf(COSTANERA, RESERVA) }

    @After
    fun desarmar() = banco.desarmar()

    private fun MainActivity.texto(id: Int): String = findViewById<TextView>(id).text.toString()

    private fun MainActivity.boton(id: Int): Button = findViewById(id)

    private fun MainActivity.tocar(id: Int) {
        boton(id).performClick()
        correrLaPantalla()
    }

    private fun MainActivity.estado(): String = texto(R.id.txtState)

    /** Los seis botones de vuelo, en orden: comenzar, despegar aquí, detener, reanudar, volver, aterrizar. */
    private fun MainActivity.botonesPrendidos(): List<Boolean> =
        listOf(R.id.btnStartPatrol, R.id.btnDespegarAqui, R.id.btnStopPatrol, R.id.btnResumePatrol, R.id.btnReturnHome, R.id.btnLand)
            .map { boton(it).isEnabled }

    private fun responder(dialogo: AlertDialog?, boton: Int) {
        dialogo!!.getButton(boton).performClick()
        correrLaPantalla()
    }

    private fun mensajeDe(dialogo: AlertDialog?): String =
        dialogo!!.findViewById<TextView>(android.R.id.message)?.text.toString()

    private fun enElSuelo(satelites: Int = 12, base: Boolean = true, detalle: String = "") {
        dron.estado.value = dron.estado.value.copy(enVuelo = false, satelites = satelites, baseFijada = base, detalle = detalle)
    }

    // ---- Rutas ----

    @Test
    fun laPrimeraRutaQuedaElegidaConSusNodosYSuAltura() {
        val pantalla = banco.abrir()

        assertEquals("las rutas por su nombre, en el orden del servidor", listOf("Costanera", "Reserva"), pantalla.opcionesDelDesplegable())
        assertEquals("Costanera", pantalla.texto(R.id.dropdownRoutes))
        val esperado = pantalla.resources.getQuantityString(R.plurals.main_waypoints, 3, 3) + " · " +
            pantalla.getString(R.string.main_altura_m, 40.0)
        assertEquals(esperado, pantalla.texto(R.id.txtRouteInfo))
    }

    @Test
    fun elegirOtraRutaEnElDesplegableEsLaQueSePatrulla() {
        val pantalla = banco.abrir()
        val desplegable = pantalla.findViewById<MaterialAutoCompleteTextView>(R.id.dropdownRoutes)

        // El operador abre el desplegable y toca la segunda opción de la lista
        desplegable.showDropDown()
        correrLaPantalla()
        val lista = ShadowListPopupWindow.getLatestListPopupWindow()
        assertTrue("el desplegable se abrió", desplegable.isPopupShowing)
        assertEquals("Reserva", lista.listView!!.adapter.getItem(1).toString())
        assertTrue(lista.performItemClick(1))
        correrLaPantalla()

        assertFalse("elegida la ruta, la lista se cierra", desplegable.isPopupShowing)
        assertEquals("Reserva", pantalla.texto(R.id.dropdownRoutes))
        assertEquals(
            pantalla.resources.getQuantityString(R.plurals.main_waypoints, 1, 1) + " · " + pantalla.getString(R.string.main_altura_m, 55.0),
            pantalla.texto(R.id.txtRouteInfo),
        )
        pantalla.tocar(R.id.btnStartPatrol)
        assertTrue(dron.ordenes.contains("startRoute(2, 0)"))
    }

    /** Una ruta todavía sin nodos no tiene altura que mostrar. */
    @Test
    fun unaRutaSinNodosMuestraSoloLaCuenta() {
        banco.rutas = listOf(PatrolRoute(7, "Borrador", emptyList()))
        val pantalla = banco.abrir()

        assertEquals(listOf("Borrador"), pantalla.opcionesDelDesplegable())
        assertEquals("Borrador", pantalla.texto(R.id.dropdownRoutes))
        assertEquals(pantalla.resources.getQuantityString(R.plurals.main_waypoints, 0, 0), pantalla.texto(R.id.txtRouteInfo))
    }

    @Test
    fun sinRutasLoDiceYNoDejaComenzar() {
        banco.rutas = emptyList()
        val pantalla = banco.abrir()

        assertEquals("el aviso no es una opción que se pueda elegir", emptyList<String>(), pantalla.opcionesDelDesplegable())
        assertEquals(pantalla.getString(R.string.main_sin_rutas), pantalla.texto(R.id.dropdownRoutes))
        assertEquals("", pantalla.texto(R.id.txtRouteInfo))
        assertFalse(pantalla.boton(R.id.btnStartPatrol).isEnabled)
    }

    // ---- Comenzar, detener, reanudar ----

    /** En el aire comenzar no despega nada: la ruta arranca sin preguntar. */
    @Test
    fun enElAireComenzarArrancaLaRutaSinPreguntar() {
        val pantalla = banco.abrir()
        assertEquals(pantalla.getString(R.string.main_comenzar_patrullaje), pantalla.texto(R.id.btnStartPatrol))
        assertEquals(pantalla.getString(R.string.estado_idle), pantalla.estado())
        // En el aire y en base: comenzar, volver y aterrizar; nada que detener ni reanudar
        assertEquals(listOf(true, false, false, false, true, true), pantalla.botonesPrendidos())

        pantalla.tocar(R.id.btnStartPatrol)

        assertNull("no hay nada que confirmar", ultimaConfirmacion())
        assertTrue(dron.ordenes.contains("startRoute(1, 0)"))
        assertEquals(pantalla.getString(R.string.estado_patrullando), pantalla.estado())
        assertEquals("patrullando se puede detener, no comenzar", listOf(false, false, true, false, true, true), pantalla.botonesPrendidos())
    }

    @Test
    fun detenerDejaAlDronQuietoYReanudarRetomaLaRuta() {
        val pantalla = banco.abrir()
        pantalla.tocar(R.id.btnStartPatrol)

        pantalla.tocar(R.id.btnStopPatrol)
        assertEquals("hold", dron.ultimaOrden)
        assertEquals(pantalla.getString(R.string.estado_pausado), pantalla.estado())
        assertEquals("pausado: se reanuda, no se detiene de nuevo", listOf(false, false, false, true, true, true), pantalla.botonesPrendidos())

        pantalla.tocar(R.id.btnResumePatrol)
        assertEquals("startRoute(1, 0)", dron.ultimaOrden)
        assertEquals(pantalla.getString(R.string.estado_patrullando), pantalla.estado())
    }

    /** Con el dron en el suelo comenzar es despegar: eso se confirma siempre. */
    @Test
    fun enElSueloDespegarYPatrullarPideConfirmacion() {
        enElSuelo()
        val pantalla = banco.abrir()
        assertEquals(pantalla.getString(R.string.main_despegar_y_patrullar), pantalla.texto(R.id.btnStartPatrol))
        // En el suelo no hay a dónde volver ni dónde aterrizar
        assertEquals(listOf(true, true, false, false, false, false), pantalla.botonesPrendidos())

        pantalla.tocar(R.id.btnStartPatrol)
        val pregunta = ultimaConfirmacion()
        assertEquals(pantalla.getString(R.string.main_confirmar_despegue_texto, "Costanera"), mensajeDe(pregunta))
        responder(pregunta, DialogInterface.BUTTON_NEGATIVE)
        assertFalse("cancelado no despega", dron.ordenes.any { it.startsWith("startRoute") })
        assertEquals(pantalla.getString(R.string.estado_idle), pantalla.estado())

        pantalla.tocar(R.id.btnStartPatrol)
        responder(ultimaConfirmacion(), DialogInterface.BUTTON_POSITIVE)
        assertTrue(dron.ordenes.contains("startRoute(1, 0)"))
        assertEquals(pantalla.getString(R.string.estado_patrullando), pantalla.estado())
    }

    /** El botón apagado no dice nada: se explica por qué no se puede patrullar. */
    @Test
    fun sinGpsExplicaPorQueNoPatrullaYDejaDespegarAqui() {
        enElSuelo(satelites = 2, base = false, detalle = "Esperando señal GPS (2 satélites)")
        val pantalla = banco.abrir()

        val aviso = pantalla.findViewById<TextView>(R.id.txtNoPatrulla)
        assertEquals(View.VISIBLE, aviso.visibility)
        assertEquals(
            pantalla.getString(R.string.main_no_se_puede_patrullar, "Esperando señal GPS (2 satélites)"),
            aviso.text.toString(),
        )
        assertEquals("solo despegar aquí, que no pide GPS", listOf(false, true, false, false, false, false), pantalla.botonesPrendidos())

        // Con GPS y punto de retorno el aviso se va
        dron.estado.value = dron.estado.value.copy(satelites = 12, baseFijada = true, detalle = "")
        correrLaPantalla()
        assertEquals(View.GONE, aviso.visibility)
        assertTrue(pantalla.boton(R.id.btnStartPatrol).isEnabled)
    }

    // ---- Volver a base y aterrizar ----

    @Test
    fun volverABasePideConfirmacionYRecienAhiLoOrdena() {
        val pantalla = banco.abrir()

        pantalla.tocar(R.id.btnReturnHome)
        val pregunta = ultimaConfirmacion()
        assertEquals(pantalla.getString(R.string.main_confirmar_rth_texto), mensajeDe(pregunta))
        assertEquals(pantalla.getString(R.string.main_volver_base), pregunta!!.getButton(DialogInterface.BUTTON_POSITIVE).text.toString())
        responder(pregunta, DialogInterface.BUTTON_NEGATIVE)
        assertFalse(dron.ordenes.contains("returnHome"))

        pantalla.tocar(R.id.btnReturnHome)
        responder(ultimaConfirmacion(), DialogInterface.BUTTON_POSITIVE)
        assertEquals("returnHome", dron.ultimaOrden)
        assertEquals(pantalla.getString(R.string.estado_rth_manual), pantalla.estado())
        assertEquals("volviendo, solo queda aterrizar donde está", listOf(false, false, false, false, false, true), pantalla.botonesPrendidos())
    }

    @Test
    fun aterrizarPideConfirmacionYRecienAhiLoOrdena() {
        val pantalla = banco.abrir()

        pantalla.tocar(R.id.btnLand)
        val pregunta = ultimaConfirmacion()
        assertEquals(pantalla.getString(R.string.main_confirmar_aterrizar_texto), mensajeDe(pregunta))
        responder(pregunta, DialogInterface.BUTTON_NEGATIVE)
        assertFalse(dron.ordenes.contains("land"))

        pantalla.tocar(R.id.btnLand)
        responder(ultimaConfirmacion(), DialogInterface.BUTTON_POSITIVE)
        assertEquals("land", dron.ultimaOrden)
        assertEquals(pantalla.getString(R.string.estado_pausado), pantalla.estado())
    }

    /**
     * Con la batería baja el dron vuelve solo y, ya en tierra, la pantalla pide
     * cambiarla: hasta entonces no se despega por ningún botón.
     */
    @Test
    fun conLaBateriaBajaVuelveSoloYEnTierraPideCambiarla() {
        val pantalla = banco.abrir()

        runBlocking { dron.emitirTelemetria(bateria = 20.0) }
        correrLaPantalla()
        assertEquals(pantalla.getString(R.string.estado_rth_bateria), pantalla.estado())
        assertEquals("ya vuelve: no se le ordena volver de nuevo", listOf(false, false, false, false, false, true), pantalla.botonesPrendidos())

        dron.flightEvents.tryEmit(FlightEvent.ArrivedHome)
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        correrLaPantalla()

        assertEquals(pantalla.getString(R.string.estado_aterrizado), pantalla.estado())
        val aviso = pantalla.findViewById<TextView>(R.id.txtNoPatrulla)
        assertEquals(View.VISIBLE, aviso.visibility)
        assertEquals(pantalla.getString(R.string.main_cambiar_bateria), aviso.text.toString())
        assertEquals("ni despegar aquí", listOf(false, false, false, false, false, false), pantalla.botonesPrendidos())
    }

    // ---- Órdenes que llegan desde la consola ----

    /** El estado que manda la consola también se lee en el teléfono, con los botones que le corresponden. */
    @Test
    fun elControlManualYElDesvioDeLaConsolaSeVenEnElTelefono() {
        val pantalla = banco.abrir()
        pantalla.tocar(R.id.btnStartPatrol)

        banco.comando.manejarMensaje("""{"type":"control_taken","by":"supervisor"}""")
        correrLaPantalla()
        assertEquals(pantalla.getString(R.string.estado_manual), pantalla.estado())
        assertTrue("en manual se puede detener", pantalla.boton(R.id.btnStopPatrol).isEnabled)
        assertTrue("y retomar la ruta que venía volando", pantalla.boton(R.id.btnResumePatrol).isEnabled)

        banco.comando.manejarMensaje("""{"type":"force_goto","routeId":1,"index":2,"orderedBy":"supervisor"}""")
        correrLaPantalla()
        assertEquals(pantalla.getString(R.string.estado_forzado), pantalla.estado())
        assertEquals("gotoPoint", dron.ultimaOrden)
        assertTrue(pantalla.boton(R.id.btnStopPatrol).isEnabled)
        assertFalse(pantalla.boton(R.id.btnResumePatrol).isEnabled)
    }
}
