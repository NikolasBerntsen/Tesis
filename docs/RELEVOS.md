# Relevos entre drones, desvío a otra base y aterrizaje de emergencia

Diseño de cuatro comportamientos que involucran a más de un dron o a una base
que no es la propia. El contrato de mensajes vive acá y en `PROTOCOLS.md`
(§2.b, §1.b): si cambia algo, cambian los dos.

## 0. Conceptos

- **Base del dron**: la que tiene asignada el activo (`drones.base_id`). Es
  también su punto de retorno: el dron despega de ahí.
- **Dron en espera** (*standby*): un dron que el operador de campo dejó
  **prendido, enlazado y con la app en operación**, y al que le activó en la
  app el interruptor **«En espera para relevos»**. Sin ese interruptor un dron
  nunca despega solo por un relevo: es la única forma de que alguien en el
  campo haya revisado que el aparato y su zona de despegue están en
  condiciones.
- **Disponible para relevo**: lo calcula **la app** y lo informa en el status
  (`relevo.disponible`). Es verdadero solo si a la vez:
  en espera; conectado al dron; en el suelo; estado `IDLE`; sin control manual
  tomado; `listoParaDespegar` (GPS + punto de retorno); sin la batería por
  cambiar; batería **≥ `BATERIA_MINIMA_RELEVO_PCT` (60 %)**; sin otro relevo
  asignado.
- **Autonomía**: cuánta batería necesita el dron para volver y para aterrizar.
  - Dron real: `FlightControllerKey.KeyLowBatteryRTHInfo` del MSDK
    (`batteryPercentNeededToGoHome`, `batteryPercentNeededToLand`,
    `maxRadiusCanFlyAndGoHome`, `timeNeededToGoHome`).
  - Simulador y respaldo cuando el SDK no informa: estimación con
    `CONSUMO_PCT_POR_KM = 5` (≈ Mini 4 Pro a 10 m/s) y
    `PCT_PARA_ATERRIZAR = 3`.
  - Se informa en la telemetría (`Telemetry.pctParaVolver`,
    `pctParaAterrizar`, `alcanceM`; `NaN` si no se sabe).

## 1. Umbrales (app, `PatrolManager`)

| Nombre | Valor | Qué dispara |
|---|---|---|
| `LOW_BATTERY_PCT` | 25 % | Regreso a base por batería (existe). |
| `RESERVA_PCT` | 5 % | Margen sobre lo que dice la autonomía. |
| Piso de energía | `pctParaVolver + RESERVA_PCT` | **Regreso obligatorio**, aunque la batería esté arriba de 25 % (dron lejos de casa). Nunca se negocia. |
| `UMBRAL_RELEVO_PCT` | 35 % (`LOW + 10`) | Un dron **siguiendo un objetivo** pide relevo. Solo en seguimiento: patrullando no se pide relevo antes de tiempo. |
| `VENTANA_RELEVO_MS` | 60 s | Gracia para esperar a un relevo **en camino** después de llegar a 25 %, siempre por encima del piso de energía + 3 %. |
| `BATERIA_MINIMA_RELEVO_PCT` | 60 % | Mínimo para que un dron en espera salga de relevo. |

Regla de oro: **el regreso a tiempo manda**. El regreso por batería se dispara
con `batería ≤ max(LOW_BATTERY_PCT, pctParaVolver + RESERVA_PCT)`. La única
demora posible es la ventana de relevo, y se corta apenas la batería toca
`pctParaVolver + RESERVA_PCT + 3` o pasan `VENTANA_RELEVO_MS`, lo primero que
ocurra.

## 2. Caso A — relevo de patrulla al volver por batería baja

1. El dron **A** patrulla la ruta R (próximo nodo k) y entra en batería baja:
   `RETURNING_HOME_BATTERY` como hoy. Si tenía un patrullaje en curso, manda
   `relay_request {motivo: "patrulla", routeId: R, fromIndex: k}`.
2. El hub busca en **la base de A** un dron **B** disponible (el de más
   batería; empate, el que lleva más tiempo en espera). Si no hay, registra
   `RELAY_UNAVAILABLE` y no hace nada más (A vuelve como siempre).
