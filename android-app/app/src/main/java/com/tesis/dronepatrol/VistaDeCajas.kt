package com.tesis.dronepatrol

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import com.tesis.dronepatrol.drone.AnotadorDeCuadros
import com.tesis.dronepatrol.model.Caja

/**
 * Las cajas de la detección encima del visor de video de la app. Va como una
 * vista aparte, del mismo tamaño que el visor, para no tener que re-codificar
 * el cuadro en el teléfono: el visor y el cuadro son 16:9, así que las
 * coordenadas normalizadas de las cajas caen derecho sobre la vista.
 */
class VistaDeCajas @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    var cajas: List<Caja> = emptyList()
        set(valor) {
            field = valor
            invalidate()
        }

    private val trazo = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 4f
        isAntiAlias = true
    }
    private val texto = Paint().apply {
        textSize = 28f
        isAntiAlias = true
        isFakeBoldText = true
        color = Color.BLACK
    }
    private val fondo = Paint().apply { style = Paint.Style.FILL }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val ancho = width.toFloat()
        val alto = height.toFloat()
        for (c in cajas) {
            val color = AnotadorDeCuadros.colorDe(c.clase)
            val izq = ((c.x - c.ancho / 2) * ancho).toFloat()
            val arr = ((c.y - c.alto / 2) * alto).toFloat()
            val der = ((c.x + c.ancho / 2) * ancho).toFloat()
            val aba = ((c.y + c.alto / 2) * alto).toFloat()
            trazo.color = color
            canvas.drawRect(izq, arr, der, aba, trazo)
            val etiqueta = "%s %.2f".format(c.clase, c.confianza)
            val yTexto = if (arr - texto.textSize - 6 > 0) arr - 6 else aba + texto.textSize
            fondo.color = color
            canvas.drawRect(izq, yTexto - texto.textSize, izq + texto.measureText(etiqueta) + 12, yTexto + 6, fondo)
            canvas.drawText(etiqueta, izq + 6, yTexto, texto)
        }
    }
}
