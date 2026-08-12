import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ejercita las migraciones de db.ts sobre bases con esquemas ANTERIORES. db.ts
// se importa DINÁMICAMENTE (después de fijar DB_FILE a un archivo real y crear
// el esquema viejo) para que las migraciones corran sobre esa base; por eso
// este archivo NO importa estáticamente ningún módulo del backend.

type Fila = Record<string, unknown>;
interface DbLike {
  prepare: (sql: string) => { all: (...p: unknown[]) => Fila[]; get: (...p: unknown[]) => Fila | undefined; run: (...p: unknown[]) => unknown };
  close: () => void;
}

function archivoTemporal(nombre: string): string {
  return path.join(os.tmpdir(), `cc-${nombre}-${process.pid}-${Date.now()}.db`);
}

/** Reimporta db.ts contra el archivo indicado, corriendo sus migraciones. */
async function abrirConMigraciones(file: string): Promise<DbLike> {
  vi.resetModules();
  process.env.DB_FILE = file;
  return (await import('../../src/db')).db as unknown as DbLike;
}

function borrarBase(file: string) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignorar */
    }
  }
}

const columnas = (db: DbLike, tabla: string) => db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name as string);

describe('integración — migración desde el esquema original', () => {
  let tmpFile = '';
  let db: DbLike;

  beforeAll(async () => {
    tmpFile = archivoTemporal('migracion-v1');

    // Esquema de la primera versión: users con CHECK (role IN ('operator','drone'))
    // y sin columnas nuevas; events sin category/meta; sin alerts ni patrol_routes.
    const old = new Database(tmpFile);
    old.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('operator', 'drone'))
      );
      CREATE TABLE events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,
        type     TEXT NOT NULL,
        source   TEXT NOT NULL,
        message  TEXT NOT NULL,
        drone_id TEXT,
        alert_id INTEGER
      );
    `);
    old.prepare("INSERT INTO users (username, password_hash, role) VALUES ('oldop', 'h', 'operator')").run();
    old.prepare("INSERT INTO users (username, password_hash, role) VALUES ('olddrone', 'h', 'drone')").run();
    old.prepare("INSERT INTO events (ts, type, source, message) VALUES ('2020-01-01', 'X', 'backend', 'evento viejo')").run();
    old
      .prepare(
        "INSERT INTO events (ts, type, source, message, drone_id) VALUES ('2020-01-02', 'PATROL_STARTED', 'olddrone', 'patrullando', 'olddrone')",
      )
      .run();
    old.close();

    db = await abrirConMigraciones(tmpFile);
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* ya cerrada */
    }
    borrarBase(tmpFile);
  });

  it('agrega las columnas nuevas a users, incluidas las del borrado lógico', () => {
    const cols = columnas(db, 'users');
    for (const col of ['display_name', 'base_name', 'base_lat', 'base_lon', 'active', 'can_control', 'deleted_at', 'deleted_by']) {
      expect(cols).toContain(col);
    }
  });

  it('agrega category y meta a events, con default de category', () => {
    const cols = columnas(db, 'events');
    expect(cols).toContain('category');
    expect(cols).toContain('meta');
    const ev = db.prepare("SELECT * FROM events WHERE type = 'X'").get()!;
    expect(ev.category).toBe('drone');
    expect(ev.meta).toBeNull();
  });

  it('elimina el CHECK viejo: ahora se pueden crear supervisores y admins', () => {
    expect(() =>
      db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('unsup', 'h', 'supervisor')").run(),
    ).not.toThrow();
    expect(db.prepare("SELECT role FROM users WHERE username = 'unsup'").get()!.role).toBe('supervisor');
  });

  it('preserva los datos existentes con los defaults de active/can_control', () => {
    const oldop = db.prepare("SELECT * FROM users WHERE username = 'oldop'").get()!;
    expect(oldop.role).toBe('operator');
    expect(oldop.active).toBe(1);
    expect(oldop.can_control).toBe(1);
    // las tablas que faltaban se crearon
    const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name as string);
    expect(tablas).toContain('patrol_routes');
    expect(tablas).toContain('alerts');
    expect(tablas).toContain('drones');
  });

  it('crea los índices del registro y de los drones', () => {
    const indices = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((i) => i.name as string);
    expect(indices).toContain('idx_events_cat_id');
    expect(indices).toContain('idx_events_drone');
    expect(indices).toContain('idx_drones_hash');
  });

  it('convierte la cuenta de dron en un activo con hash y reapunta su historial', () => {
    // la cuenta ya no está en users
    expect(db.prepare("SELECT * FROM users WHERE role = 'drone'").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM users WHERE username = 'olddrone'").get()).toBeUndefined();

    const dron = db.prepare("SELECT * FROM drones WHERE display_name = 'olddrone'").get()!;
    expect(dron).toBeDefined();
    expect(String(dron.hash)).toMatch(/^[0-9a-f]{32}$/);
    expect(dron.created_by).toBe('migracion');
    expect(dron.model).toBe('');
    expect(dron.active).toBe(1);

    // el evento del dron ahora apunta al hash
    const ev = db.prepare("SELECT * FROM events WHERE type = 'PATROL_STARTED'").get()!;
    expect(ev.drone_id).toBe(dron.hash);
    // `source` conserva el username viejo a propósito: la migración solo
    // reapunta drone_id, y el pop-up del registro muestra meta.drone
    expect(ev.source).toBe('olddrone');
  });
});

describe('integración — migración desde el esquema intermedio (drones como cuentas)', () => {
  let tmpFile = '';
  let db: DbLike;

  beforeAll(async () => {
    tmpFile = archivoTemporal('migracion-v2');

    // Esquema ya sin el CHECK y con las columnas de dron sobre `users`: es el
    // caso realista de una base en producción antes de este cambio.
    const old = new Database(tmpFile);
    old.exec(`
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
      CREATE TABLE events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,
        type     TEXT NOT NULL,
        source   TEXT NOT NULL,
        message  TEXT NOT NULL,
        drone_id TEXT,
        alert_id INTEGER,
        category TEXT NOT NULL DEFAULT 'drone',
        meta     TEXT
      );
      CREATE TABLE alerts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        type       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'PENDING',
        drone_id   TEXT,
        lat        REAL,
        lon        REAL,
        snapshot   TEXT,
        decided_by TEXT,
        decided_at TEXT
      );
    `);
    old
      .prepare(
        `INSERT INTO users (username, password_hash, role, display_name, base_name, base_lat, base_lon, active)
         VALUES ('drone1', 'h', 'drone', 'Alfa', 'Base Norte', -34.8565, -56.2075, 1)`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO users (username, password_hash, role, display_name, active)
         VALUES ('drone2', 'h', 'drone', 'Bravo', 0)`,
      )
      .run();
    old.prepare("INSERT INTO users (username, password_hash, role) VALUES ('operador', 'h', 'operator')").run();
    old
      .prepare(
        "INSERT INTO events (ts, type, source, message, drone_id, category) VALUES ('2024-01-01', 'DRONE_CONNECTED', 'backend', 'Alfa conectado', 'drone1', 'drone')",
      )
      .run();
    old
      .prepare(
        "INSERT INTO events (ts, type, source, message, drone_id, category) VALUES ('2024-01-02', 'LANDED', 'drone2', 'Bravo aterrizó', 'drone2', 'drone')",
      )
      .run();
    old
      .prepare("INSERT INTO alerts (created_at, type, drone_id) VALUES ('2024-01-03', 'PERSON', 'drone1')")
      .run();
    old.close();

    db = await abrirConMigraciones(tmpFile);
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* ya cerrada */
    }
    borrarBase(tmpFile);
  });

  it('cada cuenta de dron pasa a `drones` conservando nombre, base y estado', () => {
    const drones = db.prepare('SELECT * FROM drones ORDER BY display_name').all();
    expect(drones).toHaveLength(2);

    const alfa = drones[0];
    expect(alfa.display_name).toBe('Alfa');
    expect(alfa.base_name).toBe('Base Norte');
    expect(alfa.base_lat).toBeCloseTo(-34.8565);
    expect(alfa.base_lon).toBeCloseTo(-56.2075);
    expect(alfa.active).toBe(1);
    expect(alfa.deleted_at).toBeNull();

    const bravo = drones[1];
    expect(bravo.display_name).toBe('Bravo');
    expect(bravo.active).toBe(0);

    // hashes distintos, del formato que espera el QR
    expect(String(alfa.hash)).toMatch(/^[0-9a-f]{32}$/);
    expect(alfa.hash).not.toBe(bravo.hash);
  });

  it('borra las cuentas de dron de users y deja intactos a los humanos', () => {
    expect(db.prepare("SELECT * FROM users WHERE role = 'drone'").all()).toHaveLength(0);
    const humanos = db.prepare('SELECT username FROM users').all().map((u) => u.username as string);
    expect(humanos).toEqual(['operador']);
  });

  it('reapunta el historial de events y alerts al hash nuevo', () => {
    const alfa = db.prepare("SELECT hash FROM drones WHERE display_name = 'Alfa'").get()!;
    const bravo = db.prepare("SELECT hash FROM drones WHERE display_name = 'Bravo'").get()!;

    expect(db.prepare("SELECT drone_id FROM events WHERE type = 'DRONE_CONNECTED'").get()!.drone_id).toBe(alfa.hash);
    expect(db.prepare("SELECT drone_id FROM events WHERE type = 'LANDED'").get()!.drone_id).toBe(bravo.hash);
    expect(db.prepare('SELECT drone_id FROM alerts').get()!.drone_id).toBe(alfa.hash);
    // ningún registro quedó apuntando al username viejo
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE drone_id IN ('drone1','drone2')").get()!.n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE drone_id IN ('drone1','drone2')").get()!.n).toBe(0);
  });

  it('es idempotente: volver a arrancar sobre la base ya migrada no duplica nada', async () => {
    const antes = db.prepare('SELECT hash, display_name FROM drones ORDER BY display_name').all();
    db.close();

    const db2 = await abrirConMigraciones(tmpFile);
    const despues = db2.prepare('SELECT hash, display_name FROM drones ORDER BY display_name').all();
    expect(despues).toEqual(antes);
    // el arranque nuevo tampoco resucita cuentas de dron
    expect(db2.prepare("SELECT COUNT(*) AS n FROM users").get()!.n).toBe(1);
    db = db2;
  });
});
