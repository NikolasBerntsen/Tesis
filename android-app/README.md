# Drone Patrol — App de control (Android)

App que corre en el celular enganchado al **DJI RC-N3** (o RC-N2) —el control
sin pantalla que usa el teléfono del operador como pantalla— y ejecuta la
lógica de patrullaje (`patrol/PatrolManager.kt`). El celular habla con el dron
a través del control: por eso es el que publica el video, el que ejecuta las
órdenes de vuelo que llegan del Comando Central y el que puede frenar el dron
desde el campo.

Tiene cuatro pantallas, en una **consola de campo oscura**: fondo oscuro de
alto contraste para usar a pleno sol, botones altos para el pulgar, un solo
acento ámbar para la acción principal.

1. **Login** (`LoginActivity`) — entra la *persona* que despliega el dron: el
   operador de campo, o un supervisor/admin, con su cuenta del Comando Central.
   La URL del Comando Central viene precargada y es editable.
2. **Menú de campo** (`FieldMenuActivity`) — quién inició sesión, la cuenta
   regresiva de la sesión efímera y las acciones: escanear el QR del dron (o
   escribir su identificador), configurar el enlace y cerrar sesión.
3. **Conectar el dron** (`ConexionDronActivity`) — el QR identificó al dron en
   el Comando Central; acá se verifica que la **aeronave física** esté enchufada
   y enlazada: SDK registrado → control por USB → aeronave (modelo y número de
   serie) → GPS y punto de retorno, más la **distancia entre el teléfono y el
   dron** y su batería. Si el modelo enlazado no coincide con la ficha, avisa.
   *Desplegar* y *Modo prueba* se habilitan **solo con el dron conectado**.
4. **Operación** (`MainActivity`) — de arriba a abajo: el **estado del dron**
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
con ese hash y la ubicación del momento y recibe el token del dron. De la
pantalla de conexión en adelante la app habla como máquina, no como persona,
pero **la sesión del operador de campo sigue viva por debajo**: al terminar la
operación (*Terminar operación* en el menú, o "atrás", con confirmación si el
dron está en el aire) se vuelve al menú de campo sin reingresar, listo para
desplegar otro dron. La sesión dura 20 minutos desde el login: si venció
mientras se operaba, al volver se va al login con el aviso. La cuenta regresiva
nunca interrumpe la operación.

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
   - **Conectar el dron**: con el simulado la verificación se pone en verde
     sola; elegir **Desplegar** o **Modo prueba** (muestra los controles de
     simulación).
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
  punto con frenado proporcional desde 30 m y un piso de 1,5 m/s para que
  termine de llegar, control de altura, umbrales de llegada). `LlegadaAlNodo`
  decide cuándo un nodo se alcanzó: entrando en el umbral de 4 m, o **pasando
  de largo** —a menos de 12 m del nodo la distancia vuelve a crecer 2,5 m—,
  que es lo que pasa en el campo con el retraso del dron y el error del GPS;
  antes el lazo lo hacía dar la vuelta para pisar un punto que ya había
  dejado atrás.
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

**Detección → reacción → decisión** (`docs/VUELO.md` §5 y §6). El detector
contesta cada cuadro con las cajas (normalizadas) y, si vio algo, la captura
anotada. La app:
1. dibuja las cajas sobre el video que sube a la consola (y sobre su propio
   visor) mientras estén vigentes (1,5 s), en cualquier estado;
