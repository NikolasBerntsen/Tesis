package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.model.Telemetry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * La secuencia del protocolo de última ubicación (docs/RELEVOS.md §5), sola:
 * qué orden sale en cada paso, que cada foto espere la confirmación de la
 * telemetría y el asentamiento, el tope duro de 20 s, la regla de batería y la
 * variante que solo usa la cámara. El tiempo es de mentira: cada espera adelanta
 * el reloj, y los 20 s corren en milisegundos.
 */
class SecuenciaDeUltimaUbicacionTest {

    private val dron = DronEspia(conRelevos = true)
    private var ahora = 1_000_000L
    private var sigue = true
    private var alcanza = true
    private val fotos = mutableListOf<SecuenciaDeUltimaUbicacion.Foto>()

    private fun secuencia() = SecuenciaDeUltimaUbicacion(
        dron = dron,
        telemetria = { dron.ultimaTelemetria },
        sigue = { sigue },
        alcanzaParaOtroPaso = { alcanza },
        alFotografiar = { fotos += it },
        reloj = { ahora },
        pausa = { ahora += it },
    )

    private fun enElAire(gimbal: Double = Telemetry.GIMBAL_PATRULLA) = runBlocking {
        dron.emitirTelemetria(-34.87, -56.19, alt = 38.0, rumbo = 45.0, gimbal = gimbal)
    }

    @Test
    fun conElVueloFotografiaTodoYAterriza() = runBlocking {
        dron.confirmarCamaraYRumbo = true
        enElAire()
        val inicio = ahora
        val fin = secuencia().conControl(puedeGirar = { true })

        assertEquals(SecuenciaDeUltimaUbicacion.Final.ATERRIZO, fin)
        assertEquals(
            listOf(
                "hold", "failsafeAterrizar(true)",
                "apuntar(-70.0)", "capturarFoto",
                "apuntar(-90.0)", "capturarFoto",
                "apuntar(-30.0)", "girar(0.0)", "capturarFoto",
                "apuntar(-30.0)", "girar(90.0)", "capturarFoto",
                "apuntar(-30.0)", "girar(180.0)", "capturarFoto",
                "apuntar(-30.0)", "girar(270.0)", "capturarFoto",
                "land",
            ),
            dron.ordenes,
        )
        assertEquals((0..5).toList(), fotos.map { it.seq })
        assertEquals(listOf("oblicua", "cenital", "panoramica", "panoramica", "panoramica", "panoramica"), fotos.map { it.tipo })
        assertEquals(listOf(45.0, 45.0, 0.0, 90.0, 180.0, 270.0), fotos.map { it.rumbo })
        assertEquals(-90.0, fotos[1].inclinacion, 1e-9)
        assertTrue("cada foto con su pose", fotos.all { it.telemetria != null && it.jpeg.isNotEmpty() })
        assertEquals("cada paso cuenta 1,5 s recién confirmado", 6 * SecuenciaDeUltimaUbicacion.ASENTAR_MS, ahora - inicio)
    }

    @Test
    fun sinGirarNoHayPanoramica() = runBlocking {
        dron.confirmarCamaraYRumbo = true
        enElAire()
        secuencia().conControl(puedeGirar = { false })
        assertEquals(listOf("oblicua", "cenital"), fotos.map { it.tipo })
        assertEquals("land", dron.ultimaOrden)
    }

    @Test
    fun unPasoQueNoSeConfirmaSaleSinFotoYElTopeDuroAterriza() = runBlocking {
        // El dron gira, pero la cámara no confirma nada: ni la oblicua (el gimbal está en -50).
        dron.confirmarRumbo = true
        enElAire(gimbal = -50.0)
        val inicio = ahora
        val fin = secuencia().conControl(puedeGirar = { true })
        assertEquals(SecuenciaDeUltimaUbicacion.Final.ATERRIZO, fin)
        assertTrue(fotos.isEmpty())
        assertTrue("ninguna foto sin confirmar", "capturarFoto" !in dron.ordenes)
        assertEquals("el tope duro", SecuenciaDeUltimaUbicacion.TOPE_MS, ahora - inicio)
        assertTrue("una cámara que no confirma no corta la panorámica", "girar(180.0)" in dron.ordenes)
        assertEquals("land", dron.ultimaOrden)
    }

