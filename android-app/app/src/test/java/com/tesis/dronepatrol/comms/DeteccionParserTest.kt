package com.tesis.dronepatrol.comms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * La lectura del mensaje `detection` del software de detección: qué vio, las
 * cajas y la captura. Robolectric por org.json.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeteccionParserTest {

    @Test
    fun `una deteccion completa trae clases, cajas y captura`() {
        val d = DetectionClient.interpretarDeteccion(
            """{"type":"detection","detected":true,"classes":["PERSON","VEHICLE"],"confidence":0.91,
                "boxes":[{"cls":"PERSON","conf":0.91,"x":0.5,"y":0.4,"w":0.02,"h":0.05},
                         {"cls":"VEHICLE","conf":0.7,"x":0.8,"y":0.6,"w":0.1,"h":0.08}],
                "snapshotBase64":"/9j/abc","ts":1700000000000}""",
        )!!

        assertEquals(listOf("PERSON", "VEHICLE"), d.clases)
        assertEquals(0.91, d.confianza, 1e-9)
        assertEquals(2, d.cajas.size)
        assertEquals("PERSON", d.principal?.clase)
        assertEquals("VEHICLE", d.tipoDeAlerta)
        assertEquals("/9j/abc", d.snapshotBase64)
        assertEquals(1700000000000L, d.ts)
    }

    /** El mock no manda cajas ni captura: la app tiene que orbitar igual. */
    @Test
    fun `el mensaje del mock sin cajas tambien es una deteccion`() {
        val d = DetectionClient.interpretarDeteccion(
            """{"type":"detection","detected":true,"classes":["PERSON"],"confidence":0.9,"ts":1}""",
        )!!

        assertEquals(listOf("PERSON"), d.clases)
        assertEquals(0, d.cajas.size)
        assertNull(d.principal)
        assertNull(d.snapshotBase64)
        assertEquals("PERSON", d.tipoDeAlerta)
    }

    @Test
    fun `sin deteccion, otro tipo o basura no es nada`() {
        assertNull(DetectionClient.interpretarDeteccion("""{"type":"detection","detected":false,"classes":[]}"""))
        assertNull(DetectionClient.interpretarDeteccion("""{"type":"video_frame","detected":true}"""))
        assertNull(DetectionClient.interpretarDeteccion("""{"type":"detection","detected":true}"""))
        assertNull(DetectionClient.interpretarDeteccion("no json"))
    }

    @Test
    fun `una caja incompleta se descarta y los valores se recortan`() {
        val d = DetectionClient.interpretarDeteccion(
            """{"type":"detection","detected":true,"classes":["PERSON"],
                "boxes":[{"cls":"PERSON","conf":1.4,"x":1.2,"y":-0.1,"w":0.5,"h":0.5},{"cls":"PERSON","conf":0.5,"x":0.5}]}""",
        )!!

        assertEquals(1, d.cajas.size)
        assertEquals(1.0, d.cajas[0].confianza, 0.0)
        assertEquals(1.0, d.cajas[0].x, 0.0)
        assertEquals(0.0, d.cajas[0].y, 0.0)
    }
}
