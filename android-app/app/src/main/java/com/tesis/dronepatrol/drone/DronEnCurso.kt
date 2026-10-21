package com.tesis.dronepatrol.drone

/**
 * El controlador del dron que se está desplegando. Vive en el proceso y no en
 * una Activity porque lo comparten dos pantallas: la de conexión, que lo
 * enciende y espera el enlace con la aeronave, y la de operación, que vuela
 * con él. Crearlo dos veces sería registrar dos veces los oyentes del SDK.
 */
object DronEnCurso {

    @Volatile
    private var controller: DroneController? = null

    /** El controlador en curso, creado si todavía no hay. */
    fun obtener(): DroneController = controller ?: ControllerFactory.create().also { controller = it }

    /** Para el banco de pruebas: la pantalla usa este en vez de crear uno. */
    fun usar(controlador: DroneController) {
        controller = controlador
    }

    /** Se terminó la operación (o se abandonó antes de empezar). */
    fun soltar() {
        controller = null
    }
}