3. Cuando A **llega a la base** —la app lo ve como `GoHomeState.LANDING` en el
   dron real, o el simulador al empezar a bajar en la base— manda
   `landing_at_base`. Recién ahí el hub le manda a B la **alerta de relevo**
   y la orden: `relay_start {relayId, motivo: "patrulla", routeId, fromIndex,
   de}`. (Hasta ese momento B no sabe nada: si A no llegaba, B no se movía.)
4. B **despega y patrulla R desde el nodo k**: es el mismo camino que
   `start_route` (guardas de GPS, punto de retorno y batería incluidas). Si
   no puede, contesta `relay_reject {relayId, motivo}` y el hub prueba con el
   siguiente disponible de la misma base.
5. B confirma con `relay_ready {relayId}` cuando está en el aire. El hub
   registra `RELAY_COMPLETED`.

Despegue y aterrizaje simultáneos en la misma base: cada dron baja en **su**
punto de retorno, y B sube desde el suyo. Supuesto de operación (documentado
para el campo): **plataformas separadas al menos 5 m**. B despega en vertical
hasta la altura de trabajo antes de ir hacia el nodo k.

## 3. Caso B — relevo en seguimiento

1. A sigue un objetivo (`ORBITING` o `FOLLOWING`, alerta `PENDING` o
   `VALIDATED`) y su batería baja de `UMBRAL_RELEVO_PCT` → manda **una vez**
   `relay_request {motivo: "seguimiento", alertId, objetivo: {tipo, lat, lon,
   vNorteMs, vEsteMs, decision}}`.
2. El hub elige, entre **todos** los drones disponibles, el de menor distancia
   de su base al objetivo, dentro de `RADIO_MAXIMO_RELEVO_M = 3000`. Si no hay,
   `RELAY_UNAVAILABLE` (A sigue hasta su umbral y vuelve como hoy).
3. Al elegido le manda `relay_tracking {relayId, alertId, tipo, lat, lon,
   vNorteMs, vEsteMs, decision, de}`. Mientras dure el relevo, **reenvía a B
   cada `target` del status de A** como `relay_target {relayId, lat, lon,
   vNorteMs, vEsteMs, perdido}`.
4. B despega, sube a la altura de trabajo y vuela hacia la última posición
   conocida (y la que llegue después). Al estar a menos de
   `DISTANCIA_TOMA_M = 60` del objetivo estimado **toma el seguimiento**: arranca
   su propio rastreador con la estimación recibida (misma `alertId`, misma
   decisión), orbita o sigue, y sus propias detecciones lo corrigen. Manda
   `relay_ready {relayId}`.
5. El hub le manda a A `relay_done {relayId, a}`: A suelta el objetivo (sin
   `TRACKING_ENDED` de pérdida: es un traspaso, evento `RELAY_HANDOVER`) y
   **vuelve a base** (`RETURNING_HOME`). Desde ese momento la alerta es de B:
   las decisiones del operador (`alert_decision`) se enrutan **al dron que
   sigue la alerta**, no al que la creó.
6. Si A llega a su piso de energía antes del traspaso, vuelve igual (regla de
   oro) y avisa `TRACKING_ENDED` con la última posición; B sigue yendo a esa
   posición e intenta reencontrar el objetivo (`TARGET_REACQUIRED` si lo
   detecta en `REACQUIRE_GATE_M`; si no, orbita la última posición y queda a
   la espera del operador).
7. Si la alerta se descarta o el seguimiento termina mientras B está en camino,
   el hub le manda `relay_cancel {relayId, motivo}` y B vuelve a su base.

## 4. Caso D — desvío a otra base

- Al conectarse cada dron, y cada vez que cambian las bases, el hub le manda
  `bases {propiaId, bases: [{id, nombre, lat, lon}]}` (solo activas).
