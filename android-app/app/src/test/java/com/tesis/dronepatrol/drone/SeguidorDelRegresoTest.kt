package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.drone.SeguidorDelRegreso.Corte
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

    /** Pedir aterrizar acá no es otro regreso: no vuelve a habilitar el aviso del descenso. */
    @Test
    fun ordenarUnAterrizajeNoReponeElAvisoDelDescenso() {
        seguidor.alOrdenar(Orden.REGRESO)
        assertSame(FlightEvent.DescendiendoEnBase, seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.REGRESO, MotivoDelDron.OTRO))

        seguidor.alOrdenar(Orden.ATERRIZAJE)

        assertNull(seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.REGRESO, MotivoDelDron.OTRO))
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
        assertNull(seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA))
    }

    /**
     * Un regreso por señal que después el DJI convierte en el suyo por batería
     * es otra noticia: ahora bloquea a la app, y sin el aviso la patrulla no se
     * enteraba ni podía hacer su único intento de cortarlo (RELEVOS §4).
     */
    @Test
    fun deLaSenialALaBateriaSeAvisaOtraVez() {
        assertEquals(toma(MotivoDelDron.RTH_SENIAL), seguidor.alTomarElControl(MotivoDelDron.RTH_SENIAL))

        assertEquals(toma(MotivoDelDron.RTH_BATERIA), seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA))
    }

    /** Una persona apretó el botón de regreso durante el del DJI: la app tiene que saber que ya no lo puede cortar. */
    @Test
    fun deLaBateriaAlBotonDelControlSeAvisaOtraVez() {
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA)

        assertEquals(toma(MotivoDelDron.RTH_DEL_CONTROL), seguidor.alTomarElControl(MotivoDelDron.RTH_DEL_CONTROL))
        assertEquals(Corte.LO_PIDIO_EL_CONTROL, seguidor.corte())
    }

    /**
     * Lo que pesa menos no tapa lo que ya se avisó: el estado del regreso sin
     * explicación (OTRO), o la señal que se cae durante el regreso por batería,
     * siguen siendo el mismo episodio.
     */
    @Test
    fun unMotivoQuePesaMenosNoSeVuelveAAvisar() {
        seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA)

        assertNull(seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.OTRO))
        assertNull(seguidor.alTomarElControl(MotivoDelDron.RTH_SENIAL))
        assertNull(seguidor.alCambiarFase(Fase.DESCENDIENDO, Orden.NINGUNA, MotivoDelDron.OTRO))
    }

    /** El estado del regreso llegó antes que el cambio de autoridad: el motivo de verdad se avisa igual. */
    @Test
    fun unRegresoSinExplicarQueDespuesSeExplicaSeAvisaConElMotivo() {
        assertEquals(toma(MotivoDelDron.OTRO), seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.OTRO))

        assertEquals(toma(MotivoDelDron.RTH_BATERIA), seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA))
    }

    /**
     * Una toma sin regreso (un estacionario, el failsafe de señal en aterrizar)
     * no terminaba nunca: no hay un regreso que vuelva a IDLE. Si la app
     * retoma el mando, la próxima toma —aunque sea por lo mismo— se avisa.
     */
    @Test
    fun retomarElMandoTerminaUnaTomaSinRegreso() {
        assertEquals(toma(MotivoDelDron.RTH_SENIAL), seguidor.alTomarElControl(MotivoDelDron.RTH_SENIAL))
        assertNull("sin retomar, es el mismo episodio", seguidor.alTomarElControl(MotivoDelDron.RTH_SENIAL))

        seguidor.alRetomarElMando()

        assertEquals(toma(MotivoDelDron.RTH_SENIAL), seguidor.alTomarElControl(MotivoDelDron.RTH_SENIAL))
        seguidor.alRetomarElMando()
        assertEquals(toma(MotivoDelDron.OTRO), seguidor.alTomarElControl(MotivoDelDron.OTRO))
    }

    /** Con el regreso en curso, retomar el mando no cierra nada: ese episodio lo cierra el regreso. */
    @Test
    fun retomarElMandoConElRegresoEnCursoNoCambiaNada() {
        seguidor.alArrancarRegresoPropio(MotivoDelDron.RTH_BATERIA)
        seguidor.alCortar()

        seguidor.alRetomarElMando()

        assertNull(seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA))
        assertEquals(Corte.YA_SE_CORTO, seguidor.corte())
        assertTrue(seguidor.volviendo)
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
            assertEquals("intento ${it + 1}", Corte.SE_PUEDE, seguidor.corte())
            seguidor.alCortar()
            seguidor.alCambiarFase(Fase.INACTIVO, Orden.NINGUNA, MotivoDelDron.OTRO)
        }
    }

    @Test
    fun unRegresoPropioSeCortaUnaSolaVezPorVuelo() {
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA)
        assertEquals(Corte.SE_PUEDE, seguidor.corte())
        seguidor.alCortar()
        seguidor.alCambiarFase(Fase.INACTIVO, Orden.NINGUNA, MotivoDelDron.OTRO)

        // El DJI lo vuelve a arrancar: se lo deja seguir.
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA)
        assertEquals(Corte.YA_SE_CORTO, seguidor.corte())
    }

    /** La app adopta un regreso propio (returnHome): sigue siendo el del dron para la regla del corte. */
    @Test
    fun adoptarUnRegresoPropioNoLeDaOtroCorte() {
        seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA)
        seguidor.alOrdenar(Orden.REGRESO)
        seguidor.alCortar()
        seguidor.alCambiarFase(Fase.INACTIVO, Orden.NINGUNA, MotivoDelDron.OTRO)

        seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA)
        assertEquals(Corte.YA_SE_CORTO, seguidor.corte())
    }

    /** Un aterrizaje forzado no es un regreso: no gasta ni bloquea el corte de uno. */
    @Test
    fun elAterrizajeForzadoNoCuentaComoRegresoPropio() {
        seguidor.alTomarElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA)
        assertEquals(Corte.SE_PUEDE, seguidor.corte())
        seguidor.alCortar()
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_BATERIA)
        assertEquals("el corte del regreso propio sigue entero", Corte.SE_PUEDE, seguidor.corte())
    }

    /**
     * Una toma de señal o "de otro" no dice que el dron esté volviendo: si
     * gastaba el único corte, la app cortando después SU regreso dejaba al DJI
     * sin el intento que RELEVOS §4 guarda para su regreso por batería.
     */
    @Test
    fun unaTomaSinRegresoNoGastaElCorteDelRegresoPropio() {
        seguidor.alTomarElControl(MotivoDelDron.OTRO)
        seguidor.alTomarElControl(MotivoDelDron.RTH_SENIAL)
        // La app vuelve por su cuenta y después corta su regreso para desviarse.
        seguidor.alOrdenar(Orden.REGRESO)
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.REGRESO, MotivoDelDron.OTRO)
        assertEquals(Corte.SE_PUEDE, seguidor.corte())
        seguidor.alCortar()
        seguidor.alCambiarFase(Fase.INACTIVO, Orden.NINGUNA, MotivoDelDron.OTRO)

        // Recién ahora el DJI arranca el suyo por batería: su único corte está entero.
        seguidor.alArrancarRegresoPropio(MotivoDelDron.RTH_BATERIA)
        assertEquals(Corte.SE_PUEDE, seguidor.corte())
    }

    /** Si el failsafe de señal sí resulta un regreso, el estado del regreso lo dice y cuenta como propio. */
    @Test
    fun laSenialQueTerminaEnRegresoCuentaComoRegresoPropio() {
        seguidor.alTomarElControl(MotivoDelDron.RTH_SENIAL)
        assertNull(seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.NINGUNA, MotivoDelDron.RTH_SENIAL))
        seguidor.alCortar()
        seguidor.alCambiarFase(Fase.INACTIVO, Orden.NINGUNA, MotivoDelDron.OTRO)

        seguidor.alArrancarRegresoPropio(MotivoDelDron.RTH_BATERIA)
        assertEquals(Corte.YA_SE_CORTO, seguidor.corte())
    }

    /** El botón de regreso del control es una persona: la app no lo corta nunca, ni adoptándolo. */
    @Test
    fun elRegresoDelBotonDelControlNoSeCorta() {
        seguidor.alTomarElControl(MotivoDelDron.RTH_DEL_CONTROL)
        assertEquals(Corte.LO_PIDIO_EL_CONTROL, seguidor.corte())

        seguidor.alOrdenar(Orden.REGRESO)
        seguidor.alCambiarFase(Fase.VOLVIENDO, Orden.REGRESO, MotivoDelDron.OTRO)
        assertEquals(Corte.LO_PIDIO_EL_CONTROL, seguidor.corte())

        // Uno por batería que el DJI anuncia encima no lo vuelve cortable.
        seguidor.alTomarElControl(MotivoDelDron.RTH_BATERIA)
        assertEquals(Corte.LO_PIDIO_EL_CONTROL, seguidor.corte())
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
        assertEquals(Corte.SE_PUEDE, seguidor.corte())
        assertEquals(
            toma(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA),
            seguidor.alTomarElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA),
        )
    }
}