    /**
     * Un giro que la telemetría no confirma es un mando virtual que no está (el
     * DJI todavía en su regreso, por ejemplo): los rumbos que faltan tampoco
     * van a salir, y cada uno gastaría 4 s con la batería en el crítico.
     */
    @Test
    fun unGiroQueNoSeConfirmaCortaLaPanoramicaYAterriza() = runBlocking {
        dron.confirmarCamara = true
        enElAire()
        val inicio = ahora
        val fin = secuencia().conControl(puedeGirar = { true })
        assertEquals(SecuenciaDeUltimaUbicacion.Final.ATERRIZO, fin)
        assertEquals(
            listOf(
                "hold", "failsafeAterrizar(true)",
                "apuntar(-70.0)", "capturarFoto",
                "apuntar(-90.0)", "capturarFoto",
                "apuntar(-30.0)", "girar(0.0)",
                "land",
            ),
            dron.ordenes,
        )
        assertEquals(listOf("oblicua", "cenital"), fotos.map { it.tipo })
        assertEquals(
            "dos fotos asentadas y un solo giro esperado",
            2 * SecuenciaDeUltimaUbicacion.ASENTAR_MS + SecuenciaDeUltimaUbicacion.CONFIRMACION_MAXIMA_MS,
            ahora - inicio,
        )
    }

    /** Si la app pierde el vuelo en el medio, la panorámica se deja ahí: se pregunta antes de cada giro. */
    @Test
    fun siDejaDePoderGirarEnElMedioNoGiraMas() = runBlocking {
        dron.confirmarCamaraYRumbo = true
        enElAire()
        var giros = 0
        secuencia().conControl(puedeGirar = { giros++ < 2 })
        assertEquals(listOf("girar(0.0)", "girar(90.0)"), dron.ordenes.filter { it.startsWith("girar") })
        assertEquals(listOf("oblicua", "cenital", "panoramica", "panoramica"), fotos.map { it.tipo })
        assertEquals("land", dron.ultimaOrden)
    }

    @Test
    fun sinBateriaParaOtroPasoAterrizaEnseguida() = runBlocking {
        enElAire()
        alcanza = false
        secuencia().conControl(puedeGirar = { true })
        assertEquals(listOf("hold", "failsafeAterrizar(true)", "land"), dron.ordenes)
    }

    @Test
    fun sinTelemetriaOSinCamaraNoHayFoto() = runBlocking {
        dron.foto = null
        dron.confirmarCamaraYRumbo = true
        enElAire()
        secuencia().conControl(puedeGirar = { false })
        assertTrue(fotos.isEmpty())
        assertEquals(2, dron.ordenes.count { it == "capturarFoto" })

        val sinTelemetria = SecuenciaDeUltimaUbicacion(
            dron = DronEspia(conRelevos = true),
            telemetria = { null },
            sigue = { true },
            alcanzaParaOtroPaso = { true },
            alFotografiar = { fotos += it },
            reloj = { ahora },
            pausa = { ahora += it },
        )
        // Sin telemetría tampoco se puede confirmar un giro: la panorámica se deja ahí.
        assertEquals(SecuenciaDeUltimaUbicacion.Final.ATERRIZO, sinTelemetria.conControl(puedeGirar = { true }))
        assertTrue(fotos.isEmpty())
    }

