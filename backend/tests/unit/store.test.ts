import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../src/db';
import {
  toUserView,
  getUser,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  getDroneIdentity,
  listDroneIdentities,
  renameDrone,
  getRoutes,
  getRoute,
  setWaypointLabel,
  createLog,
  createEvent,
  listEvents,
  listLogs,
  createAlert,
  getAlert,
  listAlerts,
  decideAlert,
  type UserRow,
} from '../../src/store';

// Inserta un usuario crudo en la base (sin pasar por la API).
function insertUser(over: Partial<UserRow> & { username: string }) {
  db.prepare(
    `INSERT INTO users (username, password_hash, role, display_name, base_name, base_lat, base_lon, active, can_control)
     VALUES (@username, @password_hash, @role, @display_name, @base_name, @base_lat, @base_lon, @active, @can_control)`,
  ).run({
    password_hash: 'x',
    role: 'operator',
    display_name: null,
    base_name: null,
    base_lat: null,
    base_lon: null,
    active: 1,
    can_control: 1,
    ...over,
  });
}

function insertRoute(name: string, waypoints: object[]) {
  const info = db
    .prepare('INSERT INTO patrol_routes (name, description, waypoints) VALUES (?, ?, ?)')
    .run(name, 'desc', JSON.stringify(waypoints));
  return Number(info.lastInsertRowid);
}

// Los tests comparten la base en memoria del archivo: se limpia antes de cada uno.
beforeEach(() => {
  db.exec('DELETE FROM events; DELETE FROM alerts; DELETE FROM patrol_routes; DELETE FROM users; DELETE FROM sqlite_sequence;');
});

describe('store — usuarios', () => {
  it('toUserView convierte flags 0/1 a booleanos y oculta el hash', () => {
    const view = toUserView({
      id: 1,
      username: 'ana',
      password_hash: 'secreto',
      role: 'supervisor',
      display_name: null,
      base_name: null,
      base_lat: null,
      base_lon: null,
      active: 1,
      can_control: 0,
    });
    expect(view).toEqual({ username: 'ana', role: 'supervisor', active: true, canControl: false });
    expect(view).not.toHaveProperty('password_hash');
  });

  it('getUser devuelve la fila o undefined', () => {
    insertUser({ username: 'juan', role: 'admin' });
    expect(getUser('juan')?.role).toBe('admin');
    expect(getUser('nadie')).toBeUndefined();
  });

  it('listUsers filtra por los roles pedidos y ordena', () => {
    insertUser({ username: 'op1', role: 'operator' });
    insertUser({ username: 'sup1', role: 'supervisor' });
    insertUser({ username: 'adm1', role: 'admin' });
    insertUser({ username: 'drx', role: 'drone' });

    const soloOperadores = listUsers(['operator']);
    expect(soloOperadores.map((u) => u.username)).toEqual(['op1']);

    const humanos = listUsers(['operator', 'supervisor', 'admin']);
    expect(humanos.map((u) => u.username).sort()).toEqual(['adm1', 'op1', 'sup1']);
    expect(humanos.some((u) => u.username === 'drx')).toBe(false);
  });

  it('createUser inserta y devuelve la vista con canControl', () => {
    const conControl = createUser('c1', 'h', 'operator', true);
    expect(conControl).toEqual({ username: 'c1', role: 'operator', active: true, canControl: true });
    const sinControl = createUser('c2', 'h', 'supervisor', false);
    expect(sinControl.canControl).toBe(false);
    expect(getUser('c1')).toBeDefined();
  });

  it('updateUser devuelve antes/después y respeta COALESCE (undefined no pisa)', () => {
    createUser('u', 'hash-original', 'operator', true);
    const r = updateUser('u', { canControl: false });
    expect(r?.before.canControl).toBe(true);
    expect(r?.after.canControl).toBe(false);
    // active no se tocó
    expect(r?.after.active).toBe(true);
    // el hash original sigue si no se manda passwordHash
    expect(getUser('u')?.password_hash).toBe('hash-original');
  });

  it('updateUser cambia active y password_hash cuando se piden', () => {
    createUser('u2', 'viejo', 'operator', true);
    const r = updateUser('u2', { active: false, passwordHash: 'nuevo' });
    expect(r?.after.active).toBe(false);
    expect(getUser('u2')?.password_hash).toBe('nuevo');
  });

  it('updateUser sobre un usuario inexistente devuelve undefined', () => {
    expect(updateUser('fantasma', { active: false })).toBeUndefined();
  });

  it('deleteUser devuelve la vista borrada, o undefined si no existía', () => {
    createUser('borrar', 'h', 'operator', true);
    expect(deleteUser('borrar')?.username).toBe('borrar');
    expect(getUser('borrar')).toBeUndefined();
    expect(deleteUser('borrar')).toBeUndefined();
  });
});

