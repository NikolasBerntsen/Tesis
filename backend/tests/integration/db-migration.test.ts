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
    for (const col of ['display_name', 'active', 'can_control', 'deleted', 'deleted_at', 'deleted_by']) {
      expect(cols).toContain(col);
    }
  });

  it('no deja en users las columnas de base embebida', () => {
    const cols = columnas(db, 'users');
    for (const col of ['base_name', 'base_lat', 'base_lon']) {
      expect(cols).not.toContain(col);
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

    // el evento del dron ahora apunta al hash, y también su origen: la cuenta
    // se borra de users y su nombre queda libre, así que dejar 'olddrone' en
    // `source` haría que una persona nueva con ese nombre herede el historial
    const ev = db.prepare("SELECT * FROM events WHERE type = 'PATROL_STARTED'").get()!;
    expect(ev.drone_id).toBe(dron.hash);
    expect(ev.source).toBe(dron.hash);
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
    // Comparte la base con drone1: las dos cuentas tienen que terminar
    // apuntando a UNA sola fila de bases, no a dos iguales.
    old
      .prepare(
        `INSERT INTO users (username, password_hash, role, display_name, base_name, base_lat, base_lon, active)
         VALUES ('drone3', 'h', 'drone', 'Charlie', 'Base Norte', -34.8565, -56.2075, 1)`,
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
    expect(drones).toHaveLength(3);

    const alfa = drones[0];
    expect(alfa.display_name).toBe('Alfa');
    expect(alfa.active).toBe(1);
    expect(alfa.deleted).toBe(0);
    expect(alfa.deleted_at).toBeNull();

    // La base de la cuenta vieja no se copia dentro del dron: se promueve a
    // `bases` y el activo queda apuntando por FK.
    const base = db.prepare('SELECT * FROM bases WHERE id = ?').get(alfa.base_id) as
      | { name: string; lat: number; lon: number }
      | undefined;
    expect(base?.name).toBe('Base Norte');
    expect(base?.lat).toBeCloseTo(-34.8565);
    expect(base?.lon).toBeCloseTo(-56.2075);

    const bravo = drones[1];
    expect(bravo.display_name).toBe('Bravo');
    expect(bravo.active).toBe(0);
    // sin base en la cuenta vieja, el activo nace sin vínculo
    expect(bravo.base_id).toBeNull();

    // Charlie compartía la base con Alfa: una sola fila en `bases` para los dos.
    const charlie = drones[2];
    expect(charlie.display_name).toBe('Charlie');
    expect(charlie.base_id).toBe(alfa.base_id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bases WHERE name = 'Base Norte'").get()).toEqual({ n: 1 });

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
    // el origen del evento que emitió el propio dron también pasa al hash: la
    // cuenta se borra y el nombre queda libre para una persona nueva
    expect(db.prepare("SELECT source FROM events WHERE type = 'LANDED'").get()!.source).toBe(bravo.hash);
    // y lo que no era del dron queda intacto
    expect(db.prepare("SELECT source FROM events WHERE type = 'DRONE_CONNECTED'").get()!.source).toBe('backend');

    // ningún registro quedó apuntando al username viejo
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE drone_id IN ('drone1','drone2')").get()!.n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE source IN ('drone1','drone2')").get()!.n).toBe(0);
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

describe('integración — migración de las bases embebidas en los drones', () => {
  let tmpFile = '';
  let db: DbLike;

  beforeAll(async () => {
    tmpFile = archivoTemporal('migracion-bases');

    // Esquema con los drones ya como activos pero con la base todavía embebida
    // en cada fila: es el estado de producción antes de este cambio.
    const old = new Database(tmpFile);
    old.exec(`
      CREATE TABLE drones (
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
    `);
    const alta = old.prepare(
      `INSERT INTO drones (hash, display_name, base_name, base_lat, base_lon, created_at)
       VALUES (?, ?, ?, ?, ?, '2024-01-01T00:00:00.000Z')`,
    );
    // dos drones comparten base y uno tiene otra; un cuarto no tiene ninguna
    alta.run('a'.repeat(32), 'Alfa', 'Base Norte', -34.85, -56.2);
    alta.run('b'.repeat(32), 'Bravo', 'Base Norte', -34.85, -56.2);
    alta.run('c'.repeat(32), 'Charlie', 'Base Sur', -34.9, -56.1);
    alta.run('d'.repeat(32), 'Delta', null, null, null);
    old.close();

    db = await abrirConMigraciones(tmpFile);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmpFile, { force: true });
  });

  it('promueve cada base distinta a una fila de `bases`, sin duplicar las compartidas', () => {
    const bases = db.prepare('SELECT name, lat, lon, created_by FROM bases ORDER BY name').all() as Fila[];
    expect(bases).toEqual([
      { name: 'Base Norte', lat: -34.85, lon: -56.2, created_by: 'migracion' },
      { name: 'Base Sur', lat: -34.9, lon: -56.1, created_by: 'migracion' },
    ]);
  });

  it('apunta cada dron a su base, y los dos que la compartían quedan en la misma', () => {
    const filas = db
      .prepare('SELECT display_name, base_id FROM drones ORDER BY display_name')
      .all() as { display_name: string; base_id: number | null }[];
    const porNombre = Object.fromEntries(filas.map((f) => [f.display_name, f.base_id]));

    expect(porNombre.Alfa).toBe(porNombre.Bravo);
    expect(porNombre.Charlie).not.toBe(porNombre.Alfa);
    // el dron sin base no inventa una
    expect(porNombre.Delta).toBeNull();
  });

  it('agrega el número de inventario vacío y no pierde el nombre ni el estado', () => {
    const alfa = db.prepare("SELECT * FROM drones WHERE display_name = 'Alfa'").get() as Fila;
    expect(alfa.inventory_code).toBe('');
    expect(alfa.active).toBe(1);
    expect(alfa.hash).toBe('a'.repeat(32));
  });

  it('es idempotente: reabrir la base no vuelve a promover', async () => {
    db.close();
    const otra = await abrirConMigraciones(tmpFile);
    expect((otra.prepare('SELECT COUNT(*) AS n FROM bases').get() as { n: number }).n).toBe(2);
    otra.close();
    db = await abrirConMigraciones(tmpFile);
  });
});

describe('integración — la baja lógica pasa a ser una marca propia', () => {
  let tmpFile = '';
  let db: DbLike;

  beforeAll(async () => {
    tmpFile = archivoTemporal('migracion-deleted');

    // Esquema con borrado lógico por fecha: la marca todavía no existe y la
    // base embebida sigue copiada dentro de cada dron.
    const old = new Database(tmpFile);
    old.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL, display_name TEXT, base_name TEXT, base_lat REAL, base_lon REAL,
        full_name TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, can_control INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT, deleted_by TEXT
      );
      CREATE TABLE drones (
        id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '', inventory_code TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
        base_id INTEGER, base_name TEXT, base_lat REAL, base_lon REAL,
        created_at TEXT NOT NULL, created_by TEXT, deleted_at TEXT, deleted_by TEXT
      );
      CREATE TABLE bases (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT, deleted_at TEXT, deleted_by TEXT
      );
      CREATE TABLE patrol_routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        waypoints TEXT NOT NULL, created_at TEXT, created_by TEXT, deleted_at TEXT, deleted_by TEXT
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL,
        message TEXT NOT NULL, drone_id TEXT, alert_id INTEGER, category TEXT NOT NULL DEFAULT 'drone', meta TEXT
      );
      CREATE INDEX idx_bases_activas ON bases(deleted_at, active);
    `);
    old.prepare("INSERT INTO users (username, password_hash, role) VALUES ('viva', 'h', 'operator')").run();
    old
      .prepare(
        "INSERT INTO users (username, password_hash, role, deleted_at, deleted_by) VALUES ('exop', 'h', 'operator', '2024-01-01T00:00:00.000Z', 'admin1')",
      )
      .run();
    old
      .prepare(
        "INSERT INTO drones (hash, display_name, created_at, base_name, base_lat, base_lon) VALUES ('aaaa', 'Alfa', '2024-01-01', 'Base Norte', -34.85, -56.2)",
      )
      .run();
    old
      .prepare(
        "INSERT INTO drones (hash, display_name, created_at, deleted_at) VALUES ('bbbb', 'Bravo', '2024-01-01', '2024-02-01T00:00:00.000Z')",
      )
      .run();
    old.prepare("INSERT INTO bases (name, lat, lon, created_at) VALUES ('Base Sur', -34.9, -56.1, '2024-01-01')").run();
    old
      .prepare("INSERT INTO bases (name, lat, lon, created_at, deleted_at) VALUES ('Ex base', -34.7, -56.3, '2024-01-01', '2024-03-01')")
      .run();
    old.prepare("INSERT INTO patrol_routes (name, waypoints) VALUES ('Viva', '[]')").run();
    old.prepare("INSERT INTO patrol_routes (name, waypoints, deleted_at) VALUES ('Ex ruta', '[]', '2024-03-01')").run();
    old.close();

    db = await abrirConMigraciones(tmpFile);
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      /* ignorar */
    }
    borrarBase(tmpFile);
  });

  it('agrega la marca a las cuatro tablas con baja lógica', () => {
    for (const tabla of ['users', 'drones', 'bases', 'patrol_routes']) {
      expect(columnas(db, tabla)).toContain('deleted');
    }
  });

  it('marca lo que ya estaba dado de baja y deja en pie lo demás', () => {
    const marca = (tabla: string, campo: string, valor: string) =>
      (db.prepare(`SELECT deleted FROM ${tabla} WHERE ${campo} = ?`).get(valor) as { deleted: number }).deleted;

    expect(marca('users', 'username', 'exop')).toBe(1);
    expect(marca('users', 'username', 'viva')).toBe(0);
    expect(marca('drones', 'hash', 'bbbb')).toBe(1);
    expect(marca('drones', 'hash', 'aaaa')).toBe(0);
    expect(marca('bases', 'name', 'Ex base')).toBe(1);
    expect(marca('bases', 'name', 'Base Sur')).toBe(0);
    expect(marca('patrol_routes', 'name', 'Ex ruta')).toBe(1);
    expect(marca('patrol_routes', 'name', 'Viva')).toBe(0);
  });

  it('conserva la fecha y el autor de la baja como dato de auditoría', () => {
    const exop = db.prepare("SELECT deleted_at, deleted_by FROM users WHERE username = 'exop'").get() as {
      deleted_at: string;
      deleted_by: string;
    };
    expect(exop.deleted_at).toBe('2024-01-01T00:00:00.000Z');
    expect(exop.deleted_by).toBe('admin1');
  });

  it('borra las columnas de base embebida de drones y de users', () => {
    for (const tabla of ['drones', 'users']) {
      for (const col of ['base_name', 'base_lat', 'base_lon']) {
        expect(columnas(db, tabla)).not.toContain(col);
      }
    }
  });

  it('el índice de bases activas pasa a filtrar por la marca, no por la fecha', () => {
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_bases_activas'").get() as
      | { sql: string }
      | undefined)?.sql;
    expect(sql).toContain('deleted');
    expect(sql).not.toContain('deleted_at');
  });

  it('correr las migraciones de nuevo no cambia nada', async () => {
    const antes = db.prepare('SELECT hash, deleted FROM drones ORDER BY hash').all();
    db.close();
    const otra = await abrirConMigraciones(tmpFile);
    expect(otra.prepare('SELECT hash, deleted FROM drones ORDER BY hash').all()).toEqual(antes);
    db = otra;
  });
});
