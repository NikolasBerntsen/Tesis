import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLAZOS_DEL_CONTROL } from '../../src/control';
import { relojDelHub } from '../../src/reloj';
import { control } from '../../src/ws';
import {
  CREDS, DRON, api, connectWs, crearUsuario, login, seed, startServer, tokenDeDron, wait,
  type TestServer, type WsClient,
} from '../helpers';

// El pedido de control de punta a punta (PROTOCOLS §3 y §5): una persona pide
// el dron que vuela otra, el titular cede, mantiene o no contesta, y cada
// final le llega al dron (sin sacarlo de MANUAL) y a las consolas de los dos.
// El reloj del hub va en la mano para los 10 s de la respuesta.

const A = DRON.alfa;

describe('integración — pedido de control entre personas', () => {
  let srv: TestServer;
  let op = '';
  let oper2 = '';
  let sup = '';
  let adm = '';
  let sinControl = '';
  let alfa: WsClient;
  /** Consola del titular (operador) y del que pide (oper2). */
  let titularWs: WsClient;
  let pideWs: WsClient;
  const extras: WsClient[] = [];
  let t = 0;
  const relojReal = relojDelHub.ahora;

  const pedir = (token: string) => api(srv.base, `/api/drones/${A}/control/request`, token, { method: 'POST' });
  const contestar = (token: string, respuesta: unknown) =>
    api(srv.base, `/api/drones/${A}/control/request/answer`, token, { method: 'POST', body: JSON.stringify({ respuesta }) });
  const cancelar = (token: string) => api(srv.base, `/api/drones/${A}/control/request`, token, { method: 'DELETE' });
  const titular = async (): Promise<string | null> =>
    (await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === A).controlledBy;
  const resultado = (c: WsClient) => c.waitFor((m) => m.type === 'control_request_result' && m.droneId === A);
  const delControl = (c: WsClient) =>
    c.got.filter((m) => ['control_released', 'control_taken', 'control_transferred', 'resume_patrol'].includes(m.type));

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
    titularWs = await connectWs(srv.wsUrl, op);
    pideWs = await connectWs(srv.wsUrl, oper2);
  });

  afterAll(async () => {
    for (const c of [alfa, titularWs, pideWs]) await c.close();
    await srv.close();
  });

  /** El operador tiene el control de Alfa; los buffers arrancan vacíos. */
  beforeEach(async () => {
    t = Date.now();
    relojDelHub.ahora = () => t;
    expect((await api(srv.base, `/api/drones/${A}/control`, op, { method: 'POST' })).status).toBe(200);
    await alfa.waitFor((m) => m.type === 'control_taken');
    await pideWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === 'operador');
    await wait(30);
    for (const c of [alfa, titularWs, pideWs]) c.got.length = 0;
  });

  afterEach(async () => {
    relojDelHub.ahora = relojReal;
    for (const c of extras) await c.close();
    extras.length = 0;
    await api(srv.base, `/api/drones/${A}/control`, adm, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
    await api(srv.base, '/api/users/oper2', adm, { method: 'PATCH', body: JSON.stringify({ canControl: true }) });
    await wait(30);
  });

  it('el titular cede: el control pasa sin soltarse, el dron sigue en MANUAL y todos se enteran', async () => {
    const r = await pedir(oper2);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({
      resultado: 'pendiente',
      pedido: { solicitante: 'oper2', titular: 'operador', venceEn: new Date(t + 10_000).toISOString(), restanteMs: 10_000 },
    });
    // el titular recibe el pedido con el plazo para su cuenta regresiva
    expect(await titularWs.waitFor((m) => m.type === 'control_request')).toEqual({
      type: 'control_request', droneId: A, solicitante: 'oper2', titular: 'operador',
      venceEn: new Date(t + 10_000).toISOString(), restanteMs: 10_000,
    });
    // la ficha lo trae: una consola que recarga en el medio sigue sabiendo
    t += 3_000;
    const ficha = (await api(srv.base, '/api/drones', op)).body.find((d: any) => d.droneId === A);
    expect(ficha.pedidoDeControl).toMatchObject({ solicitante: 'oper2', restanteMs: 7_000 });

    const c = await contestar(op, 'ceder');
    expect(c.status).toBe(200);
    expect(c.body.resultado).toBe('cedido');
    expect(c.body.drone.controlledBy).toBe('oper2');
    expect(c.body.drone.pedidoDeControl).toBeNull();

    // al dron le llega el titular nuevo, sin soltar ni volver a tomar
    expect(await alfa.waitFor((m) => m.type === 'control_transferred')).toEqual({
      type: 'control_transferred', by: 'oper2', de: 'operador',
    });
    await wait(80);
    expect(delControl(alfa)).toEqual([{ type: 'control_transferred', by: 'oper2', de: 'operador' }]);
    expect(await pideWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === 'oper2')).toEqual({
      type: 'control_changed', droneId: A, controlledBy: 'oper2', teniaElControl: 'operador',
    });
    expect(await resultado(pideWs)).toMatchObject({ solicitante: 'oper2', titular: 'operador', resultado: 'cedido' });
    const ev = await titularWs.waitFor((m) => m.type === 'event' && m.event.type === 'CONTROL_TRANSFERRED');
    expect(ev.event.source).toBe('operador');
    expect(JSON.parse(ev.event.meta).detalle).toEqual({ de: 'operador', a: 'oper2', motivo: 'cedido' });

    // el nuevo titular ya pilotea; el anterior, no
    pideWs.ws.send(JSON.stringify({ type: 'manual_stick', droneId: A, pitch: 0.5, roll: 0, yaw: 0, throttle: 0 }));
    titularWs.ws.send(JSON.stringify({ type: 'manual_stick', droneId: A, pitch: -0.5, roll: 0, yaw: 0, throttle: 0 }));
    await alfa.waitFor((m) => m.type === 'manual_stick');
    await wait(80);
    expect(alfa.got.filter((m) => m.type === 'manual_stick').map((m) => m.by)).toEqual(['oper2']);
    // y contestar otra vez ya no tiene a qué
    expect((await contestar(op, 'ceder')).status).toBe(409);
  });

  it('el titular mantiene: no cambia nada y el que pidió se entera', async () => {
    expect((await pedir(oper2)).status).toBe(202);
    const r = await contestar(op, 'mantener');
    expect(r.body).toMatchObject({ resultado: 'mantenido', drone: { controlledBy: 'operador', pedidoDeControl: null } });
    expect(await resultado(pideWs)).toMatchObject({ resultado: 'mantenido', motivo: 'operador decidió mantener el control' });
    const ev = await pideWs.waitFor((m) => m.type === 'event' && m.event.type === 'CONTROL_REQUEST_ENDED');
    expect(JSON.parse(ev.event.meta).detalle).toMatchObject({ resultado: 'mantenido', solicitante: 'oper2' });
    await wait(80);
    expect(delControl(alfa)).toEqual([]);
    expect(await titular()).toBe('operador');
  });

  it('sin respuesta en 10 s el control pasa solo, aunque la consola del titular siga viva', async () => {
    expect((await pedir(oper2)).status).toBe(202);
    t += PLAZOS_DEL_CONTROL.respuestaMs - 1;
    control.barrer();
    expect(await titular()).toBe('operador');
    t += 1;
    control.barrer();
    expect(await titular()).toBe('oper2');
    expect(await alfa.waitFor((m) => m.type === 'control_transferred')).toMatchObject({ by: 'oper2', de: 'operador' });
    expect(await resultado(titularWs)).toMatchObject({ resultado: 'vencido', motivo: 'operador no contestó a tiempo' });
    const ev = await titularWs.waitFor((m) => m.type === 'event' && m.event.type === 'CONTROL_TRANSFERRED');
    expect(ev.event.source).toBe('backend');
    expect(JSON.parse(ev.event.meta).detalle.motivo).toBe('vencido');
  });

  it('una respuesta fuera de plazo cuenta como no contestada', async () => {
    expect((await pedir(oper2)).status).toBe(202);
    t += PLAZOS_DEL_CONTROL.respuestaMs;
    const r = await contestar(op, 'mantener');
    expect(r.body).toMatchObject({ resultado: 'vencido', drone: { controlledBy: 'oper2' } });
  });

  it('UN pedido por dron: el mismo que insiste recibe el suyo, otro se entera de quién se adelantó', async () => {
    expect((await pedir(oper2)).status).toBe(202);
    t += 2_000;
    const otra = await pedir(oper2);
    expect(otra.status).toBe(202);
    expect(otra.body.pedido.restanteMs).toBe(8_000);
    const sup1 = await pedir(sup);
    expect(sup1.status).toBe(409);
    expect(sup1.body.error).toBe('oper2 ya pidió el control de este dron: esperá a que le contesten');
    await wait(80);
    expect(titularWs.got.filter((m) => m.type === 'control_request')).toHaveLength(1);
  });

  it('pedir un dron libre o propio lo da en el acto', async () => {
    const propio = await pedir(op);
    expect(propio.status).toBe(200);
    expect(propio.body).toMatchObject({ resultado: 'otorgado', drone: { controlledBy: 'operador' } });
    await api(srv.base, `/api/drones/${A}/control`, op, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
    alfa.got.length = 0;
    const libre = await pedir(oper2);
    expect(libre.body).toMatchObject({ resultado: 'otorgado', drone: { controlledBy: 'oper2' } });
    expect(await alfa.waitFor((m) => m.type === 'control_taken')).toEqual({ type: 'control_taken', by: 'oper2' });
  });

  it('permisos: pedir exige canControl; contestar, ser el titular; cancelar, ser el que pidió', async () => {
    expect((await pedir(sinControl)).status).toBe(403);
    expect((await api(srv.base, '/api/drones/fantasma/control/request', op, { method: 'POST' })).status).toBe(404);
    expect((await api(srv.base, '/api/drones/fantasma/control/request/answer', op, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await api(srv.base, '/api/drones/fantasma/control/request', op, { method: 'DELETE' })).status).toBe(404);
    expect((await contestar(op, 'ceder')).status).toBe(409);
    expect((await cancelar(oper2)).status).toBe(409);

    expect((await pedir(oper2)).status).toBe(202);
    const malo = await contestar(op, 'quizas');
    expect(malo.status).toBe(400);
    expect(malo.body.error).toBe("respuesta debe ser 'ceder' o 'mantener'");
    // ni el que pidió ni un supervisor contestan por el titular
    for (const tok of [oper2, sup]) expect((await contestar(tok, 'ceder')).status).toBe(403);
    expect((await cancelar(op)).status).toBe(403);
    expect(await titular()).toBe('operador');
  });

  it('el que pidió se arrepiente y cancela', async () => {
    expect((await pedir(oper2)).status).toBe(202);
    const r = await cancelar(oper2);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resultado: 'cancelado' });
    expect(await resultado(titularWs)).toMatchObject({ resultado: 'cancelado', motivo: 'oper2 canceló el pedido' });
  });

  it('si el que pidió cierra su última consola, el pedido se cancela: no se le da un dron a quien no mira', async () => {
    const tercero = await crearUsuario(srv.base, adm, { username: 'fugaz', canControl: true });
    const tok = (await login(srv.base, 'fugaz', tercero.password))!;
    const consola = await connectWs(srv.wsUrl, tok);
    expect((await pedir(tok)).status).toBe(202);
    await consola.close();
    expect(await resultado(titularWs)).toMatchObject({
      solicitante: 'fugaz', resultado: 'cancelado', motivo: 'fugaz se desconectó del Comando Central',
    });
    t += PLAZOS_DEL_CONTROL.respuestaMs;
    control.barrer();
    expect(await titular()).toBe('operador');
  });

  it('si el titular suelta en el medio, el pedido termina liberado y el dron no se le da solo', async () => {
    expect((await pedir(oper2)).status).toBe(202);
    await api(srv.base, `/api/drones/${A}/control`, op, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
    expect(await resultado(pideWs)).toMatchObject({ resultado: 'liberado', motivo: 'operador soltó el control' });
    expect(await titular()).toBeNull();
  });

  it('el «Quitar control» de un supervisor sigue siendo inmediato y termina el pedido', async () => {
    expect((await pedir(oper2)).status).toBe(202);
    const r = await api(srv.base, `/api/drones/${A}/control`, sup, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
    expect(r.status).toBe(200);
    expect(await resultado(pideWs)).toMatchObject({ resultado: 'liberado', motivo: 'supervisor le quitó el control a operador' });
    expect(await alfa.waitFor((m) => m.type === 'control_released')).toEqual({ type: 'control_released', by: 'supervisor' });
  });

  it('suspenderle el control al que pidió cancela su pedido en el acto', async () => {
    expect((await pedir(oper2)).status).toBe(202);
    await api(srv.base, '/api/users/oper2', adm, { method: 'PATCH', body: JSON.stringify({ canControl: false }) });
    expect(await resultado(titularWs)).toMatchObject({ resultado: 'cancelado', motivo: 'control suspendido' });
    expect(await titular()).toBe('operador');
  });

  it('el titular con dos consolas: contesta desde una y las dos se enteran', async () => {
    const otraPestania = await connectWs(srv.wsUrl, op);
    extras.push(otraPestania);
    expect((await pedir(oper2)).status).toBe(202);
    await otraPestania.waitFor((m) => m.type === 'control_request');
    await contestar(op, 'mantener');
    expect(await resultado(otraPestania)).toMatchObject({ resultado: 'mantenido' });
    expect(await resultado(titularWs)).toMatchObject({ resultado: 'mantenido' });
  });
});
