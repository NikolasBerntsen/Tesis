import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { seed, startServer, login, api, connectWs, CREDS, type TestServer, type WsClient } from '../helpers';

// Comandos de patrullaje y renombres. El dron1 se conecta por WS para verificar
// que las órdenes le llegan (delivered=true); el dron2 queda offline para el
// caso delivered=false.
describe('integración — comandos de ruta y renombres', () => {
  let srv: TestServer;
  let op = '';
  let drone1: WsClient;
  let operWs: WsClient;

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    const d1 = (await login(srv.base, 'drone1', CREDS.drone1))!;
    drone1 = await connectWs(srv.wsUrl, d1);
    operWs = await connectWs(srv.wsUrl, op);
  });
  afterAll(async () => {
    await drone1.close();
    await operWs.close();
    await srv.close();
  });

  it('comenzar ruta llega al dron conectado (delivered=true)', async () => {
    const r = await api(srv.base, '/api/drones/drone1/route/start', op, {
      method: 'POST',
      body: JSON.stringify({ routeId: 1, fromIndex: 1 }),
    });
    expect(r.status).toBe(200);
    expect(r.body.delivered).toBe(true);
    const msg = await drone1.waitFor((m) => m.type === 'start_route');
    expect(msg.routeId).toBe(1);
    expect(msg.fromIndex).toBe(1);
    expect(msg.orderedBy).toBe('operador');
  });

  it('comenzar ruta a un dron offline responde delivered=false', async () => {
    const r = await api(srv.base, '/api/drones/drone2/route/start', op, {
      method: 'POST',
      body: JSON.stringify({ routeId: 1 }),
    });
    expect(r.status).toBe(200);
    expect(r.body.delivered).toBe(false);
  });

  it('comenzar ruta: dron inexistente 404, ruta inexistente 404, fromIndex fuera de rango 400', async () => {
    expect(
      (await api(srv.base, '/api/drones/fantasma/route/start', op, { method: 'POST', body: JSON.stringify({ routeId: 1 }) }))
        .status,
    ).toBe(404);
    expect(
      (await api(srv.base, '/api/drones/drone1/route/start', op, { method: 'POST', body: JSON.stringify({ routeId: 999 }) }))
        .status,
    ).toBe(404);
    expect(
      (
        await api(srv.base, '/api/drones/drone1/route/start', op, {
          method: 'POST',
          body: JSON.stringify({ routeId: 1, fromIndex: 99 }),
        })
      ).status,
    ).toBe(400);
  });

  it('interrumpir patrullaje llega al dron; dron inexistente 404', async () => {
    const r = await api(srv.base, '/api/drones/drone1/route/stop', op, { method: 'POST' });
    expect(r.status).toBe(200);
    await drone1.waitFor((m) => m.type === 'stop_patrol');
    expect((await api(srv.base, '/api/drones/fantasma/route/stop', op, { method: 'POST' })).status).toBe(404);
  });

  it('reanudar sin fromIndex manda resume_patrol sin índice', async () => {
    const before = drone1.got.length;
    const r = await api(srv.base, '/api/drones/drone1/resume', op, { method: 'POST' });
    expect(r.status).toBe(200);
    const msg = await drone1.waitFor((m, ) => m.type === 'resume_patrol', 3000);
    expect(msg).toBeDefined();
    // el más reciente no debería traer fromIndex
    const nuevos = drone1.got.slice(before).filter((m) => m.type === 'resume_patrol');
    expect(nuevos[nuevos.length - 1].fromIndex).toBeUndefined();
  });

  it('reanudar desde un nodo elegido incluye fromIndex', async () => {
    const r = await api(srv.base, '/api/drones/drone1/resume', op, {
      method: 'POST',
      body: JSON.stringify({ fromIndex: 3 }),
    });
    expect(r.status).toBe(200);
    await drone1.waitFor((m) => m.type === 'resume_patrol' && m.fromIndex === 3);
  });

  it('reanudar en dron inexistente da 404', async () => {
    expect((await api(srv.base, '/api/drones/fantasma/resume', op, { method: 'POST' })).status).toBe(404);
  });

  it('forzar vuelo a un nodo (goto) llega al dron', async () => {
    const r = await api(srv.base, '/api/drones/drone1/goto', op, {
      method: 'POST',
      body: JSON.stringify({ routeId: 1, index: 2 }),
    });
    expect(r.status).toBe(200);
    await drone1.waitFor((m) => m.type === 'force_goto' && m.index === 2);
  });

  it('goto a nodo o dron inexistente da 404', async () => {
    expect(
      (await api(srv.base, '/api/drones/drone1/goto', op, { method: 'POST', body: JSON.stringify({ routeId: 1, index: 99 }) }))
        .status,
    ).toBe(404);
    expect(
      (await api(srv.base, '/api/drones/fantasma/goto', op, { method: 'POST', body: JSON.stringify({ routeId: 1, index: 0 }) }))
        .status,
    ).toBe(404);
  });

  it('PATCH renombra un dron desde la web y el dron recibe "renamed"', async () => {
    const r = await api(srv.base, '/api/drones/drone1', op, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Alfa-Web' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.displayName).toBe('Alfa-Web');
    await drone1.waitFor((m) => m.type === 'renamed' && m.displayName === 'Alfa-Web');
    await operWs.waitFor((m) => m.type === 'drone_renamed' && m.displayName === 'Alfa-Web');
  });

  it('PATCH de dron: displayName vacío 400, muy largo 400, dron inexistente 404', async () => {
    expect(
      (await api(srv.base, '/api/drones/drone1', op, { method: 'PATCH', body: JSON.stringify({ displayName: '  ' }) })).status,
    ).toBe(400);
    expect(
      (await api(srv.base, '/api/drones/drone1', op, { method: 'PATCH', body: JSON.stringify({ displayName: 'x'.repeat(41) }) }))
        .status,
    ).toBe(400);
    expect(
      (await api(srv.base, '/api/drones/fantasma', op, { method: 'PATCH', body: JSON.stringify({ displayName: 'X' }) })).status,
    ).toBe(404);
  });

  it('PATCH apodo de nodo: pone, borra y emite route_updated', async () => {
    const set = await api(srv.base, '/api/routes/1/waypoints/0', op, {
      method: 'PATCH',
      body: JSON.stringify({ label: 'Portón Norte' }),
    });
    expect(set.status).toBe(200);
    expect(set.body.waypoints[0].label).toBe('Portón Norte');
    await operWs.waitFor((m) => m.type === 'route_updated');

    const clear = await api(srv.base, '/api/routes/1/waypoints/0', op, { method: 'PATCH', body: JSON.stringify({ label: '' }) });
    expect(clear.body.waypoints[0].label).toBeUndefined();
  });

  it('PATCH apodo: >40 chars 400, ruta inexistente 404, nodo inexistente 404', async () => {
    expect(
      (await api(srv.base, '/api/routes/1/waypoints/0', op, { method: 'PATCH', body: JSON.stringify({ label: 'x'.repeat(41) }) }))
        .status,
    ).toBe(400);
    expect(
      (await api(srv.base, '/api/routes/999/waypoints/0', op, { method: 'PATCH', body: JSON.stringify({ label: 'x' }) })).status,
    ).toBe(404);
    expect(
      (await api(srv.base, '/api/routes/1/waypoints/99', op, { method: 'PATCH', body: JSON.stringify({ label: 'x' }) })).status,
    ).toBe(404);
  });
});
