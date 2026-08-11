import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from './auth';
import { createAlert, createEvent, getDroneIdentity, listDroneIdentities, renameDrone } from './store';

// Hub central. Soporta varios drones a la vez: cada conexión de dron se guarda
// bajo su droneId (el username del token), y los mensajes del operador se
// dirigen al dron concreto en vez de a todos.
const operators = new Set<WebSocket>();
const drones = new Map<string, WebSocket>();
const lastStatus = new Map<string, Record<string, unknown>>();

export function broadcastOperators(msg: object) {
  const data = JSON.stringify(msg);
  for (const ws of operators) if (ws.readyState === WebSocket.OPEN) ws.send(data);
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

/** Ficha completa de un dron: identidad + si está online + su último estado. */
export function droneCard(droneId: string) {
  const identity = getDroneIdentity(droneId);
  if (!identity) return null;
  return { ...identity, online: isOnline(droneId), lastStatus: getLastStatus(droneId) };
}

export function listDroneCards() {
  return listDroneIdentities().map((d) => ({
    ...d,
    online: isOnline(d.droneId),
    lastStatus: getLastStatus(d.droneId),
  }));
}

/** Aplica un renombre y avisa a los dos lados: operadores y el propio dron. */
export function applyRename(droneId: string, displayName: string, notifyDrone: boolean) {
  const identity = renameDrone(droneId, displayName);
  if (!identity) return undefined;
  broadcastOperators({ type: 'drone_renamed', droneId, displayName: identity.displayName });
  if (notifyDrone) sendToDrone(droneId, { type: 'renamed', displayName: identity.displayName });
  return identity;
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
      const status = { ...msg, type: 'status', droneId, displayName };
      lastStatus.set(droneId, status);
      broadcastOperators(status);
      break;
    }
    case 'video_frame':
      broadcastOperators({ type: 'video_frame', droneId, jpegBase64: msg.jpegBase64, ts: msg.ts });
      break;
    case 'event': {
      const ev = createEvent(String(msg.eventType), 'drone', String(msg.message ?? ''), droneId);
      broadcastOperators({ type: 'event', event: ev });
      break;
    }
    case 'alert_request': {
      const alertType = msg.alertType === 'VEHICLE' ? 'VEHICLE' : 'PERSON';
      const alert = createAlert(alertType, droneId, msg.lat ?? null, msg.lon ?? null, msg.snapshotBase64 ?? null);
      const ev = createEvent(
        'ALERT_CREATED',
        'drone',
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
      const identity = applyRename(droneId, name, false);
      if (identity) {
        const ev = createEvent('DRONE_RENAMED', 'drone', `El dron ${droneId} pasó a llamarse "${name}"`, droneId);
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

    if (payload.role === 'drone') {
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
          const evc = createEvent('DRONE_DISCONNECTED', 'backend', `${name} desconectado del Comando Central`, droneId);
          broadcastOperators({ type: 'event', event: evc });
          broadcastOperators({ type: 'drone_offline', drone: droneCard(droneId) });
        }
      });
    } else {
      operators.add(ws);
      // Estado inicial: el operador pinta el dashboard sin esperar al próximo tick
      for (const status of lastStatus.values()) ws.send(JSON.stringify(status));
      ws.on('close', () => operators.delete(ws));
    }
  });
}
