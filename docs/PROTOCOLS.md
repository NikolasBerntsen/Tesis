# Contratos de mensajes (MVP)

Todos los enlaces usan WebSocket con mensajes JSON en texto. Los cuadros de video
viajan como JPEG codificado en base64: **640 px de ancho** (la altura sale de
conservar la relación de aspecto del stream del dron, que llega en 1920x1080 o
1280x720) y calidad 60. El mismo flujo se filtra a dos ritmos distintos:
**5 cuadros por segundo hacia el Comando Central** y **2 hacia el software de
detección**. Detectar no necesita más, y el enlace con la laptop es el más flojo
de los tres.

El sistema soporta **varios drones simultáneos**. Un dron **no es una cuenta de
usuario**: es un activo del inventario, identificado por un `hash` opaco de 32
caracteres hexadecimales que se genera al darlo de alta. Ese hash es su
`droneId` en todo el protocolo y sale del JWT de emparejamiento: nunca lo
declara el cliente.

## Roles

| Rol | Rango | Permisos |
|---|---|---|
| `drone` | 0 | Token de máquina que la app obtiene al emparejarse por QR. No es una cuenta de usuario |
| `field_operator` | 1 | **Operador de campo**: da de alta drones, genera sus QR y hace el emparejamiento en el terreno. No opera drones ni ve el registro. **Su sesión es efímera** |
| `operator` | 2 | Consola: alertas, rutas, eventos de drones. **Controla drones solo si tiene el flag `canControl`** |
| `supervisor` | 3 | Todo lo del operador + quitar el control manual a otro usuario + administrar operadores y los drones como activos |
| `admin` | 4 | Todo lo anterior + administrar todos los usuarios + ver el registro general del sistema |

Los permisos son jerárquicos por rango, salvo unos pocos que son **laterales**:
el operador de campo puede dar de alta y emparejar drones, cosa que un operador
común no hace. Esos casos se resuelven con una lista explícita de roles, no con
el rango.

Los flags `active` y `canControl`, el borrado lógico y el rol se evalúan **en
vivo** en cada request y en cada envío por WebSocket, no desde el JWT:
suspender, eliminar o degradar a un usuario surte efecto inmediato, aunque su
token siga siendo criptográficamente válido.

### Duración de la sesión según el rol

| Rol | Duración | Por qué |
|---|---|---|
| `field_operator` | **20 minutos** | La sesión solo tiene que durar lo que dura la configuración. Se cierra sola al terminar el emparejamiento, y la app muestra la cuenta regresiva |
| Resto de los humanos | 12 horas | Una jornada de trabajo |
| `drone` | 30 días | Token de máquina que se emite al emparejar; el dron no tiene a nadie que reingrese credenciales |

`POST /api/auth/login` devuelve `expiresIn` en segundos para que el cliente
pueda mostrar el tiempo restante y cerrar la sesión por su cuenta.

## Control manual — bloqueo exclusivo

Un dron puede estar controlado por **un solo usuario a la vez**. El backend
mantiene el lock (`controlledBy`) y lo incluye en la ficha del dron y en cada
`status`. Tomar un dron controlado por otro da `409`; un supervisor puede
forzar la liberación. Si el usuario que controla cierra todas sus conexiones,
el backend libera el lock y reanuda el patrullaje automáticamente.

Tener el lock es lo que habilita a pilotear: las órdenes de vuelo a mano
(`manual_move` por REST y el mando con palancas `manual_stick` por WebSocket,
§3.b) se aceptan **solo del titular**, y el permiso se revalida contra la base en
cada orden, no contra el token.

## Registro (logs)

Toda acción que involucre al sistema queda registrada en la tabla `events`, con
una `category`:

