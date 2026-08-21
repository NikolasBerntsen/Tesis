# Modelo de datos y arquitectura

Los tres diagramas de este documento describen el sistema desde tres ángulos:
qué se guarda (entidad-relación), cómo está armado el software que vuela el dron
(clases) y qué piezas se hablan entre sí (componentes).

Están escritos en Mermaid, así que GitHub los dibuja solo al abrir el archivo y
se pueden exportar como imagen sin herramientas aparte.

---

## 1. Diagrama entidad-relación

El almacenamiento es una única base SQLite (`backend/src/db.ts`). Siete tablas y
una estructura embebida.

Dos cosas para leer el diagrama:

- **Línea llena**: clave foránea declarada en el esquema.
- **Línea punteada**: referencia lógica, resuelta en el código y no por el motor.
  Son deliberadas: `alerts.drone_id` y `events.drone_id` guardan el `hash` del
  dron y no su `id`, porque el hash es el identificador del dron en todo el
  protocolo y sobrevive a la baja lógica del activo. El historial tiene que
  seguir resolviendo aunque el dron ya no exista.

```mermaid
erDiagram
    users {
        INTEGER id PK
        TEXT username UK "sigue ocupado después de la baja lógica"
        TEXT password_hash "bcrypt de costo 10; nunca sale del backend"
        TEXT role "field_operator, operator, supervisor o admin"
        TEXT full_name
        TEXT display_name
        INTEGER active "0 desactiva la cuenta sin borrarla"
        INTEGER can_control "permiso de control manual"
        INTEGER deleted "marca de baja lógica: es lo que consulta el código"
        TEXT deleted_at "cuándo se dio de baja; dato de auditoría"
        TEXT deleted_by
    }

    drones {
        INTEGER id PK
        TEXT hash UK "32 hexadecimales; contenido del QR e identificador del protocolo"
        TEXT display_name
        TEXT model
        TEXT inventory_code "no viaja dentro del QR"
        INTEGER active
        INTEGER base_id FK "base donde está dispuesto el dron"
        TEXT created_at
        TEXT created_by
        INTEGER deleted "marca de baja lógica: es lo que consulta el código"
        TEXT deleted_at "cuándo se dio de baja; dato de auditoría"
        TEXT deleted_by
    }

    bases {
        INTEGER id PK
        TEXT name
        REAL lat
        REAL lon
        INTEGER active
        TEXT created_at
        TEXT created_by
        INTEGER deleted "marca de baja lógica: es lo que consulta el código"
        TEXT deleted_at "cuándo se dio de baja; dato de auditoría"
        TEXT deleted_by
    }

    patrol_routes {
        INTEGER id PK
        TEXT name
        TEXT description
        TEXT waypoints "JSON con los nodos del recorrido"
        TEXT created_at
        TEXT created_by
        INTEGER deleted "marca de baja lógica: es lo que consulta el código"
        TEXT deleted_at "cuándo se dio de baja; dato de auditoría"
        TEXT deleted_by
    }

    base_routes {
        INTEGER base_id PK, FK "parte de la clave compuesta"
        INTEGER route_id PK, FK "parte de la clave compuesta"
    }

    waypoint {
        REAL lat "embebido en patrol_routes.waypoints"
        REAL lon
        REAL alt "altura sobre el suelo, 40 m por defecto"
        TEXT label "apodo opcional del nodo"
    }

    alerts {
        INTEGER id PK
        TEXT created_at
        TEXT type "PERSON o VEHICLE"
        TEXT status "PENDING, VALIDATED o DISMISSED"
        TEXT drone_id "hash del dron que la disparó"
        REAL lat
        REAL lon
        TEXT snapshot "JPEG en base64 del cuadro que disparó la detección"
        TEXT decided_by "username de quien validó o descartó"
        TEXT decided_at
    }

    events {
        INTEGER id PK
        TEXT ts
        TEXT type
        TEXT source "username, hash del dron o backend"
        TEXT message "texto legible para el operador"
        TEXT drone_id "hash del dron al que refiere"
        INTEGER alert_id "alerta que originó el evento"
        TEXT category "drone, usuarios o sistema"
        TEXT meta "JSON libre; en los cambios lleva el antes y el después"
    }

    bases       |o--o{ drones      : "aloja"
    bases       ||--o{ base_routes : "habilita"
    patrol_routes ||--o{ base_routes : "se asigna a"
    patrol_routes ||--|{ waypoint   : "contiene"
    drones      |o..o{ alerts       : "dispara (drone_id = hash)"
    drones      |o..o{ events       : "protagoniza (drone_id = hash)"
    alerts      |o..o{ events       : "documenta (alert_id)"
    users       |o..o{ alerts       : "decide (decided_by)"
    users       |o..o{ events       : "origina (source)"
```

### Referencias de auditoría

Además de las relaciones del diagrama, cinco columnas guardan el `username` de
quien hizo cada cosa. No son claves foráneas a propósito: la cuenta puede darse
de baja y el registro tiene que seguir diciendo quién fue.

