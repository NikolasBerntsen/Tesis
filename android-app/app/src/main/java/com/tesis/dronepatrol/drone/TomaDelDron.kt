package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.MotivoDelDron

/**
 * Cómo se leen los avisos del MSDK sobre el propio DJI tomando el vuelo
 * (docs/RELEVOS.md §4). Recibe los nombres de los enumerados del SDK y no los
 * enumerados mismos porque vive en `main`, que compila y se prueba sin el MSDK:
 * el controlador real le pasa `.name`. Los nombres están comprobados contra el
 * MSDK 5.18.0 (javap sobre `dji-sdk-v5-aircraft-provided`):
 *
 *  - `FlightControlAuthorityChangeReason`: MSDK_REQUEST, AUTO_TEST_REQUEST,
 *    OSDK_REQUEST, RC_LOST, RC_NOT_P_MODE, RC_SWITCH, RC_PAUSE_STOP,
 *    RC_ONE_KEY_GO_HOME, BATTERY_LOW_GO_HOME, BATTERY_SUPER_LOW_LANDING,
 *    OSDK_LOST, NEAR_BOUNDARY, AIRPORT_REQUEST, UNKNOWN.
 *  - `GoHomeState` (`FlightControllerKey.KeyGoHomeStatus`): IDLE,
 *    RETURNING_TO_HOME, LANDING, COMPLETED, UNKNOWN.
 *  - `LowBatteryRTHState` (`LowBatteryRTHInfo.lowBatteryRTHStatus`): IDLE,
 *    COUNTING_DOWN, EXECUTED, CANCELLED, UNKNOWN.
 */
object TomaDelDron {

    /**
     * Qué toma del control es un cambio de autoridad del Virtual Stick, o null
     * si no es una: el pedido de la propia app, el selector de modo del control,
     * la pausa del control y el resto quedan como un aviso de siempre (el
     * operador recupera el dron con las palancas, y eso no es el DJI decidiendo
     * por batería).
     */
    fun porCambioDeAutoridad(motivoDelSdk: String): MotivoDelDron? = when (motivoDelSdk) {
        "BATTERY_LOW_GO_HOME" -> MotivoDelDron.RTH_BATERIA
        "BATTERY_SUPER_LOW_LANDING" -> MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA
        "RC_ONE_KEY_GO_HOME" -> MotivoDelDron.RTH_DEL_CONTROL
        "RC_LOST" -> MotivoDelDron.RTH_SENIAL
        else -> null
    }

    /**
     * Si después de esta toma la app deja de comandar el vuelo hasta que el dron
     * aterrice (o hasta que la app corte el regreso con su único intento):
     * cortar el lazo y no volver a habilitar el Virtual Stick. Es así con la
     * batería —el DJI decidió que no le alcanza, y discutírselo en lazo es lo
     * peor— y con el botón de regreso del control, que es una persona pidiendo
     * el dron de vuelta.
     *
     * El regreso por pérdida de señal NO bloquea: al volver el enlace la app
     * tiene su propia regla para retomar o no (RELEVOS §1), la de siempre.
     */
    fun bloqueaLaApp(motivo: MotivoDelDron): Boolean = when (motivo) {
        MotivoDelDron.RTH_BATERIA,
        MotivoDelDron.ATERRIZAJE_BATERIA_CRITICA,
        MotivoDelDron.RTH_DEL_CONTROL,
        -> true
        MotivoDelDron.RTH_SENIAL,
        MotivoDelDron.OTRO,
        -> false
    }

    /** La fase del regreso según `GoHomeState`. */
    fun faseDelRegreso(estadoDelSdk: String): SeguidorDelRegreso.Fase = when (estadoDelSdk) {
        "IDLE" -> SeguidorDelRegreso.Fase.INACTIVO
        "RETURNING_TO_HOME" -> SeguidorDelRegreso.Fase.VOLVIENDO
        "LANDING" -> SeguidorDelRegreso.Fase.DESCENDIENDO
        else -> SeguidorDelRegreso.Fase.OTRA
    }

    /**
     * Qué decir de un regreso que el dron arrancó sin que se lo pidieran, cuando
     * no llegó un cambio de autoridad que lo explique (pasa si el Virtual Stick
     * no estaba habilitado): si su regreso por batería estaba contando o ya se
     * ejecutó, es eso; si el enlace con el control está caído o acaba de volver,
     * es su failsafe de señal (el regreso arrancó con el enlace cortado y la
     * app se entera al volver); si no, no se sabe.
     */
    fun motivoProbable(estadoDelRthPorBateria: String?, enlaceRecienRecuperado: Boolean): MotivoDelDron = when {
        estadoDelRthPorBateria == "COUNTING_DOWN" || estadoDelRthPorBateria == "EXECUTED" -> MotivoDelDron.RTH_BATERIA
        enlaceRecienRecuperado -> MotivoDelDron.RTH_SENIAL
        else -> MotivoDelDron.OTRO
    }
}
