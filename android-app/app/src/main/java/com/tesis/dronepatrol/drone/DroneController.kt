package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.EstadoDelDron
import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
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

    /** Orbita alrededor del punto dado (modo seguimiento de objetivo). */
    fun startOrbit(centerLat: Double, centerLon: Double, radiusM: Double)

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

    fun disconnect()
}
