# Relevos entre drones, desvío a otra base y aterrizaje de emergencia

Diseño de cuatro comportamientos que involucran a más de un dron o a un lugar
que no es la base propia. Versión 2: incorpora la revisión adversarial
(seguridad de vuelo, protocolo y concurrencia, viabilidad con el MSDK).
El contrato exacto de mensajes está en `PROTOCOLS.md` §1.b (app → hub),
§2.b (hub → app), §3 (hub → consola) y §5 (REST); si cambia, cambian juntos.

**Regla de oro: el regreso a tiempo manda.** Ninguna lógica de relevo o de
desvío puede dejar a un dron sin batería para volver. Ante la duda, el dron
vuelve; ante la duda en el suelo, el dron no despega.

## 0. Conceptos

- **Base**: punto registrado en el Comando Central (`bases`). Puede declarar un
  **punto de aterrizaje para visitantes** (`aterrizajeLat/Lon`, opcional): un
  lugar libre, a ≥ 10 m de toda plataforma, donde baja un dron que se desvía
  desde otra base. Sin ese punto, el visitante baja a
  `DESPLAZAMIENTO_VISITANTE_M = 15` al norte del punto de la base.
- **Estar en una base**: la posición GPS del dron está a menos de
  `RADIO_DE_BASE_M = 50` de la base. El hub usa **la posición del último status**
  (no `drones.base_id`) para saber dónde está cada dron.
- **Fuera de base**: a más de `RADIO_DE_BASE_M` de toda base **y** del punto de
  retorno propio del dron (`KeyHomeLocation`). Un `land` ordenado por una
  persona nunca cuenta como aterrizaje fuera de base.
- **Interruptor «En espera para relevos»** (app del celular): sin él un dron
  nunca despega solo. El operador de campo lo prende después de revisar el
  aparato y su zona de despegue. **Se apaga solo**: al despegar (vale una vez),
  al aterrizar, al cambiar la batería, al desconectarse del dron o del Comando
  Central, al cerrar la pantalla de operación y a los
  `VENCIMIENTO_ESPERA_MIN = 30` minutos.
- **Disponible para relevo** (lo calcula la app, va en `status.relevo`):
  interruptor prendido; conectado al dron; en el suelo; estado `IDLE`; sin
  control manual tomado; `listoParaDespegar` (GPS + punto de retorno); modo de
  vuelo normal (`P-GPS`/`N`); sin la batería por cambiar; batería ≥
  `BATERIA_MINIMA_RELEVO_PCT = 60`; en su base. La app lo vuelve a evaluar
  **entero** al recibir una orden de relevo.
- **Autonomía** (`Telemetry`, `NaN` si no se sabe):
  - Dron real: `FlightControllerKey.KeyLowBatteryRTHInfo` →
    `pctParaVolver` (`batteryPercentNeededToGoHome`), `pctParaAterrizar`
    (`batteryPercentNeededToLand`), `alcanceM` (`maxRadiusCanFlyAndGoHome`),
    `segundosParaVolver` (`timeNeededToGoHome`). Valores `null`, o ceros con el
    dron en vuelo a más de 100 m de casa, se toman como `NaN`.
  - Umbral crítico del propio DJI: `KeySeriousLowBatteryWarningThreshold`
    (`EstadoDelDron.umbralCriticoPct`). Al conectar, si el crítico es ≥ 20 %
    o el de aviso supera `LOW_BATTERY_PCT`, la app avisa `DRONE_PROBLEM`.
  - Simulador: modelo propio (4 %/min en el aire, crucero de 8 m/s,
    `CONSUMO_PCT_POR_KM` derivado de eso), configurable para las pruebas.
  - **Sin autonomía informada no hay desvío ni ventana de gracia**: el piso es
    `LOW_BATTERY_PCT` y el respaldo es el regreso inteligente del propio DJI.

## 1. Umbrales y estados (app, `PatrolManager`)

