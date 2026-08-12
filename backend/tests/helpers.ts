import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { db } from '../src/db';
import { createServer } from '../src/app';
import { signDroneToken } from '../src/auth';
import { config } from '../src/config';
import type { Role } from '../src/store';
import type { DroneCard } from '../src/ws';

// Costo bajo de bcrypt: los tests crean/validan muchos usuarios y no necesitan
// el endurecimiento de producción (compareSync funciona con cualquier costo).
const HASH_COST = 4;

/** Contraseñas de los usuarios sembrados, para reusarlas en los tests. */
export const CREDS = {
  campo: 'campo123',
  operador: 'operador123',
  supervisor: 'supervisor123',
  admin: 'admin123',
};

/**
 * Hash determinista solo para la semilla de los tests: así un test puede
 * referirse al dron "Alfa" por una constante en vez de tener que leerlo de la
 * base. Los drones reales se dan de alta con randomBytes.
 */
function hashDeTest(semilla: string): string {
  return createHash('sha256').update(`tesis-test:${semilla}`).digest('hex').slice(0, 32);
}

/** El hash ES el droneId de todo el protocolo, y lo único que viaja en el QR. */
export const DRON = {
  alfa: hashDeTest('alfa'),
  bravo: hashDeTest('bravo'),
  charlie: hashDeTest('charlie'),
};

/**
 * Siembra los usuarios, los drones y las rutas de demostración en la base
 * efímera del archivo de test actual. Replica lo esencial de src/seed.ts sin
 * sus console.log.
 */
export function seed() {
  const humanos: [string, string, Role][] = [
    ['campo', CREDS.campo, 'field_operator'],
    ['operador', CREDS.operador, 'operator'],
    ['supervisor', CREDS.supervisor, 'supervisor'],
    ['admin', CREDS.admin, 'admin'],
  ];
  for (const [username, password, role] of humanos) {
    db.prepare('INSERT INTO users (username, password_hash, role, can_control) VALUES (?, ?, ?, ?)').run(
      username,
      bcrypt.hashSync(password, HASH_COST),
      role,
      // El operador de campo despliega drones, no los pilotea
      role === 'field_operator' ? 0 : 1,
    );
  }

  const drones = [
    { hash: DRON.alfa, displayName: 'Alfa', model: 'DJI Mini 3', base: { name: 'Base Norte', lat: -34.8565, lon: -56.2075 } },
    { hash: DRON.bravo, displayName: 'Bravo', model: 'DJI Mini 3', base: { name: 'Base Sur', lat: -34.86, lon: -56.205 } },
    { hash: DRON.charlie, displayName: 'Charlie', model: 'DJI Air 3', base: { name: 'Base Este', lat: -34.8575, lon: -56.201 } },
  ];
  for (const d of drones) {
    db.prepare(
      `INSERT INTO drones (hash, display_name, model, base_name, base_lat, base_lon, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'semilla')`,
    ).run(d.hash, d.displayName, d.model, d.base.name, d.base.lat, d.base.lon, new Date().toISOString());
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

/** Vacía todas las tablas para volver a sembrar desde cero dentro de un archivo. */
export function limpiarBase() {
  db.exec(
    'DELETE FROM events; DELETE FROM alerts; DELETE FROM patrol_routes; DELETE FROM drones; DELETE FROM users; DELETE FROM sqlite_sequence;',
  );
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

export interface EntradaDron {
  displayName: string;
  model?: string;
  base?: { name: string; lat: number; lon: number } | null;
}

/** Da de alta un dron por la API y devuelve su ficha, con el hash del QR. */
export async function crearDron(base: string, token: string, input: EntradaDron): Promise<DroneCard> {
  const r = await api(base, '/api/drones', token, { method: 'POST', body: JSON.stringify(input) });
  if (r.status !== 201) throw new Error(`no se pudo dar de alta el dron: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as DroneCard;
}

/** Emparejamiento por QR: devuelve el token de máquina que recibe el celular. */
export async function emparejar(base: string, token: string, hash: string): Promise<string> {
  const r = await api(base, '/api/drones/pair', token, { method: 'POST', body: JSON.stringify({ hash }) });
  if (r.status !== 200) throw new Error(`no se pudo emparejar: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token as string;
}

/**
 * Atajo para los tests que no ejercitan el emparejamiento: firma el mismo token
 * que devolvería `/api/drones/pair` sin pasar por la API.
 */
export function tokenDeDron(hash: string): string {
  return signDroneToken(hash);
}

/**
 * Token humano con el vencimiento que pida el test: sirve para ejercitar qué
 * pasa con una sesión que caduca con el socket ya abierto. Sin `expiresIn` se
 * firma sin vencimiento, que es el otro caso que jwt.verify acepta.
 */
export function tokenHumano(username: string, role: Role, expiresIn?: number): string {
  const opciones = (expiresIn === undefined ? {} : { expiresIn }) as jwt.SignOptions;
  return jwt.sign({ sub: username, role }, config.jwtSecret, opciones);
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

/** Código con que el servidor cierra un WS (p. ej. 4401 por token inválido). */
export function wsCloseCode(wsUrl: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?token=${token}`);
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {
      /* el close llega igual */
    });
    setTimeout(() => reject(new Error('el WebSocket no cerró a tiempo')), 3000);
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
