package com.tesis.dronepatrol.drone

/**
 * El regreso inteligente por batería baja del propio DJI, visto desde la app
 * (docs/RELEVOS.md §4). Antes de arrancarlo el DJI cuenta diez segundos
 * (`LowBatteryRTHState.COUNTING_DOWN`) y acepta que se le conteste: con
 * `KeyLowBatteryRTHConfirm(false)` no vuelve. Durante un desvío a otra base la
 * app le contesta que no, porque ese regreso iría a una casa que ya no alcanza;
 * fuera del desvío lo deja seguir, que es el respaldo del dron.
 *
 * Decide dos cosas con cada estado que informa el SDK:
 *
 *  - si hay que contestarle que no AHORA: una vez por cuenta regresiva, no una
 *    por cada actualización del SDK (llega una por segundo mientras cuenta); si
 *    la respuesta falla, se reintenta con la actualización siguiente, que es
 *    reintentar al ritmo del propio dron y no en lazo;
 *  - si el regreso ARRANCÓ (la transición a `EXECUTED`): es una toma del control
 *    del DJI aunque el Virtual Stick no estuviera habilitado para enterarse por
 *    el cambio de autoridad. Solo la transición: el estado puede quedar en
 *    EXECUTED después de aterrizar, y el vuelo siguiente no es una toma.
 *
 * Recibe el nombre del estado y no el enumerado porque vive en `main` (ver
 * [TomaDelDron] para los nombres comprobados contra el MSDK).
 */
class VigiaDelRthPorBateria {

    /** Lo que hay que hacer con un estado nuevo. */
    data class Decision(
        /** Mandar ya `KeyLowBatteryRTHConfirm(false)`. */
        val contestarQueNo: Boolean,
        /** El DJI acaba de arrancar su regreso por batería. */
        val arrancoElRegreso: Boolean,
    )

    private var permitido = true
    private var contando = false
    private var contestada = false
    private var ultimoEstado: String? = null

    /** Último estado informado por el SDK (para [TomaDelDron.motivoProbable]). */
    val estado: String?
        @Synchronized get() = ultimoEstado

    /** Llegó un estado nuevo del SDK (null si el SDK no lo informa). */
    @Synchronized
    fun alCambiarEstado(estadoDelSdk: String?): Decision {
        val anterior = ultimoEstado
        ultimoEstado = estadoDelSdk
        val arranco = estadoDelSdk == EJECUTADO && anterior != EJECUTADO
        if (estadoDelSdk != CONTANDO) {
            contando = false
            contestada = false
            return Decision(contestarQueNo = false, arrancoElRegreso = arranco)
        }
        contando = true
        return Decision(contestarQueNo = decidir(), arrancoElRegreso = false)
    }

    /**
     * La app prende o apaga el regreso propio. Apagarlo en medio de una cuenta
     * regresiva contesta en el acto: esperar la próxima actualización puede ser
     * esperar a que el DJI ya haya arrancado.
     *
     * @return true si hay que mandar ya `KeyLowBatteryRTHConfirm(false)`.
     */
    @Synchronized
    fun alPermitir(permitir: Boolean): Boolean {
        permitido = permitir
        return contando && decidir()
    }

    /** La respuesta no llegó al dron: con la próxima novedad se vuelve a intentar. */
    @Synchronized
    fun alFallarLaRespuesta() {
        contestada = false
    }

    /**
     * Al reconectar: lo de antes era de otro enlace. Lo que la app pidió
     * (permitir o no) se conserva, porque el enlace se puede cortar y volver en
     * pleno desvío; lo que lo devuelve es tocar el suelo ([alTocarElSuelo]).
     */
    @Synchronized
    fun reiniciar() {
        contando = false
        contestada = false
        ultimoEstado = null
    }

    /**
     * El dron está en el suelo: el desvío (o la emergencia) terminó, y el regreso
     * inteligente vuelve a estar permitido. Si no, un solo `permitir(true)` que
     * la app no llegó a mandar —se cerró la pantalla, se cortó el desvío por una
     * orden— dejaba al vuelo siguiente sin el respaldo del propio DJI, y fuera
     * de un desvío ese respaldo tiene que estar (RELEVOS §0 y §4). El último
     * estado se conserva: un EXECUTED que queda del vuelo anterior no es un
     * arranque en el siguiente.
     */
    @Synchronized
    fun alTocarElSuelo() {
        permitido = true
        contando = false
        contestada = false
    }

    private fun decidir(): Boolean {
        if (permitido || contestada) return false
        contestada = true
        return true
    }

    private companion object {
        const val CONTANDO = "COUNTING_DOWN"
        const val EJECUTADO = "EXECUTED"
    }
}
