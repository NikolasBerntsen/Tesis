package com.tesis.dronepatrol.drone

import java.util.Locale
import kotlin.math.min

/**
 * Lo que decide, lectura por lectura, la secuencia de un aterrizaje que ordenó
 * la app (DroneController.land): mandar la orden, darla por aceptada, mirar que
 * el dron de verdad baje y, si no, volver a ordenarla o rendirse avisando.
 *
 * Existe por la prueba de campo: la orden de aterrizar llegaba, la consola
 * mostraba "aterrizando" y el dron quedaba suspendido. Nadie miraba si el SDK la
 * aceptaba —`KeyStartAutoLanding` sin tope—, ni si el Mini entraba en
 * AUTO_LANDING y bajaba; un rechazo se perdía en los filtros de avisos. Con esto
 * cada orden tiene un resultado: el dron baja hasta el suelo, o la consola se
 * entera de por qué no.
 *
 * Las reglas:
 *  - una orden rechazada o sin respuesta se vuelve a mandar; a la
 *    [MAXIMO_DE_ORDENES]ª que falla, [Accion.NO_SE_PUDO]. Una rechazada con el
 *    dron ya bajando (o pidiendo confirmar) cuenta como aceptada: es el "ya
 *    estoy aterrizando" del SDK;
 *  - aceptada, el dron tiene que dar señales de aterrizaje: el modo de vuelo de
 *    aterrizaje ([estaBajando]), la altura que baja o el pedido de confirmar
 *    (eso lo contesta [ConfirmacionDelAterrizaje], y es la mitad del arreglo).
 *    Sin ninguna en [VERIFICACION_MS], o sin bajar [DESCENSO_MINIMO_M] en
 *    [ESTANCADO_MS] aunque diga que aterriza, se vuelve a ordenar (cuenta como
 *    otra orden);
 *  - si deja de aterrizar y SUBE [SUBIDA_QUE_CORTA_M] por encima de lo más
 *    bajo que llegó, lo subió una persona con las palancas del control:
 *    [Accion.LO_SUBIERON], y la app no se lo pelea;
 *  - sin enlace con la aeronave el reloj no corre: no hay lectura nueva, y el
 *    dron sigue con lo suyo.
 *
 * Vive en `main`, sin el MSDK, para poder probar cada borde sin dron; el
 * controlador real hace las lecturas y las órdenes.
 *
 * @param reloj la hora de las lecturas (las pruebas la adelantan a mano).
 */
class SupervisorDelAterrizaje(private val reloj: () -> Long = System::currentTimeMillis) {

    /** Qué hace la secuencia después de una lectura o de una respuesta. */
    enum class Accion {
        /** Seguir mirando: el dron baja, o está pidiendo confirmar. */
        SEGUIR,

        /** Mandar `KeyStartAutoLanding` (otra vez). */
        ORDENAR,

        /** Tocó el suelo: el aviso lo da el oyente de `KeyIsFlying`. */
        EN_EL_SUELO,

        /** Se agotaron las órdenes: avisar [motivoDelFallo] y soltar el aterrizaje. */
        NO_SE_PUDO,

        /** Lo subieron con las palancas del control: avisar [motivoDeLaSubida] y soltar. */
        LO_SUBIERON,
    }

    /** Lo que se lee del dron en cada vuelta de la secuencia. */
    data class Lectura(
        val enVuelo: Boolean,
        val conEnlace: Boolean,
        /** El dron dice que está aterrizando (ver [estaBajando]); null si no lo informa. */
        val bajando: Boolean?,
        /** `KeyIsLandingConfirmationNeeded`, leído en el momento. */
        val pideConfirmar: Boolean,
        /** Altura sobre el despegue; NaN si no se sabe. */
        val alturaM: Double,
    )

    /** Cuántas órdenes salieron desde [empezar]. */
    var ordenes = 0
        private set

    /** El dron aceptó alguna de las órdenes de este aterrizaje (el aviso sale una vez). */
    var aceptado = false
        private set

    /** Cuántas veces se mandó a confirmar el aterrizaje (ver [alConfirmar]). */
    var confirmaciones = 0
        private set

    private var ultimoRechazo: String? = null
    private var ultimoIndicioMs = 0L
    private var ultimoDescensoMs = 0L
    private var alturaDeReferencia = Double.NaN
    private var alturaMinima = Double.NaN
    private var subidaM = 0.0

    /**
     * Arranca la cuenta de órdenes: al recibir el aterrizaje y después de un
     * corrimiento, que deja al dron estacionario en otro lugar y necesita su
     * propia orden sin cargar con las de antes.
     */
    fun empezar(): Accion {
        ordenes = 0
        ultimoRechazo = null
        alturaMinima = Double.NaN
        return Accion.ORDENAR
    }

    /**
     * Lo que contestó `KeyStartAutoLanding`: true aceptó, false rechazó (con
     * [motivo]), null no contestó a tiempo. [lectura] es lo que se leyó después.
     */
    fun alContestar(aceptada: Boolean?, lectura: Lectura, motivo: String? = null): Accion {
        ordenes++
        if (!lectura.enVuelo) return Accion.EN_EL_SUELO
        if (aceptada == true || lectura.bajando == true || lectura.pideConfirmar) {
            aceptado = true
            anclar(lectura, reloj())
            return Accion.SEGUIR
        }
        ultimoRechazo = motivo ?: ultimoRechazo
        return if (ordenes >= MAXIMO_DE_ORDENES) Accion.NO_SE_PUDO else Accion.ORDENAR
    }

