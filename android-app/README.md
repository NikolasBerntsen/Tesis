# Drone Patrol — App de control (Android)

App que corre en el dispositivo Android conectado al **DJI RC-N2** y ejecuta la
lógica de patrullaje (`patrol/PatrolManager.kt`).

Tiene dos pantallas: una de **login**, donde se cargan las direcciones y la
cuenta del dron y se elige el modo de operación, y la **principal**, con el
estado del dron, la ruta a patrullar y —solo en modo prueba— los controles de
simulación. El registro local de eventos vive en el menú lateral.

## Flavors

| Flavor | Qué hace | Cuándo usarlo |
|---|---|---|
| `mock` | Dron **simulado** (`SimulatedDroneController`): waypoints, órbita, RTH, drenaje de batería, failsafe por pérdida de enlace y video sintético. | Desarrollo y demo sin hardware. Corre en emulador o cualquier teléfono. |
| `dji` | Integración real con **DJI MSDK v5** (`DjiDroneController`). Requiere API key y un dron real; **no funciona en el emulador**. | Pruebas de campo con el Mini 4 Pro. |

> El flavor `dji` está **deshabilitado por defecto**: Android Studio solo ofrece
> `mockDebug` y `mockRelease`. Esto es a propósito — `djiDebug` ordena antes que
> `mockDebug` alfabéticamente, así que Studio lo elegía solo, y al correrlo en un
> emulador la app se cerraba al instante (el SDK de DJI se inicializa en la clase
> `Application` y no puede registrarse sin API key ni hardware).
> Para compilarlo cuando tengas la key y el dron: `./gradlew assembleDjiDebug -PenableDji`.
>
> **El flavor `dji` necesita un dispositivo ARM.** El MSDK v5 no publica todas sus
> librerías nativas para `x86_64`: en ese ABI falta `libSdkyclx_clx.so`, que es la
> que carga `Helper.install()`. En un emulador x86_64 eso da `UnsatisfiedLinkError`
> durante `attachBaseContext`, o sea antes de que exista la Activity. Hoy queda
> atrapado y solo se registra en el log, pero el SDK no va a funcionar ahí:
> las pruebas del flavor `dji` van sobre el teléfono real conectado al RC-N2.

La lógica (máquina de estados, watchdogs, comunicación) es la misma en ambos:
solo cambia la implementación de `DroneController` que inyecta `ControllerFactory`.

## Correr la demo (flavor mock)

1. Abrir `android-app/` en Android Studio y sincronizar.
2. Correr en un emulador. La única variante disponible es `mockDebug`, así que no
   hay nada que elegir.
3. Con el backend y el detection-mock levantados (ver README raíz), en la app:
   - URLs por defecto (`10.0.2.2` = localhost del host desde el emulador), usuario
     y contraseña del dron (`drone1` / `drone123`) → **Iniciar sesión**.
   - Elegir **Modo prueba** (muestra los controles de simulación) o **Despliegue**.
     El modo viaja en el campo `mode` de cada `status`.
   - Elegir ruta → **Comenzar patrullaje**.
   - *Forzar batería baja*, *Recargar batería* y el switch *Simular pérdida de
     señal* disparan los flujos de failsafe.
   - El menú ⋮ tiene **Renombrar dron**; el nombre también se actualiza solo si
     lo cambia el operador desde el Comando Central.

En un teléfono físico, reemplazar `10.0.2.2` por la IP LAN de la laptop.

## Flavor dji — estado y pasos pendientes

El esqueleto (`app/src/dji/`) registra el SDK, escucha posición y batería vía
KeyManager y estructura la navegación. Antes de volar hace falta:

1. Crear una app en https://developer.dji.com y poner la key en
   `gradle.properties` → `DJI_API_KEY=...`, y compilar con `-PenableDji`.
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

## Tests

```bash
./gradlew testMockDebugUnitTest
```

Incluye un smoke test de arranque con Robolectric que crea `LoginActivity` (la
pantalla inicial) y `MainActivity` en las APIs 26, 30 y 34. Si algo revienta al
abrir la app, el test falla con el stack trace en vez de dejarte un cierre
silencioso en el dispositivo.

## Estructura

```
app/src/main/java/com/tesis/dronepatrol/
├── LoginActivity.kt         Login con la cuenta del dron + elección de modo
├── MainActivity.kt          Estado, selección de ruta, simulación y registro
├── model/Models.kt          Waypoint, PatrolRoute, Telemetry, PatrolState
├── drone/DroneController.kt Interfaz que abstrae el dron
├── drone/SimulatedDroneController.kt
├── patrol/PatrolManager.kt  ★ Máquina de estados del patrullaje
└── comms/                   Clientes WS: Comando Central y software de detección
app/src/mock/  → ControllerFactory (simulador)
app/src/dji/   → ControllerFactory + DjiApplication + DjiDroneController (MSDK v5)
```
