# Contratos de mensajes (MVP)

Todos los enlaces usan WebSocket con mensajes JSON en texto. Los frames de video
viajan como JPEG codificado en base64 (~640x360, calidad 60, ~2 fps) para
mantener el MVP simple.

El sistema soporta **varios drones simultáneos**. Cada dron se identifica con su
propia cuenta (usuario/contraseña) y su `droneId` es el `username` de esa cuenta,
tomado del JWT: nunca lo declara el cliente.

## Roles

| Rol | Permisos |
|---|---|
| `drone` | Cuenta de máquina de la app de control |
| `operator` | Consola: alertas, rutas, eventos de drones. **Controla drones solo si tiene el flag `canControl`** |
| `supervisor` | Todo lo del operador + quitar el control manual a otro usuario + ver operadores y suspender/restaurar su flag `canControl` |
| `admin` | Todo lo anterior + crear/eliminar/desactivar/reactivar usuarios + ver el registro general del sistema |

Los permisos son jerárquicos (un rol incluye a los de menor rango). Los flags
`active` y `canControl` se evalúan **en vivo** en cada request, no desde el JWT:
suspender a un usuario surte efecto inmediato.

## Control manual — bloqueo exclusivo

Un dron puede estar controlado por **un solo usuario a la vez**. El backend
mantiene el lock (`controlledBy`) y lo incluye en la ficha del dron y en cada
`status`. Tomar un dron controlado por otro da `409`; un supervisor puede
forzar la liberación. Si el usuario que controla cierra todas sus conexiones,
el backend libera el lock y reanuda el patrullaje automáticamente.

## Registro (logs)

Toda acción que involucre al sistema queda registrada en la tabla `events`, con
una `category`:

| Categoría | Contenido |
|---|---|
| `drone` | Conexión/desconexión, patrullaje, alertas, batería, señal, control manual, cambios de ruta, renombres de dron y de nodos |
| `usuarios` | Alta, baja, activación, suspensión y modificación de usuarios (con **antes y después** en `meta`) |
| `sistema` | Inicios de sesión (exitosos y fallidos) |

El **log general** (`GET /api/logs`, solo admin) devuelve todas las categorías
juntas; el log de drones (`GET /api/events`, operador+) devuelve solo `drone`.

## 0. Modelo de datos

Cada cuenta de dron lleva asociados:

| Campo | Descripción |
|---|---|
| `droneId` | `username` de la cuenta. Inmutable, identifica al dron en todo el sistema |
| `displayName` | Nombre visible. **Editable desde la app y desde el Comando Central**, y el cambio se propaga al otro lado |
| `base` | `{ name, lat, lon }`: la base a la que vuelve. Se dibuja como cuadrado azul en los mapas |

Cada waypoint de una ruta es `{ lat, lon, alt, label? }`. `label` es un apodo
opcional que pone el operador para identificar zonas puntuales; se muestra al
hacer clic sobre el nodo en el mapa de la vista de detalle. En ese mapa los
nodos se pintan **rojos** mientras están pendientes y **verdes** una vez que el
dron pasó por ellos (índice ≤ `waypointIndex` del `status`).

## 1. App de control (celular) → Comando Central

Conexión: `ws://<backend>:4000/ws?token=<JWT>` (el rol `drone` sale del token).

| Mensaje | Campos | Efecto en el backend |
|---|---|---|
| `status` | ver tabla de abajo | Se guarda como último estado del dron y se reenvía a los operadores |
| `event` | `eventType, message` | Se persiste en `events` y se reenvía a los operadores |
| `video_frame` | `jpegBase64, ts` | Se reenvía a los operadores etiquetado con `droneId` |
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
| `manual_move` | `bearing, distanceM, by` | Se desplaza esa distancia en ese rumbo (solo en `MANUAL`) |
| `control_released` | `by` | Sale del control manual; si no llega un `resume_patrol` a continuación queda `PAUSED` |
| `renamed` | `displayName` | El operador renombró al dron: la app actualiza el nombre que muestra |

## 3. Comando Central → Consola del operador (web)

Conexión: `ws://<backend>:4000/ws?token=<JWT>` (rol `operator`).

| Mensaje | Contenido |
|---|---|
| `status` | Estado de un dron (los campos de arriba + `droneId`, `displayName`) |
| `video_frame` | `droneId, jpegBase64, ts` |
| `event` | Evento recién persistido (fila completa) |
| `alert_created` | Alerta nueva (fila completa, incluye snapshot) |
| `alert_updated` | Alerta con decisión tomada |
| `drone_online` / `drone_offline` | `drone` (ficha completa del dron) |
| `drone_renamed` | `droneId, displayName` |
| `route_updated` | `route` (ruta completa); se emite al cambiar el apodo de un nodo |
| `control_changed` | `droneId, controlledBy` (username o `null`) |

