package com.tesis.dronepatrol.drone

/**
 * Espera entre reintentos que se DUPLICA a cada fracaso, hasta un tope.
 *
 * Existe por la habilitación del mando virtual del DJI: `asegurarVirtualStick()`
 * se llama en CADA vuelta de los lazos de comando, que corren a 10 Hz, y cuando
 * la aeronave rechaza la habilitación —el dron en el suelo sin punto de home, el
 * RC-N3 en un modo que no cede la autoridad de vuelo, un regreso a base en
 * curso— reintentar cada 100 ms es machacarle al SDK una pregunta que ya
 * contestó, diez veces por segundo y para siempre. Con la espera creciente el
 * primer reintento sale enseguida (el rechazo puede ser de un instante) y, si el
 * motivo no se va, la frecuencia baja sola.
 *
 * No tiene reloj propio, igual que [LimitadorDeRitmo]: el momento lo pasa quien
 * llama. Así se prueba sin dormir el test y sirve tanto para el hilo del SDK
 * como para una corrutina.
 */
class EsperaCreciente(private val inicialMs: Long, private val topeMs: Long) {

    /** Espera en vigor ahora mismo. Arranca en la inicial y se duplica al fracasar. */
    private var esperaMs = inicialMs

    private var ultimoFracasoMs = SIN_FRACASOS

    /**
     * true si en [ahoraMs] se puede volver a intentar. Mientras no haya fracasado
     * nunca, siempre es true: la espera es el castigo del fracaso, no un peaje de
     * entrada.
     *
     * Está sincronizado porque los lazos de comando y los callbacks del SDK
     * corren en hilos distintos.
     */
    @Synchronized
    fun sePuedeIntentar(ahoraMs: Long): Boolean {
        if (ultimoFracasoMs == SIN_FRACASOS) return true
        // Un transcurrido negativo es el reloj del celular acomodándose hacia
        // atrás (NTP, cambio de hora). Se deja intentar: quedarse bloqueado hasta
        // que el reloj recupere la diferencia sería dejar al operador sin mando
        // por un cambio de hora.
        return (ahoraMs - ultimoFracasoMs) !in 0 until esperaMs
    }

    /**
     * El intento de [ahoraMs] falló: desde acá hay que esperar, y si vuelve a
     * fallar la espera será el doble (hasta [topeMs]).
     */
    @Synchronized
    fun fracaso(ahoraMs: Long) {
        // El primer fracaso espera la inicial; el doble es para el SIGUIENTE, así
        // un rechazo aislado no cuesta más de lo que tiene que costar.
        if (ultimoFracasoMs != SIN_FRACASOS) esperaMs = (esperaMs * 2).coerceAtMost(topeMs)
        ultimoFracasoMs = ahoraMs
    }

    /** Salió bien: se borra la deuda y se vuelve a la espera inicial. */
    @Synchronized
    fun exito() {
        ultimoFracasoMs = SIN_FRACASOS
        esperaMs = inicialMs
    }

    private companion object {
        /** Todavía no falló nunca: no hay nada que esperar. */
        const val SIN_FRACASOS = Long.MIN_VALUE
    }
}
