package com.tesis.dronepatrol

import android.Manifest
import android.content.DialogInterface
import android.content.Intent
import android.location.Location
import android.os.Looper.getMainLooper
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.Priority
import com.tesis.dronepatrol.drone.DronEnCurso
import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.drone.Geo
import com.tesis.dronepatrol.drone.SimulatedDroneController
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.SesionOperador
import com.tesis.dronepatrol.model.Vinculacion
import com.tesis.dronepatrol.patrol.DronEspia
import java.time.Duration
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

/**
 * La pantalla que conecta con el dron físico: hasta que la aeronave no está
 * enlazada no se puede desplegar, y al desplegar la sesión del operador de
 * campo sigue viva.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConexionDronActivityTest {

    private companion object {
        const val HASH = "0123456789abcdef0123456789abcdef"
        const val BASE_LAT = -34.6037
        const val BASE_LON = -58.3816

        /** Enlazado y con el GPS listo: lo que tiene que pasar para desplegar. */
        val LISTO = EstadoDelDron(
            sdkListo = true, conectado = true, modelo = "MINI 4 PRO", enVuelo = false,
            satelites = 12, baseFijada = true, controlConectado = true, serie = "1581F7",
        )

        /** El control enchufado, pero la aeronave todavía no contesta. */
        val SIN_ENLACE = EstadoDelDron(
            sdkListo = true, conectado = false, modelo = "MINI 4 PRO", enVuelo = false,
            satelites = 0, baseFijada = false, controlConectado = true,
        )
    }

    private val dron = DronEspia()
    private val gps = GpsDelTelefonoFalso()
    private var simulador: SimulatedDroneController? = null

    @After
    fun desarmar() {
        // El simulador tiene su propio lazo de vuelo: si no se lo apaga sigue
        // corriendo en el próximo test.
        simulador?.disconnect()
        DronEnCurso.soltar()
        SesionDeCampo.cerrar()
    }

    private fun construir(
        nombre: String = "Alfa",
        modeloFicha: String = "DJI Mini 4 Pro",
        base: String = "Base Obelisco",
        conUbicacion: Boolean? = null,
        controlador: DroneController = dron,
        baseLat: Double? = null,
        baseLon: Double? = null,
    ): ActivityController<ConexionDronActivity> {
        DronEnCurso.usar(controlador)
        val intent = Intent(RuntimeEnvironment.getApplication(), ConexionDronActivity::class.java)
            .putExtra(MainActivity.EXTRA_DRONE_TOKEN, "token-de-prueba")
            .putExtra(MainActivity.EXTRA_DRONE_HASH, HASH)
            .putExtra(MainActivity.EXTRA_DISPLAY_NAME, nombre)
            .putExtra(ConexionDronActivity.EXTRA_MODELO_FICHA, modeloFicha)
            .putExtra(ConexionDronActivity.EXTRA_BASE_NOMBRE, base)
        if (conUbicacion != null) intent.putExtra(ConexionDronActivity.EXTRA_CON_UBICACION, conUbicacion)
        if (baseLat != null) intent.putExtra(MainActivity.EXTRA_BASE_LAT, baseLat)
        if (baseLon != null) intent.putExtra(MainActivity.EXTRA_BASE_LON, baseLon)
        val pantalla = Robolectric.buildActivity(ConexionDronActivity::class.java, intent)
        // Antes de onCreate, que es donde la pantalla empieza a seguir al teléfono
        gps.instalarEn(pantalla.get())
        return pantalla.setup()
    }

    private fun permitir(vararg permisos: String) = shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(*permisos)

    private fun abrir(): ConexionDronActivity = construir().get()

    private fun ponerEstado(estado: EstadoDelDron) {
        dron.estado.value = estado
        shadowOf(getMainLooper()).idle()
    }

    private fun ConexionDronActivity.texto(id: Int): String = findViewById<TextView>(id).text.toString()

    private fun ConexionDronActivity.detalleDeFila(fila: Int): String =
        findViewById<View>(fila).findViewById<TextView>(R.id.detalle).text.toString()

    /** El color del punto de una fila: verde listo, ámbar a medias, gris nada. */
    private fun ConexionDronActivity.puntoDeFila(fila: Int): Int? =
        findViewById<View>(fila).findViewById<View>(R.id.punto).backgroundTintList?.defaultColor

    private fun ConexionDronActivity.color(id: Int): Int = ContextCompat.getColor(this, id)

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

    /**
     * "Vincular" no se ofrece mientras el enlace todavía se está armando: en el
     * campo, tocarlo en esos segundos borró el vínculo bueno que el control ya
     * tenía. Aparece recién con medio minuto sin enlace, y pide confirmación.
     */
    @Test
    fun vincularSeOfreceRecienConMedioMinutoSinEnlaceYPideConfirmacion() {
        val actividad = abrir()
        dron.estado.value = EstadoDelDron(
            sdkListo = true, conectado = false, modelo = "MINI 4 PRO", enVuelo = false,
            satelites = 0, baseFijada = false, controlConectado = true,
        )
        shadowOf(getMainLooper()).idle()
        val boton = actividad.findViewById<Button>(R.id.btnVincular)
        assertEquals(android.view.View.GONE, boton.visibility)

        shadowOf(getMainLooper()).idleFor(java.time.Duration.ofSeconds(10))
        assertEquals(android.view.View.GONE, boton.visibility)

        shadowOf(getMainLooper()).idleFor(java.time.Duration.ofSeconds(25))
        assertEquals(android.view.View.VISIBLE, boton.visibility)

        // Tocarlo no vincula: primero pregunta
        boton.performClick()
        shadowOf(getMainLooper()).idle()
        assertFalse(dron.ordenes.contains("vincularControl"))
        val dialogo = org.robolectric.shadows.ShadowDialog.getLatestDialog() as androidx.appcompat.app.AlertDialog
        dialogo.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(getMainLooper()).idle()
        assertTrue(dron.ordenes.contains("vincularControl"))
    }

    /** Con el enlace andando, el botón no aparece nunca. */
    @Test
    fun conEnlaceVincularNoAparece() {
        val actividad = abrir()
        dron.estado.value = EstadoDelDron(
            sdkListo = true, conectado = true, modelo = "MINI 4 PRO", enVuelo = false,
            satelites = 12, baseFijada = true, controlConectado = true,
        )
        shadowOf(getMainLooper()).idleFor(java.time.Duration.ofSeconds(40))
        assertEquals(android.view.View.GONE, actividad.findViewById<Button>(R.id.btnVincular).visibility)
    }

    /** Vincular borra el vínculo que el control ya tiene: arrepentirse no puede vincular igual. */
    @Test
    fun siSeArrepienteDeVincularNoVincula() {
        val actividad = abrir()
        ponerEstado(SIN_ENLACE)
        shadowOf(getMainLooper()).idleFor(Duration.ofSeconds(31))

        actividad.findViewById<Button>(R.id.btnVincular).performClick()
        shadowOf(getMainLooper()).idle()
        val dialogo = ShadowDialog.getLatestDialog() as AlertDialog
        dialogo.getButton(DialogInterface.BUTTON_NEGATIVE).performClick()
        shadowOf(getMainLooper()).idle()

        assertFalse(dron.ordenes.contains("vincularControl"))
    }

    /**
     * Con una vinculación en curso el botón sirve para cancelarla, y aparece al
     * toque —sin esperar el medio minuto—: el operador tiene que poder
     * arrepentirse mientras el control espera a la aeronave. Cancelar no pide
     * confirmación porque no borra nada.
     */
    @Test
    fun duranteLaVinculacionElBotonLaCancelaSinPreguntar() {
        val actividad = abrir()
        ponerEstado(SIN_ENLACE.copy(vinculacion = Vinculacion.VINCULANDO))

        val boton = actividad.findViewById<Button>(R.id.btnVincular)
        assertEquals(View.VISIBLE, boton.visibility)
        assertEquals(actividad.getString(R.string.conexion_vincular_cancelar), boton.text.toString())
        assertEquals(actividad.getString(R.string.conexion_vinculando), actividad.texto(R.id.txtVincularAyuda))
        assertEquals(View.VISIBLE, actividad.findViewById<View>(R.id.txtVincularAyuda).visibility)

        boton.performClick()
        shadowOf(getMainLooper()).idle()

        assertTrue(dron.ordenes.contains("cancelarVinculacion"))
        assertFalse(dron.ordenes.contains("vincularControl"))
        assertNull("cancelar no pregunta", ShadowDialog.getLatestDialog())
    }

    /** La ficha del Comando Central, tal como llegó del emparejamiento. */
    @Test
    fun muestraLaFichaDelDronEmparejado() {
        val actividad = abrir()

        assertEquals("DJI Mini 4 Pro · 012345…cdef", actividad.texto(R.id.txtDetalleDron))
        assertEquals("Base: Base Obelisco", actividad.texto(R.id.txtBase))
        assertEquals(View.VISIBLE, actividad.findViewById<View>(R.id.txtBase).visibility)
        // Sin el dato del GPS, lo prudente es decir que quedó sin ubicación
        assertEquals(actividad.getString(R.string.modo_sin_ubicacion), actividad.texto(R.id.txtUbicacionDespliegue))
    }

    /**
     * Un dron sin nombre ni base todavía se tiene que poder reconocer: va el hash
     * abreviado (nunca entero) y no queda una etiqueta "Base:" vacía.
     */
    @Test
    fun sinNombreNiBaseSeIdentificaPorElHashAbreviado() {
        val actividad = construir(nombre = "", modeloFicha = "", base = "", conUbicacion = true).get()

        assertEquals("012345…cdef", actividad.texto(R.id.txtNombreDron))
        assertEquals("012345…cdef", actividad.texto(R.id.txtDetalleDron))
        assertEquals(View.GONE, actividad.findViewById<View>(R.id.txtBase).visibility)
        assertEquals(actividad.getString(R.string.modo_con_ubicacion), actividad.texto(R.id.txtUbicacionDespliegue))
    }

    /** Nada conectado: todas las filas en gris, cada una diciendo qué espera. */
    @Test
    fun sinNadaConectadoTodasLasFilasQuedanApagadas() {
        val actividad = abrir()
        ponerEstado(EstadoDelDron.DESCONOCIDO)

        val apagado = actividad.color(R.color.estado_apagado)
        assertEquals(actividad.getString(R.string.conexion_sdk_esperando), actividad.detalleDeFila(R.id.filaSdk))
        assertEquals(actividad.getString(R.string.conexion_control_esperando), actividad.detalleDeFila(R.id.filaControl))
        assertEquals(actividad.getString(R.string.conexion_aeronave_esperando), actividad.detalleDeFila(R.id.filaAeronave))
        assertEquals(apagado, actividad.puntoDeFila(R.id.filaSdk))
        assertEquals(apagado, actividad.puntoDeFila(R.id.filaControl))
        assertEquals(apagado, actividad.puntoDeFila(R.id.filaAeronave))
        assertEquals(apagado, actividad.puntoDeFila(R.id.filaGps))
        assertEquals(actividad.color(R.color.texto_medio), actividad.findViewById<TextView>(R.id.txtAyuda).currentTextColor)
    }

    /**
     * Con el control enchufado y sin aeronave, la fila de la aeronave pasa a
     * ámbar: ya no falta el cable, falta el enlace. Es lo que guía al operador a
     * mirar el dron y no el teléfono.
     */
    @Test
    fun conElControlEnchufadoSinAeronaveLaAeronaveQuedaEnAlerta() {
        val actividad = abrir()
        ponerEstado(SIN_ENLACE)

        val ok = actividad.color(R.color.estado_ok)
        assertEquals(actividad.getString(R.string.conexion_sdk_ok), actividad.detalleDeFila(R.id.filaSdk))
        assertEquals(actividad.getString(R.string.conexion_control_ok), actividad.detalleDeFila(R.id.filaControl))
        assertEquals(ok, actividad.puntoDeFila(R.id.filaSdk))
        assertEquals(ok, actividad.puntoDeFila(R.id.filaControl))
        assertEquals(actividad.color(R.color.estado_alerta), actividad.puntoDeFila(R.id.filaAeronave))
        assertEquals(actividad.color(R.color.estado_apagado), actividad.puntoDeFila(R.id.filaGps))
        assertFalse(actividad.findViewById<Button>(R.id.btnDesplegar).isEnabled)
    }

    /**
     * Enlazado pero sin punto de retorno: se puede desplegar (en interior no hay
     * GPS), pero la fila del GPS queda en ámbar y dice el modo de vuelo, que es
     * lo que cuenta si la aeronave se ubica por GPS o solo por visión.
     */
    @Test
    fun enlazadoSinPuntoDeRetornoElGpsQuedaEnAlertaConElModoDeVuelo() {
        val actividad = abrir()
        ponerEstado(LISTO.copy(satelites = 5, baseFijada = false, modoDeVuelo = "ATTI", modelo = "", serie = ""))

        assertEquals("5 satélites · esperando el punto de retorno · modo ATTI", actividad.detalleDeFila(R.id.filaGps))
        assertEquals(actividad.color(R.color.estado_alerta), actividad.puntoDeFila(R.id.filaGps))
        // La aeronave que no informa modelo ni serie igual se muestra, sin huecos
        assertEquals("Sin modelo · serie —", actividad.detalleDeFila(R.id.filaAeronave))
        assertEquals(actividad.color(R.color.estado_ok), actividad.puntoDeFila(R.id.filaAeronave))
        assertTrue(actividad.findViewById<Button>(R.id.btnDesplegar).isEnabled)
        assertEquals(actividad.color(R.color.estado_ok), actividad.findViewById<TextView>(R.id.txtAyuda).currentTextColor)
    }

    @Test
    fun conGpsYPuntoDeRetornoLaFilaDelGpsQuedaVerde() {
        val actividad = abrir()
        ponerEstado(LISTO)

        assertEquals("12 satélites · punto de retorno fijado", actividad.detalleDeFila(R.id.filaGps))
        assertEquals(actividad.color(R.color.estado_ok), actividad.puntoDeFila(R.id.filaGps))
    }

    @Test
    fun laBateriaSaleDeLaTelemetriaDelDron() {
        val actividad = abrir()
        ponerEstado(LISTO)

        runBlocking { dron.emitirTelemetria(bateria = 73.6) }
        shadowOf(getMainLooper()).idle()

        assertEquals("73 %", actividad.texto(R.id.txtBateria))
        // Sin la ubicación del teléfono no hay distancia que medir
        assertEquals(actividad.getString(R.string.conexion_distancia_sin_dato), actividad.texto(R.id.txtDistancia))
    }

    /** Teléfono y dron a unos pasos: la distancia se muestra normal. */
    @Test
    fun conElDronCercaMuestraLaDistanciaSinAlarma() {
        permitir(Manifest.permission.ACCESS_FINE_LOCATION)
        val actividad = abrir()
        ponerEstado(LISTO)
        runBlocking { dron.emitirTelemetria(lat = BASE_LAT, lon = BASE_LON) }
        shadowOf(getMainLooper()).idle()

        gps.moverA(BASE_LAT + 30.0 / Geo.METROS_POR_GRADO_LAT, BASE_LON)

        assertEquals("30 m", actividad.texto(R.id.txtDistancia))
        assertEquals(actividad.color(R.color.texto), actividad.findViewById<TextView>(R.id.txtDistancia).currentTextColor)
    }

    /**
     * Más de 100 m entre el teléfono y la aeronave enlazada: probablemente es el
     * dron de al lado. Se marca en ámbar para que el operador lo revise.
     */
    @Test
    fun conElDronLejosLaDistanciaQuedaEnAlerta() {
        permitir(Manifest.permission.ACCESS_FINE_LOCATION)
        val actividad = abrir()
        ponerEstado(LISTO)
        runBlocking { dron.emitirTelemetria(lat = BASE_LAT, lon = BASE_LON) }
        shadowOf(getMainLooper()).idle()

        gps.moverA(BASE_LAT + 200.0 / Geo.METROS_POR_GRADO_LAT, BASE_LON)

        assertEquals("200 m", actividad.texto(R.id.txtDistancia))
        assertEquals(actividad.color(R.color.estado_alerta), actividad.findViewById<TextView>(R.id.txtDistancia).currentTextColor)
    }

    /** En interior el dron no tiene posición: una distancia calculada con NaN sería basura. */
    @Test
    fun sinGpsEnElDronNoHayDistancia() {
        permitir(Manifest.permission.ACCESS_FINE_LOCATION)
        val actividad = abrir()
        ponerEstado(LISTO)
        runBlocking { dron.emitirTelemetria(lat = Double.NaN, lon = Double.NaN) }
        shadowOf(getMainLooper()).idle()

        gps.moverA(BASE_LAT, BASE_LON)

        assertEquals(actividad.getString(R.string.conexion_distancia_sin_dato), actividad.texto(R.id.txtDistancia))
    }

    /** La última posición que dejó el dron no vale si se cortó el enlace. */
    @Test
    fun alPerderElEnlaceLaDistanciaDejaDeMostrarse() {
        permitir(Manifest.permission.ACCESS_FINE_LOCATION)
        val actividad = abrir()
        ponerEstado(LISTO)
        runBlocking { dron.emitirTelemetria(lat = BASE_LAT, lon = BASE_LON) }
        shadowOf(getMainLooper()).idle()
        gps.moverA(BASE_LAT + 30.0 / Geo.METROS_POR_GRADO_LAT, BASE_LON)
        assertEquals("30 m", actividad.texto(R.id.txtDistancia))

        ponerEstado(SIN_ENLACE)

        assertEquals(actividad.getString(R.string.conexion_distancia_sin_dato), actividad.texto(R.id.txtDistancia))
    }

    /**
     * Con permiso, la pantalla sigue al teléfono por GPS (alta precisión) y cada
     * 2 s: el aviso salta a los 100 m y una ubicación por antenas puede errar
     * por más que eso, y la distancia tiene que acompañar al operador mientras
     * camina hacia el dron.
     */
    @Test
    fun conPermisoSigueAlTelefonoPorGpsCadaDosSegundos() {
        permitir(Manifest.permission.ACCESS_FINE_LOCATION)
        abrir()

        val pedido = gps.pedidos.single()
        assertEquals(Priority.PRIORITY_HIGH_ACCURACY, pedido.priority)
        assertEquals(2_000L, pedido.intervalMillis)
        assertEquals(1, gps.suscriptos.size)
    }

    /** Sin permiso de ubicación no se le pide nada al proveedor: la distancia queda sin dato. */
    @Test
    fun sinPermisoDeUbicacionNoSigueAlTelefono() {
        val actividad = abrir()
        ponerEstado(LISTO)
        runBlocking { dron.emitirTelemetria(lat = BASE_LAT, lon = BASE_LON) }
        shadowOf(getMainLooper()).idle()

        assertTrue(gps.pedidos.isEmpty())
        assertTrue(gps.suscriptos.isEmpty())
        assertEquals(actividad.getString(R.string.conexion_distancia_sin_dato), actividad.texto(R.id.txtDistancia))
    }

    /**
     * Desde Android 12 el operador puede conceder solo la ubicación aproximada:
     * igual se sigue al teléfono (el sistema entrega la que puede) en lugar de
     * quedarse sin distancia.
     */
    @Test
    fun conSoloLaUbicacionAproximadaIgualSigueAlTelefono() {
        permitir(Manifest.permission.ACCESS_COARSE_LOCATION)
        val actividad = abrir()
        ponerEstado(LISTO)
        runBlocking { dron.emitirTelemetria(lat = BASE_LAT, lon = BASE_LON) }
        shadowOf(getMainLooper()).idle()

        gps.moverA(BASE_LAT + 30.0 / Geo.METROS_POR_GRADO_LAT, BASE_LON)

        assertEquals(1, gps.pedidos.size)
        assertEquals("30 m", actividad.texto(R.id.txtDistancia))
    }

    /**
     * Al cerrarse suelta la ubicación que pidió: si no, el GPS del teléfono
     * seguiría encendido, gastando batería en el campo y avisándole a una
     * pantalla que ya no existe.
     */
    @Test
    fun alCerrarseDejaDeSeguirAlTelefono() {
        permitir(Manifest.permission.ACCESS_FINE_LOCATION)
        val pantalla = construir()
        assertEquals(1, gps.suscriptos.size)

        pantalla.pause().stop().destroy()

        assertTrue("la pantalla cerrada sigue suscripta a la ubicación", gps.suscriptos.isEmpty())
    }

    /**
     * La ubicación del teléfono es una ayuda, no un requisito para volar: si el
     * proveedor falla al pedirla o al soltarla, la pantalla se usa igual —solo
     * que sin distancia— y cerrarla no la tira abajo.
     */
    @Test
    fun siElProveedorDeUbicacionFallaLaPantallaSigueAndandoSinDistancia() {
        permitir(Manifest.permission.ACCESS_FINE_LOCATION)
        gps.roto = true
        val pantalla = construir()
        val actividad = pantalla.get()
        ponerEstado(LISTO)
        runBlocking { dron.emitirTelemetria(lat = BASE_LAT, lon = BASE_LON) }
        shadowOf(getMainLooper()).idle()

        assertEquals(actividad.getString(R.string.conexion_distancia_sin_dato), actividad.texto(R.id.txtDistancia))
        assertTrue(actividad.findViewById<Button>(R.id.btnDesplegar).isEnabled)

        pantalla.pause().stop().destroy()
        assertTrue(actividad.isDestroyed)
    }

    /** "Atrás" es lo mismo que "Volver": el controlador no puede quedar encendido. */
    @Test
    fun atrasApagaElControladorYLoSuelta() {
        val actividad = abrir()

        actividad.onBackPressedDispatcher.onBackPressed()

        assertTrue(actividad.isFinishing)
        assertTrue(dron.ordenes.contains("disconnect"))
        assertNotSame("el controlador abandonado no puede quedar en curso", dron, DronEnCurso.obtener())
        assertNull(shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity)
    }

    /** El modo prueba va a la misma operación, con la ficha entera y el modo TEST. */
    @Test
    fun modoPruebaVaALaOperacionConLaFichaDelDron() {
        val actividad = construir(baseLat = BASE_LAT, baseLon = BASE_LON).get()
        ponerEstado(LISTO)

        actividad.findViewById<Button>(R.id.btnModoPrueba).performClick()

        val siguiente = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertEquals(MainActivity::class.java.name, siguiente.component?.className)
        assertEquals("TEST", siguiente.getStringExtra(MainActivity.EXTRA_MODE))
        assertEquals(HASH, siguiente.getStringExtra(MainActivity.EXTRA_DRONE_HASH))
        assertEquals("Alfa", siguiente.getStringExtra(MainActivity.EXTRA_DISPLAY_NAME))
        assertEquals(BASE_LAT, siguiente.getDoubleExtra(MainActivity.EXTRA_BASE_LAT, Double.NaN), 0.0)
        assertEquals(BASE_LON, siguiente.getDoubleExtra(MainActivity.EXTRA_BASE_LON, Double.NaN), 0.0)
        assertTrue(actividad.isFinishing)
        assertFalse(dron.ordenes.contains("disconnect"))
    }

    /**
     * El simulador arranca en la base del dron emparejado y, como no es ningún
     * modelo, no tiene sentido compararlo con la ficha: no se avisa.
     */
    @Test
    fun conElSimuladorArrancaEnLaBaseYNoComparaElModelo() {
        val sim = SimulatedDroneController().also { simulador = it }
        val actividad = construir(controlador = sim, baseLat = BASE_LAT, baseLon = BASE_LON).get()

        esperarEnElHiloPrincipal("la primera telemetría del simulador") {
            actividad.texto(R.id.txtBateria) == "100 %"
        }

        val donde = sim.telemetry.replayCache.last()
        assertEquals(BASE_LAT, donde.lat, 1e-9)
        assertEquals(BASE_LON, donde.lon, 1e-9)
        assertTrue(actividad.findViewById<Button>(R.id.btnDesplegar).isEnabled)
        assertEquals(View.GONE, actividad.findViewById<View>(R.id.txtAvisoModelo).visibility)
    }
}

