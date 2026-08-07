import { db } from './db';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'operator' | 'drone';
}

export interface PatrolRoute {
  id: number;
  name: string;
  description: string;
  waypoints: { lat: number; lon: number; alt: number }[];
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

export function getRoutes(): PatrolRoute[] {
  const rows = db.prepare('SELECT * FROM patrol_routes ORDER BY id').all() as {
    id: number; name: string; description: string; waypoints: string;
  }[];
  return rows.map((r) => ({ ...r, waypoints: JSON.parse(r.waypoints) }));
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

export function listEvents(limit = 200): EventRow[] {
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