describe('store — drones', () => {
  it('getDroneIdentity arma base y displayName cuando están completos', () => {
    insertUser({
      username: 'drone1',
      role: 'drone',
      display_name: 'Alfa',
      base_name: 'Base Norte',
      base_lat: -34.85,
      base_lon: -56.2,
    });
    const id = getDroneIdentity('drone1');
    expect(id).toEqual({ droneId: 'drone1', displayName: 'Alfa', base: { name: 'Base Norte', lat: -34.85, lon: -56.2 } });
  });

  it('displayName cae al username y base.name a "Base" si faltan', () => {
    insertUser({ username: 'drone2', role: 'drone', display_name: null, base_name: null, base_lat: 1, base_lon: 2 });
    const id = getDroneIdentity('drone2');
    expect(id?.displayName).toBe('drone2');
    expect(id?.base).toEqual({ name: 'Base', lat: 1, lon: 2 });
  });

  it('base es null si falta lat o lon', () => {
    insertUser({ username: 'drone3', role: 'drone', base_lat: 1, base_lon: null });
    expect(getDroneIdentity('drone3')?.base).toBeNull();
  });

  it('getDroneIdentity no devuelve usuarios que no son drones', () => {
    insertUser({ username: 'humano', role: 'operator' });
    expect(getDroneIdentity('humano')).toBeUndefined();
    expect(getDroneIdentity('inexistente')).toBeUndefined();
  });

  it('listDroneIdentities lista solo drones ordenados', () => {
    insertUser({ username: 'dz', role: 'drone' });
    insertUser({ username: 'da', role: 'drone' });
    insertUser({ username: 'op', role: 'operator' });
    expect(listDroneIdentities().map((d) => d.droneId)).toEqual(['da', 'dz']);
  });

  it('renameDrone actualiza el displayName y devuelve undefined si no es dron', () => {
    insertUser({ username: 'drone1', role: 'drone', display_name: 'Alfa' });
    expect(renameDrone('drone1', 'Alfa-2')?.displayName).toBe('Alfa-2');
    expect(renameDrone('noexiste', 'X')).toBeUndefined();
    insertUser({ username: 'op', role: 'operator' });
    expect(renameDrone('op', 'X')).toBeUndefined();
  });
});

describe('store — rutas y waypoints', () => {
  it('getRoutes y getRoute parsean los waypoints', () => {
    const id = insertRoute('R1', [{ lat: 1, lon: 2, alt: 3 }]);
    const all = getRoutes();
    expect(all).toHaveLength(1);
    expect(all[0].waypoints[0]).toEqual({ lat: 1, lon: 2, alt: 3 });
    expect(getRoute(id)?.name).toBe('R1');
    expect(getRoute(9999)).toBeUndefined();
  });

  it('setWaypointLabel pone y borra el apodo de un nodo', () => {
    const id = insertRoute('R', [
      { lat: 1, lon: 1, alt: 10 },
      { lat: 2, lon: 2, alt: 10 },
    ]);
    const conApodo = setWaypointLabel(id, 1, 'Portón');
    expect(conApodo?.waypoints[1].label).toBe('Portón');
    // persiste
    expect(getRoute(id)?.waypoints[1].label).toBe('Portón');
    // label vacío borra
    const sinApodo = setWaypointLabel(id, 1, '');
    expect(sinApodo?.waypoints[1].label).toBeUndefined();
    expect(getRoute(id)?.waypoints[1]).not.toHaveProperty('label');
  });

  it('setWaypointLabel devuelve undefined si la ruta o el nodo no existen', () => {
    const id = insertRoute('R', [{ lat: 1, lon: 1, alt: 10 }]);
    expect(setWaypointLabel(9999, 0, 'x')).toBeUndefined();
    expect(setWaypointLabel(id, 5, 'x')).toBeUndefined();
  });
});

