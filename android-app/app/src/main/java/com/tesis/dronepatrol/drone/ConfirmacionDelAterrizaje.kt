package com.tesis.dronepatrol.drone

import kotlin.math.cos
import kotlin.math.sin

/**
 * La protección de aterrizaje del DJI vista desde la app (docs/RELEVOS.md §4):
 * cerca del suelo el Mini se frena y pide confirmar
 * (`KeyIsLandingConfirmationNeeded`) cuando abajo ve algo que no parece suelo
 * —agua, un techo, pasto alto—. Qué contestarle depende de dónde está bajando:
 *
 *  - **En un aterrizaje de siempre** que ordenó la app (la base, "aterrizar
 *    acá"), la app lo confirma: es su orden y el operador está mirando.
 *  - **En un desvío o en el protocolo de última ubicación** (la app tiene el
 *    failsafe en aterrizar, ver [Situacion.fueraDeBase]) el dron baja donde
 *    nadie revisó el lugar, así que NO se confirma solo: se corre
 *    [CORRIMIENTO_M] y lo vuelve a intentar, hasta [MAXIMO_CORRIMIENTOS] veces,
 *    y recién con la batería en el umbral crítico + [MARGEN_CRITICO_PCT] se
 *    confirma. Más abajo de eso el dron igual se va a caer: mejor que baje
 *    entero donde está.
 *  - **Un aterrizaje forzado por batería crítica** del propio DJI se confirma
 *    con la misma regla del crítico (la batería ya está ahí): sin confirmar, el
 *    dron se quedaba suspendido a medio metro hasta agotarse. No se corre: el
 *    vuelo es del DJI y la app no lo comanda.
 *  - El resto (el operador aterrizando con las palancas) no es de la app.
 *
 * Decide una sola vez por pedido: el SDK repite el estado, y el aterrizaje no
 * se confirma dos veces ni se arranca un corrimiento encima de otro. Mientras el
 * pedido sigue en pie, cada lectura nueva de la batería se vuelve a mirar
 * ([alActualizar]): es así como llega el momento de confirmar.
 *
 * Con un aterrizaje de la app en curso el pedido no se espera: la secuencia del
 * aterrizaje lo LEE cada medio segundo ([alLeer]). Así se contesta también el
 * que ya estaba en pie cuando llegó la orden —un aterrizaje anterior cortado a
 * medio metro, el operador que lo bajó con las palancas—, que el oyente del SDK
 * no vuelve a contar porque no cambió; y una confirmación que el dron no tomó
 * (sigue pidiendo) se repite cada [REPETIR_CONFIRMACION_MS]. Las dos cosas
 * dejaban al Mini suspendido a medio metro para siempre.
 *
 * Vive en `main` y no en el controlador real, que solo compila con el MSDK y no
 * se puede probar sin dron.
 *
 * @param reloj la hora con la que se cuenta el reintento de la confirmación.
 */
class ConfirmacionDelAterrizaje(private val reloj: () -> Long = System::currentTimeMillis) {

    /** Qué hacer con el pedido de confirmación. */
    enum class Accion {
        /** Nada: no es de la app, o ya se hizo lo que correspondía. */
        NADA,

        /** Confirmar el aterrizaje (`KeyConfirmLanding`). */
        CONFIRMAR,

        /** Correrse [CORRIMIENTO_M] y volver a aterrizar; al terminar, [alTerminarDeCorrerse]. */
        CORRERSE,

        /** No confirmar todavía: esperar a que la batería llegue al crítico. */
        ESPERAR,
    }

    /** Lo que importa para decidir, leído en el momento. */
    data class Situacion(
        /** La app ordenó el aterrizaje en curso (aterrizar acá o volver a la base). */
        val ordenadoPorLaApp: Boolean,
        /** Desvío o protocolo de última ubicación en curso: la app tiene el failsafe en aterrizar. */
        val fueraDeBase: Boolean,
        /** El propio DJI está aterrizando por batería crítica. */
        val forzadoPorBateria: Boolean,
        val bateriaPct: Double,
        /** El umbral crítico del propio DJI; NaN si no lo informó. */
        val umbralCriticoPct: Double,
    )

    private var pendiente = false
    private var resuelto = false
    private var corriendose = false
    private var corrimientos = 0

    /** Cuándo se decidió confirmar este pedido por última vez; con él se repite la confirmación. */
    private var confirmadoMs = 0L

    /** Ya se dijo que este pedido espera al crítico: [alLeer], que pregunta dos veces por segundo, no lo repite. */
    private var esperaAvisada = false

    /** El dron pide (true) o deja de pedir (false) que se confirme el aterrizaje. */
    @Synchronized
    fun alPedir(pide: Boolean, situacion: Situacion): Accion {
        if (!pide) {
            pendiente = false
            resuelto = false
            esperaAvisada = false
            return Accion.NADA
        }
        pendiente = true
        return decidir(situacion)
    }