| Categoría | Contenido |
|---|---|
| `drone` | Alta, baja, edición y emparejamiento de drones; conexión/desconexión; patrullaje; alertas generadas y resueltas; batería; señal; control manual; cambios de ruta; renombres |
| `usuarios` | Alta, baja lógica, restauración, activación, suspensión y modificación de usuarios, con **antes y después** |
| `sistema` | Inicios de sesión (exitosos, fallidos y rechazados) y cierre de la sesión efímera del operador de campo |

El **log general** (`GET /api/logs`, solo admin) devuelve todas las categorías
juntas, **filtradas y paginadas en el servidor**; el log de drones
(`GET /api/events`, operador+) devuelve solo `drone`.

### La columna `meta`

`meta` es JSON y guarda el detalle estructurado que la consola despliega al
hacer clic en una entrada del registro. Las claves son siempre las mismas, así
el pop-up sabe cómo pintar cada una sin conocer el tipo de evento:

| Clave | Forma | Cómo se muestra |
|---|---|---|
| `antes` / `despues` | objetos planos con las mismas claves | Dos columnas comparadas con una flecha en el medio, resaltando solo lo que cambió |
| `ubicacion` | `{lat, lon, accuracyM}` o `null` | Mini mapa con un marcador, más las coordenadas |
| `alerta` | `{id, tipo, lat, lon, ts}` | Se trae la alerta completa con `GET /api/alerts/:id` y se muestra la captura del video |
| `drone` | `{hash, displayName, model}` | Ficha compacta del dron |
| `detalle` | objeto plano | Lista de clave/valor |

La forma exacta por tipo de evento está en la tabla del final de este
documento.

### Trazabilidad de las detecciones

Una detección deja **dos** entradas encadenadas por `alert_id`:

1. `ALERT_CREATED` cuando el algoritmo de detección dispara la alerta: guarda el
   tipo (persona o vehículo), las coordenadas GPS, el dron y la marca de tiempo,
   y queda enlazada a la fila de `alerts`, que es la que tiene la **captura del
   video** que disparó la detección.
2. `ALERT_VALIDATED` o `ALERT_DISMISSED` cuando un operador la resuelve desde el
   Comando Central: guarda **qué usuario** la marcó como válida o inválida y
   cuándo, además del antes y el después del estado de la alerta.

## 0. Modelo de datos

### Drones: activos, no cuentas

Un dron es una fila de la tabla `drones` que el Comando Central administra como
cualquier otro activo del inventario:

| Campo | Descripción |
|---|---|
| `hash` | 32 hexadecimales generados al darlo de alta. **Es el `droneId` de todo el protocolo** y el único contenido del QR. Inmutable |
| `displayName` | Nombre visible. **Editable desde la app y desde el Comando Central**, y el cambio se propaga al otro lado |
| `model` | Modelo del aparato, a título informativo |
| `active` | Si está en `false`, **se rechaza la conexión del dron** (y se corta la que tuviera abierta) |
| `base` | `{name, lat, lon}`: la base a la que vuelve. Se dibuja como cuadrado azul en los mapas |
| `deleted` | Marca de baja lógica: es lo que decide si la fila está dada de baja |
| `deletedAt` / `deletedBy` | Cuándo y quién dio la baja; dato de auditoría |

En la interfaz el hash no se muestra entero nunca: se muestra el nombre y el
hash abreviado (`a3f9c1…7e42`).

### Borrado lógico

**Nada se borra físicamente**, ni usuarios ni drones: se prende `deleted` y se
anotan `deleted_at` y `deleted_by`. La consulta es siempre por la marca y nunca
por la fecha: la fecha es el dato de auditoría, no el interruptor, así que una
fila con fecha pero sin marca está viva. Un usuario eliminado no puede iniciar
sesión, sus sockets se cierran en el acto y **sigue ocupando su nombre de
usuario** (el `UNIQUE` se
mantiene a propósito, para que el historial del registro nunca quede apuntando
a un nombre que después reusó otra persona). De supervisor para arriba se puede
listar lo eliminado y restaurarlo.

### Rutas

