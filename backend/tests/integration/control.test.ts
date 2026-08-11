import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { seed, startServer, login, api, connectWs, CREDS, type TestServer, type WsClient } from '../helpers';

// Control manual exclusivo: toma, movimiento, liberación (titular y forzada por
// supervisor), y cómo la suspensión/desactivación cortan el control en el acto.
describe('integración — control manual exclusivo', () => {
  let srv: TestServer;
  let op = '';
  let sup = '';
  let adm = '';
  let oper2 = '';
  let noControl = '';
  let drone1: WsClient;
  let operWs: WsClient;

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;

    // segundo operador con control y un operador sin control
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'oper2', password: 'oper2pass', role: 'operator', canControl: true }),
    });
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'sincontrol', password: 'sincontrol1', role: 'operator', canControl: false }),
    });
    oper2 = (await login(srv.base, 'oper2', 'oper2pass'))!;
    noControl = (await login(srv.base, 'sincontrol', 'sincontrol1'))!;

    const d1 = (await login(srv.base, 'drone1', CREDS.drone1))!;
    drone1 = await connectWs(srv.wsUrl, d1);
    operWs = await connectWs(srv.wsUrl, op);
  });

  afterAll(async () => {
    await drone1.close();
    await operWs.close();
    await srv.close();
  });

  // limpia los buffers de mensajes para no confundir con mensajes de tests previos
  beforeEach(() => {
    drone1.got.length = 0;
    operWs.got.length = 0;
  });

  // deja el dron libre y restaura los flags que algún test haya tocado
  afterEach(async () => {
    await api(srv.base, '/api/drones/drone1/control', adm, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
    await api(srv.base, '/api/users/operador', adm, { method: 'PATCH', body: JSON.stringify({ canControl: true }) });
  });

  it('el operador toma el control y el dron recibe control_taken', async () => {
    const r = await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.controlledBy).toBe('operador');
    await drone1.waitFor((m) => m.type === 'control_taken' && m.by === 'operador');
    await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === 'operador');
  });

  it('el mismo titular puede re-tomar el control (idempotente)', async () => {
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    const r = await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    expect(r.status).toBe(200);
  });

  it('un segundo usuario NO puede tomar un dron ya controlado (409)', async () => {
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    const r = await api(srv.base, '/api/drones/drone1/control', adm, { method: 'POST' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/operador/);
  });

  it('control: sin canControl da 403, dron inexistente da 404', async () => {
    expect((await api(srv.base, '/api/drones/drone1/control', noControl, { method: 'POST' })).status).toBe(403);
    expect((await api(srv.base, '/api/drones/fantasma/control', op, { method: 'POST' })).status).toBe(404);
  });

  it('el titular mueve el dron; otro usuario recibe 409; parámetros inválidos 400', async () => {
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    const mv = await api(srv.base, '/api/drones/drone1/manual_move', op, {
      method: 'POST',
      body: JSON.stringify({ bearing: 90, distanceM: 25 }),
    });
    expect(mv.status).toBe(200);
    await drone1.waitFor((m) => m.type === 'manual_move' && m.bearing === 90 && m.distanceM === 25);

    // otro usuario no es el titular
    const otro = await api(srv.base, '/api/drones/drone1/manual_move', adm, {
      method: 'POST',
      body: JSON.stringify({ bearing: 0, distanceM: 25 }),
    });
    expect(otro.status).toBe(409);

    // distancia fuera de rango
    const malo = await api(srv.base, '/api/drones/drone1/manual_move', op, {
      method: 'POST',
      body: JSON.stringify({ bearing: 90, distanceM: 999 }),
    });
    expect(malo.status).toBe(400);
  });

  it('un supervisor fuerza la liberación; el dron recibe control_released y resume', async () => {
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    drone1.got.length = 0;
    const force = await api(srv.base, '/api/drones/drone1/control', sup, {
      method: 'DELETE',
      body: JSON.stringify({ resume: 'last' }),
    });
    expect(force.status).toBe(200);
    expect(force.body.controlledBy).toBeNull();
    await drone1.waitFor((m) => m.type === 'control_released');
    await drone1.waitFor((m) => m.type === 'resume_patrol');
    await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === null);
  });

  it('el titular libera con resume=none (no manda resume_patrol)', async () => {
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    drone1.got.length = 0;
    const r = await api(srv.base, '/api/drones/drone1/control', op, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
    expect(r.status).toBe(200);
    await drone1.waitFor((m) => m.type === 'control_released');
    // no debería haber resume_patrol
    expect(drone1.got.some((m) => m.type === 'resume_patrol')).toBe(false);
  });

  it('el titular libera con resume=<número> y el dron reanuda desde ese nodo', async () => {
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    drone1.got.length = 0;
    const r = await api(srv.base, '/api/drones/drone1/control', op, { method: 'DELETE', body: JSON.stringify({ resume: 2 }) });
    expect(r.status).toBe(200);
    await drone1.waitFor((m) => m.type === 'resume_patrol' && m.fromIndex === 2);
  });

  it('DELETE control sin lock da 409; un no-titular no-supervisor da 403', async () => {
    // sin lock
    expect(
      (await api(srv.base, '/api/drones/drone1/control', op, { method: 'DELETE' })).status,
    ).toBe(409);
    // con lock de op, oper2 (operador) no puede quitarlo
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    const r = await api(srv.base, '/api/drones/drone1/control', oper2, { method: 'DELETE' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/operador/);
  });

  it('reanudar (resume) libera el control si estaba tomado', async () => {
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    drone1.got.length = 0;
    const r = await api(srv.base, '/api/drones/drone1/resume', op, { method: 'POST', body: JSON.stringify({ fromIndex: 1 }) });
    expect(r.status).toBe(200);
    await drone1.waitFor((m) => m.type === 'control_released');
    await drone1.waitFor((m) => m.type === 'resume_patrol' && m.fromIndex === 1);
    // el lock quedó liberado
    expect((await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === 'drone1').controlledBy).toBeNull();
  });

  it('un comando de otro operador sobre un dron controlado por otro da 409', async () => {
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    // oper2 es operador (no supervisor): no puede comandar un dron tomado por op
    expect(
      (await api(srv.base, '/api/drones/drone1/route/start', oper2, { method: 'POST', body: JSON.stringify({ routeId: 1 }) }))
        .status,
    ).toBe(409);
    expect((await api(srv.base, '/api/drones/drone1/route/stop', oper2, { method: 'POST' })).status).toBe(409);
    expect((await api(srv.base, '/api/drones/drone1/resume', oper2, { method: 'POST' })).status).toBe(409);
    expect(
      (await api(srv.base, '/api/drones/drone1/goto', oper2, { method: 'POST', body: JSON.stringify({ routeId: 1, index: 0 }) }))
        .status,
    ).toBe(409);
    // pero un supervisor sí puede (override jerárquico)
    expect((await api(srv.base, '/api/drones/drone1/route/stop', sup, { method: 'POST' })).status).toBe(200);
  });

  it('suspender canControl corta el control en el acto y bloquea nuevas tomas', async () => {
    await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' });
    drone1.got.length = 0;
    const susp = await api(srv.base, '/api/users/operador', sup, {
      method: 'PATCH',
      body: JSON.stringify({ canControl: false }),
    });
    expect(susp.status).toBe(200);
    expect(susp.body.canControl).toBe(false);
    // el lock se liberó
    await drone1.waitFor((m) => m.type === 'control_released');
    expect((await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === 'drone1').controlledBy).toBeNull();
    // suspendido no puede tomar control ni forzar goto
    expect((await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' })).status).toBe(403);
    expect(
      (await api(srv.base, '/api/drones/drone1/goto', op, { method: 'POST', body: JSON.stringify({ routeId: 1, index: 0 }) }))
        .status,
    ).toBe(403);
    // al restaurarlo, vuelve a poder
    await api(srv.base, '/api/users/operador', sup, { method: 'PATCH', body: JSON.stringify({ canControl: true }) });
    expect((await api(srv.base, '/api/drones/drone1/control', op, { method: 'POST' })).status).toBe(200);
  });

  it('desactivar un usuario corta el control que tenía', async () => {
    // usuario descartable que toma control y luego se desactiva
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'efimero', password: 'efimero1', role: 'operator', canControl: true }),
    });
    const efi = (await login(srv.base, 'efimero', 'efimero1'))!;
    await api(srv.base, '/api/drones/drone1/control', efi, { method: 'POST' });
    expect((await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === 'drone1').controlledBy).toBe('efimero');

    const desact = await api(srv.base, '/api/users/efimero', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    expect(desact.status).toBe(200);
    expect((await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === 'drone1').controlledBy).toBeNull();
    // limpieza
    await api(srv.base, '/api/users/efimero', adm, { method: 'DELETE' });
  });

  it('cerrar la última conexión WS del titular libera su control', async () => {
    // oper2 (sin WS persistente) abre una única conexión, toma el control y la cierra
    const o2ws = await connectWs(srv.wsUrl, oper2);
    await api(srv.base, '/api/drones/drone1/control', oper2, { method: 'POST' });
    expect((await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === 'drone1').controlledBy).toBe('oper2');
    await o2ws.close();
    // dar tiempo al handler de cierre del servidor
    await new Promise((r) => setTimeout(r, 200));
    expect((await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === 'drone1').controlledBy).toBeNull();
  });
});
