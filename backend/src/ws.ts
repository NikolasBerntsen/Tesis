import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from './auth';
import { createAlert, createEvent } from './store';

// Hub central: los operadores (web) reciben todo lo que emite el dron (celular),
// y el celular recibe las decisiones del operador.
const operators = new Set<WebSocket>();
const drones = new Set<WebSocket>();
let lastStatus: Record<string, unknown> | null = null;

export function broadcastOperators(msg: object) {
  const data = JSON.stringify(msg);
  for (const ws of operators) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

export function sendToDrones(msg: object) {
  const data = JSON.stringify(msg);
  for (const ws of drones) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function handleDroneMessage(droneId: string, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'status':
      lastStatus = { ...msg, droneId };
      broadcastOperators(lastStatus!);
      break;
    case 'video_frame':
      broadcastOperators({ type: 'video_frame', jpegBase64: msg.jpegBase64, ts: msg.ts, droneId });
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
        `Alerta de ${alertType === 'PERSON' ? 'PERSONA' : 'VEHÍCULO'} generada por ${droneId}`,
        droneId,
        alert.id,
      );
      broadcastOperators({ type: 'alert_created', alert });
      broadcastOperators({ type: 'event', event: ev });
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
      drones.add(ws);
      const ev = createEvent('DRONE_CONNECTED', 'backend', `${payload.sub} conectado al Comando Central`, payload.sub);
      broadcastOperators({ type: 'event', event: ev });
      ws.on('message', (data) => handleDroneMessage(payload.sub, data.toString()));
      ws.on('close', () => {
        drones.delete(ws);
        const evc = createEvent('DRONE_DISCONNECTED', 'backend', `${payload.sub} desconectado del Comando Central`, payload.sub);
        broadcastOperators({ type: 'event', event: evc });
      });
    } else {
      operators.add(ws);
      if (lastStatus) ws.send(JSON.stringify(lastStatus));
      ws.on('close', () => operators.delete(ws));
    }
  });
}