| Nombre | Valor | Para qué |
|---|---|---|
| `LOW_BATTERY_PCT` | 25 % | Regreso por batería (existe). |
| `RESERVA_PCT` | 5 % | Margen sobre la autonomía. |
| Piso de energía | `pctParaVolver + RESERVA_PCT` | Con autonomía informada, el regreso arranca con `batería ≤ max(LOW_BATTERY_PCT, piso)`. El piso es el disparo para **empezar** a volver; nunca es por sí solo prueba de que no se llega. |
| `UMBRAL_RELEVO_PCT` | `max(35 %, piso + 10)` | Un dron **siguiendo un objetivo** pide relevo. Patrullando no se pide antes de tiempo. |
| `VENTANA_RELEVO_MS` | 60 s | Gracia para esperar un relevo **ya en camino** al llegar al umbral de regreso (ver §3.5). |
| `BATERIA_MINIMA_RELEVO_PCT` | 60 % | Mínimo de un dron en espera. |
| `SEPARACION_VERTICAL_M` | 20 m | Separación entre A y B en el traspaso. |
| `ALTURA_TRANSITO_M` | 60 m (15..120) | Altura de vuelo de un relevo hacia el objetivo y de un desvío. |

Estados nuevos:
- `RELEVANDO`: B despegando o volando hacia el objetivo de un relevo de
  seguimiento. Pertenece a `ESTADOS_EN_VUELO` (valen los failsafes de batería
  y señal) y a `ESTADOS_SIN_ALERTAS`. **No** pertenece a `ESTADOS_QUE_SIGUEN`
  ni a `ESTADOS_REANUDABLES`.
- `ATERRIZAJE_EMERGENCIA`: secuencia del §5. Pertenece a `ESTADOS_DE_REGRESO`
  y a `ESTADOS_SIN_ALERTAS`. Corre en un `Job` que `pasarA` cancela al salir; cada
  paso vuelve a mirar el estado antes de darle una orden al dron.
- El desvío (§4) sigue en `RETURNING_HOME_BATTERY`, con una marca de destino.
- La ventana de relevo es una marca (`ventanaRelevoHastaMs`), no un estado.

Reglas que se agregan:
- Todo regreso por batería pasa por una sola función `regresar()`, que elige
  base propia, base alternativa o §5 según `Autonomia.decidirRegreso(...)`
  (función pura, con pruebas). `checkLowBattery` deja de llamar a
  `controller.returnHome()` directamente.
- Al recuperar la señal nunca se retoma una ruta si la batería es ≤
  `max(LOW_BATTERY_PCT, piso)`.
- `resumePatrol` exige `patrullaEnCurso`.

## 2. Caso A — relevo de patrulla al volver por batería

1. A patrulla la ruta R (próximo nodo k) y entra en regreso por batería. Si
   tenía un patrullaje en curso manda `relay_request {ref, motivo: "patrulla",
   routeId, fromIndex}` y lo repite cada 5 s hasta recibir `relay_status`.
2. El hub elige en **la base donde está A** un dron B disponible (más batería;
   empate: más tiempo en espera) y lo **reserva** (`RESERVADO`). La reserva es
   tentativa: B todavía no sabe nada. Si no hay candidato: `SIN_RELEVO`
   (evento `RELAY_UNAVAILABLE`); el pedido queda pendiente y se asigna si
   aparece uno mientras A no haya aterrizado.
3. Cuando A empieza a bajar en su base (dron real: `KeyGoHomeStatus = LANDING`;
   simulador: comienzo del descenso del regreso) manda `landing_at_base {ref,
   relayId|null, baseId, lat, lon, routeId, fromIndex}` (autosuficiente: si el
   pedido se perdió, el hub lo crea con estos datos). El hub vuelve a elegir
   (prefiere el reservado si sigue disponible) y le manda a B
   `relay_start {relayId, motivo: "patrulla", ruta: {id, name, waypoints},
   fromIndex, de: {droneId, displayName}}` (`ORDENADO`).
4. B vuelve a evaluar su disponibilidad y contesta en ≤ 10 s
   `relay_accept {relayId}` o `relay_reject {relayId, motivo}`
   (`EN_CAMINO` / prueba con el siguiente). Al aceptar: habilita el Virtual
   Stick **en el suelo** y espera la confirmación (si se rechaza: `relay_reject`
   sin despegar); arranca en el teléfono una **cuenta regresiva audible de
   10 s con «Cancelar»** (que manda `relay_reject`).
