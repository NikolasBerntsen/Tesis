package com.tesis.dronepatrol.drone

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Las órdenes de los relevos, del desvío y del protocolo de última ubicación
 * (docs/RELEVOS.md) traen un cuerpo por defecto en [DroneController]: el lado
 * seguro, para que los dobles de prueba compilen. Por eso el compilador no
 * avisa si un controlador se olvida de una: PatrolManager la llama, las pruebas
 * con el dron espía pasan, y en el dron no pasa nada (o pasa lo de siempre, que
 * en un desvío es volar bajo por un camino que nunca voló).
 *
 * Esta prueba lee las fuentes de los dos controladores —el real compila solo
 * con el MSDK y no entra en estas pruebas— y exige que cada uno pise cada orden
 * que PatrolManager usa para eso. Las rutas son relativas al módulo
 * `android-app/app`, como las del contrato de relevos.
 */
class ControladoresConLasOrdenesDeRelevosTest {

    private val ordenes = listOf(
        "prepararDespegue",
        "soltarDespegue",
        "despegarHasta",
        "cambiarAltura",
        "volarHacia",
        "girarEnElLugar",
        "apuntarCamara",
        "cancelarRegreso",
        "fijarPuntoDeRetornoAqui",
        "fijarPuntoDeRetornoEn",
        "permitirRthPropioPorBateria",
        "fijarFailsafeAterrizar",
        "capturarFoto",
        // El corte del aterrizaje que se sostiene hasta el suelo: sin él, la
        // orden de una persona que sigue (ir a un nodo, detenerse) se rechaza.
        "cancelarAterrizaje",
        // El control manual que se quedó sin nadie al mando: sin él, el real
        // sostiene el Virtual Stick y el control físico no puede tomar el dron.
        "devolverElMandoAlControl",
    )

    private fun fuente(ruta: String): String {
        val archivo = File(ruta)
        assertTrue("no está ${archivo.absolutePath}", archivo.isFile)
        return archivo.readText()
    }

    private fun sinPisar(fuente: String): List<String> =
        ordenes.filterNot { Regex("""override\s+(suspend\s+)?fun\s+$it\s*\(""").containsMatchIn(fuente) }

    @Test
    fun cadaOrdenEstaEnLaInterfaz() {
        val interfaz = fuente("src/main/java/com/tesis/dronepatrol/drone/DroneController.kt")
        val faltan = ordenes.filterNot { Regex("""fun\s+$it\s*\(""").containsMatchIn(interfaz) }
        assertEquals("una orden que se renombró en la interfaz y no acá", emptyList<String>(), faltan)
    }

    @Test
    fun elSimuladorLasImplementaTodas() {
        val faltan = sinPisar(fuente("src/main/java/com/tesis/dronepatrol/drone/SimulatedDroneController.kt"))
        assertEquals(emptyList<String>(), faltan)
    }

    @Test
    fun elDronRealLasImplementaTodas() {
        val faltan = sinPisar(fuente("src/dji/java/com/tesis/dronepatrol/dji/DjiDroneController.kt"))
        assertEquals(emptyList<String>(), faltan)
    }

    /** La regla misma: un controlador sin una de ellas no pasa. */
    @Test
    fun unControladorSinUnaOrdenNoPasa() {
        val incompleto = ordenes.drop(1).joinToString("\n") { "    override fun $it() = Unit" }
        assertEquals(listOf("prepararDespegue"), sinPisar(incompleto))
        assertEquals(emptyList<String>(), sinPisar("    override suspend fun prepararDespegue(): Boolean = true\n$incompleto"))
    }
}
