import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    -- 'field_operator' | 'operator' | 'supervisor' | 'admin' (validado en código)
    role          TEXT NOT NULL,
    display_name  TEXT,
    base_name     TEXT,
    base_lat      REAL,
    base_lon      REAL,
    active        INTEGER NOT NULL DEFAULT 1,
    can_control   INTEGER NOT NULL DEFAULT 1,
    -- Borrado lógico: la fila queda y por lo tanto el username SIGUE OCUPADO
    -- (el UNIQUE se mantiene a propósito: el historial referencia ese nombre).
    deleted_at    TEXT,
    deleted_by    TEXT
  );

  -- Los drones son activos del sistema, no cuentas de usuario. El hash es el
  -- identificador del QR y el droneId de todo el protocolo (WS, API, events,
  -- alerts); nunca se muestra entero en la interfaz.
  CREATE TABLE IF NOT EXISTS drones (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    hash         TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    model        TEXT NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1,
    base_name    TEXT,
    base_lat     REAL,
    base_lon     REAL,
    created_at   TEXT NOT NULL,
    created_by   TEXT,
    deleted_at   TEXT,
    deleted_by   TEXT
  );

  CREATE TABLE IF NOT EXISTS patrol_routes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    waypoints   TEXT NOT NULL -- JSON: [{lat, lon, alt, label?}]
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('PERSON', 'VEHICLE')),
    status     TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VALIDATED', 'DISMISSED')),
    drone_id   TEXT,
    lat        REAL,
    lon        REAL,
    snapshot   TEXT, -- JPEG base64 del frame que disparó la detección
    decided_by TEXT,
    decided_at TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    type     TEXT NOT NULL,
    source   TEXT NOT NULL, -- username o 'backend'
    message  TEXT NOT NULL,
    drone_id TEXT,
    alert_id INTEGER,
    category TEXT NOT NULL DEFAULT 'drone', -- 'drone' | 'usuarios' | 'sistema'
    meta     TEXT -- JSON libre, p. ej. {antes, despues} en cambios de usuarios
  );

  CREATE INDEX IF NOT EXISTS idx_drones_hash ON drones(hash);
`);

// --- Migraciones sobre bases anteriores ---

// Columnas agregadas después de la primera versión
const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
for (const [col, def] of [
  ['display_name', 'TEXT'],
  ['base_name', 'TEXT'],
  ['base_lat', 'REAL'],
  ['base_lon', 'REAL'],
  ['active', 'INTEGER NOT NULL DEFAULT 1'],
  ['can_control', 'INTEGER NOT NULL DEFAULT 1'],
]) {
  if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
}

const eventCols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
for (const [col, def] of [
  ['category', "TEXT NOT NULL DEFAULT 'drone'"],
  ['meta', 'TEXT'],
]) {
  if (!eventCols.includes(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} ${def}`);
}

// La tabla original tenía CHECK (role IN ('operator','drone')): impediría crear
// supervisores y admins. Si el esquema viejo sigue vigente, se reconstruye la
// tabla sin ese CHECK conservando los datos.
const usersSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as
  | { sql: string }
  | undefined)?.sql;
if (usersSql && usersSql.includes("CHECK (role IN ('operator', 'drone'))")) {
  db.exec(`
    BEGIN;
    ALTER TABLE users RENAME TO users_old;
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL,
      display_name  TEXT,
      base_name     TEXT,
      base_lat      REAL,
      base_lon      REAL,
      active        INTEGER NOT NULL DEFAULT 1,
      can_control   INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO users (id, username, password_hash, role, display_name, base_name, base_lat, base_lon, active, can_control)
      SELECT id, username, password_hash, role, display_name, base_name, base_lat, base_lon,
             COALESCE(active, 1), COALESCE(can_control, 1)
        FROM users_old;
    DROP TABLE users_old;
    COMMIT;
  `);
}

// El borrado lógico se agrega DESPUÉS de esa reconstrucción: la reconstrucción
// recrea `users` con la lista de columnas del esquema viejo y se llevaría
// puestas estas dos si se agregaran antes.
const userColsPostRebuild = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
for (const col of ['deleted_at', 'deleted_by']) {
  if (!userColsPostRebuild.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
}

// Índices del registro: van acá y no en el CREATE de arriba porque `category`
// puede haberse agregado recién en la migración de columnas.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_events_cat_id ON events(category, id DESC);
  CREATE INDEX IF NOT EXISTS idx_events_drone  ON events(drone_id, id DESC);
`);

// Los drones dejaron de ser cuentas de usuario. Cada `users` con role='drone'
// pasa a ser una fila de `drones` con un hash nuevo, y el historial que la
// referenciaba por username se reapunta a ese hash para no perder nada. Todo en
// una transacción; si `drones` ya tiene filas, la base ya está migrada.
const dronesVacia = (db.prepare('SELECT COUNT(*) AS n FROM drones').get() as { n: number }).n === 0;
if (dronesVacia) {
  const cuentas = db
    .prepare("SELECT username, display_name, base_name, base_lat, base_lon, active FROM users WHERE role = 'drone'")
    .all() as {
    username: string;
    display_name: string | null;
    base_name: string | null;
    base_lat: number | null;
    base_lon: number | null;
    active: number;
  }[];

  if (cuentas.length > 0) {
    const migrar = db.transaction(() => {
      const insertar = db.prepare(
        `INSERT INTO drones (hash, display_name, model, active, base_name, base_lat, base_lon, created_at, created_by)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, 'migracion')`,
      );
      const reapuntarEventos = db.prepare('UPDATE events SET drone_id = ? WHERE drone_id = ?');
      const reapuntarAlertas = db.prepare('UPDATE alerts SET drone_id = ? WHERE drone_id = ?');
      // El origen también se reapunta: la cuenta se borra de `users` y su
      // nombre queda libre para una persona nueva, así que dejar el username
      // viejo en `source` haría pasar eventos de máquina por actividad humana.
      const reapuntarOrigen = db.prepare('UPDATE events SET source = ? WHERE source = ?');
      const creadoEn = new Date().toISOString();

      for (const c of cuentas) {
        const hash = randomBytes(16).toString('hex');
        insertar.run(hash, c.display_name ?? c.username, c.active ? 1 : 0, c.base_name, c.base_lat, c.base_lon, creadoEn);
        reapuntarEventos.run(hash, c.username);
        reapuntarAlertas.run(hash, c.username);
        reapuntarOrigen.run(hash, c.username);
      }
      db.prepare("DELETE FROM users WHERE role = 'drone'").run();
    });
    migrar();
  }
}
