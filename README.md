# Sistema de patrullaje autónomo con drones — MVP

MVP de la primera entrega: un DJI Mini 4 Pro patrulla rutas predefinidas,
transmite video a un software de detección de personas/vehículos y, ante una
detección, orbita el objetivo y alerta a un Comando Central donde un operador
valida o descarta la alerta.

## Arquitectura

```
   DJI Mini 4 Pro
        │ enlace RC (video + telemetría + comandos)
        ▼
   RC-N2 ── USB ── Celular Android (android-app/)
                     │  lógica de patrullaje: rutas, pérdida de señal,
                     │  batería baja, órbita ante detección
                     │
        ┌────────────┼──────────────────┐
        │ frames JPEG (WS)              │ eventos / alertas / status / video (WS+REST, JWT)
        ▼                               ▼
   Laptop junto al control         Comando Central (backend/)
   Software de detección           Express + SQLite + WebSocket
   (detection-mock/ *)                  │
        │ detección persona/vehículo    ▼
        └────────► celular         Consola del operador (frontend/)
                                   React + Vite: video en vivo, alertas
                                   (validar / falso positivo), logs, JWT
```

\* `detection-mock/` es un **placeholder** del software de análisis de imágenes
(próxima etapa). Implementa el contrato definitivo de mensajes
(`docs/PROTOCOLS.md`), así el módulo real de visión lo reemplaza sin tocar la app.

## Componentes

| Carpeta | Qué es | Stack |
|---|---|---|
| `backend/` | Comando Central: API REST + WebSocket, auth JWT, log de eventos y alertas en SQLite | Node 20+, Express, TypeScript |
| `frontend/` | Consola del operador: login, video en vivo, alertas con decisión, registro de eventos | React + Vite + TypeScript |
| `detection-mock/` | Visor que recibe el video del celular y simula detecciones con botones | Node, ws |
| `android-app/` | App de control que corre en el celular del RC-N2 | Kotlin, coroutines, OkHttp |
| `docs/PROTOCOLS.md` | Contratos de mensajes entre los cuatro procesos | — |

## Cómo levantar todo

Un solo comando levanta los tres servicios (la app Android va aparte, desde
Android Studio):

```bash
./start.sh
```

Usa **Docker** si el daemon está corriendo y, si no, cae a **modo nativo**
(npm local). Al terminar imprime las URLs, los usuarios de demo y las
direcciones que hay que cargar en la app Android. **Ctrl+C** baja todo.

| Comando | Qué hace |
|---|---|
| `./start.sh` | Docker si está disponible; si no, nativo |
| `./start.sh docker` | Fuerza Docker Compose |
| `./start.sh native` | Fuerza npm local (requiere Node 20+) |
| `./start.sh stop` | Detiene y **elimina** los contenedores (los datos se conservan) |
| `./start.sh reset` | Borra la base de datos (se resiembra sola) |
| `./start.sh stop reset` | Elimina los contenedores y también sus volúmenes |

Requisitos: **Docker Desktop** *o* **Node 20+**, más Android Studio para la app.
En Windows, correr el script desde Git Bash o WSL. Los logs de cada servicio
quedan en `logs/` (modo nativo) o en `docker compose logs` (modo Docker).

| Servicio | URL |
|---|---|
| Consola del operador | http://localhost:5173 |
| Comando Central (API) | http://localhost:4000 |
| Visor de detección | http://localhost:8765 |

Credenciales de demo (creadas por el seed). **Cada dron tiene su propia cuenta**:
es con ella que la app inicia sesión y se identifica ante el Comando Central.

| Usuario | Contraseña | Rol | Nombre visible | Base |
|---|---|---|---|---|
| `operador` | `operador123` | Operador: ve y decide alertas, controla drones | — | — |
| `supervisor` | `supervisor123` | Supervisor: gestiona operadores y su permiso de control | — | — |
| `admin` | `admin123` | Administrador: usuarios y registro del sistema | — | — |
| `drone1` | `drone123` | App de control | Alfa | Base Norte |
| `drone2` | `drone123` | App de control | Bravo | Base Sur |
| `drone3` | `drone123` | App de control | Charlie | Base Este |

El nombre visible se puede cambiar desde la app **y** desde el Comando Central;
el cambio se propaga al otro lado.

### App Android

Abrir `android-app/` en Android Studio, elegir la variante **`mockDebug`** y
correr. En la pantalla de la app, cargar:

- **Emulador**: `http://10.0.2.2:4000` y `ws://10.0.2.2:8765`
- **Teléfono físico**: la IP de LAN que imprime `start.sh` al arrancar.

### Levantar los servicios a mano

Si preferís correr cada uno por separado: `npm install && npm run seed &&
npm run dev` en `backend/`, `npm install && npm run dev` en `frontend/`, y
`npm install && npm start` en `detection-mock/`.

## Guion de demo (mapea cada requisito)

1. **Login del operador** en `http://localhost:5173` (JWT).
2. En la app: **Conectar** → elegir **ruta** → **Comenzar patrullaje**.
   La consola muestra estado, batería, señal y el video en vivo; el log
   registra `PATROL_STARTED`.
3. **Detección**: en `http://localhost:8765` apretar *Detectar PERSONA*.
   El dron pasa a **órbita**, llega la alerta con snapshot a la consola.
4. **Falso positivo**: *Falso positivo* en la consola → el dron **reanuda el
   patrullaje** desde el waypoint donde quedó; queda logueado quién decidió.
5. **Alerta válida**: repetir detección → *Validar alerta* → queda registrada
   como real, el dron **mantiene la órbita**; *Reanudar patrullaje* lo libera.
   (El aviso a tropas de tierra queda para una etapa posterior.)
6. **Pérdida de señal**: activar el switch en la app → a los ~4 s se loguea
   `SIGNAL_LOST` + `RTH_SIGNAL_LOSS` (el dron vuelve a base por failsafe).
   Desactivarlo → `SIGNAL_RECOVERED` + `PATROL_RESUMED`: **continúa la ruta**.
7. **Batería baja**: botón *Forzar batería baja* → `RTH_LOW_BATTERY`, vuelve a
   base y aterriza (`LANDED`). Todo queda en el registro de eventos con
   marca temporal, tipo y origen.

## Decisiones y supuestos de esta entrega

- **"Bright"** de la transcripción se interpretó como **Vite**.
- **Alerta validada** → el dron sigue orbitando y el operador lo libera con
  *Reanudar patrullaje*. Falso positivo → reanuda solo. (Fácil de cambiar si
  se prefiere reanudación automática en ambos casos.)
- La **órbita** se centra en la posición actual del dron al momento de la
  detección; georreferenciar el objetivo detectado es parte de la etapa de visión.
- **Video**: JPEG base64 a ~2 fps por WebSocket — suficiente para el MVP y
  trivial de depurar. Subir tasa/calidad es un cambio de transporte, no de diseño.
- **Mini 4 Pro + MSDK v5**: no hay misiones de waypoints nativas para este
  modelo (solo Enterprise); el patrullaje usa **Virtual Stick**. Ver
  `android-app/README.md`.
- El celular envía el video a laptop y backend por separado (dos streams):
  independencia entre detección y monitoreo a costo de ancho de banda local.

## Fuera de alcance (según lo acordado)

Algoritmo real de visión, aviso a tropas de tierra, múltiples drones,
editor de rutas en mapa, HTTPS/hardening de producción.
