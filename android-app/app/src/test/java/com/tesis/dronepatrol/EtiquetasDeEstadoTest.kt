package com.tesis.dronepatrol

import com.tesis.dronepatrol.model.PatrolState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Cada estado del patrullaje tiene su texto en la pantalla de operación. Un
 * estado sin etiqueta no rompe nada a la vista: la pantalla se queda mostrando
 * la del estado anterior, y el operador lee "Patrullando" con el dron relevando
 * a otro o aterrizando de emergencia. Por eso se mira contra la lista entera de
 * estados, no contra los que había cuando se escribió la pantalla.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EtiquetasDeEstadoTest {

    private val contexto = RuntimeEnvironment.getApplication()

    @Test
    fun todosLosEstadosTienenUnaEtiquetaPropia() {
        val etiquetas = PatrolState.entries.associateWith { estado ->
            val recurso = requireNotNull(MainActivity.ETIQUETAS_ESTADO[estado]) { "el estado $estado no tiene etiqueta" }
            contexto.getString(recurso)
        }

        assertTrue("hay etiquetas vacías: $etiquetas", etiquetas.values.none { it.isBlank() })
        assertEquals("dos estados con el mismo texto: $etiquetas", etiquetas.size, etiquetas.values.toSet().size)
    }

    @Test
    fun losEstadosDeLosRelevosDicenQueEstaPasando() {
        assertEquals("Relevando a otro dron", contexto.getString(MainActivity.ETIQUETAS_ESTADO.getValue(PatrolState.RELEVANDO)))
        assertEquals(
            "Aterrizaje de emergencia",
            contexto.getString(MainActivity.ETIQUETAS_ESTADO.getValue(PatrolState.ATERRIZAJE_EMERGENCIA)),
        )
    }
}
