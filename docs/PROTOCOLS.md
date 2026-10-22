# Contratos de mensajes (MVP)

Todos los enlaces usan WebSocket con mensajes JSON en texto. Los cuadros de video
viajan como JPEG codificado en base64, y son **dos flujos distintos** que salen
del controlador de vuelo de la app:

- Al **Comando Central** le llegan **todos** los cuadros del flujo de la
  consola: **640 px de ancho** (la altura sale de conservar la relación de
  aspecto del stream del dron, que llega en 1920x1080 o 1280x720), calidad 60,
  **5 por segundo** (`CuadroDeVideo.INTERVALO_CUADRO_MS`). Es el video que mira
  el operador y con el que decide, y de ahí sale la captura de cada alerta.
- Al **software de detección** le llega el flujo de la detección: **1280 px de
  ancho** (`CuadroDeVideo.ANCHO_DETECCION`), calidad 75, **uno cada 500 ms como
  mucho** (`CuadroDeVideo.INTERVALO_DETECCION_MS`), o sea **dos por segundo
  como techo**. Va más grande porque el modelo está entrenado con VisDrone a
  1280 px y desde 50 m una persona a 640 px son diez pixeles: a esa escala no
  hay detector que la vea. Y va más espaciado porque detectar no necesita más
  y el enlace con la notebook es el más flojo de los tres.

El techo de la detección lo vuelve a medir `PatrolManager` con **reloj y no
contando cuadros** (`LimitadorDeRitmo`), aunque el controlador ya emita
raleado: es la garantía del contrato y no puede depender de que cada
controlador la cumpla. Si mañana uno emitiera el doble, la detección NO recibe
el doble. El dron **simulado** emite los dos flujos al mismo ritmo que el real,
así que el banco de pruebas mide lo mismo que el campo.

O sea: a la consola le llegan **cinco cuadros por segundo** y a la detección
**dos**, más grandes. Quien dimensione el enlace de la detección tiene que
hacerlo para 2 cuadros de ~150 KB por segundo. Antes de citar un número, mirá
las constantes de `CuadroDeVideo`, no este documento.

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
token siga siendo criptográficamente válido. El rol, además, tiene que ser el
mismo con que se firmó el token: **un cambio de rol termina la sesión**. El token
de antes recibe `401` en la API y `4401` al abrir el WebSocket, y la consola,
ante cualquiera de los dos, borra la sesión y vuelve al inicio de sesión.

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
el backend libera el lock y reanuda el patrullaje automáticamente, **salvo que
el dron esté sobre un objetivo (su último `status` trae `target`): en ese caso
lo suelta sin reanudar y el dron vuelve al objetivo** (§2 `control_released`).

Tener el lock es lo que habilita a pilotear: las dos órdenes de vuelo a mano
(`manual_move` por REST y el mando con palancas `manual_stick` por WebSocket,
§3.b) y **la inclinación de la cámara (`manual_gimbal`, también por WebSocket)**
se aceptan **solo del titular**. Pero no se apoyan en lo mismo:

- `POST /manual_move` compara el titular del lock y nada más. La cuenta y el rol
  igual se releen de la base en cada request (es lo que hace `requireAuth` con
  todas), pero **`canControl` no se vuelve a mirar**: para este endpoint, el lock
  hace de permiso.
- `manual_stick` y `manual_gimbal` viajan por un socket que se abrió una vez y
  puede quedar horas abierto, así que además del lock **revalidan la cuenta
  entera contra la base en cada mensaje**: que siga activa, que no esté
  eliminada, que conserve `canControl` y que su rol sea `operator` o superior
  (§3.b).

Hoy la diferencia no se nota porque quitarle `canControl` a alguien le suelta
todos los locks (`releaseAllControlledBy`), así que quedarse con el lock sin el
permiso no es un estado alcanzable. La que no depende de eso para ser correcta
es la del WebSocket.

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
   dónde y con qué dispositivo. La sesión del operador de campo **sigue viva**
   durante la operación (así el operador vuelve al menú de campo al terminar,
   sin reingresar); se cierra cuando el operador la cierra (`FIELD_SESSION_CLOSED`
   con su motivo) o vence sola a los 20 minutos del login.
6. Antes de operar, la app muestra la pantalla de **conexión con el dron
   físico**: verifica el SDK, el control por USB, la aeronave enlazada (modelo y
   número de serie) y el GPS, y no deja desplegar hasta que el enlace esté.

Por qué el hash suelto no alcanza para hacerse pasar por un dron: el
emparejamiento **exige un JWT válido de operador de campo**. El sticker es un
identificador, no una credencial. Aun así, si un dron se compromete se lo
desactiva desde la consola y su conexión se corta en el acto.

## 1. App de control (celular) → Comando Central

Conexión: `ws://<backend>:4000/ws?token=<JWT>` (el rol `drone` sale del token).

