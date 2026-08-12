import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seed, startServer, login, api, limpiarBase, CREDS, DRON, type TestServer } from '../helpers';
import { createLog } from '../../src/store';

// Registro general paginado y filtrado EN EL BACKEND: la consola pide una
// página y el servidor le devuelve items + total.
describe('integración — registro paginado', () => {
  let srv: TestServer;
  let adm = '';

  const TOTAL_DRONE = 60;
  const TOTAL_USUARIOS = 30;
  const TOTAL_SISTEMA = 5;
  const TOTAL = TOTAL_DRONE + TOTAL_USUARIOS + TOTAL_SISTEMA;

  beforeAll(async () => {
    seed();
    srv = await startServer();
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
  });
  afterAll(async () => {
    await srv.close();
  });

  // Se intercalan las categorías a propósito: si el filtro se aplicara en
  // memoria sobre una página ya recortada, la primera página de "usuarios"
  // vendría incompleta y el total sería el de todas las categorías.
  beforeEach(() => {
    limpiarBase();
    seed();
    for (let i = 1; i <= TOTAL_DRONE; i++) {
      createLog('drone', 'DRONE_CONNECTED', 'backend', `conexión ${i}`, { droneId: i % 2 === 0 ? DRON.alfa : DRON.bravo });
      if (i % 2 === 0) createLog('usuarios', 'USER_UPDATED', 'admin', `cambio de usuario ${i / 2}`);
    }
    for (let i = 1; i <= TOTAL_SISTEMA; i++) createLog('sistema', 'LOGIN', 'admin', `sesión ${i}`);
  });

  const logs = (query: string, token = adm) => api(srv.base, `/api/logs${query}`, token);

  it('sin parámetros devuelve la primera página de 25 con el total real', async () => {
    const r = await logs('');
    expect(r.status).toBe(200);
    expect(r.body.page).toBe(1);
    expect(r.body.pageSize).toBe(25);
    expect(r.body.items).toHaveLength(25);
    expect(r.body.total).toBe(TOTAL);
    // más reciente primero
    expect(r.body.items[0].message).toBe(`sesión ${TOTAL_SISTEMA}`);
  });

  it('las páginas no se pisan y la última trae el resto', async () => {
    const p1 = (await logs('?page=1&pageSize=50')).body;
    const p2 = (await logs('?page=2&pageSize=50')).body;
    expect(p1.items).toHaveLength(50);
    expect(p2.items).toHaveLength(TOTAL - 50);
    const ids = new Set([...p1.items, ...p2.items].map((e: any) => e.id));
    expect(ids.size).toBe(TOTAL);
    // una página más allá del final viene vacía pero con el total correcto
    const p9 = (await logs('?page=9&pageSize=50')).body;
    expect(p9.items).toHaveLength(0);
    expect(p9.total).toBe(TOTAL);
  });

  it('acepta los cuatro tamaños del contrato y cae a 25 con cualquier otro', async () => {
    for (const n of [25, 50, 75, 100]) {
      const r = await logs(`?page=1&pageSize=${n}`);
      expect(r.body.pageSize).toBe(n);
      expect(r.body.items).toHaveLength(Math.min(n, TOTAL));
    }
    for (const malo of ['10', '0', '-5', '1000', 'muchos', '']) {
      expect((await logs(`?page=1&pageSize=${malo}`)).body.pageSize, malo).toBe(25);
    }
  });

  it('una página inválida cae a la primera', async () => {
    for (const malo of ['0', '-3', 'abc', '']) {
      const r = await logs(`?page=${malo}&pageSize=25`);
      expect(r.body.page, malo).toBe(1);
      expect(r.body.items).toHaveLength(25);
    }
  });

  it('el filtro por categoría se resuelve en SQL: página completa y total de la categoría', async () => {
    const r = await logs('?category=usuarios&page=1&pageSize=25');
    expect(r.body.total).toBe(TOTAL_USUARIOS);
    expect(r.body.items).toHaveLength(25);
    expect(r.body.items.every((e: any) => e.category === 'usuarios')).toBe(true);

    const p2 = (await logs('?category=usuarios&page=2&pageSize=25')).body;
    expect(p2.items).toHaveLength(TOTAL_USUARIOS - 25);

    expect((await logs('?category=drone')).body.total).toBe(TOTAL_DRONE);
    expect((await logs('?category=sistema')).body.total).toBe(TOTAL_SISTEMA);
  });

  it('una categoría desconocida o vacía trae todas', async () => {
    expect((await logs('?category=inventada')).body.total).toBe(TOTAL);
    expect((await logs('?category=')).body.total).toBe(TOTAL);
  });

  it('filtra por dron y por texto libre, y combina los filtros', async () => {
    expect((await logs(`?droneId=${DRON.alfa}`)).body.total).toBe(TOTAL_DRONE / 2);
    expect((await logs('?q=conexión 7')).body.total).toBe(1);
    expect((await logs('?q=USER_UPDATED')).body.total).toBe(TOTAL_USUARIOS);
    expect((await logs('?q=backend')).body.total).toBe(TOTAL_DRONE);
    expect((await logs(`?category=drone&droneId=${DRON.bravo}&q=conexión 13`)).body.total).toBe(1);
    // el mismo texto con el dron equivocado no trae nada
    expect((await logs(`?droneId=${DRON.alfa}&q=conexión 13`)).body.total).toBe(0);
    expect((await logs('?q=no existe nada así')).body.total).toBe(0);
  });

  it('solo el administrador ve el registro general', async () => {
    const op = (await login(srv.base, 'operador', CREDS.operador))!;
    const sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    expect((await logs('', op)).status).toBe(403);
    expect((await logs('', sup)).status).toBe(403);
    expect((await api(srv.base, '/api/logs', null)).status).toBe(401);
  });

  // El OFFSET viaja a SQLite como entero: un page enorme lo sacaba de rango y
  // la ruta respondía 500 en vez de una página vacía.
  it('una página absurdamente grande no rompe el servidor', async () => {
    for (const page of ['1e19', '1e30']) {
      const r = await logs(`?page=${page}&pageSize=25`);
      expect(r.status, page).toBe(200);
      expect(r.body.items).toHaveLength(0);
      expect(r.body.total).toBe(TOTAL);
    }
  });
});

