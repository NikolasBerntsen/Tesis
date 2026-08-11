import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { seed, startServer, login, api, connectWs, mkStatus, wait, CREDS, type TestServer, type WsClient } from '../helpers';

// Espera el código con que el servidor cierra un WS (p. ej. token inválido).
function wsCloseCode(wsUrl: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?token=${token}`);
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {
      /* el close llega igual */
    });
    setTimeout(() => reject(new Error('el WebSocket no cerró a tiempo')), 3000);
  });
}

describe('integración — hub WebSocket multi-dron', () => {
  let srv: TestServer;
  let op = '';
  let adm = '';
  let d1tok = '';
  let d2tok = '';
  const sockets: WsClient[] = [];

  const conn = async (token: string) => {
    const c = await connectWs(srv.wsUrl, token);
    sockets.push(c);
    return c;
  };

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    d1tok = (await login(srv.base, 'drone1', CREDS.drone1))!;
    d2tok = (await login(srv.base, 'drone2', CREDS.drone2))!;
  });

  afterEach(async () => {
    for (const s of sockets) await s.close();
    sockets.length = 0;
    await wait(50); // deja asentar los handlers de cierre del servidor
  });

  afterAll(async () => {
    await srv.close();
  });

  it('los operadores reciben el status de varios drones etiquetado, y el estado inicial al conectarse', async () => {
    const d1 = await conn(d1tok);
    const d2 = await conn(d2tok);
    d1.ws.send(mkStatus({ lat: -34.855, battery: 90, mode: 'TEST' }));
    d2.ws.send(mkStatus({ lat: -34.859, battery: 55, mode: 'DEPLOY', waypointIndex: 1 }));
    await wait(150);

    // un operador que se conecta ahora recibe el estado inicial de ambos
    const opWs = await conn(op);
    const s1 = await opWs.waitFor((m) => m.type === 'status' && m.droneId === 'drone1');
    const s2 = await opWs.waitFor((m) => m.type === 'status' && m.droneId === 'drone2');
    expect(s1.displayName).toBe('Alfa');
    expect(s1.signalPct).toBe(72);
    expect(s1.waypointTotal).toBe(4);
    expect(s2.displayName).toBe('Bravo');
    expect(s2.mode).toBe('DEPLOY');

    // y en vivo: un nuevo status del dron1 llega etiquetado
    d1.ws.send(mkStatus({ battery: 88 }));
    await opWs.waitFor((m) => m.type === 'status' && m.droneId === 'drone1' && m.battery === 88);
  });

  it('los video_frame llegan a los operadores etiquetados con su droneId', async () => {
    const opWs = await conn(op);
    const d2 = await conn(d2tok);
    await wait(50);
    d2.ws.send(JSON.stringify({ type: 'video_frame', jpegBase64: 'FRAME2', ts: 7 }));
    const f = await opWs.waitFor((m) => m.type === 'video_frame');
    expect(f.droneId).toBe('drone2');
    expect(f.jpegBase64).toBe('FRAME2');
    expect(f.ts).toBe(7);
  });

  it('drone_online al conectarse y drone_offline al desconectarse', async () => {
    const opWs = await conn(op);
    await wait(50);
    const d1 = await conn(d1tok);
    const online = await opWs.waitFor((m) => m.type === 'drone_online');
    expect(online.drone.droneId).toBe('drone1');
    expect(online.drone.online).toBe(true);

    await d1.close();
    const offline = await opWs.waitFor((m) => m.type === 'drone_offline' && m.drone.droneId === 'drone1');
    expect(offline.drone.online).toBe(false);
    // y GET /drones lo muestra offline
    const lista = (await api(srv.base, '/api/drones', op)).body;
    expect(lista.find((d: any) => d.droneId === 'drone1').online).toBe(false);
  });

  it('renombre desde la app: el operador recibe drone_renamed y la app NO recibe eco', async () => {
    const opWs = await conn(op);
    const d1 = await conn(d1tok);
    await wait(50);
    d1.ws.send(JSON.stringify({ type: 'set_name', displayName: 'Alfa-App' }));
    const ren = await opWs.waitFor((m) => m.type === 'drone_renamed' && m.droneId === 'drone1');
    expect(ren.displayName).toBe('Alfa-App');
    // la app no recibe el eco 'renamed' de su propio cambio
    await wait(150);
    expect(d1.got.some((m) => m.type === 'renamed')).toBe(false);
    // queda registrado el renombre con antes/después
    const evs = (await api(srv.base, '/api/events?limit=100', op)).body;
    const ev = evs.find((e: any) => e.type === 'DRONE_RENAMED');
    expect(ev).toBeDefined();
    expect(JSON.parse(ev.meta).despues).toBe('Alfa-App');
  });

  it('set_name vacío se ignora y un frame no-JSON no rompe el hub', async () => {
    const opWs = await conn(op);
    const d1 = await conn(d1tok);
    await wait(50);
    d1.ws.send(JSON.stringify({ type: 'set_name', displayName: '   ' }));
    d1.ws.send('esto no es json');
    await wait(150);
    // el hub sigue vivo: un status posterior se sigue reenviando
    d1.ws.send(mkStatus({ battery: 42 }));
    await opWs.waitFor((m) => m.type === 'status' && m.battery === 42);
  });

  it('una alerta se crea y la decisión llega SOLO al dron que la originó', async () => {
    const opWs = await conn(op);
    const d1 = await conn(d1tok);
    const d2 = await conn(d2tok);
    await wait(50);

    // alerta de VEHÍCULO desde drone2
    d2.ws.send(JSON.stringify({ type: 'alert_request', alertType: 'VEHICLE', lat: -34.859, lon: -56.205, snapshotBase64: 'S' }));
    const created = await opWs.waitFor((m) => m.type === 'alert_created');
    expect(created.alert.drone_id).toBe('drone2');
    expect(created.alert.type).toBe('VEHICLE');

    const d1Before = d1.got.length;
    const dec = await api(srv.base, `/api/alerts/${created.alert.id}/decision`, op, {
      method: 'POST',
      body: JSON.stringify({ decision: 'DISMISSED' }),
    });
    expect(dec.status).toBe(200);
    // la decisión llega a drone2
    await d2.waitFor((m) => m.type === 'alert_decision' && m.decision === 'DISMISSED');
    // y NO a drone1
    await wait(150);
    expect(d1.got.slice(d1Before).some((m) => m.type === 'alert_decision')).toBe(false);
  });

  it('un evento emitido por el dron se reenvía a los operadores', async () => {
    const opWs = await conn(op);
    const d1 = await conn(d1tok);
    await wait(50);
    d1.ws.send(JSON.stringify({ type: 'event', eventType: 'SIGNAL_LOST', message: 'Se perdió el enlace' }));
    const ev = await opWs.waitFor((m) => m.type === 'event' && m.event.type === 'SIGNAL_LOST');
    expect(ev.event.drone_id).toBe('drone1');
    expect(ev.event.message).toBe('Se perdió el enlace');
  });

  it('una nueva conexión del mismo dron reemplaza a la anterior', async () => {
    const c1 = await conn(d1tok);
    await wait(50);
    const c2 = await conn(d1tok);
    // la primera conexión debe cerrarse
    await wait(200);
    expect(c1.ws.readyState).toBe(WebSocket.CLOSED);
    // la segunda sigue activa y recibe comandos
    const opWs = await conn(op);
    await wait(50);
    const r = await api(srv.base, '/api/drones/drone1/route/stop', op, { method: 'POST' });
    expect(r.body.delivered).toBe(true);
    await c2.waitFor((m) => m.type === 'stop_patrol');
  });

  it('token inválido cierra con 4401 y una cuenta desactivada con 4403', async () => {
    expect(await wsCloseCode(srv.wsUrl, 'token-basura')).toBe(4401);

    // usuario recién creado, con token, luego desactivado
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'wsdesac', password: 'wsdesac1', role: 'operator' }),
    });
    const tok = (await login(srv.base, 'wsdesac', 'wsdesac1'))!;
    await api(srv.base, '/api/users/wsdesac', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    expect(await wsCloseCode(srv.wsUrl, tok)).toBe(4403);
  });
});
