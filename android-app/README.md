# Drone Patrol — App de control (Android)

App que corre en el celular enganchado al **DJI RC-N3** (o RC-N2) —el control
sin pantalla que usa el teléfono del operador como pantalla— y ejecuta la
lógica de patrullaje (`patrol/PatrolManager.kt`). El celular habla con el dron
a través del control: por eso es el que publica el video, el que ejecuta las
órdenes de vuelo que llegan del Comando Central y el que puede frenar el dron
desde el campo.

Tiene tres pantallas, en una **consola de campo oscura**: fondo oscuro de alto
contraste para usar a pleno sol, botones altos para el pulgar, un solo acento
ámbar para la acción principal.

1. **Login** (`LoginActivity`) — entra la *persona* que despliega el dron: el
   operador de campo, o un supervisor/admin, con su cuenta del Comando Central.
   La URL del Comando Central viene precargada y es editable.
2. **Menú de campo** (`FieldMenuActivity`) — quién inició sesión, la cuenta
   regresiva de la sesión efímera y las acciones: escanear el QR del dron (o
   escribir su identificador), configurar el enlace y cerrar sesión.
3. **Operación** (`MainActivity`) — de arriba a abajo: el **estado del dron**
   (enlace, modelo, satélites GPS, en vuelo o en el suelo, y qué falta para
   despegar), el **video en vivo** con el estado del patrullaje encima, la
   **telemetría** (batería, señal RC, altura, rumbo, posición), los **enlaces**
   (Comando Central y detección) y las **acciones de vuelo**: *Despegar y
   patrullar*, *Detener*, *Reanudar*, *Volver a base* y *Aterrizar acá* (las
   tres últimas con confirmación). La pestaña *Registro* tiene el log local.
   En modo prueba, con el dron simulado, aparece además la tarjeta de
   simulación.

**El dron no tiene cuenta.** Se identifica con el hash de 32 hexadecimales del
QR pegado en su fuselaje: al escanearlo, la app llama a `POST /api/drones/pair`
con ese hash y la ubicación del momento, recibe el token del dron y **cierra la
sesión del operador de campo**. De la pantalla de operación en adelante la app
habla como máquina, no como persona. La sesión del operador dura 20 minutos: si
vence antes de terminar, se vuelve al login con el aviso correspondiente.

## Flavors

| Flavor | Qué hace | Cuándo usarlo |
|---|---|---|
| `mock` | Dron **simulado** (`SimulatedDroneController`): arranca en el suelo, despega solo al comenzar un patrullaje, waypoints con su altura, órbita, RTH, aterrizaje, drenaje de batería, failsafe por pérdida de enlace y video sintético (en los dos tamaños del contrato). | Desarrollo y demo sin hardware. Corre en el emulador o en cualquier teléfono. |
| `dji` | Integración real con **DJI MSDK v5.18** (`DjiDroneController`): Mini 4 Pro con RC-N2/RC-N3. Requiere App Key y un teléfono ARM64; **no corre en el emulador** y **solo carga en la variante `djiRelease`** (el cargador del SDK no desempaqueta el SDK en un build depurable). | Salidas de campo. Ver [docs/DJI.md](../docs/DJI.md). |

> El flavor `dji` aparece en Android Studio **solo si hay App Key** en
> `local.properties` (`DJI_API_KEY=...`) o se compila con `-PenableDji`. Sin
> clave queda oculto, para que el emulador siga arrancando con `mockDebug` sin
> tocar nada: el SDK de DJI se inicializa en la clase `Application` y en un
> emulador x86 no puede ni cargar sus librerías nativas.

La lógica (máquina de estados, watchdogs, comunicación) es la misma en ambos:
solo cambia la implementación de `DroneController` que inyecta `ControllerFactory`.

## Correr la demo (flavor mock)

1. Abrir `android-app/` en Android Studio y sincronizar.
2. Correr en un emulador con la variante `mockDebug`.
3. Con el backend levantado (ver README raíz) y, si se quiere detección real,
   `detection/correr.bat` en esta PC:
   - **Login**: la URL del Comando Central ya viene cargada; entrar con la cuenta
     del operador de campo → **Iniciar sesión**.
   - **Menú de campo** → **Configuración del enlace** → *Dirección manual* →
     `ws://10.0.2.2:8765` (así el emulador llega a la detección de esta PC).
   - **Escanear QR del dron** (o escribir el identificador que imprime el seed).
   - Elegir **Modo prueba** (muestra los controles de simulación) o **Despliegue**.
   - Elegir ruta → **Despegar y patrullar** → confirmar. El dron simulado
     despega, sube a la altura del primer waypoint y arranca la ruta.
   - *Forzar batería baja*, *Recargar batería* y el switch *Simular pérdida de
     señal* disparan los flujos de failsafe. *Volver a base* y *Aterrizar acá*
     están siempre a mano.

