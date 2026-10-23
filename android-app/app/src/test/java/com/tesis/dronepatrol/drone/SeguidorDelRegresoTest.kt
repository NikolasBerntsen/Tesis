package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.drone.SeguidorDelRegreso.Fase
import com.tesis.dronepatrol.drone.SeguidorDelRegreso.Orden
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Qué avisa cada novedad del regreso a base (RELEVOS §2.3 y §4): el descenso en
 * la base una vez y solo si el regreso es de la app; la toma del control una vez
 * por episodio aunque llegue por dos caminos; y un solo intento de cortar un
 * regreso que arrancó el propio DJI.
 */
class SeguidorDelRegresoTest {

    private val seguidor = SeguidorDelRegreso()

    private fun toma(motivo: MotivoDelDron) = FlightEvent.ElDronTomoElControl(motivo)

    // ---- El descenso en la base ----

    @Test
    fun elRegresoDeLaAppAvisaElDescensoUnaSolaVez() {
        seguidor.alOrdenar(Orden.REGRESO)

        assertNull(seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.REGRESO, MotivoDelDron.OTRO))
        assertSame(FlightEvent.DescendiendoEnBase, seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.REGRESO, MotivoDelDron.OTRO))
        // El SDK repite el estado (o la app pregunta de nuevo): no es otro descenso.
        assertNull(seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.REGRESO, MotivoDelDron.OTRO))
        assertTrue(seguidor.volviendo)
    }

    /** Un regreso nuevo de la app vuelve a habilitar el aviso. */
    @Test
    fun otroRegresoDeLaAppVuelveAAvisarElDescenso() {
        seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.REGRESO, MotivoDelDron.OTRO)
        seguidor.alOrdenar(Orden.REGRESO)

        assertSame(FlightEvent.DescendiendoEnBase, seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.REGRESO, MotivoDelDron.OTRO))
    }

    /** Pedir aterrizar donde está y bajar es lo pedido: ni descenso en base ni toma. */
    @Test
    fun bajarDespuesDePedirAterrizarNoAvisaNada() {
        assertNull(seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.ATERRIZAJE, MotivoDelDron.OTRO))
    }

    @Test
    fun losEstadosQueNoSonDelRegresoNoAvisanNada() {
        assertNull(seguidor.alCambiarFase(Fase.OTRA, Orden.NINGUNA, MotivoDelDron.OTRO))
        assertFalse(seguidor.volviendo)
        assertNull(seguidor.alCambiarFase(Fase.INACTIVO, Orden.REGRESO, MotivoDelDron.OTRO))
        assertFalse(seguidor.volviendo)
    }

    // ---- La toma del control ----

    @Test
    fun unRegresoQueNadiePidioEsUnaToma() {
        val aviso = seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA)

        assertEquals(toma(MotivoDelDron.RTH_BATERIA), aviso)
        // Al bajar al final del mismo regreso no se repite, ni se avisa un
        // descenso que la app no pidió.
        assertNull(seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA))
    }

    /** Pidió aterrizar acá y el dron salió para casa: eso tampoco lo pidió nadie. */
    @Test
    fun volverCuandoSePidioAterrizarAcaEsUnaToma() {
        assertEquals(
            toma(MotivoDelDron.OTRO),
            seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.ATERRIZAJE, MotivoDelDron.OTRO),
        )
    }

    /** La app se conectó con el dron ya bajando en casa por su cuenta: la toma se avisa igual. */
    @Test
    fun bajarEnCasaSinQueNadieLoPidaEsUnaToma() {
        assertEquals(
            toma(MotivoDelDron.RTH_SENIAL),
            seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.NINGUNA, MotivoDelDron.RTH_SENIAL),
        )
    }

    /** El cambio de autoridad y el estado del regreso suelen llegar juntos: un solo aviso. */
    @Test
    fun laMismaTomaPorDosCaminosSeAvisaUnaVez() {
        assertEquals(toma(MotivoDelDron.RTH_BATERIA), seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA))

        assertNull(seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA))
        assertNull(seguidor.alTomarElControl(MotivoDelDron.RTH_DEL_CONTROL))
    }

    /** El aterrizaje forzado es otra noticia: dispara el protocolo de última ubicación sin control. */
    @Test
    fun elAterrizajeForzadoSeAvisaAunqueYaSeHayaAvisadoElRegreso() {
        seguidor.alArrancarRegresoPropio(MotivoDelDron.RTH_BATERIA)

        assertEquals(
            toma(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA),
            seguidor.alTomarElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA),
        )
        assertNull(seguidor.alTomarElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA))
    }

    @Test
    fun elRegresoPropioQueSeVeDirectoAvisaYQuedaVolviendo() {
        assertEquals(toma(MotivoDelDron.RTH_DEL_CONTROL), seguidor.alArrancarRegresoPropio(MotivoDelDron.RTH_DEL_CONTROL))
        assertTrue(seguidor.volviendo)
    }

    /** Cortado el regreso, si el dron lo vuelve a arrancar es una toma nueva y se avisa otra vez. */
    @Test
    fun unRegresoPropioQueVuelveAArrancarSeAvisaOtraVez() {
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA)
        seguidor.alCambiarFase(Fase.INACTIVO, Orden.NINGUNA, MotivoDelDron.OTRO)

        assertEquals(
            toma(MotivoDelDron.RTH_BATERIA),
            seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA),
        )
    }

    // ---- Un solo corte del regreso propio ----

    @Test
    fun elRegresoDeLaAppSeCortaLasVecesQueHagaFalta() {
        repeat(3) {
            seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.REGRESO, MotivoDelDron.OTRO)
            assertTrue("intento ${it + 1}", seguidor.puedeCortar())
            seguidor.alCortar()
            seguidor.alCambiarFase(Fase.INACTIVO, Orden.NINGUNA, MotivoDelDron.OTRO)
        }
    }

    @Test
    fun unRegresoPropioSeCortaUnaSolaVezPorVuelo() {
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA)
        assertTrue(seguidor.puedeCortar())
        seguidor.alCortar()
        seguidor.alCambiarFase(Fase.INACTIVO, Orden.NINGUNA, MotivoDelDron.OTRO)

        // El DJI lo vuelve a arrancar: se lo deja seguir.
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA)
        assertFalse(seguidor.puedeCortar())
    }

    /** La app adopta un regreso propio (returnHome): sigue siendo el del dron para la regla del corte. */
    @Test
    fun adoptarUnRegresoPropioNoLeDaOtroCorte() {
        seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA)
        seguidor.alOrdenar(Orden.REGRESO)
        seguidor.alCortar()
        seguidor.alCambiarFase(Fase.INACTIVO, Orden.NINGUNA, MotivoDelDron.OTRO)

        seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA)
        assertFalse(seguidor.puedeCortar())
    }

    /** Un aterrizaje forzado no es un regreso: no gasta ni bloquea el corte de uno. */
    @Test
    fun elAterrizajeForzadoNoCuentaComoRegresoPropio() {
        seguidor.alTomarElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA)
        assertTrue(seguidor.puedeCortar())
        seguidor.alCortar()
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA)
        assertTrue("el corte del regreso propio sigue entero", seguidor.puedeCortar())
    }

    /** Al tocar el suelo todo vuelve a empezar: el vuelo siguiente tiene su corte y sus avisos. */
    @Test
    fun alAterrizarElVueloSiguienteArrancaDeCero() {
        seguidor.alArrancarRegresoPropio(MotivoDelDron.RTH_BATERIA)
        seguidor.alCortar()
        seguidor.alTomarElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA)
        seguidor.alAterrizar()

        assertFalse(seguidor.volviendo)
        assertEquals(toma(MotivoDelDron.RTH_BATERIA), seguidor.alArrancarRegresoPropio(MotivoDelDron.RTH_BATERIA))
        assertTrue(seguidor.puedeCortar())
        assertEquals(
            toma(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA),
            seguidor.alTomarElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA),
        )
    }
}