| Mensaje | Campos | Efecto en el backend |
|---|---|---|
| `status` | ver tabla de abajo | Se guarda como último estado del dron y se reenvía a los operadores **tal cual** (el hub no filtra campos; solo sanea la posición y **`gimbalPitch`**, ver la tabla) |
| `event` | `eventType, message`, **`alertId?`, `lat?`, `lon?`** | Se persiste en `events` y se reenvía a los operadores. **Con `alertId` la fila queda encadenada a esa alerta** (columna `alert_id` y `meta.alerta`, si la alerta existe y es de ese dron). **Con `lat`/`lon` válidos** (números finitos, dentro de rango, no 0,0) se guardan en `meta.ubicacion` (`accuracyM: null`): es la posición del **objetivo** en los eventos de seguimiento, para que el equipo de tierra la tenga en el registro |
| `video_frame` | `jpegBase64, ts` | Se reenvía a los operadores etiquetado con `droneId`. JPEG de 640 px de ancho, calidad 60; el ritmo es el del controlador (**5 por segundo con el dron real**; el simulado emite al suyo) |
| `alert_request` | `alertType (PERSON\|VEHICLE), lat, lon, snapshotBase64, confidence, classes`, **`ref`, `droneLat?`, `droneLon?`, `droneAlt?`** | Crea fila en `alerts` (PENDING) + evento `ALERT_CREATED`, y notifica a los operadores. `lat`/`lon` son la **posición estimada del objetivo** (no la del dron) y `snapshotBase64` el cuadro **anotado** que disparó la detección. **`confidence`, `classes` y la pose del dron (`droneLat/Lon/Alt`) quedan en `meta.detalle` del `ALERT_CREATED`** (`{confianza, clases, dronLat, dronLon, dronAlt}`). **`ref`** es un identificador que inventa la app (texto ≤ 64): el hub le contesta al dron con `alert_ack {ref, alertId}` (§2), y así la app sabe qué alerta es la del objetivo que está siguiendo |
| `set_name` | `displayName` | Renombra el dron y avisa a los operadores con `drone_renamed` |

### Campos de `status`

| Campo | Tipo | Notas |
|---|---|---|
| `state` | string | `IDLE`, `PATROLLING`, `ORBITING` (orbitando el objetivo detectado), **`FOLLOWING` (siguiendo al objetivo detectado porque se mueve)**, `RETURNING_HOME_SIGNAL`, `RETURNING_HOME_BATTERY`, `RETURNING_HOME` (regreso ordenado por el operador de campo desde la app), `LANDED`, `PAUSED` (patrulla interrumpida), `MANUAL` (control manual), `FORCED` (desvío forzado a un nodo) |
| `battery` | number | Porcentaje 0..100 |
| `lat`, `lon` | number \| **null** | Posición actual. **`null` sin fix GPS** (interior, arranque en frío): el SDK de DJI entrega 0,0 sin fix y eso no es una posición. La consola no dibuja el dron en el mapa ni le cree a 0,0 |
| **`gpsFix`** | boolean | **`true` si `lat`/`lon` son una posición real.** El status sale igual sin GPS: estado, batería, altura y si vuela llegan siempre que haya enlace con la aeronave |
| **`flightMode`** | string | **Modo de vuelo que informa la aeronave** (`GPS`, `ATTI`, `VIRTUAL_STICK`, …; texto del SDK, solo informativo). `""` si no lo informa (simulador) |
| **`target`** | objeto \| null | **El objetivo que el dron está orbitando o siguiendo** (ver abajo). `null` si no hay ninguno |
| `routeId` | number \| null | Ruta que está patrullando |
| `waypointIndex` | number | Índice 0-based del último waypoint alcanzado |
| `waypointTotal` | number | Cantidad de waypoints de la ruta. La UI muestra `waypointIndex + 1` de `waypointTotal` |
| `signal` | `OK` \| `LOST` | Estado del enlace RC |
| `heading` | number | Rumbo 0..360° hacia donde mira la cámara (el mapa dibuja el cono) |
| `signalPct` | number | Intensidad de señal 0..100 (0 cuando `signal` es `LOST`) |
| `mode` | `TEST` \| `DEPLOY` | Modo elegido en la app tras iniciar sesión |
| `alt` | number | Altura sobre el punto de despegue, en metros (barómetro del dron; 0 en el suelo) |
| `satellites` | number | Satélites GPS en uso (el dron real; el simulado informa 14) |
| `flying` | boolean | `true` con el dron en el aire. En el suelo la app rechaza toda orden de vuelo salvo comenzar un patrullaje, que despega solo |
| **`gimbalPitch`** | number, **opcional** | **Inclinación actual de la cámara en grados: `0` es el horizonte y los negativos miran hacia abajo (`-90`, derecho al suelo).** La app la manda solo si la conoce (el dron real la informa al rato de enlazar). **Una app vieja no la manda: la consola supone `-30` hasta saberla.** El hub la reenvía solo si es un número finito y **sin recortarla** (es lo que el gimbal dice que hace, no una orden); si no lo es, el campo no sale |

Los campos nuevos el hub los reenvía tal cual: una consola que no los conozca
los ignora.

#### `target`: el objetivo en seguimiento

Existe desde la detección que disparó la alerta hasta que el seguimiento
termina (alerta descartada, reanudación del patrullaje, regreso a base,
aterrizaje). Mientras existe, la app lo actualiza con cada detección asociada
(ver §4, "Qué hace la app con una detección"), y el status de cada segundo lleva
la estimación vigente:

```json
"target": {
  "alertId": 12,
  "type": "VEHICLE",
  "lat": -34.60412, "lon": -58.38170,
  "speedMs": 4.2, "courseDeg": 118,
  "moving": true,
  "lost": false,
  "lastSeenMs": 600,
  "decision": "PENDING"
}
```

