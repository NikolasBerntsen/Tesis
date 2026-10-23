package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Vinculacion
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Abstracción del dron. La lógica de patrullaje (PatrolManager) habla solo con
 * esta interfaz; detrás puede estar el simulador (flavor mock) o el DJI Mini 4
 * Pro vía MSDK v5 (flavor dji).
 *
 * Las órdenes de los relevos, del desvío a otra base y del protocolo de última
 * ubicación (docs/RELEVOS.md) llegaron después y traen un cuerpo por defecto:
 * así los dobles de prueba y los dos controladores compilan desde el primer
 * día, y cada controlador las implementa de verdad a su turno. El cuerpo por
 * defecto es siempre el lado seguro: no hacer nada, o la orden de siempre que
 * más se le parece.
 */
interface DroneController {

    companion object {
        /**
         * Cuánto espera [capturarFoto] el próximo cuadro. El detector recibe dos
         * por segundo, así que en vuelo normal llega en medio segundo; más allá,
         * la cámara no está mandando y esperar más solo gasta la batería que el
         * protocolo de última ubicación está tratando de cuidar.
         */
        const val ESPERA_FOTO_MS = 2_000L
    }
    /**
     * Enlace, modelo, GPS, punto de retorno y si está en el aire. Es un
     * StateFlow y no un SharedFlow porque la pantalla necesita el valor actual
     * apenas se abre, no esperar al próximo cambio.
     */
    val estado: StateFlow<EstadoDelDron>

    /**
     * Telemetría a ~2 Hz. Si el enlace RC se corta, este flujo se silencia.
     *
     * [Telemetry.gimbalPitch] viene en NaN mientras el dron todavía no informó
     * su gimbal (el real, recién enlazado), igual que la posición sin fix: así el
     * status no le muestra a la consola una inclinación que nadie midió. Quien
     * la use tiene que mirarlo; PatrolManager proyecta las detecciones con la de
     * patrulla mientras tanto.
     */
    val telemetry: SharedFlow<Telemetry>

    /**
     * Cuadros JPEG del video del dron para el Comando Central: 640 px de ancho,
     * 5 por segundo ([CuadroDeVideo.INTERVALO_CUADRO_MS]), tanto con el dron
     * real como con el simulado. Es el video que mira el operador en la consola.
     */
    val videoFrames: SharedFlow<ByteArray>

    /**
     * Cuadros para el software de detección: más grandes
     * ([CuadroDeVideo.ANCHO_DETECCION] px de ancho) y más espaciados (uno cada
     * [CuadroDeVideo.INTERVALO_DETECCION_MS] como mucho, dos por segundo). Van
     * aparte del video de la consola porque detectar una persona desde 50 m
     * necesita resolución y no cuadros: a 640 px un peatón son diez pixeles.
     */
    val cuadrosParaDeteccion: SharedFlow<ByteArray>

    val flightEvents: SharedFlow<FlightEvent>

    fun connect()

    /**
     * Vuela la ruta en loop, empezando por el waypoint [fromWaypoint]. Es la
     * única orden que despega sola si el dron está en el suelo: emite
     * [FlightEvent.Despegando], sube a la altura del primer waypoint, emite
     * [FlightEvent.EnElAire] y recién ahí arranca la ruta. Las demás órdenes
     * con el dron en el suelo se rechazan con [FlightEvent.Problema].
     */
    fun startRoute(route: PatrolRoute, fromWaypoint: Int)

