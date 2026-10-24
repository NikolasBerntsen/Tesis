package com.tesis.dronepatrol.model

data class Waypoint(val lat: Double, val lon: Double, val alt: Double)

data class PatrolRoute(
    val id: Int,
    val name: String,
    val waypoints: List<Waypoint>,
)

data class Telemetry(
    /**
     * Posición del dron. **NaN sin fix GPS**: el MSDK no entrega posición sin
     * satélites (o entrega 0,0), y en interior la telemetría igual tiene que
     * salir —batería, altura, si vuela—, así que la falta de posición viaja como
     * NaN y no frena nada. Todo lo que use la posición mira [tienePosicion].
     */
    val lat: Double,
    val lon: Double,
    val altM: Double,
    val batteryPct: Double,
    /** Intensidad del enlace RC 0..100 (baja con la distancia a la base). */
    val signalPct: Int,
    /** Rumbo 0..360° de la nariz del dron. */
    val heading: Double,
    val ts: Long,
    /**
     * Inclinación del gimbal en grados: 0 es el horizonte, −90 es mirar derecho
     * al suelo. Hace falta para ubicar en el terreno lo que la cámara ve.
     */
    val gimbalPitch: Double = GIMBAL_PATRULLA,
    /**
     * Rumbo 0..360° hacia donde mira la CÁMARA. Es el de la nariz salvo que el
     * gimbal informe su propio rumbo absoluto (ver DjiDroneController): para
     * ubicar en el terreno lo que se ve, manda la cámara, no el fuselaje.
     */
    val rumboCamara: Double = heading,
    // Autonomía: lo que el dron calcula que le cuesta volver y aterrizar
    // (docs/RELEVOS.md §0, `status.autonomia` en docs/PROTOCOLS.md §1). NaN
    // mientras no se sepa —el simulado recién arrancado, el real antes de que
    // el SDK lo informe, o un cero del SDK con el dron lejos de casa, que no es
    // un dato—, y sin autonomía informada no hay desvío a otra base ni ventana
    // de gracia: el piso vuelve a ser el umbral fijo de batería. Van al final y
    // con valor por defecto para que los que arman la telemetría por posición
    // sigan compilando.
    /** Batería (%) que necesita para volver a su punto de retorno (`batteryPercentNeededToGoHome`). */
    val pctParaVolver: Double = Double.NaN,
    /** Batería (%) que necesita para aterrizar donde está (`batteryPercentNeededToLand`). */
    val pctParaAterrizar: Double = Double.NaN,
    /** Radio en metros que puede volar y todavía volver (`maxRadiusCanFlyAndGoHome`). */
    val alcanceM: Double = Double.NaN,
    /** Segundos que tarda en volver a su punto de retorno (`timeNeededToGoHome`). */
    val segundosParaVolver: Double = Double.NaN,
) {
    /** Hay una posición GPS real (no NaN). */
    val tienePosicion: Boolean get() = !lat.isNaN() && !lon.isNaN()

    companion object {
        /**
         * Inclinación de la cámara mientras patrulla: oblicua y hacia abajo, que
         * es la vista con la que se entrenó el detector y la que deja ver hacia
         * adelante sin perder lo que pasa debajo.
         */
        const val GIMBAL_PATRULLA = -70.0
    }
}

/**
 * Una detección tal como la contesta el software de detección (ver
 * docs/PROTOCOLS.md §4): qué vio, con cuánta certeza, dónde en el cuadro y la
 * captura anotada del cuadro exacto que la disparó.
 */
data class Deteccion(
    /** `PERSON` y/o `VEHICLE`. */
    val clases: List<String>,
    /** La confianza más alta entre las cajas, 0..1. */
    val confianza: Double,
    val cajas: List<Caja>,
    /** JPEG en base64 del cuadro anotado con las cajas; null si el detector no lo manda (el mock). */
    val snapshotBase64: String?,
    val ts: Long,
    /**
     * Hora de captura del cuadro analizado, con el reloj del teléfono (el `ts`
     * del `video_frame` que el detector devuelve tal cual). Con ella se busca la
     * pose del dron de ESE instante para georreferenciar; null si el detector no
     * la manda (versiones viejas, el mock).
     */
    val frameTs: Long? = null,
) {
    /** La caja más segura: es la que define el objetivo a orbitar. */
    val principal: Caja? get() = cajas.maxByOrNull { it.confianza }

    /** `VEHICLE` manda si aparece: es la alerta más urgente de las dos. */
    val tipoDeAlerta: String get() = if (clases.contains("VEHICLE")) "VEHICLE" else "PERSON"
}