| Campo | Notas |
|---|---|
| `alertId` | Id de la alerta del objetivo (llega a la app con `alert_ack`); `null` hasta entonces |
| `type` | `PERSON` \| `VEHICLE` |
| `lat`, `lon` | Posición **estimada** del objetivo (filtrada; extrapolada con su velocidad hasta 4 s si no se lo ve) |
| `speedMs`, `courseDeg` | Velocidad estimada (m/s) y rumbo de su desplazamiento (0..360) |
| `moving` | `true` si se está desplazando: el dron lo **sigue** (`FOLLOWING`) en vez de orbitarlo |
| `lost` | `true` si hace más de 10 s que no se lo detecta: el dron orbita la última posición conocida |
| `lastSeenMs` | Hace cuánto se lo vio por última vez |
| `decision` | `PENDING` mientras el operador no decidió; `VALIDATED` si la confirmó como real |

`eventType` usados por la app: `PATROL_STARTED`, `PATROL_RESUMED`,
`PATROL_STOPPED`, `SIGNAL_LOST`, `SIGNAL_RECOVERED`, `RTH_SIGNAL_LOSS`,
`RTH_LOW_BATTERY`, `RTH_MANUAL` (regreso ordenado desde la app), `TAKEOFF`
(despegue automático en curso, del patrullaje o pedido desde la consola),
`LANDING` (aterrizaje ordenado desde la app o la consola),
`ORBIT_STARTED`, `GOTO_ARRIVED`, `FORCED_GOTO`, `CONTROL_RESUMED`, `LANDED`,
`BATTERY_RECHARGED`, `DRONE_PROBLEM` (el dron o su SDK rechazó una orden: el
motivo va en `message`, con un techo de repetición para no inundar el registro).
`DETECTION` (detección confirmada que se avisa sin seguimiento: dron en el suelo, a baja altura, sin GPS o con el objetivo imposible de ubicar en el terreno —la cámara al horizonte o más arriba—; con `lat`/`lon` si se pudo ubicar),
`TARGET_DETECTED` (detección durante el control manual: arranca el seguimiento sin mover al dron).
**Seguimiento** (todos con `alertId` si se conoce y con `lat`/`lon` del objetivo):
`TARGET_MOVING` (el objetivo se mueve: el dron deja la órbita y lo sigue),
`TARGET_STOPPED` (se detuvo: el dron vuelve a orbitarlo donde quedó),
`TARGET_LOST` (hace 10 s que no se lo ve: el dron orbita la última posición
conocida, que es la que va al equipo de tierra), `TARGET_REACQUIRED`,
`TRACKING_RESUMED` (el operador soltó el control y el dron vuelve al objetivo),
`TRACKING_ENDED` (el seguimiento terminó: alerta descartada, patrullaje
reanudado, regreso a base o aterrizaje; el motivo va en `message`).

## 2. Comando Central → App de control

Los mensajes se dirigen **solo al dron correspondiente**, salvo que se indique.

