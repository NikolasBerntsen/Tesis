package com.tesis.dronepatrol.drone

/**
 * El rumbo al que se le clava la nariz al dron mientras nadie la gira.
 *
 * En el Virtual Stick del MSDK el yaw se puede mandar como velocidad de giro
 * (`YawControlMode.ANGULAR_VELOCITY`) o como rumbo absoluto (`ANGLE`). El
 * mando manual y el estacionario mandaban "velocidad de giro cero", y con eso
 * el dron amortigua el giro pero no sostiene un rumbo: una ráfaga lo corre
 * unos grados y ahí se queda, con la cámara mirando a otro lado. El control
 * físico, con la palanca de giro al centro, hace lo otro: sostiene el rumbo
 * que tenía al soltarla. Esto es eso mismo: al soltar la palanca de giro se
 * recuerda el rumbo de la nariz y se lo manda como ángulo en cada vuelta;
 * mientras la palanca gira, no hay ancla.
 *
 * Es puro y vive en `main` para probarse sin dron; el controlador DJI le pasa
 * el rumbo de la brújula y usa lo que devuelve para elegir el modo del yaw.
 */
class AnclaDeRumbo {

    private var rumbo = Double.NaN

    /** El rumbo anclado, 0..360, o NaN si no hay ancla. */
    val rumboGrados: Double get() = rumbo

    /**
     * Una vuelta más del lazo. Con la palanca de giro en uso ([giroSuelto]
     * false) no hay ancla y devuelve null: la nariz va a donde la lleva la
     * palanca. Con la palanca suelta, la primera vuelta ancla el rumbo actual
     * ([rumboActualGrados], NaN si la brújula todavía no dijo nada: entonces
     * tampoco hay ancla, y se vuelve a intentar en la vuelta siguiente) y las
     * siguientes devuelven ese mismo rumbo, aunque el dron se haya corrido.
     */
    fun rumbo(giroSuelto: Boolean, rumboActualGrados: Double): Double? {
        if (!giroSuelto) {
            rumbo = Double.NaN
            return null
        }
        if (rumbo.isNaN()) {
            if (!rumboActualGrados.isFinite()) return null
            rumbo = ((rumboActualGrados % 360.0) + 360.0) % 360.0
        }
        return rumbo
    }

    /** Se olvida el ancla: la próxima vuelta con la palanca suelta vuelve a anclar donde esté la nariz. */
    fun soltar() {
        rumbo = Double.NaN
    }
}
