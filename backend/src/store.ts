import { db } from './db';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'operator' | 'drone';
  display_name: string | null;
  base_name: string | null;
  base_lat: number | null;
  base_lon: number | null;
}

/** Identidad persistente de un dron: lo que no cambia de una conexión a otra. */
export interface DroneIdentity {
  droneId: string;
  displayName: string;
  base: { name: string; lat: number; lon: number } | null;
}

/** `label` es el apodo opcional del nodo, para identificar zonas puntuales. */
export interface Waypoint {
  lat: number;
  lon: number;
  alt: number;
  label?: string;
}

export interface PatrolRoute {
  id: number;
  name: string;
  description: string;
  waypoints: Waypoint[];
}

export interface Alert {
  id: number;
  created_at: string;
  type: 'PERSON' | 'VEHICLE';
  status: 'PENDING' | 'VALIDATED' | 'DISMISSED';
  drone_id: string | null;
  lat: number | null;
  lon: number | null;
  snapshot: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  source: string;
  message: string;
  drone_id: string | null;
  alert_id: number | null;
}

export function getUser(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

function toDroneIdentity(u: UserRow): DroneIdentity {
  return {
    droneId: u.username,
    displayName: u.display_name ?? u.username,
    base:
      u.base_lat != null && u.base_lon != null
        ? { name: u.base_name ?? 'Base', lat: u.base_lat, lon: u.base_lon }
        : null,
  };
}

export function getDroneIdentity(droneId: string): DroneIdentity | undefined {
  const u = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'drone'").get(droneId) as UserRow | undefined;
  return u ? toDroneIdentity(u) : undefined;
}

export function listDroneIdentities(): DroneIdentity[] {
  const rows = db.prepare("SELECT * FROM users WHERE role = 'drone' ORDER BY username").all() as UserRow[];
  return rows.map(toDroneIdentity);
}

/** Renombra un dron. Devuelve la identidad ya actualizada, o undefined si no existe. */
export function renameDrone(droneId: string, displayName: string): DroneIdentity | undefined {
  const info = db
    .prepare("UPDATE users SET display_name = ? WHERE username = ? AND role = 'drone'")
    .run(displayName, droneId);
  if (info.changes === 0) return undefined;
  return getDroneIdentity(droneId);
}

export function getRoutes(): PatrolRoute[] {
  const rows = db.prepare('SELECT * FROM patrol_routes ORDER BY id').all() as {
    id: number; name: string; description: string; waypoints: string;
  }[];
  return rows.map((r) => ({ ...r, waypoints: JSON.parse(r.waypoints) }));
}

export function getRoute(id: number): PatrolRoute | undefined {
  const r = db.prepare('SELECT * FROM patrol_routes WHERE id = ?').get(id) as
    | { id: number; name: string; description: string; waypoints: string }
    | undefined;
  return r ? { ...r, waypoints: JSON.parse(r.waypoints) } : undefined;
}

/** Pone (o borra, con label vacío) el apodo de un nodo de la ruta. */
export function setWaypointLabel(routeId: number, index: number, label: string): PatrolRoute | undefined {
  const route = getRoute(routeId);
  if (!route) return undefined;
  const wp = route.waypoints[index];
  if (!wp) return undefined;

  if (label) wp.label = label;
  else delete wp.label;

  db.prepare('UPDATE patrol_routes SET waypoints = ? WHERE id = ?').run(JSON.stringify(route.waypoints), routeId);
  return route;
}

export function createEvent(
  type: string,
  source: string,
  message: string,
  droneId: string | null = null,
  alertId: number | null = null,
): EventRow {
  const ts = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO events (ts, type, source, message, drone_id, alert_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ts, type, source, message, droneId, alertId);
  return { id: Number(info.lastInsertRowid), ts, type, source, message, drone_id: droneId, alert_id: alertId };
}

export function listEvents(limit = 200, droneId?: string): EventRow[] {
  if (droneId) {
    return db
      .prepare('SELECT * FROM events WHERE drone_id = ? ORDER BY id DESC LIMIT ?')
      .all(droneId, limit) as EventRow[];
  }
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as EventRow[];
}

export function createAlert(
  type: 'PERSON' | 'VEHICLE',
  droneId: string | null,
  lat: number | null,
  lon: number | null,
  snapshot: string | null,
): Alert {
  const createdAt = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO alerts (created_at, type, drone_id, lat, lon, snapshot) VALUES (?, ?, ?, ?, ?, ?)')
    .run(createdAt, type, droneId, lat, lon, snapshot);
  return getAlert(Number(info.lastInsertRowid))!;
}

export function getAlert(id: number): Alert | undefined {
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as Alert | undefined;
}

export function listAlerts(status?: string): Alert[] {
  if (status) {
    return db.prepare('SELECT * FROM alerts WHERE status = ? ORDER BY id DESC LIMIT 100').all(status) as Alert[];
  }
  return db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 100').all() as Alert[];
}

/** Aplica la decisión del operador solo si la alerta sigue pendiente. */
export function decideAlert(
  id: number,
  decision: 'VALIDATED' | 'DISMISSED',
  decidedBy: string,
): Alert | undefined {
  const result = db
    .prepare("UPDATE alerts SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'")
    .run(decision, decidedBy, new Date().toISOString(), id);
  if (result.changes === 0) return undefined;
  return getAlert(id);
}
