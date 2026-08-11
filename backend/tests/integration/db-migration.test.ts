import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ejercita las migraciones de db.ts sobre una base con el ESQUEMA VIEJO:
// - users con CHECK (role IN ('operator','drone')) y sin las columnas nuevas
// - events sin las columnas category/meta
// Se importa db.ts DINÁMICAMENTE (después de fijar DB_FILE a un archivo real y
// crear el esquema viejo) para que las migraciones corran sobre esa base.
// Por eso este archivo NO importa estáticamente ningún módulo del backend.
describe('integración — migraciones de db.ts sobre esquema viejo', () => {
  let tmpFile = '';
  let dbMod: any;

  beforeAll(async () => {
    tmpFile = path.join(os.tmpdir(), `cc-migracion-${process.pid}-${Date.now()}.db`);

    // 1) Base con el esquema anterior
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
    old.close();

    // 2) db.ts abrirá ESTE archivo y correrá las migraciones al importarse
    process.env.DB_FILE = tmpFile;
    dbMod = await import('../../src/db');
  });

  afterAll(() => {
    try {
      dbMod?.db?.close();
    } catch {
      /* ya cerrada */
    }
    for (const f of [tmpFile, `${tmpFile}-wal`, `${tmpFile}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignorar */
      }
    }
  });

  it('agrega las columnas nuevas a users', () => {
    const cols = (dbMod.db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    for (const col of ['display_name', 'base_name', 'base_lat', 'base_lon', 'active', 'can_control']) {
      expect(cols).toContain(col);
    }
  });

  it('agrega category y meta a events, con default de category', () => {
    const cols = (dbMod.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('category');
    expect(cols).toContain('meta');
    const ev = dbMod.db.prepare("SELECT * FROM events WHERE type = 'X'").get() as any;
    expect(ev.category).toBe('drone');
    expect(ev.meta).toBeNull();
  });

  it('elimina el CHECK viejo: ahora se pueden crear supervisores y admins', () => {
    expect(() =>
      dbMod.db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('unsup', 'h', 'supervisor')").run(),
    ).not.toThrow();
    const sup = dbMod.db.prepare("SELECT role FROM users WHERE username = 'unsup'").get() as any;
    expect(sup.role).toBe('supervisor');
  });

  it('preserva los datos existentes con los defaults de active/can_control', () => {
    const oldop = dbMod.db.prepare("SELECT * FROM users WHERE username = 'oldop'").get() as any;
    expect(oldop).toBeDefined();
    expect(oldop.role).toBe('operator');
    expect(oldop.active).toBe(1);
    expect(oldop.can_control).toBe(1);
    // las tablas que faltaban se crearon
    const tablas = (
      dbMod.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((t) => t.name);
    expect(tablas).toContain('patrol_routes');
    expect(tablas).toContain('alerts');
  });
});
