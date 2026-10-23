package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.drone.ConfirmacionDelAterrizaje.Accion
import com.tesis.dronepatrol.drone.ConfirmacionDelAterrizaje.Situacion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Qué se le contesta al dron cuando pide confirmar el aterrizaje (RELEVOS §4):
 * en la base la app lo confirma; en un desvío o en la última ubicación se corre
 * 10 m y reintenta hasta dos veces, y confirma recién con la batería en el
 * crítico + 1; un aterrizaje forzado por batería crítica se confirma con esa
 * misma regla.
 */
class ConfirmacionDelAterrizajeTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
    }

    private val confirmacion = ConfirmacionDelAterrizaje()

    private fun situacion(
        ordenado: Boolean = true,
        fueraDeBase: Boolean = false,
        forzado: Boolean = false,
        bateria: Double = 40.0,
        umbralCritico: Double = 10.0,
    ) = Situacion(ordenado, fueraDeBase, forzado, bateria, umbralCritico)

    // ---- Un aterrizaje de siempre ----

    @Test
    fun enLaBaseLoQueOrdenoLaAppSeConfirmaUnaSolaVez() {
        assertEquals(Accion.CONFIRMAR, confirmacion.alPedir(true, situacion()))
        // El SDK repite el pedido y la batería sigue bajando: no se confirma dos veces.
        assertEquals(Accion.NADA, confirmacion.alPedir(true, situacion()))
        assertEquals(Accion.NADA, confirmacion.alActualizar(situacion(bateria = 39.0)))
    }

    /** Las palancas del operador: no es de la app. */
    @Test
    fun loQueNoOrdenoLaAppNoEsDeLaApp() {
        assertEquals(Accion.NADA, confirmacion.alPedir(true, situacion(ordenado = false)))
        assertEquals(Accion.NADA, confirmacion.alActualizar(situacion(ordenado = false, bateria = 5.0)))
    }

    @Test
    fun sinPedidoNoHayNadaQueHacer() {
        assertEquals(Accion.NADA, confirmacion.alPedir(false, situacion()))
        assertEquals(Accion.NADA, confirmacion.alActualizar(situacion(fueraDeBase = true, bateria = 5.0)))
    }

    /** Dejó de pedir y vuelve a pedir: es otro pedido, y se contesta otra vez. */
    @Test
    fun unPedidoNuevoSeVuelveAContestar() {
        confirmacion.alPedir(true, situacion())
        confirmacion.alPedir(false, situacion())

        assertEquals(Accion.CONFIRMAR, confirmacion.alPedir(true, situacion()))
    }

    // ---- En un desvío o en la última ubicación ----

    @Test
    fun fueraDeBaseSeCorreDosVecesYDespuesEspera() {
        assertEquals(Accion.CORRERSE, confirmacion.alPedir(true, situacion(fueraDeBase = true)))
        // Mientras se corre, el pedido que el SDK repite no arranca otro corrimiento.
        assertEquals(Accion.NADA, confirmacion.alPedir(true, situacion(fueraDeBase = true)))
        confirmacion.alTerminarDeCorrerse()
        confirmacion.alPedir(false, situacion(fueraDeBase = true))

        assertEquals(Accion.CORRERSE, confirmacion.alPedir(true, situacion(fueraDeBase = true)))
        confirmacion.alTerminarDeCorrerse()
        confirmacion.alPedir(false, situacion(fueraDeBase = true))

        assertEquals(Accion.ESPERAR, confirmacion.alPedir(true, situacion(fueraDeBase = true)))
        assertEquals("sigue esperando", Accion.ESPERAR, confirmacion.alActualizar(situacion(fueraDeBase = true, bateria = 20.0)))
    }

    /** Esperando, la batería que baja hasta el crítico + 1 es lo que lo confirma; una sola vez. */
    @Test
    fun conLaBateriaEnElCriticoMasUnoSeConfirma() {
        repeat(ConfirmacionDelAterrizaje.MAXIMO_CORRIMIENTOS) {
            confirmacion.alPedir(true, situacion(fueraDeBase = true))
            confirmacion.alTerminarDeCorrerse()
            confirmacion.alPedir(false, situacion(fueraDeBase = true))
        }
        confirmacion.alPedir(true, situacion(fueraDeBase = true))

        assertEquals(Accion.ESPERAR, confirmacion.alActualizar(situacion(fueraDeBase = true, bateria = 11.5)))
        assertEquals(Accion.CONFIRMAR, confirmacion.alActualizar(situacion(fueraDeBase = true, bateria = 11.0)))
        assertEquals(Accion.NADA, confirmacion.alActualizar(situacion(fueraDeBase = true, bateria = 10.0)))
    }

    /** Ya con la batería en el crítico + 1 no hay tiempo de correrse: se confirma de entrada. */
    @Test
    fun fueraDeBaseConLaBateriaCriticaSeConfirmaSinCorrerse() {
        assertEquals(Accion.CONFIRMAR, confirmacion.alPedir(true, situacion(fueraDeBase = true, bateria = 10.5)))
    }

    /** El umbral es el que informa el DJI: con uno de 15 %, el 16 % ya alcanza. */
    @Test
    fun elUmbralEsElDelPropioDji() {
        assertEquals(
            Accion.CONFIRMAR,
            confirmacion.alPedir(true, situacion(fueraDeBase = true, bateria = 16.0, umbralCritico = 15.0)),
        )
    }

    /** Si el DJI no informó su umbral, el de fábrica del Mini 4 Pro (10 %). */
    @Test
    fun sinElUmbralDelDjiVaElDeFabrica() {
        assertEquals(
            Accion.CORRERSE,
            confirmacion.alPedir(true, situacion(fueraDeBase = true, bateria = 11.5, umbralCritico = Double.NaN)),
        )
        confirmacion.alTerminarDeCorrerse()
        confirmacion.alPedir(false, situacion(fueraDeBase = true))
        assertEquals(
            Accion.CONFIRMAR,
            confirmacion.alPedir(true, situacion(fueraDeBase = true, bateria = 11.0, umbralCritico = Double.NaN)),
        )
    }

    /** Una lectura de batería sin sentido no confirma nada. */
    @Test
    fun sinLecturaDeBateriaNoSeConfirma() {
        assertEquals(Accion.CORRERSE, confirmacion.alPedir(true, situacion(fueraDeBase = true, bateria = Double.NaN)))
        assertEquals(
            Accion.NADA,
            confirmacion.alActualizar(situacion(fueraDeBase = true, bateria = Double.NEGATIVE_INFINITY)),
        )
        confirmacion.alTerminarDeCorrerse()
        assertEquals(
            Accion.CORRERSE,
            confirmacion.alActualizar(situacion(fueraDeBase = true, bateria = Double.NEGATIVE_INFINITY)),
        )
    }

    /** Un umbral sin sentido es como no tenerlo: el de fábrica. */
    @Test
    fun unUmbralInfinitoEsComoNoTenerlo() {
        assertEquals(
            Accion.CONFIRMAR,
            confirmacion.alPedir(true, situacion(fueraDeBase = true, bateria = 11.0, umbralCritico = Double.POSITIVE_INFINITY)),
        )
    }

    /** Fuera de base y sin que la app lo ordenara (el failsafe de señal aterrizando): no se corre, espera. */
    @Test
    fun fueraDeBaseSinOrdenDeLaAppNoSeCorre() {
        assertEquals(Accion.ESPERAR, confirmacion.alPedir(true, situacion(ordenado = false, fueraDeBase = true)))
        assertEquals(Accion.CONFIRMAR, confirmacion.alActualizar(situacion(ordenado = false, fueraDeBase = true, bateria = 9.0)))
    }

    // ---- El aterrizaje forzado del DJI ----

    /**
     * El DJI forzó el aterrizaje por batería crítica: sin confirmar quedaba
     * suspendido a medio metro hasta agotarse. Ya está en el crítico: se confirma.
     */
    @Test
    fun elAterrizajeForzadoSeConfirma() {
        assertEquals(Accion.CONFIRMAR, confirmacion.alPedir(true, situacion(ordenado = false, forzado = true, bateria = 10.0)))
    }

    /** Forzado con la lectura de batería todavía arriba: espera (no se corre, el vuelo es del DJI). */
    @Test
    fun elAterrizajeForzadoNoSeCorre() {
        assertEquals(Accion.ESPERAR, confirmacion.alPedir(true, situacion(ordenado = true, forzado = true, bateria = 14.0)))
        assertEquals(Accion.CONFIRMAR, confirmacion.alActualizar(situacion(ordenado = true, forzado = true, bateria = 11.0)))
    }

    // ---- De cero ----

    @Test
    fun reiniciarDevuelveLosCorrimientos() {
        repeat(ConfirmacionDelAterrizaje.MAXIMO_CORRIMIENTOS) {
            confirmacion.alPedir(true, situacion(fueraDeBase = true))
            confirmacion.alTerminarDeCorrerse()
            confirmacion.alPedir(false, situacion(fueraDeBase = true))
        }

        confirmacion.reiniciar()

        assertEquals(Accion.CORRERSE, confirmacion.alPedir(true, situacion(fueraDeBase = true)))
        confirmacion.reiniciar()
        assertEquals("sin pedido en pie", Accion.NADA, confirmacion.alActualizar(situacion(fueraDeBase = true, bateria = 5.0)))
    }

    // ---- A dónde correrse ----

    @Test
    fun elPuntoCorridoQuedaDiezMetrosHaciaLaNariz() {
        val (alNorteLat, alNorteLon) = ConfirmacionDelAterrizaje.puntoCorrido(LAT, LON, 0.0)!!
        assertEquals(10.0, (alNorteLat - LAT) * Geo.METROS_POR_GRADO_LAT, 1e-6)
        assertEquals(LON, alNorteLon, 1e-12)

        val (alEsteLat, alEsteLon) = ConfirmacionDelAterrizaje.puntoCorrido(LAT, LON, 90.0)!!
        assertEquals(LAT, alEsteLat, 1e-9)
        assertEquals(10.0, Geo.distanciaM(LAT, LON, alEsteLat, alEsteLon), 1e-6)
        assertEquals(90.0, Geo.rumboHacia(LAT, LON, alEsteLat, alEsteLon), 1e-6)

        val (lat, lon) = ConfirmacionDelAterrizaje.puntoCorrido(LAT, LON, 225.0, metros = 30.0)!!
        assertEquals(30.0, Geo.distanciaM(LAT, LON, lat, lon), 1e-6)
        assertEquals(-135.0, Geo.rumboHacia(LAT, LON, lat, lon), 1e-6)
    }

    @Test
    fun sinPosicionORumboNoHayPuntoCorrido() {
        assertNull(ConfirmacionDelAterrizaje.puntoCorrido(0.0, 0.0, 90.0))
        assertNull(ConfirmacionDelAterrizaje.puntoCorrido(Double.NaN, LON, 90.0))
        assertNull(ConfirmacionDelAterrizaje.puntoCorrido(LAT, LON, Double.NaN))
        assertNull(ConfirmacionDelAterrizaje.puntoCorrido(LAT, LON, Double.NEGATIVE_INFINITY))
        assertNull(ConfirmacionDelAterrizaje.puntoCorrido(LAT, LON, 90.0, metros = Double.POSITIVE_INFINITY))
        assertNull(ConfirmacionDelAterrizaje.puntoCorrido(LAT, LON, 90.0, metros = Double.NaN))
    }
}
