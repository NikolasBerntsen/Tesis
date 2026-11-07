package com.tesis.dronepatrol.drone

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La velocidad de la órbita del simulador es la que se le pide
 * (DroneController.startOrbit): con el ajuste de la consola a 2 m/s recorre la
 * mitad del arco que a la de fábrica (4 m/s), y cambiarla en el medio no corta
 * el giro. Robolectric sólo por el video del simulador; los tiempos son reales
 * (tick de 500 ms).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SimulatedDroneControllerOrbitaTest {

    private companion object {
        const val LAT = -34.6037
        const val LON = -58.3816
        const val RADIO_M = 30.0
    }

    /** Orbita [segundos] a [velocidadMs] desde el borde del círculo y devuelve cuánto se corrió (la cuerda). */
    private suspend fun recorrido(velocidadMs: Double?, segundos: Long): Double {
        val dron = SimulatedDroneController(arrancaEnElAire = true)
        try {
            dron.connect()
            val inicio = withTimeout(5_000) { dron.telemetry.first() }
            // El centro 30 m al norte: el dron ya está sobre el círculo y arranca a girar.
            val centroLat = LAT + RADIO_M / Geo.METROS_POR_GRADO_LAT
            if (velocidadMs == null) dron.startOrbit(centroLat, LON, RADIO_M) else dron.startOrbit(centroLat, LON, RADIO_M, velocidadMs)
            delay(segundos * 1_000)
            val fin = dron.telemetry.first()
            return Geo.distanciaM(inicio.lat, inicio.lon, fin.lat, fin.lon)
        } finally {
            dron.disconnect()
        }
    }

    @Test
    fun aDosMetrosPorSegundoRecorreLaMitadQueALaDeFabrica() = runBlocking {
        assertEquals(4.0, Navegacion.VELOCIDAD_ORBITA_MS, 0.0)
        val lenta = recorrido(2.0, 6)
        val deFabrica = recorrido(null, 6)

        // Unos 12 m contra unos 24 (la cuerda de 24 m de arco en un círculo de 30 es 23,4).
        assertTrue("a 2 m/s se corrió $lenta m", lenta in 8.0..16.0)
        assertTrue("a 4 m/s se corrió $deFabrica m", deFabrica in 18.0..30.0)
    }

    @Test
    fun unaVelocidadFueraDeRangoSeRecortaYNoFrenaLaOrbita() = runBlocking {
        // 0,2 m/s se recorta al piso de 1 m/s: en 6 s unos 6 m, no 1.
        val recortada = recorrido(0.2, 6)
        assertTrue("al piso de 1 m/s se corrió $recortada m", recortada in 4.0..9.0)
    }
}