| Mensaje | Campos | Efecto en el celular |
|---|---|---|
| **`alert_ack`** | **`ref, alertId`** | **Respuesta del hub a un `alert_request`: el id que la alerta recibió. La app lo asocia al objetivo que está siguiendo y lo manda en `status.target.alertId` y en los eventos de seguimiento** |
| `alert_decision` | `alertId, decision (VALIDATED\|DISMISSED), decidedBy`, **`resent?`** | **Se aplica solo si `alertId` es la alerta del objetivo en curso** (o si la app todavía no conoce el id de su alerta, salvo que sea un reenvío: `resent: true` solo vale para la alerta exacta); una decisión sobre una alerta vieja no toca el objetivo nuevo. `DISMISSED`: termina el seguimiento, marca la zona como descartada (§4) y reanuda el patrullaje **hacia el próximo waypoint** de la ruta. `VALIDATED`: el dron sigue sobre el objetivo (órbita o seguimiento) hasta un `resume_patrol`. **Al reconectarse un dron, el hub le reenvía las decisiones de sus alertas de los últimos 10 minutos** (con `resent: true`), por si se decidieron mientras estaba desconectado |
| `resume_patrol` | `orderedBy, fromIndex?` | Reanuda el patrullaje; con `fromIndex` vuela hacia ese nodo, **sin él hacia el próximo nodo de la ruta (el que tenía por delante cuando se interrumpió)**. **Termina el seguimiento de un objetivo, si lo había** |
| `start_route` | `routeId, fromIndex, orderedBy` | Comienza a patrullar esa ruta. **Con el dron en el suelo es despegar solo: pide GPS, punto de retorno y la misma batería que `takeoff`; si no, `DRONE_PROBLEM` con el motivo** |
| `stop_patrol` | `orderedBy` | Interrumpe el patrullaje: el dron queda en vuelo estacionario (`PAUSED`) |
| `force_goto` | `routeId, index, orderedBy` | Vuela forzado hacia ese nodo y queda estacionario sobre él (`FORCED`) |
| `control_taken` | `by` | Entra en control manual (`MANUAL`): vuelo estacionario a la espera de movimientos. **Con un objetivo en seguimiento, la app lo sigue estimando con las detecciones mientras el operador vuela** |
| **`takeoff`** | **`by`** | **Despegue automático en el lugar (~1,2 m, el del SDK) y queda suspendido a la espera del mando. Solo con el control manual tomado y el dron en el suelo. No exige GPS (la aeronave se sostiene con sus sensores de visión); sí exige enlace con la aeronave y batería: ni al 25 % o menos, ni por cambiar (aterrizó con la batería baja y todavía no se la cambió, aunque después se haya tomado el control o la lectura haya rebotado; la batería nueva se reconoce por una lectura de 50 % o más en el suelo). Si no despega, la app avisa el motivo con un `DRONE_PROBLEM`** |
| **`land`** | **`by`** | **Aterriza donde está. Solo con el control manual tomado y el dron en el aire. Al tocar el suelo el control sigue tomado (`MANUAL` en el suelo)** |
| `manual_move` | `bearing, distanceM, by` | **Desplazamiento puntual** de esa distancia en ese rumbo (solo en `MANUAL`, en el aire y con GPS) |
| `manual_stick` | `pitch, roll, yaw, throttle, by` | **Vuelo continuo con palancas** (solo en `MANUAL` y **en el aire**: en el suelo se descarta en silencio, la consola muestra "despegá primero"): cada eje es un número en `[-1, 1]` y el dron lo sostiene hasta el mensaje siguiente. Ver §3.b |
| **`manual_gimbal`** | **`pitch, by`** | **Inclina la cámara a `pitch` grados, en ángulo ABSOLUTO** (`0` horizonte, negativo hacia abajo; llega ya recortado a `[-90, 30]`). **Solo con el control manual tomado (`MANUAL`), en el suelo o en el aire**: inclinar la cámara no mueve al dron. En cualquier otro estado se descarta en silencio (patrullando, orbitando o siguiendo, la cámara la maneja la app). No cambia el estado ni toca el vuelo; la inclinación nueva se ve en `status.gimbalPitch`. **Al salir de `MANUAL` la app tira la inclinación que todavía no le pasó al gimbal: después de salir, al gimbal solo puede llegarle la que ya estaba cumpliendo, y la cámara que apunta el estado siguiente (la de patrulla al retomar la ruta, la de la órbita o el seguimiento al volver al objetivo) sale después de esa, nunca antes.** Ver §3.b |
| `control_released` | `by` | Sale del control manual. **Con un objetivo en seguimiento, el dron vuelve a él (`ORBITING` o `FOLLOWING`, evento `TRACKING_RESUMED`)**; sin objetivo, si no llega un `resume_patrol` a continuación queda `PAUSED` |
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
| `video_frame` | `droneId, jpegBase64, ts` (JPEG de 640 px de ancho; todos los cuadros que emite el controlador: 5 por segundo con el dron real) |
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
virtual** —las palancas y **la inclinación de la cámara**—, y sube por acá
justamente porque no es una acción suelta sino un flujo:

| Mensaje | Campos | Efecto en el backend |
|---|---|---|
| `manual_stick` | `droneId, pitch, roll, yaw, throttle` | Si se acepta, se reenvía al dron como `manual_stick` con `by: <username>`. No genera registro |
| **`manual_gimbal`** | **`droneId, pitch`** | **Si se acepta, se reenvía al dron como `manual_gimbal` con `pitch` recortado a `[-90, 30]` y `by: <username>`. No genera registro** |

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

### Zona muerta: |eje| < 0,05 es cero

Un eje cuyo valor absoluto sea **menor** que `0,05` se toma como `0`. El borde
exacto `0,05` **no** es zona muerta (la comparación es estricta): `0.05` mueve el
dron, `0.049` no. Es lo que evita que el mando de la consola —un dedo sobre una
pantalla— deje al dron con una deriva de la que nadie se hace cargo al soltar
despacio la palanca.

La zona muerta la aplican **los dos extremos y no el backend**:

| Quién | Qué hace | Dónde |
|---|---|---|
| Consola web | La aplica **antes de emitir**: un eje bajo el umbral sale como `0` | `MandoVirtual.ZONA_MUERTA` en el frontend |
| Comando Central | **No la aplica**: solo recorta a `[-1, 1]` y reenvía el valor tal cual llegó | `eje()` en `ws.ts` |
| App de control | La aplica **al traducir a velocidades**, después de recortar | `MandoVirtual.ZONA_MUERTA` en el Android |

Para cualquier otro cliente del Comando Central esto importa: mandar
`pitch: 0.03` es un mensaje **válido** —el hub lo acepta y lo reenvía— pero el
dron **no se va a mover**, porque la app se lo come por zona muerta. Si hace
falta el movimiento más chico posible, el valor a mandar es `0,05`.

### Ritmo y cierre

La consola emite a **10 Hz** mientras el mando está tomado, y al soltar la
palanca manda **un último mensaje con los cuatro ejes en `0`**: ese mensaje es el
que deja al dron en vuelo estacionario. Por eso un mando todo en cero es un
mensaje válido y no se filtra.

### Inclinación de la cámara (`manual_gimbal`)

```json
{ "type": "manual_gimbal", "droneId": "a3f9c1…7e42", "pitch": -45 }
```

`pitch` es la inclinación **ABSOLUTA** de la cámara en grados, no un
incremento: `0` es el horizonte, los negativos miran hacia abajo y `-90` es
derecho al suelo. El rango válido es **`[-90, 30]`**: por arriba del horizonte
se deja un poco para mirar un techo o un balcón (cuánto sube de verdad lo decide
la aeronave y su ajuste de inclinación hacia arriba).

