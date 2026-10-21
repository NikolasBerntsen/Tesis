package com.tesis.dronepatrol.drone

/**
 * Traducción de lo que la app quiere ("andá hacia el norte a 3 m/s", "adelante
 * a 2 m/s") a los cuatro números que el Virtual Stick avanzado del MSDK v5
 * acepta en modo VELOCITY. Vive en `main`, sin tocar el SDK, por una razón
 * concreta: **en el MSDK los nombres están cruzados respecto de lo intuitivo y
 * no hay forma de probarlo sin dron**, así que la cuenta tiene que quedar en un
 * lugar que CI compile y pruebe.
 *
 * La tabla oficial (MSDK v5 → Basic concepts → Flight Controller → Virtual
 * Stick, "Roll Pitch Control Mode") dice, para `RollPitchControlMode.VELOCITY`:
 *
 * | Coordenadas | Rumbo del dron | pitch (+) | pitch (−) | roll (+) | roll (−) |
 * |---|---|---|---|---|---|
 * | GROUND | norte | va al **este**  | va al oeste | va al **norte** | va al sur |
 * | GROUND | este  | va al **este**  | va al oeste | va al **norte** | va al sur |
 * | BODY   | norte | va al este      | va al oeste | va al norte     | va al sur |
 * | BODY   | este  | va al **sur**   | va al norte | va al **este**  | va al oeste |
 *
 * O sea: en VELOCITY, **`roll` es la velocidad sobre el eje X (norte en GROUND,
 * hacia la nariz en BODY) y `pitch` la del eje Y (este en GROUND, hacia la
 * derecha en BODY)**. Con el rumbo al este en BODY, "pitch +" lleva al sur, que
 * es la derecha del dron: la fila lo confirma. Es exactamente al revés de lo que
 * sugieren los nombres, y mandarlo al revés gira cada orden 90°.
 *
 * El eje vertical en VELOCITY es siempre relativo a la aeronave: positivo sube,
 * sin importar el marco de coordenadas. El yaw en ANGLE es un rumbo absoluto
 * (grados, norte = 0) y en ANGULAR_VELOCITY una velocidad de giro en grados por
 * segundo, horario positivo.
 */
object OrdenVirtualStick {

    /**
     * Los cuatro campos de `VirtualStickFlightControlParam`, ya con la
     * semántica del SDK. Se llaman como en el SDK a propósito: el controlador
     * los pasa en orden y sin pensar, porque el pensar se hizo acá.
     */
    data class Parametros(
        val pitch: Double,
        val roll: Double,
        val yaw: Double,
        val verticalThrottle: Double,
    )

    /**
     * Orden en el marco del terreno (`FlightCoordinateSystem.GROUND`, yaw en
     * `YawControlMode.ANGLE`): lo que usan los modos autónomos, donde el
     * objetivo está en coordenadas y no relativo al dron.
     *
     * @param vNorteMs velocidad hacia el norte en m/s (negativa: sur).
     * @param vEsteMs velocidad hacia el este en m/s (negativa: oeste).
     * @param rumboGrados rumbo al que apuntar la nariz, 0..360 (norte = 0).
     * @param vSubidaMs velocidad vertical en m/s, positiva sube.
     */
    fun terreno(vNorteMs: Double, vEsteMs: Double, rumboGrados: Double, vSubidaMs: Double) = Parametros(
        pitch = vEsteMs,
        roll = vNorteMs,
        yaw = rumboAngulo(rumboGrados),
        verticalThrottle = vSubidaMs,
    )

    /**
     * Orden relativa al cuerpo del dron (`FlightCoordinateSystem.BODY`, yaw en
     * `YawControlMode.ANGULAR_VELOCITY`): el mando virtual del operador, que
     * ve el video y piensa en "adelante" y "derecha".
     */
    fun cuerpo(v: MandoVirtual.VelocidadesCuerpo) = Parametros(
        pitch = v.derechaMs,
        roll = v.adelanteMs,
        yaw = v.giroGradosS,
        verticalThrottle = v.subidaMs,
    )

    /**
     * El SDK toma el ángulo de yaw en −180..180 (positivo hacia el este). El
     * resto del sistema maneja rumbos en 0..360, así que acá se pliega: 270°
     * pasa a ser −90°.
     */
    fun rumboAngulo(rumboGrados: Double): Double {
        val plegado = ((rumboGrados % 360.0) + 360.0) % 360.0
        return if (plegado > 180.0) plegado - 360.0 else plegado
    }
}
