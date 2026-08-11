import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from './auth';
import { createAlert, createEvent, createLog, getDroneIdentity, getUser, listDroneIdentities, renameDrone } from './store';

// Hub central. Soporta varios drones a la vez: cada conexión de dron se guarda
// bajo su droneId (el username del token), y los mensajes del operador se
// dirigen al dron concreto en vez de a todos.
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

/** Ficha completa de un dron: identidad + online + último estado + control. */
export function droneCard(droneId: string) {
  const identity = getDroneIdentity(droneId);
  if (!identity) return null;
  return {
    ...identity,
    online: isOnline(droneId),
    lastStatus: getLastStatus(droneId),
    controlledBy: getController(droneId),
  };
}

export function listDroneCards() {
  return listDroneIdentities().map((d) => droneCard(d.droneId)!);
}

/** Aplica un renombre y avisa a los dos lados: operadores y el propio dron. */
export function applyRename(droneId: string, displayName: string, notifyDrone: boolean) {
  const identity = renameDrone(droneId, displayName);
  if (!identity) return undefined;
  broadcastOperators({ type: 'drone_renamed', droneId, displayName: identity.displayName });
  if (notifyDrone) sendToDrone(droneId, { type: 'renamed', displayName: identity.displayName });
  return identity;
}

// ---- Control manual exclusivo ----

export function takeControl(droneId: string, username: string): { ok: true } | { ok: false; heldBy: string } {
  const holder = controlledBy.get(droneId);
  if (holder && holder !== username) return { ok: false, heldBy: holder };
  controlledBy.set(droneId, username);
  sendToDrone(droneId, { type: 'control_taken', by: username });
  broadcastOperators({ type: 'control_changed', droneId, controlledBy: username });
  const ev = createEvent('CONTROL_TAKEN', username, `${username} tomó el control manual del dron ${droneId}`, droneId);
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
  const ev = createEvent('CONTROL_RELEASED', byUser, `Control manual del dron ${droneId} liberado${detalle}${motivo}`, droneId);
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

function handleDroneMessage(droneId: string, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const displayName = getDroneIdentity(droneId)?.displayName ?? droneId;

  switch (msg.type) {
    case 'status': {
      const status = { ...msg, type: 'status', droneId, displayName, controlledBy: getController(droneId) };
      lastStatus.set(droneId, status);
      broadcastOperators(status);
      break;
    }
    case 'video_frame':
      broadcastOperators({ type: 'video_frame', droneId, jpegBase64: msg.jpegBase64, ts: msg.ts });
      break;
    case 'event': {
      const ev = createEvent(String(msg.eventType), droneId, String(msg.message ?? ''), droneId);
      broadcastOperators({ type: 'event', event: ev });
      break;
    }
    case 'alert_request': {
      const alertType = msg.alertType === 'VEHICLE' ? 'VEHICLE' : 'PERSON';
      const alert = createAlert(alertType, droneId, msg.lat ?? null, msg.lon ?? null, msg.snapshotBase64 ?? null);
      const ev = createEvent(
        'ALERT_CREATED',
        droneId,
        `Alerta de ${alertType === 'PERSON' ? 'PERSONA' : 'VEHÍCULO'} generada por ${displayName}`,
        droneId,
        alert.id,
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
          meta: { antes, despues: name },
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
    const user = getUser(payload.sub);
    if (!user || !user.active) {
      ws.close(4403, 'Cuenta desactivada');
      return;
    }

    if (user.role === 'drone') {
      const droneId = payload.sub;
      // Una sola conexión por dron: si reconecta, la anterior se descarta
      drones.get(droneId)?.close(4000, 'Reemplazada por una conexión nueva');
      drones.set(droneId, ws);

      const name = getDroneIdentity(droneId)?.displayName ?? droneId;
      const ev = createEvent('DRONE_CONNECTED', 'backend', `${name} conectado al Comando Central`, droneId);
      broadcastOperators({ type: 'event', event: ev });
      broadcastOperators({ type: 'drone_online', drone: droneCard(droneId) });

      ws.on('message', (data) => handleDroneMessage(droneId, data.toString()));
      ws.on('close', () => {
        if (drones.get(droneId) === ws) {
          drones.delete(droneId);
          lastStatus.delete(droneId);
          controlledBy.delete(droneId);
          const evc = createEvent('DRONE_DISCONNECTED', 'backend', `${name} desconectado del Comando Central`, droneId);
          broadcastOperators({ type: 'event', event: evc });
          broadcastOperators({ type: 'drone_offline', drone: droneCard(droneId) });
        }
      });
    } else {
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
    }
  });
}
