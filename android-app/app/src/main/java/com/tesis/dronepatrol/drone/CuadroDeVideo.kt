package com.tesis.dronepatrol.drone

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream

/**
 * Cuadros de video del dron real: del formato en el que los entrega el MSDK
 * (NV21, el que sale de la cámara) al JPEG chico que viaja por el WebSocket.
 *
 * Vive en el sourceSet `main` y no en el del flavor `dji` a propósito: es la
 * única parte del video real que se puede probar sin dron —y CI solo compila el
 * flavor mock—, así que el archivo del flavor queda apenas con el pegamento del
 * SDK y toda la cuenta queda acá, cubierta por pruebas.
 */
object CuadroDeVideo {

    /**
     * Ancho al que se reescala cada cuadro. El stream del Mini 4 Pro llega en
     * 1920x1080 o 1280x720: mandar eso cinco veces por segundo por el enlace del
     * celular no entra, y en la consola el video se mira en un panel chico.
     */
    const val ANCHO_MAXIMO = 640

    /** Calidad del JPEG, la misma que ya usa el video del simulador. */
    const val CALIDAD_JPEG = 60

    /** 5 cuadros por segundo hacia el Comando Central, como fija el contrato. */
    const val INTERVALO_CUADRO_MS = 200L

    /** Medidas en pixeles de un cuadro. */
    data class Tamanio(val ancho: Int, val alto: Int)

    /**
     * Medidas a las que se reescala un cuadro de [anchoOrigen]x[altoOrigen]:
     * conserva la relación de aspecto y no pasa de [ANCHO_MAXIMO].
     *
     * Los dos lados quedan pares porque el plano de croma del NV21 trae un par
     * (V,U) por cada bloque de 2x2 pixeles: un lado impar deja media muestra
     * colgada y no aporta nada.
     */
    fun tamanioDestino(anchoOrigen: Int, altoOrigen: Int): Tamanio {
        require(anchoOrigen >= 2 && altoOrigen >= 2) {
            "Un cuadro de ${anchoOrigen}x$altoOrigen no es un cuadro de video"
        }
        val ancho = aPar(minOf(anchoOrigen, ANCHO_MAXIMO))
        val alto = aPar(Math.round(ancho.toDouble() * altoOrigen / anchoOrigen).toInt())
        return Tamanio(ancho, alto)
    }

    /** Redondea hacia abajo al par más cercano, sin llegar nunca a cero. */
    private fun aPar(valor: Int): Int = maxOf(2, valor - (valor % 2))

    /**
     * Convierte un cuadro NV21 a pixeles ARGB submuestreando al vuelo.
     *
     * El submuestreo es "vecino más cercano" y se hace leyendo ÚNICAMENTE los
     * pixeles que van al destino: un cuadro 1920x1080 tiene más de dos millones
     * de pixeles y convertirlos todos para después tirar el 89% sería trabajo al
     * tacho en un celular que además está comprimiendo, mandando por WiFi y
     * dibujando la pantalla de operación.
     *
     * Devuelve null si el arreglo no alcanza para el cuadro declarado (el SDK
     * puede entregar un buffer corto en pleno reenganche del enlace): perder un
     * cuadro de treinta no se nota, y tirar una excepción acá mataría el hilo
     * del decodificador del MSDK, que es el que llama.
     */
    fun nv21AArgb(
        nv21: ByteArray,
        offset: Int,
        anchoOrigen: Int,
        altoOrigen: Int,
        destino: Tamanio,
    ): IntArray? {
        if (offset < 0 || anchoOrigen < 2 || altoOrigen < 2) return null
        if (destino.ancho < 1 || destino.alto < 1) return null
        // NV21: primero el plano de luminancia (un byte por pixel) y después el
        // de croma, con un par (V,U) cada bloque de 2x2 pixeles. De ahí el 3/2.
        val necesarios = anchoOrigen * altoOrigen * 3 / 2
        if (nv21.size - offset < necesarios) return null

        val baseCroma = offset + anchoOrigen * altoOrigen
        val pixeles = IntArray(destino.ancho * destino.alto)
        var i = 0
        for (yDestino in 0 until destino.alto) {
            val yOrigen = yDestino * altoOrigen / destino.alto
            val filaLuma = offset + yOrigen * anchoOrigen
            // Dos filas de pixeles comparten una fila de croma
            val filaCroma = baseCroma + (yOrigen / 2) * anchoOrigen
            for (xDestino in 0 until destino.ancho) {
                val xOrigen = xDestino * anchoOrigen / destino.ancho
                val luz = (nv21[filaLuma + xOrigen].toInt() and 0xFF) - 16
                val croma = filaCroma + (xOrigen / 2) * 2
                val v = (nv21[croma].toInt() and 0xFF) - 128
                val u = (nv21[croma + 1].toInt() and 0xFF) - 128
                pixeles[i++] = argb(luz.coerceAtLeast(0), u, v)
            }
        }
        return pixeles
    }

    /**
     * YUV (BT.601, rango de video 16..235) → ARGB opaco. Los coeficientes van en
     * enteros escalados por 1024 para no hacer punto flotante medio millón de
     * veces por cuadro.
     *
     * El recorte a 0..255 no es opcional: hay combinaciones de croma que el
     * espacio YUV admite y el RGB no, y sin recortar esos valores se desbordan
     * sobre los bits del canal de al lado (un rojo pasado de rosca se comería el
     * alfa y el pixel saldría transparente).
     */
    private fun argb(luz: Int, u: Int, v: Int): Int {
        val base = 1192 * luz
        val r = ((base + 1634 * v) shr 10).coerceIn(0, 255)
        val g = ((base - 833 * v - 400 * u) shr 10).coerceIn(0, 255)
        val b = ((base + 2066 * u) shr 10).coerceIn(0, 255)
        return (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }

    /**
     * El camino completo del dron real: NV21 → pixeles reescalados → JPEG.
     * Devuelve null por el mismo motivo que [nv21AArgb]: el cuadro vino corto o
     * con medidas imposibles y se descarta sin hacer ruido.
     */
    fun nv21AJpeg(nv21: ByteArray, offset: Int, anchoOrigen: Int, altoOrigen: Int): ByteArray? {
        if (anchoOrigen < 2 || altoOrigen < 2) return null
        val destino = tamanioDestino(anchoOrigen, altoOrigen)
        val pixeles = nv21AArgb(nv21, offset, anchoOrigen, altoOrigen, destino) ?: return null
        return aJpeg(pixeles, destino)
    }

    /**
     * Comprime los pixeles ya convertidos. Va aparte de la conversión porque
     * necesita android.graphics: así lo puro se prueba en la JVM pelada y esto
     * con Robolectric, igual que el video del dron simulado.
     */
    fun aJpeg(pixeles: IntArray, destino: Tamanio, calidad: Int = CALIDAD_JPEG): ByteArray {
        require(pixeles.size >= destino.ancho * destino.alto) {
            "Faltan pixeles para un cuadro de ${destino.ancho}x${destino.alto}"
        }
        val mapa = Bitmap.createBitmap(pixeles, destino.ancho, destino.alto, Bitmap.Config.ARGB_8888)
        val salida = ByteArrayOutputStream()
        mapa.compress(Bitmap.CompressFormat.JPEG, calidad, salida)
        mapa.recycle()
        return salida.toByteArray()
    }
}
