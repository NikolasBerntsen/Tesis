package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import com.tesis.dronepatrol.model.Vinculacion
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Abstracción del dron. La lógica de patrullaje (PatrolManager) habla solo con
 * esta interfaz; detrás puede estar el simulador (flavor mock) o el DJI Mini 4
 * Pro vía MSDK v5 (flavor dji).
 */
interface DroneController {
    /**
     * Enlace, modelo, GPS, punto de retorno y si está en el aire. Es un
     * StateFlow y no un SharedFlow porque la pantalla necesita el valor actual
     * apenas se abre, no esperar al próximo cambio.
     */
    val estado: StateFlow<EstadoDelDron>

    /** Telemetría a ~2 Hz. Si el enlace RC se corta, este flujo se silencia. */
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
}
