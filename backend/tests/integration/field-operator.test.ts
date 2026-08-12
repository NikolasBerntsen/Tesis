import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { seed, startServer, login, api, connectWs, CREDS, DRON, type TestServer } from '../helpers';
import { config } from '../../src/config';

// El operador de campo hace el primer despliegue y se va: sesión efímera, alta
// de drones y emparejamiento, pero nada de operación.
describe('integración — sesión efímera del operador de campo', () => {
  let srv: TestServer;
  let adm = '';

  beforeAll(async () => {
    seed();
    srv = await startServer();
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
  });
  afterAll(async () => {
    await srv.close();
  });

  it('el flujo completo: login, alta, emparejamiento y cierre de la sesión', async () => {
    const acceso = await api(srv.base, '/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ username: 'campo', password: CREDS.campo }),
    });
    expect(acceso.status).toBe(200);
    // el cliente usa expiresIn para la cuenta regresiva
    expect(acceso.body.expiresIn).toBe(20 * 60);
    const tok = acceso.body.token;

    expect((await api(srv.base, '/api/me', tok)).body).toEqual({ username: 'campo', role: 'field_operator', canControl: false });

    const alta = await api(srv.base, '/api/drones', tok, {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Despliegue', model: 'DJI Mini 4' }),
    });
    expect(alta.status).toBe(201);

    const par = await api(srv.base, '/api/drones/pair', tok, {
      method: 'POST',
      body: JSON.stringify({ hash: alta.body.hash, lat: -34.85, lon: -56.2, accuracyM: 5, deviceModel: 'Pixel 7a' }),
    });
    expect(par.status).toBe(200);

    const cierre = await api(srv.base, '/api/auth/logout', tok, {
      method: 'POST',
      body: JSON.stringify({ motivo: 'emparejamiento completado' }),
    });
    expect(cierre.status).toBe(200);
    expect(cierre.body.ok).toBe(true);
    expect(cierre.body.event.type).toBe('FIELD_SESSION_CLOSED');
    expect(cierre.body.event.category).toBe('sistema');
    expect(JSON.parse(cierre.body.event.meta).detalle).toEqual({ por: 'campo', motivo: 'emparejamiento completado' });

    // el cierre queda en el registro general
    const logs = (await api(srv.base, '/api/logs?category=sistema&pageSize=100', adm)).body.items;
    expect(logs.some((l: any) => l.type === 'FIELD_SESSION_CLOSED' && l.source === 'campo')).toBe(true);
  });

  it('sin motivo, el cierre se registra con el texto por defecto', async () => {
    const tok = (await login(srv.base, 'campo', CREDS.campo))!;
    const r = await api(srv.base, '/api/auth/logout', tok, { method: 'POST', body: JSON.stringify({}) });
    expect(JSON.parse(r.body.event.meta).detalle.motivo).toBe('cierre de sesión');
  });

  it('el operador de campo no opera drones ni ve alertas, eventos o usuarios', async () => {
    const tok = (await login(srv.base, 'campo', CREDS.campo))!;
    const prohibidos: [string, string, string?][] = [
      ['POST', `/api/drones/${DRON.alfa}/control`],
      ['POST', `/api/drones/${DRON.alfa}/route/start`, JSON.stringify({ routeId: 1 })],
      ['POST', `/api/drones/${DRON.alfa}/route/stop`],
      ['POST', `/api/drones/${DRON.alfa}/resume`],
      ['POST', `/api/drones/${DRON.alfa}/goto`, JSON.stringify({ routeId: 1, index: 0 })],
      ['POST', `/api/drones/${DRON.alfa}/manual_move`, JSON.stringify({ bearing: 0, distanceM: 10 })],
      ['PATCH', `/api/drones/${DRON.alfa}`, JSON.stringify({ displayName: 'Nope' })],
      ['DELETE', `/api/drones/${DRON.alfa}`],
      ['GET', '/api/alerts'],
      ['GET', '/api/events'],
      ['GET', '/api/users'],
      ['GET', '/api/logs'],
      ['PATCH', '/api/routes/1/waypoints/0', JSON.stringify({ label: 'x' })],
    ];
    for (const [method, path, body] of prohibidos) {
      const r = await api(srv.base, path, tok, { method, body });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });

  it('la sesión vencida deja de servir: el backend responde 401', async () => {
    const vencido = jwt.sign({ sub: 'campo', role: 'field_operator' }, config.jwtSecret, { expiresIn: -10 });
    const r = await api(srv.base, '/api/drones', vencido);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/token/i);
  });

  it('mientras la sesión vive, la consola de campo recibe las novedades de drones por WS', async () => {
    const tok = (await login(srv.base, 'campo', CREDS.campo))!;
    const ws = await connectWs(srv.wsUrl, tok);
    const alta = await api(srv.base, '/api/drones', tok, { method: 'POST', body: JSON.stringify({ displayName: 'Aviso' }) });
    await ws.waitFor((m) => m.type === 'drone_updated' && m.drone.hash === alta.body.hash);
    await ws.close();
  });
});
