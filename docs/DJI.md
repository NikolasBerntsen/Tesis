# Volar el Mini 4 Pro de verdad: el flavor `dji`

Guía de puesta en marcha de la integración real con el DJI Mobile SDK v5
(MSDK). Lo que hay que conseguir, lo que hay que configurar y lo que hay que
revisar antes de despegar.

## Qué hace falta

| Qué | Por qué |
|---|---|
| **DJI Mini 4 Pro** con firmware al día | Soportado por el MSDK desde 5.13.0 |
| **Control RC-N3** (o RC-N2) | El MSDK corre en el teléfono enganchado a un control sin pantalla. El Mini 4 Pro + RC-N3 está soportado desde **MSDK 5.17.0**; la app usa **5.18.0**. Con el DJI RC 2 (pantalla propia) **no hay forma** de comandar el dron desde una app |
| **Teléfono Android ARM64** (Android 8+) | El MSDK solo publica librerías nativas para `arm64-v8a`. No corre en el emulador |
| **Cuenta de desarrollador DJI + App Key** | Sin ella el SDK no se registra y no habla con el dron (ver abajo) |
| **Internet en el teléfono la primera vez** | El SDK se registra contra los servidores de DJI al arrancar; después cachea el registro |

## 1. Conseguir la App Key (paso a paso)

1. **Cuenta de desarrollador.** Entrar a <https://developer.dji.com> y tocar
   *Register* arriba a la derecha (si ya tenés cuenta DJI —la de DJI Fly—,
   *Login* y completar el perfil de desarrollador cuando lo pida). El registro
   pide mail, teléfono y una tarjeta de crédito **solo para verificar la
   identidad: no cobra nada**.
2. **Developer Center.** Ir a <https://developer.dji.com/user/apps> (menú de
   usuario → *Developer Center* → pestaña **Apps**).