    /** Otra lectura (la batería que baja) con el pedido en pie: puede ser el momento de confirmar. */
    @Synchronized
    fun alActualizar(situacion: Situacion): Accion = if (pendiente) decidir(situacion) else Accion.NADA

    /**
     * Lo que se LEYÓ del dron en la secuencia de un aterrizaje (ver la clase):
     * sin pedido es [alPedir] con false; con pedido se decide como siempre, haya
     * cambiado o no. Una confirmación que el dron no tomó —sigue pidiendo
     * pasados [REPETIR_CONFIRMACION_MS]— vuelve a salir; un corrimiento no se
     * repite (lo cierra [alTerminarDeCorrerse]) y la espera del crítico se dice
     * una sola vez por pedido.
     */
    @Synchronized
    fun alLeer(pide: Boolean, situacion: Situacion): Accion {
        if (!pide) return alPedir(false, situacion)
        pendiente = true
        // Solo una confirmación resuelve un pedido: si sigue en pie, no llegó.
        if (resuelto && reloj() - confirmadoMs >= REPETIR_CONFIRMACION_MS) resuelto = false
        val accion = decidir(situacion)
        if (accion != Accion.ESPERAR) return accion
        if (esperaAvisada) return Accion.NADA
        esperaAvisada = true
        return accion
    }

    /** Terminó de correrse (o se cortó el corrimiento): lo que el dron pida desde acá es otro intento. */
    @Synchronized
    fun alTerminarDeCorrerse() {
        corriendose = false
    }

    /** En el suelo (o un vuelo nuevo): la cuenta arranca de cero. */
    @Synchronized
    fun reiniciar() {
        pendiente = false
        resuelto = false
        corriendose = false
        corrimientos = 0
        esperaAvisada = false
    }

    private fun decidir(s: Situacion): Accion {
        if (resuelto || corriendose) return Accion.NADA
        val accion = when {
            s.fueraDeBase || s.forzadoPorBateria -> when {
                bateriaCritica(s) -> Accion.CONFIRMAR
                s.ordenadoPorLaApp && !s.forzadoPorBateria && corrimientos < MAXIMO_CORRIMIENTOS -> Accion.CORRERSE
                else -> Accion.ESPERAR
            }
            s.ordenadoPorLaApp -> Accion.CONFIRMAR
            else -> Accion.NADA
        }
        when (accion) {
            Accion.CONFIRMAR -> {
                resuelto = true
                confirmadoMs = reloj()
            }
            Accion.CORRERSE -> {
                corriendose = true
                corrimientos++
            }
            // Esperar no resuelve: la próxima lectura de batería vuelve a mirar.
            Accion.ESPERAR, Accion.NADA -> Unit
        }
        return accion
    }

    /** La batería en el crítico + 1. Sin el umbral del DJI, el de fábrica del Mini 4 Pro. */
    private fun bateriaCritica(s: Situacion): Boolean {
        val umbral = if (s.umbralCriticoPct.isFinite()) s.umbralCriticoPct else UMBRAL_CRITICO_DE_FABRICA_PCT
        return s.bateriaPct.isFinite() && s.bateriaPct <= umbral + MARGEN_CRITICO_PCT
    }

    companion object {
        /** Cuánto se corre antes de volver a intentar (RELEVOS §4). */
        const val CORRIMIENTO_M = 10.0

        /** Cuántas veces se corre antes de esperar al crítico. */
        const val MAXIMO_CORRIMIENTOS = 2

        /** Se confirma con la batería en el umbral crítico más esto. */
        const val MARGEN_CRITICO_PCT = 1.0

        /** El umbral crítico de fábrica del Mini 4 Pro, para cuando el DJI no informa el suyo. */
        const val UMBRAL_CRITICO_DE_FABRICA_PCT = 10.0

        /**
         * Cada cuánto se repite una confirmación que el dron no tomó ([alLeer]):
         * el doble de lo que tarda en contestar y volver a informar, para no
         * mandarle la segunda encima de la primera.
         */
        const val REPETIR_CONFIRMACION_MS = 2_000L

        /**
         * A dónde correrse: [metros] hacia donde apunta la nariz. Adelante es
         * donde miran la cámara y los sensores de obstáculos principales, y lo
         * que ve la cámara es lo que el operador puede revisar en el video.
         *
         * @return latitud y longitud del punto, o null si la posición o el rumbo no tienen sentido.
         */
        fun puntoCorrido(lat: Double, lon: Double, rumboGrados: Double, metros: Double = CORRIMIENTO_M): Pair<Double, Double>? {
            if (!Geo.esPosicionValida(lat, lon) || !rumboGrados.isFinite() || !metros.isFinite()) return null
            val rumbo = Math.toRadians(rumboGrados)
            val norte = metros * cos(rumbo)
            val este = metros * sin(rumbo)
            return (lat + norte / Geo.METROS_POR_GRADO_LAT) to (lon + este / Geo.metrosPorGradoLon(lat))
        }
    }
}
