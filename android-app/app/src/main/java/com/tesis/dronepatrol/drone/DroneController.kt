package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.model.FlightEvent
import com.tesis.dronepatrol.model.PatrolRoute
import com.tesis.dronepatrol.model.Telemetry
import kotlinx.coroutines.flow.SharedFlow

/**
 * Abstracción del dron. La lógica de patrullaje (PatrolManager) habla solo con
 * esta interfaz; detrás puede estar el simulador (flavor mock) o el DJI Mini 4
 * Pro vía MSDK v5 (flavor dji).
 */
interface DroneController {
    /** Telemetría a ~2 Hz. Si el enlace RC se corta, este flujo se silencia. */
    val telemetry: SharedFlow<Telemetry>

    /**
     * Cuadros JPEG del video del dron: 5 por segundo
     * ([CuadroDeVideo.INTERVALO_CUADRO_MS]), tanto con el dron real como con el
     * simulado. Todo lo que sale por acá va al Comando Central; al software de
     * detección le llega uno cada 500 ms como techo —dos por segundo, el ritmo
     * que fija el contrato para el enlace más flojo— y de eso se encarga
     * PatrolManager.
     */
    val videoFrames: SharedFlow<ByteArray>

    val flightEvents: SharedFlow<FlightEvent>

    fun connect()

    /** Vuela la ruta en loop, empezando por el waypoint [fromWaypoint]. */
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

    fun returnHome()

    fun disconnect()
}
