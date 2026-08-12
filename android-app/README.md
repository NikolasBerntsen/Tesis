# Drone Patrol — App de control (Android)

App que corre en el dispositivo Android conectado al **DJI RC-N2** y ejecuta la
lógica de patrullaje (`patrol/PatrolManager.kt`).

Tiene tres pantallas:

1. **Login** (`LoginActivity`) — entra la *persona* que despliega el dron: el
   operador de campo, o un supervisor/admin, con su cuenta del Comando Central.
   La URL del Comando Central viene precargada
   (`https://tesis.144-22-138-149.sslip.io`) y es editable.
2. **Menú de campo** (`FieldMenuActivity`) — quién inició sesión, la cuenta
   regresiva de la sesión efímera y las tres acciones: escanear el QR del dron,
   configurar el enlace y cerrar sesión.
3. **Principal** (`MainActivity`) — estado del dron, ruta a patrullar y —solo en
   modo prueba— los controles de simulación. El registro local de eventos vive
   en el menú lateral.

**El dron no tiene cuenta.** Se identifica con el hash de 32 hexadecimales del
QR pegado en su fuselaje: al escanearlo, la app llama a `POST /api/drones/pair`
con ese hash y la ubicación del momento, recibe el token del dron y **cierra la
sesión del operador de campo**. De la pantalla principal en adelante la app
habla como máquina, no como persona. La sesión del operador dura 20 minutos: si
vence antes de terminar, se vuelve al login con el aviso correspondiente.

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
   - **Login**: la URL del Comando Central ya viene cargada; entrar con la cuenta
     del operador de campo → **Iniciar sesión**.
   - **Menú de campo** → **Escanear QR del dron**. El QR lo imprime la consola
     web desde la vista *Drones*, y su contenido es solo el hash.
   - Elegir **Modo prueba** (muestra los controles de simulación) o **Despliegue**.
     El modo viaja en el campo `mode` de cada `status`.
   - Elegir ruta → **Comenzar patrullaje**.
   - *Forzar batería baja*, *Recargar batería* y el switch *Simular pérdida de
     señal* disparan los flujos de failsafe.
   - El menú ⋮ tiene **Renombrar dron**; el nombre también se actualiza solo si
     lo cambia el operador desde el Comando Central.

En el emulador la cámara y el GPS son simulados (controles extendidos →
*Camera* y *Location*). Si no hay ubicación el emparejamiento procede igual y el
registro queda con `ubicacion: null`: el despliegue no se frena por el GPS.

## Enlace con la computadora de detección

El celular va montado en el control y la detección corre en la laptop. Hay dos
modos, elegibles en **Menú de campo → Configuración del enlace**.

### CABLE (el que viene por defecto)

Túnel de ADB sobre el mismo cable USB que une el celular con la laptop. Es el
recomendado porque no depende de la red ni de qué IP le tocó a cada uno.

1. En el celular: *Opciones de desarrollador* → **Depuración USB** activada.
2. Enchufar el cable y aceptar la huella RSA que aparece en el celular.
3. En la laptop, una vez por cada sesión de ADB:

   ```bash
   adb reverse tcp:8765 tcp:8765
   ```

   Con eso el `localhost:8765` del celular sale por el cable hacia el
   `localhost:8765` de la laptop, que es donde escucha la detección.
4. En la app no hay nada que escribir: la URL es fija, `ws://127.0.0.1:8765/phone`.

El `adb reverse` se pierde al desenchufar el cable o al reiniciar el servidor de
ADB, y hay que volver a correrlo. Si la detección no engancha, la pantalla
principal lo dice con todas las letras (incluido el recordatorio del
`adb reverse`) en vez de quedarse muda.

### RED (respaldo)

URL manual `ws://<ip-de-la-laptop>:8765` —la app le agrega el `/phone`—. Sirve
cuando no hay depuración USB; con anclaje USB la laptop suele quedar en
`192.168.42.x`.

> **Solo funciona en compilaciones `debug`.** El Comando Central va por HTTPS,
> así que la *network security config* de release prohíbe el texto plano salvo
> contra `127.0.0.1`/`localhost`, que es el túnel del cable; la IP de la laptop
> no se puede declarar de antemano. `src/debug/res/xml/network_security_config.xml`
> lo habilita para el banco de pruebas y las salidas de campo.

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

| Suite | Qué cubre |
|---|---|
| `LoginActivityLaunchTest` | Smoke test de arranque de `LoginActivity` y `MainActivity` en las APIs 26, 30 y 34 —si algo revienta al abrir la app, el test falla con el stack trace en vez de dejarte un cierre silencioso en el dispositivo— más la URL del Comando Central precargada y los avisos de vuelta al login |
| `FieldMenuActivityTest` | Cuenta regresiva de la sesión efímera, las tres acciones y la vuelta al login cuando vence o se cierra |
| `SesionDeCampoTest` | Vencimiento del JWT del operador de campo y roles habilitados para emparejar |
| `PreferenciasEnlaceTest` | URL del Comando Central por defecto y modo CABLE de fábrica |
| `HashDeDronTest` | Filtro del contenido del QR: 32 hexadecimales y nada más |
| `DetectionClientTest` | Armado de la URL del enlace en CABLE y en RED |
| `SimulatedDroneControllerTest` | Navegación, rumbo y drenaje de batería del dron simulado |

Las dos últimas de la lista corren en la JVM pelada, sin Robolectric.

## Estructura

```
app/src/main/java/com/tesis/dronepatrol/
├── LoginActivity.kt         Login del operador de campo contra el Comando Central
├── FieldMenuActivity.kt     Menú de campo: QR del dron, enlace y cierre de sesión
├── SesionDeCampo.kt         Sesión efímera del operador (el JWT vive en el proceso)
├── Config.kt                URLs por defecto + preferencias del enlace
├── MainActivity.kt          Estado, selección de ruta, simulación y registro
├── model/Models.kt          Waypoint, PatrolRoute, Telemetry, PatrolState
├── drone/DroneController.kt Interfaz que abstrae el dron
├── drone/SimulatedDroneController.kt
├── patrol/PatrolManager.kt  ★ Máquina de estados del patrullaje
└── comms/                   Clientes WS: Comando Central y software de detección
app/src/mock/  → ControllerFactory (simulador)
app/src/dji/   → ControllerFactory + DjiApplication + DjiDroneController (MSDK v5)
app/src/debug/ → network security config permisiva (habilita el modo RED en pruebas)
```
