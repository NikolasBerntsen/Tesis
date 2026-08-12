import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../src/db';
import { limpiarBase } from '../helpers';
import {
  toUserView,
  toDroneAssetView,
  getUser,
  getActiveUser,
  listUsers,
  createUser,
  updateUser,
  softDeleteUser,
  restoreUser,
  createDrone,
  getDrone,
  listDrones,
  updateDrone,
  softDeleteDrone,
  restoreDrone,
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
  TAMANIOS_PAGINA,
  createAlert,
  getAlert,
  listAlerts,
  decideAlert,
  type DroneAsset,
  type UserRow,
} from '../../src/store';

// Inserta un usuario crudo en la base (sin pasar por la API).
function insertUser(over: Partial<UserRow> & { username: string }) {
  db.prepare(
    `INSERT INTO users (username, password_hash, role, display_name, base_name, base_lat, base_lon, active, can_control, deleted_at)
     VALUES (@username, @password_hash, @role, @display_name, @base_name, @base_lat, @base_lon, @active, @can_control, @deleted_at)`,
  ).run({
    password_hash: 'x',
    role: 'operator',
    display_name: null,
    base_name: null,
    base_lat: null,
    base_lon: null,
    active: 1,
    can_control: 1,
    deleted_at: null,
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
beforeEach(limpiarBase);

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
      deleted_at: null,
      deleted_by: null,
    });
    expect(view).toEqual({ username: 'ana', role: 'supervisor', active: true, canControl: false, deletedAt: null });
    expect(view).not.toHaveProperty('password_hash');
  });

  it('getUser devuelve la fila (incluso borrada) y getActiveUser no', () => {
    insertUser({ username: 'juan', role: 'admin' });
    insertUser({ username: 'ida', deleted_at: '2020-01-01T00:00:00.000Z' });
    insertUser({ username: 'apagada', active: 0 });

    expect(getUser('juan')?.role).toBe('admin');
    expect(getUser('nadie')).toBeUndefined();
    expect(getUser('ida')).toBeDefined();

    expect(getActiveUser('juan')).toBeDefined();
    expect(getActiveUser('ida')).toBeUndefined();
    expect(getActiveUser('apagada')).toBeUndefined();
  });

  it('listUsers filtra por los roles pedidos, ordena y esconde los borrados', () => {
    insertUser({ username: 'op1', role: 'operator' });
    insertUser({ username: 'sup1', role: 'supervisor' });
    insertUser({ username: 'adm1', role: 'admin' });
    insertUser({ username: 'campo1', role: 'field_operator' });
    insertUser({ username: 'exop', role: 'operator', deleted_at: '2020-01-01T00:00:00.000Z' });

    expect(listUsers(['operator']).map((u) => u.username)).toEqual(['op1']);
    expect(listUsers(['operator'], { includeDeleted: true }).map((u) => u.username)).toEqual(['exop', 'op1']);

    const humanos = listUsers(['field_operator', 'operator', 'supervisor', 'admin']);
    expect(humanos.map((u) => u.username).sort()).toEqual(['adm1', 'campo1', 'op1', 'sup1']);
  });

  it('createUser inserta y devuelve la vista con canControl', () => {
    const conControl = createUser('c1', 'h', 'operator', true);
    expect(conControl).toEqual({ username: 'c1', role: 'operator', active: true, canControl: true, deletedAt: null });
    const sinControl = createUser('c2', 'h', 'field_operator', false);
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
    // y vuelve a activarse
    expect(updateUser('u2', { active: true })?.after.active).toBe(true);
  });

  it('updateUser sobre un usuario inexistente devuelve undefined', () => {
    expect(updateUser('fantasma', { active: false })).toBeUndefined();
  });

  it('softDeleteUser marca deleted_at, deja la fila y no se puede repetir', () => {
    createUser('borrar', 'h', 'operator', true);
    const r = softDeleteUser('borrar', 'admin');
    expect(r?.before.deletedAt).toBeNull();
    expect(r?.after.deletedAt).toBeTruthy();
    // la fila queda: el username sigue ocupado
    expect(getUser('borrar')).toBeDefined();
    expect(getUser('borrar')?.deleted_by).toBe('admin');
    expect(softDeleteUser('borrar', 'admin')).toBeUndefined();
    expect(softDeleteUser('fantasma', 'admin')).toBeUndefined();
  });

  it('restoreUser deshace el borrado lógico y solo aplica sobre borrados', () => {
    createUser('vuelve', 'h', 'operator', true);
    expect(restoreUser('vuelve')).toBeUndefined();
    softDeleteUser('vuelve', 'admin');
    const r = restoreUser('vuelve');
    expect(r?.before.deletedAt).toBeTruthy();
    expect(r?.after.deletedAt).toBeNull();
    expect(getUser('vuelve')?.deleted_by).toBeNull();
    expect(restoreUser('fantasma')).toBeUndefined();
  });
});

