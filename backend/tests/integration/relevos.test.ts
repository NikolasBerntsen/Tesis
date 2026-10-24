import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db';
import { PLAZOS } from '../../src/relevos';
import { relojDelHub } from '../../src/reloj';
import { relevos } from '../../src/ws';
import { cumpleContrato } from '../contrato';
import {
  CREDS, DRON, api, connectWs, crearUsuario, login, mkStatus, seed, startServer, tokenDeDron, wait,
  type TestServer, type WsClient,
} from '../helpers';

// Relevos de punta a punta: drones falsos por WebSocket, consolas reales y la
// API, con el reloj del hub en la mano para los plazos. Todo lo que el hub le
// manda a un dron se controla contra el contrato (§2.b) al final de cada prueba.

const A = DRON.alfa;
const B = DRON.bravo;
/** Base Norte de la semilla: la de Alfa. */
const NORTE = { lat: -34.8565, lon: -56.2075 };
const EN_ESPERA = { enEspera: true, disponible: true, relayId: null, rol: null, fase: null };

describe('integración — relevos entre drones', () => {
  let srv: TestServer;
  let op = '';
  let sup = '';
  let campo = '';
  const sockets: WsClient[] = [];
  const drones: WsClient[] = [];
  let t = 0;
  const relojReal = relojDelHub.ahora;

  const conn = async (token: string) => {
    const c = await connectWs(srv.wsUrl, token);
    sockets.push(c);
    return c;
  };
  const dron = async (hash: string) => {
    const c = await conn(tokenDeDron(hash));
    drones.push(c);
    return c;
  };
  const manda = (c: WsClient, m: Record<string, unknown>) => c.ws.send(JSON.stringify(m));
  /** Bravo en el suelo, en espera, en la base de Alfa. */
  const bEnEspera = (c: WsClient, extra: Record<string, unknown> = {}) =>
    manda(c, JSON.parse(mkStatus({ state: 'IDLE', battery: 92, ...NORTE, alt: 0, flying: false, relevo: EN_ESPERA, ...extra })));
  /**
   * Alfa en tierra en su base antes de volar: el hub anota ahí su despegue. Un
   * relevo de seguimiento sale solo de esa base, la de su cero de altura
   * (RELEVOS §3.2).
   */
  const aDespegaDeNorte = (c: WsClient) =>
    manda(c, JSON.parse(mkStatus({ state: 'IDLE', battery: 95, lat: NORTE.lat + 0.0002, lon: NORTE.lon, alt: 0, flying: false })));
  /** El relevo de la consola por id, vía REST. */
  const relevoPorApi = async (id: number) =>
    (await api(srv.base, '/api/relevos', op)).body.find((r: any) => r.id === id);

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    campo = (await login(srv.base, 'campo', CREDS.campo))!;
  });

  beforeEach(() => {
    // Cada prueba arranca sin relevos activos y con el reloj del hub quieto.
    db.exec('DELETE FROM relevo_refs; DELETE FROM relevos;');
    t = Date.now();
    relojDelHub.ahora = () => t;
  });

  afterEach(async () => {
    for (const d of drones) {
      for (const m of d.got) expect(cumpleContrato(m), JSON.stringify(m)).toBe(true);
    }
    drones.length = 0;
    for (const s of sockets) await s.close();
    sockets.length = 0;
    relojDelHub.ahora = relojReal;
    await wait(50);
  });

  afterAll(async () => {
    await srv.close();
  });

  it('caso A completo: reserva, orden al bajar, relay_go con A abajo y COMPLETADO', async () => {
    const consola = await conn(op);
    const a = await dron(A);
    const b = await dron(B);
    bEnEspera(b);
    await consola.waitFor((m) => m.type === 'status' && m.droneId === B);

    manda(a, { type: 'relay_request', ref: 'pa-1', motivo: 'patrulla', routeId: 1, fromIndex: 2 });
    const st = await a.waitFor((m) => m.type === 'relay_status' && m.ref === 'pa-1');
    expect(st).toMatchObject({ estado: 'RESERVADO', relevo: { droneId: B, displayName: 'Bravo' }, etaS: null, motivoFin: null });
    const id = st.relayId;
    const actualizado = await consola.waitFor((m) => m.type === 'relay_updated' && m.relay.id === id);
    expect(actualizado.relay).toMatchObject({ estado: 'RESERVADO', origen: { droneId: A }, routeId: 1, fromIndex: 2 });
    const pedido = await consola.waitFor((m) => m.type === 'event' && m.event.type === 'RELAY_REQUESTED');
    expect(pedido.event).toMatchObject({ drone_id: A, source: 'backend' });

    // La consola lo puede pedir por REST al montar
    const activos = await api(srv.base, '/api/relevos?activos=1', op);
    expect(activos.status).toBe(200);
    expect(activos.body.map((r: any) => r.id)).toEqual([id]);

    manda(a, { type: 'landing_at_base', ref: 'pa-1', relayId: id, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    const start = await b.waitFor((m) => m.type === 'relay_start');
    expect(start).toMatchObject({ relayId: id, fromIndex: 2, de: { droneId: A, displayName: 'Alfa' } });

    manda(b, { type: 'relay_accept', relayId: id });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'EN_CAMINO');
    await wait(100);
    expect(b.got.some((m) => m.type === 'relay_go')).toBe(false);

    manda(a, { type: 'landed_at_base', relayId: id, baseId: 1, ...NORTE });
    await b.waitFor((m) => m.type === 'relay_go' && m.relayId === id);
    manda(b, { type: 'relay_ready', relayId: id });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'COMPLETADO');

    const tipos = consola.got.filter((m) => m.type === 'event' && m.event.type.startsWith('RELAY_')).map((m) => m.event.type);
    expect(tipos).toEqual(['RELAY_REQUESTED', 'RELAY_ASSIGNED', 'RELAY_STARTED', 'RELAY_COMPLETED']);
    expect((await api(srv.base, '/api/relevos?activos=1', op)).body).toEqual([]);
    expect((await relevoPorApi(id)).estado).toBe('COMPLETADO');
    // y quedaron en el registro, filtrables por A
    const registro = (await api(srv.base, `/api/events?droneId=${A}`, op)).body.filter((e: any) => e.type.startsWith('RELAY_'));
    expect(registro).toHaveLength(4);
  });

  it('el mismo relay_request repetido no crea otro relevo', async () => {
    const a = await dron(A);
    for (let i = 0; i < 3; i++) manda(a, { type: 'relay_request', ref: 'dup', motivo: 'patrulla', routeId: 1, fromIndex: 0 });
    await a.waitFor(() => a.got.filter((m) => m.type === 'relay_status').length === 3);
    const ids = new Set(a.got.filter((m) => m.type === 'relay_status').map((m) => m.relayId));
    expect(ids.size).toBe(1);
    expect((await api(srv.base, '/api/relevos?activos=1', op)).body).toHaveLength(1);
  });

  it('B no contesta en 10 s: relay_cancel vencido; un B que se desconecta 20 s en camino deja el relevo FALLIDO', async () => {
    const consola = await conn(op);
    const a = await dron(A);
    const b = await dron(B);
    bEnEspera(b);
    await consola.waitFor((m) => m.type === 'status' && m.droneId === B);
    manda(a, { type: 'landing_at_base', ref: 'pz', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 0 });
    const { relayId: id } = await b.waitFor((m) => m.type === 'relay_start');

    t += PLAZOS.respuestaDeBMs;
    relevos.barrer();
    expect(await b.waitFor((m) => m.type === 'relay_cancel')).toEqual({ type: 'relay_cancel', relayId: id, motivo: 'vencido' });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'SIN_RELEVO');

    // B vuelve a estar disponible, el barrido lo asigna de nuevo, acepta y se cae
    db.prepare("UPDATE relevos SET rechazados = '[]' WHERE id = ?").run(id);
    bEnEspera(b);
    await wait(80);
    relevos.barrer();
    await b.waitFor((m) => m.type === 'relay_start' && b.got.filter((x) => x.type === 'relay_start').length === 2);
    manda(b, { type: 'relay_accept', relayId: id });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'EN_CAMINO');
    await b.close();
    await wait(80);
    t += PLAZOS.relevoDesconectadoMs + 1;
    relevos.barrer();
    const fin = await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'FALLIDO');
    expect(fin.motivoFin).toBe('relevo_desconectado');
    await consola.waitFor((m) => m.type === 'event' && m.event.type === 'RELAY_FAILED');
  });

  it('B que se reconecta con su relayId recibe otra vez la orden; con uno terminado, relay_cancel terminado', async () => {
    const a = await dron(A);
    let b = await dron(B);
    bEnEspera(b);
    await wait(80);
    manda(a, { type: 'landing_at_base', ref: 'pr', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 1 });
    const { relayId: id } = await b.waitFor((m) => m.type === 'relay_start');
    manda(b, { type: 'relay_accept', relayId: id });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'EN_CAMINO');

    await b.close();
    b = await dron(B);
    const enCamino = { enEspera: false, disponible: false, relayId: id, rol: 'relevo', fase: 'esperando_despegue' };
    manda(b, JSON.parse(mkStatus({ state: 'IDLE', ...NORTE, alt: 0, relevo: enCamino })));
    expect(await b.waitFor((m) => m.type === 'relay_start')).toMatchObject({ relayId: id, fromIndex: 1 });

    manda(a, { type: 'landed_at_base', relayId: id, baseId: 1, ...NORTE });
    await b.waitFor((m) => m.type === 'relay_go');
    manda(b, { type: 'relay_ready', relayId: id });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'COMPLETADO');

    await b.close();
    b = await dron(B);
    manda(b, JSON.parse(mkStatus({ state: 'PATROLLING', relevo: { ...enCamino, fase: 'en_camino' } })));
    expect(await b.waitFor((m) => m.type === 'relay_cancel')).toEqual({ type: 'relay_cancel', relayId: id, motivo: 'terminado' });
  });

  it('caso B: seguimiento con traspaso, la alerta cambia de dueño y las decisiones van al que la sigue', async () => {
    const consola = await conn(op);
    const a = await dron(A);
    const b = await dron(B);

    manda(a, { type: 'alert_request', alertType: 'VEHICLE', lat: -34.85, lon: -56.2, snapshotBase64: 'S', ref: 'obj' });
    const { alertId } = await a.waitFor((m) => m.type === 'alert_ack' && m.ref === 'obj');
    const target = {
      alertId, type: 'VEHICLE', lat: -34.85, lon: -56.2, speedMs: 4.2, courseDeg: 90, moving: true, lost: false,
      lastSeenMs: 600, decision: 'PENDING',
    };
    const statusDeA = (extra: Record<string, unknown> = {}) =>
      manda(a, JSON.parse(mkStatus({ state: 'FOLLOWING', battery: 38, lat: -34.8507, lon: -56.1999, alt: 40, target, ...extra })));
    aDespegaDeNorte(a);
    statusDeA();
    // Bravo en la base de la que despegó Alfa (Norte, ~1 km del objetivo)
    manda(b, JSON.parse(mkStatus({ state: 'IDLE', battery: 95, ...NORTE, alt: 0, relevo: EN_ESPERA })));
    await consola.waitFor((m) => m.type === 'status' && m.droneId === B);

    manda(a, { type: 'relay_request', ref: 'seg', motivo: 'seguimiento', alertId, segundosDisponibles: 400 });
    const orden = await b.waitFor((m) => m.type === 'relay_tracking');
    expect(orden).toMatchObject({ alertId, decision: 'PENDING', de: { droneId: A } });
    expect(orden.objetivo).toMatchObject({ alertId, lat: -34.85, lon: -56.2 });
    const id = orden.relayId;
    const st = await a.waitFor((m) => m.type === 'relay_status' && m.ref === 'seg');
    expect(st.etaS).toBeGreaterThan(150);

    manda(b, { type: 'relay_accept', relayId: id });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'EN_CAMINO');
    statusDeA({ alt: 42 });
    expect(await b.waitFor((m) => m.type === 'relay_target')).toMatchObject({ relayId: id, origen: 'en_linea', aAlt: 42 });

    // Antes del traspaso la decisión va a A, y B la recibe en el relay_target
    expect((await api(srv.base, `/api/alerts/${alertId}/decision`, op, { method: 'POST', body: JSON.stringify({ decision: 'VALIDATED' }) })).status).toBe(200);
    await a.waitFor((m) => m.type === 'alert_decision' && m.alertId === alertId);
    statusDeA();
    await b.waitFor((m) => m.type === 'relay_target' && m.decision === 'VALIDATED');
    expect(b.got.some((m) => m.type === 'alert_decision')).toBe(false);

    manda(b, { type: 'relay_ready', relayId: id });
    expect(await a.waitFor((m) => m.type === 'relay_done')).toEqual({
      type: 'relay_done', relayId: id, alertId, relevadoPor: { droneId: B, displayName: 'Bravo' },
    });
    const cambio = await consola.waitFor((m) => m.type === 'alert_updated' && m.alert.id === alertId && m.alert.seguidaPor);
    expect(cambio.alert).toMatchObject({ seguidaPor: B, drone_id: A, status: 'VALIDATED' });
    expect((await api(srv.base, `/api/alerts/${alertId}`, op)).body.seguidaPor).toBe(B);
    expect((await api(srv.base, '/api/alerts', op)).body.find((x: any) => x.id === alertId).seguidaPor).toBe(B);

    // Los eventos de seguimiento se encadenan a la alerta si los manda el que la sigue
    manda(b, { type: 'event', eventType: 'TARGET_LOST', message: 'de B', alertId });
    manda(a, { type: 'event', eventType: 'TARGET_LOST', message: 'de A', alertId });
    const deB = await consola.waitFor((m) => m.type === 'event' && m.event.message === 'de B');
    const deA = await consola.waitFor((m) => m.type === 'event' && m.event.message === 'de A');
    expect(deB.event.alert_id).toBe(alertId);
    expect(deA.event.alert_id).toBeNull();

    manda(a, { type: 'relay_released', relayId: id });
    await b.waitFor((m) => m.type === 'relay_target' && m.origen === 'retirado');
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'COMPLETADO');

    // B se reconecta: las decisiones de la alerta que sigue ahora le llegan a él
    await b.close();
    const b2 = await dron(B);
    const reenviada = await b2.waitFor((m) => m.type === 'alert_decision' && m.alertId === alertId);
    expect(reenviada).toMatchObject({ decision: 'VALIDATED', resent: true });
  });

  it('B rechaza: el relevo se le ofrece al siguiente de la base, y el rechazo queda en el registro', async () => {
    const consola = await conn(op);
    const a = await dron(A);
    const b = await dron(B);
    const c = await dron(DRON.charlie);
    bEnEspera(b, { battery: 99 });
    manda(c, JSON.parse(mkStatus({ state: 'IDLE', battery: 70, lat: NORTE.lat + 0.0001, lon: NORTE.lon, alt: 0, relevo: EN_ESPERA })));
    await consola.waitFor((m) => m.type === 'status' && m.droneId === DRON.charlie);
    manda(a, { type: 'landing_at_base', ref: 'rj', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 0 });
    const { relayId: id } = await b.waitFor((m) => m.type === 'relay_start');
    manda(b, { type: 'relay_reject', relayId: id, motivo: 'cancelado_en_campo', detalle: 'Cancelado desde el teléfono' });
    expect(await c.waitFor((m) => m.type === 'relay_start')).toMatchObject({ relayId: id });
    const rechazo = await consola.waitFor((m) => m.type === 'event' && m.event.type === 'RELAY_REJECTED');
    expect(JSON.parse(rechazo.event.meta).detalle).toMatchObject({ relevoHash: B, motivoDeB: 'cancelado_en_campo' });
    expect((await relevoPorApi(id)).rechazados).toEqual([B]);
  });

  it('un relevo tardío espera a que la alerta se valide; A abandona y la alerta pasa a B en camino', async () => {
    const consola = await conn(op);
    const a = await dron(A);
    const b = await dron(B);
    manda(a, { type: 'alert_request', alertType: 'PERSON', lat: -34.85, lon: -56.2, snapshotBase64: 'S', ref: 'tarde' });
    const { alertId } = await a.waitFor((m) => m.type === 'alert_ack' && m.ref === 'tarde');
    const target = {
      alertId, type: 'PERSON', lat: -34.85, lon: -56.2, speedMs: 0, courseDeg: 0, moving: false, lost: false,
      lastSeenMs: 0, decision: 'PENDING',
    };
    aDespegaDeNorte(a);
    manda(a, JSON.parse(mkStatus({ state: 'ORBITING', lat: -34.8503, lon: -56.2, alt: 40, target })));
    // Bravo tarda unos 155 s y a Alfa le quedan 60: con la alerta pendiente no sale
    manda(b, JSON.parse(mkStatus({ state: 'IDLE', ...NORTE, alt: 0, relevo: EN_ESPERA })));
    await consola.waitFor((m) => m.type === 'status' && m.droneId === B);
    manda(a, { type: 'relay_request', ref: 'tarde-r', motivo: 'seguimiento', alertId, segundosDisponibles: 60 });
    const st = await a.waitFor((m) => m.type === 'relay_status' && m.ref === 'tarde-r');
    expect(st.estado).toBe('SIN_RELEVO');
    relevos.barrer();
    await wait(80);
    expect(b.got.some((m) => m.type === 'relay_tracking')).toBe(false);

    // validada, el mismo pedido pendiente sale en el barrido
    await api(srv.base, `/api/alerts/${alertId}/decision`, op, { method: 'POST', body: JSON.stringify({ decision: 'VALIDATED' }) });
    relevos.barrer();
    const orden = await b.waitFor((m) => m.type === 'relay_tracking');
    expect(orden).toMatchObject({ relayId: st.relayId, decision: 'VALIDATED' });
    manda(b, { type: 'relay_accept', relayId: st.relayId });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'EN_CAMINO');

    manda(a, { type: 'relay_abandon', relayId: st.relayId, motivo: 'piso' });
    expect(await b.waitFor((m) => m.type === 'relay_target')).toMatchObject({ origen: 'retirado', alertId });
    const cambio = await consola.waitFor((m) => m.type === 'alert_updated' && m.alert.id === alertId && m.alert.seguidaPor);
    expect(cambio.alert.seguidaPor).toBe(B);
  });

  it('una alerta descartada con B en camino: alert_decision al que la sigue y relay_cancel alerta_descartada a B', async () => {
    const a = await dron(A);
    const b = await dron(B);
    manda(a, { type: 'alert_request', alertType: 'PERSON', lat: -34.85, lon: -56.2, snapshotBase64: 'S', ref: 'fp' });
    const { alertId } = await a.waitFor((m) => m.type === 'alert_ack' && m.ref === 'fp');
    const target = {
      alertId, type: 'PERSON', lat: -34.85, lon: -56.2, speedMs: 0, courseDeg: 0, moving: false, lost: false,
      lastSeenMs: 0, decision: 'PENDING',
    };
    aDespegaDeNorte(a);
    manda(a, JSON.parse(mkStatus({ state: 'ORBITING', lat: -34.8503, lon: -56.2, alt: 40, target })));
    manda(b, JSON.parse(mkStatus({ state: 'IDLE', ...NORTE, alt: 0, relevo: EN_ESPERA })));
    await wait(80);
    manda(a, { type: 'relay_request', ref: 'fp-r', motivo: 'seguimiento', alertId, segundosDisponibles: 900 });
    const { relayId: id } = await b.waitFor((m) => m.type === 'relay_tracking');
    manda(b, { type: 'relay_accept', relayId: id });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'EN_CAMINO');

    await api(srv.base, `/api/alerts/${alertId}/decision`, op, { method: 'POST', body: JSON.stringify({ decision: 'DISMISSED' }) });
    await a.waitFor((m) => m.type === 'alert_decision' && m.decision === 'DISMISSED');
    expect(await b.waitFor((m) => m.type === 'relay_cancel')).toEqual({ type: 'relay_cancel', relayId: id, motivo: 'alerta_descartada' });
    expect((await relevoPorApi(id)).motivoFin).toBe('alerta_descartada');
  });

  it('órdenes del operador: hacia B cancelan sin relay_cancel; hacia A en un seguimiento son un abandono', async () => {
    const consola = await conn(op);
    const a = await dron(A);
    const b = await dron(B);
    bEnEspera(b);
    await consola.waitFor((m) => m.type === 'status' && m.droneId === B);
    manda(a, { type: 'landing_at_base', ref: 'op', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 0 });
    const { relayId: id } = await b.waitFor((m) => m.type === 'relay_start');
    manda(b, { type: 'relay_accept', relayId: id });
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'EN_CAMINO');

    const r = await api(srv.base, `/api/drones/${B}/route/start`, op, { method: 'POST', body: JSON.stringify({ routeId: 2 }) });
    expect(r.body.delivered).toBe(true);
    await b.waitFor((m) => m.type === 'start_route');
    const fin = await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'CANCELADO');
    expect(fin.motivoFin).toBe('orden_del_operador');
    expect(b.got.some((m) => m.type === 'relay_cancel')).toBe(false);

    // A en un seguimiento: un stop hacia A cuenta como relay_abandon
    manda(a, { type: 'alert_request', alertType: 'VEHICLE', lat: -34.85, lon: -56.2, snapshotBase64: 'S', ref: 'op-a' });
    const { alertId } = await a.waitFor((m) => m.type === 'alert_ack' && m.ref === 'op-a');
    const target = {
      alertId, type: 'VEHICLE', lat: -34.85, lon: -56.2, speedMs: 0, courseDeg: 0, moving: false, lost: false,
      lastSeenMs: 0, decision: 'PENDING',
    };
    aDespegaDeNorte(a);
    manda(a, JSON.parse(mkStatus({ state: 'ORBITING', lat: -34.8503, lon: -56.2, alt: 40, target })));
    manda(b, JSON.parse(mkStatus({ state: 'IDLE', ...NORTE, alt: 0, relevo: EN_ESPERA })));
    await wait(80);
    manda(a, { type: 'relay_request', ref: 'op-s', motivo: 'seguimiento', alertId, segundosDisponibles: 900 });
    const { relayId: idS } = await b.waitFor((m) => m.type === 'relay_tracking');
    manda(b, { type: 'relay_accept', relayId: idS });
    await a.waitFor((m) => m.type === 'relay_status' && m.relayId === idS && m.estado === 'EN_CAMINO');
    await api(srv.base, `/api/drones/${A}/route/stop`, op, { method: 'POST' });
    // A queda quieto sobre su órbita: "retirado" no es "lejos", y B lo sabe por la posición
    const retirado = await b.waitFor((m) => m.type === 'relay_target' && m.relayId === idS && m.origen === 'retirado');
    expect(retirado).toMatchObject({ aLat: -34.8503, aLon: -56.2, aAlt: 40, aEnTierra: false });
    expect((await api(srv.base, `/api/alerts/${alertId}`, op)).body.seguidaPor).toBe(B);

    // forzar a un nodo o reanudar a B también cancelan
    await api(srv.base, `/api/drones/${B}/goto`, op, { method: 'POST', body: JSON.stringify({ routeId: 1, index: 0 }) });
    await a.waitFor((m) => m.type === 'relay_status' && m.relayId === idS && m.estado === 'CANCELADO');
  });

  it('soltar el control de un dron en un relevo nunca manda resume_patrol ni lo cancela; reanudarlo a mano sí', async () => {
    const adm = (await login(srv.base, 'admin', CREDS.admin))!;
    const p = await crearUsuario(srv.base, adm, { username: 'piloto-relevo', canControl: true });
    const piloto = (await login(srv.base, 'piloto-relevo', p.password))!;
    const a = await dron(A);
    const b = await dron(B);
    bEnEspera(b);
    await wait(80);
    manda(a, { type: 'landing_at_base', ref: 'ctl', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 0 });
    const { relayId: id } = await b.waitFor((m) => m.type === 'relay_start');

    // tomar el control de B no cancela nada, y si al piloto se le cae la consola
    // se suelta con 'none' aunque B no tenga objetivo
    const consolaPiloto = await conn(piloto);
    expect((await api(srv.base, `/api/drones/${B}/control`, piloto, { method: 'POST' })).status).toBe(200);
    await consolaPiloto.close();
    await b.waitFor((m) => m.type === 'control_released');
    await wait(100);
    expect(b.got.some((m) => m.type === 'resume_patrol')).toBe(false);
    expect((await relevoPorApi(id)).estado).toBe('ORDENADO');

    // soltarlo a mano tampoco es una orden: la consola pide 'last' (B no tiene
    // objetivo) y el hub lo suelta igual sin resume_patrol (RELEVOS §3.9)
    const consola2 = await conn(piloto);
    const liberados = (c: WsClient) => c.got.filter((m) => m.type === 'control_released').length;
    await api(srv.base, `/api/drones/${B}/control`, piloto, { method: 'POST' });
    const soltar = await api(srv.base, `/api/drones/${B}/control`, piloto, {
      method: 'DELETE', body: JSON.stringify({ resume: 'last' }),
    });
    expect(soltar.status).toBe(200);
    expect(soltar.body.controlledBy).toBeNull();
    await b.waitFor(() => liberados(b) === 2);
    // A, que vuelve por batería con el pedido en curso, tampoco recibe una
    // reanudación, ni aunque la consola pida un nodo
    await api(srv.base, `/api/drones/${A}/control`, piloto, { method: 'POST' });
    await api(srv.base, `/api/drones/${A}/control`, piloto, { method: 'DELETE', body: JSON.stringify({ resume: 1 }) });
    await a.waitFor(() => liberados(a) === 1);
    await wait(100);
    expect(b.got.some((m) => m.type === 'resume_patrol')).toBe(false);
    expect(a.got.some((m) => m.type === 'resume_patrol')).toBe(false);
    expect((await relevoPorApi(id)).estado).toBe('ORDENADO');

    // la orden explícita de reanudar sí cuenta: cancela el relevo y le llega a B
    await api(srv.base, `/api/drones/${B}/control`, piloto, { method: 'POST' });
    expect((await api(srv.base, `/api/drones/${B}/resume`, piloto, { method: 'POST' })).status).toBe(200);
    await b.waitFor((m) => m.type === 'resume_patrol');
    expect((await relevoPorApi(id)).motivoFin).toBe('orden_del_operador');
    await consola2.close();
  });

  it('caso D: rth_diverted deja RTH_DIVERTED y despacha a B en el acto', async () => {
    const consola = await conn(op);
    const a = await dron(A);
    const b = await dron(B);
    bEnEspera(b);
    await consola.waitFor((m) => m.type === 'status' && m.droneId === B);
    manda(a, { type: 'relay_request', ref: 'dv', motivo: 'patrulla', routeId: 1, fromIndex: 1 });
    const { relayId: id } = await a.waitFor((m) => m.type === 'relay_status' && m.ref === 'dv');
    manda(a, { type: 'rth_diverted', relayId: id, baseId: 3, lat: -34.857, lon: -56.2015, motivo: 'otra_base' });
    await b.waitFor((m) => m.type === 'relay_go');
    expect(b.got.filter((m) => m.type.startsWith('relay_')).map((m) => m.type)).toEqual(['relay_start', 'relay_go']);
    const ev = await consola.waitFor((m) => m.type === 'event' && m.event.type === 'RTH_DIVERTED');
    expect(JSON.parse(ev.event.meta).detalle).toEqual({ motivo: 'otra_base', baseId: 3, base: 'Base Este', relevoId: id });
    expect(relevos.baseBloqueada(3)).toBe(true);
    // aterrizó en la base destino: se levanta el bloqueo
    manda(a, { type: 'landed_at_base', relayId: id, baseId: 3, lat: null, lon: null });
    await wait(100);
    expect(relevos.baseBloqueada(3)).toBe(false);
  });

  it('un mensaje inválido o que no corresponde se descarta: sin respuesta, sin fila en events, con aviso en el log', async () => {
    const a = await dron(A);
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const antes = (await api(srv.base, '/api/events?limit=1000', op)).body.length;
      manda(a, { type: 'relay_request', ref: 'x'.repeat(65), motivo: 'patrulla', routeId: 1, fromIndex: 0 });
      manda(a, { type: 'relay_ready', relayId: 999 });
      manda(a, { type: 'rth_diverted', relayId: null, baseId: 2, lat: null, lon: null, motivo: 'emergencia' });
      manda(a, { type: 'emergency_photo', ref: 'nadie', seq: 0 });
      // y los eventos que crea solo el hub no se aceptan de una app
      manda(a, { type: 'event', eventType: 'RELAY_COMPLETED', message: 'falso' });
      manda(a, { type: 'event', eventType: 'EMERGENCY_RECOVERED', message: 'falso' });
      manda(a, { type: 'event', eventType: 'RTH_DIVERTED', message: 'falso' });
      await wait(200);
      // lo único que recibe es lo de toda conexión: sus bases y las decisiones recientes
      expect(a.got.filter((m) => m.type !== 'bases' && m.type !== 'alert_decision')).toEqual([]);
      expect((await api(srv.base, '/api/events?limit=1000', op)).body.length).toBe(antes);
      expect(avisos).toHaveBeenCalledTimes(7);
      expect(a.ws.readyState).toBe(a.ws.OPEN);
    } finally {
      avisos.mockRestore();
    }
  });

  it('GET /api/relevos es de operador para arriba', async () => {
    expect((await api(srv.base, '/api/relevos', campo)).status).toBe(403);
    expect((await api(srv.base, '/api/relevos', sup)).status).toBe(200);
  });

  it('status: relevo y autonomía se reenvían si cumplen; si no, se sacan (el status sale igual) y se anota', async () => {
    const consola = await conn(op);
    const a = await dron(A);
    const autonomia = { pctParaVolver: 14, pctParaAterrizar: 3, alcanceM: 2400, segundosParaVolver: 95 };
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      a.ws.send(mkStatus({ battery: 61, relevo: EN_ESPERA, autonomia }));
      const bueno = await consola.waitFor((m) => m.type === 'status' && m.battery === 61);
      expect(bueno.relevo).toEqual(EN_ESPERA);
      expect(bueno.autonomia).toEqual(autonomia);

      a.ws.send(mkStatus({ battery: 62, relevo: { ...EN_ESPERA, enEspera: false }, autonomia: { ...autonomia, alcanceM: -1 } }));
      const malo = await consola.waitFor((m) => m.type === 'status' && m.battery === 62);
      expect(malo).not.toHaveProperty('relevo');
      expect(malo).not.toHaveProperty('autonomia');
      expect(malo.state).toBe('PATROLLING');
      expect(avisos).toHaveBeenCalledTimes(2);

      // una app vieja no los manda, y no salen
      a.ws.send(mkStatus({ battery: 63 }));
      const viejo = await consola.waitFor((m) => m.type === 'status' && m.battery === 63);
      expect(viejo).not.toHaveProperty('relevo');
    } finally {
      avisos.mockRestore();
    }
  });
});
