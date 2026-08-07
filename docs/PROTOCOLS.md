# Contratos de mensajes (MVP)

Todos los enlaces usan WebSocket con mensajes JSON en texto. Los frames de video
viajan como JPEG codificado en base64 (~640x360, calidad 60, ~2 fps) para
mantener el MVP simple; si hiciera falta más tasa/resolución se cambia el
transporte, no la arquitectura.

## 1. App de control (celular) → Comando Central

Conexión: `ws://<backend>:4000/ws?token=<JWT>` (el rol `drone` sale del token).

| Mensaje | Campos | Efecto en el backend |
|---|---|---|
| `status` | `state, battery, lat, lon, routeId, waypointIndex, signal` | Se reenvía a los operadores (no se persiste; es efímero) |
| `event` | `eventType, message` | Se persiste en `events` y se reenvía a los operadores |
| `video_frame` | `jpegBase64, ts` | Se reenvía a los operadores |
| `alert_request` | `alertType (PERSON\|VEHICLE), lat, lon, snapshotBase64` | Crea fila en `alerts` (PENDING) + evento `ALERT_CREATED`, y se notifica a los operadores |

`eventType` usados por la app: `PATROL_STARTED`, `PATROL_RESUMED`, `SIGNAL_LOST`,
`SIGNAL_RECOVERED`, `RTH_SIGNAL_LOSS`, `RTH_LOW_BATTERY`, `ORBIT_STARTED`, `LANDED`.

## 2. Comando Central → App de control

| Mensaje | Campos | Efecto en el celular |
|---|---|---|
| `alert_decision` | `alertId, decision (VALIDATED\|DISMISSED), decidedBy` | El dron deja el modo órbita y reanuda el patrullaje desde el waypoint guardado |

## 3. Comando Central → Consola del operador (web)

Conexión: `ws://<backend>:4000/ws?token=<JWT>` (rol `operator`).

| Mensaje | Contenido |
|---|---|
| `status` | Último estado del dron (relay) |
| `video_frame` | Frame en vivo (relay) |
| `event` | Evento recién persistido (fila completa) |
| `alert_created` | Alerta nueva (fila completa, incluye snapshot) |
| `alert_updated` | Alerta con decisión tomada |

Las decisiones del operador van por REST: `POST /api/alerts/:id/decision`.

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
| POST | `/api/auth/login` | — | `{username, password}` → `{token, user}` (JWT HS256, 12 h) |
| GET | `/api/routes` | JWT | Rutas de patrullaje disponibles (waypoints incluidos) |
| GET | `/api/alerts?status=` | JWT operador | Lista de alertas |
| POST | `/api/alerts/:id/decision` | JWT operador | `{decision: VALIDATED\|DISMISSED}`; registra quién decidió y notifica al dron |
| GET | `/api/events?limit=` | JWT operador | Log de eventos (más reciente primero) |
| GET | `/api/health` | — | Ping |