5. **B despega recién cuando A está abajo**: A informa `landed_at_base` (de
   `Aterrizado`/`ArrivedHome`) o su altura en el status es ≤ 5 m. El hub se lo
   avisa a B con `relay_go {relayId}`. Si se pierde la telemetría de A, B no
   despega hasta que A confirme o un operador ordene la ruta a mano; a los
   `RELEVO_DESPEGUE_MS = 120 s` sin confirmación el relevo pasa a `FALLIDO`.
   Supuesto de campo: **plataformas separadas ≥ 10 m**; B sube en vertical
   por su propia columna. Esto retrasa el despegue de B lo que tarda A en
   bajar (20 a 30 s), a cambio de que nunca se crucen.
6. B patrulla R desde k con el mismo camino que `start_route` y manda
   `relay_ready {relayId}` en el aire (`COMPLETADO`). Si la subida o el
   Virtual Stick fallan después de despegar, B **aterriza** (`land()`) en vez
   de quedar suspendido, y avisa `relay_abort {relayId, motivo}`.
7. Si A se desvía a otra base o entra en §5, manda `rth_diverted {relayId|null,
   baseId|null, lat, lon, motivo: "otra_base"|"emergencia"}`: la plataforma
   de su base queda libre y el hub despacha a B en el acto (`relay_go` junto con
   `relay_start`).

## 3. Caso B — relevo en seguimiento

1. A sigue un objetivo (`ORBITING` o `FOLLOWING`, alerta `PENDING` o
   `VALIDATED`, con `alertId` ya acusado) y su batería baja de
   `UMBRAL_RELEVO_PCT` → `relay_request {ref, motivo: "seguimiento", alertId,
   segundosDisponibles}`, con `segundosDisponibles = (batería − (piso + 3)) /
   consumo medido (%/s)` (o `NaN` sin autonomía). Se repite cada 5 s hasta
   `relay_status`.
2. El hub toma el objetivo del status de A (no del pedido) y elige, entre todos
   los disponibles, el de menor `etaS = 30 + distancia(posición de B, objetivo)
   / 8`, solo si `etaS ≤ segundosDisponibles` y la distancia ≤
   `RADIO_MAXIMO_RELEVO_M = 1500` (tope administrativo). Dos reglas más cuidan
   la separación con A, que es solo vertical (revisión final):
   - B tiene que estar **en la base de la que despegó A** (la de su último
     status en tierra). La altura de cada dron es barométrica desde su propio
     despegue: con otra base, a otra altura del terreno, "A + 20" no deja a B
     20 m por encima de A. Hasta que las bases tengan su altura sobre el nivel
     del mar, B no sale de otra; y si el hub no vio a A en tierra antes de
     volar, no sale ninguno.
   - B no despega a menos de `DISTANCIA_MINIMA_DE_DESPEGUE_M = 100` del
     objetivo ni de A: sube en vertical y cruza la altura de A. La app de B lo
     vuelve a mirar al despegar, con la última estimación y la última
     posición de A (si no, `relay_reject no_disponible`).

   Un relevo **tardío**
   (B llegaría después de que A se vaya) solo sale si la alerta ya está
   `VALIDATED`. Sin candidato: `SIN_RELEVO`, el pedido queda pendiente
   mientras A siga por encima de su piso. Un pedido de seguimiento puede quitarle
   la reserva a uno de patrulla que todavía esté en `RESERVADO`, nunca a uno
   `ORDENADO` o posterior.
3. Al elegido le manda `relay_tracking {relayId, alertId, decision, objetivo,
   de}`; `objetivo` tiene la forma de `status.target` más `vNorteMs, vEsteMs`;
   `decision` sale de la alerta en la base. B contesta `relay_accept`/
   `relay_reject` en ≤ 10 s (misma cuenta regresiva y Virtual Stick en el suelo
   que en §2), despega y pasa a `RELEVANDO`.
