# Contratos de mensajes (MVP)

Todos los enlaces usan WebSocket con mensajes JSON en texto. Los cuadros de video
viajan como JPEG codificado en base64, y son **dos flujos distintos** que salen
del controlador de vuelo de la app:

- Al **Comando Central** le llegan **todos** los cuadros del flujo de la
  consola: **640 px de ancho** (la altura sale de conservar la relación de
  aspecto del stream del dron, que llega en 1920x1080 o 1280x720), calidad 60,
  **5 por segundo** (`CuadroDeVideo.INTERVALO_CUADRO_MS`). Es el video que mira
  el operador y con el que decide, y de ahí sale la captura de cada alerta.
- Al **software de detección** le llega el flujo de la detección: **1280 px de
  ancho** (`CuadroDeVideo.ANCHO_DETECCION`), calidad 75, **uno cada 500 ms como
  mucho** (`CuadroDeVideo.INTERVALO_DETECCION_MS`), o sea **dos por segundo
  como techo**. Va más grande porque el modelo está entrenado con VisDrone a
  1280 px y desde 50 m una persona a 640 px son diez pixeles: a esa escala no
  hay detector que la vea. Y va más espaciado porque detectar no necesita más
  y el enlace con la notebook es el más flojo de los tres.

El techo de la detección lo vuelve a medir `PatrolManager` con **reloj y no
contando cuadros** (`LimitadorDeRitmo`), aunque el controlador ya emita
raleado: es la garantía del contrato y no puede depender de que cada
controlador la cumpla. Si mañana uno emitiera el doble, la detección NO recibe
el doble. El dron **simulado** emite los dos flujos al mismo ritmo que el real,
así que el banco de pruebas mide lo mismo que el campo.

O sea: a la consola le llegan **cinco cuadros por segundo** y a la detección
**dos**, más grandes. Quien dimensione el enlace de la detección tiene que
hacerlo para 2 cuadros de ~150 KB por segundo. Antes de citar un número, mirá
las constantes de `CuadroDeVideo`, no este documento.

El sistema soporta **varios drones simultáneos**. Un dron **no es una cuenta de
usuario**: es un activo del inventario, identificado por un `hash` opaco de 32
caracteres hexadecimales que se genera al darlo de alta. Ese hash es su
`droneId` en todo el protocolo y sale del JWT de emparejamiento: nunca lo
declara el cliente.

## Roles

| Rol | Rango | Permisos |
|---|---|---|
| `drone` | 0 | Token de máquina que la app obtiene al emparejarse por QR. No es una cuenta de usuario |
| `field_operator` | 1 | **Operador de campo**: da de alta drones, genera sus QR y hace el emparejamiento en el terreno. No opera drones ni ve el registro. **Su sesión es efímera** |
| `operator` | 2 | Consola: alertas, rutas, eventos de drones. **Controla drones solo si tiene el flag `canControl`** |
| `supervisor` | 3 | Todo lo del operador + quitar el control manual a otro usuario + administrar operadores y los drones como activos |
| `admin` | 4 | Todo lo anterior + administrar todos los usuarios + ver el registro general del sistema |

Los permisos son jerárquicos por rango, salvo unos pocos que son **laterales**:
el operador de campo puede dar de alta y emparejar drones, cosa que un operador
común no hace. Esos casos se resuelven con una lista explícita de roles, no con
el rango.

Los flags `active` y `canControl`, el borrado lógico y el rol se evalúan **en
vivo** en cada request y en cada envío por WebSocket, no desde el JWT:
suspender, eliminar o degradar a un usuario surte efecto inmediato, aunque su
token siga siendo criptográficamente válido. El rol, además, tiene que ser el
mismo con que se firmó el token: **un cambio de rol termina la sesión**. El token
de antes recibe `401` en la API y `4401` al abrir el WebSocket, y la consola,
ante cualquiera de los dos, borra la sesión y vuelve al inicio de sesión.

### Duración de la sesión según el rol

| Rol | Duración | Por qué |
|---|---|---|
| `field_operator` | **20 minutos** | La sesión solo tiene que durar lo que dura la configuración. Se cierra sola al terminar el emparejamiento, y la app muestra la cuenta regresiva |
| Resto de los humanos | 12 horas | Una jornada de trabajo |
| `drone` | 30 días | Token de máquina que se emite al emparejar; el dron no tiene a nadie que reingrese credenciales |

`POST /api/auth/login` devuelve `expiresIn` en segundos para que el cliente
pueda mostrar el tiempo restante y cerrar la sesión por su cuenta.

## Control manual — bloqueo exclusivo

Un dron puede estar controlado por **un solo usuario a la vez**. El backend
mantiene el lock (`controlledBy`) y lo incluye en la ficha del dron y en cada
`status`. Tomar un dron controlado por otro da `409` (para eso está el **pedido
de control**, abajo); un supervisor puede forzar la liberación («Quitar
control», inmediato como siempre).

### El titular tiene que seguir ahí: 30 s sin señales y se suelta solo

**Mientras tiene el control de un dron, la consola manda `control_heartbeat`
cada 5 s** (§3.b), mire o no mire, mande o no mande: con la pantalla abierta
mirando el video, el control no se pierde. Late la consola entera —el tablero,
la vista del dron o la de pilotaje—, porque el control es de la persona. Cada
mando aceptado del titular (`manual_stick`, `manual_gimbal`) también cuenta como
señal, y tomar el control es la primera.

**Si pasan 30 s sin ninguna señal de vida del titular** —se cortó su red, se
cerró la pestaña, se colgó o se durmió la notebook— **el hub le suelta el
control solo**, con `resume: 'none'` pase lo que pase con el objetivo o con un
relevo (el dron no sale a patrullar porque a alguien se le cayó internet):

- a la app le llega `control_released` con **`motivo: "inactividad"`** (§2): sale
  de `MANUAL`, **queda en vuelo estacionario y le devuelve el mando al control
  físico** (deshabilita el Virtual Stick), para que el que está al lado con el
  RC-N3 lo pueda volar. Con un objetivo o un relevo vuelve a ellos, como con
  cualquier soltar sin orden; aterrizando, sigue bajando; en el suelo, reposo.
  **Mientras el mando siga en el control físico, la app no le da al dron
  ninguna orden de vuelo por su cuenta** —cada una vuelve a habilitar el
  Virtual Stick—: una detección confirmada alerta sin seguimiento (§4), y
  perder o recuperar la señal no lo frena ni le retoma la ruta. Lo termina una
  orden de una persona (tomar el control, una ruta, reanudar, un desvío,
  aterrizar, volver a base), una toma del propio DJI o el regreso por batería;
- a las consolas, `control_changed` con `motivo: "inactividad"` y
  `teniaElControl` (§3), que avisan que el control se soltó solo;
- en el registro, `CONTROL_RELEASED` con `por: "Comando Central"`, `forzado:
  true` y el motivo («X estuvo 30 s sin dar señales desde la consola»).

Desde ahí, desde la consola lo pueden **volver a tomar** o **mandar a
patrullar** (`POST /resume` o una ruta), y el del control físico lo vuela.

**Con un pedido de control encima** (abajo), el titular que cumple 30 s sin
señales no se suelta: **el control pasa en el acto al que lo pidió**
(`vencido`), sin esperar a que venza el pedido. Es lo que la consola le
prometió («si no contesta, el control pasa a vos»), el que pidió está mirando,
y acá nadie eligió una orden que se pise. Si el que pidió ya no puede recibirlo
(perdió `canControl` o no tiene consola), el pedido termina `cancelado` y el
titular se suelta como siempre.

**Cerrar la última consola de la cuenta ya no suelta el control en el acto**:
una pestaña que recarga o un corte de dos segundos le sacaban el dron al que lo
estaba volando. Lo suelta el barrido de arriba, a los 30 s. (Suspenderle el
control, desactivar o dar de baja la cuenta y pasarla a operador de campo lo
siguen soltando en el acto, como antes.) **Cerrar la sesión (`POST
/auth/logout`) sí lo suelta en el acto**: es irse a propósito, y el lock no
puede quedar 30 s a nombre de alguien que no va a volver. Suelta como una baja
(`resume` con la regla de `reanudacionAlSoltar`: `'none'` con objetivo o en un
relevo, `'last'` si no) y cancela sus pedidos.

**El espejo en la app**: si la app se queda **30 s sin el Comando Central con el
control tomado**, lo suelta sola de la misma forma —estacionario, mando al
control físico— (`PatrolManager.CONTROL_SIN_COMANDO_CENTRAL_MS`). Sin enlace
ninguna consola le puede mandar nada, y esperar era dejar al dron clavado en
`MANUAL`. Al volver el enlace, el hub le dice quién cree que lo tiene y la app
le contesta que lo soltó (abajo).

### Pedirle el control a quien lo tiene

Si alguien ya está volando un dron, otro operador con `canControl` puede
**pedirle el control** (`POST /control/request`, §5). La consola primero le
avisa quién lo está piloteando y le pide que confirme («X está piloteando este
dron. ¿Querés pedirle el control?»). Entonces:

1. Si el dron quedó libre en el medio, o ya era suyo, se le da en el acto (`200`,
   `otorgado`).
2. Si no, queda **UN pedido por dron** (`202`, `pendiente`) con **10 s** para que el
   titular conteste. El mismo que vuelve a pedir (otra pestaña, un doble clic)
   recibe el mismo pedido; otro recibe `409` con el nombre del que se adelantó.
   **Sin una consola conectada al hub (el WebSocket caído, reintentando) no
   queda pedido: `409`**; el traspaso le abriría la vista de pilotaje a quien no
   la ve ni late. Todas las consolas reciben `control_request` (§3) y la ficha
   lo trae en `pedidoDeControl` (§6), así que una consola que recarga lo sigue
   viendo. **Una consola descarta sola el pedido que no vio terminar a los 3 s
   de su vencimiento** (`GRACIA_DEL_PEDIDO_MS`): una recarga de `/drones`
   armada antes del final y llegada después lo revivía para siempre.
3. Al titular —en cualquier sección, **también encima de la vista de pilotaje a
   pantalla completa**— le aparece «Y quiere tomar el control» con la cuenta
   regresiva y dos respuestas, **«Mantener el control»** y **«Ceder el
   control»** (`POST /control/request/answer`, solo el titular). El aviso no se
   lleva el foco: el que vuela sigue con el teclado de vuelo; con el foco
   adentro, las teclas de vuelo son de los botones y Escape mantiene. **La
   cuenta del titular termina 1 s antes que el plazo del hub**
   (`MARGEN_DEL_TITULAR_MS`): la suya arranca una latencia tarde, y una
   respuesta que llega vencida cuenta como no contestada. En modo mouse el
   aviso suelta la captura del puntero, y con un diálogo abierto se llega a él
   con el tabulador (los diálogos y los avisos van en la misma capa).
4. **Ceder, o no contestar en 10 s**, pasa el lock al que lo pidió **sin
   soltarlo**: la app recibe `control_transferred` (§2), no sale de `MANUAL`, y
   queda estacionaria donde está a la espera del nuevo titular. Registra
   `CONTROL_TRANSFERRED`. Es lo que destraba una sesión fantasma que el sistema
   cree viva (la consola sigue latiendo, pero nadie la mira). Una respuesta que
   llega con el plazo vencido cuenta como no contestada.
5. **Mantener** deja todo como estaba, y el que pidió se entera.

Cada final llega a las consolas como `control_request_result` (§3), y los que no
son un traspaso dejan `CONTROL_REQUEST_ENDED` en el registro:

| Resultado | Cuándo |
|---|---|
| `cedido` | El titular contestó «Ceder»: el control pasó |
| `vencido` | El titular no contestó en 10 s (o contestó tarde), **o cumplió 30 s sin señales de vida con el pedido encima** (`motivo`: «X estuvo 30 s sin dar señales»): el control pasó |
| `mantenido` | El titular contestó «Mantener» |
| `cancelado` | El que pidió lo canceló (`DELETE /control/request`), cerró su última consola —no se le pasa un dron a quien no está mirando—, perdió `canControl` (o la cuenta) en la espera, **o al resolverse no tenía ninguna consola conectada** |
| `liberado` | El lock se soltó mientras tanto —el titular, un supervisor con «Quitar control», una baja, un cierre de sesión—: el dron quedó libre y **no** se le da solo al que lo pidió (el que soltó pudo haberlo mandado a patrullar); lo toma si todavía lo quiere. **El barrido de señales ya no termina acá**: con un pedido encima, traspasa (`vencido`) |

### El dron que se desconecta: el lock sigue, y al volver se ponen de acuerdo

**El hub ya no borra el lock cuando se cierra el socket del dron**: sigue siendo
de quien lo tenía, que sigue en la consola dando señales de vida. **Cuando un
dron se conecta, lo primero que recibe, siempre, es quién tiene el control**,
antes que cualquier otro mensaje de la reconexión:

- **Sin titular** (también después de un reinicio del hub, que guarda los locks en
  memoria): `control_released` con `by: "Comando Central"` y **`resync: true`**.
  La app que seguía con el control tomado —en `MANUAL` con nadie al mando, que
  es justo donde no alerta (§4)— lo suelta **como el de la inactividad: con el
  mando de vuelta en el control físico**. Ese soltar pasó con la app afuera y
  tampoco lo eligió nadie: el `motivo: "inactividad"` del barrido se pierde si
  el dron estaba desconectado justo al barrer, y un reinicio del hub no avisa.
  A una que no lo tenía tomado no le cambia nada. No va acompañado de un
  `resume_patrol`.
- **Con titular**: `control_taken` con **`resync: true`**, que la app **no** toma
  como una toma nueva. Si ya lo tenía tomado no cambia nada (ni frena, ni le saca
  la ruta que el titular le mandó sin soltarlo). Si no lo tenía —lo soltó sola sin
  el Comando Central, o se reinició— **no lo vuelve a tomar**: contesta
  `control_dropped` (§1) y el hub suelta el lock de ESE titular, sin reanudar
  (`control_changed` con `motivo: "app"`). Tomarlo desde ahí le podría sacar el
  mando a quien lo esté volando con el control físico.

### Qué habilita el lock

Tener el lock es lo que habilita a pilotear: las dos órdenes de vuelo a mano
(`manual_move` por REST y el mando con palancas `manual_stick` por WebSocket,
§3.b) y **la inclinación de la cámara (`manual_gimbal`, también por WebSocket)**
se aceptan **solo del titular**. Pero no se apoyan en lo mismo:

- `POST /manual_move` compara el titular del lock y nada más. La cuenta y el rol
  igual se releen de la base en cada request (es lo que hace `requireAuth` con
  todas), pero **`canControl` no se vuelve a mirar**: para este endpoint, el lock
  hace de permiso.
- `manual_stick` y `manual_gimbal` viajan por un socket que se abrió una vez y
  puede quedar horas abierto, así que además del lock **revalidan la cuenta
  entera contra la base en cada mensaje**: que siga activa, que no esté
  eliminada, que conserve `canControl` y que su rol sea `operator` o superior
  (§3.b).

Hoy la diferencia no se nota porque quitarle `canControl` a alguien le suelta
todos los locks (`releaseAllControlledBy`), así que quedarse con el lock sin el
permiso no es un estado alcanzable. La que no depende de eso para ser correcta
es la del WebSocket.

## Registro (logs)

Toda acción que involucre al sistema queda registrada en la tabla `events`, con
una `category`:

| Categoría | Contenido |
|---|---|
| `drone` | Alta, baja, edición y emparejamiento de drones; conexión/desconexión; patrullaje; alertas generadas y resueltas; batería; señal; control manual; cambios de ruta; renombres; **relevos, desvíos a otra base y aterrizajes de emergencia** |
| `usuarios` | Alta, baja lógica, restauración, activación, suspensión y modificación de usuarios, con **antes y después** |
| `sistema` | Inicios de sesión (exitosos, fallidos y rechazados) y cierre de la sesión efímera del operador de campo |

El **log general** (`GET /api/logs`, solo admin) devuelve todas las categorías
juntas, **filtradas y paginadas en el servidor**; el log de drones
(`GET /api/events`, operador+) devuelve solo `drone`.

### La columna `meta`

`meta` es JSON y guarda el detalle estructurado que la consola despliega al
hacer clic en una entrada del registro (el pop-up del Registro y el panel
lateral del historial de un dron muestran el mismo detalle). Las claves son
siempre las mismas, así el pop-up sabe cómo pintar cada una sin conocer el tipo
de evento:

| Clave | Forma | Cómo se muestra |
|---|---|---|
| `antes` / `despues` | objetos planos con las mismas claves | Dos columnas comparadas con una flecha en el medio, resaltando solo lo que cambió |
| `ubicacion` | `{lat, lon, accuracyM}` o `null` | Mini mapa con un marcador, más las coordenadas |
| `alerta` | `{id, tipo, lat, lon, ts}` | La alerta entera, igual que en su propio pop-up: la captura, un mapa con el punto de la detección (y, si el seguimiento sigue, el objetivo y el dron ahora), el dron, "Ver feed en vivo" y Validar/Descartar si está pendiente. Sale de la lista en vivo de la consola o, si no está ahí, de `GET /api/alerts/:id`. Una fila vieja sin `meta.alerta` pero con la columna `alert_id` se muestra igual |
| **`emergencia`** | **`{id, motivo, lat, lon, ts}`** (`ts` es `creadaEn`) | **Se trae la emergencia completa con `GET /api/emergencias/:id` y se muestra su ficha: galería de fotos con tipo y rumbo, mapa con la última posición, coordenadas para copiar y «Marcar como recuperado»** |
| `drone` | `{hash, displayName, model}` | Ficha compacta del dron (si el evento nombra una alerta, la ficha va adentro del bloque de la alerta) |
| `detalle` | objeto plano | Lista de clave/valor |

La forma exacta por tipo de evento está en la tabla del final de este
documento.

### Trazabilidad de las detecciones

Una detección deja **dos** entradas encadenadas por `alert_id`:

