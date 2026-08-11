import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { WebSocket } from 'ws';
import { db } from '../src/db';
import { createServer } from '../src/app';

// Costo bajo de bcrypt: los tests crean/validan muchos usuarios y no necesitan
// el endurecimiento de producción (compareSync funciona con cualquier costo).
const HASH_COST = 4;

/** Contraseñas de los usuarios sembrados, para reusarlas en los tests. */
export const CREDS = {
  operador: 'operador123',
  supervisor: 'supervisor123',
  admin: 'admin123',
  drone1: 'drone123',
  drone2: 'drone123',
  drone3: 'drone123',
};

/**
 * Siembra los usuarios y rutas de demostración en la base efímera del archivo
 * de test actual. Replica lo esencial de src/seed.ts sin sus console.log.
 */
export function seed() {
  const humans: [string, string, string][] = [
    ['operador', CREDS.operador, 'operator'],
    ['supervisor', CREDS.supervisor, 'supervisor'],
    ['admin', CREDS.admin, 'admin'],
  ];
  for (const [username, password, role] of humans) {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      username,
      bcrypt.hashSync(password, HASH_COST),
      role,
    );
  }

  const drones = [
    { username: 'drone1', displayName: 'Alfa', base: { name: 'Base Norte', lat: -34.8565, lon: -56.2075 } },
    { username: 'drone2', displayName: 'Bravo', base: { name: 'Base Sur', lat: -34.86, lon: -56.205 } },
    { username: 'drone3', displayName: 'Charlie', base: { name: 'Base Este', lat: -34.8575, lon: -56.201 } },
  ];
  for (const d of drones) {
    db.prepare(
      `INSERT INTO users (username, password_hash, role, display_name, base_name, base_lat, base_lon)
       VALUES (?, ?, 'drone', ?, ?, ?, ?)`,
    ).run(d.username, bcrypt.hashSync(CREDS.drone1, HASH_COST), d.displayName, d.base.name, d.base.lat, d.base.lon);
  }

  const routes = [
    {
      name: 'Perímetro Norte',
      description: 'Rectángulo sobre el sector norte',
      waypoints: [
        { lat: -34.856, lon: -56.207, alt: 40 },
        { lat: -34.8532, lon: -56.207, alt: 40 },
        { lat: -34.8532, lon: -56.2036, alt: 40 },
        { lat: -34.856, lon: -56.2036, alt: 40 },
      ],
    },
    {
      name: 'Perímetro Sur',
      description: 'Rectángulo sobre el sector sur',
      waypoints: [
        { lat: -34.8588, lon: -56.207, alt: 40 },
        { lat: -34.8588, lon: -56.2038, alt: 40 },
        { lat: -34.861, lon: -56.2038, alt: 40 },
        { lat: -34.861, lon: -56.207, alt: 40 },
      ],
    },
    {
      name: 'Acceso Este',
      description: 'Camino de acceso',
      waypoints: [
        { lat: -34.8575, lon: -56.2015, alt: 45 },
        { lat: -34.8548, lon: -56.2015, alt: 45 },
        { lat: -34.8548, lon: -56.1985, alt: 45 },
        { lat: -34.8575, lon: -56.1985, alt: 45 },
        { lat: -34.859, lon: -56.2, alt: 45 },
      ],
    },
  ];
  for (const r of routes) {
    db.prepare('INSERT INTO patrol_routes (name, description, waypoints) VALUES (?, ?, ?)').run(
      r.name,
      r.description,
      JSON.stringify(r.waypoints),
    );
  }
}

export interface TestServer {
  server: Server;
  base: string;
  wsUrl: string;
  close: () => Promise<void>;
}

/** Levanta el servidor HTTP+WS en un puerto efímero (0) y devuelve sus URLs. */
export function startServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/** Inicia sesión y devuelve el token, o null si falla. */
export async function login(base: string, username: string, password: string): Promise<string | null> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return r.ok ? (await r.json()).token : null;
}

export interface ApiResult {
  status: number;
  body: any;
}

/** Hace una request autenticada a /api y devuelve status + body parseado. */
export async function api(
  base: string,
  path: string,
  token: string | null,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${path.startsWith('/api') ? path : `/api${path}`}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export interface WsClient {
  ws: WebSocket;
  got: any[];
  waitFor: (pred: (m: any) => boolean, timeout?: number) => Promise<any>;
  close: () => Promise<void>;
}

/** Abre un WebSocket cliente, acumula los mensajes recibidos y resuelve al abrir. */
export function connectWs(wsUrl: string, token: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?token=${token}`);
    const got: any[] = [];
    ws.on('message', (d) => {
      try {
        got.push(JSON.parse(d.toString()));
      } catch {
        /* ignora frames no-JSON */
      }
    });
    ws.on('open', () =>
      resolve({
        ws,
        got,
        waitFor: (pred, timeout = 3000) => waitFor(got, pred, timeout),
        close: () =>
          new Promise<void>((res) => {
            if (ws.readyState === WebSocket.CLOSED) return res();
            ws.once('close', () => res());
            ws.close();
          }),
      }),
    );
    ws.on('error', reject);
  });
}

/** Resuelve cuando aparece en `got` un mensaje que cumple el predicado. */
export function waitFor(got: any[], pred: (m: any) => boolean, timeout = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const found = got.find(pred);
      if (found) return resolve(found);
      if (Date.now() - start > timeout) return reject(new Error('timeout esperando un mensaje del WebSocket'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mensaje `status` de dron con los campos del contrato. */
export function mkStatus(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'status',
    state: 'PATROLLING',
    battery: 90,
    lat: -34.855,
    lon: -56.206,
    routeId: 1,
    waypointIndex: 2,
    waypointTotal: 4,
    signal: 'OK',
    signalPct: 72,
    heading: 120,
    mode: 'TEST',
    ...over,
  });
}
