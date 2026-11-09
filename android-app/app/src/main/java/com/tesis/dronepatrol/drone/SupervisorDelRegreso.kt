package com.tesis.dronepatrol.drone

/**
 * Lo que decide, lectura por lectura, la secuencia de un regreso a base que
 * ordenó la app (DroneController.returnHome, docs/VUELO.md §7.2): mandar la
 * orden, mirar que el regreso de verdad arranque y, si no, volver a ordenarla o
 * rendirse avisando.
 *
 * Existe por la prueba de campo del estacionamiento (VUELO §0): «Volver a la
 * base» cortaba el lazo de la órbita y mandaba `KeyStartGoHome` sin esperar ni
 * mirar nada. Una vuelta tardía del lazo volvía a habilitar el Virtual Stick,
 * el GoHome quedaba pisado o rechazado, la app decía que volvía y el dron
 * seguía queriendo orbitar. Con esto cada orden de volver tiene un resultado:
 * el dron vuelve, o la consola se entera de por qué no.
 *
 * Las reglas:
 *  - una orden rechazada o sin respuesta se vuelve a mandar; a la
 *    [MAXIMO_DE_ORDENES]ª que falla, [Accion.NO_SE_PUDO]. Una rechazada con el
 *    dron ya volviendo cuenta como arrancado: es el «ya estoy volviendo» del
 *    SDK;
 *  - aceptada, el regreso tiene que ARRANCAR: `GoHomeState` en
 *    RETURNING_TO_HOME (o LANDING cerca de la base) o el modo de vuelo GO_HOME
 *    (ver [arranco]). Sin eso en [VERIFICACION_MS] contados desde la respuesta,
 *    se vuelve a ordenar (cuenta como otra orden);
 *  - arrancado, la secuencia termina: el resto del regreso lo sigue el oyente
 *    de `KeyGoHomeStatus` (el descenso en la base, el suelo, y si se interrumpe
 *    en el aire, [seInterrumpioEnElAire]);
 *  - BAJANDO (el modo de aterrizaje, o el dron pidiendo confirmar), el dron va
 *    al suelo: cerca de la base el GoHome aterriza directo
 *    (`NOT_HOMING_IN_SHORT_DISTANCE`, con el estado en IDLE y el modo en
 *    AUTO_LANDING). Se lo mira hasta el suelo y nunca se rinde: reordenar
 *    durante el descenso terminaba en un «no se pudo volver» a segundos de
 *    tocar tierra, y el estacionario que sigue le cortaba el aterrizaje;
 *  - sin enlace con la aeronave el reloj no corre y las órdenes no cuentan: no
 *    hay lectura nueva, la que salió no le llegó al dron (o su respuesta no dice
 *    nada) y el dron puede estar volviendo igual. Sin enlace nunca hay
 *    [Accion.NO_SE_PUDO]: cuando vuelve, las órdenes siguen donde estaban.
 *
 * Vive en `main`, sin el MSDK, para poder probar cada borde sin dron; el
 * controlador real hace las lecturas y las órdenes.
 *
 * @param reloj la hora de las lecturas (las pruebas la adelantan a mano).
 */
class SupervisorDelRegreso(private val reloj: () -> Long = System::currentTimeMillis) {

    /** Qué hace la secuencia después de una lectura o de una respuesta. */
    enum class Accion {
        /** Seguir mirando: la orden fue aceptada y el plazo no venció, el dron baja, o no hay enlace. */
        SEGUIR,

        /** Mandar `KeyStartGoHome` (otra vez). */
        ORDENAR,

        /** El regreso arrancó: la secuencia termina y el oyente del regreso sigue el resto. */
        ARRANCO,

        /** Está en el suelo: no hay regreso que ordenar (el aviso lo da el oyente de `KeyIsFlying`). */
        EN_EL_SUELO,

        /** Se agotaron las órdenes, con enlace: avisar [motivoDelFallo] y dejar al dron estacionario por su cuenta. */
        NO_SE_PUDO,
    }

    /** Lo que se lee del dron en cada vuelta de la secuencia. */
    data class Lectura(
        val enVuelo: Boolean,
        val conEnlace: Boolean,
        /** El regreso está en curso según el dron (ver [arranco]); null si no lo informa. */
        val arranco: Boolean?,
        /**
         * El dron va al suelo: el modo de aterrizaje
         * ([SupervisorDelAterrizaje.estaBajando]) o el pedido de confirmar el
         * aterrizaje; null si no lo informa.
         */
        val bajando: Boolean? = null,
        /** Por qué salió del último GoHome (`KeyGoHomeExitReason`, su `name`); null si no lo informa. */
        val salida: String? = null,
    )

    /** Cuántas órdenes salieron, con enlace, desde [empezar]. */
    var ordenes = 0
        private set

    /** El dron aceptó, con enlace, alguna de las órdenes de este regreso (cambia el motivo del fallo). */
    var aceptado = false
        private set