4. Mientras dure el relevo, con cada status de A el hub le reenvía a B
   `relay_target {relayId, alertId, decision, objetivo, origen: "en_linea"|
   "sin_enlace"|"retirado", aLat, aLon, aAlt, aEnTierra, ts}` (solo objetivos válidos de
   esa alerta; ver validación en PROTOCOLS). B vuela a `ALTURA_TRANSITO_M` hacia
   la estimación extrapolada (`speedMs`/`courseDeg`, `lastSeenMs` + tiempo de
   viaje). En `RELEVANDO`, una detección de la misma clase a menos de
   `REACQUIRE_GATE_M` de la estimación adelanta la toma; cualquier otra se
   descarta (sin `alert_request`).
5. **Traspaso con separación.** B se detiene a `DISTANCIA_TOMA_M = 60` del
   objetivo, del lado por el que llega, a la altura de A +
   `SEPARACION_VERTICAL_M`, arranca su rastreador con la estimación recibida
   (misma `alertId` y decisión) y manda `relay_ready`. El hub pasa a
   `TRASPASO` y le manda a A `relay_done {relayId, alertId, relevadoPor}`. A
   suelta el objetivo **sin** `TRACKING_ENDED` de pérdida (evento
   `RELAY_HANDOVER`), **primero se aleja en horizontal** a su altura hasta ≥
   100 m del objetivo en dirección a su base, y recién ahí `regresar()` (estado
   `RETURNING_HOME_BATTERY`: volvió por batería). B baja a la altura de
   seguimiento y empieza a orbitar o seguir recién cuando `relay_target`
   muestra a A a > 100 m de la estimación del objetivo que tiene B, o en
   tierra (`aEnTierra`). `origen: "retirado"` solo dice que A ya no lo sigue,
   no dónde está: un A que un operador detuvo queda quieto sobre su órbita, y
   uno que arranca el regreso del DJI sube primero en vertical, ahí mismo; con
   A cerca, o sin su posición, B sigue arriba, en la toma.
   El hub reenvía `relay_done` en cada reconexión de A mientras esté en
   `TRASPASO`; a los 30 s sin confirmación (`relay_released` de A) pasa a
   `COMPLETADO` con `motivoFin: "origen_sin_confirmar"`. Completado con o sin
   confirmación, el hub le sigue mandando a B dónde está A hasta que A esté en
   tierra (o 10 minutos), y un B que se reconecta en la toma lo vuelve a
   recibir en vez de un `relay_cancel`.
   **Ventana de gracia**: si A llega a su umbral de regreso con un relevo
   `EN_CAMINO` (último `relay_status` de hace < 10 s con `etaS` dentro de lo que
   queda), puede seguir hasta `VENTANA_RELEVO_MS`, solo con autonomía
   informada, y corta apenas la batería toca `piso + 3`.
6. **La alerta cambia de dueño.** Columna `alerts.seguida_por` (droneId; NULL =
   el creador). El hub la escribe en el traspaso o cuando A abandona antes, y
   difunde `alert_updated`. Antes del traspaso las decisiones van a A y a B le
   llegan en `relay_target.decision`; después, `alert_decision`, el reenvío al
   reconectar y el encadenado de eventos usan `COALESCE(seguida_por, drone_id)`.
   La consola usa `seguidaPor ?? droneId` para «Ver feed en vivo».
7. **B no hereda la ruta de A.** Un dron que adoptó un seguimiento por relevo
   queda sin ruta; `DISMISSED`, `resume_patrol` o `relay_cancel` → `regresar()`
   a su base (nunca `resumePatrol`). Si A tenía un patrullaje en curso, después
   del traspaso A manda además un `relay_request` de patrulla (§2) para que
   otro dron siga la ruta cuando A aterrice.
8. **Si A se va antes** (llegó a su piso, o el propio DJI tomó el control):
   A avisa `relay_abandon {relayId}` y `TRACKING_ENDED` con la última
   posición; la alerta pasa a `seguida_por = B`; B sigue hacia esa posición e
   intenta reencontrar el objetivo (`TARGET_REACQUIRED`) u orbita la última
   posición a la espera del operador. Como en todo traspaso, B baja a orbitar
   recién con A lejos o en tierra (§3.5): un A que se fue porque un operador lo
   detuvo puede seguir quieto sobre su órbita.