// El log de drones que consumen los operadores.
describe('integración — log de drones (/api/events)', () => {
  let srv: TestServer;
  let op = '';

  beforeAll(async () => {
    limpiarBase();
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    for (let i = 1; i <= 5; i++) createLog('drone', 'LANDED', 'backend', `aterrizaje ${i}`, { droneId: DRON.alfa });
    createLog('usuarios', 'USER_CREATED', 'admin', 'alta', {});
  });
  afterAll(async () => {
    await srv.close();
  });

  it('devuelve solo la categoría drone y respeta limit y droneId', async () => {
    const todos = (await api(srv.base, '/api/events', op)).body;
    expect(todos).toHaveLength(5);
    expect(todos.every((e: any) => e.category === 'drone')).toBe(true);
    expect((await api(srv.base, '/api/events?limit=2', op)).body).toHaveLength(2);
    expect((await api(srv.base, `/api/events?droneId=${DRON.alfa}`, op)).body).toHaveLength(5);
    expect((await api(srv.base, `/api/events?droneId=${DRON.bravo}`, op)).body).toHaveLength(0);
  });

  // Un limit de basura llegaba como NaN al LIMIT de SQL y la ruta respondía 500.
  it('un limit inválido cae al valor por defecto y uno fraccionario se trunca', async () => {
    for (const malo of ['abc', '', '0', '-3']) {
      const r = await api(srv.base, `/api/events?limit=${malo}`, op);
      expect(r.status, malo).toBe(200);
      expect(r.body, malo).toHaveLength(5);
    }
    expect((await api(srv.base, '/api/events?limit=1.5', op)).body).toHaveLength(1);
    // el techo se respeta igual: pedir de más no trae más de lo que hay
    expect((await api(srv.base, '/api/events?limit=99999', op)).body).toHaveLength(5);
  });
});
