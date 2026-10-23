package com.tesis.dronepatrol.drone

/**
 * Un texto que sobrevive al controlador que lo escribió: el real lo guarda en
 * las preferencias del teléfono, y así lo que la app le cambió al dron se le
 * puede devolver aunque la pantalla se haya cerrado en el medio (ver
 * [RecuerdoDelFailsafe]). Vive en `main` como interfaz para que lo que decide
 * se pruebe sin Android.
 */
interface AlmacenDeTexto {

    /** Lo guardado, o null si no hay nada. */
    fun leer(): String?

    /** Guarda [valor]; null lo borra. */
    fun escribir(valor: String?)
}
