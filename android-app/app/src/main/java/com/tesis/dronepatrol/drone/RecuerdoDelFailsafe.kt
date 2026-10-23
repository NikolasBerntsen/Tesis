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
 * Lo guarda además en [almacen], que sobrevive al controlador: si la pantalla
 * se cierra o la app se recrea en pleno desvío, el controlador nuevo arranca
 * sabiendo que hay un failsafe por devolver y lo devuelve apenas el dron está en
 * el suelo. Sin eso el aparato quedaba en "aterrizar" para todos los vuelos
 * siguientes —también los de DJI Fly—, y la activación siguiente guardaba ese
 * aterrizaje como si fuera el original.
 *
 * Lo olvida recién cuando el dron aceptó la restauración ([alRestaurar]): si la
 * escritura falla (sin enlace, por ejemplo) queda pendiente y se reintenta la
 * próxima vez que el dron toque el suelo o se conecte en tierra.
 *
 * Genérico porque el valor es un enumerado del MSDK (`FailsafeAction`) y esto
 * vive en `main`, que se prueba sin el SDK.
 *
 * @param aterrizar el valor que se fija mientras está activo.
 * @param deFabrica el que se devuelve si al activar no se pudo leer el original
 *   (el de fábrica del Mini 4 Pro es volver a casa).
 * @param almacen dónde queda guardado entre un controlador y otro; null, en memoria nomás.
 */
class RecuerdoDelFailsafe<T : Enum<T>>(
    private val aterrizar: T,
    private val deFabrica: T,
    private val almacen: AlmacenDeTexto?,
) {

    private var guardado = false
    private var original: T? = null

    init {
        // Lo que dejó guardado un controlador anterior: sigue pendiente.
        val texto = runCatching { almacen?.leer() }.getOrNull()
        if (texto != null) {
            guardado = true
            // Un nombre que no es de este enumerado (otra versión de la app, o el
            // "no se pudo leer") queda en null: al restaurar va el de fábrica.
            original = runCatching { java.lang.Enum.valueOf(aterrizar.declaringJavaClass, texto) }.getOrNull()
        }
    }

    /** Hay un failsafe por devolver (de este controlador o de uno anterior). */
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
            persistir(if (actual == null) DESCONOCIDO else actual.name)
        }
        return aterrizar
    }

    /**
     * Lo que hay que volver a fijar para devolverle al dron el suyo, o null si
     * no hay nada pendiente (apagar dos veces no toca al dron). No lo olvida:
     * eso lo hace [alRestaurar] cuando el dron lo aceptó.
     */
    @Synchronized
    fun porRestaurar(): T? = if (guardado) original ?: deFabrica else null

    /** El dron aceptó el failsafe devuelto: no queda nada pendiente. */
    @Synchronized
    fun alRestaurar() {
        guardado = false
        original = null
        persistir(null)
    }

    /** Un almacén que falla no puede llevarse puesto al controlador: queda en memoria. */
    private fun persistir(valor: String?) {
        runCatching { almacen?.escribir(valor) }
    }

    private companion object {
        /** Se activó sin poder leer el original: al restaurar va el de fábrica. */
        const val DESCONOCIDO = "?"
    }
}