9. **Órdenes del operador durante un relevo.** `start_route`, `stop_patrol`,
   `force_goto` y `resume` hacia B cancelan el relevo (`CANCELADO`, `motivoFin:
   "orden_del_operador"`). Las mismas hacia A en un relevo de seguimiento
   cuentan como `relay_abandon`. Tomar el control de B no cancela nada; al
   soltarlo, `reanudacionAlSoltar` devuelve `none` si el dron participa de un
   relevo activo.
10. Una alerta descartada mientras B está en camino → `relay_cancel {relayId,
    motivo: "alerta_descartada"}` y B vuelve. Si B pierde la señal en
    `RELEVANDO` manda `relay_abort {relayId, motivo: "senial"}` y no retoma el
    relevo al recuperarla.

## 4. Caso D — desvío a otra base

**Prioridad: el dron siempre vuelve a su propia base.** Desviarse es un caso
extremo, solo cuando ya no hay forma de que la batería alcance para volver a
la propia; nunca porque otra base esté más cerca o sea más cómoda. Cada dron
que aterriza en otra base deja la suya con un dron menos, y una base sin drones
no puede relevar ni patrullar. Por lo mismo, todo dron que sale de relevo vuelve
a **su** base al terminar (§3.7), y los umbrales de abajo están puestos para que
el desvío se dispare tarde, no temprano.

- El hub manda `bases {propiaId, bases: [{id, nombre, lat, lon, aterrizajeLat,
  aterrizajeLon}]}` (solo activas) al conectarse cada dron, en cada alta,
  edición, baja o restauración de una base, y al dron cuyo `base_id` cambia.
- **No llega a su base** si, **sostenido durante `CONFIRMAR_NO_LLEGA_MS = 10 s`**,
  `batería < pctParaVolver + MARGEN_DESVIO_PCT (2 %)` o distancia al punto de
  retorno `> alcanceM`. La reserva de §1 se puede gastar en el regreso: no cuenta
  para decidir el desvío. Sin autonomía informada no hay desvío.
- **Costo de otra base**: se escala la cifra del propio DJI,
  `pctOtra = pctParaVolver × dOtra / dCasa` (solo si `dCasa ≥ 200 m`; si no, con
  el consumo medido, mínimo 8 %/km) + subida a `ALTURA_TRANSITO_M` +
  `pctParaAterrizar`. Es candidata si `dOtra < dCasa`, `pctOtra + RESERVA_PCT <
  batería` y está a ≤ `RADIO_ENLACE_M = 2000` de la base propia (donde está
  el control remoto).
- La decisión es **de una sola vía**: una vez desviado no se vuelve a evaluar
  la base propia, y la base elegida no cambia salvo que deje de ser alcanzable
  con la misma confirmación sostenida. El destino comprometido se mantiene
  aunque la base salga de la lista.
- **Cómo se desvía** (dron real): `permitirRthPropioPorBateria(false)`,
  `cancelarRegreso()` (`KeyStopGoHome` y esperar `GoHomeState = IDLE`, tope
  3 s), `fijarFailsafeAterrizar(true)` (`KeyFailsafeAction = LANDING`: si se
  corta el enlace, aterriza donde está en vez de volver a una casa
  inalcanzable), subir a `ALTURA_TRANSITO_M`, `volarHacia(punto de visitantes)`,
  y al llegar `fijarPuntoDeRetornoAqui()` + `land()`. Se intenta además
  `KeyHomeLocation` en la base destino; el rechazo es el caso esperado y se
  registra.
- Si durante el desvío el propio DJI arranca su regreso por batería: un único
  intento de cancelarlo; si vuelve a arrancar, se lo deja seguir (nunca se pelea
  en lazo) y se pasa a §5 cuando corresponda.
- Al decidir el desvío la app manda `rth_diverted`; el hub registra
  `RTH_DIVERTED` y **bloquea los despegues de relevo desde la base destino**
  hasta que llegue el aterrizaje del desviado o pasen 10 min.