Al conectarse, el operador recibe un `status` por cada dron que esté online, para
poder pintar el dashboard sin esperar al próximo tick.

## 4. App de control (celular) ↔ Software de detección (laptop)

Conexión: `ws://<laptop>:8765/phone`. Este contrato es el que debe implementar
el software real de detección de imágenes; `detection-mock/` es un placeholder
que lo respeta.

| Dirección | Mensaje | Campos |
|---|---|---|
| celular → laptop | `video_frame` | `jpegBase64, ts` |
| laptop → celular | `detection` | `detected (bool), classes (["PERSON"\|"VEHICLE"]), confidence, ts` |

La app solo actúa ante `detected: true` y solo mientras está en estado
`PATROLLING` (evita re-alertar mientras orbita o vuelve a base).

## 5. REST del Comando Central

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{username, password}` → `{token, user}` (JWT HS256, 12 h). Lo usan el operador y la app del dron |
| GET | `/api/me` | JWT | Ficha del usuario autenticado. Para un dron incluye `displayName` y `base` |
| GET | `/api/routes` | JWT | Rutas de patrullaje disponibles (waypoints incluidos) |
| PATCH | `/api/routes/:routeId/waypoints/:index` | JWT operador | `{label}`; pone el apodo de un nodo (vacío lo borra). Emite `route_updated` |
| GET | `/api/drones` | JWT operador | Todos los drones: `droneId, displayName, base, online, lastStatus` |
| PATCH | `/api/drones/:droneId` | JWT operador | `{displayName}`; renombra y avisa al dron con `renamed` |
| GET | `/api/alerts?status=` | JWT operador | Lista de alertas |
| POST | `/api/alerts/:id/decision` | JWT operador | `{decision: VALIDATED\|DISMISSED}`; registra quién decidió y notifica al dron |
| POST | `/api/drones/:droneId/resume` | JWT operador+ | `{fromIndex?}`: reanuda el patrullaje (desde ese nodo, o desde el último alcanzado). Libera el control manual si estaba tomado |
| POST | `/api/drones/:droneId/route/start` | JWT operador+ | `{routeId, fromIndex?}`: comienza esa ruta |
| POST | `/api/drones/:droneId/route/stop` | JWT operador+ | Interrumpe el patrullaje (el dron queda estacionario) |
| POST | `/api/drones/:droneId/goto` | JWT con `canControl` | `{routeId, index}`: fuerza el vuelo hacia ese nodo |
| POST | `/api/drones/:droneId/control` | JWT con `canControl` | Toma el control manual (409 si otro lo tiene) |
| DELETE | `/api/drones/:droneId/control` | titular o supervisor+ | `{resume: 'last'\|'none'\|número}`: libera el control (default `last`) |
| POST | `/api/drones/:droneId/manual_move` | titular del control | `{bearing, distanceM}` |
| GET | `/api/users` | JWT supervisor+ | Supervisor: operadores; admin: todos los usuarios humanos |
| POST | `/api/users` | JWT admin | `{username, password, role (operator\|supervisor), canControl}` |
| PATCH | `/api/users/:username` | supervisor+ (solo `canControl` de operadores) / admin (todo) | `{canControl?, active?, password?}`. Registra antes y después |
| DELETE | `/api/users/:username` | JWT admin | Elimina el usuario |
| GET | `/api/logs?category=&limit=` | JWT admin | Log general del sistema (todas las categorías) |
| GET | `/api/events?limit=&droneId=` | JWT operador | Log de eventos (más reciente primero) |
| GET | `/api/health` | — | Ping |

## 6. Ficha de dron (`drone`)

Forma que devuelven `GET /api/drones` y los mensajes `drone_online` / `drone_offline`:

```json
{
  "droneId": "drone1",
  "displayName": "Alfa",
  "base": { "name": "Base Norte", "lat": -34.8565, "lon": -56.2075 },
  "online": true,
  "lastStatus": { "state": "PATROLLING", "battery": 87, "lat": -34.855, "lon": -56.206,
                  "routeId": 1, "waypointIndex": 2, "waypointTotal": 4,
                  "signal": "OK", "signalPct": 78, "mode": "TEST" }
}
```