Cada waypoint de una ruta es `{ lat, lon, alt, label? }`. `label` es un apodo
opcional que pone el operador para identificar zonas puntuales; se muestra al
hacer clic sobre el nodo en el mapa de la vista de detalle. En ese mapa los
nodos se pintan **rojos** mientras están pendientes y **verdes** una vez que el
dron pasó por ellos (índice ≤ `waypointIndex` del `status`).

## 0.b Emparejamiento por QR

Reemplaza al viejo inicio de sesión del dron con usuario y contraseña.

1. Desde el Comando Central, un operador de campo (o un supervisor) **da de alta
   el dron**. El backend genera su `hash`.
2. La consola dibuja el QR **con el hash como único contenido** y lo imprime
   como sticker, que se pega en el aparato. El QR no lleva nombre, modelo, base
   ni ningún otro dato: si alguien lo fotografía, no aprende nada del sistema.
3. En el campo, el operador **inicia sesión en la app** (sesión efímera de 20
   minutos) y escanea el sticker.
4. La app llama a `POST /api/drones/pair` con el hash **y la ubicación GPS del
   operador en ese momento**. El backend valida que el dron exista, no esté
   eliminado y esté activo, y devuelve un **token de rol `drone`** con el que la
   app se conecta al WebSocket.
5. El emparejamiento queda registrado (`DRONE_PAIRED`) con quién lo hizo, desde
   dónde y con qué dispositivo. La sesión del operador de campo **se cierra ahí
   mismo** (`FIELD_SESSION_CLOSED`).

Por qué el hash suelto no alcanza para hacerse pasar por un dron: el
emparejamiento **exige un JWT válido de operador de campo**. El sticker es un
identificador, no una credencial. Aun así, si un dron se compromete se lo
desactiva desde la consola y su conexión se corta en el acto.

## 1. App de control (celular) → Comando Central

Conexión: `ws://<backend>:4000/ws?token=<JWT>` (el rol `drone` sale del token).

| Mensaje | Campos | Efecto en el backend |
|---|---|---|
| `status` | ver tabla de abajo | Se guarda como último estado del dron y se reenvía a los operadores |
| `event` | `eventType, message` | Se persiste en `events` y se reenvía a los operadores |
| `video_frame` | `jpegBase64, ts` | Se reenvía a los operadores etiquetado con `droneId`. **5 por segundo**: JPEG de 640 px de ancho, calidad 60 |
| `alert_request` | `alertType (PERSON\|VEHICLE), lat, lon, snapshotBase64` | Crea fila en `alerts` (PENDING) + evento `ALERT_CREATED`, y notifica a los operadores |
| `set_name` | `displayName` | Renombra el dron y avisa a los operadores con `drone_renamed` |

### Campos de `status`

| Campo | Tipo | Notas |
|---|---|---|
| `state` | string | `IDLE`, `PATROLLING`, `ORBITING`, `RETURNING_HOME_SIGNAL`, `RETURNING_HOME_BATTERY`, `LANDED`, `PAUSED` (patrulla interrumpida), `MANUAL` (control manual), `FORCED` (desvío forzado a un nodo) |
| `battery` | number | Porcentaje 0..100 |
| `lat`, `lon` | number | Posición actual |
| `routeId` | number \| null | Ruta que está patrullando |
| `waypointIndex` | number | Índice 0-based del último waypoint alcanzado |
| `waypointTotal` | number | Cantidad de waypoints de la ruta. La UI muestra `waypointIndex + 1` de `waypointTotal` |
| `signal` | `OK` \| `LOST` | Estado del enlace RC |
| `heading` | number | Rumbo 0..360° hacia donde mira la cámara (el mapa dibuja el cono) |
| `signalPct` | number | Intensidad de señal 0..100 (0 cuando `signal` es `LOST`) |
| `mode` | `TEST` \| `DEPLOY` | Modo elegido en la app tras iniciar sesión |