2. solo **patrullando, en pausa o en un desvío**, proyecta el centro de la caja
   más segura al terreno con la altura, el rumbo y la inclinación del gimbal
   (`drone/Georreferencia.kt`) y reacciona según el ajuste del dron
   `reaccionADeteccion`: de fábrica (`seguir_y_orbitar`) **orbita alrededor
   del objetivo** a 30 m con la cámara al centro (`ORBITING`), lo sigue a 25 m
   si se mueve (`FOLLOWING`) y vuelve a orbitarlo si se detiene; `orbitar`
   orbita el lugar de la detección con el centro fijo, sin seguirlo; `seguir`
   se pone a 25 m y lo sigue, sin orbitar nunca; `detenerse` se queda donde
   está, con la nariz y la cámara en el objetivo (`VIGILANDO`,
   `DroneController.vigilar`). En las cuatro el arranque deja `ORBIT_STARTED`,
   con un texto que dice qué hace el dron, y salen los avisos `TARGET_MOVING`,
   `TARGET_STOPPED`, `TARGET_LOST` y `TARGET_REACQUIRED`. La velocidad de la
   órbita es de 4 m/s de fábrica y la fija el operador desde la vista del dron
   en la consola (`ajustes`, `docs/PROTOCOLS.md` §2), entre 1 y 8 m/s; el
   Comando Central guarda los tres ajustes y se los vuelve a mandar en cada
   conexión. La app valida cada campo contra `docs/contrato/ajustes.json` sin
   convertir ni recortar nada: un valor inválido, o un mensaje sin ninguna de
   las tres claves, descarta el mensaje entero, y una clave ausente es la de
   fábrica. Una sola detección, o dos de distinta clase o lejos una de
   otra, **no** le cambian nada a la ruta: solo la confirmada (dos de la misma
   clase, en 2,5 s y a menos de 25 m) arranca la reacción. Volviendo a base o
   en control manual una detección solo dibuja sus cajas; aterrizando no le da
   al dron ninguna orden, y sin el control tomado alerta sin seguimiento
   (`DETECTION`, una por minuto), igual que en la pausa de un regreso que no
   arrancó;
3. manda la alerta con el tipo, la **captura anotada**, la posición del objetivo
   y la confianza; y
4. espera la decisión del operador: *falso positivo* retoma la ruta hacia el
   próximo nodo (sin un patrullaje en curso que retomar, queda estacionario
   en `PAUSED` y registra `PATROL_STOPPED`); *validada* mantiene la reacción
   hasta que la consola ordene reanudar. Cada vez que el dron **deja un
   objetivo para volver a volar solo** (un descarte, reanudar, otra ruta, un
   desvío a un nodo o «Detener», que además deja la zona del objetivo como
   descartada) empieza el **silencio al retomar** (`silencioAlRetomarS`, 15 s
   de fábrica, de 0 a 30 de a 5; uno nuevo vale desde el próximo objetivo):
   mientras dura, las detecciones solo dibujan sus cajas, así el dron pasa de
   largo la playa de estacionamiento en vez de parar en cada auto. Un regreso
   o un aterrizaje no lo arrancan.

**Mando virtual.** El operador de la consola toma el control y mueve una
palanca; cada eje viaja en `[-1, 1]` en un `manual_stick` a ~10 Hz. Con el
control tomado, si no llega ningún mando durante 1,5 s y el último no era todo
ceros, la app manda ceros por su cuenta (watchdog). Toda salida de `MANUAL`
pasa por `PatrolManager.pasarA()`, que frena cuando nadie más le habla al dron.

**Desde el campo**, *Volver a base* y *Aterrizar acá* pisan cualquier orden,
incluido el control manual de la consola: el que está al lado del dron manda.
Lo que no se cumple, ni desde el campo ni desde la consola: volver a base o
aterrizar sin señal con la aeronave (el DJI ya vuelve solo), y cualquier
orden de vuelo en el descenso final de una emergencia, que ya está bajando;
ahí la app contesta con un `DRONE_PROBLEM` que sale siempre (`docs/VUELO.md`
§14).

