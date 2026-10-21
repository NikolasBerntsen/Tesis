package com.tesis.dronepatrol.drone

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.tesis.dronepatrol.model.Caja
import java.io.ByteArrayOutputStream

/**
 * Dibuja las cajas de la detección sobre un cuadro JPEG, para que el operador
 * de la consola vea en el video en vivo QUÉ disparó la alerta y dónde. Las
 * cajas vienen normalizadas (0..1), así valen sobre el cuadro de 640 px de la
 * consola aunque el detector las haya calculado sobre el de 1280.
 */
object AnotadorDeCuadros {

    private const val CALIDAD_JPEG = 65

    fun colorDe(clase: String): Int = if (clase == "VEHICLE") Color.rgb(90, 176, 255) else Color.rgb(61, 214, 140)

    /**
     * El cuadro con las cajas encima, o el mismo cuadro si no hay cajas o no
     * se pudo decodificar: anotar nunca puede dejar a la consola sin video.
     */
    fun anotar(jpeg: ByteArray, cajas: List<Caja>): ByteArray {
        if (cajas.isEmpty()) return jpeg
        val mapa = runCatching { BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) }.getOrNull() ?: return jpeg
        val lienzo = runCatching { mapa.copy(Bitmap.Config.ARGB_8888, true) }.getOrNull() ?: return jpeg
        mapa.recycle()
        val canvas = Canvas(lienzo)
        val ancho = lienzo.width.toFloat()
        val alto = lienzo.height.toFloat()
        val grosor = (ancho / 320f).coerceAtLeast(2f)
        val trazo = Paint().apply {
            style = Paint.Style.STROKE
            strokeWidth = grosor
            isAntiAlias = true
        }
        val texto = Paint().apply {
            textSize = (ancho / 40f).coerceAtLeast(12f)
            isAntiAlias = true
            isFakeBoldText = true
        }
        val fondo = Paint().apply { style = Paint.Style.FILL }
        for (c in cajas) {
            val color = colorDe(c.clase)
            val izq = ((c.x - c.ancho / 2) * ancho).toFloat()
            val arr = ((c.y - c.alto / 2) * alto).toFloat()
            val der = ((c.x + c.ancho / 2) * ancho).toFloat()
            val aba = ((c.y + c.alto / 2) * alto).toFloat()
            trazo.color = color
            canvas.drawRect(izq, arr, der, aba, trazo)
            val etiqueta = "%s %.2f".format(c.clase, c.confianza)
            val anchoTexto = texto.measureText(etiqueta)
            val altoTexto = texto.textSize
            val yTexto = if (arr - altoTexto - 4 > 0) arr - 4 else aba + altoTexto
            fondo.color = color
            canvas.drawRect(izq, yTexto - altoTexto, izq + anchoTexto + 8, yTexto + 4, fondo)
            texto.color = Color.BLACK
            canvas.drawText(etiqueta, izq + 4, yTexto, texto)
        }
        val salida = ByteArrayOutputStream()
        lienzo.compress(Bitmap.CompressFormat.JPEG, CALIDAD_JPEG, salida)
        lienzo.recycle()
        return salida.toByteArray()
    }
}
