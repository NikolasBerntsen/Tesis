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
    full_name     TEXT NOT NULL DEFAULT '',
    active        INTEGER NOT NULL DEFAULT 1,
    can_control   INTEGER NOT NULL DEFAULT 1,
    -- Borrado lógico: la fila queda y por lo tanto el username SIGUE OCUPADO
    -- (el UNIQUE se mantiene a propósito: el historial referencia ese nombre).
    -- deleted es la marca que consulta el código; deleted_at y deleted_by son
    -- el dato de auditoría. Preguntar por la marca y no por la fecha evita que
    -- una fila con la fecha en blanco por un error de escritura pase por viva.
    deleted       INTEGER NOT NULL DEFAULT 0,
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
    -- Número de inventario con el que la organización identifica al aparato.
    -- No entra en el QR: se imprime al lado, para poder leerlo sin escanear.
    inventory_code TEXT NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1,
    base_id      INTEGER REFERENCES bases(id),
    created_at   TEXT NOT NULL,
    created_by   TEXT,
    deleted      INTEGER NOT NULL DEFAULT 0,
    deleted_at   TEXT,
    deleted_by   TEXT
  );

  CREATE TABLE IF NOT EXISTS patrol_routes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    waypoints   TEXT NOT NULL, -- JSON: [{lat, lon, alt, label?}]
    created_at  TEXT,
    created_by  TEXT,
    deleted     INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    deleted_by  TEXT
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

  -- Las bases dejaron de vivir embebidas en cada dron: son un activo propio que
  -- se da de alta una vez y al que muchos drones apuntan. El borrado es lógico,
  -- como todo en el sistema.
  CREATE TABLE IF NOT EXISTS bases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    created_by TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    deleted_by TEXT
  );

  -- Una base puede tener varias rutas y una ruta puede servir a varias bases:
  -- el operador elige, entre las de SU base, cuál patrullar.
  CREATE TABLE IF NOT EXISTS base_routes (
    base_id  INTEGER NOT NULL REFERENCES bases(id),
    route_id INTEGER NOT NULL REFERENCES patrol_routes(id),
    PRIMARY KEY (base_id, route_id)
  );
  CREATE INDEX IF NOT EXISTS idx_base_routes_ruta ON base_routes(route_id);
`);

// --- Migraciones sobre bases anteriores ---

// Columnas agregadas después de la primera versión
const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
for (const [col, def] of [
  ['display_name', 'TEXT'],
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
  // La base embebida puede estar o no según hasta dónde haya llegado una
  // migración anterior. Si está, se arrastra: recién se borra al final, cuando
  // las cuentas de dron ya se promovieron a activos con su base_id.
  const conBaseEmbebida = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[])
    .some((c) => c.name === 'base_lat');
  const defsBase = conBaseEmbebida ? 'base_name TEXT, base_lat REAL, base_lon REAL,' : '';
  const colsBase = conBaseEmbebida ? 'base_name, base_lat, base_lon,' : '';
  db.exec(`
    BEGIN;
    ALTER TABLE users RENAME TO users_old;
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL,
      display_name  TEXT,
      ${defsBase}
      active        INTEGER NOT NULL DEFAULT 1,
      can_control   INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO users (id, username, password_hash, role, display_name, ${colsBase} active, can_control)
      SELECT id, username, password_hash, role, display_name, ${colsBase}
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
if (!userColsPostRebuild.includes('deleted')) {
  db.exec('ALTER TABLE users ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
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
const usuariosConBaseEmbebida = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[])
  .some((c) => c.name === 'base_lat');
// El esquema más viejo de todos no tenía la base embebida en la cuenta: en ese
// caso el activo nace sin base y se le asigna después desde la consola.
const columnasDeBase = usuariosConBaseEmbebida
  ? 'base_name, base_lat, base_lon'
  : 'NULL AS base_name, NULL AS base_lat, NULL AS base_lon';
const dronesVacia = (db.prepare('SELECT COUNT(*) AS n FROM drones').get() as { n: number }).n === 0;
if (dronesVacia) {
  const cuentas = db
    .prepare(`SELECT username, display_name, ${columnasDeBase}, active FROM users WHERE role = 'drone'`)
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
        `INSERT INTO drones (hash, display_name, model, active, base_id, created_at, created_by)
         VALUES (?, ?, '', ?, ?, ?, 'migracion')`,
      );
      // La base de la cuenta vieja se busca (o se crea) en `bases`: el activo
      // nace apuntando por FK, no con la coordenada copiada encima.
      const buscarBase = db.prepare('SELECT id FROM bases WHERE lat = ? AND lon = ?');
      const crearBase = db.prepare(
        "INSERT INTO bases (name, lat, lon, created_at, created_by) VALUES (?, ?, ?, ?, 'migracion')",
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
        let baseId: number | null = null;
        if (c.base_lat != null && c.base_lon != null) {
          const ya = buscarBase.get(c.base_lat, c.base_lon) as { id: number } | undefined;
          baseId = ya
            ? ya.id
            : Number(crearBase.run(c.base_name ?? 'Base', c.base_lat, c.base_lon, creadoEn).lastInsertRowid);
        }
        insertar.run(hash, c.display_name ?? c.username, c.active ? 1 : 0, baseId, creadoEn);
        reapuntarEventos.run(hash, c.username);
        reapuntarAlertas.run(hash, c.username);
        reapuntarOrigen.run(hash, c.username);
      }
      db.prepare("DELETE FROM users WHERE role = 'drone'").run();
    });
    migrar();
  }
}