3. **CREATE APP** (botón a la derecha) y completar:
   - *App Type*: **Mobile SDK**
   - *App Name*: el que quieras (por ejemplo `Drone Patrol`)
   - *Software Platform*: **Android**
   - *Package Name*: **`com.tesis.dronepatrol`** — exactamente el
     `applicationId` de la app. Con otro package el SDK contesta
     `INVALID_METADATA` al registrarse y no habla con el dron.
   - *Category* y *Description*: cualquiera (por ejemplo "Patrullaje
     autónomo — tesis").
4. **Activar por mail.** DJI manda un correo con un enlace de activación de la
   app; hay que abrirlo.
5. **Copiar la App Key.** Volver a <https://developer.dji.com/user/apps>: la
   app aparece en la lista con su **App Key** (24 caracteres hexadecimales).
   Esa es la que va en `local.properties` (sección 2).

> La App Key está atada al package name y a tu cuenta: no va al repo (git
> ignora `local.properties`). Si alguna vez cambia el `applicationId`, hay que
> crear otra app en el Developer Center.

## 2. Cargar la App Key en el proyecto

En `android-app/local.properties` (git lo ignora; es el lugar para claves):

```properties
sdk.dir=C:\\Users\\...\\AppData\\Local\\Android\\Sdk
DJI_API_KEY=la_app_key_que_dio_dji
```

Con la clave cargada, el flavor `dji` **se habilita solo** en Android Studio
(aparecen `djiDebug` y `djiRelease` en *Build Variants*). Sin clave queda
oculto, para que el emulador siga arrancando con `mockDebug` sin tocar nada.
También se puede forzar con `-PenableDji` o con la variable de entorno
`DJI_API_KEY`.

**El build de campo es `djiRelease`, no `djiDebug`.** El código real del MSDK
viene empaquetado y `Helper.install()` lo desempaqueta al arrancar; ese
cargador trae detección de depuración y **en una app `debuggable` no carga el
SDK**: el log muestra `No implementation found for ... Helper.i()` y después
`ClassNotFoundException: dji.v5.manager.interfaces.SDKManagerCallback`, y la
pantalla queda en *"el SDK de DJI no carga en un build depurable"*. Es lo que
reportan los issues [#623](https://github.com/dji-sdk/Mobile-SDK-Android-V5/issues/623)
y [#671](https://github.com/dji-sdk/Mobile-SDK-Android-V5/issues/671) del
repo del MSDK sin respuesta de DJI; comprobado en un Galaxy S23 Ultra con
Android 16: `djiDebug` falla, `djiRelease` registra el SDK. El release del
proyecto se firma con el keystore de debug de la máquina (no hay keystore
propio), así que se instala igual que un debug.

```bash
./gradlew assembleDjiRelease        # con DJI_API_KEY en local.properties
adb install -r app/build/outputs/apk/dji/release/app-dji-release.apk
```

Instalarlo **antes** de enchufar el control (el puerto USB del teléfono queda
ocupado); o activar *Depuración inalámbrica* y usar `adb pair` / `adb connect`,
o copiar el APK y abrirlo desde el teléfono.

> El build de `release` del flavor `dji` permite tráfico en claro (`ws://`)
> hacia cualquier destino: es lo que necesita el enlace con la notebook de
> detección, cuya IP no se puede declarar de antemano. El Comando Central va
> por `https` igual.

## 3. Antes de despegar (checklist de campo)

1. **Control en modo N (Normal).** En S o C la aeronave no le cede el mando al
   SDK: la app avisa *"el dron no aceptó el mando virtual"* y no se mueve.
2. **Dron encendido, control encendido, teléfono enganchado por el cable
   superior.** Android ofrece abrir Drone Patrol al enchufar el control
   (`USB_ACCESSORY_ATTACHED`); si no, abrirla a mano.
3. En la pantalla de operación, la tarjeta **Dron** tiene que decir *"En el
   suelo, listo para despegar"* con el punto en verde. Hasta entonces dice qué
   falta, en este orden: SDK registrado → control conectado → enlace con la
   aeronave → punto de retorno fijado → GPS con **8 satélites** como mínimo.
4. **Área de despegue despejada.** "Despegar y patrullar" enciende los motores
   solo: el dron salta a 1,2 m (despegue automático del SDK), **sube derecho a
   la altura del primer waypoint** sin moverse en el plano, y recién entonces
   arranca la ruta.
5. El operador **siempre puede recuperar el dron con el control**: mover el
   selector de modo o tocar las palancas le saca la autoridad al SDK (la app lo
   registra como *"la aeronave le sacó la autoridad de vuelo a la app"*). El
   botón RTH del control también.
6. Desde la app, **Volver a base** y **Aterrizar acá** piden confirmación y
   pisan cualquier otra orden, incluido el control manual de la consola. La
   batería al 25 % ordena el regreso a base sola.

## 4. Cómo vuela

El Mini 4 Pro **no** soporta las misiones de waypoints del MSDK (son solo
Enterprise). Todo el vuelo autónomo —ruta, órbita, ir a un nodo, vuelo
estacionario y mando manual de la consola— se hace con **Virtual Stick**: un
lazo a 10 Hz que manda velocidades.

- La cuenta de hacia dónde y a qué velocidad vive en `drone/Navegacion.kt`
  (`main`, con pruebas): crucero 8 m/s, órbita 5 m/s, vertical 2,5 m/s, frenado
  proporcional en los últimos 16 m, llegada a 4 m.
- La traducción a los campos del SDK vive en `drone/OrdenVirtualStick.kt`.
  **Ojo:** en modo VELOCITY el MSDK usa `roll` para el eje X (norte / adelante)
  y `pitch` para el Y (este / derecha), al revés de lo intuitivo; está tomado
  de la tabla oficial de *Flight Controller → Virtual Stick* y cubierto por
  tests. Mandarlo al revés gira cada orden 90°.
- La altura de cada waypoint (`alt`, relativa al punto de despegue) se corrige
  en el mismo lazo; el barómetro del dron (`KeyAltitude`) es la referencia.
- **La cámara.** Patrullando, el gimbal va a −70° (oblicua hacia abajo: la
  vista con la que se entrenó el detector). Ante una detección, la app ubica
  al objetivo en el terreno proyectando la caja con la altura, el rumbo y la
  inclinación del gimbal (`drone/Georreferencia.kt`, con tests), **orbita
  alrededor de ese punto** a 30 m con la nariz hacia el centro y el gimbal
  inclinado a `atan(altura / radio)` (unos −56° a 45 m), así el objetivo queda
  en el medio del cuadro toda la órbita. Al reanudar la ruta vuelve a −70°.
- El Virtual Stick se devuelve al control al cerrar la app, al ordenar un
  regreso a base o un aterrizaje, y cuando la aeronave lo revoca.

## 5. Problemas típicos

| Síntoma | Causa probable |
|---|---|
| *"DJI rechazó el registro de la app (INVALID_METADATA)"* | La App Key es de una app con otro package name, o no hay internet la primera vez |
| *"la app se compiló sin App Key"* | Falta `DJI_API_KEY` en `local.properties` (y se compiló con `-PenableDji`) |
| *"el SDK de DJI no carga en un build depurable"* / `ClassNotFoundException: SDKManagerCallback` | Se instaló `djiDebug`. El cargador del MSDK no desempaqueta el SDK en una app `debuggable`: usar `djiRelease` |
| La app se cierra al abrir en el emulador | El flavor `dji` no corre en x86: usar `mockDebug` |
| *"Conectá el control al teléfono…"* y no cambia | El cable del control va en el puerto **superior** del RC-N3; probar otro cable (tiene que ser de datos) |
| *"el dron no aceptó el mando virtual"* | Control en modo S o C, o un regreso a base en curso |
| *"GPS insuficiente"* | Esperar al aire libre; el Mini necesita unos segundos para fijar el punto de retorno |
| La detección no engancha | Celular y notebook en redes distintas, o el firewall de Windows bloqueando Python (ver `detection/README.md`) |
