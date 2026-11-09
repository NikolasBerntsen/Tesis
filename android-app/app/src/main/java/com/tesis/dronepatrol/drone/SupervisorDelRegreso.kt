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
 *  - aceptada, el regreso tiene que ARRANCAR: `GoHomeState` fuera de IDLE
 *    (RETURNING_TO_HOME, o LANDING si ya estaba sobre la base) o el modo de
 *    vuelo GO_HOME (ver [arranco]). Sin eso en [VERIFICACION_MS] contados desde
 *    la respuesta, se vuelve a ordenar (cuenta como otra orden);
 *  - arrancado, la secuencia termina: el resto del regreso lo sigue el oyente
 *    de `KeyGoHomeStatus` (el descenso en la base, el suelo);
 *  - sin enlace con la aeronave el reloj no corre: no hay lectura nueva, y el
 *    dron sigue con lo suyo.
 *
 * Vive en `main`, sin el MSDK, para poder probar cada borde sin dron; el
 * controlador real hace las lecturas y las órdenes.
 *
 * @param reloj la hora de las lecturas (las pruebas la adelantan a mano).
 */
class SupervisorDelRegreso(private val reloj: () -> Long = System::currentTimeMillis) {

    /** Qué hace la secuencia después de una lectura o de una respuesta. */
    enum class Accion {
        /** Seguir mirando: la orden fue aceptada y el plazo para que arranque no venció. */
        SEGUIR,

        /** Mandar `KeyStartGoHome` (otra vez). */
        ORDENAR,

        /** El regreso arrancó: la secuencia termina y el oyente del regreso sigue el resto. */
        ARRANCO,

        /** Está en el suelo: no hay regreso que ordenar (el aviso lo da el oyente de `KeyIsFlying`). */
        EN_EL_SUELO,

        /** Se agotaron las órdenes: avisar [motivoDelFallo] y dejar al dron estacionario por su cuenta. */
        NO_SE_PUDO,
    }

    /** Lo que se lee del dron en cada vuelta de la secuencia. */
    data class Lectura(
        val enVuelo: Boolean,
        val conEnlace: Boolean,
        /** El regreso está en curso según el dron (ver [arranco]); null si no lo informa. */
        val arranco: Boolean?,
    )

    /** Cuántas órdenes salieron desde [empezar]. */
    var ordenes = 0
        private set

    /** El dron aceptó alguna de las órdenes de este regreso (cambia el motivo del fallo). */
    var aceptado = false
        private set

    private var ultimoRechazo: String? = null
    private var plazoDesdeMs = 0L

    /** Arranca la cuenta de órdenes. */
    fun empezar(): Accion {
        ordenes = 0
        aceptado = false
        ultimoRechazo = null
        return Accion.ORDENAR
    }

    /**
     * Lo que contestó `KeyStartGoHome`: true aceptó, false rechazó (con
     * [motivo]), null no contestó a tiempo. [lectura] es lo que se leyó después.
     */
    fun alContestar(aceptada: Boolean?, lectura: Lectura, motivo: String? = null): Accion {
        ordenes++
        if (!lectura.enVuelo) return Accion.EN_EL_SUELO
        // Rechazada o sin respuesta, pero el dron ya vuelve: es lo que se pidió.
        if (lectura.arranco == true) return Accion.ARRANCO
        if (aceptada == true) {
            aceptado = true
            plazoDesdeMs = reloj()
            return Accion.SEGUIR
        }
        ultimoRechazo = motivo ?: ultimoRechazo
        return siguienteOrden()
    }

    /** Una vuelta de la secuencia con la orden ya aceptada: ¿arrancó? */
    fun alLeer(lectura: Lectura): Accion {
        val ahora = reloj()
        if (!lectura.enVuelo) return Accion.EN_EL_SUELO
        if (lectura.arranco == true) return Accion.ARRANCO
        if (!lectura.conEnlace) {
            // El plazo cuenta desde que vuelve el enlace: sin él no hay lectura nueva.
            plazoDesdeMs = ahora
            return Accion.SEGUIR
        }
        if (ahora - plazoDesdeMs < VERIFICACION_MS) return Accion.SEGUIR
        return siguienteOrden()
    }

    private fun siguienteOrden(): Accion = if (ordenes >= MAXIMO_DE_ORDENES) Accion.NO_SE_PUDO else Accion.ORDENAR

    /** Por qué no se pudo, para el aviso (sin el prefijo de DroneController). */
    fun motivoDelFallo(): String {
        val porQue = when {
            aceptado -> "el dron aceptó la orden pero el regreso no arrancó en ${VERIFICACION_MS / 1000} s ($ordenes órdenes)"
            ultimoRechazo != null -> "el dron no aceptó la orden en $ordenes intentos ($ultimoRechazo)"
            else -> "el dron no contestó la orden en $ordenes intentos"
        }
        return "$porQue: queda estacionario donde está, a la espera de otra orden"
    }

    companion object {
        /** Órdenes de volver por regreso (la primera y dos reintentos) antes de rendirse. */
        const val MAXIMO_DE_ORDENES = 3

        /** Cada cuánto se lee al dron mientras se espera que arranque. */
        const val INTERVALO_MS = 500L

        /** Lo que se le espera la respuesta a `KeyStartGoHome` (antes no tenía tope). */
        const val ESPERA_DE_LA_ORDEN_MS = 5_000L

        /** Entre una orden que falló y la siguiente. */
        const val ENTRE_ORDENES_MS = 1_000L

        /** Aceptada la orden, lo que tiene el regreso para salir de IDLE (VUELO §7.2). */
        const val VERIFICACION_MS = 3_000L

        /** Los `GoHomeState` del MSDK 5.18 (comprobados con javap) con el regreso en curso: volviendo, o ya bajando en la base. */
        val ESTADOS_DE_REGRESO_EN_CURSO = setOf("RETURNING_TO_HOME", "LANDING")

        /** El `FlightMode` del MSDK 5.18 (comprobado con javap) del regreso a base. */
        const val MODO_DE_REGRESO = "GO_HOME"

        /**
         * Si el regreso está en curso, con el estado del regreso
         * (`KeyGoHomeStatus`, su `name`) y el modo de vuelo (`KeyFlightMode`, su
         * `name`): true si cualquiera de los dos lo dice, false si alguno informa
         * otra cosa conocida (IDLE, COMPLETED, un modo que no es el regreso), null
         * si no informa ninguno.
         */
        fun arranco(estadoDelRegreso: String?, modoDeVuelo: String?): Boolean? = when {
            estadoDelRegreso in ESTADOS_DE_REGRESO_EN_CURSO || modoDeVuelo == MODO_DE_REGRESO -> true
            informa(estadoDelRegreso) || informa(modoDeVuelo) -> false
            else -> null
        }

        private fun informa(valor: String?): Boolean = valor != null && valor != "UNKNOWN"
    }
}
