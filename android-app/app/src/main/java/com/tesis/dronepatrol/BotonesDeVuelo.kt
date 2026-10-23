package com.tesis.dronepatrol

import android.content.Context
import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.PatrolState

/**
 * Qué botones de vuelo de la pantalla de operación tienen sentido en cada
 * momento. Son funciones puras —el estado del patrullaje y el del dron entran,
 * la decisión sale— para poder probarlas sin levantar la pantalla, que al
 * crearse se conecta al Comando Central y al dron.
 */
internal object BotonesDeVuelo {

    /**
     * Con un regreso a base en curso no se despega ni se arranca nada: el
     * regreso manda. El aterrizaje de emergencia también es un regreso (el que
     * baja donde está porque no alcanza ninguna base), y un relevo despega por
     * su cuenta: "Despegar aquí" en el medio le pisaría el despegue.
     */
    private val SIN_DESPEGUE_A_MANO = setOf(
        PatrolState.RETURNING_HOME,
        PatrolState.RETURNING_HOME_BATTERY,
        PatrolState.RETURNING_HOME_SIGNAL,
        PatrolState.ATERRIZAJE_EMERGENCIA,
        PatrolState.RELEVANDO,
    )

    /**
     * "Despegar y patrullar" / "Comenzar patrullaje": con una ruta cargada, sin
     * otra cosa en curso, y con el dron en el aire o listo para despegar solo
     * (GPS y punto de retorno: la ruta se vuela con coordenadas).
     */
    fun comenzarHabilitado(hayRutas: Boolean, estado: PatrolState, dron: EstadoDelDron): Boolean =
        hayRutas && estado == PatrolState.IDLE && (dron.enVuelo || dron.listoParaDespegar)

    /**
     * "Despegar aquí": en el suelo, con enlace con la aeronave, sin un regreso a
     * base ni un relevo en curso y sin la batería por cambiar (LANDED). No exige
     * GPS.
     */
    fun despegarAquiHabilitado(estado: PatrolState, dron: EstadoDelDron): Boolean =
        !dron.enVuelo && dron.conectado && estado !in SIN_DESPEGUE_A_MANO && estado != PatrolState.LANDED

    /** Lo que se explica debajo de los botones de vuelo cuando están apagados. */
    sealed interface Aviso {
        /** Falta GPS o punto de retorno para volar una ruta; [detalle] es lo que dice el controlador. */
        data class SinCondicionesParaLaRuta(val detalle: String) : Aviso

        /** Aterrizó con la batería baja: hasta que la cambien no se vuela. */
        object CambiarLaBateria : Aviso
    }

    /**
     * Por qué los botones de vuelo están apagados, para decirlo debajo; null si
     * no hay nada que explicar (se puede, no hay rutas, u otra cosa en curso).
     * Lo típico es la falta de GPS o de punto de retorno; después de un
     * aterrizaje por batería baja, que hay que cambiarla.
     */
    fun aviso(hayRutas: Boolean, estado: PatrolState, dron: EstadoDelDron): Aviso? = when {
        estado == PatrolState.LANDED && !dron.enVuelo -> Aviso.CambiarLaBateria
        hayRutas && estado == PatrolState.IDLE && !dron.enVuelo && !dron.listoParaDespegar ->
            Aviso.SinCondicionesParaLaRuta(dron.detalle)
        else -> null
    }

    /** El texto de un [Aviso] para el operador. */
    fun texto(aviso: Aviso, contexto: Context): String = when (aviso) {
        is Aviso.SinCondicionesParaLaRuta -> contexto.getString(R.string.main_no_se_puede_patrullar, aviso.detalle)
        Aviso.CambiarLaBateria -> contexto.getString(R.string.main_cambiar_bateria)
    }
}
