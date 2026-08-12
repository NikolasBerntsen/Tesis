import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from './auth';
import {
  createAlert, createLog, getActiveUser, getDrone, getDroneIdentity, listDrones, renameDrone,
  type DroneAssetView, type DroneBase,
} from './store';

// Hub central. Soporta varios drones a la vez: cada conexión de dron se guarda
// bajo su droneId (el hash del token de emparejamiento), y los mensajes del
// operador se dirigen al dron concreto en vez de a todos.
const operators = new Map<WebSocket, string>(); // socket -> username
const drones = new Map<string, WebSocket>();
const lastStatus = new Map<string, Record<string, unknown>>();

// Control manual: un solo usuario por dron a la vez
const controlledBy = new Map<string, string>(); // droneId -> username

export function broadcastOperators(msg: object) {
  const data = JSON.stringify(msg);
  for (const ws of operators.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
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

/** Ficha completa de un dron: identidad + activo + online + estado + control. */
export interface DroneCard {
  /** El hash del QR. `droneId` es exactamente el mismo valor: así lo llama el protocolo. */
  hash: string;
  droneId: string;
  displayName: string;
  model: string;
  active: boolean;
  deletedAt: string | null;
  base: DroneBase | null;
  online: boolean;
  lastStatus: Record<string, unknown> | null;
  controlledBy: string | null;
}

function cardDesdeActivo(d: DroneAssetView): DroneCard {
  return {
    hash: d.hash,
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

function handleDroneMessage(droneId: string, raw: string) {
  let msg: MensajeDron;
  try {
    msg = JSON.parse(raw) as MensajeDron;
  } catch {
    return;
  }
  const displayName = getDroneIdentity(droneId)?.displayName ?? droneId;

  switch (msg.type) {
    case 'status': {
      const status: Record<string, unknown> = {
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

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
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

      ws.on('message', (data) => handleDroneMessage(droneId, data.toString()));
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

    if (!getActiveUser(payload.sub)) {
      ws.close(4403, 'Cuenta desactivada o eliminada');
      return;
    }
    operators.set(ws, payload.sub);
    // Estado inicial: el operador pinta el dashboard sin esperar al próximo tick
    for (const status of lastStatus.values()) ws.send(JSON.stringify(status));
    ws.on('close', () => {
      operators.delete(ws);
      // Si era la última conexión de ese usuario, no puede seguir controlando
      const sigueConectado = [...operators.values()].includes(payload.sub);
      if (!sigueConectado) {
        releaseAllControlledBy(payload.sub, payload.sub, 'el usuario se desconectó del Comando Central');
      }
    });
  });
}