`eventType` usados por la app: `PATROL_STARTED`, `PATROL_RESUMED`, `SIGNAL_LOST`,
`SIGNAL_RECOVERED`, `RTH_SIGNAL_LOSS`, `RTH_LOW_BATTERY`, `ORBIT_STARTED`,
`LANDED`, `BATTERY_RECHARGED`.

## 2. Comando Central → App de control

Los mensajes se dirigen **solo al dron correspondiente**, salvo que se indique.

| Mensaje | Campos | Efecto en el celular |
|---|---|---|
| `alert_decision` | `alertId, decision (VALIDATED\|DISMISSED), decidedBy` | Si fue descartada, deja la órbita y reanuda el patrullaje desde el waypoint guardado |
| `resume_patrol` | `orderedBy, fromIndex?` | Reanuda el patrullaje; con `fromIndex` continúa desde ese nodo, sin él desde el último alcanzado |
| `start_route` | `routeId, fromIndex, orderedBy` | Comienza a patrullar esa ruta |
| `stop_patrol` | `orderedBy` | Interrumpe el patrullaje: el dron queda en vuelo estacionario (`PAUSED`) |
| `force_goto` | `routeId, index, orderedBy` | Vuela forzado hacia ese nodo y queda estacionario sobre él (`FORCED`) |
| `control_taken` | `by` | Entra en control manual (`MANUAL`): vuelo estacionario a la espera de movimientos |
| `manual_move` | `bearing, distanceM, by` | **Desplazamiento puntual** de esa distancia en ese rumbo (solo en `MANUAL`) |
| `manual_stick` | `pitch, roll, yaw, throttle, by` | **Vuelo continuo con palancas** (solo en `MANUAL`): cada eje es un número en `[-1, 1]` y el dron lo sostiene hasta el mensaje siguiente. Ver §3.b |
| `control_released` | `by` | Sale del control manual; si no llega un `resume_patrol` a continuación queda `PAUSED` |
| `renamed` | `displayName` | El operador renombró al dron: la app actualiza el nombre que muestra |

### `manual_move` y `manual_stick` no son lo mismo

Los dos mueven el dron a mano y los dos solo valen en estado `MANUAL`, pero son
dos formas distintas de pilotear:

| | `manual_move` | `manual_stick` |
|---|---|---|
| Qué es | Un **salto puntual**: "corrémelo 25 metros al este" | **Vuelo continuo**: las palancas de un control físico |
| Parámetros | Rumbo absoluto (0..360°) y distancia en metros | Cuatro ejes en `[-1, 1]`, relativos al cuerpo del dron |
| Cómo llega | REST (`POST /api/drones/:droneId/manual_move`): es un click, uno por vez | WebSocket, ~10 mensajes por segundo mientras la palanca esté tomada |
| Cuándo termina | Cuando el dron llegó; después queda estacionario | Cuando llega un mensaje con los cuatro ejes en `0`, o cuando salta el watchdog de la app |

Los botones de flecha de la consola siguen mandando `manual_move` (25 m por
click); las palancas mandan `manual_stick`.

**Watchdog de mando (en la app)**: estando en `MANUAL`, si pasan 1500 ms sin que
llegue ningún `manual_stick` y el último recibido no era todo ceros, la app pone
los ejes en cero por su cuenta y lo anota en su log local. Es la red de seguridad
ante un corte de internet del celular: sin eso, el dron seguiría volando con la
última velocidad comandada.

## 3. Comando Central → Consola del operador (web)

Conexión: `ws://<backend>:4000/ws?token=<JWT>` (rol `operator`).

| Mensaje | Contenido |
|---|---|
| `status` | Estado de un dron (los campos de arriba + `droneId`, `displayName`) |
| `video_frame` | `droneId, jpegBase64, ts` (5 por segundo, JPEG de 640 px de ancho) |
| `event` | Evento recién persistido (fila completa) |
| `alert_created` | Alerta nueva (fila completa, incluye snapshot) |
| `alert_updated` | Alerta con decisión tomada |
| `drone_online` / `drone_offline` | `drone` (ficha completa del dron) |
| `drone_updated` | `drone` (ficha completa); se emite al dar de alta, editar, eliminar o restaurar un activo, para que la vista de Drones se refresque sin repreguntar |
| `drone_renamed` | `droneId, displayName` |
| `route_updated` | `route` (ruta completa); se emite al cambiar el apodo de un nodo |
| `control_changed` | `droneId, controlledBy` (username o `null`) |