- **No llega a ninguna**: si la más cercana es la propia, sigue el regreso del
  DJI y se lo corta recién al disparar §5; si es otra, vuela hacia ella mientras
  la batería esté por encima del disparo de §5, y ahí ejecuta §5. Así baja lo
  más cerca posible de una zona controlada.
- Confirmación de aterrizaje en un desvío o en §5: no se confirma sola; si el
  dron la pide, se corre 10 m y reintenta (hasta 2 veces); recién con batería ≤
  `umbralCritico + 1` se confirma.

## 5. Caso C — protocolo de última ubicación

Disparo: `batería ≤ max(pctParaAterrizar + RESERVA_PCT, umbralCritico + 3)`
fuera de base, o el propio DJI forzó el aterrizaje fuera de base.

Secuencia controlada (estado `ATERRIZAJE_EMERGENCIA`, tope duro 20 s; cada paso
solo si después queda batería ≥ disparo − 3; si no, aterriza):
1. Vuelo estacionario; `fijarFailsafeAterrizar(true)`.
2. Foto **oblicua** (inclinación actual de patrulla).
3. Foto **cenital** (cámara a −90°).
4. Cámara a −30° y **panorámica** a 0°, 90°, 180° y 270° (`girarEnElLugar`),
   una foto en cada uno; solo con el Virtual Stick habilitado.
5. `land()`.
Cada paso espera que la telemetría confirme el rumbo (±5°) y la inclinación
(±3°) y recién ahí cuenta `ASENTAR_MS = 1500`.

Variante sin control de vuelo (el DJI forzó el aterrizaje): solo la cámara
(−90°, después −30°) con una foto por paso, mientras baja.

Cada foto lleva su lugar en la secuencia (`seq`): con control, 0 la oblicua, 1
la cenital y 2 a 5 la panorámica; sin control, 6 la cenital y 7 la panorámica.
Una emergencia que pasa a la variante sin control en el medio (mismo `ref`) no
repite números, y ninguna foto pisa a otra en la cola ni en el hub.

Mensajes (por una **cola persistente** de la app, con reintento, hasta el acuse):
- `emergency_landing {ref, motivo: "autonomia"|"bateria_critica_dji", lat, lon,
  alt, bateria, ts}` → `emergency_ack {ref, emergencyId}`.
- `emergency_photo {ref, seq (0..7), tipo: "oblicua"|"cenital"|"panoramica",
  rumbo, inclinacion, lat, lon, alt, jpegBase64 (≤ 400 000 caracteres), ts}` →
  `emergency_photo_ack {ref, seq}`. Las fotos salen del cuadro para detección
  (1280 px), reescalado si hace falta.
- `emergency_landed {ref, lat, lon, alt, ts}` al tocar tierra: la última
  posición GPS.
- La última posición queda además fija en la pantalla del teléfono.

El hub guarda cada emergencia (`emergencias`, `emergencia_fotos`), idempotente
por `(drone_id, ref)` (y reutiliza una abierta sin aterrizar de menos de 30 min
del mismo dron), y la deja abierta hasta que alguien la marca **recuperada**.

## 6. Consola

- Eventos (los crea **solo el hub**, `source: 'backend'`): `RELAY_REQUESTED`,
  `RELAY_ASSIGNED`, `RELAY_REJECTED`, `RELAY_STARTED`, `RELAY_HANDOVER`,
  `RELAY_COMPLETED`, `RELAY_UNAVAILABLE`, `RELAY_CANCELLED`, `RELAY_FAILED`,
  `RTH_DIVERTED`, `EMERGENCY_LANDING`, `EMERGENCY_LANDED`,
  `EMERGENCY_RECOVERED`. Las apps no los mandan como `event`.
- Hub → consola: `relay_updated {relay}`, `emergency_updated {emergencia}` (sin
  fotos), `emergency_photo {emergenciaId, seq, tipo, rumbo, inclinacion, lat,
  lon, ts, jpegBase64}`, `alert_updated` cuando cambia `seguidaPor`.
  `emergency_*` llegan también al operador de campo, que es quien sale a buscar
  el dron.
