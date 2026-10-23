package com.tesis.dronepatrol.patrol

import com.tesis.dronepatrol.drone.DroneController
import com.tesis.dronepatrol.model.Telemetry
import kotlin.math.abs
import kotlinx.coroutines.delay

/**
 * La secuencia del protocolo de última ubicación (docs/RELEVOS.md §5): el dron
 * ya no llega a ninguna base y va a aterrizar donde está, así que antes deja
 * fotos del lugar para que el equipo de tierra lo encuentre.
 *
 * Con control de vuelo ([conControl]), con un tope duro de [TOPE_MS]:
 *  1. vuelo estacionario y failsafe "aterrizar" (si se corta el enlace, baja
 *     donde está en vez de volver a una casa que no alcanza);
 *  2. foto oblicua, con la inclinación de patrulla;
 *  3. foto cenital, la cámara a −90°;
 *  4. la cámara a −30° y una foto a 0°, 90°, 180° y 270° girando en el lugar
 *     (solo si se puede girar: con el mando virtual del lado de la app). Un
 *     giro que la telemetría no confirma es un mando virtual que no está —el
 *     DJI todavía volviendo a casa, por ejemplo—: la panorámica se deja ahí y
 *     no se gastan otros 4 s por rumbo con la batería en el crítico;
 *  5. aterrizar.
 *
 * Cada paso arranca solo si después queda batería ([alcanzaParaOtroPaso]); si
 * no, aterriza enseguida. Cada paso espera que la telemetría confirme el rumbo
 * (± [TOLERANCIA_RUMBO_GRADOS]) y la inclinación (± [TOLERANCIA_INCLINACION_GRADOS])
 * y recién ahí cuenta [ASENTAR_MS] antes de la foto; un paso que no se confirma
 * en [CONFIRMACION_MAXIMA_MS] sale sin foto. Antes de cada orden vuelve a mirar
 * que el patrullaje siga en el protocolo ([sigue]): el Job lo cancela quien
 * cambia de estado, y aun así una orden no puede salir un instante tarde.
 *
 * Sin control de vuelo ([soloCamara], el propio DJI forzó el aterrizaje): solo
 * la cámara, −90° y después −30°, una foto en cada uno, mientras baja.
 *
 * Las fotos van numeradas por su lugar en la secuencia (0 la oblicua, 1 la
 * cenital, 2 a 5 la panorámica), así la consola sabe qué es cada una aunque
 * falte alguna.
 *
 * El tiempo lo dan [reloj] y [pausa], para probar la secuencia entera sin
 * esperar sus 20 segundos. Las órdenes salen por [ordenar], que las da solo si
 * el protocolo sigue en curso: PatrolManager lo hace bajo la misma puerta que
 * cambia el estado, así una persona que toma el control en el medio no recibe
 * un `land()` un instante después.
 */
