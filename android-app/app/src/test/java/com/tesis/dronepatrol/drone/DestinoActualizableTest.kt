package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El destino de volarHacia en el dron real: se corrige sin cortar el vuelo y la
 * llegada se avisa una vez por destino.
 */
class DestinoActualizableTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        val AL_NORTE = LAT + 200.0 / Geo.METROS_POR_GRADO_LAT
        val AL_ESTE = LON + 200.0 / Geo.metrosPorGradoLon(LAT)
    }

    @Test
    fun lejosDelDestinoVuelaHaciaEl() {
        val destino = DestinoActualizable(AL_NORTE, LON)

        val paso = destino.siguiente(LAT, LON)

        assertTrue(paso is DestinoActualizable.Paso.Volar)
        val volar = paso as DestinoActualizable.Paso.Volar
        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS, volar.paso.vNorteMs, 1e-9)
        assertEquals(0.0, volar.paso.vEsteMs, 1e-9)
    }

    @Test
    fun alLlegarAvisaUnaVezYDespuesQuedaQuieto() {
        val destino = DestinoActualizable(AL_NORTE, LON)

        assertSame(DestinoActualizable.Paso.Llego, destino.siguiente(AL_NORTE, LON))
        assertSame(DestinoActualizable.Paso.Quieto, destino.siguiente(AL_NORTE, LON))
        assertSame(DestinoActualizable.Paso.Quieto, destino.siguiente(AL_NORTE, LON))
    }

    /** El objetivo se corrige en camino: la próxima vuelta ya vuela hacia el punto nuevo. */
    @Test
    fun cambiarElDestinoEnCaminoCambiaHaciaDondeVuela() {
        val destino = DestinoActualizable(AL_NORTE, LON)
        destino.siguiente(LAT, LON)

        destino.cambiar(LAT, AL_ESTE)

        val volar = destino.siguiente(LAT, LON) as DestinoActualizable.Paso.Volar
        assertEquals(0.0, volar.paso.vNorteMs, 1e-9)
        assertEquals(Navegacion.VELOCIDAD_CRUCERO_MS, volar.paso.vEsteMs, 1e-9)
    }

    /** Si el destino se corre después de llegar, vuelve a volar y avisa la llegada nueva. */
    @Test
    fun unDestinoNuevoDespuesDeLlegarSeAvisaOtraVez() {
        val destino = DestinoActualizable(AL_NORTE, LON)
        destino.siguiente(AL_NORTE, LON)

        destino.cambiar(LAT, AL_ESTE)

        assertTrue(destino.siguiente(AL_NORTE, LON) is DestinoActualizable.Paso.Volar)
        assertSame(DestinoActualizable.Paso.Llego, destino.siguiente(LAT, AL_ESTE))
    }

    /** Reenviar el mismo punto (quien llama no sabe si cambió) no es otra llegada. */
    @Test
    fun reenviarElMismoPuntoNoRepiteElAviso() {
        val destino = DestinoActualizable(AL_NORTE, LON)
        destino.siguiente(AL_NORTE, LON)

        destino.cambiar(AL_NORTE, LON)

        assertSame(DestinoActualizable.Paso.Quieto, destino.siguiente(AL_NORTE, LON))
    }

    /** El viento lo saca del punto: vuelve, sin anunciar otra llegada. */
    @Test
    fun siLoCorrenDelPuntoVuelveSinAvisarDeNuevo() {
        val destino = DestinoActualizable(AL_NORTE, LON)
        destino.siguiente(AL_NORTE, LON)

        assertTrue(destino.siguiente(LAT, LON) is DestinoActualizable.Paso.Volar)
        assertSame(DestinoActualizable.Paso.Quieto, destino.siguiente(AL_NORTE, LON))
    }
}
