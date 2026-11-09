import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDS, DRON, api, connectWs, crearUsuario, login, seed, startServer, tokenDeDron, wait,
  type TestServer, type WsClient,
} from '../helpers';

// Las dos órdenes de llegada desde la consola (VUELO §7.1, §9 y §11; PROTOCOLS
// §5): volver a la base y aterrizar donde está. No piden tener el control
// manual —el que mira el tablero tiene que poder traer un dron que vuela
// solo— pero lo respetan: con el control de otro son un 409, salvo que un
// supervisor lo fuerce. Volver a la base con el control propio lo suelta sin
// avisarle a la app (ella lo suelta sola con la orden); aterrizar lo deja
// tomado. Despegar sigue pidiendo el lock como siempre.

const A = DRON.alfa;
const DRON_ALFA = { hash: A, displayName: 'Alfa', model: 'DJI Mini 3' };

type Orden = 'return_home' | 'land' | 'takeoff';

describe('integración — volver a la base y aterrizar desde la consola', () => {
  let srv: TestServer;
  let op = '';
  let sup = '';
  let adm = '';
  let oper2 = '';
  let sinControl = '';
  let alfa: WsClient;
  let operWs: WsClient;
  const extras: WsClient[] = [];

  const ordenar = (orden: Orden, token: string, cuerpo?: unknown) =>
    api(srv.base, `/api/drones/${A}/${orden}`, token, {
      method: 'POST',
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
  const tomar = (token: string) => api(srv.base, `/api/drones/${A}/control`, token, { method: 'POST' });
  const titular = async (): Promise<string | null> =>
    (await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === A).controlledBy;
  const evento = (c: WsClient, tipo: string) => c.waitFor((m) => m.type === 'event' && m.event.type === tipo);
  const detalleDe = (ev: any) => JSON.parse(ev.event.meta).detalle;

  /** `quien` toma el control de Alfa y los buffers arrancan vacíos después. */
  async function conElControlDe(token: string, nombre: string) {
    expect((await tomar(token)).status).toBe(200);
    await alfa.waitFor((m) => m.type === 'control_taken' && m.by === nombre);
    await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === nombre);
    await wait(30);
    alfa.got.length = 0;
    operWs.got.length = 0;
  }

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    const dos = await crearUsuario(srv.base, adm, { username: 'oper2', canControl: true });
    oper2 = (await login(srv.base, 'oper2', dos.password))!;
    const sin = await crearUsuario(srv.base, adm, { username: 'mirador', canControl: false });
    sinControl = (await login(srv.base, 'mirador', sin.password))!;
    alfa = await connectWs(srv.wsUrl, tokenDeDron(A));
    operWs = await connectWs(srv.wsUrl, op);
    // la conexión del dron termina con sus ajustes: desde ahí los buffers son de cada prueba
    await alfa.waitFor((m) => m.type === 'ajustes');
  });

  afterAll(async () => {
    await alfa.close();
    await operWs.close();
    await srv.close();
  });

  beforeEach(async () => {
    await wait(30);
    alfa.got.length = 0;
    operWs.got.length = 0;
  });

  afterEach(async () => {
    for (const c of extras) await c.close();
    extras.length = 0;
    // deja el dron libre para la que sigue (409 si ya lo estaba: da igual)
    await api(srv.base, `/api/drones/${A}/control`, adm, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
  });

  it('volver a la base con el dron libre: la orden llega, queda registrada y nadie toca el control', async () => {
    const r = await ordenar('return_home', op);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, delivered: true });
    expect(await alfa.waitFor((m) => m.type === 'return_home')).toEqual({ type: 'return_home', by: 'operador' });

    const ev = await evento(operWs, 'RTH_ORDERED');
    expect(ev.event).toMatchObject({ drone_id: A, source: 'operador', category: 'drone' });
    expect(ev.event.message).toBe('operador ordenó el regreso a la base del dron "Alfa"');
    expect(JSON.parse(ev.event.meta)).toEqual({ drone: DRON_ALFA, detalle: { por: 'operador', teniaElControl: null } });

    await wait(80);
    expect(alfa.got.map((m) => m.type)).toEqual(['return_home']);
    expect(operWs.got.some((m) => m.type === 'control_changed')).toBe(false);
    expect(await titular()).toBeNull();
  });

  it('el titular que ordena volver suelta el lock, y a la app le llega SOLO la orden: ella lo suelta sola', async () => {
    await conElControlDe(op, 'operador');

    const r = await ordenar('return_home', op);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, delivered: true });
    expect(await titular()).toBeNull();
    expect(await alfa.waitFor((m) => m.type === 'return_home')).toEqual({ type: 'return_home', by: 'operador' });
    await wait(80);
    // ni control_released ni resume_patrol: un control_released la haría frenar o volver al objetivo antes del regreso
    expect(alfa.got.map((m) => m.type)).toEqual(['return_home']);

    // las consolas sí se enteran de que el lock se soltó, y antes de la orden
    const cambio = await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === null);
    expect(cambio).toEqual({ type: 'control_changed', droneId: A, controlledBy: null, teniaElControl: 'operador' });
    const soltado = await evento(operWs, 'CONTROL_RELEASED');
    expect(detalleDe(soltado)).toEqual({
      por: 'operador', teniaElControl: 'operador', forzado: false, motivo: 'operador ordenó volver a la base',
    });
    const rth = await evento(operWs, 'RTH_ORDERED');
    expect(detalleDe(rth)).toEqual({ por: 'operador', teniaElControl: 'operador' });
    expect(operWs.got.indexOf(cambio)).toBeLessThan(operWs.got.indexOf(rth));
  });

  it('con el control en manos de otro, volver a la base da 409 y al dron no le llega nada', async () => {
    await conElControlDe(oper2, 'oper2');
    const intentos: [string, unknown][] = [
      [op, undefined],
      [op, { forzar: true }],
      [sup, undefined],
      [sup, { forzar: false }],
      [sup, { forzar: 'si' }],
    ];
    for (const [token, cuerpo] of intentos) {
      const r = await ordenar('return_home', token, cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(409);
      expect(r.body.error).toBe('El control lo tiene oper2');
    }
    await wait(80);
    expect(alfa.got).toEqual([]);
    expect(operWs.got.some((m) => m.type === 'event')).toBe(false);
    expect(await titular()).toBe('oper2');
  });

  it('un supervisor con forzar se lo quita antes: la app recibe control_released y después la orden', async () => {
    await conElControlDe(oper2, 'oper2');

    const r = await ordenar('return_home', sup, { forzar: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, delivered: true });
    expect(await alfa.waitFor((m) => m.type === 'return_home')).toEqual({ type: 'return_home', by: 'supervisor' });
    await wait(80);
    expect(alfa.got).toEqual([
      { type: 'control_released', by: 'supervisor' },
      { type: 'return_home', by: 'supervisor' },
    ]);
    expect(await titular()).toBeNull();

    const cambio = await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === null);
    expect(cambio).toEqual({ type: 'control_changed', droneId: A, controlledBy: null, teniaElControl: 'oper2' });
    const soltado = await evento(operWs, 'CONTROL_RELEASED');
    expect(detalleDe(soltado)).toEqual({
      por: 'supervisor', teniaElControl: 'oper2', forzado: true, motivo: 'supervisor ordenó volver a la base',
    });
    expect(detalleDe(await evento(operWs, 'RTH_ORDERED'))).toEqual({ por: 'supervisor', teniaElControl: 'oper2' });
  });

  it('un pedido de control que esperaba termina liberado cuando el titular ordena volver, y el dron no se le da solo', async () => {
    const consola2 = await connectWs(srv.wsUrl, oper2);
    extras.push(consola2);
    await conElControlDe(op, 'operador');
    const pedido = await api(srv.base, `/api/drones/${A}/control/request`, oper2, { method: 'POST' });
    expect(pedido.status).toBe(202);
    await operWs.waitFor((m) => m.type === 'control_request' && m.solicitante === 'oper2');

    expect((await ordenar('return_home', op)).status).toBe(200);
    expect(await consola2.waitFor((m) => m.type === 'control_request_result' && m.droneId === A)).toMatchObject({
      solicitante: 'oper2', titular: 'operador', resultado: 'liberado', motivo: 'operador ordenó volver a la base',
    });
    const ficha = (await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === A);
    expect(ficha).toMatchObject({ controlledBy: null, pedidoDeControl: null });
    await alfa.waitFor((m) => m.type === 'return_home');
    await wait(80);
    expect(alfa.got.map((m) => m.type)).toEqual(['return_home']);
  });

  it('aterrizar sin el control: la orden llega y queda registrada como siempre', async () => {
    const r = await ordenar('land', op);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, delivered: true });
    expect(await alfa.waitFor((m) => m.type === 'land')).toEqual({ type: 'land', by: 'operador' });
    const ev = await evento(operWs, 'LANDING_ORDERED');
    expect(ev.event.message).toBe('operador ordenó el aterrizaje del dron "Alfa"');
    expect(JSON.parse(ev.event.meta)).toEqual({ drone: DRON_ALFA, detalle: { por: 'operador' } });
    await wait(80);
    expect(alfa.got.map((m) => m.type)).toEqual(['land']);
    expect(operWs.got.some((m) => m.type === 'control_changed')).toBe(false);
  });

  it('el titular que aterriza sigue con el control: el dron queda en MANUAL en el suelo', async () => {
    await conElControlDe(op, 'operador');
    expect((await ordenar('land', op)).status).toBe(200);
    expect(await alfa.waitFor((m) => m.type === 'land')).toEqual({ type: 'land', by: 'operador' });
    await wait(80);
    expect(alfa.got.map((m) => m.type)).toEqual(['land']);
    expect(await titular()).toBe('operador');
    expect(operWs.got.some((m) => m.type === 'control_changed')).toBe(false);
    expect(operWs.got.some((m) => m.type === 'event' && m.event.type === 'CONTROL_RELEASED')).toBe(false);
  });

  it('aterrizar con el control de otro da 409, salvo un supervisor con forzar, que se lo quita antes', async () => {
    await conElControlDe(oper2, 'oper2');
    for (const token of [op, sup]) {
      const r = await ordenar('land', token);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('El control lo tiene oper2');
    }
    expect((await ordenar('land', op, { forzar: true })).status).toBe(409);
    await wait(80);
    expect(alfa.got).toEqual([]);

    const r = await ordenar('land', sup, { forzar: true });
    expect(r.status).toBe(200);
    await alfa.waitFor((m) => m.type === 'land');
    expect(alfa.got).toEqual([
      { type: 'control_released', by: 'supervisor' },
      { type: 'land', by: 'supervisor' },
    ]);
    expect(await titular()).toBeNull();
    const soltado = await evento(operWs, 'CONTROL_RELEASED');
    expect(detalleDe(soltado)).toEqual({
      por: 'supervisor', teniaElControl: 'oper2', forzado: true, motivo: 'supervisor ordenó aterrizar',
    });
    expect(JSON.parse((await evento(operWs, 'LANDING_ORDERED')).event.meta).detalle).toEqual({ por: 'supervisor' });
  });

  it('permisos: sin canControl 403, dron inexistente 404, operador de campo 403', async () => {
    const campo = (await login(srv.base, 'campo', CREDS.campo))!;
    for (const orden of ['return_home', 'land'] as Orden[]) {
      expect((await ordenar(orden, sinControl)).status, orden).toBe(403);
      expect((await ordenar(orden, campo)).status, orden).toBe(403);
      expect((await api(srv.base, `/api/drones/fantasma/${orden}`, op, { method: 'POST' })).status, orden).toBe(404);
    }
    await wait(80);
    expect(alfa.got).toEqual([]);
  });

  it('a un dron desconectado la orden le queda registrada con delivered: false', async () => {
    const r = await api(srv.base, `/api/drones/${DRON.charlie}/return_home`, op, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, delivered: false });
    const evs = (await api(srv.base, `/api/events?droneId=${DRON.charlie}`, op)).body;
    expect(evs.some((e: any) => e.type === 'RTH_ORDERED' && e.message.includes('Charlie'))).toBe(true);
  });

  it('despegar sigue pidiendo el lock: ni con el dron libre ni con el control de otro, tampoco un supervisor', async () => {
    const libre = await ordenar('takeoff', op);
    expect(libre.status).toBe(409);
    expect(libre.body.error).toBe('No tenés el control manual de este dron');
    await conElControlDe(oper2, 'oper2');
    for (const token of [op, sup]) {
      expect((await ordenar('takeoff', token, { forzar: true })).status).toBe(409);
    }
    await wait(80);
    expect(alfa.got).toEqual([]);
    expect(await titular()).toBe('oper2');
  });
});
