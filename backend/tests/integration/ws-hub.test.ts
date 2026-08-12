import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  seed, startServer, login, api, connectWs, wsCloseCode, mkStatus, wait, tokenDeDron,
  CREDS, DRON, type TestServer, type WsClient,
} from '../helpers';

/** Promesa con el código de cierre de un socket ya abierto. */
function cierreDe(c: WsClient): Promise<number> {
  return new Promise((resolve) => c.ws.once('close', (code) => resolve(code)));
}

describe('integración — hub WebSocket multi-dron', () => {
  let srv: TestServer;
  let op = '';
  let adm = '';
  let sup = '';
  let alfaTok = '';
  let bravoTok = '';
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
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    alfaTok = tokenDeDron(DRON.alfa);
    bravoTok = tokenDeDron(DRON.bravo);
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
    const d1 = await conn(alfaTok);
    const d2 = await conn(bravoTok);
    d1.ws.send(mkStatus({ lat: -34.855, battery: 90, mode: 'TEST' }));
    d2.ws.send(mkStatus({ lat: -34.859, battery: 55, mode: 'DEPLOY', waypointIndex: 1 }));
    await wait(150);

    // un operador que se conecta ahora recibe el estado inicial de ambos
    const opWs = await conn(op);
    const s1 = await opWs.waitFor((m) => m.type === 'status' && m.droneId === DRON.alfa);
    const s2 = await opWs.waitFor((m) => m.type === 'status' && m.droneId === DRON.bravo);
    expect(s1.displayName).toBe('Alfa');
    expect(s1.signalPct).toBe(72);
    expect(s1.waypointTotal).toBe(4);
    expect(s2.displayName).toBe('Bravo');
    expect(s2.mode).toBe('DEPLOY');

    // y en vivo: un nuevo status del dron Alfa llega etiquetado
    d1.ws.send(mkStatus({ battery: 88 }));
    await opWs.waitFor((m) => m.type === 'status' && m.droneId === DRON.alfa && m.battery === 88);
  });

  it('los video_frame llegan a los operadores etiquetados con su droneId', async () => {
    const opWs = await conn(op);
    const d2 = await conn(bravoTok);
    await wait(50);
    d2.ws.send(JSON.stringify({ type: 'video_frame', jpegBase64: 'FRAME2', ts: 7 }));
    const f = await opWs.waitFor((m) => m.type === 'video_frame');
    expect(f.droneId).toBe(DRON.bravo);
    expect(f.jpegBase64).toBe('FRAME2');
    expect(f.ts).toBe(7);
  });

  it('drone_online al conectarse y drone_offline al desconectarse', async () => {
    const opWs = await conn(op);
    await wait(50);
    const d1 = await conn(alfaTok);
    const online = await opWs.waitFor((m) => m.type === 'drone_online');
    expect(online.drone.droneId).toBe(DRON.alfa);
    expect(online.drone.hash).toBe(DRON.alfa);
    expect(online.drone.online).toBe(true);

    await d1.close();
    const offline = await opWs.waitFor((m) => m.type === 'drone_offline' && m.drone.droneId === DRON.alfa);
    expect(offline.drone.online).toBe(false);
    // y GET /drones lo muestra offline
    const lista = (await api(srv.base, '/api/drones', op)).body;
    expect(lista.find((d: any) => d.droneId === DRON.alfa).online).toBe(false);
  });

  it('renombre desde la app: el operador recibe drone_renamed y la app NO recibe eco', async () => {
    const opWs = await conn(op);
    const d1 = await conn(alfaTok);
    await wait(50);
    d1.ws.send(JSON.stringify({ type: 'set_name', displayName: 'Alfa-App' }));
    const ren = await opWs.waitFor((m) => m.type === 'drone_renamed' && m.droneId === DRON.alfa);
    expect(ren.displayName).toBe('Alfa-App');
    // la app no recibe el eco 'renamed' de su propio cambio
    await wait(150);
    expect(d1.got.some((m) => m.type === 'renamed')).toBe(false);
    // queda registrado el renombre con antes/después
    const evs = (await api(srv.base, '/api/events?limit=100', op)).body;
    const ev = evs.find((e: any) => e.type === 'DRONE_RENAMED');
    expect(ev).toBeDefined();
    const meta = JSON.parse(ev.meta);
    expect(meta.antes).toEqual({ displayName: 'Alfa' });
    expect(meta.despues).toEqual({ displayName: 'Alfa-App' });
    expect(meta.drone.hash).toBe(DRON.alfa);
    // volver al nombre de la semilla
    await api(srv.base, `/api/drones/${DRON.alfa}`, op, { method: 'PATCH', body: JSON.stringify({ displayName: 'Alfa' }) });
  });

  it('set_name vacío se ignora y un frame no-JSON no rompe el hub', async () => {
    const opWs = await conn(op);
    const d1 = await conn(alfaTok);
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
    const d1 = await conn(alfaTok);
    const d2 = await conn(bravoTok);
    await wait(50);

    // alerta de VEHÍCULO desde Bravo
    d2.ws.send(JSON.stringify({ type: 'alert_request', alertType: 'VEHICLE', lat: -34.859, lon: -56.205, snapshotBase64: 'S' }));
    const created = await opWs.waitFor((m) => m.type === 'alert_created');
    expect(created.alert.drone_id).toBe(DRON.bravo);
    expect(created.alert.type).toBe('VEHICLE');
    // el evento trae la alerta y la ficha del dron para el pop-up del registro
    const evAlerta = await opWs.waitFor((m) => m.type === 'event' && m.event.type === 'ALERT_CREATED');
    const meta = JSON.parse(evAlerta.event.meta);
    expect(meta.alerta).toMatchObject({ id: created.alert.id, tipo: 'VEHICLE', lat: -34.859, lon: -56.205 });
    expect(meta.drone).toEqual({ hash: DRON.bravo, displayName: 'Bravo', model: 'DJI Mini 3' });

    const d1Before = d1.got.length;
    const dec = await api(srv.base, `/api/alerts/${created.alert.id}/decision`, op, {
      method: 'POST',
      body: JSON.stringify({ decision: 'DISMISSED' }),
    });
    expect(dec.status).toBe(200);
    // la decisión llega a Bravo
    await d2.waitFor((m) => m.type === 'alert_decision' && m.decision === 'DISMISSED');
    // y NO a Alfa
    await wait(150);
    expect(d1.got.slice(d1Before).some((m) => m.type === 'alert_decision')).toBe(false);
  });

  it('un alert_request sin datos cae a PERSON con coordenadas y captura nulas', async () => {
    const opWs = await conn(op);
    const d1 = await conn(alfaTok);
    await wait(50);
    d1.ws.send(JSON.stringify({ type: 'alert_request' }));
    const created = await opWs.waitFor((m) => m.type === 'alert_created');
    expect(created.alert.type).toBe('PERSON');
    expect(created.alert.lat).toBeNull();
    expect(created.alert.lon).toBeNull();
    expect(created.alert.snapshot).toBeNull();
    const ev = await opWs.waitFor((m) => m.type === 'event' && m.event.type === 'ALERT_CREATED');
    expect(ev.event.message).toContain('PERSONA');
  });

  it('un evento emitido por el dron se reenvía a los operadores', async () => {
    const opWs = await conn(op);
    const d1 = await conn(alfaTok);
    await wait(50);
    d1.ws.send(JSON.stringify({ type: 'event', eventType: 'SIGNAL_LOST', message: 'Se perdió el enlace' }));
    const ev = await opWs.waitFor((m) => m.type === 'event' && m.event.type === 'SIGNAL_LOST');
    expect(ev.event.drone_id).toBe(DRON.alfa);
    expect(ev.event.message).toBe('Se perdió el enlace');
    // un evento sin texto se guarda con mensaje vacío, no rompe
    d1.ws.send(JSON.stringify({ type: 'event', eventType: 'LANDED' }));
    const mudo = await opWs.waitFor((m) => m.type === 'event' && m.event.type === 'LANDED');
    expect(mudo.event.message).toBe('');
    // el origen es el hash; la ficha para mostrar el nombre viaja en la meta
    expect(ev.event.source).toBe(DRON.alfa);
    expect(JSON.parse(ev.event.meta).drone.displayName).toBe('Alfa');
  });

  it('una nueva conexión del mismo dron reemplaza a la anterior', async () => {
    const c1 = await conn(alfaTok);
    await wait(50);
    const c2 = await conn(alfaTok);
    // la primera conexión debe cerrarse
    await wait(200);
    expect(c1.ws.readyState).toBe(WebSocket.CLOSED);
    // la segunda sigue activa y recibe comandos
    const opWs = await conn(op);
    await wait(50);
    const r = await api(srv.base, `/api/drones/${DRON.alfa}/route/stop`, op, { method: 'POST' });
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

  it('un usuario eliminado lógicamente tampoco puede abrir el WebSocket', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'wsborrado', password: 'wsborrado1', role: 'operator' }),
    });
    const tok = (await login(srv.base, 'wsborrado', 'wsborrado1'))!;
    await api(srv.base, '/api/users/wsborrado', adm, { method: 'DELETE' });
    expect(await wsCloseCode(srv.wsUrl, tok)).toBe(4403);
  });

  it('un dron inexistente, eliminado o desactivado no puede conectarse (4403)', async () => {
    // hash que nunca se dio de alta
    expect(await wsCloseCode(srv.wsUrl, tokenDeDron('f'.repeat(32)))).toBe(4403);

    // desactivado
    await api(srv.base, `/api/drones/${DRON.charlie}`, sup, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    expect(await wsCloseCode(srv.wsUrl, tokenDeDron(DRON.charlie))).toBe(4403);
    await api(srv.base, `/api/drones/${DRON.charlie}`, sup, { method: 'PATCH', body: JSON.stringify({ active: true }) });

    // eliminado
    await api(srv.base, `/api/drones/${DRON.charlie}`, sup, { method: 'DELETE' });
    expect(await wsCloseCode(srv.wsUrl, tokenDeDron(DRON.charlie))).toBe(4403);
    await api(srv.base, `/api/drones/${DRON.charlie}/restore`, sup, { method: 'POST' });
    // restaurado y activo, vuelve a entrar
    const vuelve = await conn(tokenDeDron(DRON.charlie));
    expect(vuelve.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('desactivar un dron conectado le cierra el socket en el acto', async () => {
    const d1 = await conn(alfaTok);
    await wait(50);
    const cerrado = cierreDe(d1);
    await api(srv.base, `/api/drones/${DRON.alfa}`, sup, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    expect(await cerrado).toBe(4403);
    await api(srv.base, `/api/drones/${DRON.alfa}`, sup, { method: 'PATCH', body: JSON.stringify({ active: true }) });
  });

  it('eliminar un dron conectado le cierra el socket y avisa a las consolas', async () => {
    const opWs = await conn(op);
    const d2 = await conn(bravoTok);
    await wait(50);
    const cerrado = cierreDe(d2);
    await api(srv.base, `/api/drones/${DRON.bravo}`, sup, { method: 'DELETE' });
    expect(await cerrado).toBe(4403);
    const aviso = await opWs.waitFor((m) => m.type === 'drone_updated' && m.drone.droneId === DRON.bravo);
    expect(aviso.drone.deletedAt).toBeTruthy();
    await api(srv.base, `/api/drones/${DRON.bravo}/restore`, sup, { method: 'POST' });
  });
});