    private var ultimoRechazo: String? = null
    private var ultimaSalida: String? = null
    private var plazoDesdeMs = 0L

    /** Arranca la cuenta de órdenes. */
    fun empezar(): Accion {
        ordenes = 0
        aceptado = false
        ultimoRechazo = null
        ultimaSalida = null
        return Accion.ORDENAR
    }

    /**
     * Lo que contestó `KeyStartGoHome`: true aceptó, false rechazó (con
     * [motivo]), null no contestó a tiempo. [lectura] es lo que se leyó después.
     */
    fun alContestar(aceptada: Boolean?, lectura: Lectura, motivo: String? = null): Accion {
        anotarLaSalida(lectura)
        // Sin enlace la orden no le llegó al dron, o su respuesta no dice nada:
        // no gasta ninguna de las tres.
        if (lectura.conEnlace) ordenes++
        if (!lectura.enVuelo) return Accion.EN_EL_SUELO
        // Rechazada o sin respuesta, pero el dron ya vuelve: es lo que se pidió.
        if (lectura.arranco == true) return Accion.ARRANCO
        if (aceptada == true && lectura.conEnlace) aceptado = true
        // Aceptada, bajando o sin enlace: se mira, y el plazo cuenta desde acá.
        if (aceptada == true || lectura.bajando == true || !lectura.conEnlace) {
            plazoDesdeMs = reloj()
            return Accion.SEGUIR
        }
        ultimoRechazo = motivo ?: ultimoRechazo
        return siguienteOrden()
    }

    /** Una vuelta de la secuencia con la orden ya contestada: ¿arrancó? */
    fun alLeer(lectura: Lectura): Accion {
        val ahora = reloj()
        anotarLaSalida(lectura)
        if (!lectura.enVuelo) return Accion.EN_EL_SUELO
        if (lectura.arranco == true) return Accion.ARRANCO
        if (!lectura.conEnlace || lectura.bajando == true) {
            // Sin enlace no hay lectura nueva; bajando, el dron va al suelo. El
            // plazo cuenta desde que vuelve el enlace, o desde que deja de bajar.
            plazoDesdeMs = ahora
            return Accion.SEGUIR
        }
        if (ahora - plazoDesdeMs < VERIFICACION_MS) return Accion.SEGUIR
        return siguienteOrden()
    }

    private fun siguienteOrden(): Accion = if (ordenes >= MAXIMO_DE_ORDENES) Accion.NO_SE_PUDO else Accion.ORDENAR

    /** La última salida del GoHome que dice algo, para el motivo del fallo. */
    private fun anotarLaSalida(lectura: Lectura) {
        if (salidaInformada(lectura.salida)) ultimaSalida = lectura.salida
    }

    /** Por qué no se pudo, para el aviso (sin el prefijo de DroneController). */
    fun motivoDelFallo(): String {
        val salida = ultimaSalida?.let { "salida del GoHome: $it" }
        val porQue = when {
            aceptado -> "el dron aceptó la orden pero el regreso no arrancó en ${VERIFICACION_MS / 1000} s " +
                "(${listOfNotNull("$ordenes órdenes", salida).joinToString("; ")})"
            ultimoRechazo != null -> "el dron no aceptó la orden en $ordenes intentos " +
                "(${listOfNotNull(ultimoRechazo, salida).joinToString("; ")})"
            else -> "el dron no contestó la orden en $ordenes intentos" + (if (salida != null) " ($salida)" else "")
        }
        return "$porQue: queda estacionario donde está, a la espera de otra orden"
    }

