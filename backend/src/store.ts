import { randomBytes } from 'node:crypto';
import { db } from './db';

export type Role = 'drone' | 'field_operator' | 'operator' | 'supervisor' | 'admin';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  display_name: string | null;
  base_name: string | null;
  base_lat: number | null;
  base_lon: number | null;
  active: number;
  can_control: number;
  deleted_at: string | null;
  deleted_by: string | null;
}

/** Vista pública de un usuario humano (sin hash de contraseña). */
export interface UserView {
  username: string;
  role: Role;
  active: boolean;
  canControl: boolean;
  deletedAt: string | null;
}

export function toUserView(u: UserRow): UserView {
  return {
    username: u.username,
    role: u.role,
    active: !!u.active,
    canControl: !!u.can_control,
    deletedAt: u.deleted_at,
  };
}

/** Base a la que vuelve un dron; se dibuja como cuadrado azul en los mapas. */
export interface DroneBase {
  name: string;
  lat: number;
  lon: number;
}

/** Identidad persistente de un dron: lo que no cambia de una conexión a otra. */
export interface DroneIdentity {
  droneId: string;
  displayName: string;
  base: DroneBase | null;
}

/** Fila cruda de la tabla `drones`: el dron como activo del sistema. */
export interface DroneAsset {
  id: number;
  hash: string;
  display_name: string;
  model: string;
  active: number;
  base_name: string | null;
  base_lat: number | null;
  base_lon: number | null;
  created_at: string;
  created_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

/** Vista pública del activo: el `hash` ES el droneId de todo el protocolo. */
export interface DroneAssetView {
  hash: string;
  displayName: string;
  model: string;
  active: boolean;
  base: DroneBase | null;
  createdAt: string;
  createdBy: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
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

export type LogCategory = 'drone' | 'usuarios' | 'sistema';

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  source: string;
  message: string;
  drone_id: string | null;
  alert_id: number | null;
  category: LogCategory;
  meta: string | null;
}

// ---- Usuarios ----

/** Fila cruda, INCLUIDOS los borrados lógicamente (el login necesita distinguirlos). */
export function getUser(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

/** Solo el usuario que puede operar: ni desactivado ni borrado. */
export function getActiveUser(username: string): UserRow | undefined {
  return db
    .prepare('SELECT * FROM users WHERE username = ? AND active = 1 AND deleted_at IS NULL')
    .get(username) as UserRow | undefined;
}

/** Usuarios humanos de los roles pedidos. Los borrados solo salen si se piden. */
export function listUsers(roles: Role[], opts: { includeDeleted?: boolean } = {}): UserView[] {
  const marks = roles.map(() => '?').join(',');
  const filtroBorrados = opts.includeDeleted ? '' : ' AND deleted_at IS NULL';
  const rows = db
    .prepare(`SELECT * FROM users WHERE role IN (${marks})${filtroBorrados} ORDER BY role, username`)
    .all(...roles) as UserRow[];
  return rows.map(toUserView);
}

export function createUser(username: string, passwordHash: string, role: Role, canControl: boolean): UserView {
  db.prepare('INSERT INTO users (username, password_hash, role, can_control) VALUES (?, ?, ?, ?)').run(
    username,
    passwordHash,
    role,
    canControl ? 1 : 0,
  );
  return toUserView(getUser(username)!);
}

export interface UserPatch {
  active?: boolean;
  canControl?: boolean;
  passwordHash?: string;
}

/** Aplica el cambio y devuelve el antes y el después, para el log. */
export function updateUser(username: string, patch: UserPatch): { before: UserView; after: UserView } | undefined {
  const row = getUser(username);
  if (!row) return undefined;
  const before = toUserView(row);
  db.prepare(
    `UPDATE users SET
       active = COALESCE(?, active),
       can_control = COALESCE(?, can_control),
       password_hash = COALESCE(?, password_hash)
     WHERE username = ?`,
  ).run(
    patch.active === undefined ? null : patch.active ? 1 : 0,
    patch.canControl === undefined ? null : patch.canControl ? 1 : 0,
    patch.passwordHash ?? null,
    username,
  );
  return { before, after: toUserView(getUser(username)!) };
}

/**
 * Borrado lógico: la fila queda para que el historial siga teniendo sentido y
 * el username no se pueda reusar. Devuelve undefined si ya estaba borrado.
 */
export function softDeleteUser(username: string, deletedBy: string): { before: UserView; after: UserView } | undefined {
  const row = getUser(username);
  if (!row || row.deleted_at) return undefined;
  const before = toUserView(row);
  db.prepare('UPDATE users SET deleted_at = ?, deleted_by = ? WHERE username = ?').run(
    new Date().toISOString(),
    deletedBy,
    username,
  );
  return { before, after: toUserView(getUser(username)!) };
}

/** Deshace el borrado lógico. Devuelve undefined si el usuario no estaba borrado. */
export function restoreUser(username: string): { before: UserView; after: UserView } | undefined {
  const row = getUser(username);
  if (!row || !row.deleted_at) return undefined;
  const before = toUserView(row);
  db.prepare('UPDATE users SET deleted_at = NULL, deleted_by = NULL WHERE username = ?').run(username);
  return { before, after: toUserView(getUser(username)!) };
}

// ---- Drones como activos ----

function toDroneBase(d: { base_name: string | null; base_lat: number | null; base_lon: number | null }): DroneBase | null {
  return d.base_lat != null && d.base_lon != null
    ? { name: d.base_name ?? 'Base', lat: d.base_lat, lon: d.base_lon }
    : null;
}

export function toDroneAssetView(d: DroneAsset): DroneAssetView {
  return {
    hash: d.hash,
    displayName: d.display_name,
    model: d.model,
    active: !!d.active,
    base: toDroneBase(d),
    createdAt: d.created_at,
    createdBy: d.created_by,
    deletedAt: d.deleted_at,
    deletedBy: d.deleted_by,
  };
}

function toDroneIdentity(d: DroneAsset): DroneIdentity {
  return { droneId: d.hash, displayName: d.display_name, base: toDroneBase(d) };
}

export interface DroneInput {
  displayName: string;
  model?: string;
  base?: DroneBase | null;
}

/**
 * Da de alta el activo. El hash son 16 bytes al azar en hexa: es lo único que
 * viaja en el QR, así que tiene que ser imposible de adivinar.
 */
export function createDrone(input: DroneInput, createdBy: string): DroneAssetView {
  const hash = randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO drones (hash, display_name, model, base_name, base_lat, base_lon, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hash,
    input.displayName,
    input.model ?? '',
    input.base?.name ?? null,
    input.base?.lat ?? null,
    input.base?.lon ?? null,
    new Date().toISOString(),
    createdBy,
  );
  return getDrone(hash)!;
}

/** Busca por hash SIN filtrar borrados: quien llama decide si un 404 o un 410. */
export function getDrone(hash: string): DroneAssetView | undefined {
  const row = db.prepare('SELECT * FROM drones WHERE hash = ?').get(hash) as DroneAsset | undefined;
  return row ? toDroneAssetView(row) : undefined;
}

export function listDrones(opts: { includeDeleted?: boolean } = {}): DroneAssetView[] {
  const filtroBorrados = opts.includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  const rows = db
    .prepare(`SELECT * FROM drones ${filtroBorrados} ORDER BY display_name COLLATE NOCASE, id`)
    .all() as DroneAsset[];
  return rows.map(toDroneAssetView);
}

export interface DronePatch {
  displayName?: string;
  model?: string;
  active?: boolean;
  /** `null` borra la base; `undefined` la deja como está. */
  base?: DroneBase | null;
}

/** Aplica el cambio sobre un dron vivo y devuelve el antes y el después, para el log. */
export function updateDrone(hash: string, patch: DronePatch): { before: DroneAssetView; after: DroneAssetView } | undefined {
  const before = getDrone(hash);
  if (!before || before.deletedAt) return undefined;

  db.prepare(
    `UPDATE drones SET
       display_name = COALESCE(?, display_name),
       model = COALESCE(?, model),
       active = COALESCE(?, active)
     WHERE hash = ?`,
  ).run(
    patch.displayName ?? null,
    patch.model ?? null,
    patch.active === undefined ? null : patch.active ? 1 : 0,
    hash,
  );

  // La base va aparte porque COALESCE no distingue "no la toques" de "borrala".
  if (patch.base !== undefined) {
    db.prepare('UPDATE drones SET base_name = ?, base_lat = ?, base_lon = ? WHERE hash = ?').run(
      patch.base?.name ?? null,
      patch.base?.lat ?? null,
      patch.base?.lon ?? null,
      hash,
    );
  }

  return { before, after: getDrone(hash)! };
}

/** Borrado lógico: el historial sigue apuntando al hash. Undefined si ya estaba borrado. */
export function softDeleteDrone(hash: string, deletedBy: string): DroneAssetView | undefined {
  const info = db
    .prepare('UPDATE drones SET deleted_at = ?, deleted_by = ? WHERE hash = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), deletedBy, hash);
  if (info.changes === 0) return undefined;
  return getDrone(hash);
}

/** Deshace el borrado lógico. Undefined si el dron no existe o no estaba borrado. */
export function restoreDrone(hash: string): DroneAssetView | undefined {
  const info = db
    .prepare('UPDATE drones SET deleted_at = NULL, deleted_by = NULL WHERE hash = ? AND deleted_at IS NOT NULL')
    .run(hash);
  if (info.changes === 0) return undefined;
  return getDrone(hash);
}

/**
 * Identidad del dron para el protocolo. Los borrados no existen para nadie; los
 * inactivos sí, porque la consola tiene que poder mostrarlos y reactivarlos.
 */
export function getDroneIdentity(droneId: string): DroneIdentity | undefined {
  const row = db.prepare('SELECT * FROM drones WHERE hash = ? AND deleted_at IS NULL').get(droneId) as
    | DroneAsset
    | undefined;
  return row ? toDroneIdentity(row) : undefined;
}

export function listDroneIdentities(): DroneIdentity[] {
  const rows = db
    .prepare('SELECT * FROM drones WHERE deleted_at IS NULL ORDER BY display_name COLLATE NOCASE, id')
    .all() as DroneAsset[];
  return rows.map(toDroneIdentity);
}

/** Renombra un dron. Devuelve la identidad ya actualizada, o undefined si no existe. */
export function renameDrone(droneId: string, displayName: string): DroneIdentity | undefined {
  const info = db
    .prepare('UPDATE drones SET display_name = ? WHERE hash = ? AND deleted_at IS NULL')
    .run(displayName, droneId);
  if (info.changes === 0) return undefined;
  return getDroneIdentity(droneId);
}

// ---- Rutas de patrullaje ----

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

// ---- Registro ----

/**
 * Registro central del sistema: TODA acción pasa por acá. `category` separa el
 * log de drones del de usuarios/sistema; `meta` guarda detalles estructurados
 * (p. ej. el antes y el después de un cambio de usuario).
 */
export function createLog(
  category: LogCategory,
  type: string,
  source: string,
  message: string,
  opts: { droneId?: string | null; alertId?: number | null; meta?: object } = {},
): EventRow {
  const ts = new Date().toISOString();
  const meta = opts.meta ? JSON.stringify(opts.meta) : null;
  const info = db
    .prepare('INSERT INTO events (ts, type, source, message, drone_id, alert_id, category, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ts, type, source, message, opts.droneId ?? null, opts.alertId ?? null, category, meta);
  return {
    id: Number(info.lastInsertRowid),
    ts,
    type,
    source,
    message,
    drone_id: opts.droneId ?? null,
    alert_id: opts.alertId ?? null,
    category,
    meta,
  };
}

export function createEvent(
  type: string,
  source: string,
  message: string,
  droneId: string | null = null,
  alertId: number | null = null,
): EventRow {
  return createLog('drone', type, source, message, { droneId, alertId });
}

/** Log de drones: lo que ven los operadores. */
export function listEvents(limit = 200, droneId?: string): EventRow[] {
  if (droneId) {
    return db
      .prepare("SELECT * FROM events WHERE category = 'drone' AND drone_id = ? ORDER BY id DESC LIMIT ?")
      .all(droneId, limit) as EventRow[];
  }
  return db.prepare("SELECT * FROM events WHERE category = 'drone' ORDER BY id DESC LIMIT ?").all(limit) as EventRow[];
}

/** Tamaños de página que ofrece la consola; cualquier otro cae al primero. */
export const TAMANIOS_PAGINA = [25, 50, 75, 100] as const;

export interface LogQuery {
  category?: LogCategory;
  droneId?: string;
  /** Texto libre: busca en mensaje, tipo y origen. */
  q?: string;
  page: number;
  pageSize: number;
}

export interface LogPage {
  items: EventRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Log general del sistema, para el admin. El filtro y el conteo se resuelven en
 * SQL (dos consultas: una de COUNT y una con LIMIT/OFFSET) porque la tabla
 * crece sin techo y traerla entera a memoria para paginarla no escala.
 */
export function listLogs(query: LogQuery): LogPage {
  const pageSize = (TAMANIOS_PAGINA as readonly number[]).includes(query.pageSize)
    ? query.pageSize
    : TAMANIOS_PAGINA[0];
  const page = Number.isFinite(query.page) && query.page >= 1 ? Math.floor(query.page) : 1;

  const condiciones: string[] = [];
  const params: (string | number)[] = [];

  if (query.category) {
    condiciones.push('category = ?');
    params.push(query.category);
  }
  if (query.droneId) {
    condiciones.push('drone_id = ?');
    params.push(query.droneId);
  }
  if (query.q) {
    // Los comodines que escriba el usuario se escapan: buscar "100%" no puede
    // convertirse en un LIKE que matchee cualquier cosa.
    const patron = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    condiciones.push(`(message LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')`);
    params.push(patron, patron, patron);
  }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).get(...params) as { n: number }).n;
  const items = db
    .prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as EventRow[];

  return { items, total, page, pageSize };
}

// ---- Alertas ----

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