Al conectarse, el operador recibe un `status` por cada dron que esté online, para
poder pintar el dashboard sin esperar al próximo tick.

**El hub filtra por rol lo que manda**, con los mismos permisos que la API REST y
leyendo el rol de la base, no del token: el operador de campo solo recibe las
novedades del inventario de drones (`drone_updated`, `drone_online`,
`drone_offline`, `drone_renamed`) y nunca video, alertas, telemetría ni eventos;
los eventos de las categorías `usuarios` y `sistema` solo llegan al admin, que es
el único que puede leer el registro general. Antes de cada envío se comprueba que
el JWT no haya vencido y que la cuenta siga activa; si no, el socket se cierra.

## 3.b Consola del operador (web) → Comando Central

El socket de la consola es de **doble vía**. Casi todo lo que la consola le pide
al backend va por REST; lo único que sube por el WebSocket es el **mando
virtual**, y sube por acá justamente porque no es una acción suelta sino un flujo:

| Mensaje | Campos | Efecto en el backend |
|---|---|---|
| `manual_stick` | `droneId, pitch, roll, yaw, throttle` | Si se acepta, se reenvía al dron como `manual_stick` con `by: <username>`. No genera registro |

```json
{ "type": "manual_stick", "droneId": "a3f9c1…7e42", "pitch": 0.6, "roll": 0, "yaw": -0.3, "throttle": 0 }
```

### Los cuatro ejes

Cada eje es un número en `[-1, 1]`, como la palanca de un control físico. Los
ejes son **relativos al cuerpo del dron** (adelante = hacia donde mira la
cámara), que es exactamente lo que el operador está viendo en el video: no hay
que rotar nada por el rumbo.

| Eje | `+1` | `-1` |
|---|---|---|
| `pitch` | Adelante (hacia la nariz) | Atrás |
| `roll` | A la derecha | A la izquierda |
| `yaw` | Gira en sentido horario | Gira en sentido antihorario |
| `throttle` | Sube | Baja |

Los cuatro son **obligatorios y tienen que ser números**: si alguno falta, viene
en texto (`"0.5"`) o es `null`, se descarta el mensaje **entero**, porque
mandarle al dron tres ejes buenos y uno inventado es peor que no mandarle nada.
Un valor apenas fuera de rango (un `1.4` de la normalización del arrastre del
puntero) **no se descarta: se recorta** a `1`; lo que el operador quiso decir es
"todo para ese lado".

### Ritmo y cierre

La consola emite a **10 Hz** mientras el mando está tomado, y al soltar la
palanca manda **un último mensaje con los cuatro ejes en `0`**: ese mensaje es el
que deja al dron en vuelo estacionario. Por eso un mando todo en cero es un
mensaje válido y no se filtra.

### Por qué no es REST

Es la única orden de vuelo que no tiene endpoint REST. A ~10 mensajes por
segundo, abrir un POST por cada uno (con su handshake, su cabecera de
autorización y su respuesta JSON) sería absurdo: el socket ya está abierto, ya
está autenticado y ya entrega en orden. La tabla de endpoints REST de §5 no
cambió por el mando virtual.

### Cuándo se acepta

El mensaje se reenvía al dron **solo si, en ese momento**, se cumple todo esto:

1. La sesión del socket **no venció** (si venció, el socket se cierra con `4401`).
2. El que manda **tiene el lock de control manual de ese dron** (`controlledBy`).
   Es lo primero que se comprueba: el lock es lo que hace exclusivo el mando.