    @Test
    fun siElProtocoloSeCortaNoSaleNiUnaOrdenMas() = runBlocking {
        sigue = false
        assertEquals(SecuenciaDeUltimaUbicacion.Final.CORTADA, secuencia().conControl(puedeGirar = { true }))
        assertTrue(dron.ordenes.isEmpty())

        // Cortado en el medio: después de la primera foto.
        sigue = true
        dron.confirmarCamaraYRumbo = true
        enElAire()
        val s = SecuenciaDeUltimaUbicacion(
            dron = dron,
            telemetria = { dron.ultimaTelemetria },
            sigue = { sigue },
            alcanzaParaOtroPaso = { true },
            alFotografiar = {
                fotos += it
                sigue = false
            },
            reloj = { ahora },
            pausa = { ahora += it },
        )
        assertEquals(SecuenciaDeUltimaUbicacion.Final.CORTADA, s.conControl(puedeGirar = { true }))
        assertEquals(listOf("hold", "failsafeAterrizar(true)", "apuntar(-70.0)", "capturarFoto"), dron.ordenes)
    }

    @Test
    fun cortadaMientrasEsperaLaConfirmacionNiSacaLaFoto() = runBlocking {
        enElAire(gimbal = -50.0)
        var vueltas = 0
        val s = SecuenciaDeUltimaUbicacion(
            dron = dron,
            telemetria = { dron.ultimaTelemetria },
            sigue = { sigue },
            alcanzaParaOtroPaso = { true },
            alFotografiar = { fotos += it },
            reloj = { ahora },
            pausa = {
                ahora += it
                if (++vueltas == 3) sigue = false
            },
        )
        assertEquals(SecuenciaDeUltimaUbicacion.Final.CORTADA, s.conControl(puedeGirar = { true }))
        assertTrue("capturarFoto" !in dron.ordenes)
    }

    @Test
    fun sinElVueloSoloLaCamaraYSinUnaOrdenDeVuelo() = runBlocking {
        dron.confirmarCamaraYRumbo = true
        enElAire()
        assertEquals(SecuenciaDeUltimaUbicacion.Final.ATERRIZO, secuencia().soloCamara())
        assertEquals(listOf("apuntar(-90.0)", "capturarFoto", "apuntar(-30.0)", "capturarFoto"), dron.ordenes)
        assertEquals(listOf("cenital", "panoramica"), fotos.map { it.tipo })
        assertEquals(listOf(0, 1), fotos.map { it.seq })
    }

    @Test
    fun soloLaCamaraTambienRespetaElTopeYElCorte() = runBlocking {
        enElAire(gimbal = -50.0)
        sigue = true
        val inicio = ahora
        assertEquals(SecuenciaDeUltimaUbicacion.Final.ATERRIZO, secuencia().soloCamara())
        assertEquals("dos pasos sin confirmar", 2 * SecuenciaDeUltimaUbicacion.CONFIRMACION_MAXIMA_MS, ahora - inicio)
        sigue = false
        assertEquals(SecuenciaDeUltimaUbicacion.Final.CORTADA, secuencia().soloCamara())
    }

    @Test
    fun laOrdenPasaPorLaPuertaDeQuienLlama() = runBlocking {
        enElAire()
        val pedidas = mutableListOf<Int>()
        val s = SecuenciaDeUltimaUbicacion(
            dron = dron,
            telemetria = { dron.ultimaTelemetria },
            sigue = { true },
            alcanzaParaOtroPaso = { false },
            alFotografiar = { fotos += it },
            reloj = { ahora },
            pausa = { ahora += it },
            ordenar = { orden ->
                pedidas += pedidas.size
                // La puerta dice que no: el protocolo ya no está en curso.
                pedidas.size == 1 && run {
                    dron.orden()
                    true
                }
            },
        )
        assertEquals("el aterrizaje no pasó la puerta", SecuenciaDeUltimaUbicacion.Final.CORTADA, s.conControl(puedeGirar = { true }))
        assertEquals(listOf("hold", "failsafeAterrizar(true)"), dron.ordenes)
        assertEquals(2, pedidas.size)
    }
}