**Desde la consola**, `return_home` y `land` son órdenes de llegada
(`docs/VUELO.md` §4, §7 y §9): mandan sobre la ruta, la órbita, el seguimiento
y un regreso en curso (al aterrizar durante un regreso de la app se corta el
GoHome antes, como al tomar el control), y ya no exigen el control tomado:
quién puede lo decide el hub. Con `return_home` el hub ya soltó el lock (el
del que ordenó, o el que un supervisor le quitó a otro), así que la app
suelta el control sola con cada `return_home` que recibe teniéndolo, vuele a
casa o no, sin `control_dropped`. Ya volviendo, en el suelo o en las fotos de
una emergencia, el `return_home` solo queda en el log; volviendo, lo cortan
tomar el control, aterrizar, una ruta o un desvío, y reanudar o detener se
ignoran. «Aterrizar acá» (`land`) se rechaza en tres casos —un failsafe del
DJI que no se discute, la señal perdida y el descenso final de una
emergencia—, siempre con un `DRONE_PROBLEM` «No se aterriza (…): …». Si el
GoHome no arranca, el controlador lo vuelve a ordenar hasta 3 veces
(`NO_SE_PUDO_VOLVER`): la consola se entera siempre con un `DRONE_PROBLEM`
«No se pudo volver a la base: …» y el dron queda estacionario en `PAUSED` (con
el control tomado, en `MANUAL`), sin perseguir detecciones hasta que una
persona dé una orden; con la batería en el umbral, la telemetría siguiente lo
vuelve a mandar a casa. Si alguien mueve las palancas del RC-N3 durante el
regreso, el DJI deja el GoHome y la app no lo pelea: `PAUSED` con el mando en
el control físico y `RTH_INTERRUPTED`. Durante un aterrizaje sostenido con el
control tomado, la primera **palanca deliberada** —o un salto del pad— que
llegue 1,5 s o más después de la orden lo corta, deja al dron estacionario a
su mando y registra `LANDING_CANCELLED`; las palancas en cero y las de antes
de la gracia no cuentan.

**Tomar el control** se toma del todo: la persona manda. Volviendo a base
(`RETURNING_HOME` o `RETURNING_HOME_BATTERY`, también si el regreso lo arrancó
el propio DJI) la toma le corta el regreso al dron antes del estacionario,
porque con el GoHome puesto el DJI no acepta el mando virtual; y mientras la
persona lo tenga, la batería baja no le vuelve a sacar el dron (al soltarlo,
sí). La app **no** toma el control con un vuelo del DJI que no se le
discute: el regreso pedido desde el botón del control físico, el aterrizaje
por batería crítica, y su regreso por batería cuando el único corte del vuelo
ya se gastó (RELEVOS §4); tampoco en el descenso final de una emergencia, ni
cuando el DJI no acepta cortar el regreso (sigue volviendo). Ahí contesta
`control_dropped` con el motivo, el hub suelta el lock y la consola lo dice
(antes entraba en `MANUAL` a medias y el dron seguía con lo suyo, con las
palancas mudas). Al soltar el control desde la consola, con un objetivo el
dron vuelve a él con la reacción vigente (`ORBITING`, `FOLLOWING` o
`VIGILANDO`, `TRACKING_RESUMED`); sin objetivo queda en vuelo estacionario, y
la consola pregunta si retoma el patrullaje: no sale a la ruta solo.

**Entre nodos** el dron no pega volantazos: la velocidad que se le manda sube
y baja en rampa (2 m/s²), la nariz gira a 45°/s como mucho y la velocidad se
achica mientras la nariz no apunta al nodo (`Navegacion.Crucero`), así que
llega despacio, gira casi en el lugar y recién después acelera, mirando hacia
donde va. Cerca del nodo el rumbo pedido no se toca (el rumbo al nodo tiembla
con el GPS). En estacionario y en manual, con la palanca de giro suelta, la
nariz queda anclada al rumbo que tenía (`AnclaDeRumbo`, yaw en modo ángulo):
antes iba en «velocidad de giro cero» y una ráfaga la dejaba corrida. En el
logcat, cada nodo alcanzado dice a qué distancia y velocidad se dio por
alcanzado y cada cuánto llegó la posición del SDK, para el banco de campo.

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
| `PatrolManagerReaccionTest`, `PatrolManagerSilencioTest`, `PatrolManagerDeteccionEnRegresoTest` | Las cuatro reacciones a una detección, el silencio al retomar con cada orden que lo arranca, y que volviendo a base una detección no ordena nada (`docs/VUELO.md` §5–§7) |
| `PatrolManagerRegresoPorLaConsolaTest`, `PatrolManagerAterrizajeDeLaConsolaTest` | `return_home` y `land` desde la consola con y sin el control, el regreso que no arranca y la palanca que corta un aterrizaje (`docs/VUELO.md` §7–§9) |
| `SimulatedDroneControllerVigilanciaTest` | La vigilancia del simulador: quieto, con la nariz y la cámara en el objetivo |
| `CommandCenterClientTest`, `ContratoDeAjustesTest` | El mapeo de los mensajes del WebSocket a órdenes; los ajustes del dron contra `docs/contrato/ajustes.json` |

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