3. La cuenta **sigue activa y no está eliminada**, y conserva `canControl`.
4. Su rol es `operator` o superior.

Los puntos 3 y 4 se releen **de la base en cada mensaje**, igual que hace la API
REST con cada request: a un operador al que le acaban de quitar `canControl` o
bajarle el rol no le sirve tener el socket abierto de antes.

Si algo de eso no se cumple, el mensaje se descarta **en silencio**: no se le
contesta nada a la consola. Contestar no serviría, porque la consola ya se entera
del estado del lock por `control_changed`, y a 10 Hz una respuesta por cada
mensaje descartado sería una avalancha que nadie mira. Un frame que no es JSON, o
un `type` que el hub no conoce, también se ignoran sin cortar la conexión.

**El mando no deja entradas en el registro.** A 10 Hz inundaría la tabla `events`
y taparía todo lo demás. Lo que queda registrado es tomar y soltar el control
(`CONTROL_TAKEN` / `CONTROL_RELEASED`), que es lo que la auditoría necesita:
quién tuvo el mando de qué dron y desde cuándo.

## 4. App de control (celular) ↔ Software de detección (laptop)

El control con el celular montado se comunica con la laptop que corre la
detección **por cable USB**. Hay dos modos, elegibles desde la app:

### Modo `CABLE` (por defecto)

Túnel de ADB sobre el propio cable USB. En la laptop se corre **una sola vez**:

```bash
adb reverse tcp:8765 tcp:8765
```

Con eso, el puerto 8765 del celular queda redirigido al 8765 de la laptop, y la
app se conecta a `ws://127.0.0.1:8765/phone`. Requiere depuración USB activada
en el teléfono. Es el modo recomendado porque **no depende de la red**: no hay
que averiguar IPs, no importa si el predio no tiene wifi y no hay tráfico de
video saliendo al aire.

Si el enlace no levanta, la app no muestra un error mudo: dice que revise el
cable, la depuración USB y el `adb reverse`.

### Modo `RED` (respaldo)

URL manual contra la IP de la laptop (`ws://<ip-de-la-laptop>:8765`). Sirve
cuando no hay depuración USB disponible, y también cubre el caso del **anclaje
USB**, donde la laptop suele quedar en `192.168.42.x`.

### Contrato de mensajes

Este es el contrato que debe implementar el software real de detección;
`detection-mock/` es un placeholder que lo respeta.

| Dirección | Mensaje | Campos |
|---|---|---|
| celular → laptop | `video_frame` | `jpegBase64, ts` (**2 por segundo**, JPEG de 640 px de ancho) |
| laptop → celular | `detection` | `detected (bool), classes (["PERSON"\|"VEHICLE"]), confidence, ts` |

Son los **mismos cuadros** que van al Comando Central, filtrados a menos ritmo: 5
por segundo hacia la consola (donde hay una persona mirando y el salto se nota) y
2 hacia la detección. El algoritmo no necesita más, y este es el enlace más flojo
de los tres.

La app solo actúa ante `detected: true` y solo mientras está en estado
`PATROLLING` (evita re-alertar mientras orbita o vuelve a base). Cuando actúa,
manda `alert_request` al Comando Central con la captura y las coordenadas, y eso
queda en el registro (ver "Trazabilidad de las detecciones").

## 5. REST del Comando Central

Lo que cambió respecto de la versión anterior está marcado con **negrita**.