describe('store — drones como activos', () => {
  it('createDrone genera un hash de 32 hexa y devuelve la vista completa', () => {
    const d = createDrone({ displayName: 'Alfa', model: 'DJI Mini 3', base: { name: 'Base Norte', lat: -34.85, lon: -56.2 } }, 'campo');
    expect(d.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(d.displayName).toBe('Alfa');
    expect(d.model).toBe('DJI Mini 3');
    expect(d.active).toBe(true);
    expect(d.base).toEqual({ name: 'Base Norte', lat: -34.85, lon: -56.2 });
    expect(d.createdBy).toBe('campo');
    expect(d.deletedAt).toBeNull();

    // dos altas seguidas no comparten hash
    const otro = createDrone({ displayName: 'Bravo' }, 'campo');
    expect(otro.hash).not.toBe(d.hash);
    expect(otro.model).toBe('');
    expect(otro.base).toBeNull();
  });

  it('toDroneAssetView deja la base en null si falta lat o lon', () => {
    const fila: DroneAsset = {
      id: 1,
      hash: 'abc',
      display_name: 'X',
      model: '',
      active: 0,
      base_name: 'Base Norte',
      base_lat: -34.85,
      base_lon: null,
      created_at: '2020-01-01T00:00:00.000Z',
      created_by: null,
      deleted_at: null,
      deleted_by: null,
    };
    expect(toDroneAssetView(fila).base).toBeNull();
    expect(toDroneAssetView(fila).active).toBe(false);
    // sin nombre de base, cae a "Base"
    expect(toDroneAssetView({ ...fila, base_name: null, base_lon: -56.2 }).base).toEqual({ name: 'Base', lat: -34.85, lon: -56.2 });
  });

  it('getDrone devuelve el dron AUNQUE esté borrado; listDrones lo esconde', () => {
    const vivo = createDrone({ displayName: 'Vivo' }, 'campo');
    const muerto = createDrone({ displayName: 'Muerto' }, 'campo');
    softDeleteDrone(muerto.hash, 'supervisor');

    expect(getDrone(muerto.hash)?.deletedAt).toBeTruthy();
    expect(getDrone('no-existe')).toBeUndefined();
    expect(listDrones().map((d) => d.hash)).toEqual([vivo.hash]);
    expect(listDrones({ includeDeleted: true }).map((d) => d.displayName)).toEqual(['Muerto', 'Vivo']);
  });

  it('updateDrone aplica solo lo pedido y devuelve antes/después', () => {
    const d = createDrone({ displayName: 'Alfa', model: 'M1', base: { name: 'Norte', lat: 1, lon: 2 } }, 'campo');
    const r = updateDrone(d.hash, { displayName: 'Alfa-2' });
    expect(r?.before.displayName).toBe('Alfa');
    expect(r?.after.displayName).toBe('Alfa-2');
    // lo que no se manda no se toca
    expect(r?.after.model).toBe('M1');
    expect(r?.after.base).toEqual({ name: 'Norte', lat: 1, lon: 2 });

    expect(updateDrone(d.hash, { active: false })?.after.active).toBe(false);
    expect(updateDrone(d.hash, { model: 'M2' })?.after.model).toBe('M2');
  });

  it('updateDrone con base:null la borra y con un objeto la reemplaza', () => {
    const d = createDrone({ displayName: 'Alfa', base: { name: 'Norte', lat: 1, lon: 2 } }, 'campo');
    expect(updateDrone(d.hash, { base: { name: 'Sur', lat: 3, lon: 4 } })?.after.base).toEqual({ name: 'Sur', lat: 3, lon: 4 });
    expect(updateDrone(d.hash, { base: null })?.after.base).toBeNull();
  });

  it('updateDrone y renameDrone no tocan drones borrados ni inexistentes', () => {
    const d = createDrone({ displayName: 'Alfa' }, 'campo');
    softDeleteDrone(d.hash, 'supervisor');
    expect(updateDrone(d.hash, { displayName: 'X' })).toBeUndefined();
    expect(renameDrone(d.hash, 'X')).toBeUndefined();
    expect(updateDrone('fantasma', { displayName: 'X' })).toBeUndefined();
    expect(renameDrone('fantasma', 'X')).toBeUndefined();
  });

  it('softDeleteDrone y restoreDrone son idempotentes (undefined si es un no-op)', () => {
    const d = createDrone({ displayName: 'Alfa' }, 'campo');
    expect(restoreDrone(d.hash)).toBeUndefined();
    const borrado = softDeleteDrone(d.hash, 'supervisor');
    expect(borrado?.deletedAt).toBeTruthy();
    expect(borrado?.deletedBy).toBe('supervisor');
    expect(softDeleteDrone(d.hash, 'supervisor')).toBeUndefined();
    const restaurado = restoreDrone(d.hash);
    expect(restaurado?.deletedAt).toBeNull();
    expect(restaurado?.deletedBy).toBeNull();
    expect(softDeleteDrone('fantasma', 'supervisor')).toBeUndefined();
    expect(restoreDrone('fantasma')).toBeUndefined();
  });

  it('getDroneIdentity excluye borrados pero NO inactivos', () => {
    const activo = createDrone({ displayName: 'Alfa', base: { name: 'Base Norte', lat: -34.85, lon: -56.2 } }, 'campo');
    const inactivo = createDrone({ displayName: 'Bravo' }, 'campo');
    const borrado = createDrone({ displayName: 'Charlie' }, 'campo');
    updateDrone(inactivo.hash, { active: false });
    softDeleteDrone(borrado.hash, 'supervisor');

    expect(getDroneIdentity(activo.hash)).toEqual({
      droneId: activo.hash,
      displayName: 'Alfa',
      base: { name: 'Base Norte', lat: -34.85, lon: -56.2 },
    });
    expect(getDroneIdentity(inactivo.hash)?.displayName).toBe('Bravo');
    expect(getDroneIdentity(borrado.hash)).toBeUndefined();
    expect(getDroneIdentity('fantasma')).toBeUndefined();
  });

  it('listDroneIdentities ordena por nombre y omite los borrados', () => {
    createDrone({ displayName: 'Zulu' }, 'campo');
    createDrone({ displayName: 'alfa' }, 'campo');
    const fuera = createDrone({ displayName: 'Bravo' }, 'campo');
    softDeleteDrone(fuera.hash, 'supervisor');
    expect(listDroneIdentities().map((d) => d.displayName)).toEqual(['alfa', 'Zulu']);
  });

  it('renameDrone actualiza el displayName y devuelve la identidad nueva', () => {
    const d = createDrone({ displayName: 'Alfa' }, 'campo');
    expect(renameDrone(d.hash, 'Alfa-2')?.displayName).toBe('Alfa-2');
    expect(getDrone(d.hash)?.displayName).toBe('Alfa-2');
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
    const ev = createEvent('DRONE_CONNECTED', 'backend', 'conectado', 'abc123', null);
    expect(ev.category).toBe('drone');
    expect(ev.drone_id).toBe('abc123');
  });

  it('listEvents solo trae categoría drone y filtra por droneId', () => {
    createEvent('A', 'backend', 'm', 'd1');
    createEvent('B', 'backend', 'm', 'd2');
    createLog('usuarios', 'USER_CREATED', 'admin', 'm');
    createLog('sistema', 'LOGIN', 'admin', 'm');

    const todos = listEvents(500);
    expect(todos.every((e) => e.category === 'drone')).toBe(true);
    expect(todos).toHaveLength(2);

    const soloD1 = listEvents(500, 'd1');
    expect(soloD1).toHaveLength(1);
    expect(soloD1[0].drone_id).toBe('d1');
  });

  it('listEvents respeta el límite y ordena por id descendente', () => {
    for (let i = 0; i < 5; i++) createEvent('E', 'backend', `m${i}`, 'd1');
    const dos = listEvents(2, 'd1');
    expect(dos).toHaveLength(2);
    expect(dos[0].message).toBe('m4');
  });
});

describe('store — registro paginado (listLogs)', () => {
  beforeEach(() => {
    for (let i = 1; i <= 30; i++) createEvent('DRONE_CONNECTED', 'backend', `dron ${i}`, 'd1');
    for (let i = 1; i <= 5; i++) createLog('usuarios', 'USER_CREATED', 'admin', `usuario ${i}`);
    createLog('sistema', 'LOGIN', 'admin', 'admin inició sesión');
  });

  it('pagina con el tamaño pedido y devuelve el total sin paginar', () => {
    const p1 = listLogs({ page: 1, pageSize: 25 });
    expect(p1.items).toHaveLength(25);
    expect(p1.total).toBe(36);
    expect(p1.page).toBe(1);
    expect(p1.pageSize).toBe(25);
    // más reciente primero
    expect(p1.items[0].type).toBe('LOGIN');

    const p2 = listLogs({ page: 2, pageSize: 25 });
    expect(p2.items).toHaveLength(11);
    expect(p2.total).toBe(36);
    // no se repiten filas entre páginas
    const ids = new Set([...p1.items, ...p2.items].map((e) => e.id));
    expect(ids.size).toBe(36);
  });

  it('acepta los cuatro tamaños del contrato y cae a 25 con cualquier otro', () => {
    expect(TAMANIOS_PAGINA).toEqual([25, 50, 75, 100]);
    for (const n of TAMANIOS_PAGINA) expect(listLogs({ page: 1, pageSize: n }).pageSize).toBe(n);
    expect(listLogs({ page: 1, pageSize: 33 }).pageSize).toBe(25);
    expect(listLogs({ page: 1, pageSize: 0 }).pageSize).toBe(25);
    expect(listLogs({ page: 1, pageSize: Number.NaN }).pageSize).toBe(25);
  });

  it('sanea la página: menor a 1 o no finita cae a 1, y una página vacía no rompe', () => {
    expect(listLogs({ page: 0, pageSize: 25 }).page).toBe(1);
    expect(listLogs({ page: -7, pageSize: 25 }).page).toBe(1);
    expect(listLogs({ page: Number.NaN, pageSize: 25 }).page).toBe(1);
    expect(listLogs({ page: 1.9, pageSize: 25 }).page).toBe(1);
    const lejos = listLogs({ page: 99, pageSize: 25 });
    expect(lejos.items).toHaveLength(0);
    expect(lejos.total).toBe(36);
  });

  it('filtra por categoría contando solo esa categoría', () => {
    const usuarios = listLogs({ category: 'usuarios', page: 1, pageSize: 25 });
    expect(usuarios.total).toBe(5);
    expect(usuarios.items.every((e) => e.category === 'usuarios')).toBe(true);
    expect(listLogs({ category: 'sistema', page: 1, pageSize: 25 }).total).toBe(1);
    expect(listLogs({ category: 'drone', page: 1, pageSize: 25 }).total).toBe(30);
  });

  it('filtra por dron y por texto libre en mensaje, tipo y origen', () => {
    createEvent('OTRO', 'backend', 'mensaje de otro dron', 'd2');
    expect(listLogs({ droneId: 'd2', page: 1, pageSize: 25 }).total).toBe(1);
    expect(listLogs({ q: 'dron 7', page: 1, pageSize: 25 }).total).toBe(1);
    expect(listLogs({ q: 'USER_CREATED', page: 1, pageSize: 25 }).total).toBe(5);
    expect(listLogs({ q: 'admin', page: 1, pageSize: 25 }).total).toBe(6);
    // categoría y texto se combinan con AND
    expect(listLogs({ category: 'usuarios', q: 'admin', page: 1, pageSize: 25 }).total).toBe(5);
  });

  it('escapa los comodines del texto buscado', () => {
    createLog('sistema', 'RARO', 'x', 'batería al 100%');
    createLog('sistema', 'RARO', 'x', 'batería al 10 por ciento');
    // sin escape, "100%" en un LIKE traería las dos
    expect(listLogs({ q: '100%', page: 1, pageSize: 25 }).total).toBe(1);
    // el guion bajo es comodín de un carácter en SQL
    createLog('sistema', 'RARO', 'x', 'nodo_1');
    expect(listLogs({ q: 'nodo_1', page: 1, pageSize: 25 }).total).toBe(1);
    expect(listLogs({ q: 'nodoX1', page: 1, pageSize: 25 }).total).toBe(0);
  });
});

describe('store — alertas', () => {
  it('createAlert crea PENDING y getAlert la recupera', () => {
    const a = createAlert('PERSON', 'd1', -34.8, -56.2, 'JPEG');
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
