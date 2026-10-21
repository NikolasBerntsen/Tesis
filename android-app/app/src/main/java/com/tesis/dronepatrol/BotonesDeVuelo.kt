package com.tesis.dronepatrol

import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.PatrolState

/**
 * Qué botones de vuelo de la pantalla de operación tienen sentido en cada
 * momento. Son funciones puras —el estado del patrullaje y el del dron entran,
 * la decisión sale— para poder probarlas sin levantar la pantalla, que al
 * crearse se conecta al Comando Central y al dron.
 */
internal object BotonesDeVuelo {

    /** Con un regreso a base en curso no se despega ni se arranca nada: el regreso manda. */
    private val REGRESOS = setOf(
        PatrolState.RETURNING_HOME,
        PatrolState.RETURNING_HOME_BATTERY,
        PatrolState.RETURNING_HOME_SIGNAL,
    )

    /**
     * "Despegar y patrullar" / "Comenzar patrullaje": con una ruta cargada, sin
     * otra cosa en curso, y con el dron en el aire o listo para despegar solo
     * (GPS y punto de retorno: la ruta se vuela con coordenadas).
     */
    fun comenzarHabilitado(hayRutas: Boolean, estado: PatrolState, dron: EstadoDelDron): Boolean =
        hayRutas && estado == PatrolState.IDLE && (dron.enVuelo || dron.listoParaDespegar)

    /** "Despegar aquí": en el suelo, con enlace con la aeronave, y sin un regreso a base en curso. No exige GPS. */
    fun despegarAquiHabilitado(estado: PatrolState, dron: EstadoDelDron): Boolean =
        !dron.enVuelo && dron.conectado && estado !in REGRESOS

    /**
     * Por qué no se puede comenzar a patrullar, para decirlo debajo del botón
     * apagado; null si se puede o si no hay nada que explicar (sin rutas, o con
     * otra cosa en curso). Lo típico es la falta de GPS o de punto de retorno,
     * y el motivo exacto es el `detalle` que arma el controlador.
     */
    fun porQueNoPatrulla(hayRutas: Boolean, estado: PatrolState, dron: EstadoDelDron): String? =
        if (hayRutas && estado == PatrolState.IDLE && !dron.enVuelo && !dron.listoParaDespegar) dron.detalle else null
}