    /** Una vuelta de la secuencia con el aterrizaje ya aceptado. */
    fun alLeer(lectura: Lectura): Accion {
        val ahora = reloj()
        if (!lectura.enVuelo) return Accion.EN_EL_SUELO
        if (!lectura.conEnlace) {
            anclar(lectura, ahora)
            return Accion.SEGUIR
        }
        if (loSubieron(lectura)) return Accion.LO_SUBIERON
        anotarIndicios(lectura, ahora)
        val sinIndicios = ahora - ultimoIndicioMs >= VERIFICACION_MS
        val estancado = ahora - ultimoDescensoMs >= ESTANCADO_MS
        if (!sinIndicios && !estancado) return Accion.SEGUIR
        return if (ordenes >= MAXIMO_DE_ORDENES) Accion.NO_SE_PUDO else Accion.ORDENAR
    }

    /**
     * Se mandó una confirmación. true en la [AVISO_TRAS_CONFIRMACIONES]ª: el
     * dron sigue pidiendo y la consola tiene que enterarse (la app sigue
     * confirmando, pero algo abajo no le gusta al dron).
     */
    fun alConfirmar(): Boolean {
        confirmaciones++
        return confirmaciones == AVISO_TRAS_CONFIRMACIONES
    }

    /** Por qué no se pudo, para el aviso (sin el prefijo de DroneController). */
    fun motivoDelFallo(): String {
        val porQue = when {
            aceptado -> "el dron aceptó la orden pero no baja ($ordenes órdenes)"
            ultimoRechazo != null -> "el dron no aceptó la orden en $ordenes intentos ($ultimoRechazo)"
            else -> "el dron no contestó la orden en $ordenes intentos"
        }
        return "$porQue: queda suspendido donde está, con las palancas del control"
    }

    /** Lo que se dice cuando lo subieron con las palancas (ver [Accion.LO_SUBIERON]). */
    fun motivoDeLaSubida(): String =
        "el dron dejó de bajar y subió ${String.format(Locale.ROOT, "%.1f", subidaM)} m: " +
            "lo están subiendo con las palancas del control y la app no se lo pelea"

    private fun loSubieron(l: Lectura): Boolean {
        if (!l.alturaM.isFinite()) return false
        alturaMinima = if (alturaMinima.isNaN()) l.alturaM else min(alturaMinima, l.alturaM)
        subidaM = l.alturaM - alturaMinima
        // Aterrizando o pidiendo confirmar, lo que sube es el propio dron acomodándose.
        return l.bajando != true && !l.pideConfirmar && subidaM > SUBIDA_QUE_CORTA_M
    }

    private fun anotarIndicios(l: Lectura, ahora: Long) {
        val bajo = l.alturaM.isFinite() && (alturaDeReferencia.isNaN() || l.alturaM <= alturaDeReferencia - DESCENSO_MINIMO_M)
        if (bajo || l.pideConfirmar) {
            ultimoDescensoMs = ahora
            ultimoIndicioMs = ahora
            if (l.alturaM.isFinite()) alturaDeReferencia = l.alturaM
        } else if (l.bajando == true) {
            ultimoIndicioMs = ahora
        }
    }

    /** La cuenta de los indicios arranca de nuevo desde esta lectura. */
    private fun anclar(l: Lectura, ahora: Long) {
        ultimoIndicioMs = ahora
        ultimoDescensoMs = ahora
        alturaDeReferencia = l.alturaM
    }

    companion object {
        /** Órdenes de aterrizar por aterrizaje (la primera y dos reintentos) antes de rendirse. */
        const val MAXIMO_DE_ORDENES = 3

        /** Cada cuánto se lee al dron durante el aterrizaje. */
        const val INTERVALO_MS = 500L

        /** Lo que se le espera la respuesta a `KeyStartAutoLanding` (antes no tenía tope). */
        const val ESPERA_DE_LA_ORDEN_MS = 5_000L

        /** Entre una orden que falló y la siguiente. */
        const val ENTRE_ORDENES_MS = 1_000L

        /** Sin una sola señal de aterrizaje en este tiempo, el dron no está aterrizando. */
        const val VERIFICACION_MS = 3_000L

        /** Diciendo que aterriza pero sin bajar en este tiempo, está trabado. */
        const val ESTANCADO_MS = 20_000L

        /** Lo que tiene que bajar la altura para contar como descenso: más que el ruido del barómetro. */
        const val DESCENSO_MINIMO_M = 0.3

        /** Lo que sube por encima de lo más bajo que llegó sin estar aterrizando: lo están subiendo. */
        const val SUBIDA_QUE_CORTA_M = 1.5

        /** A la cuántas confirmaciones sin efecto se avisa a la consola. */
        const val AVISO_TRAS_CONFIRMACIONES = 5

        /** Los modos de vuelo del MSDK 5.18 (`FlightMode`, comprobado con javap) en los que el dron aterriza. */
        val MODOS_DE_ATERRIZAJE = setOf("AUTO_LANDING", "FORCE_LANDING", "ATTI_LANDING")

        /**
         * Si el dron dice que está aterrizando, con el modo de vuelo
         * (`KeyFlightMode`, su `name`) y `KeyIsInLandingMode`: true si cualquiera
         * de los dos lo dice, false si el modo es otro conocido, null si no
         * informa ninguno.
         */
        fun estaBajando(modoDeVuelo: String?, enModoDeAterrizaje: Boolean?): Boolean? = when {
            modoDeVuelo in MODOS_DE_ATERRIZAJE || enModoDeAterrizaje == true -> true
            modoDeVuelo != null && modoDeVuelo != "UNKNOWN" -> false
            else -> enModoDeAterrizaje
        }
    }
}