class SecuenciaDeUltimaUbicacion(
    private val dron: DroneController,
    private val telemetria: () -> Telemetry?,
    private val sigue: () -> Boolean,
    private val alcanzaParaOtroPaso: () -> Boolean,
    private val alFotografiar: (Foto) -> Unit,
    private val reloj: () -> Long,
    private val pausa: suspend (Long) -> Unit = { delay(it) },
    private val ordenar: (DroneController.() -> Unit) -> Boolean = { orden ->
        val puede = sigue()
        if (puede) dron.orden()
        puede
    },
) {
    companion object {
        const val TOPE_MS = 20_000L
        const val ASENTAR_MS = 1_500L
        const val CONFIRMACION_MAXIMA_MS = 4_000L
        const val TOLERANCIA_RUMBO_GRADOS = 5.0
        const val TOLERANCIA_INCLINACION_GRADOS = 3.0
        const val REVISION_MS = 100L
        const val CENITAL = -90.0
        const val PANORAMICA = -30.0
        val RUMBOS_PANORAMICA = listOf(0.0, 90.0, 180.0, 270.0)
    }

    /** Una foto ya sacada, con la pose del instante. */
    class Foto(
        val seq: Int,
        /** `oblicua`, `cenital` o `panoramica`. */
        val tipo: String,
        val rumbo: Double,
        val inclinacion: Double,
        val jpeg: ByteArray,
        val telemetria: Telemetry?,
    )

    /** Cómo terminó: con el aterrizaje ordenado, o cortada porque el patrullaje salió del protocolo. */
    enum class Final { ATERRIZO, CORTADA }

    private var inicioMs = 0L

    /**
     * [puedeGirar] se pregunta antes de cada paso de la panorámica y no una
     * sola vez al arrancar: lo que dice si el mando virtual está del lado de la
     * app (que el DJI no haya vuelto a tomar el vuelo, que el corte de su
     * regreso no haya fallado) puede cambiar en el medio de la secuencia.
     */
    suspend fun conControl(puedeGirar: () -> Boolean): Final {
        inicioMs = reloj()
        val quieto = ordenar {
            hold()
            fijarFailsafeAterrizar(true)
        }
        if (!quieto) return Final.CORTADA
        val pasos = buildList {
            add(Paso(0, "oblicua", Telemetry.GIMBAL_PATRULLA, null))
            add(Paso(1, "cenital", CENITAL, null))
            RUMBOS_PANORAMICA.forEachIndexed { i, r -> add(Paso(2 + i, "panoramica", PANORAMICA, r)) }
        }
        for (p in pasos) {
            if (!sigue()) return Final.CORTADA
            if (reloj() - inicioMs >= TOPE_MS || !alcanzaParaOtroPaso()) break
            if (p.rumbo != null && !puedeGirar()) break
            val girado = fotografiar(p)
            // Sin giro no hay panorámica: los rumbos que faltan tampoco van a salir.
            if (!girado) break
        }
        return if (ordenar { land() }) Final.ATERRIZO else Final.CORTADA
    }

    /** El DJI ya está bajando por su cuenta: solo la cámara, sin una sola orden de vuelo. */
    suspend fun soloCamara(): Final {
        inicioMs = reloj()
        for (p in listOf(Paso(0, "cenital", CENITAL, null), Paso(1, "panoramica", PANORAMICA, null))) {
            if (!sigue()) return Final.CORTADA
            if (reloj() - inicioMs >= TOPE_MS) break
            fotografiar(p)
        }
        return if (sigue()) Final.ATERRIZO else Final.CORTADA
    }

    private class Paso(val seq: Int, val tipo: String, val inclinacion: Double, val rumbo: Double?)

    /**
     * Apunta, espera la confirmación, asienta y saca la foto del paso [p].
     * Devuelve false solo si el paso pedía un giro y la telemetría nunca
     * mostró el rumbo: el dron no está girando. Una cámara que no confirma o una
     * foto que no llega dejan el paso sin foto, pero no dicen nada del giro.
     */
    private suspend fun fotografiar(p: Paso): Boolean {
        val apuntada = ordenar {
            apuntarCamara(p.inclinacion)
            p.rumbo?.let { girarEnElLugar(it) }
        }
        if (!apuntada) return true
        val limite = minOf(reloj() + CONFIRMACION_MAXIMA_MS, inicioMs + TOPE_MS)
        if (!esperar(limite) { confirmado(p) }) return rumboConfirmado(p)
        // Confirmado: recién ahí cuenta el asentamiento, para que la foto no salga movida.
        esperar(minOf(reloj() + ASENTAR_MS, inicioMs + TOPE_MS)) { false }
        if (!sigue()) return true
        val jpeg = dron.capturarFoto() ?: return true
        val t = telemetria()
        alFotografiar(
            Foto(
                seq = p.seq,
                tipo = p.tipo,
                rumbo = t?.rumboCamara?.takeIf { it.isFinite() } ?: p.rumbo ?: 0.0,
                inclinacion = t?.gimbalPitch?.takeIf { it.isFinite() } ?: p.inclinacion,
                jpeg = jpeg,
                telemetria = t,
            ),
        )
        return true
    }

    private fun confirmado(p: Paso): Boolean {
        val t = telemetria() ?: return false
        val inclinacionOk = t.gimbalPitch.isFinite() && abs(t.gimbalPitch - p.inclinacion) <= TOLERANCIA_INCLINACION_GRADOS
        return inclinacionOk && rumboConfirmado(p)
    }

    /** El paso no pedía giro, o la telemetría ya muestra la nariz en su rumbo. */
    private fun rumboConfirmado(p: Paso): Boolean {
        val rumbo = p.rumbo ?: return true
        val t = telemetria() ?: return false
        return t.heading.isFinite() && diferenciaDeRumbo(t.heading, rumbo) <= TOLERANCIA_RUMBO_GRADOS
    }

    /** Espera [condicion] hasta [limiteMs]; false si no se cumplió (o el protocolo se cortó). */
    private suspend fun esperar(limiteMs: Long, condicion: () -> Boolean): Boolean {
        while (true) {
            if (condicion()) return true
            if (reloj() >= limiteMs || !sigue()) return false
            pausa(REVISION_MS)
        }
    }
}

/**
 * La última posición de un aterrizaje de emergencia, fija en la pantalla del
 * teléfono (RELEVOS §5): es lo que el equipo de tierra necesita para ir a
 * buscar el dron, aunque el Comando Central no esté. [aterrizado] false es la
 * posición donde empezó a bajar.
 */
data class UbicacionFijada(val lat: Double, val lon: Double, val altM: Double, val aterrizado: Boolean)

/** Diferencia entre dos rumbos en grados, por el lado corto (0..180). */
internal fun diferenciaDeRumbo(a: Double, b: Double): Double {
    val d = abs(((a - b) % 360.0 + 360.0) % 360.0)
    return if (d > 180.0) 360.0 - d else d
}