1. `ALERT_CREATED` cuando el algoritmo de detección dispara la alerta: guarda el
   tipo (persona o vehículo), las coordenadas GPS, el dron y la marca de tiempo,
   y queda enlazada a la fila de `alerts`, que es la que tiene la **captura del
   video** que disparó la detección.
2. `ALERT_VALIDATED` o `ALERT_DISMISSED` cuando un operador la resuelve desde el
   Comando Central: guarda **qué usuario** la marcó como válida o inválida y
   cuándo, además del antes y el después del estado de la alerta.

## 0. Modelo de datos

### Drones: activos, no cuentas

Un dron es una fila de la tabla `drones` que el Comando Central administra como
cualquier otro activo del inventario:

| Campo | Descripción |
|---|---|
| `hash` | 32 hexadecimales generados al darlo de alta. **Es el `droneId` de todo el protocolo** y el único contenido del QR. Inmutable |
| `displayName` | Nombre visible. **Editable desde la app y desde el Comando Central**, y el cambio se propaga al otro lado |
| `model` | Modelo del aparato, a título informativo |
| `active` | Si está en `false`, **se rechaza la conexión del dron** (y se corta la que tuviera abierta) |
| `base` | `{name, lat, lon}`: la base a la que vuelve. Se dibuja como cuadrado azul en los mapas |
| `deleted` | Marca de baja lógica: es lo que decide si la fila está dada de baja |
| `deletedAt` / `deletedBy` | Cuándo y quién dio la baja; dato de auditoría |

En la interfaz el hash no se muestra entero nunca: se muestra el nombre y el
hash abreviado (`a3f9c1…7e42`).

### Borrado lógico

**Nada se borra físicamente**, ni usuarios ni drones: se prende `deleted` y se
anotan `deleted_at` y `deleted_by`. La consulta es siempre por la marca y nunca
por la fecha: la fecha es el dato de auditoría, no el interruptor, así que una
fila con fecha pero sin marca está viva. Un usuario eliminado no puede iniciar
sesión, sus sockets se cierran en el acto y **sigue ocupando su nombre de
usuario** (el `UNIQUE` se
mantiene a propósito, para que el historial del registro nunca quede apuntando
a un nombre que después reusó otra persona). De supervisor para arriba se puede
listar lo eliminado y restaurarlo.

### Rutas

Cada waypoint de una ruta es `{ lat, lon, alt, label? }`. `label` es un apodo
opcional que pone el operador para identificar zonas puntuales; se muestra al
hacer clic sobre el nodo en el mapa de la vista de detalle. En ese mapa los
nodos se pintan **rojos** mientras están pendientes y **verdes** una vez que el
dron pasó por ellos (índice ≤ `waypointIndex` del `status`).

## 0.b Emparejamiento por QR

Reemplaza al viejo inicio de sesión del dron con usuario y contraseña.

1. Desde el Comando Central, un operador de campo (o un supervisor) **da de alta
   el dron**. El backend genera su `hash`.
2. La consola dibuja el QR **con el hash como único contenido** y lo imprime
   como sticker, que se pega en el aparato. El QR no lleva nombre, modelo, base
   ni ningún otro dato: si alguien lo fotografía, no aprende nada del sistema.
3. En el campo, el operador **inicia sesión en la app** (sesión efímera de 20
   minutos) y escanea el sticker.
4. La app llama a `POST /api/drones/pair` con el hash **y la ubicación GPS del
   operador en ese momento**. El backend valida que el dron exista, no esté
   eliminado y esté activo, y devuelve un **token de rol `drone`** con el que la
   app se conecta al WebSocket.
5. El emparejamiento queda registrado (`DRONE_PAIRED`) con quién lo hizo, desde
   dónde y con qué dispositivo. La sesión del operador de campo **sigue viva**
   durante la operación (así el operador vuelve al menú de campo al terminar,
   sin reingresar); se cierra cuando el operador la cierra (`FIELD_SESSION_CLOSED`
   con su motivo) o vence sola a los 20 minutos del login.
6. Antes de operar, la app muestra la pantalla de **conexión con el dron
   físico**: verifica el SDK, el control por USB, la aeronave enlazada (modelo y
   número de serie) y el GPS, y no deja desplegar hasta que el enlace esté.

Por qué el hash suelto no alcanza para hacerse pasar por un dron: el
emparejamiento **exige un JWT válido de operador de campo**. El sticker es un
identificador, no una credencial. Aun así, si un dron se compromete se lo
desactiva desde la consola y su conexión se corta en el acto.

## 1. App de control (celular) → Comando Central

Conexión: `ws://<backend>:4000/ws?token=<JWT>` (el rol `drone` sale del token).

| Mensaje | Campos | Efecto en el backend |
|---|---|---|
| `status` | ver tabla de abajo | Se guarda como último estado del dron y se reenvía a los operadores **tal cual** (el hub no filtra campos; solo sanea la posición y **`gimbalPitch`**, ver la tabla) |
| `event` | `eventType, message`, **`alertId?`, `lat?`, `lon?`** | Se persiste en `events` y se reenvía a los operadores. **Con `alertId` la fila queda encadenada a esa alerta** (columna `alert_id` y `meta.alerta`, si la alerta existe y es de ese dron). **Con `lat`/`lon` válidos** (números finitos, dentro de rango, no 0,0) se guardan en `meta.ubicacion` (`accuracyM: null`): es la posición del **objetivo** en los eventos de seguimiento, para que el equipo de tierra la tenga en el registro |
| `video_frame` | `jpegBase64, ts` | Se reenvía a los operadores etiquetado con `droneId`. JPEG de 640 px de ancho, calidad 60; el ritmo es el del controlador (**5 por segundo con el dron real**; el simulado emite al suyo) |
| `alert_request` | `alertType (PERSON\|VEHICLE), lat, lon, snapshotBase64, confidence, classes`, **`ref`, `droneLat?`, `droneLon?`, `droneAlt?`** | Crea fila en `alerts` (PENDING) + evento `ALERT_CREATED`, y notifica a los operadores. `lat`/`lon` son la **posición estimada del objetivo** (no la del dron) y `snapshotBase64` el cuadro **anotado** que disparó la detección. **`confidence`, `classes` y la pose del dron (`droneLat/Lon/Alt`) quedan en `meta.detalle` del `ALERT_CREATED`** (`{confianza, clases, dronLat, dronLon, dronAlt}`). **`ref`** es un identificador que inventa la app (texto ≤ 64): el hub le contesta al dron con `alert_ack {ref, alertId}` (§2), y así la app sabe qué alerta es la del objetivo que está siguiendo |
| `set_name` | `displayName` | Renombra el dron y avisa a los operadores con `drone_renamed` |
| **`control_dropped`** | **`by, motivo`** | **La app no tiene el control que el hub cree que le dio a `by`: lo soltó sola tras 30 s sin el Comando Central, se reinició, o el operador de campo lo soltó con una orden desde el teléfono (volver a base, aterrizar). Lo manda al recibir un `control_taken` con `resync: true` o un `control_transferred` sin tener el control tomado, y en el acto con la orden de campo si el enlace está arriba (sin enlace, el motivo queda para el resync). El hub suelta el lock solo si su titular es `by` (si en el medio pasó a otro, no es de este aviso), con `resume: 'none'`, y registra `CONTROL_RELEASED` con `motivo` (texto, hasta 200 caracteres; sin él, «la app del dron no tenía el control tomado»)** |
| **`relay_*`, `landing_at_base`, `landed_at_base`, `rth_diverted`, `emergency_*`** | **Ver §1.b** | **Relevos entre drones, desvío a otra base y protocolo de última ubicación** |

### Campos de `status`

| Campo | Tipo | Notas |
|---|---|---|
| `state` | string | `IDLE`, `PATROLLING`, `ORBITING` (orbitando el objetivo detectado), **`FOLLOWING` (siguiendo al objetivo detectado porque se mueve)**, `RETURNING_HOME_SIGNAL`, `RETURNING_HOME_BATTERY`, `RETURNING_HOME` (regreso ordenado por el operador de campo desde la app), `LANDED`, `PAUSED` (patrulla interrumpida), `MANUAL` (control manual), `FORCED` (desvío forzado a un nodo), **`RELEVANDO` (despegando o volando hacia el objetivo de un relevo de seguimiento, RELEVOS §3), `ATERRIZAJE_EMERGENCIA` (protocolo de última ubicación, RELEVOS §5)**. Un desvío a otra base sigue en `RETURNING_HOME_BATTERY` |
| `battery` | number | Porcentaje 0..100 |
| `lat`, `lon` | number \| **null** | Posición actual. **`null` sin fix GPS** (interior, arranque en frío): el SDK de DJI entrega 0,0 sin fix y eso no es una posición. La consola no dibuja el dron en el mapa ni le cree a 0,0 |
| **`gpsFix`** | boolean | **`true` si `lat`/`lon` son una posición real.** El status sale igual sin GPS: estado, batería, altura y si vuela llegan siempre que haya enlace con la aeronave |
| **`flightMode`** | string | **Modo de vuelo que informa la aeronave** (`GPS`, `ATTI`, `VIRTUAL_STICK`, …; texto del SDK, solo informativo). `""` si no lo informa (simulador) |
| **`target`** | objeto \| null | **El objetivo que el dron está orbitando o siguiendo** (ver abajo). `null` si no hay ninguno |
| `routeId` | number \| null | Ruta que está patrullando |
| `waypointIndex` | number | Índice 0-based del último waypoint alcanzado |
| `waypointTotal` | number | Cantidad de waypoints de la ruta. La UI muestra `waypointIndex + 1` de `waypointTotal` |
| `signal` | `OK` \| `LOST` | Estado del enlace RC |
| `heading` | number | Rumbo 0..360° hacia donde mira la cámara (el mapa dibuja el cono) |
| `signalPct` | number | Intensidad de señal 0..100 (0 cuando `signal` es `LOST`) |
| `mode` | `TEST` \| `DEPLOY` | Modo elegido en la app tras iniciar sesión |
| `alt` | number | Altura sobre el punto de despegue, en metros (barómetro del dron; 0 en el suelo) |
| `satellites` | number | Satélites GPS en uso (el dron real; el simulado informa 14) |
| `flying` | boolean | `true` con el dron en el aire. En el suelo la app rechaza toda orden de vuelo salvo comenzar un patrullaje, que despega solo |
| **`gimbalPitch`** | number, **opcional** | **Inclinación actual de la cámara en grados: `0` es el horizonte y los negativos miran hacia abajo (`-90`, derecho al suelo).** La app la manda solo si la conoce (el dron real la informa al rato de enlazar). **Una app vieja no la manda: la consola supone `-30` hasta saberla.** El hub la reenvía solo si es un número finito y **sin recortarla** (es lo que el gimbal dice que hace, no una orden); si no lo es, el campo no sale |
| **`relevo`** | objeto, **opcional** | **Si el dron está en espera, disponible o participando de un relevo (ver abajo, "`relevo`"). Una app vieja no lo manda y el hub lo trata como `{enEspera: false, disponible: false, relayId: null, rol: null, fase: null}`** |
| **`autonomia`** | objeto, **opcional** | **Lo que el dron calcula que le cuesta volver y aterrizar (ver abajo, "`autonomia`"). Sin el objeto, o con todos sus campos en `null`, no hay autonomía informada** |

Los campos nuevos el hub los reenvía tal cual: una consola que no los conozca
los ignora. **Las excepciones son `relevo` y `autonomia`: el hub los valida
(§1.b) y, si no pasan, los saca del status que reenvía —el status sale igual,
porque es lo único que dice si el dron vuela— y anota el motivo en el log del
proceso. Un dron con un `relevo` que no pasa la validación no es candidato a
ningún relevo.**

#### `relevo`: en espera, disponible o relevando

| Campo | Tipo | Regla |
|---|---|---|
| `enEspera` | boolean | El interruptor «En espera para relevos» de la app está prendido (RELEVOS §0: se apaga solo al despegar, al aterrizar, al cambiar la batería, al perder el dron o el Comando Central, al cerrar la pantalla y a los 30 minutos) |
| `disponible` | boolean | La app lo calcula entero en cada status (RELEVOS §0: interruptor, enlace, en el suelo, `IDLE`, sin control manual, `listoParaDespegar`, modo de vuelo normal, batería sin cambiar y ≥ 60 %, en su base). `true` con `enEspera: false` es inválido |
| `relayId` | entero \| null | El relevo activo del que participa el dron, en cualquiera de los dos roles; `null` si ninguno |
| `rol` | `"origen"` \| `"relevo"` \| null | `origen` es A (el que pidió), `relevo` es B (el que va). `null` si y solo si `relayId` es `null` |
| `fase` | texto \| null | Dónde está la app dentro del relevo, para el registro y para la reconexión. `null` si y solo si `relayId` es `null`. Con `rol: "origen"`: `pedido` (mandó `relay_request`), `ventana` (estirando el regreso a la espera de un relevo en camino, RELEVOS §3.5), `soltando` (recibió `relay_done` y se aleja del objetivo), `aterrizando` (mandó `landing_at_base`), `desviado` (mandó `rth_diverted`). Con `rol: "relevo"`: `cuenta_regresiva` (aceptó; corre la cuenta de 10 s), `esperando_despegue` (relevo de patrulla: terminó la cuenta y espera `relay_go`), `despegando`, `en_camino`, `traspaso` (mandó `relay_ready` en un seguimiento y espera que A se aleje). Un valor de la lista del otro rol es inválido |

El hub usa `relevo` para elegir candidatos (solo drones con `disponible: true`
y sin relevo activo **en su propia tabla**, que es la única fuente de verdad de
las reservas) y para desempatar: anota él mismo desde cuándo ve `enEspera:
true` (se reinicia cuando lo ve en `false`). Al reconectarse un dron, el
`relayId` de su primer status decide qué se le reenvía (§1.b, "Reconexión").

#### `autonomia`: lo que cuesta volver

Con el dron real sale de `FlightControllerKey.KeyLowBatteryRTHInfo`; con el
simulado, de su modelo de consumo (RELEVOS §0). Cada campo es `null` si no se
sabe (en la app es `NaN`, que el JSON no admite). Sin el objeto, o con todo en
`null`, el dron no tiene autonomía informada: no hay desvío a otra base ni
ventana de gracia.

| Campo | Tipo | Regla |
|---|---|---|
| `pctParaVolver` | número \| null | Batería (%) que necesita para volver a su punto de retorno (`batteryPercentNeededToGoHome`). `[0, 100]` |
| `pctParaAterrizar` | número \| null | Batería (%) que necesita para aterrizar donde está (`batteryPercentNeededToLand`). `[0, 100]` |
| `alcanceM` | número \| null | Radio en metros que puede volar y todavía volver (`maxRadiusCanFlyAndGoHome`). `[0, 100000]` |
| `segundosParaVolver` | número \| null | Segundos que tarda en volver (`timeNeededToGoHome`). `[0, 36000]` |

Un campo fuera de rango, o que no sea número ni `null`, invalida el objeto
entero. La consola lo muestra a título informativo.

#### `target`: el objetivo en seguimiento

Existe desde la detección que disparó la alerta hasta que el seguimiento
termina (alerta descartada, reanudación del patrullaje, regreso a base,
aterrizaje). Mientras existe, la app lo actualiza con cada detección asociada
(ver §4, "Qué hace la app con una detección"), y el status de cada segundo lleva
la estimación vigente:

```json
"target": {
  "alertId": 12,
  "type": "VEHICLE",
  "lat": -34.60412, "lon": -58.38170,
  "speedMs": 4.2, "courseDeg": 118,
  "moving": true,
  "lost": false,
  "lastSeenMs": 600,
  "decision": "PENDING"
}
```

| Campo | Notas |
|---|---|
| `alertId` | Id de la alerta del objetivo (llega a la app con `alert_ack`); `null` hasta entonces |
| `type` | `PERSON` \| `VEHICLE` |
| `lat`, `lon` | Posición **estimada** del objetivo (filtrada; extrapolada con su velocidad hasta 4 s si no se lo ve) |
| `speedMs`, `courseDeg` | Velocidad estimada (m/s) y rumbo de su desplazamiento (0..360) |
| `moving` | `true` si se está desplazando: el dron lo **sigue** (`FOLLOWING`) en vez de orbitarlo |
| `lost` | `true` si hace más de 10 s que no se lo detecta: el dron orbita la última posición conocida |
| `lastSeenMs` | Hace cuánto se lo vio por última vez |
| `decision` | `PENDING` mientras el operador no decidió; `VALIDATED` si la confirmó como real |
| **`vNorteMs`, `vEsteMs`** | **Opcionales. Componentes norte y este (m/s) de la velocidad estimada, números finitos con módulo ≤ 40 (`RastreadorDeObjetivo.VELOCIDAD_MAXIMA_CREIBLE_MS`); `0` y `0` con el objetivo quieto (`moving: false`). Los usa el relevo de seguimiento (§2.b) para que B arranque su rastreador con la velocidad que A ya estimó. Una app vieja no los manda: el hub los saca de `speedMs`/`courseDeg` (`vNorte = speed·cos(course)`, `vEste = speed·sin(course)`) si `moving`, o `0` si no** |