/**
 * Una caja de detección en coordenadas normalizadas del cuadro (0..1, el
 * origen arriba a la izquierda), así vale igual sobre el cuadro de 1280 px
 * que analizó el detector y sobre el de 640 px que mira la consola.
 */
data class Caja(
    val clase: String,
    val confianza: Double,
    /** Centro de la caja. */
    val x: Double,
    val y: Double,
    val ancho: Double,
    val alto: Double,
)

/**
 * Vínculo por radio entre el control y la aeronave (lo que DJI llama *linking*).
 * Es independiente del cable USB: un control puede estar perfectamente
 * enchufado al teléfono —el SDK le lee hasta el número de serie— y no tener
 * ninguna aeronave vinculada; entonces no va a haber enlace nunca, por más que
 * el dron esté encendido al lado. Pasa con un control nuevo o que se usó con
 * otro dron, y la pantalla de conexión lo tiene que distinguir de "el dron está
 * apagado" para que el operador sepa qué hacer.
 */
enum class Vinculacion {
    /** El SDK todavía no lo informó, o el dron es simulado y no aplica. */
    DESCONOCIDA,
    /**
     * El control no está vinculando (`UNPAIRED` del SDK). Ojo: el RC-N3 lo
     * informa así AUNQUE tenga una aeronave vinculada y el enlace funcione
     * (comprobado con el Mini 4 Pro), así que por sí solo no dice que falte
     * vincular: solo cuenta si además no hay enlace con la aeronave.
     */
    SIN_VINCULAR,
    /** Vinculación en curso: el control espera que la aeronave responda. */
    VINCULANDO,
    VINCULADA,
    /** La vinculación se cortó o falló (modelos incompatibles, tiempo agotado). */
    FALLIDA,
}

/**
 * Lo que la app sabe del aparato más allá de la telemetría de vuelo: si hay
 * enlace con él, si está en el aire, si tiene GPS y punto de retorno. Con el
 * dron real lo arman el SDK y las llaves del controlador de vuelo; el simulado
 * lo inventa. Es lo que la pantalla de operación muestra arriba de todo y lo que
 * decide si se puede despegar.
 */
data class EstadoDelDron(
    /** El SDK está registrado y listo (con el simulado, siempre). */
    val sdkListo: Boolean,
    /** Hay enlace con la aeronave (control conectado al teléfono y dron prendido). */
    val conectado: Boolean,
    /** Nombre del modelo que informa el SDK; "Simulado" en el flavor mock. */
    val modelo: String,
    val enVuelo: Boolean,
    /** Satélites GPS en uso; menos de [SATELITES_MINIMOS] no alcanza para una ruta. */
    val satelites: Int,
    /** El dron registró su punto de retorno: sin él no hay regreso a base posible. */
    val baseFijada: Boolean,
    /** Qué falta o qué pasa, redactado para el operador; vacío si está todo bien. */
    val detalle: String = "",
    /** El control está enchufado al teléfono (el paso previo al enlace con la aeronave). */
    val controlConectado: Boolean = conectado,
    /** Número de serie de la aeronave, para identificar cuál es la que está enlazada. */
    val serie: String = "",
    /** Vínculo por radio entre el control y la aeronave (ver [Vinculacion]). */
    val vinculacion: Vinculacion = Vinculacion.DESCONOCIDA,
    /** Número de serie del control enchufado; si llega, el canal de datos con el control funciona. */
    val serieControl: String = "",
    /** Modo de vuelo que informa la aeronave (`P-GPS`, `ATTI`, …); vacío si no lo informa. */
    val modoDeVuelo: String = "",
    /**
     * Dónde quedó fijado el punto de retorno (`KeyHomeLocation`); NaN si no se
     * sabe. "Fuera de base" (docs/RELEVOS.md §0) se mide contra las bases Y
     * contra este punto: un dron que despegó en un lugar que no es una base
     * registrada no está perdido por aterrizar ahí.
     */
    val puntoDeRetornoLat: Double = Double.NaN,
    /** Longitud del punto de retorno; NaN si no se sabe (ver [puntoDeRetornoLat]). */
    val puntoDeRetornoLon: Double = Double.NaN,
    /**
     * Umbral de batería crítica del propio DJI
     * (`KeySeriousLowBatteryWarningThreshold`), en %; NaN si no se sabe. Por
     * debajo el dron aterriza donde esté por su cuenta, así que el protocolo de
     * última ubicación tiene que dispararse antes (RELEVOS §5).
     */
    val umbralCriticoPct: Double = Double.NaN,
) {
    /** Todo lo que hace falta para que la app ordene un despegue. */
    val listoParaDespegar: Boolean
        get() = sdkListo && conectado && baseFijada && satelites >= SATELITES_MINIMOS

    companion object {
        /** Con menos satélites el GPS del Mini 4 Pro no fija bien el punto de retorno. */
        const val SATELITES_MINIMOS = 8

        /** Punto de partida: nada conectado todavía. */
        val DESCONOCIDO = EstadoDelDron(
            sdkListo = false,
            conectado = false,
            modelo = "",
            enVuelo = false,
            satelites = 0,
            baseFijada = false,
            detalle = "Esperando al dron",
        )
    }
}