// --- Bases como activo propio ---

// Columnas nuevas sobre bases anteriores.
const droneCols = (db.prepare('PRAGMA table_info(drones)').all() as { name: string }[]).map((c) => c.name);
for (const [col, def] of [
  ['inventory_code', "TEXT NOT NULL DEFAULT ''"],
  ['base_id', 'INTEGER REFERENCES bases(id)'],
]) {
  if (!droneCols.includes(col)) db.exec(`ALTER TABLE drones ADD COLUMN ${col} ${def}`);
}
const userCols2 = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
if (!userCols2.includes('full_name')) db.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");

// Las bases que vivían embebidas en cada dron se promueven a filas de `bases`.
// Se agrupan por nombre y coordenada: tres drones que compartían "Base Norte"
// terminan apuntando a una sola base, que es lo que el operador espera ver.
const dronesConBaseEmbebida = (db.prepare('PRAGMA table_info(drones)').all() as { name: string }[])
  .some((c) => c.name === 'base_lat');
const basesVacia = (db.prepare('SELECT COUNT(*) AS n FROM bases').get() as { n: number }).n === 0;
if (basesVacia && dronesConBaseEmbebida) {
  const embebidas = db
    .prepare(
      `SELECT DISTINCT base_name AS name, base_lat AS lat, base_lon AS lon
         FROM drones
        WHERE base_lat IS NOT NULL AND base_lon IS NOT NULL`,
    )
    .all() as { name: string | null; lat: number; lon: number }[];

  if (embebidas.length > 0) {
    const promover = db.transaction(() => {
      const insertar = db.prepare(
        "INSERT INTO bases (name, lat, lon, created_at, created_by) VALUES (?, ?, ?, ?, 'migracion')",
      );
      const apuntar = db.prepare(
        'UPDATE drones SET base_id = ? WHERE base_lat = ? AND base_lon = ? AND base_id IS NULL',
      );
      const creadaEn = new Date().toISOString();
      for (const b of embebidas) {
        const info = insertar.run(b.name ?? 'Base', b.lat, b.lon, creadaEn);
        apuntar.run(Number(info.lastInsertRowid), b.lat, b.lon);
      }
    });
    promover();
  }
}

// Las rutas nacieron como datos de demostración sin autoría ni baja: ahora se
// dan de alta desde la consola, así que necesitan lo mismo que el resto.
const rutaCols = (db.prepare('PRAGMA table_info(patrol_routes)').all() as { name: string }[]).map((c) => c.name);
for (const [col, def] of [
  ['created_at', 'TEXT'],
  ['created_by', 'TEXT'],
  ['deleted_at', 'TEXT'],
  ['deleted_by', 'TEXT'],
]) {
  if (!rutaCols.includes(col)) db.exec(`ALTER TABLE patrol_routes ADD COLUMN ${col} ${def}`);
}

// --- La baja lógica pasa a ser una marca propia ---

// Antes había que deducirla de `deleted_at IS NOT NULL`. Ahora cada tabla con
// baja lógica lleva su booleano y es lo único que consulta el código: la fecha
// queda como dato de auditoría y deja de ser el interruptor.
for (const tabla of ['users', 'drones', 'bases', 'patrol_routes']) {
  const cols = (db.prepare(`PRAGMA table_info(${tabla})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('deleted')) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
  }
  // Las filas que ya estaban dadas de baja tienen fecha y todavía no marca.
  db.exec(`UPDATE ${tabla} SET deleted = 1 WHERE deleted = 0 AND deleted_at IS NOT NULL`);
}

// El índice de bases activas filtraba por la fecha; ahora por la marca.
db.exec('DROP INDEX IF EXISTS idx_bases_activas');
db.exec('CREATE INDEX IF NOT EXISTS idx_bases_activas ON bases(deleted, active)');

// --- Se van las columnas de base embebida ---

// `drones.base_name`, `base_lat` y `base_lon` sobrevivían de cuando la base
// vivía copiada dentro de cada dron. Hoy la base es una entidad y el vínculo es
// `drones.base_id`; las de `users` nunca tuvieron uso después de que los drones
// dejaran de ser cuentas. Se borran recién acá, cuando las migraciones de
// arriba ya promovieron lo que había.
for (const tabla of ['drones', 'users']) {
  const cols = (db.prepare(`PRAGMA table_info(${tabla})`).all() as { name: string }[]).map((c) => c.name);
  for (const col of ['base_name', 'base_lat', 'base_lon']) {
    if (cols.includes(col)) db.exec(`ALTER TABLE ${tabla} DROP COLUMN ${col}`);
  }
}
