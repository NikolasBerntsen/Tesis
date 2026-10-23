package com.tesis.dronepatrol.drone

/**
 * Qué hace el dron si se corta el enlace con el control (`KeyFailsafeAction` en
 * el real), mientras la app lo tiene cambiado: durante un desvío a otra base y
 * en el protocolo de última ubicación (docs/RELEVOS.md §4 y §5) el failsafe es
 * aterrizar donde está, porque volver a una casa que no se alcanza es peor.
 * Después hay que devolverle al dron el que tenía, que es configuración del
 * operador (DJI Fly) y no de la app.
 *
 * Guarda el original UNA sola vez: el desvío y la emergencia lo pueden prender
 * los dos seguidos, y si la segunda activación guardara "el actual" guardaría
 * el aterrizaje que puso la primera, y al apagar nunca volvería el de verdad.
 *
 * Genérico porque el valor es un enumerado del MSDK (`FailsafeAction`) y esto
 * vive en `main`, que se prueba sin el SDK.
 *
 * @param aterrizar el valor que se fija mientras está activo.
 * @param deFabrica el que se devuelve si al activar no se pudo leer el original
 *   (el de fábrica del Mini 4 Pro es volver a casa).
 */
class RecuerdoDelFailsafe<T : Any>(private val aterrizar: T, private val deFabrica: T) {

    private var guardado = false
    private var original: T? = null

    /** Está activo: lo que haya que restaurar sigue guardado. */
    val activo: Boolean
        @Synchronized get() = guardado

    /**
     * Se activa con [actual] como valor de ese momento (null si no se pudo
     * leer). Devuelve lo que hay que fijar: siempre aterrizar.
     */
    @Synchronized
    fun alActivar(actual: T?): T {
        if (!guardado) {
            original = actual
            guardado = true
        }
        return aterrizar
    }

    /**
     * Se apaga. Devuelve lo que hay que volver a fijar, o null si no había
     * nada activo (apagar dos veces no toca al dron).
     */
    @Synchronized
    fun alDesactivar(): T? {
        if (!guardado) return null
        val restaurar = original ?: deFabrica
        guardado = false
        original = null
        return restaurar
    }
}