/**
 * El objetivo que el dron está orbitando o siguiendo, tal como viaja en el
 * `status` al Comando Central (docs/PROTOCOLS.md §1, `target`): es lo que la
 * consola pinta en el mapa y lo que el equipo de tierra necesita saber.
 */
data class ObjetivoReportado(
    /** Id de la alerta del objetivo; null hasta que llega el `alert_ack`. */
    val alertId: Long?,
    /** `PERSON` o `VEHICLE`. */
    val tipo: String,
    val lat: Double,
    val lon: Double,
    val velocidadMs: Double,
    val rumboGrados: Double,
    val enMovimiento: Boolean,
    val perdido: Boolean,
    val vistoHaceMs: Long,
    /** `PENDING` o `VALIDATED`. */
    val decision: String,
    /**
     * Componentes norte y este de la velocidad (m/s), `0` con el objetivo
     * quieto: con ellas B siembra su rastreador en un relevo (docs/PROTOCOLS.md
     * §1, `target.vNorteMs/vEsteMs`). NaN no las manda (son opcionales).
     */
    val vNorteMs: Double = Double.NaN,
    val vEsteMs: Double = Double.NaN,
)

data class DroneBase(val name: String, val lat: Double, val lon: Double)

/**
 * Ficha del dron. El [hash] es su identificador en todo el protocolo (el
 * `droneId` de los mensajes): sale del QR pegado en el dron, nunca lo declara
 * la app.
 */
data class DroneProfile(
    val hash: String,
    val displayName: String,
    val model: String = "",
    val base: DroneBase? = null,
)

/**
 * Sesión del operador de campo (POST /api/auth/login). Es efímera a propósito:
 * [expiresIn] son los segundos que le quedan, para la cuenta regresiva.
 */
data class SesionOperador(
    val username: String,
    val role: String,
    val expiresIn: Long,
)

/** Resultado de POST /api/drones/pair: el token de máquina del dron y su ficha. */
data class Emparejamiento(
    val token: String,
    val drone: DroneProfile,
)

enum class PatrolState {
    IDLE,
    PATROLLING,
    /** Orbitando el objetivo detectado, con la cámara apuntada al centro. */
    ORBITING,
    /** Siguiendo al objetivo detectado porque se está moviendo. */
    FOLLOWING,
    RETURNING_HOME_SIGNAL,
    RETURNING_HOME_BATTERY,
    LANDED,
    /** Patrulla interrumpida por el operador: vuelo estacionario. */
    PAUSED,
    /** Control manual desde el Comando Central. */
    MANUAL,
    /** Desvío forzado hacia un nodo puntual. */
    FORCED,
    /** Vuelve a la base por orden del operador de campo desde la app. */
    RETURNING_HOME,
    /**
     * B de un relevo de seguimiento: despegando o volando hacia el objetivo
     * que A le pasa (docs/RELEVOS.md §3). Es vuelo —valen los failsafes de
     * batería y señal— pero no alerta ni arranca seguimientos propios: solo
     * puede tomar el objetivo que vino a relevar.
     */
    RELEVANDO,
    /**
     * Protocolo de última ubicación (docs/RELEVOS.md §5): fotos del lugar y
     * aterrizaje donde está porque la batería ya no alcanza para ninguna base.
     * Es un regreso: los failsafes no lo pisan y no se alerta.
     */
    ATERRIZAJE_EMERGENCIA,
}

