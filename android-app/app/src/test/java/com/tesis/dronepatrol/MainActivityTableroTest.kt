package com.tesis.dronepatrol

import android.graphics.Bitmap
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.tesis.dronepatrol.model.Caja
import com.tesis.dronepatrol.model.Deteccion
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.patrol.DronEspia
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Lo que el operador de campo mira en la pantalla de operación: el estado del
 * aparato, la telemetría, el video, los avisos de vuelo y el registro local.
 * Cada dato tiene que pintarse con el color que dice si está bien, y nada puede
 * quedar mostrando un valor viejo cuando el dron cambia.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityTableroTest {

    private val dron = DronEspia()
    private val banco = BancoDeOperacion(dron)

    @After
    fun desarmar() = banco.desarmar()

    private fun MainActivity.texto(id: Int): String = findViewById<TextView>(id).text.toString()

    private fun MainActivity.colorDelTexto(id: Int): Int = findViewById<TextView>(id).currentTextColor

    private fun MainActivity.color(id: Int): Int = ContextCompat.getColor(this, id)

    private fun MainActivity.colorDelPunto(): Int? = findViewById<View>(R.id.puntoDron).backgroundTintList?.defaultColor

    private fun cambiarDron(cambio: (EstadoDelDron) -> EstadoDelDron) {
        dron.estado.value = cambio(dron.estado.value)
        correrLaPantalla()
    }

    private fun telemetria(
        lat: Double = -34.6037,
        lon: Double = -58.3816,
        bateria: Double = 80.0,
        alt: Double = 40.0,
        rumbo: Double = 0.0,
    ) {
        runBlocking { dron.emitirTelemetria(lat = lat, lon = lon, bateria = bateria, alt = alt, rumbo = rumbo) }
        correrLaPantalla()
    }

    // ---- El aparato ----

    @Test
    fun sinEnlaceConElDronLoPintaApagadoYSinModelo() {
        dron.estado.value = EstadoDelDron.DESCONOCIDO
        val pantalla = banco.abrir()

        assertEquals("Esperando al dron", pantalla.texto(R.id.txtDroneStatus))
        assertEquals(pantalla.color(R.color.estado_apagado), pantalla.colorDelPunto())
        assertEquals(pantalla.getString(R.string.main_modelo_desconocido), pantalla.texto(R.id.txtModelo))
        assertEquals(pantalla.getString(R.string.main_gps_sat, 0), pantalla.texto(R.id.txtGps))
        assertEquals(pantalla.color(R.color.estado_alerta), pantalla.colorDelTexto(R.id.txtGps))
        assertEquals(pantalla.getString(R.string.main_en_suelo), pantalla.texto(R.id.txtVuelo))
        assertEquals(pantalla.color(R.color.texto_medio), pantalla.colorDelTexto(R.id.txtVuelo))

        // El SDK listo no alcanza: sin enlace con la aeronave sigue apagado
        cambiarDron { it.copy(sdkListo = true, conectado = false, modelo = "MINI 4 PRO", detalle = "Encendé el dron") }
        assertEquals("Encendé el dron", pantalla.texto(R.id.txtDroneStatus))
        assertEquals("MINI 4 PRO", pantalla.texto(R.id.txtModelo))
        assertEquals(pantalla.color(R.color.estado_apagado), pantalla.colorDelPunto())
    }

    @Test
    fun elPuntoDelDronCambiaDeColorSegunPuedaDespegarOEsteEnElAire() {
        dron.estado.value = dron.estado.value.copy(enVuelo = false, satelites = 3, baseFijada = false, detalle = "Esperando GPS")
        val pantalla = banco.abrir()

        // En el suelo y sin GPS: hay enlace pero no se puede volar una ruta
        assertEquals(pantalla.color(R.color.estado_alerta), pantalla.colorDelPunto())
        assertEquals(pantalla.getString(R.string.main_gps_sat, 3), pantalla.texto(R.id.txtGps))
        assertEquals(pantalla.color(R.color.estado_alerta), pantalla.colorDelTexto(R.id.txtGps))

        cambiarDron { it.copy(satelites = EstadoDelDron.SATELITES_MINIMOS, baseFijada = true, detalle = "") }
        assertEquals("listo para despegar", pantalla.color(R.color.estado_ok), pantalla.colorDelPunto())
        assertEquals(pantalla.color(R.color.estado_ok), pantalla.colorDelTexto(R.id.txtGps))
        assertEquals(pantalla.getString(R.string.main_en_suelo), pantalla.texto(R.id.txtVuelo))

        cambiarDron { it.copy(enVuelo = true) }
        assertEquals(pantalla.color(R.color.estado_info), pantalla.colorDelPunto())
        assertEquals(pantalla.getString(R.string.main_en_vuelo), pantalla.texto(R.id.txtVuelo))
        assertEquals(pantalla.color(R.color.estado_info), pantalla.colorDelTexto(R.id.txtVuelo))
        assertEquals("Espía", pantalla.texto(R.id.txtModelo))
    }

    // ---- Telemetría ----

    @Test
    fun laTelemetriaMuestraAlturaRumboYPosicion() {
        val pantalla = banco.abrir()

        telemetria(lat = -34.61, lon = -58.37, alt = 35.0, rumbo = 7.0)

        assertEquals(pantalla.getString(R.string.main_altura_m, 35.0), pantalla.texto(R.id.txtAltitude))
        assertEquals("el rumbo va con tres cifras", "007°", pantalla.texto(R.id.txtHeading))
        assertEquals(pantalla.getString(R.string.main_posicion_valor, -34.61, -58.37), pantalla.texto(R.id.txtPosition))
    }

    /** Sin fix la posición viaja en NaN: se dice cuántos satélites hay, no se imprime "NaN". */
    @Test
    fun sinGpsDiceCuantosSatelitesHayEnVezDeLaPosicion() {
        dron.estado.value = dron.estado.value.copy(satelites = 3)
        val pantalla = banco.abrir()

        telemetria(lat = Double.NaN, lon = Double.NaN)

        assertEquals(pantalla.getString(R.string.main_posicion_sin_gps, 3), pantalla.texto(R.id.txtPosition))
    }

    /** Hasta el 40 % la batería se ve normal; del 40 al 26 en alerta; del 25 para abajo, en peligro. */
    @Test
    fun laBateriaCambiaDeColorEnLosUmbrales() {
        // En el suelo: con el dron en el aire, el 25 % ya dispara el regreso a base
        dron.estado.value = dron.estado.value.copy(enVuelo = false)
        val pantalla = banco.abrir()
        val barra = pantalla.findViewById<LinearProgressIndicator>(R.id.progressBattery)

        for ((pct, color) in listOf(41 to R.color.texto, 40 to R.color.estado_alerta, 26 to R.color.estado_alerta, 25 to R.color.estado_peligro)) {
            telemetria(bateria = pct.toDouble())
            assertEquals(pantalla.getString(R.string.main_bateria_pct, pct), pantalla.texto(R.id.txtBattery))
            assertEquals("color del texto con $pct %", pantalla.color(color), pantalla.colorDelTexto(R.id.txtBattery))
            assertEquals("color de la barra con $pct %", pantalla.color(color), barra.indicatorColor.single())
            assertEquals(pct, barra.progress)
        }
    }

    /**
     * Sin telemetría durante más de 4 s el enlace de radio se da por perdido: la
     * señal dice PERDIDA en rojo y el estado, que vuelve a base. Al volver la
     * telemetría la señal vuelve a mostrar su porcentaje.
     */
    @Test
    fun laSenialPerdidaSeVeEnRojoYVuelveConLaTelemetria() {
        val pantalla = banco.abrir()
        val barra = pantalla.findViewById<LinearProgressIndicator>(R.id.progressSignal)
        telemetria()
        assertEquals(pantalla.getString(R.string.main_senal_ok, 90), pantalla.texto(R.id.txtSignal))
        assertEquals(pantalla.color(R.color.texto), pantalla.colorDelTexto(R.id.txtSignal))
        assertEquals(90, barra.progress)

        // El vigía de la señal mira el reloj de verdad: hay que dejarlo pasar
        Thread.sleep(4_200)
        adelantarElReloj(1)

        assertEquals(pantalla.getString(R.string.main_senal_perdida), pantalla.texto(R.id.txtSignal))
        assertEquals(pantalla.color(R.color.estado_peligro), pantalla.colorDelTexto(R.id.txtSignal))
        assertEquals(0, barra.progress)
        assertEquals(pantalla.getString(R.string.estado_rth_senal), pantalla.texto(R.id.txtState))

        telemetria()
        assertEquals(pantalla.getString(R.string.main_senal_ok, 90), pantalla.texto(R.id.txtSignal))
        assertEquals(pantalla.color(R.color.texto), pantalla.colorDelTexto(R.id.txtSignal))
    }

    // ---- Video ----

    private fun unJpeg(): ByteArray {
        val salida = ByteArrayOutputStream()
        Bitmap.createBitmap(64, 36, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 60, salida)
        return salida.toByteArray()
    }

    @Test
    fun conCuadrosElVisorDiceEnVivoYSinCuadrosVuelveASinVideo() {
        val pantalla = banco.abrir()
        val visor = pantalla.findViewById<ImageView>(R.id.imgVideo)
        assertEquals(pantalla.getString(R.string.main_video_sin_senal), pantalla.texto(R.id.chipVideo))
        assertNull(visor.drawable)

        dron.videoFrames.tryEmit(unJpeg())
        esperarEnLaPantalla("el primer cuadro en el visor") {
            pantalla.texto(R.id.chipVideo) == pantalla.getString(R.string.main_video_en_vivo)
        }
        assertEquals(pantalla.color(R.color.estado_ok), pantalla.colorDelTexto(R.id.chipVideo))
        assertNotNull("el cuadro decodificado queda en el visor", visor.drawable)

        // Un segundo sin cuadros es normal: el video no se da por perdido
        adelantarElReloj(1)
        assertEquals(pantalla.getString(R.string.main_video_en_vivo), pantalla.texto(R.id.chipVideo))

        adelantarElReloj(3)
        assertEquals(pantalla.getString(R.string.main_video_sin_senal), pantalla.texto(R.id.chipVideo))
        assertEquals(pantalla.color(R.color.texto_medio), pantalla.colorDelTexto(R.id.chipVideo))
    }

    /** Las cajas de la detección se dibujan sobre el video de la app, no solo en la consola. */
    @Test
    fun lasCajasDeLaDeteccionSeDibujanSobreElVideo() {
        val pantalla = banco.abrir()
        val cajas = listOf(Caja("PERSON", 0.9, 0.5, 0.5, 0.2, 0.3), Caja("VEHICLE", 0.6, 0.2, 0.7, 0.1, 0.1))

        banco.deteccion.onDetection!!.invoke(Deteccion(listOf("PERSON", "VEHICLE"), 0.9, cajas, null, System.currentTimeMillis()))
        correrLaPantalla()

        assertEquals(cajas, pantalla.findViewById<VistaDeCajas>(R.id.vistaCajas).cajas)
    }

    // ---- Avisos de vuelo ----

    @Test
    fun elAvisoDeDespegueQuedaHastaElProximoYLosDemasSeVanSolos() {
        val pantalla = banco.abrir()
        val aviso = pantalla.findViewById<TextView>(R.id.txtAviso)

        dron.flightEvents.tryEmit(FlightEvent.Despegando)
        correrLaPantalla()
        assertEquals(View.VISIBLE, aviso.visibility)
        assertEquals(pantalla.getString(R.string.main_aviso_despegando), aviso.text.toString())
        assertEquals(pantalla.color(R.color.estado_alerta), aviso.currentTextColor)
        adelantarElReloj(30)
        assertEquals("un despegue en curso no se esconde solo", View.VISIBLE, aviso.visibility)

        dron.flightEvents.tryEmit(FlightEvent.EnElAire)
        correrLaPantalla()
        assertEquals(pantalla.getString(R.string.main_aviso_en_el_aire), aviso.text.toString())
        assertEquals(pantalla.color(R.color.estado_ok), aviso.currentTextColor)
        adelantarElReloj(7)
        assertEquals(View.VISIBLE, aviso.visibility)
        adelantarElReloj(2)
        assertEquals(View.GONE, aviso.visibility)
    }

    /** El motivo del rechazo se muestra tal cual, en rojo: un rechazo mudo es lo peor que puede pasar. */
    @Test
    fun unProblemaDelDronSeMuestraEnRojoConSuMotivo() {
        val pantalla = banco.abrir()
        val aviso = pantalla.findViewById<TextView>(R.id.txtAviso)

        dron.flightEvents.tryEmit(FlightEvent.Problema("La aeronave rechazó el despegue: motores bloqueados"))
        correrLaPantalla()

        assertEquals(View.VISIBLE, aviso.visibility)
        assertEquals("La aeronave rechazó el despegue: motores bloqueados", aviso.text.toString())
        assertEquals(pantalla.color(R.color.estado_peligro), aviso.currentTextColor)

        // Un evento que no es un aviso (pasar por un nodo) no lo pisa ni lo esconde
        dron.flightEvents.tryEmit(FlightEvent.WaypointReached(0))
        correrLaPantalla()
        assertEquals("La aeronave rechazó el despegue: motores bloqueados", aviso.text.toString())

        adelantarElReloj(9)
        assertEquals(View.GONE, aviso.visibility)
    }

    // ---- Registro local ----

    @Test
    fun laPestaniaRegistroMuestraElRegistroYOperacionLoEsconde() {
        val pantalla = banco.abrir()
        val grupo = pantalla.findViewById<MaterialButtonToggleGroup>(R.id.grupoVistas)
        val operativo = pantalla.findViewById<View>(R.id.panelOperativo)
        val registro = pantalla.findViewById<View>(R.id.panelLogs)
        assertEquals(View.VISIBLE, operativo.visibility)
        assertEquals(View.GONE, registro.visibility)

        grupo.check(R.id.btnVerLogs)
        assertEquals(View.GONE, operativo.visibility)
        assertEquals(View.VISIBLE, registro.visibility)

        grupo.check(R.id.btnVistaOperativa)
        assertEquals(View.VISIBLE, operativo.visibility)
        assertEquals(View.GONE, registro.visibility)
    }

    /** Lo más nuevo arriba, y como mucho 80 líneas: en una salida larga no puede crecer sin fin. */
    @Test
    fun elRegistroPoneLoMasNuevoArribaYGuardaLasUltimas80Lineas() {
        val pantalla = banco.abrir()
        assertEquals(pantalla.getString(R.string.main_registro_vacio), pantalla.texto(R.id.txtLocalLog))

        // Un aterrizaje pedido sin el control tomado solo deja una línea en el registro
        for (n in 1..85) {
            banco.comando.manejarMensaje("""{"type":"land","by":"operador-$n"}""")
            correrLaPantalla()
        }

        val lineas = pantalla.texto(R.id.txtLocalLog).lines()
        assertEquals(80, lineas.size)
        assertEquals("operador-85 pidió aterrizar sin el control manual tomado: se ignora", lineas.first())
        assertEquals("las cinco más viejas se descartan", "operador-6 pidió aterrizar sin el control manual tomado: se ignora", lineas.last())
    }
}