- Durante un regreso por batería, en cada telemetría la app evalúa la
  autonomía:
  - Si **llega a su base**: sigue el regreso normal.
  - Si **no llega a su base** (`pctParaVolver + RESERVA_PCT ≥ batería`, o
    distancia a casa `> alcanceM`) pero **llega a otra base** (distancia ×
    consumo + aterrizaje + reserva < batería): se desvía a la más cercana
    alcanzable: `irYAterrizar(lat, lon)`, evento `RTH_DIVERTED` con la base.
  - Si **no llega a ninguna**: vuela hacia la base más cercana (la propia u
    otra) mientras le quede batería por encima de `pctParaAterrizar +
    RESERVA_PCT`, y ahí ejecuta el **protocolo de última ubicación** (§5) y
    aterriza. Así baja lo más cerca posible de una zona controlada.
- En el dron real, `irYAterrizar` va con el Virtual Stick a ese punto y
  aterriza con `KeyStartAutoLanding`. Si el SDK lo permite, además mueve el
  punto de retorno (`KeyHomeLocation`) a esa base, así los failsafes propios
  del dron (pérdida de señal, RTH inteligente) también van ahí.

## 5. Caso C — protocolo de última ubicación (aterrizaje fuera de base)

Se ejecuta cuando el dron va a aterrizar en un lugar que **no es una base**
(a más de `RADIO_DE_BASE_M = 50` de toda base conocida):
- porque la autonomía no alcanza (§4), o
- porque el dron aterriza por su cuenta (batería crítica del propio DJI)
  lejos de una base: ahí no se controla el vuelo, solo se capturan las
  imágenes que se puedan.

Secuencia controlada (tope ~15 s; cada paso espera `ASENTAR_MS = 1500` para
que la imagen se estabilice):

1. Vuelo estacionario.
2. Foto **oblicua**: inclinación de patrulla (−45° a −70°, la actual).
3. Foto **cenital**: cámara a −90°.
4. Cámara a −30° y **panorámica**: el dron gira a 0°, 90°, 180° y 270°
   (norte, este, sur, oeste) con una foto en cada uno. Se omite si la batería
   ya está en `pctParaAterrizar + 2`.
5. Aterriza.

Cada foto sale apenas se toma (por si el enlace se corta a mitad):
`emergency_photo {ref, seq, tipo: "oblicua"|"cenital"|"panoramica", rumbo,
inclinacion, lat, lon, alt, jpegBase64, ts}`. Al empezar manda
`emergency_landing {ref, motivo, lat, lon, alt, bateria, ts}` y al tocar tierra
un evento `EMERGENCY_LANDED` con la **última posición GPS**. Las fotos son el
cuadro de video del momento (JPEG de 640 px).

El hub guarda cada emergencia (tabla `emergencias` + `emergencia_fotos`),
la difunde a las consolas (`emergency_landing`, `emergency_photo`) y la deja
abierta hasta que alguien la marca como recuperada.

## 6. Consola

- Badges en la tarjeta del dron: «En espera para relevos», «Relevando a Alfa»,
  «Relevo en camino: Bravo».
- Eventos: `RELAY_REQUESTED`, `RELAY_ASSIGNED`, `RELAY_STARTED`,
  `RELAY_HANDOVER`, `RELAY_COMPLETED`, `RELAY_UNAVAILABLE`, `RELAY_CANCELLED`,
  `RTH_DIVERTED`, `EMERGENCY_LANDING`, `EMERGENCY_LANDED`.
- **Aterrizajes de emergencia**: aviso destacado (como las alertas) hasta que
  se marquen recuperados; ficha con mapa (última posición), galería de las
  fotos con su tipo y rumbo, coordenadas para copiar y «Marcar como
  recuperado».

## 7. Qué no cubre

- Coordinar espacio aéreo entre drones (separación vertical/horizontal): se
  confía en las plataformas separadas y en los sensores de obstáculos del
  dron.
- Elegir drones de otra base para un relevo de patrulla (§2 usa solo la base
  de A).
- Probar con drones reales: todo se valida con el simulador y con pruebas
  automáticas; el primer vuelo real tiene que ser con dos aparatos, en campo
  abierto y con un operador por dron.