describe('store — logs y eventos', () => {
  it('createLog guarda meta como JSON y devuelve la fila', () => {
    const ev = createLog('usuarios', 'USER_UPDATED', 'admin', 'cambió algo', {
      meta: { antes: { a: 1 }, despues: { a: 2 } },
    });
    expect(ev.category).toBe('usuarios');
    expect(ev.id).toBeGreaterThan(0);
    expect(JSON.parse(ev.meta!)).toEqual({ antes: { a: 1 }, despues: { a: 2 } });
    // sin meta queda null
    const ev2 = createLog('sistema', 'LOGIN', 'x', 'msg');
    expect(ev2.meta).toBeNull();
    expect(ev2.drone_id).toBeNull();
    expect(ev2.alert_id).toBeNull();
  });

  it('createEvent es un atajo de categoría drone', () => {
    const ev = createEvent('DRONE_CONNECTED', 'backend', 'conectado', 'drone1', null);
    expect(ev.category).toBe('drone');
    expect(ev.drone_id).toBe('drone1');
  });

  it('listEvents solo trae categoría drone y filtra por droneId', () => {
    createEvent('A', 'backend', 'm', 'drone1');
    createEvent('B', 'backend', 'm', 'drone2');
    createLog('usuarios', 'USER_CREATED', 'admin', 'm');
    createLog('sistema', 'LOGIN', 'admin', 'm');

    const todos = listEvents(500);
    expect(todos.every((e) => e.category === 'drone')).toBe(true);
    expect(todos).toHaveLength(2);

    const soloD1 = listEvents(500, 'drone1');
    expect(soloD1).toHaveLength(1);
    expect(soloD1[0].drone_id).toBe('drone1');
  });

  it('listEvents respeta el límite y ordena por id descendente', () => {
    for (let i = 0; i < 5; i++) createEvent('E', 'backend', `m${i}`, 'drone1');
    const dos = listEvents(2, 'drone1');
    expect(dos).toHaveLength(2);
    expect(dos[0].message).toBe('m4');
  });

  it('listLogs junta todas las categorías o filtra por una', () => {
    createEvent('A', 'backend', 'm', 'drone1');
    createLog('usuarios', 'USER_CREATED', 'admin', 'm');
    createLog('sistema', 'LOGIN', 'admin', 'm');

    const general = listLogs(500);
    const cats = new Set(general.map((l) => l.category));
    expect(cats).toEqual(new Set(['drone', 'usuarios', 'sistema']));

    const soloUsuarios = listLogs(500, 'usuarios');
    expect(soloUsuarios.every((l) => l.category === 'usuarios')).toBe(true);
    expect(soloUsuarios).toHaveLength(1);
  });
});

describe('store — alertas', () => {
  it('createAlert crea PENDING y getAlert la recupera', () => {
    const a = createAlert('PERSON', 'drone1', -34.8, -56.2, 'JPEG');
    expect(a.status).toBe('PENDING');
    expect(a.type).toBe('PERSON');
    expect(getAlert(a.id)?.snapshot).toBe('JPEG');
    expect(getAlert(9999)).toBeUndefined();
  });

  it('listAlerts filtra por estado o trae todas', () => {
    createAlert('PERSON', 'd', null, null, null);
    const v = createAlert('VEHICLE', 'd', null, null, null);
    decideAlert(v.id, 'VALIDATED', 'op');

    expect(listAlerts()).toHaveLength(2);
    expect(listAlerts('PENDING')).toHaveLength(1);
    expect(listAlerts('VALIDATED')).toHaveLength(1);
  });

  it('decideAlert solo aplica sobre alertas pendientes', () => {
    const a = createAlert('PERSON', 'd', null, null, null);
    const primera = decideAlert(a.id, 'DISMISSED', 'op');
    expect(primera?.status).toBe('DISMISSED');
    expect(primera?.decided_by).toBe('op');
    // segunda decisión sobre la misma alerta no cambia nada
    expect(decideAlert(a.id, 'VALIDATED', 'otro')).toBeUndefined();
    // alerta inexistente
    expect(decideAlert(9999, 'VALIDATED', 'op')).toBeUndefined();
  });
});
