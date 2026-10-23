package com.tesis.dronepatrol.drone

/**
 * El destino de [DroneController.volarHacia] en el dron real: el lazo de 10 Hz
 * lo relee en cada vuelta, igual que el seguimiento relee la estimación del
 * objetivo, así que cambiarlo no corta el vuelo. Es lo que necesita B en un
 * relevo (RELEVOS §3.4): la estimación del objetivo se corrige con cada
 * `relay_target` y el dron va hacia la última sin frenar ni relanzar nada.
 *
 * También decide cuándo avisar la llegada
 * ([com.tesis.dronepatrol.model.FlightEvent.GotoArrived]): una vez por destino.
 * Si llega otro pedido con el MISMO punto, ya está ahí y no se repite el aviso
 * —quien llama puede reenviar el destino sin saber si cambió—; si el punto se
 * corre después de llegar, vuelve a volar y avisa otra vez. Si el viento lo
 * saca del punto, vuelve sin avisar de nuevo: es la misma llegada.
 *
 * [cambiar] lo llama el hilo que comanda y [siguiente] el lazo: el destino es
 * un objeto entero y volátil para que el lazo nunca lea la latitud de uno y la
 * longitud de otro. [siguiente] lo llama un solo hilo (el lazo).
 */
class DestinoActualizable(lat: Double, lon: Double) {

    private data class Punto(val lat: Double, val lon: Double)

    /** Lo que el lazo tiene que hacer en esta vuelta. */
    sealed class Paso {
        /** Volar con estas velocidades (todavía no llegó). */
        data class Volar(val paso: Navegacion.Paso) : Paso()

        /** Acaba de llegar a este destino: avisar la llegada y quedar estacionario. */
        object Llego : Paso()

        /** Ya había llegado y avisado: seguir estacionario. */
        object Quieto : Paso()
    }

    @Volatile
    private var destino = Punto(lat, lon)

    private var avisadoEn: Punto? = null

    /** Nuevo destino, en el acto: la próxima vuelta del lazo ya vuela hacia él. */
    fun cambiar(lat: Double, lon: Double) {
        destino = Punto(lat, lon)
    }

    /** Qué hacer estando en ([aquiLat], [aquiLon]). */
    fun siguiente(aquiLat: Double, aquiLon: Double): Paso {
        val punto = destino
        val paso = Navegacion.hacia(aquiLat, aquiLon, punto.lat, punto.lon)
        if (!paso.llego) return Paso.Volar(paso)
        if (avisadoEn == punto) return Paso.Quieto
        avisadoEn = punto
        return Paso.Llego
    }
}
