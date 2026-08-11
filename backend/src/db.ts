import Database from 'better-sqlite3';
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
    -- 'drone' | 'operator' | 'supervisor' | 'admin' (validado en código)
    role          TEXT NOT NULL,
    display_name  TEXT,
    base_name     TEXT,
    base_lat      REAL,
    base_lon      REAL,
    active        INTEGER NOT NULL DEFAULT 1,
    can_control   INTEGER NOT NULL DEFAULT 1
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
