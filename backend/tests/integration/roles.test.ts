import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { seed, startServer, login, api, tokenDeDron, CREDS, DRON, type TestServer } from '../helpers';

// Verifica la jerarquía de roles y los permisos laterales (el operador de campo
// no está por encima ni por debajo del de consola). Solo lecturas y chequeos.
describe('integración — jerarquía de roles', () => {
  let srv: TestServer;
  let campo = '';
  let op = '';
  let sup = '';
  let adm = '';
  let dron = '';

  beforeAll(async () => {
    seed();
    srv = await startServer();
    campo = (await login(srv.base, 'campo', CREDS.campo))!;
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    dron = tokenDeDron(DRON.alfa);
  });
  afterAll(async () => {
    await srv.close();
  });

  it('cualquier autenticado ve /routes', async () => {
    expect((await api(srv.base, '/api/routes', op)).status).toBe(200);
    expect((await api(srv.base, '/api/routes', dron)).status).toBe(200);
    const r = await api(srv.base, '/api/routes', adm);
    expect(r.body.length).toBe(3);
    expect(r.body[0].waypoints.length).toBeGreaterThan(0);
  });

  it('operador de campo, operador+ ven /drones, pero un dron NO', async () => {
    expect((await api(srv.base, '/api/drones', campo)).status).toBe(200);
    expect((await api(srv.base, '/api/drones', op)).status).toBe(200);
    expect((await api(srv.base, '/api/drones', sup)).status).toBe(200);
    expect((await api(srv.base, '/api/drones', dron)).status).toBe(403);
  });

  it('operador+ ve /events (log de drones); el de campo y el dron no', async () => {
    expect((await api(srv.base, '/api/events', op)).status).toBe(200);
    expect((await api(srv.base, '/api/events', campo)).status).toBe(403);
    expect((await api(srv.base, '/api/events', dron)).status).toBe(403);
  });

  it('un operador NO accede a /users (necesita supervisor+)', async () => {
    expect((await api(srv.base, '/api/users', op)).status).toBe(403);
    expect((await api(srv.base, '/api/users', campo)).status).toBe(403);
  });

  it('supervisor ve /users pero solo operadores; admin ve todos los humanos', async () => {
    const vistaSup = await api(srv.base, '/api/users', sup);
    expect(vistaSup.status).toBe(200);
    expect(vistaSup.body.every((u: any) => u.role === 'operator')).toBe(true);

    const vistaAdm = await api(srv.base, '/api/users', adm);
    const roles = new Set(vistaAdm.body.map((u: any) => u.role));
    expect(roles).toEqual(new Set(['field_operator', 'operator', 'supervisor', 'admin']));
    // los drones ya no son cuentas: nunca aparecen en /users
    expect(vistaAdm.body.some((u: any) => u.role === 'drone')).toBe(false);
  });

  it('un supervisor NO puede crear usuarios (necesita admin)', async () => {
    const r = await api(srv.base, '/api/users', sup, {
      method: 'POST',
      body: JSON.stringify({ username: 'nuevo', password: 'clave123' }),
    });
    expect(r.status).toBe(403);
  });

  it('un supervisor NO ve el log general /logs (necesita admin); el admin sí', async () => {
    expect((await api(srv.base, '/api/logs', sup)).status).toBe(403);
    expect((await api(srv.base, '/api/logs', op)).status).toBe(403);
    expect((await api(srv.base, '/api/logs', adm)).status).toBe(200);
  });

  it('el dron no puede renombrar nodos de ruta (hace falta operador+)', async () => {
    expect(
      (await api(srv.base, '/api/routes/1/waypoints/0', dron, { method: 'PATCH', body: JSON.stringify({ label: 'x' }) }))
        .status,
    ).toBe(403);
  });

  it('el operador de campo puede dar de alta y emparejar drones, pero no operarlos', async () => {
    expect((await api(srv.base, '/api/drones', campo, { method: 'POST', body: JSON.stringify({ displayName: 'Delta' }) })).status).toBe(201);
    expect(
      (await api(srv.base, '/api/drones/pair', campo, { method: 'POST', body: JSON.stringify({ hash: DRON.bravo }) })).status,
    ).toBe(200);
    // operar es de consola: el rango del de campo no llega
    expect((await api(srv.base, `/api/drones/${DRON.bravo}/route/stop`, campo, { method: 'POST' })).status).toBe(403);
  });

  it('un operador de consola no puede dar de alta ni emparejar drones', async () => {
    expect((await api(srv.base, '/api/drones', op, { method: 'POST', body: JSON.stringify({ displayName: 'Eco' }) })).status).toBe(403);
    expect(
      (await api(srv.base, '/api/drones/pair', op, { method: 'POST', body: JSON.stringify({ hash: DRON.bravo }) })).status,
    ).toBe(403);
  });
});