- Tiene que ser un **número**: un texto (`"-30"`), `null` o un campo ausente
  descartan el mensaje. Convertirlos daría un `0` que nadie escribió, y eso es
  apuntar la cámara al horizonte.
- Un valor fuera de rango **no se descarta: se recorta** (`-120` llega como
  `-90`), por lo mismo que los ejes de las palancas: sale de un deslizador o de
  un arrastre, y lo que el operador quiso decir es "todo para abajo".
- La consola lo emite **a 10 Hz como mucho, y manda el último valor**: mientras
  el operador arrastra no hace falta mandar cada posición intermedia. Lo emite
  solo mientras tiene el lock de ese dron.
- Se acepta con **las mismas condiciones que `manual_stick`** (ver "Cuándo se
  acepta"), salvo el cupo de ritmo, que es **propio** (ver más abajo).
- La app lo aplica solo en `MANUAL` (§2) y el dron informa la inclinación en la
  que quedó en `status.gimbalPitch` (§1).
- Con el dron real, la app le pasa al gimbal **una inclinación por vez**: espera
  a que el SDK conteste la anterior (con un tope de 2 s) y deja al menos 300 ms
  entre una y otra. Las que llegan mientras tanto se pisan y va la última, que
  no se pierde mientras el dron siga en `MANUAL`. Diez órdenes por segundo al
  gimbal eran diez recorridos que se interrumpían entre sí.
- **Al salir de `MANUAL`** (se soltó el control, se retomó la ruta, batería
  baja, pérdida de señal…) **la inclinación que esperaba su turno se tira**: la
  que el gimbal ya estaba cumpliendo termina —no hay forma de retirársela—, pero
  ninguna otra de la consola le llega después. Y la cámara que apunta la app en
  los modos autónomos va **por la misma fila**, así que sale detrás de esa y no
  la puede pisar una inclinación vieja: antes, una que esperaba llegaba 300 ms
  después de que la ruta apuntara a la de patrulla, y la ruta —que apunta una
  sola vez— seguía mirando al horizonte sin poder ubicar ninguna detección.
- Con la cámara **al horizonte o más arriba**, lo que el detector ve no se
  puede ubicar en el terreno: la alerta sale sin posición del objetivo y sin
  seguimiento (§4, "Qué hace la app con una detección").

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
4. Su rol es `operator` o superior. La jerarquía es la de siempre
   (`field_operator` < `operator` < `supervisor` < `admin`), así que el
   supervisor y el admin también vuelan; un rol que **no** esté en esa jerarquía
   se rechaza en vez de dejarlo pasar.

Los puntos 3 y 4 se releen **de la base en cada mensaje**, igual que hace la API
REST con cada request: a un operador al que le acaban de quitar `canControl` o
bajarle el rol no le sirve tener el socket abierto de antes.

Además hay dos topes que no dependen del permiso de nadie, porque su razón de
ser es que una sola consola no pueda dejar sin Comando Central a todo el resto
(el hub es un solo proceso para todas las consolas y todos los drones):

- **Tamaño.** Un frame de más de 1 MiB cierra esa conexión con el código `1009`.
  El tope es grande porque por este mismo servidor entra el video del dron, que
  pesa decenas de KB por cuadro. Encima de eso, un mensaje de consola de más de
  1 KiB se descarta **sin decodificarlo ni parsearlo**: un `manual_stick` no
  llega a 200 bytes, y decodificar y parsear es justamente el trabajo caro que
  conviene no regalar. Ese 1 KiB se cuenta en **bytes del frame como llegó**, no
  en letras: un mensaje lleno de acentos o de eñes pesa en UTF-8 más que su largo
  en caracteres y el que se pasa de 1 KiB en bytes se descarta igual.
- **Ritmo.** Cada socket tiene un cupo de mando que se repone solo. El contrato
  manda 10 Hz y el cupo tolera el doble sostenido, más una ráfaga para absorber
  los tirones del temporizador del navegador: corta la inundación, no al
  operador que está volando. **Las palancas y la cámara tienen un cupo cada
  una**: el operador puede arrastrar la cámara mientras sostiene la palanca, y
  con un cupo compartido la cámara le podría comer al mando el mensaje de los
  cuatro ejes en cero que deja al dron estacionario.

Si algo de eso no se cumple, el mensaje se descarta **en silencio**: no se le
contesta nada a la consola. Contestar no serviría, porque la consola ya se entera
del estado del lock por `control_changed`, y a 10 Hz una respuesta por cada
mensaje descartado sería una avalancha que nadie mira. Un frame que no es JSON,
uno que es JSON pero no un objeto (`null`, un arreglo, un número suelto) y un
`type` que el hub no conoce también se ignoran sin cortar la conexión.

**El mando —palancas y cámara— no deja entradas en el registro.** A 10 Hz
inundaría la tabla `events` y taparía todo lo demás. Lo que queda registrado es
tomar y soltar el control (`CONTROL_TAKEN` / `CONTROL_RELEASED`), que es lo que
la auditoría necesita: quién tuvo el mando de qué dron y desde cuándo.

## 4. App de control (celular) ↔ Software de detección (notebook)

El celular va enganchado al control RC-N2/RC-N3 por su **único puerto USB**,
así que el enlace con la notebook que corre la detección es **por Wi-Fi, sí o
sí** (el USB-C de abajo del control es solo carga y DJI Assistant). Celular y
notebook tienen que estar en la misma red: el hotspot del celular o la Wi-Fi
del lugar. Hay tres modos, elegibles desde la app:

### Modo `AUTO` (por defecto): la notebook se anuncia

El servidor de detección (`detection/servidor.py`) manda **cada segundo**, por
UDP a toda la red (broadcast, puerto **8766**), un anuncio:

```json
{ "service": "dronepatrol-detection", "port": 8765, "name": "notebook-campo" }
```

La app escucha ese puerto (`DescubridorDeDeteccion`), toma la dirección de la
que vino el datagrama y se conecta a `ws://<esa-ip>:<port>/phone`. Cualquier
otro datagrama se ignora: solo cuenta un JSON con ese `service` y un puerto
válido. Si llega un anuncio de otra dirección (la notebook cambió de IP), la
app cierra el socket y se va a la nueva. Mientras no llegó ninguno, la pantalla
dice que está buscando; no es un fallo.

El servidor manda el anuncio **por cada interfaz de red real** (con un socket
atado a la IP de esa interfaz): al broadcast dirigido calculado con la
**máscara verdadera** de la interfaz (una red /22 como `192.168.68.0/22` tiene
el broadcast en `192.168.71.255`, no en `.255` del tercer octeto) y a
`255.255.255.255`. Las interfaces virtuales (VMware, Hyper-V/WSL, VPN TAP/TUN,
loopback, APIPA `169.254/16`) se saltean. La app toma un `MulticastLock` de
Wi-Fi para que el teléfono no filtre los broadcast en el chip.

**El descubrimiento es de ida y vuelta.** Mientras busca, la app también se
anuncia: cada 2 s manda por broadcast al puerto **8766**

```json
{ "service": "dronepatrol-app", "port": 8766, "name": "S23 Ultra" }
```

y el servidor, que escucha ese puerto, le contesta **por unicast** a la IP de
origen con el mismo anuncio de siempre (`dronepatrol-detection`). Así el enlace
se arma aunque el broadcast de la PC se pierda (Windows lo manda por una sola
interfaz, una VPN con mejor métrica se lo lleva, el router no lo reenvía): el
del teléfono casi siempre llega, y la respuesta unicast también.

En el teléfono, los sockets de la detección (el UDP del descubrimiento y el
WebSocket) se atan a la **red Wi-Fi** cuando hay una: con una Wi-Fi sin
internet (el router del lugar, sin salida) Android pasa la red por defecto a
los datos móviles y un socket sin red asignada nunca llegaría a la notebook.
Con el teléfono como hotspot no hay red Wi-Fi cliente y se usa la de siempre.

### Modo `CABLE` (banco de pruebas)

Túnel de ADB sobre el cable USB, **solo sin el control enchufado** (emulador o
pruebas de escritorio). En la laptop, una vez: `adb reverse tcp:8765 tcp:8765`,
y la app se conecta a `ws://127.0.0.1:8765/phone`.

### Modo `RED` (respaldo)

URL manual (`ws://<ip-de-la-notebook>:8765`), para cuando los anuncios no
llegan (una red que filtra broadcast). Desde el emulador de Android Studio la
PC es `ws://10.0.2.2:8765`.

### Contrato de mensajes

Este es el contrato que implementa `detection/servidor.py` (el software real,
con YOLO11) y que `detection-mock/` respeta como placeholder sin GPU.

| Dirección | Mensaje | Campos |
|---|---|---|
| celular → notebook | `video_frame` | `jpegBase64, ts` (JPEG de **1280 px de ancho**, calidad 75, **hasta 2 por segundo**). **`ts` es la hora de captura del cuadro, con el reloj del teléfono** |
| notebook → celular | `detection` | `detected (bool), classes (["PERSON"\|"VEHICLE"]), confidence, boxes[], snapshotBase64?, ts`, **`frameTs`** |

**`frameTs` es el `ts` del `video_frame` que se analizó, devuelto tal cual.**
Entre la captura y la respuesta pasan de 0,3 a 1 s (cola, Wi-Fi, inferencia), y
en ese lapso el dron se movió y giró: la app georreferencia la caja con la pose
del dron **en el instante del cuadro** (guarda los últimos segundos de
telemetría y usa la muestra más cercana a `frameTs`), no con la de cuando llegó
la respuesta. `ts` sigue siendo la hora del servidor.

Cada elemento de `boxes` es `{cls, conf, x, y, w, h}` con **`x`, `y` el centro
y `w`, `h` el tamaño, normalizados 0..1** sobre el cuadro (origen arriba a la
izquierda): así valen igual sobre el cuadro de 1280 px que analizó el detector
y sobre el de 640 px que mira la consola. `snapshotBase64` es el **cuadro
anotado con las cajas**, reducido a 640 px, y viene solo con `detected: true`:
es la captura que la app adjunta a la alerta. `boxes` y `snapshotBase64` son
opcionales (el mock no los manda): sin ellos la app orbita su propia posición y
adjunta el último cuadro de la consola.

Es un flujo **aparte** del que va al Comando Central (ver el principio de este
documento): más grande y más espaciado. El servidor contesta **un `detection`
por cada cuadro procesado**, detecte o no; si la GPU no da abasto descarta el
cuadro viejo y nunca acumula retraso.

### Qué hace la app con una detección

1. **Guarda las cajas** y las dibuja sobre el video que sube al Comando Central
   durante 1,5 s (`PatrolManager.VIGENCIA_CAJAS_MS`), en cualquier estado: el
   operador ve marcado lo que el detector ve, también mientras orbita.
2. **Ubica cada caja en el terreno** con la pose del dron en el instante del
   cuadro (`frameTs`): altura, rumbo de la cámara e inclinación del gimbal
   (`Georreferencia`). Sin GPS o por debajo de 2 m de altura no hay proyección
   posible, y tampoco para una caja cuyo rayo no baja al menos 5° por debajo
   del horizonte (la cámara al horizonte o más arriba, que el operador puede
   pedir con `manual_gimbal`). En todos esos casos la caja queda **sin
   posición**, nunca con la del dron, que con la cámara levantada es justo
   donde el objetivo no está. Una detección sin cajas (el detector de
   respaldo) cuenta en la posición del dron solo si el centro del cuadro se
   puede proyectar; si no, también queda sin posición.
3. **Toda detección confirmada avisa al Comando Central**: dos detecciones de
   la misma clase en menos de 2,5 s y a menos de 25 m una de otra (un solo
   cuadro no alerta). No se alerta despegando (el detector ve al equipo de
   tierra) ni volviendo a base. Las detecciones que caen en una **zona
   descartada** (40 m alrededor de un falso positivo descartado en los últimos
   5 minutos) no alertan, y en los 10 s siguientes a retomar la ruta por un
   descarte tampoco.
4. Cómo alerta depende de dónde está el dron:
   - **En el aire, a 8 m o más y con GPS, patrullando, en pausa o en un
     desvío**: **orbita el objetivo** a 30 m con la cámara apuntada al centro
     y arranca el seguimiento (`ORBIT_STARTED`).
   - **En control manual** (en el aire, con GPS): arranca el seguimiento SIN
     mover al dron (`TARGET_DETECTED`); al soltar el control, el dron va al
     objetivo.
   - **En el suelo, a baja altura, sin GPS o con el objetivo sin posición**
     (o en el aire sin patrullar): alerta sin seguimiento (`DETECTION`), como
     mucho una por minuto.
   En todos los casos manda `alert_request` (tipo, **captura anotada**,
   posición del objetivo si se pudo ubicar, confianza, pose del dron y un
   `ref`) y, con seguimiento, queda a la espera del `alert_ack`.
5. **Seguimiento.** Mientras haya objetivo (órbita, seguimiento o control
   manual del operador), cada detección de la misma clase que cae cerca de
   donde se lo espera se asocia a él y alimenta un filtro de velocidad
   constante (`RastreadorDeObjetivo`): posición suavizada y velocidad.
   - Si **se mueve** (más de 1,2 m/s sostenido en 3 detecciones, o más de 15 m
     desde donde se lo vio quieto): deja la órbita y **lo sigue** a 25 m, del
     lado en que está, copiando su velocidad, con la nariz y el gimbal
     apuntados a él (`FOLLOWING`, evento `TARGET_MOVING`).
   - Si **se detiene** (menos de 0,6 m/s durante 6 s): vuelve a orbitarlo donde
     quedó (`ORBITING`, `TARGET_STOPPED`). Orbitando, si la estimación se corre
     más de 6 m, el centro de la órbita la acompaña sin cortar el giro.
   - Si **se pierde** (10 s sin detecciones asociadas): orbita la última
     posición estimada y avisa `TARGET_LOST` con esa posición, que es la que
     necesita el equipo de tierra. Si vuelve a aparecer cerca (70 m), lo
     retoma (`TARGET_REACQUIRED`).
6. **Decisión del operador** (`alert_decision` de la alerta del objetivo):
   `DISMISSED` termina el seguimiento, marca la zona como descartada y retoma
   la ruta **hacia el próximo waypoint**; `VALIDATED` sigue sobre el objetivo
   hasta un `resume_patrol`. El operador puede tomar el control manual en
   cualquier momento; al soltarlo el dron vuelve al objetivo.
7. El seguimiento termina con un `resume_patrol`, un regreso a base (batería
   baja, señal perdida, orden del campo) o un aterrizaje, y deja
   `TRACKING_ENDED` con la última posición conocida.

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
| POST | `/api/drones/:droneId/resume` | operador+ | `{fromIndex?}`: reanuda hacia ese nodo o **hacia el próximo de la ruta**. Libera el control manual y **termina el seguimiento de un objetivo** |
| POST | `/api/drones/:droneId/goto` | con `canControl` | `{routeId, index}`: fuerza el vuelo hacia ese nodo |
| POST | `/api/drones/:droneId/control` | con `canControl` | Toma el control manual (409 si otro lo tiene) |
| DELETE | `/api/drones/:droneId/control` | titular o supervisor+ | `{resume: 'last'\|'none'\|número}`. **Con un objetivo en seguimiento la consola manda `'none'`: el dron vuelve al objetivo.** Si el titular se desconecta, el hub suelta el control con `'none'` cuando el último status del dron trae `target`, y con `'last'` si no |
| **POST** | **`/api/drones/:droneId/takeoff`** | **titular del control (con `canControl`)** | **Despegue en el lugar (§2 `takeoff`). 409 si no tenés el control. Registra `TAKEOFF_ORDERED`** |
| **POST** | **`/api/drones/:droneId/land`** | **titular del control (con `canControl`)** | **Aterriza donde está (§2 `land`). 409 si no tenés el control. Registra `LANDING_ORDERED`** |
| POST | `/api/drones/:droneId/manual_move` | titular del control | `{bearing, distanceM}`: desplazamiento puntual (la consola manda 25 m por click) |

El **mando virtual con palancas no está en esta tabla y no va a estar**: viaja por
el WebSocket de la consola (§3.b) porque son ~10 mensajes por segundo mientras el
operador sostiene la palanca. **La inclinación de la cámara (`manual_gimbal`)
tampoco**, por lo mismo.

### Alertas

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/alerts?status=` | operador+ | Lista de alertas |
| **GET** | **`/api/alerts/:id`** | operador+ | Alerta completa **con la captura del video**; la usa el pop-up del registro |
| POST | `/api/alerts/:id/decision` | operador+ | `{decision: VALIDATED\|DISMISSED}`; registra quién decidió y notifica al dron |

### Usuarios

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/users` | supervisor+ | **`?includeDeleted=1`**, `?q=` (usuario, nombre, DNI con o sin puntos o ceros adelante, o rol). Supervisor ve operadores; admin ve todos |
| POST | `/api/users` | admin | `{username, fullName, dni, role, canControl}`. **`dni` es obligatorio**: texto, con o sin puntos/espacios, se guarda en dígitos **sin ceros a la izquierda** (`"05.123.456"` → `"5123456"`, como figura adentro del CUIL) y vale con 7 u 8 dígitos ya sin esos ceros (`"00000000"` → 400). Repetido entre cuentas no eliminadas → 409, también si se lo escribe con otros ceros adelante. **`role` acepta `field_operator`**, al que se le fuerza `canControl:false`. La contraseña la genera el sistema y viaja una sola vez en la respuesta |
| PATCH | `/api/users/:username` | supervisor+ (solo `canControl` de operadores) / admin (todo) | `{canControl?, active?, fullName?, dni?, role?}`. `role` solo entre `operator`, `supervisor` y `field_operator`, nunca desde ni hacia `admin`; el cambio de rol **cierra la consola** del usuario (4403) y **termina su sesión**: el token de antes ya no vale (401 en la API, 4401 al reconectar el WebSocket), así que vuelve a entrar con el rol nuevo; y pasar a `field_operator` apaga `canControl` y suelta los drones que controlara. Registra antes y después |
| **DELETE** | **`/api/users/:username`** | admin | **Borrado lógico**. Cierra sus sockets y libera los drones que controlara. Libera el DNI |
| **POST** | **`/api/users/:username/restore`** | admin | Restaura un usuario eliminado. 409 si otra cuenta viva tomó su DNI |

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
                  "gpsFix": true, "routeId": 1, "waypointIndex": 2, "waypointTotal": 4,
                  "signal": "OK", "signalPct": 78, "heading": 132, "mode": "TEST",
                  "alt": 40, "satellites": 14, "flying": true, "flightMode": "P-GPS",
                  "gimbalPitch": -70, "target": null }
}
```

## 7. Forma de `meta` por tipo de evento

Piezas que se repiten: `Dron = {hash, displayName, model}` ·
`EstadoDron = {displayName, model, activo, eliminado, base, baseLat, baseLon}`
(plano a propósito, para que la comparación del pop-up sea campo a campo) ·
`UserView = {username, fullName, dni, role, active, canControl, deleted, deletedAt}` (`dni` en dígitos y sin ceros a la izquierda; vacío en las cuentas anteriores al DNI).

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
| drone | **`TAKEOFF_ORDERED` / `LANDING_ORDERED`** | **`{drone, detalle: {por}}`** |
| drone | `ALERT_CREATED` | `{alerta: {id, tipo, lat, lon, ts}, drone, detalle: {confianza, clases, dronLat, dronLon, dronAlt}}` (**`detalle` es nuevo**; cada campo puede faltar) |
| drone | `ALERT_VALIDATED` / `ALERT_DISMISSED` | `{alerta: {id, tipo}, decision, por, antes: {estado}, despues: {estado, decidedBy, decidedAt}, drone}` |
| drone | Eventos que reporta la app (`PATROL_STARTED`, `SIGNAL_LOST`, `RTH_LOW_BATTERY`, `TARGET_MOVING`, …) | `{drone}` **+ `alerta: {id, tipo, lat, lon, ts}` si el evento trae un `alertId` de una alerta de ese dron, + `ubicacion: {lat, lon, accuracyM: null}` si trae `lat`/`lon` válidos** |
| usuarios | `USER_CREATED` | `{despues: UserView}` |
| usuarios | `USER_UPDATED` / `USER_DELETED` / `USER_RESTORED` | `{antes: UserView, despues: UserView}` |
| sistema | `FIELD_SESSION_CLOSED` | `{detalle: {por, motivo}}` |
| sistema | `LOGIN` / `LOGIN_FAILED` / `LOGIN_REJECTED` | — |