En el emulador la cámara y el GPS son simulados (controles extendidos →
*Camera* y *Location*). Si no hay ubicación el emparejamiento procede igual y el
registro queda con `ubicacion: null`: el despliegue no se frena por el GPS.

## Enlace con la notebook de detección

El celular va enganchado al control por su **único puerto USB**, así que el
enlace con la notebook que corre la detección es **por Wi-Fi**: el hotspot del
celular o la Wi-Fi del lugar, con los dos equipos en la misma red. Hay tres
modos en **Menú de campo → Configuración del enlace**:

| Modo | Qué hace | Cuándo |
|---|---|---|
| **Automático** (de fábrica) | La notebook anuncia su servicio por UDP (puerto 8766) cada segundo y la app se conecta a la dirección de la que vino el anuncio. Sin tipear IPs. | En el campo |
| Cable USB | Túnel `adb reverse tcp:8765 tcp:8765` hacia `127.0.0.1`. Solo sin el control enchufado. | Banco de pruebas |
| Dirección manual | `ws://<ip-de-la-notebook>:8765`. Desde el emulador, `ws://10.0.2.2:8765`. | Respaldo / emulador |

Si el enlace no engancha, la pantalla de operación lo dice con todas las letras
(qué revisar: red, firewall de la notebook, `adb reverse`) en vez de quedarse muda.
El patrullaje sigue andando sin detección; lo que no hay son alertas automáticas.

## Video en vivo

El controlador emite **dos flujos** y `PatrolManager` los reparte:

| Destino | Cuadro | Ritmo | Por qué |
|---|---|---|---|
| Comando Central | 640 px, calidad 60 | **5 por segundo** (`CuadroDeVideo.INTERVALO_CUADRO_MS`) | Es el video que mira el operador y con el que decide; de acá sale la captura de cada alerta |
| Software de detección | **1280 px**, calidad 75 | **2 por segundo como techo** (`CuadroDeVideo.INTERVALO_DETECCION_MS`) | El modelo está entrenado a 1280 px: desde 50 m una persona a 640 px son diez pixeles. El enlace con la notebook es el más flojo de los tres y detectar no necesita más cuadros |

El techo de la detección lo vuelve a medir `PatrolManager` **con reloj**
(`LimitadorDeRitmo`), aunque el controlador ya emita raleado: es la garantía
del contrato §1 de `docs/PROTOCOLS.md` y no depende de que cada controlador la
cumpla. El dron simulado emite los dos flujos al mismo ritmo que el real.

Con el dron real el cuadro llega en NV21 (1920x1080 o 1280x720) y se reescala
con submuestreo de vecino más cercano antes de comprimirlo (`drone/CuadroDeVideo.kt`,
en `main` y con pruebas: es justo lo que el flavor `dji` no permite probar).
La propia app también muestra el flujo de 640 px en la pantalla de operación.

## Vuelo

Todo lo que se puede probar sin dron vive en `main`, con pruebas, y el flavor
`dji` queda como el pegamento con el SDK:

- `drone/Navegacion.kt`: la cuenta de cada vuelta del lazo (velocidad hacia un
  punto con frenado proporcional, control de altura, umbrales de llegada).
- `drone/OrdenVirtualStick.kt`: la traducción a los campos del Virtual Stick
  del MSDK. En modo VELOCITY el SDK usa `roll` para el eje X (norte / adelante)
  y `pitch` para el Y (este / derecha), al revés de lo intuitivo; está tomado
  de la tabla oficial y cubierto por tests porque mandarlo al revés gira cada
  orden 90° y con el dron real no hay otra prueba antes de volar.
- `drone/MandoVirtual.kt`: los ejes del mando de la consola → velocidades
  (5 m/s horizontal, 2 m/s vertical, 45 °/s de giro, zona muerta de 0,05).
- `drone/Geo.kt`: rumbos y metros por grado.

**Despegue.** Solo "Comenzar patrullaje" despega, y pide confirmación: el
controlador ordena el despegue automático (1,2 m), **sube derecho a la altura
del primer waypoint** sin moverse en el plano, y recién ahí arranca la ruta.
Antes verifica `EstadoDelDron.listoParaDespegar`: SDK registrado, enlace con la
aeronave, punto de retorno fijado y **8 satélites** como mínimo. Cualquier otra
orden con el dron en el suelo se rechaza y se registra como `DRONE_PROBLEM`.