| Tabla | Columnas | Apunta a |
|---|---|---|
| `drones`, `bases`, `patrol_routes` | `created_by`, `deleted_by` | `users.username` |
| `users` | `deleted_by` | `users.username` |
| `alerts` | `decided_by` | `users.username` |
| `events` | `source` | `users.username`, `drones.hash` o el literal `backend` |

### Decisiones que explican la forma del modelo

- **El dron es un activo, no una cuenta.** Nació como una fila de `users` con
  rol `drone` y se promovió a tabla propia. La migración reapunta todo el
  historial del username viejo al hash nuevo, para no perder trazabilidad.
- **La base es una entidad, no una columna.** Vivía embebida en cada dron, con
  el nombre y la coordenada copiados fila por fila. La migración las promovió a
  `bases`, agrupando por coordenada para que los drones que compartían base
  terminen apuntando a una sola, y después borró las columnas: hoy el único
  vínculo es `drones.base_id`.
- **`base_routes` es una relación de muchos a muchos.** Una base puede tener
  varias rutas y una ruta puede servir a varias bases: el operador elige, entre
  las de su base, cuál patrullar.
- **Todo el borrado es lógico, y la baja es una marca propia.** Ninguna baja
  borra la fila: se prende `deleted` y se anotan `deleted_at` y `deleted_by`. La
  consulta va siempre contra la marca y nunca contra la fecha —la fecha es el
  dato de auditoría, no el interruptor—, así que una fila con la fecha en blanco
  por un error de escritura no puede pasar por viva ni al revés. Por eso también
  el `UNIQUE` de `username` se mantiene después de la baja.
- **Renombrar una base se ve en el acto en todos sus drones**, justamente
  porque el dato vive en un solo lugar y no hay copias que sincronizar.
- **Los nodos de una ruta van embebidos.** Se leen y se escriben siempre
  completos, con la ruta, y nunca se consultan por separado. Una tabla aparte
  agregaría un join a cada lectura sin habilitar ninguna consulta que el sistema
  necesite.

---

## 2. Diagrama de clases — app de control

La app Android es la parte del sistema con una estructura de clases propiamente
dicha. El `PatrolManager` es el cerebro: sostiene la máquina de estados, los
watchdogs y los dos failsafes, y habla con el aparato únicamente a través de la
interfaz `DroneController`. Esa abstracción es la que permite cambiar de
fabricante sin tocar la lógica de vuelo.

```mermaid
classDiagram
    direction TB

    class DroneController {
        <<interface>>
        +SharedFlow~Telemetry~ telemetry
        +SharedFlow~ByteArray~ videoFrames
        +SharedFlow~FlightEvent~ flightEvents
        +connect()
        +startRoute(route, fromWaypoint)
        +startOrbit(centerLat, centerLon, radiusM)
        +hold()
        +gotoPoint(lat, lon)
        +returnHome()
        +disconnect()
    }

    class DjiDroneController {
        -CoroutineScope scope
        -Job navigationJob
        -emitTelemetry()
        -sendVelocity(vNorth, vEast, yaw)
    }

    class SimulatedDroneController {
        -Job loop
        -avanzarHacia(destino)
    }

    class ControllerFactory {
        <<object>>
        +create() DroneController
    }

    class PatrolManager {
        -DroneController controller
        -CommandCenterClient commandCenter
        -DetectionClient detection
        -String mode
        -PatrolRoute route
        -int lastReachedWaypoint
        -Telemetry lastTelemetry
        +StateFlow~PatrolState~ state
        +StateFlow~Boolean~ signalOk
        +StateFlow~Int~ signalPct
        +SharedFlow~String~ localLog
        +List~PatrolRoute~ availableRoutes
        +start()
        +startPatrol(route)
        +onBatteryRecharged()
    }

    class CommandCenterClient {
        +StateFlow~Boolean~ connected
        +login(baseUrl, username, password) SesionOperador
        +emparejarDron(hash) Emparejamiento
        +usarTokenDeDron(token, baseUrl)
        +fetchProfile() DroneProfile
        +fetchRoutes() List~PatrolRoute~
        +sendStatus(estado, telemetria)
        +sendVideoFrame(jpegBase64)
        +sendAlertRequest(tipo, lat, lon, snapshot)
        +sendEvent(tipo, mensaje)
        +cerrarSesion(motivo)
    }

    class DetectionClient {
        -String url
        +StateFlow~Boolean~ connected
        +StateFlow~String~ ultimoFallo
        +connect(modo, urlManual)
        +sendFrame(jpegBase64)
        +disconnect()
    }

    class SesionDeCampo {
        <<object>>
        +Set~String~ ROLES_HABILITADOS
        +String usuario
        +String rol
        +Boolean vigente
        +abrir(cliente, sesion)
        +cerrar(motivo)
        +restanteMs() Long
    }

    class MainActivity {
        -PatrolManager manager
        +onCreate()
    }

    class PatrolState {
        <<enumeration>>
        IDLE
        PATROLLING
        ORBITING
        RETURNING_HOME_SIGNAL
        RETURNING_HOME_BATTERY
        PAUSED
        MANUAL
        FORCED
        LANDED
    }

    class FlightEvent {
        <<sealed>>
        WaypointReached
        ArrivedHome
        GotoArrived
    }

    class PatrolRoute {
        +int id
        +String name
        +List~Waypoint~ waypoints
    }

    class Waypoint {
        +double lat
        +double lon
        +double alt
    }

    class Telemetry {
        +double lat
        +double lon
        +double altM
        +double batteryPct
        +int signalPct
        +double heading
        +long ts
    }

    class DroneProfile {
        +String hash
        +String displayName
        +String model
        +DroneBase base
    }

    class DroneBase {
        +String name
        +double lat
        +double lon
    }

    DroneController <|.. DjiDroneController : implementa
    DroneController <|.. SimulatedDroneController : implementa
    ControllerFactory ..> DroneController : crea

    MainActivity *-- PatrolManager
    PatrolManager o-- DroneController
    PatrolManager o-- CommandCenterClient
    PatrolManager o-- DetectionClient
    PatrolManager --> PatrolState : expone
    PatrolManager ..> FlightEvent : reacciona a
    PatrolManager --> PatrolRoute : patrulla

    SesionDeCampo o-- CommandCenterClient
    CommandCenterClient ..> DroneProfile : devuelve
    CommandCenterClient ..> PatrolRoute : descarga

    PatrolRoute *-- Waypoint
    DroneProfile o-- DroneBase
    DroneController ..> Telemetry : emite
```

