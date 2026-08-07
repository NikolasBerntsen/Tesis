# Drone Patrol — App de control (Android)

App que corre en el dispositivo Android conectado al **DJI RC-N2** y ejecuta la
lógica de patrullaje. La interfaz es mínima a propósito: el foco de esta
entrega es la lógica (`patrol/PatrolManager.kt`).

## Flavors

| Flavor | Qué hace | Cuándo usarlo |
|---|---|---|
| `mock` | Dron **simulado** (`SimulatedDroneController`): waypoints, órbita, RTH, drenaje de batería, failsafe por pérdida de enlace y video sintético. | Desarrollo y demo sin hardware. Corre en emulador o cualquier teléfono. |
| `dji` | Integración real con **DJI MSDK v5** (`DjiDroneController`). | Pruebas de campo con el Mini 4 Pro. |

La lógica (máquina de estados, watchdogs, comunicación) es la misma en ambos:
solo cambia la implementación de `DroneController` que inyecta `ControllerFactory`.

## Correr la demo (flavor mock)

1. Abrir `android-app/` en Android Studio y sincronizar.
2. Elegir la variante `mockDebug` (Build Variants) y correr en un emulador.
3. Con el backend y el detection-mock levantados (ver README raíz), en la app:
   - URLs por defecto (`10.0.2.2` = localhost del host desde el emulador) → **Conectar**.
   - Elegir ruta → **Comenzar patrullaje**.
   - El switch *Simular pérdida de señal* y el botón *Forzar batería baja*
     disparan los flujos de failsafe.

En un teléfono físico, reemplazar `10.0.2.2` por la IP LAN de la laptop.

## Flavor dji — estado y pasos pendientes

El esqueleto (`app/src/dji/`) registra el SDK, escucha posición y batería vía
KeyManager y estructura la navegación. Antes de volar hace falta:

1. Crear una app en https://developer.dji.com y poner la key en
   `gradle.properties` → `DJI_API_KEY=...`.
2. Completar los `TODO(hardware)` de `DjiDroneController.kt`:
   - envío real de velocidades por **Virtual Stick** (el Mini 4 Pro **no**
     soporta las misiones de waypoints del SDK — son solo Enterprise — por eso
     el patrullaje se implementa con Virtual Stick),
   - captura del stream de video (`ICameraStreamManager`) → JPEG,
   - escucha de `KeyConnection` para que el watchdog de señal funcione con el
     enlace RC real.
3. Probar en campo con las validaciones de seguridad correspondientes (RTH
   configurado, altura, geocercas).

> Este flavor **no fue probado con hardware** en esta entrega; compila y marca
> los puntos de integración, pero requiere la etapa de pruebas de campo.

## Estructura

```
app/src/main/java/com/tesis/dronepatrol/
├── MainActivity.kt          UI mínima: conexión, selección de ruta, simulación
├── model/Models.kt          Waypoint, PatrolRoute, Telemetry, PatrolState
├── drone/DroneController.kt Interfaz que abstrae el dron
├── drone/SimulatedDroneController.kt
├── patrol/PatrolManager.kt  ★ Máquina de estados del patrullaje
└── comms/                   Clientes WS: Comando Central y software de detección
app/src/mock/  → ControllerFactory (simulador)
app/src/dji/   → ControllerFactory + DjiApplication + DjiDroneController (MSDK v5)
```
