import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { seed, startServer, login, api, CREDS, type TestServer } from '../helpers';

// Verifica la jerarquía de roles: cada endpoint exige un rango mínimo y los
// flags/roles se evalúan en vivo. Solo lecturas y chequeos de permiso.
describe('integración — jerarquía de roles', () => {
  let srv: TestServer;
  let op = '';
  let sup = '';
  let adm = '';
  let dron = '';

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    dron = (await login(srv.base, 'drone1', CREDS.drone1))!;
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

  it('operador+ ve /drones, pero un dron NO', async () => {
    expect((await api(srv.base, '/api/drones', op)).status).toBe(200);
    expect((await api(srv.base, '/api/drones', sup)).status).toBe(200);
    expect((await api(srv.base, '/api/drones', dron)).status).toBe(403);
  });

  it('operador+ ve /events (log de drones)', async () => {
    expect((await api(srv.base, '/api/events', op)).status).toBe(200);
    expect((await api(srv.base, '/api/events', dron)).status).toBe(403);
  });

  it('un operador NO accede a /users (necesita supervisor+)', async () => {
    expect((await api(srv.base, '/api/users', op)).status).toBe(403);
  });

  it('supervisor ve /users pero solo operadores; admin ve todos los humanos', async () => {
    const vistaSup = await api(srv.base, '/api/users', sup);
    expect(vistaSup.status).toBe(200);
    expect(vistaSup.body.every((u: any) => u.role === 'operator')).toBe(true);

    const vistaAdm = await api(srv.base, '/api/users', adm);
    const roles = new Set(vistaAdm.body.map((u: any) => u.role));
    expect(roles.has('operator')).toBe(true);
    expect(roles.has('supervisor')).toBe(true);
    expect(roles.has('admin')).toBe(true);
    // nunca aparecen las cuentas de dron
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

  it('un operador sin canControl NO renombra nodos si... (label lo permite a operador+)', async () => {
    // PATCH waypoint exige operador: el dron no puede
    expect(
      (await api(srv.base, '/api/routes/1/waypoints/0', dron, { method: 'PATCH', body: JSON.stringify({ label: 'x' }) }))
        .status,
    ).toBe(403);
  });
});
