package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron
import java.util.EnumSet

/**
 * La cuenta del regreso a base en curso, para saber qué avisar con cada novedad
 * del dron (docs/RELEVOS.md §2.3 y §4). La comparten los dos controladores: el
 * real la alimenta con `KeyGoHomeStatus` y los cambios de autoridad del MSDK, el
 * simulado con su propio modo de vuelo. Así los dos avisan lo mismo en el mismo
 * momento, y lo que decide —lo que se puede equivocar— se prueba sin dron.
 *
 * Decide tres cosas:
 *
 *  1. **El descenso en la base.** Un regreso que pidió la app avisa
 *     [FlightEvent.DescendiendoEnBase] UNA vez, al empezar a bajar: es lo que
 *     dispara `landing_at_base` en un relevo de patrulla, y repetirlo sería
 *     ordenar el relevo dos veces.
 *  2. **La toma del control.** Un regreso o un aterrizaje que nadie pidió es el
 *     propio DJI sacándole el vuelo a la app: [FlightEvent.ElDronTomoElControl],
 *     una vez por episodio aunque llegue por dos caminos (el cambio de autoridad
 *     y el estado del regreso suelen llegar juntos). El aterrizaje forzado se
 *     avisa aparte del regreso: es otra noticia, y la que dispara el protocolo de
 *     última ubicación sin control de vuelo (RELEVOS §5).
 *  3. **Un solo intento de cortar un regreso propio** (RELEVOS §4): si el DJI lo
 *     vuelve a arrancar, se lo deja seguir. Pelearse en lazo con el failsafe del
 *     dron es la peor forma de gastar la batería que le queda. El regreso que
 *     pidió la app, en cambio, se corta las veces que haga falta (el desvío
 *     empieza justamente cortándolo).
 *
 * Todo va sincronizado: los oyentes del SDK y los lazos de comando lo llaman
 * desde hilos distintos.
 */
class SeguidorDelRegreso {

    /** Qué aterrizaje pidió la app. Con esto un regreso propio se distingue de uno ordenado. */
    enum class Orden { NINGUNA, REGRESO, ATERRIZAJE }

    /** En qué anda el regreso a base del dron (el `GoHomeState` del MSDK, sin depender del SDK). */
    enum class Fase { INACTIVO, VOLVIENDO, DESCENDIENDO, OTRA }

    /** Las dos clases de toma que se avisan por separado. */
    private enum class Toma { REGRESO, ATERRIZAJE }

    private var fase = Fase.INACTIVO
    private var descensoAvisado = false
    private val tomasAvisadas: EnumSet<Toma> = EnumSet.noneOf(Toma::class.java)
    private var regresoPropio = false
    private var cortesDeRegresoPropio = 0

    /** El dron está volviendo a casa o bajando al final del regreso. */
    val volviendo: Boolean
        @Synchronized get() = fase == Fase.VOLVIENDO || fase == Fase.DESCENDIENDO

    /**
     * La app ordenó un aterrizaje. Uno nuevo de regreso —también el que adopta
     * un regreso propio que ya estaba en curso— vuelve a habilitar el aviso del
     * descenso: es otro regreso.
     */
    @Synchronized
    fun alOrdenar(orden: Orden) {
        if (orden == Orden.REGRESO) descensoAvisado = false
    }

    /**
     * Novedad del regreso a base según el dron. [orden] es lo que la app tiene
     * pedido en este momento; [motivoProbable], qué decir si resulta ser una
     * toma (ver [TomaDelDron.motivoProbable]).
     *
     * @return el aviso que corresponde, o null si no hay nada que avisar.
     */
    @Synchronized
    fun alCambiarFase(nueva: Fase, orden: Orden, motivoProbable: MotivoDelDron): FlightEvent? {
        fase = nueva
        return when (nueva) {
            Fase.INACTIVO -> {
                terminarRegreso()
                null
            }
            // Un regreso que la app no pidió —tampoco si pidió aterrizar acá—
            // es del dron.
            Fase.VOLVIENDO -> if (orden == Orden.REGRESO) null else arrancarRegresoPropio(motivoProbable)
            Fase.DESCENDIENDO -> when (orden) {
                Orden.REGRESO -> avisarDescenso()
                // La app pidió aterrizar donde está: bajar es lo que se le pidió.
                Orden.ATERRIZAJE -> null
                // Bajando en casa sin que nadie lo pida: el final de un regreso
                // propio cuyo comienzo no se vio (la app se conectó a mitad de
                // camino, o se cortó el enlace).
                Orden.NINGUNA -> arrancarRegresoPropio(motivoProbable)
            }
            Fase.OTRA -> null
        }
    }

    /**
     * El dron arrancó un regreso propio que se ve por su lado (el simulado lo
     * sabe; el real lo deduce de la autoridad o del regreso por batería).
     */
    @Synchronized
    fun alArrancarRegresoPropio(motivo: MotivoDelDron): FlightEvent.ElDronTomoElControl? {
        fase = Fase.VOLVIENDO
        return arrancarRegresoPropio(motivo)
    }

    /**
     * El dron avisó que se quedó con el vuelo (un cambio de autoridad, el
     * aterrizaje forzado por batería crítica). Un regreso cuenta como regreso
     * propio para la regla del único corte.
     */
    @Synchronized
    fun alTomarElControl(motivo: MotivoDelDron): FlightEvent.ElDronTomoElControl? {
        if (motivo != MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA) regresoPropio = true
        return avisarToma(motivo)
    }

    /**
     * Si se puede intentar cortar el regreso en curso: el que pidió la app,
     * siempre; uno propio del dron, una sola vez por vuelo.
     */
    @Synchronized
    fun puedeCortar(): Boolean = !regresoPropio || cortesDeRegresoPropio == 0

    /** Se va a intentar cortar el regreso: si es propio, gasta el único intento. */
    @Synchronized
    fun alCortar() {
        if (regresoPropio) cortesDeRegresoPropio++
    }

    /** Tocó el suelo: todo vuelve a empezar para el vuelo siguiente. */
    @Synchronized
    fun alAterrizar() {
        fase = Fase.INACTIVO
        descensoAvisado = false
        tomasAvisadas.clear()
        regresoPropio = false
        cortesDeRegresoPropio = 0
    }

    private fun arrancarRegresoPropio(motivo: MotivoDelDron): FlightEvent.ElDronTomoElControl? {
        regresoPropio = true
        return avisarToma(motivo)
    }

    /**
     * El regreso terminó sin aterrizar (se cortó). Si el dron lo vuelve a
     * arrancar es una toma nueva y se avisa otra vez; los cortes gastados NO se
     * reponen: son por vuelo.
     */
    private fun terminarRegreso() {
        regresoPropio = false
        tomasAvisadas.remove(Toma.REGRESO)
    }

    private fun avisarDescenso(): FlightEvent? {
        if (descensoAvisado) return null
        descensoAvisado = true
        return FlightEvent.DescendiendoEnBase
    }

    private fun avisarToma(motivo: MotivoDelDron): FlightEvent.ElDronTomoElControl? {
        val toma = if (motivo == MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA) Toma.ATERRIZAJE else Toma.REGRESO
        return if (tomasAvisadas.add(toma)) FlightEvent.ElDronTomoElControl(motivo) else null
    }
}
