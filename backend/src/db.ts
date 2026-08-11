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
    role          TEXT NOT NULL CHECK (role IN ('operator', 'drone')),
    -- Solo para role='drone': nombre visible (editable desde ambos lados) y base
    display_name  TEXT,
    base_name     TEXT,
    base_lat      REAL,
    base_lon      REAL
  );

  CREATE TABLE IF NOT EXISTS patrol_routes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    waypoints   TEXT NOT NULL -- JSON: [{lat, lon, alt}]
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
    source   TEXT NOT NULL, -- 'drone' | 'operator' | 'backend'
    message  TEXT NOT NULL,
    drone_id TEXT,
    alert_id INTEGER
  );
`);

// Bases de datos creadas antes de que existieran estas columnas: se agregan al vuelo
const userColumns = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
for (const [col, type] of [['display_name', 'TEXT'], ['base_name', 'TEXT'], ['base_lat', 'REAL'], ['base_lon', 'REAL']]) {
  if (!userColumns.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
}
