import type { Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { ROLE_RANK, SESION_DE_OTRO_ROL, esDeOtroRol, verifyToken } from './auth';
import { posicionValida, validarAutonomia, validarRelevoInformado } from './contrato';
import { CoordinadorDelControl, PLAZOS_DEL_CONTROL, type PedidoDeControlView } from './control';
import { Emergencias } from './emergencias';
import { metaAlerta, metaDron } from './meta';
import { CoordinadorDeRelevos } from './relevos';
import { relojDelHub } from './reloj';
import {
  createAlert, createLog, getActiveUser, getAlert, getDrone, getDroneIdentity, listBases, listDecisionsSince, listDrones,
  renameDrone, seguidorDeAlerta,
  type Alert, type DroneAssetView, type DroneBase, type EventRow, type Role,
} from './store';

// Se reexportan para quien ya las tomaba del hub: viven en módulos propios para
// que el coordinador de relevos y el de emergencias las usen sin importar ws.ts.
export { metaDron, type MetaDron } from './meta';
export { posicionValida } from './contrato';

/** Todo lo que sale hacia las consolas lleva `type`: es lo que decide quién lo ve. */
export interface MensajeHub {
  type: string;
  [clave: string]: unknown;
}

/** Balde de fichas de un tipo de mando (ver `hayCupo`). */
interface Balde {
  /** Fichas que le quedan. */
  fichas: number;
  /** Cuándo se contaron, para reponerlas al usar las siguientes. */
  medidoEn: number;
}

/** Consola conectada. El rol y el vencimiento se guardan para revalidarla. */
interface SesionConsola {
  username: string;
  role: Role;
  /** Epoch en segundos del JWT; infinito si el token no lleva vencimiento. */
  expiraEn: number;
  /** Cupo de `manual_stick` de este socket. */
  cupoDePalancas: Balde;
  /** Cupo de `manual_gimbal`, aparte del de las palancas (ver `cupoDelMando`). */
  cupoDeCamara: Balde;
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
 * único que una consola manda para arriba es el mando —`manual_stick`, que con
 * el droneId y los cuatro ejes no llega a 200 bytes, y `manual_gimbal`, que con
 * un solo número es más chico todavía—. Se mide primero porque decodificar y
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
 * Las novedades de un aterrizaje de emergencia también le llegan al operador de
 * campo: es quien sale a buscar el dron (PROTOCOLS §3), y la última posición y
 * las fotos del lugar son justo lo que necesita en el teléfono.
 */
const TIPOS_DE_EMERGENCIA = new Set(['emergency_updated', 'emergency_photo']);

/**
 * El canal en vivo respeta los mismos permisos que la API REST: sin esto un
 * operador de campo recibía por WebSocket el video, las alertas y el registro
 * de usuarios que sus propias requests reciben con un 403.
 */
function puedeVer(sesion: SesionConsola, msg: MensajeHub): boolean {
  if (sesion.role === 'field_operator') return TIPOS_DE_ACTIVO.has(msg.type) || TIPOS_DE_EMERGENCIA.has(msg.type);
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
  /** El pedido de control que espera la respuesta del titular, o null (PROTOCOLS §6). */
  pedidoDeControl: PedidoDeControlView | null;
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
    pedidoDeControl: control.pedidoDe(d.hash),
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

// ---- Relevos, desvíos y emergencias ----

/**
 * Coordinador de relevos del hub (relevos.ts). Manda por los mismos caminos que
 * el resto del hub y mide los plazos con `relojDelHub`, que las pruebas
 * reemplazan para mover el tiempo a mano.
 */
export const relevos = new CoordinadorDeRelevos({
  enviar: sendToDrone,
  difundir: broadcastOperators,
  ahora: () => relojDelHub.ahora(),
  conectado: isOnline,
});

/**
 * Quién sigue vivo al mando y el traspaso del control entre personas
 * (control.ts). El lock es este de acá (`controlledBy`): el coordinador decide
 * cuándo soltarlo o pasarlo, con el mismo reloj que los relevos.
 */
export const control = new CoordinadorDelControl({
  ahora: () => relojDelHub.ahora(),
  locks: () => controlledBy.entries(),
  titular: getController,
  tomar: (droneId, username) => {
    takeControl(droneId, username);
  },
  traspasar: transferirControl,
  soltarPorInactividad,
  puedeControlar: cuentaQuePuedePilotear,
  tieneConsola: (username) => [...operators.values()].some((s) => s.username === username),
  difundir: broadcastOperators,
});

/** Protocolo de última ubicación del lado del hub (emergencias.ts). */
export const emergencias = new Emergencias({
  enviar: sendToDrone,
  difundir: broadcastOperators,
  ahora: () => relojDelHub.ahora(),
  alAterrizar: (droneId) => relevos.alAterrizarFueraDeBase(droneId),
});

/** Tope de bases por mensaje (§2.b): un dron no necesita más para elegir dónde bajar. */
const TOPE_BASES_AL_DRON = 200;
const TOPE_NOMBRE_DE_BASE = 60;

/**
 * El mensaje `bases` para un dron (PROTOCOLS §2.b): las bases activas, con su
 * punto para visitantes, y cuál es la suya. La app reemplaza su lista entera
 * con cada uno y descarta el mensaje completo si algo no cumple, y sin lista no
 * hay desvío posible: por eso acá se dejan afuera las bases que no se podrían
 * mandar —una cargada en 0,0, que la API de bases acepta, o una vieja con un
 * nombre fuera de rango— en vez de arruinar el mensaje entero.
 */
export function mensajeDeBases(droneId: string): MensajeHub {
  const enviables = listBases({ soloActivas: true }).filter(
    (b) => posicionValida(b.lat, b.lon) !== null && b.name.length >= 1 && b.name.length <= TOPE_NOMBRE_DE_BASE,
  );
  const propia = getDrone(droneId)?.baseId ?? null;
  let lista = enviables.slice(0, TOPE_BASES_AL_DRON);
  const suya = enviables.find((b) => b.id === propia);
  // La propia va siempre, aunque la lista se corte: es la base a la que vuelve.
  if (suya && !lista.includes(suya)) lista = [...lista.slice(0, TOPE_BASES_AL_DRON - 1), suya];
  return {
    type: 'bases',
    propiaId: suya ? suya.id : null,
    bases: lista.map((b) => {
      const visitantes = posicionValida(b.aterrizajeLat, b.aterrizajeLon);
      return {
        id: b.id,
        nombre: b.name,
        lat: b.lat,
        lon: b.lon,
        aterrizajeLat: visitantes?.lat ?? null,
        aterrizajeLon: visitantes?.lon ?? null,
      };
    }),
  };
}

/** Manda `bases` a un dron: al conectarse y cuando le cambian la base asignada. */
export function enviarBases(droneId: string): boolean {
  return sendToDrone(droneId, mensajeDeBases(droneId));
}

/** Manda `bases` a todos los drones conectados: en cada alta, edición, baja o restauración de una base. */
export function enviarBasesATodos(): void {
  for (const droneId of drones.keys()) enviarBases(droneId);
}

/**
 * `relevo` y `autonomia` del status (§1): el hub los reenvía tal cual si pasan
 * la validación y, si no, los saca —el status sale igual, porque es lo único
 * que dice si el dron vuela— y anota el motivo. Una app vieja no los manda, y
 * entonces no salen.
 */
function camposDeRelevo(droneId: string, relevo: unknown, autonomia: unknown): Record<string, unknown> {
  const campos: Record<string, unknown> = {};
  if (relevo !== undefined) {
    if (validarRelevoInformado(relevo)) campos.relevo = relevo;
    else console.warn(`[hub] status de ${droneId}: se sacó 'relevo' porque no cumple el contrato`);
  }
  if (autonomia !== undefined) {
    if (validarAutonomia(autonomia)) campos.autonomia = autonomia;
    else console.warn(`[hub] status de ${droneId}: se sacó 'autonomia' porque no cumple el contrato`);
  }
  return campos;
}

/**
 * Tipos de evento que crea SOLO el hub (PROTOCOLS §1): viniendo del teléfono
 * serían falsificables, y el registro de un relevo o de una emergencia tiene
 * que salir del estado que guarda el hub, no de lo que un dron diga.
 */
function eventoReservadoAlHub(tipo: string): boolean {
  return tipo.startsWith('RELAY_') || tipo.startsWith('EMERGENCY_') || tipo === 'RTH_DIVERTED';
}

// ---- Control manual exclusivo ----

export function takeControl(droneId: string, username: string): { ok: true } | { ok: false; heldBy: string } {
  const holder = controlledBy.get(droneId);
  if (holder && holder !== username) return { ok: false, heldBy: holder };
  controlledBy.set(droneId, username);
  control.alTomar(droneId);
  sendToDrone(droneId, { type: 'control_taken', by: username });
  broadcastOperators({ type: 'control_changed', droneId, controlledBy: username });
  const ev = createLog('drone', 'CONTROL_TAKEN', username, `${username} tomó el control manual del dron ${droneId}`, {
    droneId,
    meta: { drone: metaDron(droneId), detalle: { por: username } },
  });
  broadcastOperators({ type: 'event', event: ev });
  return { ok: true };
}

/**
 * Por qué el hub soltó el control SOLO, sin que nadie lo pidiera. Viaja en
 * `control_released` a la app y en `control_changed` a las consolas (PROTOCOLS
 * §2 y §3): `inactividad` es el titular sin señales de vida 30 s, y la app la
 * atiende distinto (le devuelve el mando al control físico); `app` es la app
 * que avisó que no tenía el control tomado (`control_dropped`).
 */
export type MotivoDeSoltar = 'inactividad' | 'app';

export interface ReleaseOptions {
  resume: 'last' | 'none' | number;
  forced?: boolean;
  reason?: string;
  motivo?: MotivoDeSoltar;
  /**
   * El `resume_patrol` de este soltar es una orden de reanudar que una persona
   * eligió (`POST /resume`). Sin esto sale con `alSoltar: true`: es el que
   * acompaña a un soltar (la salida de la vista de pilotaje, «Quitar control»,
   * una baja, el cierre de sesión), y la app no le corta con él un aterrizaje
   * en curso (PROTOCOLS §2).
   */
  ordenDeReanudar?: boolean;
}

/** Lo que se le dice a quien pidió el control si el lock se suelta mientras espera. */
function porQueSeSolto(byUser: string, holder: string, opts: ReleaseOptions): string {
  if (opts.reason) return opts.reason;
  return opts.forced ? `${byUser} le quitó el control a ${holder}` : `${holder} soltó el control`;
}

export function releaseControl(droneId: string, byUser: string, opts: ReleaseOptions): boolean {
  const holder = controlledBy.get(droneId);
  if (!holder) return false;
  controlledBy.delete(droneId);
  control.alSoltar(droneId, porQueSeSolto(byUser, holder, opts));
  const causa = opts.motivo ? { motivo: opts.motivo } : {};
  sendToDrone(droneId, { type: 'control_released', by: byUser, ...causa });

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
  broadcastOperators({ type: 'control_changed', droneId, controlledBy: null, teniaElControl: holder, ...causa });

  if (opts.resume !== 'none') {
    const msg: Record<string, unknown> = { type: 'resume_patrol', orderedBy: byUser };
    if (typeof opts.resume === 'number') msg.fromIndex = opts.resume;
    if (!opts.ordenDeReanudar) msg.alSoltar = true;
    sendToDrone(droneId, msg);
  }
  return true;
}

/**
 * El control pasa de `de` a `a` sin soltarse: un pedido que el titular cedió o
 * no contestó a tiempo (control.ts). El dron recibe `control_transferred` y no
 * `control_released` + `control_taken`: con esos dos la app frenaba, volvía al
 * objetivo o esperaba una reanudación en el medio, y un dron que alguien está
 * piloteando no puede hacer nada de eso porque cambió la persona. La app lo
 * deja estacionario donde está, en MANUAL, a la espera del nuevo titular.
 */
function transferirControl(droneId: string, de: string, a: string, motivo: 'cedido' | 'vencido') {
  controlledBy.set(droneId, a);
  sendToDrone(droneId, { type: 'control_transferred', by: a, de });
  broadcastOperators({ type: 'control_changed', droneId, controlledBy: a, teniaElControl: de });
  const mensaje =
    motivo === 'cedido'
      ? `${de} le cedió a ${a} el control manual del dron ${droneId}`
      : `El control manual del dron ${droneId} pasó de ${de} a ${a}: ${de} no contestó el pedido a tiempo`;
  const ev = createLog('drone', 'CONTROL_TRANSFERRED', motivo === 'cedido' ? de : 'backend', mensaje, {
    droneId,
    meta: { drone: metaDron(droneId), detalle: { de, a, motivo } },
  });
  broadcastOperators({ type: 'event', event: ev });
}

/**
 * El titular lleva 30 s sin dar señales de vida (control.ts): la consola se
 * colgó, se cortó la red o se cerró la pestaña. El control se suelta SIN
 * reanudar nada, pase lo que pase con el objetivo o con un relevo: el dron no
 * se pone a patrullar solo porque a alguien se le cayó internet. Con
 * `motivo: 'inactividad'` la app sale de MANUAL, queda estacionaria y le
 * devuelve el mando a las palancas del control físico, para que el que está al
 * lado del dron lo pueda tomar; desde la consola se lo puede volver a tomar o
 * mandar a patrullar.
 */
function soltarPorInactividad(droneId: string, titular: string) {
  releaseControl(droneId, 'Comando Central', {
    resume: 'none',
    forced: true,
    motivo: 'inactividad',
    reason: `${titular} estuvo ${PLAZOS_DEL_CONTROL.sinSenalesMs / 1000} s sin dar señales desde la consola`,
  });
}

/** Tope del `motivo` de un `control_dropped`: es para el registro, no un párrafo. */
const TOPE_MOTIVO_DE_LA_APP = 200;

/**
 * La app avisa que NO tiene el control tomado que el hub cree que le dio
 * (`control_dropped`, PROTOCOLS §1): lo soltó sola tras 30 s sin enlace con el
 * Comando Central, o se reinició. El hub le cree y suelta el lock, sin
 * reanudar: la app es la que está al lado del dron, y volver a tomarlo desde
 * acá le podría sacar el mando a quien lo esté volando con el control físico.
 *
 * Solo el lock del titular que el aviso nombra (`by`): si en el medio el
 * control pasó a otro, ese lo tomó después y el aviso no es suyo.
 */
function alSoltarseEnLaApp(droneId: string, msg: MensajeDron) {
  const titular = controlledBy.get(droneId);
  if (!titular || msg.by !== titular) return;
  const motivo = typeof msg.motivo === 'string' ? msg.motivo.trim().slice(0, TOPE_MOTIVO_DE_LA_APP) : '';
  releaseControl(droneId, 'Comando Central', {
    resume: 'none',
    forced: true,
    motivo: 'app',
    reason: motivo || 'la app del dron no tenía el control tomado',
  });
}

/**
 * Con qué reanuda un dron cuando el hub le suelta el control POR SU CUENTA, sin
 * que nadie haya elegido: suspendieron o borraron al titular. (Al que se le
 * cae la consola ya no se lo suelta en el acto: ver `soltarPorInactividad`.)
 *
 * Si el último status trae un `target`, el dron está sobre un objetivo
 * (orbitándolo o siguiéndolo) y se suelta con 'none': al recibir
 * `control_released` la app vuelve sola al objetivo. Con 'last' le llegaría
 * además un `resume_patrol`, que TERMINA el seguimiento (§2), y que al operador
 * se le corte internet no puede ser el motivo para abandonar a la persona o al
 * vehículo que el dron tenía a la vista. Sin objetivo, 'last' como siempre: el
 * dron vuelve a su ruta en vez de quedarse estacionario esperando a alguien que
 * ya no está.
 *
 * Un dron que participa de un relevo activo también se suelta con 'none'
 * (RELEVOS §3.9): a B un `resume_patrol` lo sacaría del relevo, y a A lo
 * mandaría a patrullar con la batería que lo hizo pedir uno.
 */
function reanudacionAlSoltar(droneId: string): 'none' | 'last' {
  if (relevos.participaDeUnRelevoActivo(droneId)) return 'none';
  const target = lastStatus.get(droneId)?.target;
  return typeof target === 'object' && target !== null && !Array.isArray(target) ? 'none' : 'last';
}

/**
 * Libera todos los drones controlados por un usuario (suspensión o borrado), y
 * cancela los pedidos de control que tuviera esperando: ya no puede pilotear.
 */
export function releaseAllControlledBy(username: string, byUser: string, reason: string) {
  control.cancelarPedidosDe(username, reason);
  for (const [droneId, holder] of controlledBy) {
    if (holder === username) {
      releaseControl(droneId, byUser, { resume: reanudacionAlSoltar(droneId), forced: byUser !== username, reason });
    }
  }
}

/**
 * Mensaje que llega del celular: viene de la red, así que todo campo es
 * opcional. Los que el hub valida antes de usarlos van como `unknown` a
 * propósito: así el compilador no deja leerlos como si ya fueran lo que dicen.
 */
interface MensajeDron {
  type?: string;
  eventType?: string;
  message?: string;
  jpegBase64?: string;
  ts?: number;
  alertType?: string;
  lat?: unknown;
  lon?: unknown;
  gpsFix?: unknown;
  alertId?: unknown;
  ref?: unknown;
  confidence?: unknown;
  classes?: unknown;
  droneLat?: unknown;
  droneLon?: unknown;
  droneAlt?: unknown;
  gimbalPitch?: unknown;
  snapshotBase64?: string;
  displayName?: string;
  [clave: string]: unknown;
}

/**
 * La inclinación de la cámara que informa el `status` (§1, `gimbalPitch`), solo
 * si es un número finito; si no, el campo no sale. Va TAL CUAL llegó, sin
 * recortarla: es lo que el gimbal dice que está haciendo, no una orden, y la
 * consola la muestra para que el operador sepa adónde mira la cámara.
 *
 * Es el único campo del status que el hub filtra además de la posición, y por
 * el mismo motivo: la consola lo dibuja. Un texto o un null que se colaran como
 * inclinación le pintarían al operador una cámara apuntando a ningún lado,
 * cuando sin el campo la consola ya sabe qué suponer (una app vieja no lo
 * manda). `Number.isFinite` y no `Number(...)`, igual que en [posicionValida]:
 * `Number(null)` es 0 y el horizonte no es lo mismo que "no sé".
 */
function inclinacionInformada(gimbalPitch: unknown): { gimbalPitch?: number } {
  return Number.isFinite(gimbalPitch) ? { gimbalPitch: gimbalPitch as number } : {};
}

/**
 * Normalización defensiva del `status`. El contrato dice que sin fix la app
 * manda `lat`/`lon` en null y `gpsFix: false`, pero una app vieja (sin el
 * filtro del 0,0 en el controlador del dron real) manda el 0,0 del SDK como si
 * fuera una posición:
 * el hub es el único punto por el que pasan TODAS las consolas, así que se
 * corrige acá una vez en vez de confiar en que cada pantalla lo filtre.
 *
 * - Sin posición válida, `lat`/`lon` quedan en null y `gpsFix` en false, diga
 *   lo que diga la app: un fix sin posición no se puede dibujar.
 * - Con posición válida y sin `gpsFix` (la app vieja no lo conoce), se asume
 *   true. Si la app lo manda en false se respeta: ella sabe si tiene fix.
 *
 * Todo lo demás —`target` incluido— se reenvía tal cual: el hub no filtra
 * campos, y una consola que no conozca uno lo ignora. La excepción, además de la
 * posición, es `gimbalPitch` (ver [inclinacionInformada]).
 */
function normalizarPosicion(msg: MensajeDron): { lat: number | null; lon: number | null; gpsFix: boolean } {
  const posicion = posicionValida(msg.lat, msg.lon);
  if (!posicion) return { lat: null, lon: null, gpsFix: false };
  return { ...posicion, gpsFix: typeof msg.gpsFix === 'boolean' ? msg.gpsFix : true };
}

/**
 * La alerta a la que un evento del dron dice pertenecer, solo si existe y es
 * de ESE dron. El id viaja desde el celular: sin este control, una app con un
 * id viejo (de antes de reinstalarla, o de otro dron emparejado en el mismo
 * teléfono) colgaría sus eventos de la alerta de otro, y el pop-up del
 * registro mostraría como prueba la captura equivocada.
 *
 * `isSafeInteger` y no `isInteger`: un 1e300 es "entero" para JS pero no es un
 * id que SQLite pueda tener, y no hace falta preguntarle.
 *
 * "De ese dron" es el que la SIGUE ahora, `COALESCE(seguida_por, drone_id)`
 * (RELEVOS §3.6): después de un traspaso los eventos de seguimiento los manda
 * el que relevó, y son los que cuentan cómo sigue la historia de la alerta.
 */
function alertaDelDron(alertId: unknown, droneId: string): Alert | null {
  if (!Number.isSafeInteger(alertId) || (alertId as number) <= 0) return null;
  const alerta = getAlert(alertId as number);
  return alerta && seguidorDeAlerta(alerta) === droneId ? alerta : null;
}

/** Valor de `meta.detalle`: el pop-up lo pinta como lista de clave/valor, así que va plano. */
type ValorPlano = string | number | boolean | null;

/**
 * Las clases que vio el detector, como texto separado por comas: es lo que
 * entra en un valor plano del `detalle` y lo que el operador lee. Llegan como
 * lista (`["PERSON", "VEHICLE"]`); se acepta también un texto suelto, y lo que
 * no sea texto adentro de la lista se descarta en vez de pintarse como
 * `[object Object]`.
 */
function textoDeClases(classes: unknown): string {
  if (typeof classes === 'string') return classes.trim();
  if (!Array.isArray(classes)) return '';
  const nombres = classes.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter(Boolean);
  return [...new Set(nombres)].join(', ');
}

/**
 * Lo que la detección sabía al disparar la alerta y que la fila de `alerts` no
 * guarda: con qué confianza, qué clases y desde dónde miraba el dron. Sin la
 * pose del dron no hay forma de revisar después si la georreferencia del
 * objetivo tenía sentido.
 *
 * Entra solo lo que viene válido y cada campo puede faltar (§7): una confianza
 * fuera de [0, 1] o una pose en 0,0 no son un dato, son ruido, y en el registro
 * de una alerta un dato falso es peor que uno ausente. Si no queda ninguno,
 * devuelve null y el evento sale sin `detalle`.
 */
function detalleDeDeteccion(msg: MensajeDron): Record<string, ValorPlano> | null {
  const detalle: Record<string, ValorPlano> = {};
  if (Number.isFinite(msg.confidence) && (msg.confidence as number) >= 0 && (msg.confidence as number) <= 1) {
    detalle.confianza = msg.confidence as number;
  }
  const clases = textoDeClases(msg.classes);
  if (clases) detalle.clases = clases;
  const dron = posicionValida(msg.droneLat, msg.droneLon);
  if (dron) {
    detalle.dronLat = dron.lat;
    detalle.dronLon = dron.lon;
  }
  if (Number.isFinite(msg.droneAlt)) detalle.dronAlt = msg.droneAlt as number;
  return Object.keys(detalle).length > 0 ? detalle : null;
}

/** Largo máximo del `ref` de un `alert_request` (§1). */
const TOPE_REF = 64;

/**
 * El `ref` con el que la app reconoce el `alert_ack` de su alerta, o null si no
 * vino o no sirve. Se devuelve TAL CUAL llegó (sin recortar ni limpiar): la app
 * lo compara contra el que inventó, y un ref retocado no le coincidiría nunca.
 * Por lo mismo uno de más de 64 caracteres no se trunca: se descarta.
 */
function refDeAlerta(ref: unknown): string | null {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= TOPE_REF ? ref : null;
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
 * El texto del frame, decodificado de la MISMA forma en que [bytesDelFrame] lo
 * midió. Va en par con esa función a propósito: medir las tres formas de
 * `RawData` y después decodificar con un `.toString()` pelado dejaba el trabajo a
 * medias, porque ese `.toString()` solo hace lo correcto con un Buffer. Sobre un
 * ArrayBuffer devuelve la cadena `[object ArrayBuffer]`, y sobre una lista de
 * fragmentos los une con COMAS: `{"a":1` + `,"b":2}` sale `{"a":1,,"b":2}`, que
 * no parsea. En los dos casos el mando se perdía en silencio.
 */
export function textoDelFrame(datos: RawData): string {
  if (Array.isArray(datos)) return Buffer.concat(datos).toString('utf8');
  if (datos instanceof ArrayBuffer) return Buffer.from(datos).toString('utf8');
  return datos.toString('utf8');
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
      // La inclinación, el relevo y la autonomía se sacan del resto para que
      // uno que no sirva no viaje por la copia tal cual: vuelven solo si pasan.
      const { gimbalPitch, relevo, autonomia, ...resto } = msg;
      const status: MensajeHub = {
        ...resto,
        ...normalizarPosicion(msg),
        ...inclinacionInformada(gimbalPitch),
        ...camposDeRelevo(droneId, relevo, autonomia),
        type: 'status',
        droneId,
        displayName,
        controlledBy: getController(droneId),
      };
      lastStatus.set(droneId, status);
      broadcastOperators(status);
      relevos.alRecibirStatus(droneId, status);
      break;
    }
    case 'video_frame':
      broadcastOperators({ type: 'video_frame', droneId, jpegBase64: msg.jpegBase64, ts: msg.ts });
      break;
    case 'event': {
      // Los eventos de seguimiento (TARGET_MOVING, TARGET_LOST, …) traen la
      // alerta del objetivo y su posición: encadenados a la alerta, el registro
      // cuenta la historia entera de esa detección, y con la posición el equipo
      // de tierra sabe dónde quedó el objetivo aunque el dron ya no lo vea. Lo
      // que venga mal se ignora sin perder el evento, que igual se registra.
      if (eventoReservadoAlHub(String(msg.eventType))) {
        console.warn(`[hub] se descartó un event ${String(msg.eventType)} de ${droneId}: ese tipo lo crea solo el hub`);
        break;
      }
      const alerta = alertaDelDron(msg.alertId, droneId);
      const ubicacion = posicionValida(msg.lat, msg.lon);
      const meta: Record<string, unknown> = { drone: metaDron(droneId) };
      if (alerta) meta.alerta = metaAlerta(alerta);
      if (ubicacion) meta.ubicacion = { ...ubicacion, accuracyM: null };
      const ev = createLog('drone', String(msg.eventType), droneId, String(msg.message ?? ''), {
        droneId,
        alertId: alerta?.id ?? null,
        meta,
      });
      broadcastOperators({ type: 'event', event: ev });
      break;
    }
    case 'alert_request': {
      const alertType = msg.alertType === 'VEHICLE' ? 'VEHICLE' : 'PERSON';
      // lat/lon son la posición estimada del OBJETIVO, no la del dron: se
      // validan igual que cualquier posición, y una inválida queda en null en
      // vez de mandar al equipo de tierra al 0,0.
      const objetivo = posicionValida(msg.lat, msg.lon);
      const alert = createAlert(
        alertType,
        droneId,
        objetivo?.lat ?? null,
        objetivo?.lon ?? null,
        msg.snapshotBase64 ?? null,
      );
      const detalle = detalleDeDeteccion(msg);
      const ev = createLog(
        'drone',
        'ALERT_CREATED',
        droneId,
        `Alerta de ${alertType === 'PERSON' ? 'PERSONA' : 'VEHÍCULO'} generada por ${displayName}`,
        {
          droneId,
          alertId: alert.id,
          meta: { alerta: metaAlerta(alert), drone: metaDron(droneId), ...(detalle ? { detalle } : {}) },
        },
      );
      broadcastOperators({ type: 'alert_created', alert });
      broadcastOperators({ type: 'event', event: ev });
      // El id de la alerta lo decide la base, no la app: sin este acuse el dron
      // no sabría cuál es la alerta del objetivo que está siguiendo, y no podría
      // distinguir la decisión sobre ESA alerta de la de una vieja.
      const ref = refDeAlerta(msg.ref);
      if (ref) sendToDrone(droneId, { type: 'alert_ack', ref, alertId: alert.id });
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
    case 'control_dropped':
      alSoltarseEnLaApp(droneId, msg);
      break;
    // Relevos, desvíos y emergencias (§1.b): cada coordinador dice si el tipo
    // es suyo. Cualquier otro tipo se ignora, como siempre.
    default:
      if (!relevos.alRecibirMensaje(droneId, msg)) emergencias.alRecibirMensaje(droneId, msg);
  }
}

/** Mensaje que llega de una consola: viene de la red, así que todo campo es opcional. */
interface MensajeOperador {
  type?: string;
  droneId?: string;
  /** En `manual_stick` es el eje adelante/atrás; en `manual_gimbal`, la inclinación de la cámara en grados. */
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
 * Rango de la inclinación de la cámara que acepta `manual_gimbal`, en grados:
 * 0 es el horizonte y los negativos miran hacia abajo, hasta el nadir (-90).
 * Por arriba del horizonte se deja un poco (30) para mirar un techo, una copa o
 * un balcón; más arriba el gimbal del Mini no llega y la cámara le mostraría al
 * operador sus propias hélices.
 */
const INCLINACION_MINIMA = -90;
const INCLINACION_MAXIMA = 30;

/**
 * La inclinación ABSOLUTA de la cámara pedida por la consola, recortada a
 * [INCLINACION_MINIMA, INCLINACION_MAXIMA]; null si no es un número finito.
 *
 * Mismo criterio que [eje]: `Number.isFinite` para que un null o un texto no
 * se cuelen como un 0 —que acá es apuntar al horizonte, una orden que nadie
 * dio—, y recortar en vez de descartar porque la consola la arma desde un
 * deslizador o un arrastre: un -95 por redondeo quiere decir "todo para abajo".
 */
function inclinacionDeCamara(valor: unknown): number | null {
  if (!Number.isFinite(valor)) return null;
  return Math.min(INCLINACION_MAXIMA, Math.max(INCLINACION_MINIMA, valor as number));
}

/**
 * Techo de ritmo del mando, por socket de consola y por tipo de mando, en forma
 * de balde de fichas: cada mensaje atendido gasta una ficha y el balde se repone
 * a razón de [FICHAS_POR_SEGUNDO] hasta [FICHAS_DE_MANDO].
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

/** Un balde lleno, como arranca cada consola (ver `setupWebSocket`). */
function baldeLleno(ahora: number): Balde {
  return { fichas: FICHAS_DE_MANDO, medidoEn: ahora };
}

/**
 * Gasta una ficha del balde y dice si el mando se puede atender.
 *
 * Los baldes viven en la `SesionConsola`, que sale del mapa `operators` cuando
 * el socket se cierra: el cupo se va con la consola y no queda estado colgado de
 * nadie. Son por socket, así que una consola abierta dos veces tiene dos cupos;
 * sigue siendo un techo, y el que abre consolas es alguien ya autenticado y con
 * el mando tomado.
 */
function hayCupo(balde: Balde, ahora: number): boolean {
  // Un transcurrido negativo es el reloj del servidor acomodándose hacia atrás
  // (NTP, cambio de hora): se toma como cero en vez de descontar fichas que
  // nadie gastó, que dejaría el mando mudo hasta que el reloj se recupere.
  const transcurrido = Math.max(0, ahora - balde.medidoEn);
  balde.medidoEn = ahora;
  balde.fichas = Math.min(FICHAS_DE_MANDO, balde.fichas + (transcurrido * FICHAS_POR_SEGUNDO) / 1000);
  if (balde.fichas < 1) return false;
  balde.fichas -= 1;
  return true;
}

/**
 * De qué balde gasta cada tipo de mando; null si el tipo no es un mando.
 *
 * La cámara tiene su PROPIO balde y no comparte el de las palancas, a
 * propósito: el operador puede arrastrar el deslizador de la cámara mientras
 * sostiene la palanca, y son 10 Hz de cada uno. Con un balde compartido, esos
 * 20 mensajes por segundo son exactamente la reposición del balde: al primer
 * tirón del navegador se empiezan a perder mensajes, y el que se pierde puede
 * ser el de los cuatro ejes en cero de soltar la palanca, que es el que deja al
 * dron estacionario. Inclinar la cámara no puede gastarle el cupo al mando que
 * vuela; con dos baldes cada uno tiene su techo, y una inundación de uno no
 * enmudece al otro. El costo es que el techo del socket se duplica, y sigue
 * siendo un techo.
 *
 * Es un `switch` y no una tabla indexada por el `type`, porque el `type` lo
 * escribe el otro lado: un objeto común hereda Object.prototype y un mensaje
 * con `type: "toString"` encontraría ahí una función (ver el control del rol).
 */
function cupoDelMando(sesion: SesionConsola, type: unknown): Balde | null {
  switch (type) {
    case 'manual_stick':
      return sesion.cupoDePalancas;
    case 'manual_gimbal':
      return sesion.cupoDeCamara;
    default:
      return null;
  }
}

/**
 * Mando virtual: lo único que una consola manda HACIA el hub, las palancas
 * (`manual_stick`) y la inclinación de la cámara (`manual_gimbal`). Va por el
 * socket que ya tiene abierto y no por REST porque son ~10 mensajes por segundo
 * mientras el operador mantiene la palanca o arrastra la cámara, y abrir un
 * POST por cada uno sería absurdo.
 *
 * Los dos pasan por los MISMOS controles (ver [puedeMandar]): mover la cámara
 * es parte de pilotear —le cambia al operador lo que ve y, con eso, hacia dónde
 * va la georreferencia de las detecciones—, así que lo hace el titular del lock
 * y nadie más.
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
  const msg = parsearMensaje(textoDelFrame(datos)) as MensajeOperador | null;
  if (!msg) return;
  // La señal de vida del titular (§3.b): sin cupo ni consulta a la base,
  // porque no mueve nada y no le llega al dron. De cualquier otro, se ignora.
  if (msg.type === 'control_heartbeat') {
    if (sesionVigente(ws, sesion)) control.latido(String(msg.droneId), sesion.username);
    return;
  }
  // Además de eso, el mando es lo único que la consola manda para arriba;
  // cualquier otro tipo se ignora en vez de tratarse como error.
  const cupo = cupoDelMando(sesion, msg.type);
  if (!cupo) return;

  // Si falta el droneId, String(undefined) no va a coincidir con ningún lock y
  // el mensaje muere en puedeMandar, que es lo que corresponde.
  const droneId = String(msg.droneId);
  if (!puedeMandar(ws, sesion, droneId, cupo)) return;
  // Un mando que pasó es también una señal de vida del titular.
  control.latido(droneId, sesion.username);

  // A propósito SIN createLog, ninguno de los dos: a 10 Hz un registro por
  // mensaje inundaría el log y taparía todo lo demás. Lo que queda registrado es
  // tomar y soltar el control (CONTROL_TAKEN / CONTROL_RELEASED), que es lo que
  // la auditoría necesita saber: quién tuvo el mando de qué dron y desde cuándo.
  if (msg.type === 'manual_gimbal') {
    const pitch = inclinacionDeCamara(msg.pitch);
    if (pitch !== null) sendToDrone(droneId, { type: 'manual_gimbal', pitch, by: sesion.username });
    return;
  }

  const ejes = {
    pitch: eje(msg.pitch),
    roll: eje(msg.roll),
    yaw: eje(msg.yaw),
    throttle: eje(msg.throttle),
  };
  // Un solo eje inválido invalida el mensaje entero: mandarle al dron tres ejes
  // buenos y uno inventado es peor que no mandarle nada.
  if (Object.values(ejes).some((v) => v === null)) return;
  sendToDrone(droneId, { type: 'manual_stick', ...ejes, by: sesion.username });
}

/**
 * Los controles que tiene que pasar un mando antes de llegar al dron, en este
 * orden. Son los mismos para las palancas y para la cámara: lo único que cambia
 * es de qué [cupo] gasta cada uno (ver [cupoDelMando]).
 */
function puedeMandar(ws: WebSocket, sesion: SesionConsola, droneId: string, cupo: Balde): boolean {
  // El JWT no se revoca del lado del servidor, así que un socket abierto puede
  // sobrevivir al vencimiento de su sesión: una sesión vencida no vuela un dron.
  // sesionVigente además cierra el socket con 4401.
  if (!sesionVigente(ws, sesion)) return false;

  // El lock es lo que hace exclusivo el mando, así que se comprueba primero:
  // es la condición que puede cambiar sola mientras el operador vuela (un
  // supervisor se lo quita, se le cae la última consola) y la que decide si
  // este socket es o no el que manda ESTE dron.
  if (controlledBy.get(droneId) !== sesion.username) return false;

  // El techo de ritmo va ANTES de la consulta a la base: es lo que impide que
  // una consola con el mando tomado —comprometida, o con el temporizador roto—
  // le haga al hub un SELECT y un envío al celular por cada mensaje a la
  // velocidad del socket. El contrato manda 10 Hz y acá entra el doble.
  if (!hayCupo(cupo, Date.now())) return false;

  // La cuenta se revalida contra la BASE en cada mensaje, igual que hace
  // requireAuth con cada request: al operador al que le acaban de quitar
  // canControl, le bajaron el rol o le dieron de baja la cuenta no le sirve
  // tener el socket abierto de antes. Es también la última línea de defensa si
  // alguna vez un camino liberara el permiso sin liberar el lock.
  return cuentaQuePuedePilotear(sesion.username);
}

/**
 * Si la cuenta puede pilotear AHORA, leída de la base: activa, no eliminada,
 * con `canControl` y con rol de operador o más. La usan el mando en cada
 * mensaje y el traspaso de un pedido de control (control.ts), que no le pasa
 * el dron a quien perdió el permiso en los 10 s de la espera.
 */
function cuentaQuePuedePilotear(username: string): boolean {
  const cuenta = getActiveUser(username);
  if (!cuenta || !cuenta.can_control) return false;
  // El tipo `Role` de la fila es una promesa del esquema, no una garantía: la
  // columna `role` no tiene CHECK (db.ts: "validado en código") y las
  // migraciones copian el valor viejo tal cual. Si el rol no está en ROLE_RANK,
  // `undefined < 2` da false en JS y el mando SALDRÍA igual: el control falla
  // cerrado a propósito, que en un sistema de fuerzas de seguridad lo
  // desconocido no vuela.
  // Se exige NÚMERO, no "distinto de undefined": ROLE_RANK hereda
  // Object.prototype, así que un rol llamado `toString` o `constructor` devuelve
  // una función, y con ella `=== undefined` es false y `función < 2` también.
  const rango: unknown = ROLE_RANK[cuenta.role];
  return typeof rango === 'number' && rango >= ROLE_RANK.operator;
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

/**
 * Hasta cuánto hacia atrás se le reenvían a un dron que se (re)conecta las
 * decisiones de sus alertas (§2). Un corte de enlace en el campo dura segundos
 * o minutos: diez cubren el corte largo de verdad. Más atrás ya no sirve, porque
 * para entonces el dron dejó ese objetivo (por batería, por un regreso o porque
 * el operador reanudó la ruta) y la app descarta la decisión de una alerta que
 * no es la de su objetivo en curso.
 */
const VENTANA_DECISIONES_MS = 10 * 60 * 1000;

/**
 * Reenvía las decisiones recientes al dron que acaba de conectarse.
 * `sendToDrone` no encola: una alerta descartada mientras el dron estaba caído
 * se perdía, y el dron seguía orbitando el falso positivo. Mandarlas de nuevo
 * aunque ya le hubieran llegado no hace daño, porque la app aplica una decisión
 * solo si es la de la alerta del objetivo que sigue, y la misma decisión dos
 * veces deja todo igual.
 *
 * El único caso delicado lo abre el propio contrato (§2): la app también aplica
 * una decisión mientras todavía no conoce el id de su alerta (el `alert_ack` no
 * llegó). Si el dron se reconecta justo en ese hueco, una decisión vieja
 * reenviada acá le pegaría al objetivo nuevo. Por eso los reenvíos van marcados
 * con `resent: true`: la app aplica un reenvío solo si es EXACTAMENTE la alerta
 * que ella conoce, nunca por la excepción del id todavía desconocido.
 */
function reenviarDecisionesRecientes(droneId: string) {
  // Mismo formato que escribe decideAlert: la consulta compara texto (ver listDecisionsSince)
  const desde = new Date(Date.now() - VENTANA_DECISIONES_MS).toISOString();
  for (const d of listDecisionsSince(droneId, desde)) {
    sendToDrone(droneId, {
      type: 'alert_decision', alertId: d.id, decision: d.status, decidedBy: d.decided_by, resent: true,
    });
  }
}

/** Cada cuánto revisa el hub los plazos de los relevos (RELEVOS §7). */
const INTERVALO_BARRIDO_MS = 1000;

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: TOPE_FRAME_BYTES });

  // Arranque del hub: los relevos que quedaron activos en la tabla empiezan a
  // contar el plazo de sus B desde ahora, y el barrido de 1 s vence lo que
  // corresponda. `unref` para que el barrido no tenga vivo al proceso por sí
  // solo, y se corta con el servidor.
  relevos.iniciar();
  // El mismo barrido vence los pedidos de control y suelta a los titulares sin
  // señales de vida (control.ts): cada uno con su red, para que un error en
  // uno no le saque la vuelta al otro.
  const barrido = setInterval(() => {
    sinTumbarElHub('el barrido de relevos', () => relevos.barrer());
    sinTumbarElHub('el barrido del control manual', () => control.barrer());
  }, INTERVALO_BARRIDO_MS);
  barrido.unref();
  server.on('close', () => clearInterval(barrido));

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
      // El estado del control va antes que todo lo demás, y SIEMPRE: mientras
      // el dron estuvo desconectado el lock pudo cambiar (lo soltaron, pasó a
      // otro, el hub se reinició y los olvidó todos) sin que nadie pudiera
      // avisarle. Sin titular, `control_released` con `resync: true`: la app
      // que seguía en MANUAL con nadie al mando —que es justo donde no alerta
      // (PROTOCOLS §4)— lo suelta como si lo hubiera soltado el barrido, con el
      // mando de vuelta en el control físico, porque ese soltar tampoco lo
      // eligió nadie (el `motivo: 'inactividad'` que se perdió con el dron
      // desconectado, un reinicio del hub); a una sin el control tomado no le
      // hace nada. Con titular,
      // `control_taken` con `resync: true`, que la app NO toma como una toma
      // nueva: si ya lo tenía no frena ni le saca la ruta que el titular le
      // mandó sin soltarlo, y si no lo tenía contesta `control_dropped` y el hub
      // lo suelta (ver alSoltarseEnLaApp), en vez de que la app le saque el
      // mando a quien lo esté volando con el control físico.
      const titular = controlledBy.get(droneId);
      sendToDrone(
        droneId,
        titular
          ? { type: 'control_taken', by: titular, resync: true }
          : { type: 'control_released', by: 'Comando Central', resync: true },
      );
      reenviarDecisionesRecientes(droneId);
      // Las bases donde puede bajar (desvío, RELEVOS §4), y el primer status
      // que llegue decide qué relevo se le reenvía (PROTOCOLS §1.b, "Reconexión").
      enviarBases(droneId);
      relevos.alConectar(droneId);

      ws.on('message', (data) => sinTumbarElHub(`el dron ${droneId}`, () => handleDroneMessage(droneId, data.toString())));
      ws.on('close', () => {
        if (drones.get(droneId) === ws) {
          drones.delete(droneId);
          lastStatus.delete(droneId);
          // El lock NO se borra: sigue siendo de quien lo tenía, que sigue en la
          // consola dando señales de vida, y al volver el dron se le dice a la
          // app quién lo tiene (ver la conexión). Borrarlo acá, sin poder
          // avisarle a nadie, dejaba a la consola y a la app en desacuerdo.
          relevos.alDesconectar(droneId);
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
    // Mismo criterio que requireAuth: el token de antes de un cambio de rol ya
    // no abre la consola. Sin esto, la consola a la que el cambio le cerró el
    // socket se reconectaba sola a los 3 s con el mismo token y seguía adentro.
    if (esDeOtroRol(payload, cuenta.role)) {
      ws.close(4401, SESION_DE_OTRO_ROL);
      return;
    }
    // El rol sale de la base y no del token, como en requireAuth: el canal en
    // vivo tiene que filtrar con el rol que la cuenta tiene AHORA.
    const sesion: SesionConsola = {
      username: cuenta.username,
      role: cuenta.role,
      expiraEn: payload.exp ?? Number.POSITIVE_INFINITY,
      // Arranca con los baldes llenos: el operador que recién abre la consola
      // tiene que poder tomar el mando y volar sin esperar a que se le repongan
      // fichas.
      cupoDePalancas: baldeLleno(Date.now()),
      cupoDeCamara: baldeLleno(Date.now()),
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
      // El control NO se suelta acá: una pestaña que recarga o un corte de red
      // de dos segundos le sacaban el dron al que lo estaba volando. Lo suelta
      // el barrido si en 30 s no llega ninguna señal de vida de ninguna de sus
      // consolas (control.ts). Lo que sí se cancela en el acto, si era la última
      // consola de la cuenta, es lo que esperaba: no se le traspasa un dron a
      // quien ya no está mirando.
      const sigueConectado = [...operators.values()].some((s) => s.username === sesion.username);
      if (!sigueConectado) {
        control.cancelarPedidosDe(sesion.username, `${sesion.username} se desconectó del Comando Central`);
      }
    });
  });
}