- REST: `GET /api/relevos?activos=1`, `GET /api/emergencias?abiertas=1`,
  `GET /api/emergencias/:id` (con fotos), `POST /api/emergencias/:id/recuperada`
  (operador de campo o más). La consola los pide al montar y en cada reconexión.
- Badges en la tarjeta del dron (salen de `relay_updated`): «En espera para
  relevos» («En espera: no puede salir» si ahora no puede; lo dice el texto,
  no sólo el color), «Relevo en camino: Bravo», «Relevando a Alfa».
- Aterrizaje de emergencia: aviso destacado hasta marcarlo recuperado; ficha
  en el mismo pop-up que las alertas (hora, dron, galería de fotos con tipo y
  rumbo, mapa con la última posición, coordenadas para copiar, «Marcar como
  recuperado»). Los eventos de relevo y emergencia se abren desde el historial.
- Bases: el diálogo de edición suma el punto de aterrizaje para visitantes.

## 7. Estado del relevo en el hub

Tabla `relevos(id, motivo, origen, relevo, base_id, alert_id, route_id,
from_index, ref_origen, estado, motivo_fin, rechazados, vence_en, creado_en,
actualizado_en)`; `relayId = relevos.id`. Estados: `RESERVADO` → `ORDENADO` →
`EN_CAMINO` → (`TRASPASO`, solo seguimiento) → `COMPLETADO` | `SIN_RELEVO` |
`CANCELADO` | `FALLIDO`. Vencimientos en `vence_en`, revisados por un barrido de
1 s. Reglas: el hub es la única fuente de verdad de las reservas; un dron con un
relevo activo no es candidato; un relevo activo por `(origen, motivo)` y uno de
seguimiento por `alertId`; respuesta de B en ≤ 10 s o se prueba el siguiente; B
desconectado > 20 s → `FALLIDO`; idempotencia por `(origen, ref)`. Al
reconectarse, si un dron informa un `relayId` activo el hub le reenvía la última
orden (idempotente por `relayId`); si el relevo terminó o no existe, le manda
`relay_cancel`. A recibe `relay_status {ref, relayId, estado, relevo, etaS}` en
cada cambio y cada 5 s mientras esté `EN_CAMINO`.

## 8. Validación y límites

- Todo se valida con pruebas automáticas y con el simulador (que valida los
  flujos y los mensajes, no la recaptura real del objetivo por B).
- Antes del primer vuelo real, en banco con el simulador del MSDK y sin hélices:
  `KeyStopGoHome` con Virtual Stick, `KeyFailsafeAction = LANDING`, la respuesta
  a `KeyHomeLocation` en otra base, `KeyLowBatteryRTHConfirm(false)` y los
  motivos de `FlightControlAuthorityChangeReason`. Y la secuencia de un
  aterrizaje de la app, con `adb logcat -s DjiDroneController PatrolManager`:
  el Virtual Stick deshabilitado antes de `KeyStartAutoLanding` (y que nada lo
  vuelva a habilitar mientras baja: el mando, tomar o soltar el control), el
  modo `AUTO_LANDING` y `KeyIsInLandingMode` durante la bajada, un
  `KeyIsLandingConfirmationNeeded` que ya estaba en pie al llegar la orden, y
  si un `KeyConfirmLanding` repetido mientras lo sigue pidiendo lo baja.
- Primeros vuelos reales: dos aparatos, campo abierto, un operador por dron,
  con los umbrales de batería y de relevo subidos 30 puntos para ejercitar la
  lógica lejos de la batería crítica.
- Solo se comprueba en campo: cuándo el Mini 4 Pro informa `LANDING`, si
  `LowBatteryRTHInfo` viene completo en vuelo, si respeta la cancelación del
  regreso propio, el límite de `KeyHomeLocation`, la latencia de
  `KeyStopGoHome` al Virtual Stick, el giro en el lugar, la protección de
  aterrizaje fuera de base, el despegue con otra plataforma a 10 m y horas en
  espera (temperatura, apagado automático, descarga en el suelo).
- No cubre: coordinar espacio aéreo general entre drones (más allá de la
  separación del traspaso), ni elegir drones de otra base para un relevo de
  patrulla.