sealed class FlightEvent {
    /** El dron pasó por el waypoint [index] de la ruta activa. */
    data class WaypointReached(val index: Int) : FlightEvent()
    /** Terminó un regreso a base: el dron está en el suelo, en la base. */
    object ArrivedHome : FlightEvent()
    /** Llegó al punto pedido con gotoPoint y quedó en vuelo estacionario. */
    object GotoArrived : FlightEvent()

    /** Arrancó la secuencia de despegue (motores, salto a 1,2 m, subida a la altura de trabajo). */
    object Despegando : FlightEvent()

    /** El despegue terminó: el dron está a la altura de trabajo y empieza la orden que lo pidió. */
    object EnElAire : FlightEvent()

    /** Aterrizó donde estaba (orden de aterrizar, no un regreso a base). */
    object Aterrizado : FlightEvent()

    /**
     * El dron ACEPTÓ el aterrizaje que se le ordenó con `land()` y está bajando
     * donde está (real: el SDK contestó que sí a `KeyStartAutoLanding`, o el dron
     * ya estaba en modo aterrizaje; simulado: en el acto). Sale una vez por
     * orden. Existe porque mandar la orden no es que el dron la cumpla: en el
     * campo la consola mostraba "aterrizando" con el dron suspendido a medio
     * metro. Lo que no se pudo cumplir llega como un [Problema] que empieza con
     * [com.tesis.dronepatrol.drone.DroneController.NO_SE_PUDO_ATERRIZAR].
     */
    object AterrizajeAceptado : FlightEvent()

    /**
     * El dron —o su SDK— rechazó una orden. Existe porque un rechazo mudo es lo
     * peor que puede pasar en vuelo: el operador mueve la palanca, el dron no se
     * mueve y no hay una sola pista de por qué. PatrolManager lo reporta al
     * Comando Central para que quede en el registro de la salida.
     */
    data class Problema(val motivo: String) : FlightEvent()

    /**
     * Al final de un regreso a base, el dron empezó a DESCENDER sobre la base
     * (dron real: `KeyGoHomeStatus = LANDING`; simulado: el comienzo del
     * descenso del regreso). Es el aviso que dispara `landing_at_base` en un
     * relevo de patrulla (docs/RELEVOS.md §2.3): el relevo se ordena mientras A
     * baja, para no perder esos segundos.
     */
    object DescendiendoEnBase : FlightEvent()

    /**
     * El propio DJI le sacó el vuelo a la app con un failsafe suyo: un regreso
     * o un aterrizaje que nadie le pidió (docs/RELEVOS.md §4). La app no pelea
     * en lazo con él: lo registra, cede y decide desde ahí (un único intento de
     * cancelar un regreso propio durante un desvío; si vuelve a arrancar, se lo
     * deja seguir).
     */
    data class ElDronTomoElControl(val motivo: MotivoDelDron) : FlightEvent()
}

/** Por qué el propio DJI tomó el control (ver [FlightEvent.ElDronTomoElControl]). */
enum class MotivoDelDron(
    /** Cómo se dice en el registro, para el operador. */
    val descripcion: String,
) {
    /** Su regreso inteligente por batería baja. */
    RTH_BATERIA("regreso propio por batería baja"),

    /** Aterrizaje forzado por batería crítica, donde esté. */
    ATERRIZAJE_BATERIA_CRITICA("aterrizaje forzado por batería crítica"),

    /** Su failsafe por pérdida de señal con el control. */
    RTH_SENIAL("regreso propio por pérdida de señal"),

    /** Alguien apretó el botón de regreso del control físico. */
    RTH_DEL_CONTROL("regreso pedido desde el botón del control"),

    /** Cualquier otro motivo que el SDK informe (`FlightControlAuthorityChangeReason`). */
    OTRO("otro motivo del dron"),
}