### Sesión

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{username, password}` → **`{token, expiresIn, user}`**. `expiresIn` en segundos: lo usa la app para la cuenta regresiva de la sesión efímera |
| **POST** | **`/api/auth/logout`** | JWT | `{motivo?}`. No invalida nada del lado del servidor (el JWT vive en el cliente): existe para **dejar registrado** el cierre de la sesión efímera del operador de campo |
| GET | `/api/me` | JWT | Ficha del usuario autenticado. Para un dron incluye `displayName` y `base` |
| GET | `/api/health` | — | Ping |

### Drones como activos

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/drones` | operador de campo, operador+ | `?includeDeleted=1` (el flag **solo lo respeta supervisor+**; para el resto se ignora) |
| **POST** | **`/api/drones`** | campo, supervisor+ | `{displayName, model?, base?}` → 201 con la ficha, **incluido el `hash` para el QR** |
| **POST** | **`/api/drones/pair`** | campo, supervisor+ | `{hash, lat?, lon?, accuracyM?, deviceModel?}` → `{token, drone}`. 404 si el QR no corresponde a ningún dron, 403 si está eliminado o desactivado |
| **PATCH** | **`/api/drones/:hash`** | operador+ si solo cambia `displayName`; supervisor+ para el resto | `{displayName?, model?, active?, base?}`. Desactivar corta la conexión del dron |
| **DELETE** | **`/api/drones/:hash`** | supervisor+ | **Borrado lógico**. Corta la conexión del dron |
| **POST** | **`/api/drones/:hash/restore`** | supervisor+ | Restaura un dron eliminado |

### Operación

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/routes` | JWT | Rutas de patrullaje disponibles (waypoints incluidos) |
| PATCH | `/api/routes/:routeId/waypoints/:index` | operador+ | `{label}`; apodo de un nodo (vacío lo borra). Emite `route_updated` |
| POST | `/api/drones/:droneId/route/start` | operador+ | `{routeId, fromIndex?}` |
| POST | `/api/drones/:droneId/route/stop` | operador+ | Interrumpe el patrullaje (el dron queda estacionario) |
| POST | `/api/drones/:droneId/resume` | operador+ | `{fromIndex?}`: reanuda desde ese nodo o desde el último alcanzado. Libera el control manual |
| POST | `/api/drones/:droneId/goto` | con `canControl` | `{routeId, index}`: fuerza el vuelo hacia ese nodo |
| POST | `/api/drones/:droneId/control` | con `canControl` | Toma el control manual (409 si otro lo tiene) |
| DELETE | `/api/drones/:droneId/control` | titular o supervisor+ | `{resume: 'last'\|'none'\|número}` |
| POST | `/api/drones/:droneId/manual_move` | titular del control | `{bearing, distanceM}`: desplazamiento puntual (la consola manda 25 m por click) |

El **mando virtual con palancas no está en esta tabla y no va a estar**: viaja por
el WebSocket de la consola (§3.b) porque son ~10 mensajes por segundo mientras el
operador sostiene la palanca.

### Alertas

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/alerts?status=` | operador+ | Lista de alertas |
| **GET** | **`/api/alerts/:id`** | operador+ | Alerta completa **con la captura del video**; la usa el pop-up del registro |
| POST | `/api/alerts/:id/decision` | operador+ | `{decision: VALIDATED\|DISMISSED}`; registra quién decidió y notifica al dron |

