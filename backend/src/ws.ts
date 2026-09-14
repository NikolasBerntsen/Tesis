import type { Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { ROLE_RANK, verifyToken } from './auth';
import {
  createAlert, createLog, getActiveUser, getDrone, getDroneIdentity, listDrones, renameDrone,
  type DroneAssetView, type DroneBase, type EventRow, type Role,
} from './store';

/** Todo lo que sale hacia las consolas lleva `type`: es lo que decide quién lo ve. */
export interface MensajeHub {
  type: string;
  [clave: string]: unknown;
}

/** Consola conectada. El rol y el vencimiento se guardan para revalidarla. */
interface SesionConsola {
  username: string;
  role: Role;
  /** Epoch en segundos del JWT; infinito si el token no lleva vencimiento. */
  expiraEn: number;
  /** Fichas de mando que le quedan a este socket (ver `hayCupoDeMando`). */
  fichasDeMando: number;
  /** Cuándo se contaron esas fichas, para reponerlas al usar las siguientes. */
  fichasMedidasEn: number;
}

/**
 * Tope de tamaño de CUALQUIER frame que entre por /ws, en bytes. Sin esto rige
 * el default de `ws` (100 MiB) y una sola consola puede hacer que el hub —que es
 * de un solo hilo— se coma un JSON de decenas de megas ANTES de que nadie le
 * mire el permiso: el event loop se traba y durante ese rato no sale un cuadro
 * de video, ni una alerta, ni una orden hacia ningún dron.
 *
 * No puede ser chico, porque por este mismo servidor entra el video: un
 * `video_frame` trae el JPEG del cuadro (640 px de ancho, calidad 60: unas
 * decenas de KB) en base64, que agrega un tercio, y un `alert_request` trae
 * además la instantánea de la alerta. 1 MiB deja más de un orden de magnitud de
 * margen sobre el cuadro más pesado imaginable y sigue siendo cien veces menos
 * que el default. El tope chico va donde corresponde: en el mensaje de consola.
 */
const TOPE_FRAME_BYTES = 1024 * 1024;

/**
 * Tope del mensaje de una CONSOLA, en bytes y medido sobre el frame CRUDO: antes
 * de decodificarlo a string y antes de parsearlo. Acá sí puede ser chico: lo
 * único que una consola manda para arriba es `manual_stick`, que con el droneId
 * y los cuatro ejes no llega a 200 bytes. Se mide primero porque decodificar y
 * parsear es justamente el trabajo caro que un socket abusivo quiere regalarle
 * al hub (ver `handleOperatorMessage`).
 */
const TOPE_MENSAJE_CONSOLA = 1024;

// Hub central. Soporta varios drones a la vez: cada conexión de dron se guarda
// bajo su droneId (el hash del token de emparejamiento), y los mensajes del
// operador se dirigen al dron concreto en vez de a todos.
const operators = new Map<WebSocket, SesionConsola>();
const drones = new Map<string, WebSocket>();
const lastStatus = new Map<string, MensajeHub>();

// Control manual: un solo usuario por dron a la vez
const controlledBy = new Map<string, string>(); // droneId -> username

// Novedades del dron como ACTIVO: alta, baja, renombre y conexión. Es lo único
// del canal en vivo que le toca al operador de campo, que entra a la consola
// nada más que a dar de alta drones y emparejarlos.
const TIPOS_DE_ACTIVO = new Set(['drone_updated', 'drone_online', 'drone_offline', 'drone_renamed']);

/**
 * El canal en vivo respeta los mismos permisos que la API REST: sin esto un
 * operador de campo recibía por WebSocket el video, las alertas y el registro
 * de usuarios que sus propias requests reciben con un 403.
 */
function puedeVer(sesion: SesionConsola, msg: MensajeHub): boolean {
  if (sesion.role === 'field_operator') return TIPOS_DE_ACTIVO.has(msg.type);
  // El registro de usuarios y de sistema es del admin, igual que GET /api/logs
  if (msg.type === 'event') {
    return (msg.event as EventRow | undefined)?.category === 'drone' || sesion.role === 'admin';
  }
  return true;
}

/**
 * El JWT no se revoca del lado del servidor, así que un socket abierto podría
 * sobrevivir al vencimiento de su sesión: se controla antes de cada envío y se
 * corta ahí mismo.
 */
function sesionVigente(ws: WebSocket, sesion: SesionConsola): boolean {
  if (Date.now() < sesion.expiraEn * 1000) return true;
  ws.close(4401, 'Sesión vencida');
  return false;
}

export function broadcastOperators(msg: MensajeHub) {
  const data = JSON.stringify(msg);
  for (const [ws, sesion] of operators) {
    if (!sesionVigente(ws, sesion) || !puedeVer(sesion, msg)) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

/** Envía un mensaje a un dron concreto. Devuelve false si no está conectado. */
export function sendToDrone(droneId: string, msg: object): boolean {
  const ws = drones.get(droneId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

export function isOnline(droneId: string): boolean {
  const ws = drones.get(droneId);
  return ws !== undefined && ws.readyState === WebSocket.OPEN;
}

export function getLastStatus(droneId: string): Record<string, unknown> | null {
  return lastStatus.get(droneId) ?? null;
}

export function getController(droneId: string): string | null {
  return controlledBy.get(droneId) ?? null;
}

/**
 * Corta la conexión de un dron. Se usa cuando deja de estar habilitado
 * (desactivado o eliminado): el token que tiene el celular sigue siendo válido
 * criptográficamente, así que el corte tiene que ser explícito.
 */
export function kickDrone(hash: string, motivo: string): boolean {
  const ws = drones.get(hash);
  if (!ws) return false;
  ws.close(4403, motivo);
  return true;
}

/**
 * Espejo de kickDrone para las personas: corta las consolas abiertas de una
 * cuenta que se desactiva o se elimina. Sin esto el socket ya establecido
 * seguiría recibiendo el flujo en vivo aunque la API le responda 403.
 */
export function kickUser(username: string, motivo: string): number {
  let cerradas = 0;
  for (const [ws, sesion] of operators) {
    if (sesion.username !== username) continue;
    ws.close(4403, motivo);
    cerradas += 1;
  }
  return cerradas;
}

/** Ficha completa de un dron: identidad + activo + online + estado + control. */
export interface DroneCard {
  /** El hash del QR. `droneId` es exactamente el mismo valor: así lo llama el protocolo. */
  hash: string;
  droneId: string;
  displayName: string;
  model: string;
  /** Número de inventario con el que la organización identifica al aparato. */
  inventoryCode: string;
  /** `active` es el estado operativo: un dron no operativo no puede conectarse. */
  active: boolean;
  deletedAt: string | null;
  baseId: number | null;
  base: DroneBase | null;
  online: boolean;
  lastStatus: Record<string, unknown> | null;
  controlledBy: string | null;
}

function cardDesdeActivo(d: DroneAssetView): DroneCard {
  return {
    hash: d.hash,
    inventoryCode: d.inventoryCode,
    baseId: d.baseId,
    droneId: d.hash,
    displayName: d.displayName,
    model: d.model,
    active: d.active,
    deletedAt: d.deletedAt,
    base: d.base,
    online: isOnline(d.hash),
    lastStatus: getLastStatus(d.hash),
    controlledBy: getController(d.hash),
  };
}

/** Devuelve la ficha aunque el dron esté eliminado: la consola tiene que poder mostrarlo. */
export function droneCard(droneId: string): DroneCard | null {
  const d = getDrone(droneId);
  return d ? cardDesdeActivo(d) : null;
}

export function listDroneCards(opts: { includeDeleted?: boolean } = {}): DroneCard[] {
  return listDrones(opts).map(cardDesdeActivo);
}

/** Lo que el pop-up del registro pinta bajo la clave `drone` de la `meta`. */
export interface MetaDron {
  hash: string;
  displayName: string;
  model: string;
}

export function metaDron(droneId: string): MetaDron | undefined {
  const d = getDrone(droneId);
  return d ? { hash: d.hash, displayName: d.displayName, model: d.model } : undefined;
}

/** Aplica un renombre y avisa a los dos lados: operadores y el propio dron. */
export function applyRename(droneId: string, displayName: string, notifyDrone: boolean) {
  const identity = renameDrone(droneId, displayName);
  if (!identity) return undefined;
  broadcastOperators({ type: 'drone_renamed', droneId, displayName: identity.displayName });
  if (notifyDrone) sendToDrone(droneId, { type: 'renamed', displayName: identity.displayName });
  return identity;
}

/** Avisa a las consolas que la ficha del activo cambió (alta, edición, baja o restauración). */
export function broadcastDroneUpdated(droneId: string) {
  const card = droneCard(droneId);
  if (card) broadcastOperators({ type: 'drone_updated', drone: card });
}

// ---- Control manual exclusivo ----

export function takeControl(droneId: string, username: string): { ok: true } | { ok: false; heldBy: string } {
  const holder = controlledBy.get(droneId);
  if (holder && holder !== username) return { ok: false, heldBy: holder };
  controlledBy.set(droneId, username);
  sendToDrone(droneId, { type: 'control_taken', by: username });
  broadcastOperators({ type: 'control_changed', droneId, controlledBy: username });
  const ev = createLog('drone', 'CONTROL_TAKEN', username, `${username} tomó el control manual del dron ${droneId}`, {
    droneId,
    meta: { drone: metaDron(droneId), detalle: { por: username } },
  });
  broadcastOperators({ type: 'event', event: ev });
  return { ok: true };
}

export interface ReleaseOptions {
  resume: 'last' | 'none' | number;
  forced?: boolean;
  reason?: string;
}

export function releaseControl(droneId: string, byUser: string, opts: ReleaseOptions): boolean {
  const holder = controlledBy.get(droneId);
  if (!holder) return false;
  controlledBy.delete(droneId);
  sendToDrone(droneId, { type: 'control_released', by: byUser });

  const detalle = opts.forced ? ` (forzado por ${byUser}, lo tenía ${holder})` : '';
  const motivo = opts.reason ? ` — ${opts.reason}` : '';
  const ev = createLog(
    'drone',
    'CONTROL_RELEASED',
    byUser,
    `Control manual del dron ${droneId} liberado${detalle}${motivo}`,
    {
      droneId,
      meta: {
        drone: metaDron(droneId),
        detalle: { por: byUser, teniaElControl: holder, forzado: !!opts.forced, motivo: opts.reason ?? null },
      },
    },
  );
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'control_changed', droneId, controlledBy: null });

  if (opts.resume !== 'none') {
    const msg: Record<string, unknown> = { type: 'resume_patrol', orderedBy: byUser };
    if (typeof opts.resume === 'number') msg.fromIndex = opts.resume;
    sendToDrone(droneId, msg);
  }
  return true;
}

/** Libera todos los drones controlados por un usuario (suspensión, borrado o desconexión). */
export function releaseAllControlledBy(username: string, byUser: string, reason: string) {
  for (const [droneId, holder] of controlledBy) {
    if (holder === username) releaseControl(droneId, byUser, { resume: 'last', forced: byUser !== username, reason });
  }
}

/** Mensaje que llega del celular: viene de la red, así que todo campo es opcional. */
interface MensajeDron {
  type?: string;
  eventType?: string;
  message?: string;
  jpegBase64?: string;
  ts?: number;
  alertType?: string;
  lat?: number;
  lon?: number;
  snapshotBase64?: string;
  displayName?: string;
  [clave: string]: unknown;
}

/**
 * Bytes que ocupa un frame tal como lo entregó `ws`, SIN decodificarlo. Es lo que
 * hay que mirar para descartar por tamaño: `Buffer.byteLength` sobre el string ya
 * decodificado llegaría tarde, y el `.length` de ese string cuenta unidades
 * UTF-16, que no son los bytes que viajaron por el cable (una eñe es una unidad
 * y dos bytes).
 *
 * `ws` hoy entrega un Buffer, pero el tipo `RawData` admite además un ArrayBuffer
 * y una lista de fragmentos: los tres se cubren en vez de confiar en la forma de
 * hoy, porque leerle `.byteLength` a un arreglo daría `undefined` y
 * `undefined > TOPE` es false en JS, o sea que el tope fallaría ABIERTO. Se
 * exporta solo para poder probar las tres formas, que desde un socket de verdad
 * no se pueden provocar.
 */
export function bytesDelFrame(datos: RawData): number {
  if (Array.isArray(datos)) return datos.reduce((total, parte) => total + parte.byteLength, 0);
  return datos.byteLength;
}

/**
 * Parsea un frame de la red y devuelve null si no es un OBJETO JSON.
 *
 * El control de que sea un objeto no es cosmético: `JSON.parse('null')` devuelve
 * null y `null.type` es un TypeError que, sin nadie que lo atrape, se lleva
 * puesto el proceso entero del Comando Central —o sea, el socket de TODAS las
 * consolas y el de TODOS los drones en pleno vuelo— por un frame de cuatro
 * bytes. Un arreglo o un número sueltos tampoco son mensajes del protocolo.
 */
function parsearMensaje(raw: string): Record<string, unknown> | null {
  let valor: unknown;
  try {
    valor = JSON.parse(raw);
  } catch {
    // Viene de la red: un frame que no es JSON no puede tumbar el hub
    return null;
  }
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return null;
  return valor as Record<string, unknown>;
}

function handleDroneMessage(droneId: string, raw: string) {
  const msg = parsearMensaje(raw) as MensajeDron | null;
  if (!msg) return;
  const displayName = getDroneIdentity(droneId)?.displayName ?? droneId;

  switch (msg.type) {
    case 'status': {
      const status: MensajeHub = {
        ...msg,
        type: 'status',
        droneId,
        displayName,
        controlledBy: getController(droneId),
      };
      lastStatus.set(droneId, status);
      broadcastOperators(status);
      break;
    }
    case 'video_frame':
      broadcastOperators({ type: 'video_frame', droneId, jpegBase64: msg.jpegBase64, ts: msg.ts });
      break;
    case 'event': {
      const ev = createLog('drone', String(msg.eventType), droneId, String(msg.message ?? ''), {
        droneId,
        meta: { drone: metaDron(droneId) },
      });
      broadcastOperators({ type: 'event', event: ev });
      break;
    }
    case 'alert_request': {
      const alertType = msg.alertType === 'VEHICLE' ? 'VEHICLE' : 'PERSON';
      const alert = createAlert(alertType, droneId, msg.lat ?? null, msg.lon ?? null, msg.snapshotBase64 ?? null);
      const ev = createLog(
        'drone',
        'ALERT_CREATED',
        droneId,
        `Alerta de ${alertType === 'PERSON' ? 'PERSONA' : 'VEHÍCULO'} generada por ${displayName}`,
        {
          droneId,
          alertId: alert.id,
          meta: {
            alerta: { id: alert.id, tipo: alert.type, lat: alert.lat, lon: alert.lon, ts: alert.created_at },
            drone: metaDron(droneId),
          },
        },
      );
      broadcastOperators({ type: 'alert_created', alert });
      broadcastOperators({ type: 'event', event: ev });
      break;
    }
    // El dron se renombró desde la app: no hace falta devolverle el eco
    case 'set_name': {
      const name = String(msg.displayName ?? '').trim();
      if (!name) break;
      const antes = displayName;
      const identity = applyRename(droneId, name, false);
      if (identity) {
        const ev = createLog('drone', 'DRONE_RENAMED', droneId, `El dron ${droneId} pasó a llamarse "${name}"`, {
          droneId,
          meta: { antes: { displayName: antes }, despues: { displayName: name }, drone: metaDron(droneId) },
        });
        broadcastOperators({ type: 'event', event: ev });
      }
      break;
    }
  }
}

/** Mensaje que llega de una consola: viene de la red, así que todo campo es opcional. */
interface MensajeOperador {
  type?: string;
  droneId?: string;
  pitch?: unknown;
  roll?: unknown;
  yaw?: unknown;
  throttle?: unknown;
  [clave: string]: unknown;
}

/**
 * Un eje de palanca es un número entre -1 y 1. Devuelve null si el valor no es
 * un número finito, y lo RECORTA si se pasó de rango.
 *
 * Se usa `Number.isFinite` y no `Number(...)` justamente porque no convierte:
 * `Number(null)` es 0 y `Number('')` también, así que con la conversión un campo
 * ausente o basura se le colaría al dron como un cero que la consola nunca
 * escribió. Y recortar en vez de descartar porque la consola normaliza el
 * arrastre del puntero: un 1.0000001 o un 1.4 por redondeo es plausible y lo
 * que el operador quiso decir es "todo para ese lado", no "no me hagas caso".
 */
function eje(valor: unknown): number | null {
  if (!Number.isFinite(valor)) return null;
  return Math.min(1, Math.max(-1, valor as number));
}

/**
 * Techo de ritmo del mando, por socket de consola, en forma de balde de fichas:
 * cada `manual_stick` atendido gasta una ficha y el balde se repone a razón de
 * [FICHAS_POR_SEGUNDO] hasta [FICHAS_DE_MANDO].
 *
 * Es un balde y no un intervalo mínimo entre mensajes porque el ritmo real
 * llega a los tirones: el temporizador del navegador y la red agrupan mensajes,
 * y un intervalo mínimo tiraría el segundo de cada par que llega pegado —
 * incluido el mensaje con los cuatro ejes en cero de soltar la palanca, que es
 * el que deja al dron estacionario y es justo el que no se puede perder—.
 *
 * Los números van holgados sobre los 10 Hz del contrato: el ritmo sostenido que
 * se tolera es el doble, y el balde lleno aguanta de un saque cuatro segundos
 * de mando a ritmo de contrato. Lo que corta es la inundación —un socket
 * mandando a la velocidad del loopback, donde cada mensaje cuesta una consulta
 * SÍNCRONA a SQLite y un envío hacia el celular—, no al operador que vuela.
 */
const FICHAS_DE_MANDO = 40;
const FICHAS_POR_SEGUNDO = 20;

/**
 * Gasta una ficha del balde de la sesión y dice si el mando se puede atender.
 *
 * El balde vive en la `SesionConsola`, que sale del mapa `operators` cuando el
 * socket se cierra: el cupo se va con la consola y no queda estado colgado de
 * nadie. Es por socket, así que una consola abierta dos veces tiene dos cupos;
 * sigue siendo un techo, y el que abre consolas es alguien ya autenticado y con
 * el mando tomado.
 */
function hayCupoDeMando(sesion: SesionConsola, ahora: number): boolean {
  // Un transcurrido negativo es el reloj del servidor acomodándose hacia atrás
  // (NTP, cambio de hora): se toma como cero en vez de descontar fichas que
  // nadie gastó, que dejaría el mando mudo hasta que el reloj se recupere.
  const transcurrido = Math.max(0, ahora - sesion.fichasMedidasEn);
  sesion.fichasMedidasEn = ahora;
  sesion.fichasDeMando = Math.min(FICHAS_DE_MANDO, sesion.fichasDeMando + (transcurrido * FICHAS_POR_SEGUNDO) / 1000);
  if (sesion.fichasDeMando < 1) return false;
  sesion.fichasDeMando -= 1;
  return true;
}

/**
 * Mando virtual: lo único que una consola manda HACIA el hub. Va por el socket
 * que ya tiene abierto y no por REST porque son ~10 mensajes por segundo
 * mientras el operador mantiene la palanca, y abrir un POST por cada uno sería
 * absurdo.
 *
 * Todo rechazo es SILENCIOSO: al que manda no se le contesta nada. La consola ya
 * sabe si tiene el mando o no porque el hub le avisa con `control_changed` cada
 * vez que el lock cambia de manos; contestar por mensaje descartado sería, a
 * 10 Hz, una avalancha de respuestas que nadie mira.
 */
function handleOperatorMessage(ws: WebSocket, sesion: SesionConsola, datos: RawData) {
  // Lo que pesa más que TOPE_MENSAJE_CONSOLA no es un mando: se descarta sin
  // decodificarlo ni parsearlo. Es lo primero de todo justamente para que el
  // trabajo caro no dependa de nada que mande el que está del otro lado, y por
  // eso se miden los BYTES que llegaron y no el largo del string: pasar a texto
  // el megabyte que deja entrar TOPE_FRAME_BYTES ya es parte del trabajo que un
  // socket abusivo quiere regalarle al hub, que es de un solo hilo.
  if (bytesDelFrame(datos) > TOPE_MENSAJE_CONSOLA) return;
  const msg = parsearMensaje(datos.toString()) as MensajeOperador | null;
  if (!msg) return;
  // Por ahora el mando es lo único que la consola manda para arriba; cualquier
  // otro tipo se ignora en vez de tratarse como error.
  if (msg.type !== 'manual_stick') return;

  // El JWT no se revoca del lado del servidor, así que un socket abierto puede
  // sobrevivir al vencimiento de su sesión: una sesión vencida no vuela un dron.
  // sesionVigente además cierra el socket con 4401.
  if (!sesionVigente(ws, sesion)) return;

  // Si falta el droneId, String(undefined) no va a coincidir con ningún lock y
  // el mensaje muere acá mismo, que es lo que corresponde.
  const droneId = String(msg.droneId);
  // El lock es lo que hace exclusivo el mando, así que se comprueba primero:
  // es la condición que puede cambiar sola mientras el operador vuela (un
  // supervisor se lo quita, se le cae la última consola) y la que decide si
  // este socket es o no el que manda ESTE dron.
  if (controlledBy.get(droneId) !== sesion.username) return;

  // El techo de ritmo va ANTES de la consulta a la base: es lo que impide que
  // una consola con el mando tomado —comprometida, o con el temporizador roto—
  // le haga al hub un SELECT y un envío al celular por cada mensaje a la
  // velocidad del socket. El contrato manda 10 Hz y acá entra el doble.
  if (!hayCupoDeMando(sesion, Date.now())) return;

  // La cuenta se revalida contra la BASE en cada mensaje, igual que hace
  // requireAuth con cada request: al operador al que le acaban de quitar
  // canControl, le bajaron el rol o le dieron de baja la cuenta no le sirve
  // tener el socket abierto de antes. Es también la última línea de defensa si
  // alguna vez un camino liberara el permiso sin liberar el lock.
  const cuenta = getActiveUser(sesion.username);
  if (!cuenta || !cuenta.can_control) return;
  // El tipo `Role` de la fila es una promesa del esquema, no una garantía: la
  // columna `role` no tiene CHECK (db.ts: "validado en código") y las
  // migraciones copian el valor viejo tal cual. Si el rol no está en ROLE_RANK,
  // `undefined < 2` da false en JS y el mando SALDRÍA igual: el control falla
  // cerrado a propósito, que en un sistema de fuerzas de seguridad lo
  // desconocido no vuela.
  const rango: number | undefined = ROLE_RANK[cuenta.role];
  if (rango === undefined || rango < ROLE_RANK.operator) return;

  const ejes = {
    pitch: eje(msg.pitch),
    roll: eje(msg.roll),
    yaw: eje(msg.yaw),
    throttle: eje(msg.throttle),
  };
  // Un solo eje inválido invalida el mensaje entero: mandarle al dron tres ejes
  // buenos y uno inventado es peor que no mandarle nada.
  if (Object.values(ejes).some((v) => v === null)) return;

  // A propósito SIN createLog: a 10 Hz un registro por mensaje inundaría el log
  // y taparía todo lo demás. Lo que queda registrado es tomar y soltar el
  // control (CONTROL_TAKEN / CONTROL_RELEASED), que es lo que la auditoría
  // necesita saber: quién tuvo el mando de qué dron y desde cuándo.
  sendToDrone(droneId, { type: 'manual_stick', ...ejes, by: sesion.username });
}

/**
 * Red de contención del hub: corre el trabajo de un mensaje y, si algo tira una
 * excepción que nadie previó, la anota y sigue.
 *
 * El hub es un solo proceso para TODAS las consolas y TODOS los drones: que un
 * frame mal formado de uno se lleve puesto el Comando Central de los demás —en
 * pleno vuelo— no es una opción. No reemplaza a validar lo que entra (el
 * mensaje igual se descarta), es el piso abajo de eso.
 */
function sinTumbarElHub(quien: string, trabajo: () => void) {
  try {
    trabajo();
  } catch (error) {
    console.error(`[hub] se descartó un mensaje de ${quien}:`, error);
  }
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: TOPE_FRAME_BYTES });

  wss.on('connection', (ws, req) => {
    // `ws` emite 'error' cuando el otro lado manda un frame que viola el
    // protocolo o que se pasa de TOPE_FRAME_BYTES, y un EventEmitter sin oyente
    // de 'error' TIRA la excepción: sin este handler, poner un tope de tamaño
    // convertiría un frame gigante en la muerte del proceso, que es justo lo
    // contrario de lo que el tope busca. La conexión ya la cierra `ws` sola
    // (1009 si fue por tamaño); acá solo queda anotado.
    ws.on('error', (e) => console.error('[hub] error en un socket:', e.message));

    const url = new URL(req.url ?? '', 'http://localhost');
    const payload = verifyToken(url.searchParams.get('token') ?? '');
    if (!payload) {
      ws.close(4401, 'Token inválido');
      return;
    }

    // El dron ya no es una cuenta de usuario: su `sub` es el hash del QR y su
    // habilitación se lee de `drones` en cada conexión, no del token.
    if (payload.role === 'drone') {
      const droneId = payload.sub;
      const asset = getDrone(droneId);
      if (!asset) {
        ws.close(4403, 'Dron inexistente');
        return;
      }
      if (asset.deletedAt) {
        ws.close(4403, 'Dron eliminado');
        return;
      }
      if (!asset.active) {
        ws.close(4403, 'Dron desactivado');
        return;
      }

      // Una sola conexión por dron: si reconecta, la anterior se descarta
      drones.get(droneId)?.close(4000, 'Reemplazada por una conexión nueva');
      drones.set(droneId, ws);

      const name = asset.displayName;
      const ev = createLog('drone', 'DRONE_CONNECTED', 'backend', `${name} conectado al Comando Central`, {
        droneId,
        meta: { drone: metaDron(droneId) },
      });
      broadcastOperators({ type: 'event', event: ev });
      broadcastOperators({ type: 'drone_online', drone: droneCard(droneId) });

      ws.on('message', (data) => sinTumbarElHub(`el dron ${droneId}`, () => handleDroneMessage(droneId, data.toString())));
      ws.on('close', () => {
        if (drones.get(droneId) === ws) {
          drones.delete(droneId);
          lastStatus.delete(droneId);
          controlledBy.delete(droneId);
          const evc = createLog('drone', 'DRONE_DISCONNECTED', 'backend', `${name} desconectado del Comando Central`, {
            droneId,
            meta: { drone: metaDron(droneId) },
          });
          broadcastOperators({ type: 'event', event: evc });
          broadcastOperators({ type: 'drone_offline', drone: droneCard(droneId) });
        }
      });
      return;
    }

    const cuenta = getActiveUser(payload.sub);
    if (!cuenta) {
      ws.close(4403, 'Cuenta desactivada o eliminada');
      return;
    }
    // El rol sale de la base y no del token, como en requireAuth: el canal en
    // vivo tiene que filtrar con el rol que la cuenta tiene AHORA.
    const sesion: SesionConsola = {
      username: cuenta.username,
      role: cuenta.role,
      expiraEn: payload.exp ?? Number.POSITIVE_INFINITY,
      // Arranca con el balde lleno: el operador que recién abre la consola tiene
      // que poder tomar el mando y volar sin esperar a que se le repongan fichas.
      fichasDeMando: FICHAS_DE_MANDO,
      fichasMedidasEn: Date.now(),
    };
    operators.set(ws, sesion);
    // Estado inicial: el operador pinta el dashboard sin esperar al próximo tick
    for (const status of lastStatus.values()) if (puedeVer(sesion, status)) ws.send(JSON.stringify(status));
    // El socket de la consola es de doble vía: además de recibir el flujo en
    // vivo, es por donde entra el mando virtual (ver handleOperatorMessage).
    ws.on('message', (datos) =>
      sinTumbarElHub(`la consola de ${sesion.username}`, () => handleOperatorMessage(ws, sesion, datos)),
    );
    ws.on('close', () => {
      operators.delete(ws);
      // Si era la última conexión de ese usuario, no puede seguir controlando
      const sigueConectado = [...operators.values()].some((s) => s.username === sesion.username);
      if (!sigueConectado) {
        releaseAllControlledBy(sesion.username, sesion.username, 'el usuario se desconectó del Comando Central');
      }
    });
  });
}