`eventType` usados por la app: `PATROL_STARTED`, `PATROL_RESUMED`,
`PATROL_STOPPED`, `SIGNAL_LOST`, `SIGNAL_RECOVERED`, `RTH_SIGNAL_LOSS`,
`RTH_LOW_BATTERY`, `RTH_MANUAL` (regreso ordenado desde la app), `TAKEOFF`
(despegue automático en curso, del patrullaje o pedido desde la consola),
`LANDING` (**el dron ACEPTÓ el aterrizaje** ordenado desde la app o la consola, o el que la app ordena cuando falla la subida de un relevo: sale cuando el dron lo acepta y está bajando, no al mandarle la orden; si no se puede, en su lugar llega un `DRONE_PROBLEM` que empieza con «No se pudo aterrizar». En el protocolo de última ubicación, RELEVOS §5, sale además al empezar, con la posición del aterrizaje de emergencia),
`ORBIT_STARTED`, `GOTO_ARRIVED`, `FORCED_GOTO`, `CONTROL_RESUMED`, `LANDED`,
`BATTERY_RECHARGED`, `DRONE_PROBLEM` (el dron o su SDK rechazó una orden: el
motivo va en `message`, con un techo de repetición para no inundar el registro.
**«No se pudo aterrizar: …» sale SIEMPRE, sin ese techo: es la respuesta
definitiva a un `land` —el dron no lo aceptó después de tres órdenes, lo aceptó
y no baja, o lo subieron con las palancas del control— y el dron queda
suspendido donde está, con el mando devuelto a quien lo tenía**).
`DETECTION` (detección confirmada que se avisa sin seguimiento: dron en el suelo, a baja altura, sin GPS o con el objetivo imposible de ubicar en el terreno —la cámara al horizonte o más arriba—; con `lat`/`lon` si se pudo ubicar).
**`TARGET_DETECTED` (la detección durante el control manual) ya no sale: en `MANUAL` no se alerta (§4). El hub lo sigue aceptando como cualquier otro `eventType`, por las apps viejas.**
**Seguimiento** (todos con `alertId` si se conoce y con `lat`/`lon` del objetivo):
`TARGET_MOVING` (el objetivo se mueve: el dron deja la órbita y lo sigue),
`TARGET_STOPPED` (se detuvo: el dron vuelve a orbitarlo donde quedó),
`TARGET_LOST` (hace 10 s que no se lo ve: el dron orbita la última posición
conocida, que es la que va al equipo de tierra), `TARGET_REACQUIRED`,
`TRACKING_RESUMED` (el operador soltó el control y el dron vuelve al objetivo),
`TRACKING_ENDED` (el seguimiento terminó: alerta descartada, patrullaje
reanudado, regreso a base o aterrizaje; el motivo va en `message`).

**Eventos reservados al hub.** `RELAY_*`, `RTH_DIVERTED` y `EMERGENCY_*` los
crea **solo** el Comando Central (§7). Un `event` de una app con uno de esos
`eventType` se descarta y se anota en el log del proceso: viniendo del
teléfono serían falsificables, y el registro de un relevo o de una emergencia
tiene que salir del estado que guarda el hub, no de lo que un dron diga.

## 1.b App de control → Comando Central: relevos, desvíos y emergencias

El diseño completo está en `RELEVOS.md`; esta sección y la §2.b son el contrato
exacto de los mensajes. Hay un ejemplo válido de cada uno (y algunos inválidos,
marcados con el motivo) en **`docs/contrato/relevos.json`**, que leen tanto las
pruebas del backend (con `fs`, relativo a la raíz del repo) como las de la app
(`File("../../docs/contrato/relevos.json")`, relativo al módulo
`android-app/app`). Si el contrato cambia, cambian juntos: el documento, el
archivo y las dos puntas.

A es el dron que pide el relevo (el **origen**); B, el que va (el **relevo**).

### Convenciones

| Pieza | Tipo | Regla |
|---|---|---|
| `ref` | texto | De 1 a 64 caracteres; lo inventa la app (un UUID). Se compara **tal cual**, sin recortar. Identifica un pedido a lo largo de todos sus reintentos: el hub es idempotente por `(droneId, ref)` |
| `relayId` | entero | `≥ 1` y entero seguro (`Number.isSafeInteger`). Es `relevos.id`: lo asigna solo el hub |
| `alertId`, `routeId`, `baseId`, `emergencyId` | entero | `≥ 1` y entero seguro |
| `fromIndex`, `seq` | entero | `≥ 0`, con el tope que dice cada mensaje |
| Posición (`lat`, `lon`) | número | Finitos, `\|lat\| ≤ 90`, `\|lon\| ≤ 180` y **no `0,0`** (la regla de `posicionValida` del hub: menos de `1e-6` en los dos es "sin posición"). Donde la tabla dice "posición o `null`", **los dos** vienen `null` (sin fix GPS); uno solo en `null` es inválido |
| `alt` | número | Metros sobre el punto de despegue (barómetro), finito, en `[-200, 1000]`. Puede ser negativo: un dron que se desvía a una base más baja que la de su despegue |
| `bateria` | número | Porcentaje, finito, en `[0, 100]` |
| `ts` | entero | Milisegundos desde el epoch con el reloj **del teléfono**, `> 0`. El hub lo guarda como dato y nunca lo usa para ordenar ni para vencer nada: los relojes no están sincronizados, y para eso usa el suyo |
| Enumerados (`motivo`, `tipo`, `rol`, `fase`, `origen`) | texto | Exactamente uno de los valores listados, en minúsculas y con guion bajo. Los `estado` del relevo van en mayúsculas (§3). Cualquier otro valor es inválido |
| Números | número | Números del JSON: un texto (`"12"`), un `null` donde la tabla no lo admite o un booleano son inválidos. **Nada se convierte**: `Number(null)` es `0`, y un `0` que nadie mandó es un nodo, una altura o una batería inventados |

Un campo obligatorio ausente es inválido. Los campos que la tabla de un mensaje
no nombra **se ignoran**, igual que en `status`: así una versión nueva puede
agregar campos sin romper a la anterior.

**Validación en el hub.** Un mensaje de esta sección que no cumple su tabla se
**descarta entero**, sin contestar y sin cortar la conexión, y se anota en el
log del proceso (`console.warn` con el `droneId`, el `type` y el campo que
falló). No deja fila en `events`: un dron con un defecto que reintenta cada 5 s
inundaría el registro. Se descarta igual —y se anota— un mensaje bien formado
que no corresponde: un `relayId` que no existe, uno en el que ese dron no tiene
el rol que el mensaje supone, o un relevo en un estado en el que ese mensaje no
vale (columna "Vale en"). La única excepción es `relay_accept`, que tiene
respuesta (ver su fila).

### Mensajes

| Mensaje | Quién | Vale en | Efecto en el backend |
|---|---|---|---|
| `relay_request` | A | — | Crea el relevo o devuelve el que ya tiene; contesta **siempre** `relay_status` |
| `relay_accept` | B | `ORDENADO`, con `relevo` = este dron | `EN_CAMINO`, evento `RELAY_STARTED`. Si no corresponde, contesta `relay_cancel {motivo: "vencido"}` |
| `relay_reject` | B | `ORDENADO` o `EN_CAMINO`, con `relevo` = este dron | B pasa a `rechazados` (evento `RELAY_REJECTED`) y se prueba el siguiente candidato |
| `relay_ready` | B | `EN_CAMINO`, con `relevo` = este dron | Patrulla: `COMPLETADO`. Seguimiento: `TRASPASO`, la alerta cambia de dueño y A recibe `relay_done` |
| `relay_abort` | B | `EN_CAMINO` o `TRASPASO`, con `relevo` = este dron | `FALLIDO` (`motivoFin: "relevo_abortado"`) |
| `relay_abandon` | A | Seguimiento, antes de `TRASPASO`, con `origen` = este dron | La alerta pasa a B si hay uno en camino; si no, `CANCELADO` |
| `relay_released` | A | Seguimiento en `TRASPASO`, con `origen` = este dron | `COMPLETADO` |
| `landing_at_base` | A | — | Ordena el relevo de patrulla (`relay_start` a B); lo crea si el pedido se perdió |
| `landed_at_base` | A | — | `relay_go` a B; libera la base destino de un desvío |
| `rth_diverted` | A | — | Evento `RTH_DIVERTED`; despacha a B en el acto y bloquea la base destino |
| `emergency_landing` | cualquiera | — | Abre la emergencia; contesta `emergency_ack` |
| `emergency_photo` | cualquiera | Emergencia con ese `ref` | Guarda la foto; contesta `emergency_photo_ack` |
| `emergency_landed` | cualquiera | Emergencia con ese `ref` | Registra el aterrizaje; contesta `emergency_ack {aterrizada: true}` |

#### `relay_request`: A pide un relevo

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `ref` | texto | sí | El **mismo** en cada reintento de este pedido |
| `motivo` | `"patrulla"` \| `"seguimiento"` | sí | |
| `routeId` | entero | con `patrulla` | La ruta que A patrullaba; tiene que existir y no estar eliminada |
| `fromIndex` | entero | con `patrulla` | El nodo **hacia el que** volaba A (el próximo, no el último alcanzado). `0 ≤ fromIndex <` cantidad de nodos de la ruta |
| `alertId` | entero | con `seguimiento` | La alerta del objetivo: tiene que existir, estar `PENDING` o `VALIDATED` y estar **seguida por A** (`COALESCE(seguida_por, drone_id) = A`) |
| `segundosDisponibles` | número \| null | con `seguimiento` (el campo tiene que estar; puede ser `null`) | Cuánto puede quedarse A sobre el objetivo: `(batería − (piso + 3)) / consumo medido (%/s)`. En `[0, 3600]`. `null` sin autonomía informada |

Los campos del otro motivo se ignoran. **Cuándo**: al entrar en regreso por
batería con un patrullaje en curso (`patrulla`, RELEVOS §2.1), o al bajar de
`UMBRAL_RELEVO_PCT` siguiendo un objetivo con `alertId` ya acusado
(`seguimiento`, RELEVOS §3.1); también A, después de un traspaso, si tenía un
patrullaje en curso (RELEVOS §3.7). La app lo **repite cada 5 s con el mismo
`ref`** hasta recibir un `relay_status` con ese `ref`.

**Efecto**:
- Un `ref` ya visto de este dron (idempotencia por `(origen, ref)`): no crea
  nada; contesta `relay_status` de ese relevo, aunque haya terminado.
- Si `(A, motivo)` ya tiene un relevo activo (uno por origen y motivo, y uno de
  seguimiento por `alertId`), no crea otro: **adopta el `ref` nuevo** (la app
  se pudo reiniciar y perder el viejo) y contesta `relay_status` de ese. En
  seguimiento se adopta **solo el de la misma `alertId`**. En patrulla, si B
  todavía no recibió nada (`RESERVADO` o `SIN_RELEVO`), el relevo toma además
  el `routeId` y el `fromIndex` del pedido nuevo: son los del regreso de ahora.
- **Seguimiento por otra alerta**: A sigue un solo objetivo a la vez, así que
  un relevo de seguimiento activo de A por otra alerta quiere decir que A ya
  dejó ese objetivo, y el hub lo trata como un `relay_abandon` de ese relevo
  (con B en camino la alerta pasa a B; sin B, `CANCELADO` `origen_se_fue`;
  uno en `TRASPASO` termina solo). El pedido nuevo crea su propio relevo:
  nunca se le contesta con el estado ni la `etaS` de un B que va hacia otro
  objetivo, que A usaría para su ventana de gracia.