### Cómo se lee

- **`DroneController` es el punto de corte con el hardware.** El `PatrolManager`
  no sabe qué aparato está volando. Las dos implementaciones cumplen el mismo
  contrato y se eligen en tiempo de compilación con `ControllerFactory`.
- **La comunicación va por flujos, no por llamadas de vuelta.** La telemetría,
  el video y los eventos de vuelo salen como `SharedFlow`, con capacidad acotada
  y emisión que no bloquea el lazo de captura.
- **El `PatrolManager` concentra la seguridad.** Los dos failsafes —regreso por
  batería baja y regreso por pérdida de enlace— se disparan desde cualquier
  estado en vuelo, incluidos control manual y desvío forzado.

---

## 3. Diagrama de componentes

Cuatro piezas de software, dos aparatos y dos servicios externos. Cada flecha
lleva el protocolo por el que se hablan.

```mermaid
flowchart LR
    campo(["Operador<br/>de campo"])
    operador(["Operador · Supervisor<br/>Administrador"])

    subgraph predio["Base del dron"]
        direction TB
        app["App de control<br/>Android · Kotlin<br/>teléfono acoplado al dron"]
        dron["Dron<br/>DJI Mini 4 Pro"]
        vision["Módulo de detección<br/>modelo de visión"]
    end

    subgraph servidor["Servidor"]
        direction TB
        proxy["Proxy inverso<br/>termina el TLS"]
        subgraph back["Comando Central · backend"]
            direction TB
            api["API REST<br/>Express"]
            hub["Central en tiempo real<br/>WebSocket"]
            auth["Autenticación<br/>JWT · bcrypt"]
            store["Acceso a datos"]
            datos[("SQLite")]
        end
    end

    subgraph consola["Puesto de mando"]
        direction TB
        web["Consola web<br/>React · Leaflet"]
        teselas["Proveedor de teselas<br/>callejero y satelital"]
    end

    campo -->|emparejamiento por QR| app
    app -->|SDK del fabricante| dron
    dron -->|telemetría y video| app
    app <-->|"WS /phone · cuadros JPEG y detecciones"| vision

    app -->|"REST /api"| proxy
    app <-->|"/ws · estado, video y alertas"| proxy

    proxy --> api
    proxy <--> hub
    api <-->|órdenes y novedades| hub
    api --> auth
    hub --> auth
    api --> store
    hub --> store
    store --> datos

    proxy <-->|"REST /api y canal en vivo /ws"| web
    web -->|cartografía| teselas
    operador --> web
```

### Interfaces

| Entre | Protocolo | Qué viaja |
|---|---|---|
| Consola web ↔ backend | REST sobre HTTPS | altas, bajas y consultas de usuarios, drones, bases, rutas, alertas y registro |
| Consola web ↔ backend | WebSocket | telemetría de la flota, video, alertas y eventos en vivo |
| App de control ↔ backend | REST sobre HTTPS | inicio de sesión de campo, emparejamiento, ficha del dron y rutas de su base |
| App de control ↔ backend | WebSocket | estado del dron, cuadros de video, pedidos de alerta y órdenes de vuelo |
| App de control ↔ módulo de detección | WebSocket | cuadros JPEG hacia el módulo, detecciones de vuelta |
| App de control ↔ dron | SDK del fabricante | órdenes de vuelo, telemetría y video |
| Consola web ↔ proveedor de teselas | HTTPS | cartografía de fondo, callejera y satelital |

La consola web la entrega el propio backend como archivos estáticos: no hay un
servidor web aparte.

El enlace con el módulo de detección admite dos modos: por el cable de datos,
con un túnel local que no expone el tráfico a la red y no exige escribir ninguna
dirección, y por red con una URL configurable.
