package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.MotivoDelDron

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
 *     propio DJI sacándole el vuelo a la app: [FlightEvent.ElDronTomoElControl].
 *     El mismo motivo se avisa una vez por episodio aunque llegue por dos
 *     caminos (el cambio de autoridad y el estado del regreso suelen llegar
 *     juntos); un motivo que pesa MÁS ([TomaDelDron.fuerza]) se vuelve a avisar,
 *     porque es otra noticia: de la señal a la batería el regreso pasa a
 *     bloquear a la app, y de la batería al botón del control pasa a ser una
 *     persona pidiendo el dron. El aterrizaje forzado se avisa aparte del
 *     regreso: es la noticia que dispara el protocolo de última ubicación sin
 *     control de vuelo (RELEVOS §5).
 *  3. **Si se puede cortar el regreso** ([corte]). El que pidió la app, las
 *     veces que haga falta (el desvío empieza justamente cortándolo). Uno que
 *     arrancó el propio DJI, un solo intento por vuelo (RELEVOS §4): si lo
 *     vuelve a arrancar se lo deja seguir, porque pelearse en lazo con el
 *     failsafe del dron es la peor forma de gastar la batería que le queda. El
 *     que pidió el botón del control, nunca.
 *
 * Un episodio de toma termina cuando el regreso termina sin aterrizar (se
 * cortó), al tocar el suelo, o cuando la app retoma el mando de un dron que no
 * está volviendo ([alRetomarElMando]): sin eso, una toma sin regreso (un
 * estacionario, el failsafe de señal en aterrizar) dejaba ocupado el lugar del
 * aviso hasta el final del vuelo y la toma siguiente pasaba muda.
 *
 * Todo va sincronizado: los oyentes del SDK y los lazos de comando lo llaman
 * desde hilos distintos.
 */
class SeguidorDelRegreso {

    /** Qué aterrizaje pidió la app. Con esto un regreso propio se distingue de uno ordenado. */
    enum class Orden { NINGUNA, REGRESO, ATERRIZAJE }

    /** En qué anda el regreso a base del dron (el `GoHomeState` del MSDK, sin depender del SDK). */
    enum class Fase { INACTIVO, VOLVIENDO, DESCENDIENDO, OTRA }

    /** Si se puede intentar cortar el regreso en curso y, si no, por qué. */
    enum class Corte {
        SE_PUEDE,

        /** Es un regreso del propio DJI y su único corte de este vuelo ya se gastó. */
        YA_SE_CORTO,

        /** Lo pidió el botón de regreso del control: una persona; la app no lo corta. */
        LO_PIDIO_EL_CONTROL,
    }

    private var fase = Fase.INACTIVO
    private var descensoAvisado = false

    /** El motivo de regreso ya avisado en este episodio (el que más pesa); null si ninguno. */
    private var regresoAvisado: MotivoDelDron? = null
    private var aterrizajeAvisado = false

    /**
     * El regreso en curso es del propio dron y por qué; null si no hay ninguno o
     * es el que pidió la app. Solo un regreso de verdad lo marca: una toma de
     * señal o "de otro" puede ser un estacionario o un aterrizaje, y marcarla
     * dejaba gastado el único corte para cuando el DJI arrancara el suyo por
     * batería.
     */
    private var regresoPropio: MotivoDelDron? = null
    private var cortesDeRegresoPropio = 0

    /** El dron está volviendo a casa o bajando al final del regreso. */
    val volviendo: Boolean
        @Synchronized get() = enRegreso()

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
     * aterrizaje forzado por batería crítica, una toma simulada). La batería y
     * el botón del control dicen que el dron arrancó SU regreso; la señal y
     * "otro" no dicen qué hace —el failsafe de señal puede ser volver, quedarse
     * o aterrizar—, así que se avisan sin contar como regreso: si de verdad
     * vuelve, lo dice el estado del regreso ([alCambiarFase]).
     */
    @Synchronized
    fun alTomarElControl(motivo: MotivoDelDron): FlightEvent.ElDronTomoElControl? = when (motivo) {
        MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA -> avisarAterrizaje()
        MotivoDelDron.RTH_BATERIA, MotivoDelDron.RTH_DEL_CONTROL -> arrancarRegresoPropio(motivo)
        MotivoDelDron.RTH_SENIAL, MotivoDelDron.OTRO -> avisarRegreso(motivo)
    }

    /** Si se puede intentar cortar el regreso en curso (ver [Corte]). */
    @Synchronized
    fun corte(): Corte {
        val propio = regresoPropio ?: return Corte.SE_PUEDE
        return when {
            propio == MotivoDelDron.RTH_DEL_CONTROL -> Corte.LO_PIDIO_EL_CONTROL
            cortesDeRegresoPropio > 0 -> Corte.YA_SE_CORTO
            else -> Corte.SE_PUEDE
        }
    }

    /** Se va a intentar cortar el regreso: si es propio, gasta el único intento. */
    @Synchronized
    fun alCortar() {
        if (regresoPropio != null) cortesDeRegresoPropio++
    }

    /**
     * La app volvió a comandar el dron (el Virtual Stick habilitado otra vez, o
     * una orden aceptada con enlace). Si no está volviendo, la toma de antes
     * terminó: la próxima se avisa aunque sea por el mismo motivo. Con un
     * regreso en curso no cambia nada: ese episodio lo cierra el regreso.
     */
    @Synchronized
    fun alRetomarElMando() {
        if (enRegreso()) return
        regresoAvisado = null
        regresoPropio = null
    }

    /** Tocó el suelo: todo vuelve a empezar para el vuelo siguiente. */
    @Synchronized
    fun alAterrizar() {
        fase = Fase.INACTIVO
        descensoAvisado = false
        regresoAvisado = null
        aterrizajeAvisado = false
        regresoPropio = null
        cortesDeRegresoPropio = 0
    }

    private fun enRegreso(): Boolean = fase == Fase.VOLVIENDO || fase == Fase.DESCENDIENDO

    private fun arrancarRegresoPropio(motivo: MotivoDelDron): FlightEvent.ElDronTomoElControl? {
        regresoPropio = TomaDelDron.masFuerte(regresoPropio, motivo)
        return avisarRegreso(motivo)
    }

    /**
     * El regreso terminó sin aterrizar (se cortó). Si el dron lo vuelve a
     * arrancar es una toma nueva y se avisa otra vez; los cortes gastados NO se
     * reponen: son por vuelo.
     */
    private fun terminarRegreso() {
        regresoPropio = null
        regresoAvisado = null
    }

    private fun avisarDescenso(): FlightEvent? {
        if (descensoAvisado) return null
        descensoAvisado = true
        return FlightEvent.DescendiendoEnBase
    }

    /** Una toma de regreso: se avisa si es la primera del episodio o si pesa más que la ya avisada. */
    private fun avisarRegreso(motivo: MotivoDelDron): FlightEvent.ElDronTomoElControl? {
        val avisado = regresoAvisado
        if (avisado != null && TomaDelDron.fuerza(motivo) <= TomaDelDron.fuerza(avisado)) return null
        regresoAvisado = motivo
        return FlightEvent.ElDronTomoElControl(motivo)
    }

    private fun avisarAterrizaje(): FlightEvent.ElDronTomoElControl? {
        if (aterrizajeAvisado) return null
        aterrizajeAvisado = true
        return FlightEvent.ElDronTomoElControl(MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA)
    }
}