    /**
     * Orbita alrededor del punto dado con la nariz y la cámara apuntadas al
     * centro: es como el dron mantiene a la vista un objetivo quieto.
     *
     * Si YA está orbitando, solo corre el centro (y el radio) sin cortar el
     * giro: el objetivo estimado se va corrigiendo con cada detección y la
     * órbita lo acompaña sin dar saltos. Arranca desde el punto del círculo más
     * cercano a donde está el dron, no desde uno fijo. Con el dron en el suelo
     * se rechaza ([FlightEvent.Problema]).
     */
    fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double)

    /**
     * Sigue a un objetivo que se mueve: se mantiene a una distancia fija de él
     * (ver [Persecucion]), copiando su velocidad, con la nariz y el gimbal
     * apuntados a él. Se llama en cada estimación nueva del objetivo (a ~2 Hz);
     * si ya está siguiendo, solo actualiza el objetivo —entre una llamada y la
     * siguiente el controlador extrapola con la velocidad dada—. Con el dron en
     * el suelo se rechaza.
     */
    fun seguirObjetivo(lat: Double, lon: Double, vNorteMs: Double, vEsteMs: Double)

    /** Queda en vuelo estacionario donde está. */
    fun hold()

    /** Vuela hasta el punto dado y queda en vuelo estacionario al llegar (emite [FlightEvent.GotoArrived]). */
    fun gotoPoint(lat: Double, lon: Double)

    /**
     * Mando virtual del operador: cada eje va en [-1, 1], como una palanca
     * física, y los cuatro son **relativos al cuerpo del dron** —adelante es
     * hacia donde mira la cámara—, que es lo que el operador ve en el video.
     *
     * @param pitch +1 adelante (hacia la nariz), -1 atrás.
     * @param roll +1 a la derecha, -1 a la izquierda.
     * @param yaw +1 gira en sentido horario, -1 en sentido antihorario.
     * @param throttle +1 sube, -1 baja.
     *
     * Los cuatro en cero dejan al dron en vuelo estacionario. La escala a m/s y
     * grados/s la hace [MandoVirtual], igual para el simulador y para el DJI.
     * Manda siempre el último valor recibido y el dron lo sostiene hasta que
     * llegue otro: por eso la consola repite el mando a 10 Hz y por eso
     * PatrolManager tiene un watchdog que manda ceros si se corta.
     */
    fun manualStick(pitch: Double, roll: Double, yaw: Double, throttle: Double)

    /**
     * Inclina la cámara a [pitchGrados] en ángulo ABSOLUTO: 0 es el horizonte y
     * los negativos miran hacia abajo, hasta −90 (derecho al suelo). Es la orden
     * `manual_gimbal` de la consola (docs/PROTOCOLS.md §2), que PatrolManager
     * solo deja pasar con el control manual tomado y ya recortada al rango del
     * contrato.
     *
     * Vale en el suelo y en el aire, porque mover la cámara no mueve al dron, y
     * no cambia lo que el dron está haciendo. Los modos que apuntan la cámara por
     * su cuenta (la ruta, la órbita, el seguimiento) la vuelven a apuntar cuando
     * arrancan, y esa orden le llega al gimbal DESPUÉS de cualquier inclinación
     * de la consola que el controlador ya hubiera aceptado (ver
     * [cancelarInclinacionManual]). La inclinación en la que queda se lee en
     * [Telemetry.gimbalPitch]. Un rechazo del gimbal se avisa como
     * [FlightEvent.Problema]; no tira nada.
     *
     * El controlador puede no pasársela al gimbal en el acto: el real espera a
     * que el gimbal termine la anterior y, mientras tanto, se queda con la última.
     */
    fun inclinarCamara(pitchGrados: Double)

    /**
     * Tira la inclinación de la consola ([inclinarCamara]) que todavía no le
     * llegó al gimbal. La llama PatrolManager al salir de MANUAL, ANTES de darle
     * al dron la orden del estado siguiente: fuera de MANUAL la cámara no es del
     * operador, y una inclinación que llegara después pisaría la que pone la
     * ruta, la órbita o el seguimiento —en la ruta, para siempre: apunta una sola
     * vez—, o movería la cámara sin nadie al control.
     *
     * La que el gimbal ya está cumpliendo no se puede retirar, pero lo que se le
     * pida a la cámara después sale detrás de ella, nunca antes. No toca el vuelo
     * ni la cámara que apuntan los modos autónomos. Sin una inclinación esperando
     * no hace nada; un controlador que la aplica en el acto (el simulado) no
     * tiene nada que tirar.
     */
    fun cancelarInclinacionManual()

    /** Regreso a base del propio dron; al aterrizar emite [FlightEvent.ArrivedHome]. */
    fun returnHome()

    /** Aterriza donde está; al tocar el suelo emite [FlightEvent.Aterrizado]. */
    fun land()

    /**
     * Despegue automático EN EL LUGAR, para el control manual: el dron sube a la
     * altura del despegue del SDK (~1,2 m) y queda suspendido a la espera del
     * mando, sin ruta ni altura de trabajo. Emite [FlightEvent.Despegando] y,
     * ya en el aire, [FlightEvent.EnElAire]. No exige GPS (en interior el Mini
     * se sostiene con los sensores de visión); sí exige enlace con la aeronave.
     * En el aire no hace nada.
     */
    fun despegarEnElLugar()

    /**
     * Vincula por radio el control con la aeronave (el *linking* de DJI), para
     * cuando [EstadoDelDron.vinculacion] es [Vinculacion.SIN_VINCULAR]: el
     * control queda esperando y hay que mantener apretado el botón de encendido
     * de la aeronave hasta que pite. El avance se sigue en [estado]. Con el
     * simulado no hace nada: no tiene control físico.
     */
    fun vincularControl()

    /** Cancela una vinculación en curso. */
    fun cancelarVinculacion()

    fun disconnect()

    // ---- Relevos, desvío a otra base y última ubicación (docs/RELEVOS.md) ----

    /**
     * Despega y sube EN VERTICAL hasta [alturaM] metros sobre el punto de
     * despegue, y queda suspendido ahí. Es el despegue de B en un relevo
     * (RELEVOS §2.5 y §3.3): sube por su propia columna —las plataformas están
     * a 10 m una de otra— y recién arriba va a algún lado.
     *
     * Tiene que emitir [FlightEvent.Despegando] al arrancar y
     * [FlightEvent.EnElAire] al llegar a la altura. Si el despegue o la subida
     * fallan ya en el aire, avisa con [FlightEvent.Problema] y quien llama
     * aterriza (`land()`): nunca queda suspendido a media altura. En el aire no
     * hace nada.
     *
     * Real: `KeyStartTakeoff` y la subida con el mando virtual, sin componente
     * horizontal, hasta [alturaM] ± 1 m. Simulado: sube a su velocidad de
     * ascenso. Por defecto no hace nada: un controlador que no lo implementa no
     * despega para un relevo.
     */
    fun despegarHasta(alturaM: Double) {
        // Sin implementación no se despega para un relevo: es el lado seguro.
    }

    /**
     * Vuela hasta el punto dado A LA ALTURA EN QUE ESTÁ y queda en vuelo
     * estacionario al llegar, emitiendo [FlightEvent.GotoArrived]. Es la orden
     * de B hacia el objetivo de un relevo y la de un desvío hacia el punto de
     * aterrizaje de visitantes (RELEVOS §3.4 y §4), siempre después de subir a
     * la altura de tránsito: por eso no la cambia.
     *
     * Por defecto es [gotoPoint], que el real ya vuela a su altura actual. El
     * simulado lleva [gotoPoint] a su altura de crucero, así que tiene que
     * implementarla aparte para respetar la de tránsito. Con el dron en el
     * suelo se rechaza, igual que [gotoPoint].
     */
    fun volarHacia(lat: Double, lon: Double) = gotoPoint(lat, lon)

    /**
     * Gira EN EL LUGAR —sin desplazarse ni cambiar de altura— hasta que la nariz
     * apunte a [rumboGrados] (absoluto, 0..360) y queda estacionario. Es la
     * panorámica del protocolo de última ubicación (RELEVOS §5, paso 4): quien
     * llama espera que [Telemetry.heading] lo confirme (± 5°) antes de sacar la
     * foto.
     *
     * Real: guiñada con el mando virtual (solo con el mando virtual habilitado).
     * Simulado: gira a su velocidad de guiñada. Por defecto no hace nada, y la
     * panorámica sale con las fotos que se puedan.
     */
    fun girarEnElLugar(rumboGrados: Double) {
        // Sin implementación el dron no gira: la panorámica sale incompleta.
    }

    /**
     * Apunta la cámara a [pitchGrados] en ángulo ABSOLUTO (0 horizonte, −90
     * derecho al suelo) para un modo autónomo: las fotos del protocolo de
     * última ubicación (−90 la cenital, −30 la panorámica, RELEVOS §5). No es
     * una orden del operador como [inclinarCamara]: la pide la app, en
     * cualquier estado.
     *
     * Por defecto es [inclinarCamara]. El real la manda por la misma fila del
     * gimbal que el resto, así que sale después de cualquier inclinación que ya
     * se estaba cumpliendo y no la pisa una vieja, y la recorta a [−90, 0]
     * (para un modo autónomo, por arriba del horizonte no sirve); quien llama
     * espera que [Telemetry.gimbalPitch] la confirme (± 3°).
     */
    fun apuntarCamara(pitchGrados: Double) = inclinarCamara(pitchGrados)

    /**
     * Corta un regreso a base en curso —el que pidió la app con [returnHome] o
     * el que arrancó el propio DJI por batería— y deja al dron estacionario
     * donde está, listo para otra orden. Es el primer paso de un desvío a otra
     * base (RELEVOS §4).
     *
     * Real: `KeyStopGoHome` y esperar `GoHomeState = IDLE`, con un tope de 3 s;
     * si no se corta, lo avisa con [FlightEvent.Problema]. Es UN intento: si el
     * DJI vuelve a arrancar su regreso, se lo deja seguir y se avisa con
     * [FlightEvent.ElDronTomoElControl] (no se pelea en lazo con él).
     * Simulado: sale de su modo de regreso. Sin un regreso en curso no hace
     * nada. Por defecto no hace nada.
     */
    fun cancelarRegreso() {
        // Sin implementación el regreso sigue: volver a casa es el lado seguro.
    }

    /**
     * Fija el punto de retorno del dron en donde está ahora. Se llama al llegar
     * a la base de un desvío, antes de aterrizar (RELEVOS §4): así cualquier
     * regreso posterior —el del propio DJI incluido— vuelve acá y no a una base
     * que no alcanza.
     *
     * Real: `KeyHomeLocation` con la posición actual; un rechazo se avisa con
     * [FlightEvent.Problema] y queda registrado (el desvío sigue igual).
     * Simulado: mueve su base. El nuevo punto se ve en
     * [EstadoDelDron.puntoDeRetornoLat]/[EstadoDelDron.puntoDeRetornoLon]. Por
     * defecto no hace nada.
     */
    fun fijarPuntoDeRetornoAqui() {
        // Sin implementación el punto de retorno queda donde estaba.
    }

    /**
     * Prende o apaga el regreso inteligente por batería baja del propio DJI.
     * Durante un desvío se apaga (`false`): si no, el DJI arrancaría su regreso
     * hacia una casa que ya no alcanza (RELEVOS §4). Fuera de un desvío queda
     * prendido: es el respaldo del dron cuando la app no tiene autonomía
     * informada.
     *
     * Real: la llave de confirmación del regreso por batería baja del MSDK
     * (`KeyLowBatteryRTHConfirm`, ver RELEVOS §8). Simulado: lo anota y lo
     * respeta si modela un regreso propio. Por defecto no hace nada.
     */
    fun permitirRthPropioPorBateria(permitir: Boolean) {
        // Sin implementación el dron conserva su regreso propio, que es el respaldo.
    }

    /**
     * Qué hace el dron si se corta el enlace con el control: con `true`,
     * aterriza donde está (`KeyFailsafeAction = LANDING`); con `false`, vuelve
     * a su punto de retorno (el de fábrica). Se prende durante un desvío y en el
     * protocolo de última ubicación (RELEVOS §4 y §5): volver a una casa que no
     * se alcanza es peor que bajar donde está.
     *
     * Real: `KeyFailsafeAction`. Simulado: lo respeta al perder la señal. Por
     * defecto no hace nada.
     */
    fun fijarFailsafeAterrizar(activo: Boolean) {
        // Sin implementación queda el failsafe de fábrica (volver a casa).
    }

    /**
     * Una foto para el protocolo de última ubicación (RELEVOS §5): un JPEG de lo
     * que la cámara ve ahora, o null si no llegó ninguno en [ESPERA_FOTO_MS].
     * No toca la cámara ni el vuelo: quien llama la apunta antes
     * ([apuntarCamara], [girarEnElLugar]) y espera que la telemetría lo
     * confirme.
     *
     * Por defecto es el PRÓXIMO cuadro para la detección
     * ([cuadrosParaDeteccion], 1280 px), que es lo que el diseño pide: nunca uno
     * anterior a la llamada, que sería una foto con la cámara apuntada a otro
     * lado. Un controlador que saque fotos de verdad tiene que respetar el mismo
     * plazo.
     */
    suspend fun capturarFoto(): ByteArray? = withTimeoutOrNull(ESPERA_FOTO_MS) { cuadrosParaDeteccion.first() }
}