- Si no, crea el relevo (evento `RELAY_REQUESTED`) y busca candidato con las
  reglas de RELEVOS §2.2 (patrulla: reserva, `RESERVADO`) o §3.2
  (seguimiento: ordena en el acto, `ORDENADO` con `relay_tracking`). En
  seguimiento B tiene que estar **en la base de la que despegó A** (la de su
  último status en tierra: las dos alturas barométricas miden desde el mismo
  cero solo así; si el hub no vio a A en tierra antes de volar, no hay
  candidato) y a **100 m o más del objetivo y de A** (sube en vertical y cruza
  la altura de A). Sin
  candidato: `SIN_RELEVO` (evento `RELAY_UNAVAILABLE`), y el pedido queda
  pendiente hasta que aparezca uno o venza (§3, `motivoFin`; ver "Pedidos que
  vencen sin aviso" más abajo).

#### `relay_accept` y `relay_reject`: B contesta la orden

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId` | entero | sí | El de `relay_start` o `relay_tracking` |
| `motivo` | texto | solo `relay_reject` | `no_disponible` (al reevaluar dejó de estar disponible, RELEVOS §0), `virtual_stick` (no se pudo habilitar el mando virtual en el suelo), `cancelado_en_campo` (el operador apretó «Cancelar» en la cuenta regresiva), `ocupado` (ya participa de otro relevo), `mensaje_invalido` (la orden no pasó la validación de §2.b) |
| `detalle` | texto | no (`relay_reject`) | Hasta 200 caracteres, para el registro («batería al 55 %») |

B contesta en **≤ 10 s** desde la orden; pasado ese plazo el hub lo cuenta
como rechazo (`motivoDeB: "sin_respuesta"` en el evento) y prueba con el
siguiente. Un `relay_reject` puede llegar **después** de un `relay_accept`
(en `EN_CAMINO`): al aceptar, B habilita el mando virtual en el suelo y arranca
la cuenta regresiva de 10 s, y el rechazo del mando virtual o el «Cancelar» del
operador llegan recién ahí. Siempre antes de despegar: con B en el aire lo que
corresponde es `relay_abort`.

`relay_accept` es el único mensaje que **no** se descarta en silencio cuando no
corresponde (llegó tarde, el relevo se reasignó o terminó): el hub contesta
`relay_cancel {relayId, motivo: "vencido"}`, porque B puede estar a segundos de
despegar y tiene que enterarse. Un `relay_accept` repetido en `EN_CAMINO` o en
`TRASPASO` del mismo B no hace nada: en el traspaso es la respuesta de la app al
`relay_tracking` que el hub le reenvía al reconectarse (ver "Reconexión"), y un
`relay_cancel` ahí le haría soltar el objetivo que ya tomó.

#### `relay_ready` y `relay_abort`: B llegó, o no puede seguir

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId` | entero | sí | |
| `motivo` | texto | solo `relay_abort` | `subida` (falló el despegue o la subida: B aterriza con `land()`), `virtual_stick` (se perdió en el aire: B aterriza), `senial` (B perdió la señal en `RELEVANDO`; no retoma el relevo al recuperarla), `bateria` (B llegó a su propio umbral de regreso), `dji` (el propio DJI tomó el control, `FlightEvent.ElDronTomoElControl`), `orden_de_campo` (el operador de campo ordenó volver o aterrizar desde la app), `otro` |
| `detalle` | texto | no (`relay_abort`) | Hasta 200 caracteres |

`relay_ready` sale **en el aire**: en patrulla, con la ruta ya arrancada
(`COMPLETADO`, evento `RELAY_COMPLETED`); en seguimiento, detenido a
`DISTANCIA_TOMA_M` del objetivo con su rastreador ya sembrado (`TRASPASO`,
evento `RELAY_HANDOVER`, `alerts.seguida_por = B` con su `alert_updated`, y
`relay_done` a A). `relay_abort` deja el relevo `FALLIDO` (evento
`RELAY_FAILED`, el motivo en `detalle.motivoDeB`) y A se entera por
`relay_status`. Si fue en `TRASPASO`, la alerta vuelve a A (`seguida_por = A`,
con su `alert_updated`): A ya está soltando y no vuelve al objetivo, pero es el
último que lo tuvo a la vista.

#### `relay_abandon` y `relay_released`: A deja el objetivo

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId` | entero | sí | Un relevo de **seguimiento** de este origen |
| `motivo` | texto | no (`relay_abandon`) | `piso` (llegó a su piso de energía), `dji` (el DJI tomó el control), `orden_del_operador` (`start_route`, `stop_patrol`, `force_goto` o `resume` hacia A, RELEVOS §3.9), `orden_de_campo`, `senial` |

`relay_abandon` vale antes del traspaso. A manda además `TRACKING_ENDED` con
la última posición (§1). Con B `EN_CAMINO`, la alerta pasa a
`seguida_por = B` (`alert_updated`) y B recibe `relay_target` con `origen:
"retirado"`, la última estimación válida y **dónde está A**: `retirado` quiere
decir que A ya no sigue al objetivo, no que se haya ido (un A que un operador
detuvo queda quieto sobre su órbita); con B en `ORDENADO`, la alerta pasa
a B cuando acepte (y si rechaza y no hay otro candidato, `CANCELADO`); sin B
(`SIN_RELEVO`), `CANCELADO`. Los dos `CANCELADO` llevan `motivoFin:
"origen_se_fue"`. Repetido, no hace nada.

`relay_released` vale en `TRASPASO`: A lo manda cuando **ya se alejó ≥ 100 m
del objetivo y arranca su regreso** (`regresar()`), no al recibir `relay_done`.
Con él, el hub marca a A como `retirado` en el `relay_target` siguiente, con la
posición de A, y B baja a la altura de seguimiento cuando esa posición queda a
más de 100 m de **su** estimación del objetivo (§2.b, `relay_target`): mandarlo
antes juntaría a los dos sobre el objetivo. Deja el relevo `COMPLETADO`
(`motivoFin: null`). Repetido, no hace nada; tardío (ya `COMPLETADO` por
`origen_sin_confirmar`), no cambia el estado pero marca a A como `retirado`.

#### `landing_at_base` y `landed_at_base`: A baja y aterriza en una base

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `ref` | texto | solo `landing_at_base` | El `ref` del `relay_request` de patrulla de este regreso |
| `relayId` | entero \| null | sí | El relevo de patrulla de A (el del último `relay_status`), o `null` si no llegó ninguno |
| `baseId` | entero \| null | sí | `landing_at_base`: `propiaId` del último `bases` (§2.b). `landed_at_base`: la base donde tocó tierra (la propia o la del desvío). `null` si la app no la sabe. **Informativo**: el hub ubica al dron por la posición de su último status (RELEVOS §0) |
| `lat`, `lon` | posición o `null` | sí | Dónde está A |
| `routeId` | entero | solo `landing_at_base` | Como en `relay_request` |
| `fromIndex` | entero | solo `landing_at_base` | Como en `relay_request` |

`landing_at_base` sale **una vez**, cuando A empieza a descender en **su**
base al final de un regreso por batería con un relevo de patrulla pedido (dron
real: `KeyGoHomeStatus = LANDING`; simulador: comienzo del descenso del
regreso; las dos llegan como `FlightEvent.DescendiendoEnBase`). Si en ese
momento no hay conexión con el hub, sale al reconectar. Es **autosuficiente**:
si el hub no tiene el relevo (el `relay_request` se perdió), lo crea con estos
datos. Si lo tiene, adopta su `ref` (el de los `relay_status` siguientes) y,
con B todavía sin avisar, su `routeId` y su `fromIndex`. Después vuelve a
elegir B (prefiere el reservado si sigue disponible), le manda `relay_start`
(`ORDENADO`, evento `RELAY_ASSIGNED`) y, sin candidato, `SIN_RELEVO`.
Aterrizando en otra base no se manda: ese relevo ya salió con el
`rth_diverted`.

`landed_at_base` sale al tocar tierra al final de un regreso a una base (la
propia o la del desvío; de `FlightEvent.Aterrizado`/`ArrivedHome`). Nunca por
un `land` ordenado por una persona. Con un relevo de patrulla de A esperando
(`ORDENADO` o `EN_CAMINO`), el hub le manda `relay_go` a B; en `RESERVADO`
despacha en el acto (`relay_start` y `relay_go` juntos); en `SIN_RELEVO` el
pedido vence (`CANCELADO`, `motivoFin: "sin_relevo"`). Si A venía desviado a
esa base, se levanta el bloqueo de sus despegues.

**Pedidos que vencen sin aviso.** `landing_at_base` y `landed_at_base` son
mensajes únicos, y se pierden si al teléfono se le corta el enlace al tocar
tierra; un `land` ordenado por una persona no manda ninguno. Para que un pedido
no quede colgado —y un B que aparece horas después despegue solo hacia una
ruta que ya nadie vuela— el hub también mira los status de A:
- Después del `landing_at_base`, un status de A con `alt ≤ 5` o en tierra
  (`flying: false`) vale como su `landed_at_base`: es "A abajo" para el
  `relay_go` (§2.b) y, para un pedido `SIN_RELEVO`, el último intento de
  asignarlo antes de que venza con `sin_relevo`.
- Sin ese aviso de descenso, A en tierra (`flying: false`, sea cual sea su
  `state`) vence el pedido con `sin_relevo`: en `SIN_RELEVO` en el acto; en
  `RESERVADO`, a los **10 s** (es lo que el hub espera el `landed_at_base`,
  que puede llegar después del status y que despacharía a B). Cuentan solo
  los status de la conexión actual de A: uno en tierra de antes de una
  reconexión no vence nada (sin enlace A pudo despegar y volver, y su pedido
  puede llegar antes que su primer status). Si A se desconecta después de
  posarse, el suyo sigue valiendo.
- Un pedido `RESERVADO` o `SIN_RELEVO` (de patrulla o de seguimiento) vence con
  `sin_relevo` a los **10 minutos sin ningún status de A**, contados desde su
  pedido o desde el arranque del hub si fue después: con la batería con la que
  pidió, A ya está en tierra.

#### `rth_diverted`: A no vuelve a su base

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId` | entero \| null | sí | El relevo de patrulla de A, o `null` |
| `baseId` | entero \| null | sí | La base destino. **Entero con `otra_base`, `null` con `emergencia`**; al revés es inválido |
| `lat`, `lon` | posición o `null` | sí | Dónde está A al decidir |
| `motivo` | `"otra_base"` \| `"emergencia"` | sí | `otra_base`: se desvía a otra base (RELEVOS §4). `emergencia`: entra en el protocolo de última ubicación (RELEVOS §5) sin llegar a ninguna |

Sale al **comprometer** la decisión y se repite en cada reconexión mientras
dure el desvío; si el destino cambia (la base dejó de ser alcanzable, RELEVOS
§4) sale otro con la base nueva. El hub lo trata como idempotente: un desvío
abierto por dron, y un evento `RTH_DIVERTED` por cada destino nuevo. La
plataforma de la base de A queda libre: si A tenía un relevo de patrulla en
`RESERVADO`, `ORDENADO` o `SIN_RELEVO`, el hub despacha a B en el acto
(`relay_start` junto con `relay_go`). Con `otra_base`, **bloquea los despegues
de relevo desde la base destino** hasta el `landed_at_base` de A con ese
`baseId`, hasta un status de A en tierra (`flying: false`: el aterrizaje del
desviado, aunque su aviso no llegue) o hasta 10 minutos. La repetición de un
desvío vigente no se registra otra vez ni estira el bloqueo; un `rth_diverted`
después de eso (con el desvío anterior cerrado o con sus 10 minutos cumplidos)
es un **desvío nuevo**: otro evento y otros 10 minutos de bloqueo.

#### `emergency_landing`, `emergency_photo` y `emergency_landed`: última ubicación

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `ref` | texto | sí | Identifica la emergencia en **todos** sus mensajes: lo inventa la app en `emergency_landing` y lo repite en las fotos y en el aterrizaje |
| `motivo` | `"autonomia"` \| `"bateria_critica_dji"` | `emergency_landing` | `autonomia`: lo disparó el cálculo de la app (RELEVOS §5). `bateria_critica_dji`: el propio DJI forzó el aterrizaje fuera de base |
| `seq` | entero | `emergency_photo` | Lugar de la foto en la secuencia, `[0, 7]`: con control de vuelo, `0` la oblicua, `1` la cenital y `2` a `5` la panorámica; la variante que solo usa la cámara, `6` la cenital y `7` la panorámica. Una emergencia que pasa de una a la otra en el medio (el DJI tomó el vuelo) no repite ningún número |
| `tipo` | `"oblicua"` \| `"cenital"` \| `"panoramica"` | `emergency_photo` | |
| `rumbo` | número | `emergency_photo` | Rumbo de la cámara, `[0, 360]` |
| `inclinacion` | número | `emergency_photo` | Inclinación del gimbal, `[-90, 30]` |
| `jpegBase64` | texto | `emergency_photo` | De 1 a **400 000** caracteres del alfabeto base64 (`A-Z a-z 0-9 + / =`), y empieza con `/9j/` (la marca de inicio de un JPEG). Sale del cuadro para detección (1280 px), reescalado o recomprimido hasta entrar. Con el resto del mensaje queda muy por debajo del tope de 1 MiB por frame |
| `lat`, `lon` | posición o `null` | los tres | En `emergency_landed`, la **última posición GPS** al tocar tierra, que es la que sale a buscar el equipo de tierra |
| `alt` | número | los tres | |
| `bateria` | número | `emergency_landing` | |
| `ts` | entero | los tres | |

**Efecto**:
- `emergency_landing` abre la emergencia (tablas `emergencias` y
  `emergencia_fotos`), idempotente por `(droneId, ref)`. Si el dron ya tiene
  una abierta, **sin aterrizar** y de menos de 30 minutos, el `ref` nuevo se
  asocia a esa en vez de abrir otra (la app pudo reiniciarse en el medio). Con
  una emergencia nueva: evento `EMERGENCY_LANDING` y `emergency_updated`.
  Contesta siempre `emergency_ack {ref, emergencyId, aterrizada}`.
- `emergency_photo` guarda la foto, idempotente por `(emergencia, seq)`: una
  repetida no pisa la guardada. Con una foto nueva: `emergency_photo` y
  `emergency_updated` (cambió `fotos`). Contesta siempre `emergency_photo_ack
  {ref, seq}`. Con un `ref` que el hub no conoce (su `emergency_landing` no
  llegó) se descarta **sin acuse**: la app la reintenta.
- `emergency_landed` registra el aterrizaje (la hora del hub y la posición),
  una sola vez: evento `EMERGENCY_LANDED` y `emergency_updated`. Contesta
  `emergency_ack {ref, emergencyId, aterrizada: true}`. Con un `ref`
  desconocido, como la foto.

La emergencia queda **abierta** hasta que alguien la marca recuperada
(`POST /api/emergencias/:id/recuperada`, §5).

**Cola persistente de la app.** Los tres mensajes salen por una cola que
sobrevive a un reinicio de la app, y cada uno se reintenta con espera creciente
(de 5 s a 60 s, `EsperaCreciente`) hasta su acuse:
- `emergency_landing` sale primero, y nada de esa emergencia sale antes de su
  `emergency_ack` (sin él, el hub no conoce el `ref`). Sale de la cola con
  cualquier `emergency_ack` de su `ref`.
- `emergency_landed` tiene **prioridad sobre las fotos pendientes**: la última
  posición es lo que el equipo de tierra necesita primero. Sale de la cola solo
  con un `emergency_ack` de su `ref` con `aterrizada: true`.
- Las fotos van en orden de `seq`, cada una hasta su `emergency_photo_ack`.

La última posición queda además fija en la pantalla del teléfono.

### Reconexión

Cuando un dron se reconecta, lo primero, sin esperar su status: quién tiene el
control manual —`control_released` con `resync: true` sin titular,
`control_taken` con `resync: true` con titular (ver "Control manual — bloqueo
exclusivo")—. Después, el
`relevo.relayId` de su **primer
status** decide qué hace el hub (RELEVOS §7):
- Un relevo activo en el que el dron tiene ese rol: le reenvía la última orden,
  idempotente por `relayId`. Al relevo (B): `relay_start` o `relay_tracking`
  (más `relay_go` si ya se le había dado). Al origen (A): `relay_status` y, en
  `TRASPASO`, `relay_done`.
- Un relevo terminado o que no existe: `relay_cancel` con `motivo:
  "terminado"` o `"inexistente"`. **Salvo** un seguimiento `COMPLETADO` en el
  que el dron es B y la alerta sigue siendo suya (no descartada, `seguidaPor`
  = B): B puede estar todavía en la toma, arriba, esperando saber que A se fue
  (se perdió el aviso mientras estaba caído, o el hub se reinició y olvidó el
  seguimiento posterior). A ese B no se le cancela nada: el hub le vuelve a
  abrir el seguimiento posterior (§2.b, `relay_target`) por otros 10 minutos y
  le manda en el acto un `relay_target` con lo último que sabe de A.
- `relayId: null` con el dron como B de un relevo activo: en `ORDENADO`, le
  reenvía la orden; en `EN_CAMINO` o `TRASPASO`, el relevo pasa a `FALLIDO`
  (`motivoFin: "relevo_perdio_estado"`): una app que perdió el relevo en el
  aire ya no está volando hacia él.
- `relayId: null` con el dron como A: el hub mantiene el relevo; el próximo
  `relay_request` (con un `ref` nuevo) lo retoma.

Con B desconectado más de 20 s en `ORDENADO`, `EN_CAMINO` o `TRASPASO`, el
relevo pasa a `FALLIDO` (`motivoFin: "relevo_desconectado"`).

## 2. Comando Central → App de control

Los mensajes se dirigen **solo al dron correspondiente**, salvo que se indique.

| Mensaje | Campos | Efecto en el celular |
|---|---|---|
| **`alert_ack`** | **`ref, alertId`** | **Respuesta del hub a un `alert_request`: el id que la alerta recibió. La app lo asocia al objetivo que está siguiendo y lo manda en `status.target.alertId` y en los eventos de seguimiento** |
| `alert_decision` | `alertId, decision (VALIDATED\|DISMISSED), decidedBy`, **`resent?`** | **Se aplica solo si `alertId` es la alerta del objetivo en curso** (o si la app todavía no conoce el id de su alerta, salvo que sea un reenvío: `resent: true` solo vale para la alerta exacta); una decisión sobre una alerta vieja no toca el objetivo nuevo. `DISMISSED`: termina el seguimiento, marca la zona como descartada (§4) y reanuda el patrullaje **hacia el próximo waypoint** de la ruta. `VALIDATED`: el dron sigue sobre el objetivo (órbita o seguimiento) hasta un `resume_patrol`. **Al reconectarse un dron, el hub le reenvía las decisiones de sus alertas de los últimos 10 minutos** (con `resent: true`), por si se decidieron mientras estaba desconectado |
| `resume_patrol` | `orderedBy, fromIndex?`, **`alSoltar?`** | Reanuda el patrullaje; con `fromIndex` vuela hacia ese nodo, **sin él hacia el próximo nodo de la ruta (el que tenía por delante cuando se interrumpió)**. **Termina el seguimiento de un objetivo, si lo había**. **Con `alSoltar: true` es el que acompaña a un soltar que nadie eligió como orden de vuelo (`DELETE /control` con `'last'` o un nodo —la salida de la vista de pilotaje, «Quitar control»—, una baja, un cierre de sesión): con un aterrizaje en curso la app lo ignora y el dron sigue bajando; sin aterrizaje, es la reanudación de siempre. El de `POST /resume`, la orden explícita, va sin la marca y sí corta un aterrizaje** |
| `start_route` | `routeId, fromIndex, orderedBy` | Comienza a patrullar esa ruta. **Con el dron en el suelo es despegar solo: pide GPS, punto de retorno y la misma batería que `takeoff`; si no, `DRONE_PROBLEM` con el motivo** |
| `stop_patrol` | `orderedBy` | Interrumpe el patrullaje: el dron queda en vuelo estacionario (`PAUSED`). **Con un aterrizaje en curso es otra orden de vuelo: lo corta** |
| `force_goto` | `routeId, index, orderedBy` | Vuela forzado hacia ese nodo y queda estacionario sobre él (`FORCED`) |
| `control_taken` | `by`, **`resync?`** | Entra en control manual (`MANUAL`): vuelo estacionario a la espera de movimientos. **Con un objetivo en seguimiento, la app lo sigue estimando con las detecciones mientras el operador vuela. Mientras dure `MANUAL` (en el aire o en el suelo), las detecciones se dibujan en el video pero no generan alertas (§4). Con un aterrizaje en curso no lo frena: el control queda tomado y el dron sigue bajando hasta el suelo. Con `resync: true` (lo manda el hub al reconectarse el dron) NO es una toma: si la app ya lo tenía tomado no hace nada; si no, no lo toma y contesta `control_dropped` (§1)** |
| **`control_transferred`** | **`by, de`** | **El control pasó de `de` a `by` sin soltarse: `de` cedió el pedido de control o no lo contestó en 10 s. En `MANUAL`, en el aire y sin un aterrizaje en curso, la app queda estacionaria donde está (frena la palanca o el salto de 25 m que haya dejado el anterior) y sigue en `MANUAL`, a la espera de `by`; en cualquier otro estado (una ruta que el titular mandó sin soltar, la señal perdida, aterrizando) sigue con lo que estaba haciendo. Sin el control tomado, contesta `control_dropped`** |
| **`takeoff`** | **`by`** | **Despegue automático en el lugar (~1,2 m, el del SDK) y queda suspendido a la espera del mando. Solo con el control manual tomado y el dron en el suelo. No exige GPS (la aeronave se sostiene con sus sensores de visión); sí exige enlace con la aeronave y batería: ni al 25 % o menos, ni por cambiar (aterrizó con la batería baja y todavía no se la cambió, aunque después se haya tomado el control o la lectura haya rebotado; la batería nueva se reconoce por una lectura de 50 % o más en el suelo). Si no despega, la app avisa el motivo con un `DRONE_PROBLEM`** |
| **`land`** | **`by`** | **Aterriza donde está. Solo con el control manual tomado y el dron en el aire. Al tocar el suelo el control sigue tomado (`MANUAL` en el suelo). El aterrizaje se SOSTIENE hasta el suelo (también el que se ordena desde el teléfono): mientras baja, `manual_stick` —incluido el de los cuatro ejes en cero al soltar la palanca, que puede llegar después del `land`—, `manual_move`, el watchdog del mando, `control_taken`, `control_released` y la pérdida de señal no le dan ninguna orden al dron, el regreso por batería no lo pisa y una detección alerta sin seguimiento; `manual_gimbal` sí mueve la cámara. Lo corta otra orden de vuelo de una persona: `start_route`, `resume_patrol` sin `alSoltar`, `force_goto`, `stop_patrol`, o volver a base desde el teléfono. `LANDING` sale cuando el dron lo acepta (el hub ya registró `LANDING_ORDERED` al recibir la orden); si no se puede, `DRONE_PROBLEM` «No se pudo aterrizar: …», que sale siempre** |
| `manual_move` | `bearing, distanceM, by` | **Desplazamiento puntual** de esa distancia en ese rumbo (solo en `MANUAL`, en el aire y con GPS; **con el dron aterrizando se ignora**) |
| `manual_stick` | `pitch, roll, yaw, throttle, by` | **Vuelo continuo con palancas** (solo en `MANUAL` y **en el aire**: en el suelo se descarta en silencio, la consola muestra "despegá primero"; **con el dron aterrizando también, ver `land`**): cada eje es un número en `[-1, 1]` y el dron lo sostiene hasta el mensaje siguiente. Ver §3.b |
| **`manual_gimbal`** | **`pitch, by`** | **Inclina la cámara a `pitch` grados, en ángulo ABSOLUTO** (`0` horizonte, negativo hacia abajo; llega ya recortado a `[-90, 30]`). **Solo con el control manual tomado (`MANUAL`), en el suelo o en el aire**: inclinar la cámara no mueve al dron. En cualquier otro estado se descarta en silencio (patrullando, orbitando o siguiendo, la cámara la maneja la app). No cambia el estado ni toca el vuelo; la inclinación nueva se ve en `status.gimbalPitch`. **Al salir de `MANUAL` la app tira la inclinación que todavía no le pasó al gimbal: después de salir, al gimbal solo puede llegarle la que ya estaba cumpliendo, y la cámara que apunta el estado siguiente (la de patrulla al retomar la ruta, la de la órbita o el seguimiento al volver al objetivo) sale después de esa, nunca antes.** Ver §3.b |
| `control_released` | `by`, **`motivo?`** | Sale del control manual. **Con un objetivo en seguimiento, el dron vuelve a él (`ORBITING` o `FOLLOWING`, evento `TRACKING_RESUMED`)**; sin objetivo, si no llega un `resume_patrol` a continuación queda `PAUSED`. **Desde ahí las detecciones vuelven a alertar como siempre: la próxima confirmada, sin ráfaga de lo que se vio durante el control. Con `motivo: "inactividad"` (el titular estuvo 30 s sin dar señales) el final cambia: el dron que esperaba quieto en `MANUAL` queda `PAUSED` en vuelo estacionario con el mando devuelto al control físico (sin Virtual Stick), en vez de sostenido por la app; con objetivo, relevo, aterrizaje o en el suelo, lo mismo que siempre. Desde ahí la app no le da órdenes de vuelo por su cuenta hasta que una persona dé una (ver "Control manual"). Con `resync: true` (lo manda el hub al reconectarse el dron, sin titular) termina igual que con `motivo: "inactividad"`, si la app todavía lo tenía tomado. `motivo: "app"` (la app avisó con `control_dropped`) no cambia nada: ya lo había soltado** |
| `renamed` | `displayName` | El operador renombró al dron: la app actualiza el nombre que muestra |
| **`bases`, `relay_*`, `emergency_ack`, `emergency_photo_ack`** | **Ver §2.b** | **Relevos entre drones, desvío a otra base y protocolo de última ubicación** |

### `manual_move` y `manual_stick` no son lo mismo

Los dos mueven el dron a mano y los dos solo valen en estado `MANUAL`, pero son
dos formas distintas de pilotear:

| | `manual_move` | `manual_stick` |
|---|---|---|
| Qué es | Un **salto puntual**: "corrémelo 25 metros al este" | **Vuelo continuo**: las palancas de un control físico |
| Parámetros | Rumbo absoluto (0..360°) y distancia en metros | Cuatro ejes en `[-1, 1]`, relativos al cuerpo del dron |
| Cómo llega | REST (`POST /api/drones/:droneId/manual_move`): es un click, uno por vez | WebSocket, ~10 mensajes por segundo mientras la palanca esté tomada |
| Cuándo termina | Cuando el dron llegó; después queda estacionario | Cuando llega un mensaje con los cuatro ejes en `0`, o cuando salta el watchdog de la app |

Los botones de flecha de la consola siguen mandando `manual_move` (25 m por
click); las palancas mandan `manual_stick`.

**Watchdog de mando (en la app)**: estando en `MANUAL`, si pasan 1500 ms sin que
llegue ningún `manual_stick` y el último recibido no era todo ceros, la app pone
los ejes en cero por su cuenta y lo anota en su log local. Es la red de seguridad
ante un corte de internet del celular: sin eso, el dron seguiría volando con la
última velocidad comandada. **Con un aterrizaje en curso no actúa: el dron baja
por su cuenta, y esos ceros le cancelaban el aterrizaje al DJI.**

## 2.b Comando Central → App de control: relevos, desvíos y emergencias

Mismas convenciones que §1.b. Todos van **solo al dron correspondiente**.

| Mensaje | A quién | Cuándo |
|---|---|---|
| `bases` | cada dron | Al conectarse; en cada alta, edición, baja o restauración de una base; al dron cuyo `base_id` cambia |
| `relay_status` | A | En respuesta a cada `relay_request` (reintentos incluidos), en cada cambio de estado del relevo y cada 5 s mientras esté `EN_CAMINO` |
| `relay_start` | B | Al ordenarle un relevo de patrulla (`ORDENADO`); al reconectarse |
| `relay_tracking` | B | Al ordenarle un relevo de seguimiento (`ORDENADO`); al reconectarse |
| `relay_target` | B | Desde que acepta un seguimiento hasta que el relevo termina: con cada status de A (aunque su objetivo no pase) y cada 5 s sin él. Si terminó `COMPLETADO` (con `relay_released` o por `origen_sin_confirmar`), sigue igual hasta el primero con `aEnTierra: true` o 10 minutos: B no baja hasta ver a A lejos o en tierra (RELEVOS §3.5). La reconexión de ese B lo vuelve a abrir (§1.b, "Reconexión") |
| `relay_go` | B | Relevo de patrulla aceptado, cuando A está abajo o se desvió; al reconectarse si ya se le había dado |
| `relay_done` | A | Al pasar a `TRASPASO`, y en cada reconexión de A mientras siga así |
| `relay_cancel` | B, o el que se reconecta | El relevo se cancela, vence o falla con B asignado; `relay_accept` que no corresponde; reconexión con un relevo terminado o desconocido |
| `emergency_ack` | el que abrió la emergencia | En respuesta a cada `emergency_landing` y `emergency_landed` |
| `emergency_photo_ack` | idem | En respuesta a cada `emergency_photo` de una emergencia conocida |

### Validación en la app

La app valida **cada** mensaje de esta sección en un solo lugar
(`CommandCenterClient`, que lo convierte en un objeto tipado o en nada), con las
convenciones de §1.b:
- **`relay_start` o `relay_tracking` inválido**: si trae un `relayId` válido, la
  app contesta `relay_reject {relayId, motivo: "mensaje_invalido"}` y no
  arranca nada (así el hub prueba con otro dron en vez de esperar 10 s); sin un
  `relayId` válido no hay a quién contestarle, y se ignora.
- **Cualquier otro mensaje inválido se ignora** y se anota en el log local. Es
  siempre el lado seguro: un `relay_go` inválido no despega, un `relay_target`
  inválido deja la estimación anterior, un `bases` inválido deja la lista
  anterior (y sin lista no hay desvío: el dron vuelve siempre a la suya), un
  acuse inválido deja el mensaje en la cola.
- **Excepción, `relay_cancel`**: con el `relayId` del relevo activo de la app
  se aplica aunque el `motivo` no sea uno de la lista (se anota como `otro`):
  cancelar es siempre el lado seguro.
- **Un mensaje sobre otro relevo** que el activo: `relay_start` o
  `relay_tracking` se contestan `relay_reject {motivo: "ocupado"}`; el resto
  se ignora.
- **Repeticiones** (el hub reenvía la última orden al reconectar): un
  `relay_start` o `relay_tracking` del relevo que la app ya está atendiendo se
  vuelve a contestar igual (`relay_accept` o `relay_reject`) sin reiniciar la
  cuenta regresiva; un `relay_done` ya atendido vuelve a contestar
  `relay_released` si A ya se alejó.

**Despegar es la única orden de un relevo que puede salir de la app sin una
persona que la apriete en ese momento**, así que antes de cualquier despegue de
relevo la app reevalúa **entera** su disponibilidad (RELEVOS §0), y ante
cualquier duda no despega.

#### `bases`: las bases donde puede bajar

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `propiaId` | entero \| null | sí | La base del dron (`drones.base_id`). `null` si no tiene; si no es `null`, tiene que ser el `id` de una de la lista |
| `bases` | lista | sí | De 0 a 200 bases, **solo las activas y no eliminadas** |
| `bases[].id` | entero | sí | |
| `bases[].nombre` | texto | sí | De 1 a 60 caracteres |
| `bases[].lat`, `bases[].lon` | posición | sí | El punto de la base (sin `null`) |
| `bases[].aterrizajeLat`, `bases[].aterrizajeLon` | número \| null | sí | **Punto de aterrizaje para visitantes** (§5, Bases): los dos números o los dos `null`. Sin él, el visitante baja a `DESPLAZAMIENTO_VISITANTE_M = 15` al norte del punto de la base |

La app **reemplaza** la lista entera con cada mensaje; un mensaje con
cualquier campo inválido se ignora entero. El destino de un desvío ya
comprometido se mantiene aunque su base salga de la lista (RELEVOS §4).

#### `relay_status`: cómo va el pedido de A

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `ref` | texto | sí | El `ref` del `relay_request` que contesta; en los avisos sin pedido, el último que el hub adoptó para ese relevo |
| `relayId` | entero | sí | |
| `estado` | texto | sí | Uno de los estados del relevo (§3, "Objeto relevo") |
| `relevo` | `{droneId, displayName}` \| null | sí | B: el reservado o el ordenado. `null` sin candidato. `droneId` son 32 hexadecimales en minúsculas; `displayName` es texto |
| `etaS` | número \| null | sí | Solo en seguimiento con B asignado: segundos que le faltan a B para llegar (`30 + distancia / 8` al asignarlo, menos lo transcurrido desde entonces, nunca negativo; RELEVOS §3.2). `null` en patrulla o sin B |
| `motivoFin` | texto \| null | sí | En los estados terminales, por qué terminó (§3, "Objeto relevo"); `null` en el resto |

A deja de repetir el `relay_request` al recibir uno con su `ref`; uno con otro
`ref` se ignora. La **ventana de gracia** (RELEVOS §3.5) mira el último
`relay_status` en `EN_CAMINO`: si es de hace menos de 10 s **con el reloj de la
app** (la hora en que llegó, no un campo del mensaje) y su `etaS` entra en lo
que queda. Un estado terminal (`COMPLETADO`, `CANCELADO`, `FALLIDO`) hace que A
olvide el relevo.

#### `relay_start`: B releva una patrulla

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId` | entero | sí | |
| `motivo` | `"patrulla"` | sí | |
| `ruta` | objeto | sí | `{id, name, waypoints}`, como la devuelve `GET /api/routes` |
| `ruta.id` | entero | sí | |
| `ruta.name` | texto | sí | |
| `ruta.waypoints` | lista | sí | De 2 a 60 nodos `{lat, lon, alt, label?}`: posición sin `null`, `alt` en `[0, 500]`, `label` texto de hasta 40 caracteres u omitido |
| `fromIndex` | entero | sí | `0 ≤ fromIndex < ruta.waypoints.length`: el nodo hacia el que volaba A |
| `de` | `{droneId, displayName}` | sí | El dron que B releva (A) |

B reevalúa su disponibilidad y contesta en ≤ 10 s (§1.b). Al aceptar habilita
el mando virtual en el suelo y arranca la **cuenta regresiva audible de 10 s
con «Cancelar»**; despega recién con `relay_go` (si llega durante la cuenta, al
terminarla) y patrulla `ruta` desde `fromIndex` con el mismo camino que
`start_route`.

#### `relay_tracking`: B releva un seguimiento

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId` | entero | sí | |
| `alertId` | entero | sí | La alerta del objetivo |
| `decision` | `"PENDING"` \| `"VALIDATED"` | sí | La de la alerta **en la base**, que es la que manda |
| `objetivo` | objeto | sí | El objetivo según A (ver "Objetivo de un relevo") |
| `de` | `{droneId, displayName}` | sí | El dron que B releva (A) |
| `ts` | entero | sí | Hora **del hub** en que llegó el status de A del que sale `objetivo` |

Igual que `relay_start` hasta la cuenta regresiva; al terminarla B despega **sin
esperar `relay_go`** (A está en el aire, sobre el objetivo) y pasa a
`RELEVANDO`. Un relevo tardío (B llegaría después de que A se vaya) solo se
ordena con la alerta ya `VALIDATED` (RELEVOS §3.2).

#### `relay_target`: dónde está el objetivo ahora

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId`, `alertId`, `decision`, `objetivo` | | sí | Como en `relay_tracking` |
| `origen` | `"en_linea"` \| `"sin_enlace"` \| `"retirado"` | sí | `en_linea`: sale con el status de A que acaba de llegar, **traiga o no un objetivo que pase** (en el traspaso A ya soltó su rastreador y lo manda sin `target`); si no trae, va la última estimación válida. `sin_enlace`: A está desconectado del hub o sin status hace más de 5 s; va la última estimación válida, cada 5 s. `retirado`: A ya no sigue al objetivo (`relay_released`, `relay_abandon` o una orden que cuenta como tal, §2.b `relay_cancel`) o está en tierra; va la última estimación válida, y sale así también con cada status de A y cada 5 s. **El estado de A no cuenta**: un A en `RETURNING_HOME*` sigue `en_linea`, porque el regreso del DJI sube primero en vertical, ahí mismo. **Ningún `origen` le dice a B que puede bajar** (ver abajo) |
| `aLat`, `aLon` | posición o `null` | sí | Posición de A en su último status |
| `aAlt` | número \| null | sí | Altura de A en su último status; `null` si no hay ninguno |
| `aEnTierra` | boolean | sí | `true` si el último status de A dice que está en tierra (`flying: false`); `false` si dice otra cosa o si no hay ninguno |
| `ts` | entero | sí | Hora del hub en que llegó el status de A del que sale **`objetivo`**: identifica esa estimación. Cuando el mensaje lleva la última válida (`sin_enlace`, `retirado`, o un `en_linea` cuyo status no traía un objetivo que pase), es el `ts` de esa, y se repite |

El `ts` **ordena solo el objetivo**: B toma el `objetivo` de un `relay_target`
únicamente si su `ts` es mayor que el del último que tomó (si no, es la misma
estimación o una más vieja, y se queda con la que tiene). `origen`, `aLat`,
`aLon`, `aAlt` y `aEnTierra` los toma de **todos**, aunque el `ts` se repita: son del último
status de A, y los mensajes de una misma conexión llegan en orden (el hub no
reenvía `relay_target` viejos al reconectar). Lo mismo `decision`: es la de la
alerta en el hub al mandar el mensaje. Un `retirado` con el `ts` del
último `en_linea` es lo normal. B **nunca compara `ts` con su propio reloj** (no
están sincronizados). Vuela hacia la estimación extrapolada con
`speedMs`/`courseDeg` y `lastSeenMs` + su tiempo de viaje, y baja a la altura de
seguimiento recién con la **posición de A a más de 100 m de su propia
estimación del objetivo**, o con `aEnTierra: true` (RELEVOS §3.4 y §3.5). Un
`retirado` con A cerca, o sin la posición de A, no alcanza: B sigue arriba, en
la toma.

#### Objetivo de un relevo (`objetivo`)

Es `status.target` de A (§1) con `vNorteMs` y `vEsteMs` siempre presentes. El
hub **solo reenvía objetivos que pasan esto**: si el de un status de A no pasa,
el `relay_target` de ese status lleva la posición de A con el último objetivo
que pasó y su `ts`, y B se queda con su estimación. La app lo vuelve a validar
igual.

| Campo | Tipo | Regla |
|---|---|---|
| `alertId` | entero | Igual al `alertId` del mensaje |
| `type` | `"PERSON"` \| `"VEHICLE"` | El tipo de la alerta |
| `lat`, `lon` | posición | Sin `null` |
| `speedMs` | número | `[0, 40]` |
| `courseDeg` | número | `[0, 360]` |
| `moving`, `lost` | boolean | |
| `lastSeenMs` | entero | `≥ 0` |
| `decision` | `"PENDING"` \| `"VALIDATED"` | El hub la pisa con la de la base: siempre igual a la del mensaje |
| `vNorteMs`, `vEsteMs` | número | Módulo `≤ 40`. Los del status de A, o calculados por el hub (§1, `target`) |

Con él B siembra su rastreador
(`RastreadorDeObjetivo.heredado(...)`): `lat`/`lon` son la estimación de A ya
extrapolada, y `lastSeenMs` es hace cuánto la vio A, así que la extrapolación
total desde la última vista no pasa del tope del rastreador.

#### `relay_go`: B ya puede despegar

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId` | entero | sí | Un relevo de patrulla aceptado por este B |

Sale cuando A está abajo: su `landed_at_base`, o un status de A posterior al
`landing_at_base` con `alt ≤ 5` o en tierra (`flying: false`). También junto
con `relay_start` cuando A se desvió o aterrizó antes de que se ordenara (§1.b). Sin telemetría de A, B no
despega hasta que A confirme o un operador ordene la ruta a mano; a los
`RELEVO_DESPEGUE_MS = 120 s` del `relay_start` sin `relay_go`, el relevo pasa a
`FALLIDO` (`motivoFin: "sin_despegue"`) y B recibe `relay_cancel {motivo:
"vencido"}`.

#### `relay_done`: A ya puede soltar el objetivo

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId` | entero | sí | El relevo de seguimiento de A |
| `alertId` | entero | sí | Tiene que ser la alerta que A sigue; si no, se ignora |
| `relevadoPor` | `{droneId, displayName}` | sí | B |

A suelta el objetivo **sin** `TRACKING_ENDED` de pérdida, se aleja en
horizontal a su altura hasta ≥ 100 m del objetivo en dirección a su base y ahí
arranca `regresar()` y manda `relay_released`. A los 30 s de `TRASPASO` sin
`relay_released`, el relevo pasa a `COMPLETADO` con `motivoFin:
"origen_sin_confirmar"`.

#### `relay_cancel`: B ya no va

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `relayId` | entero | sí | |
| `motivo` | texto | sí | `alerta_descartada` (se descartó la alerta con B en camino o en el traspaso), `vencido` (la respuesta de B llegó tarde, el relevo se reasignó o venció su plazo, como `sin_despegue`), `terminado` e `inexistente` (los dos de la reconexión: el relevo ya terminó, o el hub no lo conoce) |

B en el suelo corta la cuenta regresiva o la espera y no despega; B en el aire
(en `RELEVANDO` o con un seguimiento adoptado) hace `regresar()` a **su** base,
nunca `resumePatrol`. A (en una reconexión) olvida el relevo.

Las órdenes del operador **hacia B** (`start_route`, `stop_patrol`,
`force_goto`, `resume_patrol`) cancelan el relevo en las dos puntas sin un
`relay_cancel`: el hub lo pasa a `CANCELADO` (`motivoFin:
"orden_del_operador"`) y reenvía la orden como siempre, y la app de B, al
recibirla en un relevo, lo olvida y la cumple. Un `relay_cancel` antes de la
orden la haría arrancar un regreso que la orden pisa un instante después. Las
mismas órdenes **hacia A** en un seguimiento son un `relay_abandon` (§1.b).
Tomar el control de B no cancela nada, y soltarlo tampoco: a un dron que
participa de un relevo activo (A o B) el hub lo suelta siempre sin
`resume_patrol` (§5, `DELETE /control`). La orden de reanudar es `POST /resume`.

#### `emergency_ack` y `emergency_photo_ack`

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `ref` | texto | sí | El de la emergencia |
| `emergencyId` | entero | `emergency_ack` | El id de la emergencia en el hub |
| `aterrizada` | boolean | `emergency_ack` | `true` si el hub ya registró el `emergency_landed` de esa emergencia |
| `seq` | entero | `emergency_photo_ack` | `[0, 7]`: la foto que se guardó |

Sacan de la cola de la app el mensaje que acusan (§1.b, "Cola persistente").

## 3. Comando Central → Consola del operador (web)

Conexión: `ws://<backend>:4000/ws?token=<JWT>` (rol `operator`).

| Mensaje | Contenido |
|---|---|
| `status` | Estado de un dron (los campos de arriba + `droneId`, `displayName`) |
| `video_frame` | `droneId, jpegBase64, ts` (JPEG de 640 px de ancho; todos los cuadros que emite el controlador: 5 por segundo con el dron real) |
| `event` | Evento recién persistido (fila completa) |
| `alert_created` | Alerta nueva (fila completa, incluye snapshot) |
| `alert_updated` | Alerta con decisión tomada, **o con otro dron siguiéndola (`seguidaPor` cambió: un traspaso de relevo o un origen que abandonó, RELEVOS §3.6)** |
| `drone_online` / `drone_offline` | `drone` (ficha completa del dron) |
| `drone_updated` | `drone` (ficha completa); se emite al dar de alta, editar, eliminar o restaurar un activo, para que la vista de Drones se refresque sin repreguntar |
| `drone_renamed` | `droneId, displayName` |
| `route_updated` | `route` (ruta completa); se emite al cambiar el apodo de un nodo |
| `control_changed` | `droneId, controlledBy` (username o `null`), **`teniaElControl?`, `motivo?`**. **`teniaElControl` (el titular de antes) va al soltarse y en un traspaso. `motivo` va solo cuando el hub lo soltó solo: `inactividad` (30 s sin señales del titular) o `app` (la app avisó que no lo tenía, `control_dropped`); la consola lo avisa** |
| **`control_request`** | **`droneId, solicitante, titular, venceEn, restanteMs`: alguien le pidió el control a quien lo tiene. `venceEn` es la hora del hub; la cuenta regresiva sale de `restanteMs` (lo que quedaba al salir el mensaje), porque el reloj del navegador no tiene por qué coincidir. Al titular le aparece la respuesta; al que pidió, la espera; los demás no muestran nada** |
| **`control_request_result`** | **`droneId, solicitante, titular, resultado, motivo`: cómo terminó un pedido (`cedido`, `vencido`, `mantenido`, `cancelado`, `liberado`; ver "Control manual"). Con `cedido` o `vencido` llega además el `control_changed` del traspaso** |
| `base_updated` | `base` (la base completa, §5 Bases, **con `aterrizajeLat`/`aterrizajeLon`**); al dar de alta, editar, eliminar o restaurar una base |
| **`relay_updated`** | **`relay` (objeto relevo, abajo), en cada cambio de un relevo. De ahí salen las insignias de la tarjeta del dron: «En espera para relevos» (del `status.relevo`), «Relevo en camino: Bravo» (en A), «Relevando a Alfa» (en B)** |
| **`emergency_updated`** | **`emergencia` (objeto emergencia, abajo, sin fotos): al abrirse, con cada foto nueva (cambia `fotos`), al aterrizar y al marcarse recuperada** |
| **`emergency_photo`** | **`emergenciaId, seq, tipo, rumbo, inclinacion, lat, lon, alt, ts, jpegBase64`: cada foto nueva de una emergencia (las repetidas no salen)** |

Al conectarse, el operador recibe un `status` por cada dron que esté online, para
poder pintar el dashboard sin esperar al próximo tick. **Los relevos activos y
las emergencias abiertas no llegan así: la consola los pide por REST
(`GET /api/relevos?activos=1`, `GET /api/emergencias?abiertas=1`, §5) al montar
y en cada reconexión del socket, y de ahí en más los mantiene con
`relay_updated` y `emergency_updated`.**

**El hub filtra por rol lo que manda**, con los mismos permisos que la API REST y
leyendo el rol de la base, no del token: el operador de campo solo recibe las
novedades del inventario de drones (`drone_updated`, `drone_online`,
`drone_offline`, `drone_renamed`) **y las de las emergencias
(`emergency_updated`, `emergency_photo`: es quien sale a buscar el dron)**, y
nunca video, alertas, relevos, telemetría ni eventos;
los eventos de las categorías `usuarios` y `sistema` solo llegan al admin, que es
el único que puede leer el registro general. Antes de cada envío se comprueba que
el JWT no haya vencido y que la cuenta siga activa; si no, el socket se cierra.

### La alerta: `seguidaPor`

La fila de la alerta (en `alert_created`, `alert_updated`, `GET /api/alerts` y
`GET /api/alerts/:id`) suma **`seguidaPor`**: el `droneId` del dron que sigue
al objetivo ahora, o `null` si es el que la creó (`drone_id`). Sale de la
columna `alerts.seguida_por`; es el único campo de la fila con nombre en
camelCase, porque así lo usan el diseño y la consola. El hub lo escribe en el
traspaso (`relay_ready` de un seguimiento) o cuando A abandona antes; desde ahí
`alert_decision`, el reenvío de decisiones al reconectar y el encadenado de
eventos a la alerta usan `COALESCE(seguida_por, drone_id)`. La consola usa
`seguidaPor ?? drone_id` para «Ver feed en vivo».

### Objeto relevo (`relay`)

Forma que devuelven `relay_updated` y `GET /api/relevos`:

```json
{
  "id": 7, "motivo": "seguimiento", "estado": "EN_CAMINO", "motivoFin": null,
  "origen": { "droneId": "a3f9c1b27d5e4408f61a9c3e772b7e42", "displayName": "Alfa" },
  "relevo": { "droneId": "b7e4209c3f1a4d6e8b2c5a7f9d1e3c40", "displayName": "Bravo" },
  "baseId": 1, "alertId": 12, "routeId": null, "fromIndex": null, "etaS": 74,
  "rechazados": [], "venceEn": null,
  "creadoEn": "2026-10-23T15:04:05.000Z", "actualizadoEn": "2026-10-23T15:04:20.000Z"
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `id` | entero | El `relayId` |
| `motivo` | `"patrulla"` \| `"seguimiento"` | |
| `estado` | texto | `RESERVADO` (patrulla: B elegido pero todavía sin avisar; la reserva es tentativa), `ORDENADO` (B recibió la orden y tiene 10 s para contestar), `EN_CAMINO` (B aceptó), `TRASPASO` (solo seguimiento: B llegó y A está soltando), `SIN_RELEVO` (pedido pendiente sin candidato), `COMPLETADO`, `CANCELADO`, `FALLIDO`. **Activos**: los cinco primeros; **terminales**: los tres últimos |
| `motivoFin` | texto \| null | `null` mientras está activo y en un `COMPLETADO` normal. `COMPLETADO`: `origen_sin_confirmar` (A no confirmó en 30 s). `CANCELADO`: `orden_del_operador`, `alerta_descartada`, `sin_relevo` (el pedido venció antes de avisarle a un B, sin candidato o solo reservado: A aterrizó, se fue o hace 10 minutos que no da noticias, §1.b "Pedidos que vencen sin aviso"), `origen_se_fue` (A abandonó un seguimiento sin B en camino). `FALLIDO`: `relevo_abortado` (`relay_abort`), `relevo_desconectado` (B más de 20 s sin conexión), `sin_despegue` (120 s sin A abajo), `relevo_perdio_estado` (B se reconectó en el aire sin el relevo) |
| `origen` | `{droneId, displayName}` | A |
| `relevo` | `{droneId, displayName}` \| null | B, el reservado o el ordenado; `null` sin candidato |
| `baseId` | entero \| null | La base desde la que sale B (patrulla: la de A; seguimiento: la de B); `null` sin B |
| `alertId` | entero \| null | Seguimiento |
| `routeId`, `fromIndex` | entero \| null | Patrulla |
| `etaS` | número \| null | Como en `relay_status` |
| `rechazados` | lista de `droneId` | Los B que rechazaron o no contestaron, en orden: no se les vuelve a ofrecer este relevo |
| `venceEn` | texto ISO \| null | El próximo vencimiento que revisa el barrido de 1 s del hub (respuesta de B, despegue, traspaso), si hay uno |
| `creadoEn`, `actualizadoEn` | texto ISO | Con el reloj del hub |

### Objeto emergencia (`emergencia`)

Forma que devuelven `emergency_updated`, `GET /api/emergencias` y, con
`fotos` como lista, `GET /api/emergencias/:id`:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | entero | El `emergencyId` |
| `droneId`, `displayName` | texto | El dron |
| `motivo` | `"autonomia"` \| `"bateria_critica_dji"` | |
| `lat`, `lon` | número \| null | Dónde estaba al disparar el protocolo |
| `alt`, `bateria` | número | Al disparar |
| `ts` | entero | El `ts` del teléfono al disparar (dato, no orden) |
| `creadaEn` | texto ISO | Hora del hub al abrirla |
| `aterrizadaEn` | texto ISO \| null | Hora del hub al llegar el `emergency_landed` |
| `aterrizajeLat`, `aterrizajeLon`, `aterrizajeAlt` | número \| null | La última posición al tocar tierra: la que hay que ir a buscar |
| `recuperadaEn` | texto ISO \| null | Abierta mientras sea `null` |
| `recuperadaPor` | texto \| null | Usuario que la marcó |
| `fotos` | entero | Cuántas fotos llegaron (en `GET /api/emergencias/:id`, la lista: ver §5) |

Cada foto (en `emergency_photo`, más `emergenciaId`, y en la lista de §5):
`{seq, tipo, rumbo, inclinacion, lat, lon, alt, ts, jpegBase64}`, con las
reglas de §1.b.

**Validación en la consola.** Todo lo de esta sección sale de filas que el hub
ya validó al recibirlas de la app (§1.b), así que la consola no rechaza
mensajes: los toma por `id` (un `relay_updated` o un `emergency_updated`
reemplaza al que tenía con ese `id`). Lo que sí mira, como con el `status`, es
que una posición sea un número antes de dibujarla: `null` es "sin posición" y no
va al mapa. Un `estado` o un `motivo` que no conoce (un hub más nuevo) se
muestra tal cual, sin traducir.

## 3.b Consola del operador (web) → Comando Central

El socket de la consola es de **doble vía**. Casi todo lo que la consola le pide
al backend va por REST; lo único que sube por el WebSocket es el **mando
virtual** —las palancas y **la inclinación de la cámara**— **y la señal de vida
del control** (`control_heartbeat`), y suben por acá justamente porque no son
acciones sueltas sino un flujo:

| Mensaje | Campos | Efecto en el backend |
|---|---|---|
| `manual_stick` | `droneId, pitch, roll, yaw, throttle` | Si se acepta, se reenvía al dron como `manual_stick` con `by: <username>`. No genera registro |
| **`manual_gimbal`** | **`droneId, pitch`** | **Si se acepta, se reenvía al dron como `manual_gimbal` con `pitch` recortado a `[-90, 30]` y `by: <username>`. No genera registro** |
| **`control_heartbeat`** | **`droneId`** | **La señal de vida del titular (ver "Señal de vida del control"). No le llega al dron ni genera registro** |

```json
{ "type": "manual_stick", "droneId": "a3f9c1…7e42", "pitch": 0.6, "roll": 0, "yaw": -0.3, "throttle": 0 }
```

### Los cuatro ejes

Cada eje es un número en `[-1, 1]`, como la palanca de un control físico. Los
ejes son **relativos al cuerpo del dron** (adelante = hacia donde mira la
cámara), que es exactamente lo que el operador está viendo en el video: no hay
que rotar nada por el rumbo.

| Eje | `+1` | `-1` |
|---|---|---|
| `pitch` | Adelante (hacia la nariz) | Atrás |
| `roll` | A la derecha | A la izquierda |
| `yaw` | Gira en sentido horario | Gira en sentido antihorario |
| `throttle` | Sube | Baja |

Los cuatro son **obligatorios y tienen que ser números**: si alguno falta, viene
en texto (`"0.5"`) o es `null`, se descarta el mensaje **entero**, porque
mandarle al dron tres ejes buenos y uno inventado es peor que no mandarle nada.
Un valor apenas fuera de rango (un `1.4` de la normalización del arrastre del
puntero) **no se descarta: se recorta** a `1`; lo que el operador quiso decir es
"todo para ese lado".

### Zona muerta: |eje| < 0,05 es cero

Un eje cuyo valor absoluto sea **menor** que `0,05` se toma como `0`. El borde
exacto `0,05` **no** es zona muerta (la comparación es estricta): `0.05` mueve el
dron, `0.049` no. Es lo que evita que el mando de la consola —un dedo sobre una
pantalla— deje al dron con una deriva de la que nadie se hace cargo al soltar
despacio la palanca.

La zona muerta la aplican **los dos extremos y no el backend**:

| Quién | Qué hace | Dónde |
|---|---|---|
| Consola web | La aplica **antes de emitir**: un eje bajo el umbral sale como `0` | `MandoVirtual.ZONA_MUERTA` en el frontend |
| Comando Central | **No la aplica**: solo recorta a `[-1, 1]` y reenvía el valor tal cual llegó | `eje()` en `ws.ts` |
| App de control | La aplica **al traducir a velocidades**, después de recortar | `MandoVirtual.ZONA_MUERTA` en el Android |

Para cualquier otro cliente del Comando Central esto importa: mandar
`pitch: 0.03` es un mensaje **válido** —el hub lo acepta y lo reenvía— pero el
dron **no se va a mover**, porque la app se lo come por zona muerta. Si hace
falta el movimiento más chico posible, el valor a mandar es `0,05`.

### Ritmo y cierre

La consola emite a **10 Hz** mientras el mando está tomado, y al soltar la
palanca manda **un último mensaje con los cuatro ejes en `0`**: ese mensaje es el
que deja al dron en vuelo estacionario. Por eso un mando todo en cero es un
mensaje válido y no se filtra.

### Inclinación de la cámara (`manual_gimbal`)

```json
{ "type": "manual_gimbal", "droneId": "a3f9c1…7e42", "pitch": -45 }
```

`pitch` es la inclinación **ABSOLUTA** de la cámara en grados, no un
incremento: `0` es el horizonte, los negativos miran hacia abajo y `-90` es
derecho al suelo. El rango válido es **`[-90, 30]`**: por arriba del horizonte
se deja un poco para mirar un techo o un balcón (cuánto sube de verdad lo decide
la aeronave y su ajuste de inclinación hacia arriba).

- Tiene que ser un **número**: un texto (`"-30"`), `null` o un campo ausente
  descartan el mensaje. Convertirlos daría un `0` que nadie escribió, y eso es
  apuntar la cámara al horizonte.
- Un valor fuera de rango **no se descarta: se recorta** (`-120` llega como
  `-90`), por lo mismo que los ejes de las palancas: sale de un deslizador o de
  un arrastre, y lo que el operador quiso decir es "todo para abajo".
- La consola lo emite **a 10 Hz como mucho, y manda el último valor**: mientras
  el operador arrastra no hace falta mandar cada posición intermedia. Lo emite
  solo mientras tiene el lock de ese dron.
- Se acepta con **las mismas condiciones que `manual_stick`** (ver "Cuándo se
  acepta"), salvo el cupo de ritmo, que es **propio** (ver más abajo).
- La app lo aplica solo en `MANUAL` (§2) y el dron informa la inclinación en la
  que quedó en `status.gimbalPitch` (§1).
- Con el dron real, la app le pasa al gimbal **una inclinación por vez**: espera
  a que el SDK conteste la anterior (con un tope de 2 s) y deja al menos 300 ms
  entre una y otra. Las que llegan mientras tanto se pisan y va la última, que
  no se pierde mientras el dron siga en `MANUAL`. Diez órdenes por segundo al
  gimbal eran diez recorridos que se interrumpían entre sí.
- **Al salir de `MANUAL`** (se soltó el control, se retomó la ruta, batería
  baja, pérdida de señal…) **la inclinación que esperaba su turno se tira**: la
  que el gimbal ya estaba cumpliendo termina —no hay forma de retirársela—, pero
  ninguna otra de la consola le llega después. Y la cámara que apunta la app en
  los modos autónomos va **por la misma fila**, así que sale detrás de esa y no
  la puede pisar una inclinación vieja: antes, una que esperaba llegaba 300 ms
  después de que la ruta apuntara a la de patrulla, y la ruta —que apunta una
  sola vez— seguía mirando al horizonte sin poder ubicar ninguna detección.
- Con la cámara **al horizonte o más arriba**, lo que el detector ve no se
  puede ubicar en el terreno: la alerta sale sin posición del objetivo y sin
  seguimiento (§4, "Qué hace la app con una detección").

### Señal de vida del control (`control_heartbeat`)

```json
{ "type": "control_heartbeat", "droneId": "a3f9c1…7e42" }
```

La consola lo manda **cada 5 s por cada dron cuyo control tiene la cuenta**, y en
el acto al (re)conectarse el socket o al tomar el control. Lo manda la consola
entera y no la vista de pilotaje, sin depender de que el operador mande nada:
el control es de la persona, que puede estar mirando el tablero. Además late al
llegar cualquier mensaje del hub si ya pasaron 5 s, porque con la pestaña en
segundo plano el navegador espacia los temporizadores hasta un minuto y los
mensajes del socket los sigue entregando en el acto.

- Cuenta **solo del titular** de ese dron; el de cualquier otro, o uno sin
  `droneId`, se ignora en silencio.
- **No gasta cupo ni consulta la base** (no mueve nada); sí se comprueba que la
  sesión no haya vencido (si venció, el socket se cierra con `4401`).
- Treinta segundos sin ninguna señal (ni latido ni mando aceptado) y el hub
  suelta el control (ver "Control manual").

### Por qué no es REST

Es la única orden de vuelo que no tiene endpoint REST. A ~10 mensajes por
segundo, abrir un POST por cada uno (con su handshake, su cabecera de
autorización y su respuesta JSON) sería absurdo: el socket ya está abierto, ya
está autenticado y ya entrega en orden. La tabla de endpoints REST de §5 no
cambió por el mando virtual.

### Cuándo se acepta

El mensaje se reenvía al dron **solo si, en ese momento**, se cumple todo esto:

1. La sesión del socket **no venció** (si venció, el socket se cierra con `4401`).
2. El que manda **tiene el lock de control manual de ese dron** (`controlledBy`).
   Es lo primero que se comprueba: el lock es lo que hace exclusivo el mando.
3. La cuenta **sigue activa y no está eliminada**, y conserva `canControl`.
4. Su rol es `operator` o superior. La jerarquía es la de siempre
   (`field_operator` < `operator` < `supervisor` < `admin`), así que el
   supervisor y el admin también vuelan; un rol que **no** esté en esa jerarquía
   se rechaza en vez de dejarlo pasar.

Los puntos 3 y 4 se releen **de la base en cada mensaje**, igual que hace la API
REST con cada request: a un operador al que le acaban de quitar `canControl` o
bajarle el rol no le sirve tener el socket abierto de antes.

Además hay dos topes que no dependen del permiso de nadie, porque su razón de
ser es que una sola consola no pueda dejar sin Comando Central a todo el resto
(el hub es un solo proceso para todas las consolas y todos los drones):

- **Tamaño.** Un frame de más de 1 MiB cierra esa conexión con el código `1009`.
  El tope es grande porque por este mismo servidor entra el video del dron, que
  pesa decenas de KB por cuadro. Encima de eso, un mensaje de consola de más de
  1 KiB se descarta **sin decodificarlo ni parsearlo**: un `manual_stick` no
  llega a 200 bytes, y decodificar y parsear es justamente el trabajo caro que
  conviene no regalar. Ese 1 KiB se cuenta en **bytes del frame como llegó**, no
  en letras: un mensaje lleno de acentos o de eñes pesa en UTF-8 más que su largo
  en caracteres y el que se pasa de 1 KiB en bytes se descarta igual.
- **Ritmo.** Cada socket tiene un cupo de mando que se repone solo. El contrato
  manda 10 Hz y el cupo tolera el doble sostenido, más una ráfaga para absorber
  los tirones del temporizador del navegador: corta la inundación, no al
  operador que está volando. **Las palancas y la cámara tienen un cupo cada
  una**: el operador puede arrastrar la cámara mientras sostiene la palanca, y
  con un cupo compartido la cámara le podría comer al mando el mensaje de los
  cuatro ejes en cero que deja al dron estacionario.

Si algo de eso no se cumple, el mensaje se descarta **en silencio**: no se le
contesta nada a la consola. Contestar no serviría, porque la consola ya se entera
del estado del lock por `control_changed`, y a 10 Hz una respuesta por cada
mensaje descartado sería una avalancha que nadie mira. Un frame que no es JSON,
uno que es JSON pero no un objeto (`null`, un arreglo, un número suelto) y un
`type` que el hub no conoce también se ignoran sin cortar la conexión.

**El mando —palancas y cámara— no deja entradas en el registro.** A 10 Hz
inundaría la tabla `events` y taparía todo lo demás. Lo que queda registrado es
tomar y soltar el control (`CONTROL_TAKEN` / `CONTROL_RELEASED`), que es lo que
la auditoría necesita: quién tuvo el mando de qué dron y desde cuándo.

## 4. App de control (celular) ↔ Software de detección (notebook)

El celular va enganchado al control RC-N2/RC-N3 por su **único puerto USB**,
así que el enlace con la notebook que corre la detección es **por Wi-Fi, sí o
sí** (el USB-C de abajo del control es solo carga y DJI Assistant). Celular y
notebook tienen que estar en la misma red: el hotspot del celular o la Wi-Fi
del lugar. Hay tres modos, elegibles desde la app:

### Modo `AUTO` (por defecto): la notebook se anuncia

El servidor de detección (`detection/servidor.py`) manda **cada segundo**, por
UDP a toda la red (broadcast, puerto **8766**), un anuncio:

```json
{ "service": "dronepatrol-detection", "port": 8765, "name": "notebook-campo" }
```

La app escucha ese puerto (`DescubridorDeDeteccion`), toma la dirección de la
que vino el datagrama y se conecta a `ws://<esa-ip>:<port>/phone`. Cualquier
otro datagrama se ignora: solo cuenta un JSON con ese `service` y un puerto
válido. Si llega un anuncio de otra dirección (la notebook cambió de IP), la
app cierra el socket y se va a la nueva. Mientras no llegó ninguno, la pantalla
dice que está buscando; no es un fallo.

El servidor manda el anuncio **por cada interfaz de red real** (con un socket
atado a la IP de esa interfaz): al broadcast dirigido calculado con la
**máscara verdadera** de la interfaz (una red /22 como `192.168.68.0/22` tiene
el broadcast en `192.168.71.255`, no en `.255` del tercer octeto) y a
`255.255.255.255`. Las interfaces virtuales (VMware, Hyper-V/WSL, VPN TAP/TUN,
loopback, APIPA `169.254/16`) se saltean. La app toma un `MulticastLock` de
Wi-Fi para que el teléfono no filtre los broadcast en el chip.

**El descubrimiento es de ida y vuelta.** Mientras busca, la app también se
anuncia: cada 2 s manda por broadcast al puerto **8766**

```json
{ "service": "dronepatrol-app", "port": 8766, "name": "S23 Ultra" }
```

y el servidor, que escucha ese puerto, le contesta **por unicast** a la IP de
origen con el mismo anuncio de siempre (`dronepatrol-detection`). Así el enlace
se arma aunque el broadcast de la PC se pierda (Windows lo manda por una sola
interfaz, una VPN con mejor métrica se lo lleva, el router no lo reenvía): el
del teléfono casi siempre llega, y la respuesta unicast también.

En el teléfono, los sockets de la detección (el UDP del descubrimiento y el
WebSocket) se atan a la **red Wi-Fi** cuando hay una: con una Wi-Fi sin
internet (el router del lugar, sin salida) Android pasa la red por defecto a
los datos móviles y un socket sin red asignada nunca llegaría a la notebook.
Con el teléfono como hotspot no hay red Wi-Fi cliente y se usa la de siempre.

### Modo `CABLE` (banco de pruebas)

Túnel de ADB sobre el cable USB, **solo sin el control enchufado** (emulador o
pruebas de escritorio). En la laptop, una vez: `adb reverse tcp:8765 tcp:8765`,
y la app se conecta a `ws://127.0.0.1:8765/phone`.

### Modo `RED` (respaldo)

URL manual (`ws://<ip-de-la-notebook>:8765`), para cuando los anuncios no
llegan (una red que filtra broadcast). Desde el emulador de Android Studio la
PC es `ws://10.0.2.2:8765`.

### Contrato de mensajes

Este es el contrato que implementa `detection/servidor.py` (el software real,
con YOLO11) y que `detection-mock/` respeta como placeholder sin GPU.

| Dirección | Mensaje | Campos |
|---|---|---|
| celular → notebook | `video_frame` | `jpegBase64, ts` (JPEG de **1280 px de ancho**, calidad 75, **hasta 2 por segundo**). **`ts` es la hora de captura del cuadro, con el reloj del teléfono** |
| notebook → celular | `detection` | `detected (bool), classes (["PERSON"\|"VEHICLE"]), confidence, boxes[], snapshotBase64?, ts`, **`frameTs`** |

**`frameTs` es el `ts` del `video_frame` que se analizó, devuelto tal cual.**
Entre la captura y la respuesta pasan de 0,3 a 1 s (cola, Wi-Fi, inferencia), y
en ese lapso el dron se movió y giró: la app georreferencia la caja con la pose
del dron **en el instante del cuadro** (guarda los últimos segundos de
telemetría y usa la muestra más cercana a `frameTs`), no con la de cuando llegó
la respuesta. `ts` sigue siendo la hora del servidor.

Cada elemento de `boxes` es `{cls, conf, x, y, w, h}` con **`x`, `y` el centro
y `w`, `h` el tamaño, normalizados 0..1** sobre el cuadro (origen arriba a la
izquierda): así valen igual sobre el cuadro de 1280 px que analizó el detector
y sobre el de 640 px que mira la consola. `snapshotBase64` es el **cuadro
anotado con las cajas**, reducido a 640 px, y viene solo con `detected: true`:
es la captura que la app adjunta a la alerta. `boxes` y `snapshotBase64` son
opcionales (el mock no los manda): sin ellos la app orbita su propia posición y
adjunta el último cuadro de la consola.

Es un flujo **aparte** del que va al Comando Central (ver el principio de este
documento): más grande y más espaciado. El servidor contesta **un `detection`
por cada cuadro procesado**, detecte o no; si la GPU no da abasto descarta el
cuadro viejo y nunca acumula retraso.

### Qué hace la app con una detección

1. **Guarda las cajas** y las dibuja sobre el video que sube al Comando Central
   durante 1,5 s (`PatrolManager.VIGENCIA_CAJAS_MS`), en cualquier estado: el
   operador ve marcado lo que el detector ve, también mientras orbita **y
   mientras maneja él (`MANUAL`), que es cuando las cajas son el único aviso**.
2. **Ubica cada caja en el terreno** con la pose del dron en el instante del
   cuadro (`frameTs`): altura, rumbo de la cámara e inclinación del gimbal
   (`Georreferencia`). Sin GPS o por debajo de 2 m de altura no hay proyección
   posible, y tampoco para una caja cuyo rayo no baja al menos 5° por debajo
   del horizonte (la cámara al horizonte o más arriba, que el operador puede
   pedir con `manual_gimbal`). En todos esos casos la caja queda **sin
   posición**, nunca con la del dron, que con la cámara levantada es justo
   donde el objetivo no está. Una detección sin cajas (el detector de
   respaldo) cuenta en la posición del dron solo si el centro del cuadro se
   puede proyectar; si no, también queda sin posición.
3. **Toda detección confirmada avisa al Comando Central**: dos detecciones de
   la misma clase en menos de 2,5 s y a menos de 25 m una de otra (un solo
   cuadro no alerta). No se alerta despegando (el detector ve al equipo de
   tierra), volviendo a base **ni en control manual** (punto 4). Las
   detecciones que caen en una **zona
   descartada** (40 m alrededor de un falso positivo descartado en los últimos
   5 minutos) no alertan, y en los 10 s siguientes a retomar la ruta por un
   descarte tampoco.
4. Cómo alerta depende de dónde está el dron:
   - **En el aire, a 8 m o más y con GPS, patrullando, en pausa o en un
     desvío**: **orbita el objetivo** a 30 m con la cámara apuntada al centro
     y arranca el seguimiento (`ORBIT_STARTED`).
   - **En el suelo, a baja altura, sin GPS o con el objetivo sin posición**
     (o en el aire sin patrullar), **aterrizando o con el mando devuelto al
     control físico** (la órbita es el Virtual Stick, que le sacaría el dron a
     quien lo vuela con las palancas): alerta sin seguimiento (`DETECTION`),
     como mucho una por minuto.
   En los dos casos manda `alert_request` (tipo, **captura anotada**,
   posición del objetivo si se pudo ubicar, confianza, pose del dron y un
   `ref`) y, con seguimiento, queda a la espera del `alert_ack`.

   **En control manual (`MANUAL`, en el aire o en el suelo) no alerta**: ni
   `alert_request`, ni seguimiento nuevo, ni evento. El dron lo maneja una
   persona que mira ese mismo video con las cajas encima (punto 1), y una
   alerta le taparía la pantalla para avisarle lo que ya está viendo. La
   detección ni siquiera cuenta como primera de una confirmación: nada de lo
   visto durante el control se guarda, y al salir de `MANUAL` (soltar el
   control, o una orden que lo saca sin soltarlo) la próxima detección
   confirmada alerta como siempre, sin ráfaga. La regla es el **estado**, no
   el lock: con el control tomado y el dron volando solo (una ruta, un desvío
   o un "Detener" pedidos sin soltarlo, que dejan el mando sin efecto) se
   alerta como siempre. Un objetivo que ya se seguía al tomar el control no
   es una alerta nueva: se lo sigue estimando (punto 5) y su alerta sigue
   esperando la decisión.
5. **Seguimiento.** Mientras haya objetivo (órbita, seguimiento, o control
   manual con un objetivo que ya se seguía al tomarlo), cada detección de la
   misma clase que cae cerca de donde se lo espera se asocia a él y alimenta un filtro de velocidad
   constante (`RastreadorDeObjetivo`): posición suavizada y velocidad.
   - Si **se mueve** (más de 1,2 m/s sostenido en 3 detecciones, o más de 15 m
     desde donde se lo vio quieto): deja la órbita y **lo sigue** a 25 m, del
     lado en que está, copiando su velocidad, con la nariz y el gimbal
     apuntados a él (`FOLLOWING`, evento `TARGET_MOVING`).
   - Si **se detiene** (menos de 0,6 m/s durante 6 s): vuelve a orbitarlo donde
     quedó (`ORBITING`, `TARGET_STOPPED`). Orbitando, si la estimación se corre
     más de 6 m, el centro de la órbita la acompaña sin cortar el giro.
   - Si **se pierde** (10 s sin detecciones asociadas): orbita la última
     posición estimada y avisa `TARGET_LOST` con esa posición, que es la que
     necesita el equipo de tierra. Si vuelve a aparecer cerca (70 m), lo
     retoma (`TARGET_REACQUIRED`).
6. **Decisión del operador** (`alert_decision` de la alerta del objetivo):
   `DISMISSED` termina el seguimiento, marca la zona como descartada y retoma
   la ruta **hacia el próximo waypoint**; `VALIDATED` sigue sobre el objetivo
   hasta un `resume_patrol`. El operador puede tomar el control manual en
   cualquier momento; al soltarlo el dron vuelve al objetivo.
7. El seguimiento termina con un `resume_patrol`, un regreso a base (batería
   baja, señal perdida, orden del campo) o un aterrizaje, y deja
   `TRACKING_ENDED` con la última posición conocida.

## 5. REST del Comando Central

Lo que cambió respecto de la versión anterior está marcado con **negrita**.

### Sesión

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{username, password}` → **`{token, expiresIn, user}`**. `expiresIn` en segundos: lo usa la app para la cuenta regresiva de la sesión efímera |
| **POST** | **`/api/auth/logout`** | JWT | `{motivo?}`. No invalida nada del lado del servidor (el JWT vive en el cliente): existe para **dejar registrado** el cierre de la sesión efímera del operador de campo. **Para las demás cuentas suelta en el acto el control manual que tuvieran (`CONTROL_RELEASED` con «X cerró la sesión») y cancela sus pedidos de control** |
| GET | `/api/me` | JWT | Ficha del usuario autenticado. Para un dron incluye `displayName` y `base` |
| GET | `/api/health` | — | Ping |

### Drones como activos

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/drones` | operador de campo, operador+ | `?includeDeleted=1` (el flag **solo lo respeta supervisor+**; para el resto se ignora) |
| **POST** | **`/api/drones`** | campo, supervisor+ | `{displayName, model?, base?}` → 201 con la ficha, **incluido el `hash` para el QR** |
| **POST** | **`/api/drones/pair`** | campo, supervisor+ | `{hash, lat?, lon?, accuracyM?, deviceModel?}` → `{token, drone}`. 404 si el QR no corresponde a ningún dron, 403 si está eliminado o desactivado |
| **PATCH** | **`/api/drones/:hash`** | operador+ si solo cambia `displayName`; supervisor+ para el resto | `{displayName?, model?, active?, base?}`. Desactivar corta la conexión del dron |
| **DELETE** | **`/api/drones/:hash`** | supervisor+ | **Borrado lógico**. Corta la conexión del dron |
| **POST** | **`/api/drones/:hash/restore`** | supervisor+ | Restaura un dron eliminado |

### Operación

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/routes` | JWT | Rutas de patrullaje disponibles (waypoints incluidos) |
| PATCH | `/api/routes/:routeId/waypoints/:index` | operador+ | `{label}`; apodo de un nodo (vacío lo borra). Emite `route_updated` |
| POST | `/api/drones/:droneId/route/start` | operador+ | `{routeId, fromIndex?}` |
| POST | `/api/drones/:droneId/route/stop` | operador+ | Interrumpe el patrullaje (el dron queda estacionario) |
| POST | `/api/drones/:droneId/resume` | operador+ | `{fromIndex?}`: reanuda hacia ese nodo o **hacia el próximo de la ruta**. Libera el control manual y **termina el seguimiento de un objetivo** |
| POST | `/api/drones/:droneId/goto` | con `canControl` | `{routeId, index}`: fuerza el vuelo hacia ese nodo |
| POST | `/api/drones/:droneId/control` | con `canControl` | Toma el control manual (409 si otro lo tiene) |
| DELETE | `/api/drones/:droneId/control` | titular o supervisor+ | `{resume: 'last'\|'none'\|número, titular?, forzar?}`. **`titular` es quien la consola cree que suelta: si ya no es el del lock (un traspaso se cruzó con el «Salir»), `409` «El control ya no lo tiene X: ahora lo tiene Y», salvo `forzar: true`, que manda solo «Quitar control». La consola manda siempre `titular`.** **El `resume_patrol` que sale de acá va con `alSoltar: true` (§2).** **Con un objetivo en seguimiento la consola manda `'none'`: el dron vuelve al objetivo.** **Si el titular deja de dar señales de vida 30 s, el hub lo suelta solo con `'none'` (ver "Control manual"); suspenderle el control o darle de baja la cuenta lo suelta en el acto, con `'none'` cuando el último status del dron trae `target` y con `'last'` si no.** **A un dron que participa de un relevo activo (A o B) el hub lo suelta siempre con `'none'`, pida lo que pida el cuerpo: soltar no es una orden y no toca el relevo (RELEVOS §3.9). Para reanudarlo está `POST /resume`, que sí cuenta como orden del operador.** **Un pedido de control que esperaba termina `liberado`** |
| **POST** | **`/api/drones/:droneId/control/request`** | **con `canControl`** | **Pedir el control (la consola ya pidió confirmación). Libre o propio: `200 {resultado: 'otorgado', drone}`. Si lo tiene otro: `202 {resultado: 'pendiente', pedido: {solicitante, titular, venceEn, restanteMs}}`, un pedido por dron con 10 s para el titular (el mismo solicitante recibe el mismo pedido). `409` si ya hay un pedido de otro o si el que pide no tiene ninguna consola conectada al hub, `403` sin `canControl`, `404` dron inexistente. Registra `CONTROL_REQUESTED`** |
| **POST** | **`/api/drones/:droneId/control/request/answer`** | **solo el titular** | **`{respuesta: 'ceder'\|'mantener'}` → `{resultado, drone}`. `ceder` pasa el control sin soltarlo (`control_transferred`); fuera de plazo cuenta como no contestada (`vencido`, el control pasa igual). Si el que pidió perdió `canControl` en la espera, `cancelado` y el titular sigue. `400` con otra respuesta, `403` si no es el titular, `409` sin pedido pendiente, `404` dron inexistente** |
| **DELETE** | **`/api/drones/:droneId/control/request`** | **solo el que pidió** | **Cancela el pedido antes de que le contesten → `{resultado: 'cancelado'}`. `403` si el pedido es de otro, `409` sin pedido, `404` dron inexistente** |
| **POST** | **`/api/drones/:droneId/takeoff`** | **titular del control (con `canControl`)** | **Despegue en el lugar (§2 `takeoff`). 409 si no tenés el control. Registra `TAKEOFF_ORDERED`** |
| **POST** | **`/api/drones/:droneId/land`** | **titular del control (con `canControl`)** | **Aterriza donde está (§2 `land`). 409 si no tenés el control. Registra `LANDING_ORDERED`** |
| POST | `/api/drones/:droneId/manual_move` | titular del control | `{bearing, distanceM}`: desplazamiento puntual (la consola manda 25 m por click) |

El **mando virtual con palancas no está en esta tabla y no va a estar**: viaja por
el WebSocket de la consola (§3.b) porque son ~10 mensajes por segundo mientras el
operador sostiene la palanca. **La inclinación de la cámara (`manual_gimbal`)
tampoco**, por lo mismo.

### Alertas

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/alerts?status=` | operador+ | Lista de alertas (las últimas 100, **con la captura** y **con `seguidaPor`**, §3): la consola la carga al conectarse y la mantiene al día con `alert_created`/`alert_updated` |
| **GET** | **`/api/alerts/:id`** | operador+ | Alerta completa **con la captura del video**. La consola la pide sólo para la alerta que no tiene en su lista (la de un evento viejo del Registro o del historial de un dron), y otra vez después de decidirla desde el pop-up, porque esa no le llega por el WebSocket |
| POST | `/api/alerts/:id/decision` | operador+ | `{decision: VALIDATED\|DISMISSED}`; registra quién decidió y notifica al dron **que la sigue (`COALESCE(seguida_por, drone_id)`)**. **Un `DISMISSED` con un relevo de seguimiento activo de esa alerta lo cancela (`relay_cancel {motivo: "alerta_descartada"}` a B)** |

### Bases

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/bases` | operador de campo, operador+ | `?includeDeleted=1` (solo supervisor+), `?soloActivas=1`. Cada base: `{id, name, lat, lon, active, createdAt, createdBy, deleted, deletedAt, **aterrizajeLat, aterrizajeLon**}` |
| POST | `/api/bases` | campo, supervisor+ | `{name, lat, lon, **aterrizajeLat?, aterrizajeLon?**}` → 201 con la base. Registra `BASE_CREATED` |
| PATCH | `/api/bases/:id` | supervisor+ | `{name?, lat?, lon?, active?, **aterrizajeLat?, aterrizajeLon?**}`. Registra `BASE_UPDATED` con antes y después |
| DELETE | `/api/bases/:id` | supervisor+ | Borrado lógico; 409 si algún dron la tiene asignada |
| POST | `/api/bases/:id/restore` | supervisor+ | Restaura una base eliminada |

**Punto de aterrizaje para visitantes** (`aterrizajeLat`, `aterrizajeLon`,
RELEVOS §0): dónde baja un dron que se desvía desde otra base.
- Van **juntos**: los dos números o los dos `null`. Uno solo → 400
  («aterrizajeLat y aterrizajeLon van juntos»). En el alta, ausentes es `null`;
  en la edición, ausentes es "sin cambios" y los dos en `null` lo borran.
- Posición válida (§1.b) y **a entre 10 y 50 m** (inclusive) del punto de la
  base: más cerca bajaría sobre la plataforma; más lejos ya no está "en la
  base" (`RADIO_DE_BASE_M`). Si no → 400 («El punto de aterrizaje para
  visitantes tiene que estar entre 10 y 50 m de la base»).
- Se controla con los valores **finales**: un PATCH que mueve la base sin
  mandar un punto nuevo que siga en rango → 400; la consola manda el punto nuevo
  o `null`.
- Cualquier cambio en las bases emite `base_updated` a las consolas y `bases`
  (§2.b) a todos los drones conectados. El `antes`/`despues` de
  `BASE_CREATED`/`BASE_UPDATED` suma `aterrizajeLat` y `aterrizajeLon`.

### Relevos y emergencias

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| **GET** | **`/api/relevos`** | operador+ | **`?activos=1`: solo los activos (`RESERVADO`, `ORDENADO`, `EN_CAMINO`, `TRASPASO`, `SIN_RELEVO`); sin el flag, los últimos 100. Más recientes primero. Lista de objetos relevo (§3)** |
| **GET** | **`/api/emergencias`** | operador de campo, operador+ | **`?abiertas=1`: solo las que no se marcaron recuperadas; sin el flag, las últimas 100. Más recientes primero. Objetos emergencia (§3) sin fotos (`fotos` es la cantidad)** |
| **GET** | **`/api/emergencias/:id`** | operador de campo, operador+ | **La emergencia con `fotos: [{seq, tipo, rumbo, inclinacion, lat, lon, alt, ts, jpegBase64}]`, ordenadas por `seq`. 404 si no existe (también con un id que no es un entero ≥ 1)** |
| **POST** | **`/api/emergencias/:id/recuperada`** | operador de campo, operador+ | **Sin cuerpo. Marca `recuperadaEn`/`recuperadaPor`, registra `EMERGENCY_RECOVERED` y emite `emergency_updated`. Vale también sin `emergency_landed` (el aviso se pudo perder y el dron igual apareció). 404 si no existe, 409 si ya estaba recuperada. Devuelve la emergencia (sin fotos)** |

Los flags valen con `1` o `true`, como `includeDeleted`.

### Usuarios

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/users` | supervisor+ | **`?includeDeleted=1`**, `?q=` (usuario, nombre, DNI con o sin puntos o ceros adelante, o rol). Supervisor ve operadores; admin ve todos |
| POST | `/api/users` | admin | `{username, fullName, dni, role, canControl}`. **`dni` es obligatorio**: texto, con o sin puntos/espacios, se guarda en dígitos **sin ceros a la izquierda** (`"05.123.456"` → `"5123456"`, como figura adentro del CUIL) y vale con 7 u 8 dígitos ya sin esos ceros (`"00000000"` → 400). Repetido entre cuentas no eliminadas → 409, también si se lo escribe con otros ceros adelante. **`role` acepta `field_operator`**, al que se le fuerza `canControl:false`. La contraseña la genera el sistema y viaja una sola vez en la respuesta |
| PATCH | `/api/users/:username` | supervisor+ (solo `canControl` de operadores) / admin (todo) | `{canControl?, active?, fullName?, dni?, role?}`. `role` solo entre `operator`, `supervisor` y `field_operator`, nunca desde ni hacia `admin`; el cambio de rol **cierra la consola** del usuario (4403) y **termina su sesión**: el token de antes ya no vale (401 en la API, 4401 al reconectar el WebSocket), así que vuelve a entrar con el rol nuevo; y pasar a `field_operator` apaga `canControl` y suelta los drones que controlara. Registra antes y después |
| **DELETE** | **`/api/users/:username`** | admin | **Borrado lógico**. Cierra sus sockets y libera los drones que controlara. Libera el DNI |
| **POST** | **`/api/users/:username/restore`** | admin | Restaura un usuario eliminado. 409 si otra cuenta viva tomó su DNI |

### Registro

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| **GET** | **`/api/logs`** | admin | `?category=&page=&pageSize=&droneId=&q=` → **`{items, total, page, pageSize}`**. `pageSize` ∈ {25, 50, 75, 100}; fuera de ese conjunto cae a 25. El filtro y el conteo se resuelven **en SQL**, no en el navegador |
| GET | `/api/events` | operador+ | `?limit=&droneId=`: log de drones (más reciente primero). `limit` por defecto 200, techo 1000. El historial de eventos de la vista de un dron pide `?droneId=…&limit=100` al abrirse, le suma los `event` que llegan en vivo y pagina de a 20 en el navegador: con cien filas no hace falta paginar en el servidor |

## 6. Ficha de dron (`drone`)

Forma que devuelven `GET /api/drones` y los mensajes `drone_online`,
`drone_offline` y `drone_updated`. `hash` y `droneId` son el mismo valor con dos
nombres: `hash` cuando se habla del activo y del QR, `droneId` cuando se habla
del protocolo.

```json
{
  "hash": "a3f9c1b27d5e4408f61a9c3e772b7e42",
  "droneId": "a3f9c1b27d5e4408f61a9c3e772b7e42",
  "displayName": "Alfa",
  "model": "DJI Mini 4 Pro",
  "active": true,
  "deleted": false,
  "deletedAt": null,
  "base": { "name": "Base Norte", "lat": -34.8565, "lon": -56.2075 },
  "online": true,
  "controlledBy": null,
  "pedidoDeControl": null,
  "lastStatus": { "state": "PATROLLING", "battery": 87, "lat": -34.855, "lon": -56.206,
                  "gpsFix": true, "routeId": 1, "waypointIndex": 2, "waypointTotal": 4,
                  "signal": "OK", "signalPct": 78, "heading": 132, "mode": "TEST",
                  "alt": 40, "satellites": 14, "flying": true, "flightMode": "P-GPS",
                  "gimbalPitch": -70, "target": null }
}
```

**`pedidoDeControl`**: el pedido de control que espera la respuesta del titular,
`{solicitante, titular, venceEn, restanteMs}` (como en `control_request`, §3), o
`null`. Es lo que le muestra el pedido a una consola que recargó en el medio.

## 7. Forma de `meta` por tipo de evento

Piezas que se repiten: `Dron = {hash, displayName, model}` ·
`EstadoDron = {displayName, model, activo, eliminado, base, baseLat, baseLon}`
(plano a propósito, para que la comparación del pop-up sea campo a campo) ·
`UserView = {username, fullName, dni, role, active, canControl, deleted, deletedAt}` (`dni` en dígitos y sin ceros a la izquierda; vacío en las cuentas anteriores al DNI).

| Categoría | Tipo | `meta` |
|---|---|---|
| drone | `DRONE_CREATED` | `{drone, despues: EstadoDron}` |
| drone | `DRONE_UPDATED` / `DRONE_DELETED` / `DRONE_RESTORED` | `{drone, antes: EstadoDron, despues: EstadoDron}` |
| drone | `DRONE_PAIRED` | `{por, ubicacion: {lat, lon, accuracyM} \| null, dispositivo, drone}` |
| drone | `DRONE_CONNECTED` / `DRONE_DISCONNECTED` | `{drone}` |
| drone | `DRONE_RENAMED` | `{antes: {displayName}, despues: {displayName}, drone}` |
| drone | `WAYPOINT_RENAMED` | `{antes: {apodo}, despues: {apodo}, detalle: {ruta, rutaId, nodo}}` |
| drone | `ROUTE_STARTED` | `{drone, detalle: {ruta, rutaId, desdeNodo}}` |
| drone | `PATROL_STOPPED` | `{drone, detalle: {por}}` |
| drone | `PATROL_RESUME_ORDERED` | `{drone, detalle: {por, desdeNodo}}` |
| drone | `FORCED_GOTO` | `{drone, detalle: {ruta, rutaId, nodo}}` |
| drone | `CONTROL_TAKEN` | `{drone, detalle: {por}}` |
| drone | `CONTROL_RELEASED` | `{drone, detalle: {por, teniaElControl, forzado, motivo}}` (**el barrido de señales de vida y el `control_dropped` de la app lo registran con `por: "Comando Central"`, `forzado: true` y su motivo en texto**) |
| drone | **`CONTROL_REQUESTED`** | **`{drone, detalle: {solicitante, titular}}`; `source` es el que pidió** |
| drone | **`CONTROL_TRANSFERRED`** | **`{drone, detalle: {de, a, motivo: "cedido"\|"vencido"}}`; `source` es el que cedió, o `backend` si no contestó (en 10 s, o con 30 s sin señales y el pedido encima)** |
| drone | **`CONTROL_REQUEST_ENDED`** | **`{drone, detalle: {solicitante, titular, resultado: "mantenido"\|"cancelado"\|"liberado", motivo}}`: un pedido que terminó sin traspaso; `source` es el titular (mantenido), el que pidió (canceló) o `backend`** |
| drone | **`TAKEOFF_ORDERED` / `LANDING_ORDERED`** | **`{drone, detalle: {por}}`** |
| drone | `ALERT_CREATED` | `{alerta: {id, tipo, lat, lon, ts}, drone, detalle: {confianza, clases, dronLat, dronLon, dronAlt}}` (**`detalle` es nuevo**; cada campo puede faltar) |
| drone | `ALERT_VALIDATED` / `ALERT_DISMISSED` | `{alerta: {id, tipo}, decision, por, antes: {estado}, despues: {estado, decidedBy, decidedAt}, drone}` |
| drone | Eventos que reporta la app (`PATROL_STARTED`, `SIGNAL_LOST`, `RTH_LOW_BATTERY`, `TARGET_MOVING`, …) | `{drone}` **+ `alerta: {id, tipo, lat, lon, ts}` si el evento trae un `alertId` de una alerta de ese dron, + `ubicacion: {lat, lon, accuracyM: null}` si trae `lat`/`lon` válidos** |
| drone | **`RELAY_REQUESTED` / `RELAY_ASSIGNED` / `RELAY_REJECTED` / `RELAY_STARTED` / `RELAY_HANDOVER` / `RELAY_COMPLETED` / `RELAY_UNAVAILABLE` / `RELAY_CANCELLED` / `RELAY_FAILED`** | **`{drone (A), alerta?: {id, tipo, lat, lon, ts} (seguimiento), detalle: {relevoId, motivo, estado, motivoFin, origen, relevo, relevoHash, rutaId, desdeNodo, motivoDeB}}`** |
| drone | **`RTH_DIVERTED`** | **`{drone, ubicacion?: {lat, lon, accuracyM: null}, detalle: {motivo, baseId, base, relevoId}}`** |
| drone | **`EMERGENCY_LANDING`** | **`{drone, emergencia: {id, motivo, lat, lon, ts}, ubicacion?, detalle: {alt, bateria}}`** |
| drone | **`EMERGENCY_LANDED`** | **`{drone, emergencia, ubicacion? (la del aterrizaje), detalle: {alt}}`** |
| drone | **`EMERGENCY_RECOVERED`** | **`{drone, emergencia, detalle: {por}}`** |

**Eventos de relevos, desvíos y emergencias.** Los crea **solo el hub** (una app
no los puede mandar como `event`, §1), con `source: 'backend'` y categoría
`drone`. Cuándo sale cada uno:

| Tipo | Cuándo |
|---|---|
| `RELAY_REQUESTED` | Se crea un relevo (`relay_request` nuevo o `landing_at_base` sin pedido previo) |
| `RELAY_ASSIGNED` | Se le ordena a un B (`relay_start` o `relay_tracking`): uno por cada candidato al que se le ofrece. La reserva tentativa no deja evento |
| `RELAY_REJECTED` | Un B rechaza, o no contesta en 10 s (`motivoDeB: "sin_respuesta"`) |
| `RELAY_STARTED` | B acepta (`EN_CAMINO`) |
| `RELAY_HANDOVER` | Traspaso de un seguimiento (`relay_ready`) |
| `RELAY_COMPLETED` | `COMPLETADO` |
| `RELAY_UNAVAILABLE` | Pasa a `SIN_RELEVO` (una vez por cada vez que entra, no por cada búsqueda) |
| `RELAY_CANCELLED` | `CANCELADO` |
| `RELAY_FAILED` | `FALLIDO` |
| `RTH_DIVERTED` | Un `rth_diverted` con un destino nuevo |
| `EMERGENCY_LANDING` | Se abre una emergencia (no al reutilizar una abierta) |
| `EMERGENCY_LANDED` | El primer `emergency_landed` de una emergencia |
| `EMERGENCY_RECOVERED` | `POST /api/emergencias/:id/recuperada` |

`drone_id` es siempre el de A (el origen) en los `RELAY_*` y el del dron en los
demás; los de seguimiento quedan además encadenados a su alerta (`alert_id`).
En `detalle` de los `RELAY_*`, cada clave está siempre, en `null` si no
corresponde: `relevoId`, `motivo` (`patrulla`/`seguimiento`), `estado` y
`motivoFin` (los del relevo después del cambio), `origen` y `relevo` (nombres
visibles de A y de B), `relevoHash` (el `droneId` de B, para filtrar el registro
por él), `rutaId` y `desdeNodo` (patrulla, `desdeNodo` 1-based como en
`ROUTE_STARTED`), `motivoDeB` (el `motivo` del `relay_reject` o del
`relay_abort`, o `sin_respuesta`). En `RTH_DIVERTED`, `base` es el nombre de la
base destino (o `null`). `EMERGENCY_RECOVERED` guarda en `por` el usuario que la
marcó.
| usuarios | `USER_CREATED` | `{despues: UserView}` |
| usuarios | `USER_UPDATED` / `USER_DELETED` / `USER_RESTORED` | `{antes: UserView, despues: UserView}` |
| sistema | `FIELD_SESSION_CLOSED` | `{detalle: {por, motivo}}` |
| sistema | `LOGIN` / `LOGIN_FAILED` / `LOGIN_REJECTED` | — |