**Detección → órbita → decisión.** El detector contesta cada cuadro con las
cajas (normalizadas) y, si vio algo, la captura anotada. La app:
1. dibuja las cajas sobre el video que sube a la consola (y sobre su propio
   visor) mientras estén vigentes (1,5 s), en cualquier estado;
2. solo **patrullando**, proyecta el centro de la caja más segura al terreno
   con la altura, el rumbo y la inclinación del gimbal
   (`drone/Georreferencia.kt`) y **orbita alrededor del objetivo** a 30 m con
   la cámara apuntada al centro, para no perderlo de vista;
3. manda la alerta con el tipo, la **captura anotada**, la posición del objetivo
   y la confianza; y
4. espera la decisión del operador: *falso positivo* retoma la ruta donde la
   dejó; *validada* mantiene la órbita hasta que la consola ordene reanudar.

**Mando virtual.** El operador de la consola toma el control y mueve una
palanca; cada eje viaja en `[-1, 1]` en un `manual_stick` a ~10 Hz. Con el
control tomado, si no llega ningún mando durante 1,5 s y el último no era todo
ceros, la app manda ceros por su cuenta (watchdog). Toda salida de `MANUAL`
pasa por `PatrolManager.pasarA()`, que frena cuando nadie más le habla al dron.

**Desde el campo**, *Volver a base* y *Aterrizar acá* pisan cualquier orden,
incluido el control manual de la consola: el que está al lado del dron manda.

## Tests

```bash
./gradlew testMockDebugUnitTest
```

| Suite | Qué cubre |
|---|---|
| `LoginActivityLaunchTest` | Arranque de `LoginActivity` y `MainActivity` en las APIs 26, 30 y 34, URL precargada y avisos de vuelta al login |
| `FieldMenuActivityTest` | Cuenta regresiva de la sesión efímera, las acciones y la vuelta al login |
| `SesionDeCampoTest`, `PreferenciasEnlaceTest`, `HashDeDronTest`, `MenuOperativoTest` | Sesión, preferencias (modo AUTO de fábrica), validación del QR |
| `DetectionClientTest`, `DescubridorDeDeteccionTest` | URL del enlace en cada modo; la lectura de los anuncios UDP |
| `SimulatedDroneControllerTest` | Navegación, rumbo, altura, mando y batería del simulador en vuelo |
| `SimulatedDroneControllerSueloTest` | Arranca en el suelo, despega al comenzar una ruta, rechaza el resto, aterriza y vuelve a base |
| `OrdenVirtualStickTest` | Los ejes del Virtual Stick, fila por fila de la tabla oficial del MSDK |
| `NavegacionTest` | Velocidades, frenado, llegada y control de altura |
| `CuadroDeVideoTest`, `CuadroDeVideoJpegTest`, `LimitadorDeRitmoTest`, `EsperaCrecienteTest`, `MandoVirtualTest`, `GeoTest` | Las piezas puras del vuelo y del video |
| `PatrolManager*Test` | La máquina de estados: mando, salidas de manual, pérdida de señal, avisos del dron y el reparto del video en sus dos flujos |
| `CommandCenterClientTest` | El mapeo de los mensajes del WebSocket a órdenes |

## Estructura

```
app/src/main/java/com/tesis/dronepatrol/
├── LoginActivity.kt           Login del operador de campo
├── FieldMenuActivity.kt       Menú de campo: QR, enlace, cierre de sesión
├── MainActivity.kt            Pantalla de operación
├── SesionDeCampo.kt           Sesión efímera del operador
├── Config.kt                  URLs, puertos y preferencias del enlace
├── model/Models.kt            Waypoint, PatrolRoute, Telemetry, EstadoDelDron, PatrolState, FlightEvent
├── drone/DroneController.kt   Interfaz que abstrae el dron (estado, dos flujos de video, órdenes)
├── drone/SimulatedDroneController.kt
├── drone/Navegacion.kt        La cuenta de los lazos de vuelo
├── drone/OrdenVirtualStick.kt Ejes del Virtual Stick del MSDK
├── drone/MandoVirtual.kt      Ejes del mando → velocidades
├── drone/CuadroDeVideo.kt     NV21 → JPEG en los dos tamaños
├── patrol/PatrolManager.kt    ★ Máquina de estados del patrullaje
└── comms/                     Comando Central, detección y el descubridor UDP
app/src/mock/  → ControllerFactory (simulador)
app/src/dji/   → ControllerFactory + DjiApplication + DjiSdk + DjiDroneController + UsbAttachActivity (MSDK v5)
app/src/debug/ → network security config permisiva (texto plano en pruebas)
```
