package com.tesis.dronepatrol.drone

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * La traducción a los cuatro campos del Virtual Stick avanzado del MSDK v5.
 * Cada caso es una fila de la tabla oficial "Roll Pitch Control Mode" (Flight
 * Controller → Virtual Stick) para RollPitchControlMode.VELOCITY: en ese modo
 * `roll` es el eje X (norte / adelante) y `pitch` el eje Y (este / derecha), al
 * revés de lo que sugieren los nombres. Mandarlo al revés gira cada orden 90°,
 * y con el dron real no hay otra prueba que esta antes de volar.
 */
class OrdenVirtualStickTest {

    @Test
    fun `en GROUND ir al norte es roll positivo y pitch cero`() {
        val p = OrdenVirtualStick.terreno(vNorteMs = 3.0, vEsteMs = 0.0, rumboGrados = 0.0, vSubidaMs = 0.0)

        assertEquals(3.0, p.roll, 0.0)
        assertEquals(0.0, p.pitch, 0.0)
    }

    @Test
    fun `en GROUND ir al este es pitch positivo y roll cero`() {
        val p = OrdenVirtualStick.terreno(vNorteMs = 0.0, vEsteMs = 2.0, rumboGrados = 90.0, vSubidaMs = 0.0)

        assertEquals(2.0, p.pitch, 0.0)
        assertEquals(0.0, p.roll, 0.0)
    }

    @Test
    fun `en GROUND ir al sur y al oeste son los negativos`() {
        val p = OrdenVirtualStick.terreno(vNorteMs = -1.5, vEsteMs = -2.5, rumboGrados = 225.0, vSubidaMs = 0.0)

        assertEquals(-1.5, p.roll, 0.0)
        assertEquals(-2.5, p.pitch, 0.0)
    }

    @Test
    fun `en BODY adelante es roll y derecha es pitch`() {
        val p = OrdenVirtualStick.cuerpo(
            MandoVirtual.VelocidadesCuerpo(adelanteMs = 4.0, derechaMs = 1.0, giroGradosS = 0.0, subidaMs = 0.0),
        )

        assertEquals(4.0, p.roll, 0.0)
        assertEquals(1.0, p.pitch, 0.0)
    }

    @Test
    fun `el mando virtual entero llega con sus signos`() {
        val p = OrdenVirtualStick.cuerpo(MandoVirtual.velocidades(pitch = -1.0, roll = 0.5, yaw = -0.5, throttle = 1.0))

        assertEquals(-MandoVirtual.MAX_HORIZONTAL_MS, p.roll, 1e-9) // atrás
        assertEquals(MandoVirtual.MAX_HORIZONTAL_MS / 2, p.pitch, 1e-9) // a la derecha
        assertEquals(-MandoVirtual.MAX_YAW_GRADOS_S / 2, p.yaw, 1e-9) // antihorario
        assertEquals(MandoVirtual.MAX_VERTICAL_MS, p.verticalThrottle, 1e-9) // sube
    }

    /** El eje vertical es relativo a la aeronave en los dos marcos: positivo sube. */
    @Test
    fun `subir es vertical positivo en los dos marcos`() {
        assertEquals(1.5, OrdenVirtualStick.terreno(0.0, 0.0, 0.0, 1.5).verticalThrottle, 0.0)
        assertEquals(-2.0, OrdenVirtualStick.cuerpo(MandoVirtual.VelocidadesCuerpo(0.0, 0.0, 0.0, -2.0)).verticalThrottle, 0.0)
    }

    /** El SDK toma el rumbo en −180..180; el resto del sistema lo maneja en 0..360. */
    @Test
    fun `el rumbo se pliega al rango del SDK`() {
        assertEquals(0.0, OrdenVirtualStick.rumboAngulo(0.0), 0.0)
        assertEquals(90.0, OrdenVirtualStick.rumboAngulo(90.0), 0.0)
        assertEquals(180.0, OrdenVirtualStick.rumboAngulo(180.0), 0.0)
        assertEquals(-90.0, OrdenVirtualStick.rumboAngulo(270.0), 0.0)
        assertEquals(-1.0, OrdenVirtualStick.rumboAngulo(359.0), 1e-9)
        assertEquals(-90.0, OrdenVirtualStick.rumboAngulo(-90.0), 0.0)
        assertEquals(10.0, OrdenVirtualStick.rumboAngulo(370.0), 1e-9)
    }
}
