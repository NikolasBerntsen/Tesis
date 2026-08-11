# Contratos de mensajes (MVP)

Todos los enlaces usan WebSocket con mensajes JSON en texto. Los frames de video
viajan como JPEG codificado en base64 (~640x360, calidad 60, ~2 fps) para
mantener el MVP simple.

El sistema soporta **varios drones simultáneos**. Cada dron se identifica con su
propia cuenta (usuario/contraseña) y su `droneId` es el `username` de esa cuenta,
tomado del JWT: nunca lo declara el cliente.

## 0. Modelo de datos

Cada cuenta de dron lleva asociados:

| Campo | Descripción |
|---|---|
| `droneId` | `username` de la cuenta. Inmutable, identifica al dron en todo el sistema |
| `displayName` | Nombre visible. **Editable desde la app y desde el Comando Central**, y el cambio se propaga al otro lado |
| `base` | `{ name, lat, lon }`: la base a la que vuelve. Se dibuja como cuadrado azul en los mapas |

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
| `state` | string | `IDLE`, `PATROLLING`, `ORBITING`, `RETURNING_HOME_SIGNAL`, `RETURNING_HOME_BATTERY`, `LANDED` |
| `battery` | number | Porcentaje 0..100 |
| `lat`, `lon` | number | Posición actual |
| `routeId` | number \| null | Ruta que está patrullando |
| `waypointIndex` | number | Índice 0-based del último waypoint alcanzado |
| `waypointTotal` | number | Cantidad de waypoints de la ruta. La UI muestra `waypointIndex + 1` de `waypointTotal` |
| `signal` | `OK` \| `LOST` | Estado del enlace RC |
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
| `resume_patrol` | `orderedBy` | Sale de la órbita y reanuda el patrullaje |
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
| GET | `/api/drones` | JWT operador | Todos los drones: `droneId, displayName, base, online, lastStatus` |
| PATCH | `/api/drones/:droneId` | JWT operador | `{displayName}`; renombra y avisa al dron con `renamed` |
| GET | `/api/alerts?status=` | JWT operador | Lista de alertas |
| POST | `/api/alerts/:id/decision` | JWT operador | `{decision: VALIDATED\|DISMISSED}`; registra quién decidió y notifica al dron |
| POST | `/api/drones/:droneId/resume` | JWT operador | Saca al dron de la órbita y lo devuelve a su ruta |
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