/**
 * El proveedor de ubicación del teléfono, del lado de las pruebas. Anota lo que
 * la pantalla le pide y, como el de Google, le entrega posiciones solo a quien
 * sigue suscripto: la distancia se prueba pasando por la suscripción de verdad,
 * así que si la pantalla dejara de pedir la ubicación —o de soltarla— las
 * pruebas lo ven.
 */
private class GpsDelTelefonoFalso {
    val pedidos = mutableListOf<LocationRequest>()
    val suscriptos = mutableListOf<LocationCallback>()

    /** Un proveedor que falla tanto al pedir como al soltar la ubicación. */
    var roto = false

    fun instalarEn(actividad: ConexionDronActivity) {
        actividad.pedirUbicacion = { pedido, alCambiar ->
            check(!roto) { "el proveedor de ubicación falló" }
            pedidos += pedido
            suscriptos += alCambiar
        }
        actividad.soltarUbicacion = { alCambiar ->
            check(!roto) { "el proveedor de ubicación falló" }
            suscriptos.remove(alCambiar)
        }
    }

    /** El teléfono está en otro lado: se les avisa a los suscriptos, como lo haría Google. */
    fun moverA(lat: Double, lon: Double) {
        assertTrue("la pantalla no está siguiendo al teléfono", suscriptos.isNotEmpty())
        val donde = Location("prueba").apply {
            latitude = lat
            longitude = lon
        }
        suscriptos.toList().forEach { it.onLocationResult(LocationResult.create(listOf(donde))) }
    }
}