    companion object {
        /** Órdenes de volver por regreso (la primera y dos reintentos) antes de rendirse. */
        const val MAXIMO_DE_ORDENES = 3

        /** Cada cuánto se lee al dron mientras se espera que arranque (y mientras se espera el enlace). */
        const val INTERVALO_MS = 500L

        /** Lo que se le espera la respuesta a `KeyStartGoHome` (antes no tenía tope). */
        const val ESPERA_DE_LA_ORDEN_MS = 5_000L

        /** Entre una orden que falló y la siguiente. */
        const val ENTRE_ORDENES_MS = 1_000L

        /** Aceptada la orden, lo que tiene el regreso para salir de IDLE (VUELO §7.2). */
        const val VERIFICACION_MS = 3_000L

        /**
         * Hasta dónde de la base un `GoHomeState` LANDING es el descenso del
         * regreso. Más lejos no prueba nada: recién cortado un aterrizaje, el
         * LANDING de ese aterrizaje se adoptaba como un regreso y el dron bajaba
         * donde estaba con la app diciendo que volvía. El GoHome baja sobre el
         * punto de retorno; 30 m cubren el error del GPS de los dos lados.
         */
        const val CERCA_DE_LA_BASE_M = 30.0

        /**
         * Por debajo de esto, un regreso que deja de volver está terminando (el
         * descenso final, la protección de aterrizaje a medio metro), no
         * interrumpido en el aire.
         */
        const val ALTURA_DEL_FINAL_DEL_REGRESO_M = 2.0

        /** Los `GoHomeState` del MSDK 5.18 (comprobados con javap) del regreso en curso: volviendo, y bajando en la base. */
        const val ESTADO_VOLVIENDO = "RETURNING_TO_HOME"
        const val ESTADO_BAJANDO_EN_LA_BASE = "LANDING"
        val ESTADOS_DE_REGRESO_EN_CURSO = setOf(ESTADO_VOLVIENDO, ESTADO_BAJANDO_EN_LA_BASE)

        /** El `FlightMode` del MSDK 5.18 (comprobado con javap) del regreso a base. */
        const val MODO_DE_REGRESO = "GO_HOME"

        /**
         * Si el dron está volviendo, con el estado del regreso (`KeyGoHomeStatus`,
         * su `name`), el modo de vuelo (`KeyFlightMode`, su `name`) y a cuántos
         * metros está del punto de retorno (NaN si no se sabe): true con
         * RETURNING_TO_HOME o el modo GO_HOME —el GoHome se pone en GO_HOME antes
         * de que su estado salga de IDLE—, y con LANDING solo a
         * [CERCA_DE_LA_BASE_M] o menos de la base; false si alguno informa otra
         * cosa conocida (IDLE, COMPLETED, un modo que no es el regreso, LANDING
         * lejos de la base); null si no informa ninguno. Es EL criterio de
         * «el dron está volviendo» del controlador: la secuencia, el corte del
         * regreso y la adopción de uno en curso miran lo mismo.
         */
        fun arranco(estadoDelRegreso: String?, modoDeVuelo: String?, distanciaALaBaseM: Double): Boolean? = when {
            estadoDelRegreso == ESTADO_VOLVIENDO || modoDeVuelo == MODO_DE_REGRESO -> true
            estadoDelRegreso == ESTADO_BAJANDO_EN_LA_BASE && distanciaALaBaseM <= CERCA_DE_LA_BASE_M -> true
            informa(estadoDelRegreso) || informa(modoDeVuelo) -> false
            else -> null
        }

        /**
         * Un regreso que dejó de volver ¿se interrumpió en el aire? Sí si el modo
         * de vuelo es conocido y no es GO_HOME (con GO_HOME, el estado en IDLE es
         * un estado que se atrasó), el dron no está aterrizando y está a más de
         * [ALTURA_DEL_FINAL_DEL_REGRESO_M]. Bajando, o a ras del suelo, es el
         * final del regreso, que termina con el aviso del suelo; sin modo (el
         * enlace que se corta lo manda a UNKNOWN) no se sabe, y no se avisa nada.
         */
        fun seInterrumpioEnElAire(modoDeVuelo: String?, enModoDeAterrizaje: Boolean?, alturaM: Double): Boolean =
            informa(modoDeVuelo) &&
                modoDeVuelo != MODO_DE_REGRESO &&
                SupervisorDelAterrizaje.estaBajando(modoDeVuelo, enModoDeAterrizaje) != true &&
                alturaM > ALTURA_DEL_FINAL_DEL_REGRESO_M

        /**
         * La salida del GoHome fue por las palancas del control físico: alguien al
         * lado del dron lo está volando. El MSDK 5.18 las llama
         * `JOYSTICK_PITCH_ADD` y `OYSTICK_THROTTLE_ADD` —así, sin la J (javap)—,
         * por eso se busca lo que tienen en común y no el nombre entero.
         */
        fun esSalidaPorLasPalancas(salida: String?): Boolean = salida?.contains("OYSTICK_") == true

        /** La salida del GoHome dice algo: ni nada informado, ni `NO_ERROR`, ni `UNKNOWN`. */
        fun salidaInformada(salida: String?): Boolean = salida != null && salida != "NO_ERROR" && salida != "UNKNOWN"

        /**
         * El dron ya no está aterrizando: ni LANDING en el estado del regreso ni
         * el modo de aterrizaje, dicho por el modo de vuelo o por
         * `KeyIsInLandingMode` (sin ninguno de los dos informado no se sabe). Es
         * lo que espera un regreso que acaba de cortar un aterrizaje antes de
         * mirar si el dron vuelve.
         */
        fun sinElAterrizaje(estadoDelRegreso: String?, modoDeVuelo: String?, enModoDeAterrizaje: Boolean?): Boolean =
            estadoDelRegreso != ESTADO_BAJANDO_EN_LA_BASE &&
                SupervisorDelAterrizaje.estaBajando(modoDeVuelo, enModoDeAterrizaje) == false

        private fun informa(valor: String?): Boolean = valor != null && valor != "UNKNOWN"
    }
}
