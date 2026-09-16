package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Las cuentas de geografía que comparten el simulador y el DJI. Es aritmética
 * pura, así que corre en la JVM pelada — que es la razón de que estas dos
 * cuentas vivan en el sourceSet `main` y no adentro del controlador del dron,
 * donde no había forma de mirarlas.
 */
class GeoTest {

    private companion object {
        // El Obelisco: la latitud a la que vuela esto de verdad.
        const val LAT = -34.6037
        const val LON = -58.3816
    }

    /** A la latitud del Obelisco un grado de longitud mide bastante menos que uno de latitud. */
    @Test
    fun losMeridianosSeJuntanHaciaElPolo() {
        val porGradoLon = Geo.metrosPorGradoLon(LAT)

        assertEquals(Geo.METROS_POR_GRADO_LAT * 0.8231, porGradoLon, 100.0)
        assertTrue("un grado de longitud no puede medir más que uno de latitud acá", porGradoLon < Geo.METROS_POR_GRADO_LAT)
        // En el ecuador sí miden lo mismo
        assertEquals(Geo.METROS_POR_GRADO_LAT, Geo.metrosPorGradoLon(0.0), 1e-9)
    }

    @Test
    fun elNorteEsCeroYElEsteEsNoventa() {
        assertEquals(0.0, Geo.rumboHacia(LAT, LON, LAT + 0.01, LON), 1e-9)
        assertEquals(90.0, Geo.rumboHacia(LAT, LON, LAT, LON + 0.01), 1e-9)
        assertEquals(180.0, Math.abs(Geo.rumboHacia(LAT, LON, LAT - 0.01, LON)), 1e-9)
        assertEquals(-90.0, Geo.rumboHacia(LAT, LON, LAT, LON - 0.01), 1e-9)
    }

    /**
     * El caso que motivó todo esto: un objetivo a 100 m al norte y 100 m al este
     * —metros, no grados— está al noreste exacto y el rumbo tiene que dar 45°.
     * Sin escalar la longitud por cos(lat) da 50,6° a la latitud del Obelisco:
     * más de 5° de error, que orbitando a 30 m de radio le corre el objetivo del
     * centro del cuadro.
     */
    @Test
    fun elRumboEscalaLaLongitudPorLaLatitud() {
        val destinoLat = LAT + 100.0 / Geo.METROS_POR_GRADO_LAT
        val destinoLon = LON + 100.0 / Geo.metrosPorGradoLon(LAT)

        assertEquals(45.0, Geo.rumboHacia(LAT, LON, destinoLat, destinoLon), 0.01)
    }

    /** Lo mismo para el otro cuadrante, que es donde el error de signo se esconde. */
    @Test
    fun elRumboAlSudoesteTambienDaLaDiagonal() {
        val destinoLat = LAT - 250.0 / Geo.METROS_POR_GRADO_LAT
        val destinoLon = LON - 250.0 / Geo.metrosPorGradoLon(LAT)

        assertEquals(-135.0, Geo.rumboHacia(LAT, LON, destinoLat, destinoLon), 0.01)
    }
}