### Usuarios

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/users` | supervisor+ | **`?includeDeleted=1`**. Supervisor ve operadores; admin ve todos |
| POST | `/api/users` | admin | `{username, password, role, canControl}`. **`role` acepta ahora `field_operator`**, al que se le fuerza `canControl:false` |
| PATCH | `/api/users/:username` | supervisor+ (solo `canControl` de operadores) / admin (todo) | `{canControl?, active?, password?}`. Registra antes y después |
| **DELETE** | **`/api/users/:username`** | admin | **Borrado lógico**. Cierra sus sockets y libera los drones que controlara |
| **POST** | **`/api/users/:username/restore`** | admin | Restaura un usuario eliminado |

### Registro

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| **GET** | **`/api/logs`** | admin | `?category=&page=&pageSize=&droneId=&q=` → **`{items, total, page, pageSize}`**. `pageSize` ∈ {25, 50, 75, 100}; fuera de ese conjunto cae a 25. El filtro y el conteo se resuelven **en SQL**, no en el navegador |
| GET | `/api/events` | operador+ | `?limit=&droneId=`: log de drones (más reciente primero) |

## 6. Ficha de dron (`drone`)

Forma que devuelven `GET /api/drones` y los mensajes `drone_online`,
`drone_offline` y `drone_updated`. `hash` y `droneId` son el mismo valor con dos
nombres: `hash` cuando se habla del activo y del QR, `droneId` cuando se habla
del protocolo.

```json
{
  "hash": "a3f9c1b27d5e4408f61a9c3e772b7e42",
  "droneId": "a3f9c1b27d5e4408f61a9c3e772b7e42",
  "displayName": "Alfa",
  "model": "DJI Mini 4 Pro",
  "active": true,
  "deleted": false,
  "deletedAt": null,
  "base": { "name": "Base Norte", "lat": -34.8565, "lon": -56.2075 },
  "online": true,
  "controlledBy": null,
  "lastStatus": { "state": "PATROLLING", "battery": 87, "lat": -34.855, "lon": -56.206,
                  "routeId": 1, "waypointIndex": 2, "waypointTotal": 4,
                  "signal": "OK", "signalPct": 78, "heading": 132, "mode": "TEST" }
}
```

## 7. Forma de `meta` por tipo de evento

Piezas que se repiten: `Dron = {hash, displayName, model}` ·
`EstadoDron = {displayName, model, activo, eliminado, base, baseLat, baseLon}`
(plano a propósito, para que la comparación del pop-up sea campo a campo) ·
`UserView = {username, fullName, role, active, canControl, deleted, deletedAt}`.

| Categoría | Tipo | `meta` |
|---|---|---|
| drone | `DRONE_CREATED` | `{drone, despues: EstadoDron}` |
| drone | `DRONE_UPDATED` / `DRONE_DELETED` / `DRONE_RESTORED` | `{drone, antes: EstadoDron, despues: EstadoDron}` |
| drone | `DRONE_PAIRED` | `{por, ubicacion: {lat, lon, accuracyM} \| null, dispositivo, drone}` |
| drone | `DRONE_CONNECTED` / `DRONE_DISCONNECTED` | `{drone}` |
| drone | `DRONE_RENAMED` | `{antes: {displayName}, despues: {displayName}, drone}` |
| drone | `WAYPOINT_RENAMED` | `{antes: {apodo}, despues: {apodo}, detalle: {ruta, rutaId, nodo}}` |
| drone | `ROUTE_STARTED` | `{drone, detalle: {ruta, rutaId, desdeNodo}}` |
| drone | `PATROL_STOPPED` | `{drone, detalle: {por}}` |
| drone | `PATROL_RESUME_ORDERED` | `{drone, detalle: {por, desdeNodo}}` |
| drone | `FORCED_GOTO` | `{drone, detalle: {ruta, rutaId, nodo}}` |
| drone | `CONTROL_TAKEN` | `{drone, detalle: {por}}` |
| drone | `CONTROL_RELEASED` | `{drone, detalle: {por, teniaElControl, forzado, motivo}}` |
| drone | `ALERT_CREATED` | `{alerta: {id, tipo, lat, lon, ts}, drone}` |
| drone | `ALERT_VALIDATED` / `ALERT_DISMISSED` | `{alerta: {id, tipo}, decision, por, antes: {estado}, despues: {estado, decidedBy, decidedAt}, drone}` |
| drone | Eventos que reporta la app (`PATROL_STARTED`, `SIGNAL_LOST`, `RTH_LOW_BATTERY`, …) | `{drone}` |
| usuarios | `USER_CREATED` | `{despues: UserView}` |
| usuarios | `USER_UPDATED` / `USER_DELETED` / `USER_RESTORED` | `{antes: UserView, despues: UserView}` |
| sistema | `FIELD_SESSION_CLOSED` | `{detalle: {por, motivo}}` |
| sistema | `LOGIN` / `LOGIN_FAILED` / `LOGIN_REJECTED` | — |
