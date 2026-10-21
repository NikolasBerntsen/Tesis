import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { db } from '../../src/db';
import { createAlert } from '../../src/store';
import {
  crearUsuario, seed, startServer, login, api, connectWs, mkStatus, wait, tokenDeDron,
  CREDS, DRON, type TestServer, type WsClient,
} from '../helpers';

/** Objetivo tal como lo manda la app en `status.target` (§1). */
const OBJETIVO = {
  alertId: 12,
  type: 'VEHICLE',
  lat: -34.60412,
  lon: -58.3817,
  speedMs: 4.2,
  courseDeg: 118,
  moving: true,
  lost: false,
  lastSeenMs: 600,
  decision: 'PENDING',
};

// Lo que el hub hace con el seguimiento de un objetivo: el acuse de la alerta
// para que la app sepa cuál es la suya, la trazabilidad de la detección en el
// registro, la posición saneada del status, las decisiones que se perdieron
// con el dron caído y qué pasa con el objetivo cuando el hub suelta el control
// por su cuenta.
describe('integración — objetivo en seguimiento y trazabilidad de la detección', () => {
  let srv: TestServer;
  let op = '';
  let adm = '';
  let sup = '';
  let piloto = '';
  const sockets: WsClient[] = [];

  const conn = async (token: string) => {
    const c = await connectWs(srv.wsUrl, token);
    sockets.push(c);
    return c;
  };

  /**
   * Dispara una alerta desde el dron y devuelve su id, leído del `alert_ack`:
   * es exactamente el camino por el que la app se entera del id.
   */
  async function alertaDesde(dron: WsClient, ref: string, extra: Record<string, unknown> = {}): Promise<number> {
    dron.ws.send(JSON.stringify({ type: 'alert_request', alertType: 'PERSON', lat: -34.85, lon: -56.2, ref, ...extra }));
    const ack = await dron.waitFor((m) => m.type === 'alert_ack' && m.ref === ref);
    return ack.alertId as number;
  }

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    // Un operador propio para los tests de control: abrir y cerrar SU consola
    // es lo que dispara la liberación automática, y no puede ser `operador`,
    // que tiene otras consolas abiertas en el mismo test.
    const p = await crearUsuario(srv.base, adm, { username: 'piloto', canControl: true });
    piloto = (await login(srv.base, 'piloto', p.password))!;
  });

  afterEach(async () => {
    for (const s of sockets) await s.close();
    sockets.length = 0;
    await wait(50); // deja asentar los handlers de cierre del servidor
  });

  afterAll(async () => {
    await srv.close();
  });

  describe('status: la posición se sanea en el hub', () => {
    it('un status en 0,0 sale sin posición y sin fix, aunque la app diga que tiene fix', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      await wait(50);
      // El 0,0 es lo que entrega el SDK de DJI sin fix: una app vieja lo manda
      // como si fuera una posición.
      d1.ws.send(mkStatus({ lat: 0, lon: 0, gpsFix: true, battery: 61 }));
      const s = await opWs.waitFor((m) => m.type === 'status' && m.droneId === DRON.alfa && m.battery === 61);
      expect(s.lat).toBeNull();
      expect(s.lon).toBeNull();
      expect(s.gpsFix).toBe(false);

      // y el último estado que guarda el hub (el de GET /drones y el de la
      // consola que se conecta después) es el saneado, no el crudo
      const ficha = (await api(srv.base, '/api/drones', op)).body.find((d: any) => d.droneId === DRON.alfa);
      expect(ficha.lastStatus).toMatchObject({ lat: null, lon: null, gpsFix: false, battery: 61 });
      const tarde = await conn(op);
      const inicial = await tarde.waitFor((m) => m.type === 'status' && m.droneId === DRON.alfa);
      expect(inicial).toMatchObject({ lat: null, lon: null, gpsFix: false });
    });

    it('una posición que no es número, fuera de rango o casi 0,0 también queda en null', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      await wait(50);
      const malas: unknown[][] = [[null, null], ['-34.85', '-56.2'], [95, -56.2], [-34.85, 181], [1e-7, -1e-7], [-34.85, undefined]];
      for (const [i, [lat, lon]] of malas.entries()) {
        d1.ws.send(mkStatus({ lat, lon, battery: 10 + i }));
        const s = await opWs.waitFor((m) => m.type === 'status' && m.battery === 10 + i);
        expect([s.lat, s.lon, s.gpsFix], JSON.stringify([lat, lon])).toEqual([null, null, false]);
      }
    });

    it('una posición válida sin gpsFix (app vieja) se toma con fix; si la app dice que no, se respeta', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      await wait(50);
      d1.ws.send(mkStatus({ lat: -34.855, lon: -56.206, battery: 71 }));
      const vieja = await opWs.waitFor((m) => m.type === 'status' && m.battery === 71);
      expect(vieja).toMatchObject({ lat: -34.855, lon: -56.206, gpsFix: true });

      // gpsFix en texto no es un booleano: cuenta como que no vino
      d1.ws.send(mkStatus({ lat: -34.855, lon: -56.206, gpsFix: 'si', battery: 72 }));
      expect((await opWs.waitFor((m) => m.type === 'status' && m.battery === 72)).gpsFix).toBe(true);

      d1.ws.send(mkStatus({ lat: -34.855, lon: -56.206, gpsFix: false, battery: 73 }));
      const sinFix = await opWs.waitFor((m) => m.type === 'status' && m.battery === 73);
      expect(sinFix).toMatchObject({ lat: -34.855, lon: -56.206, gpsFix: false });
    });

    it('el target y los demás campos pasan tal cual', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      await wait(50);
      d1.ws.send(mkStatus({ state: 'FOLLOWING', target: OBJETIVO, flightMode: 'VIRTUAL_STICK', satellites: 14, battery: 81 }));
      const s = await opWs.waitFor((m) => m.type === 'status' && m.battery === 81);
      expect(s.target).toEqual(OBJETIVO);
      expect(s.state).toBe('FOLLOWING');
      expect(s.flightMode).toBe('VIRTUAL_STICK');
      expect(s.satellites).toBe(14);
      expect(s.displayName).toBe('Alfa');
    });
  });

  describe('alert_request: acuse y detalle de la detección', () => {
    it('la detección deja confianza, clases y pose del dron en meta.detalle, y el dron recibe el alert_ack', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      const d2 = await conn(tokenDeDron(DRON.bravo));
      await wait(50);
      d1.ws.send(
        JSON.stringify({
          type: 'alert_request',
          alertType: 'VEHICLE',
          lat: -34.8571,
          lon: -56.2088,
          snapshotBase64: 'ANOTADA',
          confidence: 0.82,
          classes: ['VEHICLE', 'PERSON', 'VEHICLE'],
          ref: 'obj-1',
          droneLat: -34.8565,
          droneLon: -56.2075,
          droneAlt: 48.5,
        }),
      );
      const created = await opWs.waitFor((m) => m.type === 'alert_created');
      expect(created.alert).toMatchObject({ type: 'VEHICLE', lat: -34.8571, lon: -56.2088, snapshot: 'ANOTADA' });
      const ev = await opWs.waitFor((m) => m.type === 'event' && m.event.type === 'ALERT_CREATED');
      const meta = JSON.parse(ev.event.meta);
      expect(meta.detalle).toEqual({
        confianza: 0.82,
        clases: 'VEHICLE, PERSON',
        dronLat: -34.8565,
        dronLon: -56.2075,
        dronAlt: 48.5,
      });
      expect(meta.alerta).toEqual({
        id: created.alert.id,
        tipo: 'VEHICLE',
        lat: -34.8571,
        lon: -56.2088,
        ts: created.alert.created_at,
      });

      // El acuse le dice a la app qué id recibió SU alerta
      const ack = await d1.waitFor((m) => m.type === 'alert_ack');
      expect(ack).toEqual({ type: 'alert_ack', ref: 'obj-1', alertId: created.alert.id });
      // y va solo al dron que la pidió
      await wait(100);
      expect(d2.got.some((m) => m.type === 'alert_ack')).toBe(false);
    });

    it('lo inválido del detalle se descarta campo por campo; sin nada válido, no hay detalle', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      await wait(50);

      // Nada sirve: confianza fuera de [0, 1], clases que no son texto, la pose
      // del dron sin longitud y la altura en texto.
      const nada = await alertaDesde(d1, 'sin-detalle', {
        confidence: 1.5,
        classes: [{}, 3],
        droneLat: -34.85,
        droneAlt: '40',
      });
      const ev1 = await opWs.waitFor((m) => m.type === 'event' && m.event.alert_id === nada);
      expect(JSON.parse(ev1.event.meta)).not.toHaveProperty('detalle');

      // Mitad y mitad: la confianza 0 y la altura negativa (bajo el punto de
      // despegue) son datos; la pose en 0,0 es "sin fix" y no entra.
      const parcial = await alertaDesde(d1, 'parcial', {
        confidence: 0,
        classes: ' PERSON ',
        droneLat: 0,
        droneLon: 0,
        droneAlt: -1.5,
      });
      const ev2 = await opWs.waitFor((m) => m.type === 'event' && m.event.alert_id === parcial);
      expect(JSON.parse(ev2.event.meta).detalle).toEqual({ confianza: 0, clases: 'PERSON', dronAlt: -1.5 });
    });

    it('sin ref, con uno vacío, que no es texto o de más de 64 caracteres no hay acuse', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      await wait(50);
      for (const ref of [undefined, '', 42, { id: 1 }, 'x'.repeat(65)]) {
        opWs.got.length = 0;
        d1.ws.send(JSON.stringify({ type: 'alert_request', alertType: 'PERSON', lat: -34.85, lon: -56.2, ref }));
        // la alerta se crea igual: el ref es para la app, no para la consola
        await opWs.waitFor((m) => m.type === 'alert_created');
      }
      // 64 justos sí sirven, y el acuse lo devuelve tal cual llegó
      const justo = ' y'.repeat(32);
      await alertaDesde(d1, justo);
      const acuses = d1.got.filter((m) => m.type === 'alert_ack');
      expect(acuses.map((a) => a.ref)).toEqual([justo]);
    });
  });

  describe('event: los eventos de seguimiento se encadenan a la alerta', () => {
    it('con alertId y posición queda encadenado a la alerta y con la ubicación del objetivo', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      await wait(50);
      const alertId = await alertaDesde(d1, 'seguir-1');
      const alerta = (await api(srv.base, `/api/alerts/${alertId}`, op)).body;

      d1.ws.send(
        JSON.stringify({
          type: 'event',
          eventType: 'TARGET_LOST',
          message: 'Hace 10 s que no se ve al objetivo',
          alertId,
          lat: -34.8581,
          lon: -56.2102,
        }),
      );
      const ev = await opWs.waitFor((m) => m.type === 'event' && m.event.type === 'TARGET_LOST');
      expect(ev.event.alert_id).toBe(alertId);
      const meta = JSON.parse(ev.event.meta);
      expect(meta.alerta).toEqual({ id: alertId, tipo: 'PERSON', lat: -34.85, lon: -56.2, ts: alerta.created_at });
      // la posición del evento es la del OBJETIVO al perderlo, no la de la alerta
      expect(meta.ubicacion).toEqual({ lat: -34.8581, lon: -56.2102, accuracyM: null });
      expect(meta.drone.hash).toBe(DRON.alfa);

      // y quedó así en la base, no solo en el mensaje en vivo
      const guardado = (await api(srv.base, `/api/events?droneId=${DRON.alfa}`, op)).body.find(
        (e: any) => e.type === 'TARGET_LOST',
      );
      expect(guardado.alert_id).toBe(alertId);
      expect(JSON.parse(guardado.meta).ubicacion).toEqual(meta.ubicacion);
    });

    it('un alertId de otro dron, inexistente o que no es un entero no encadena; el evento se registra igual', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      const d2 = await conn(tokenDeDron(DRON.bravo));
      await wait(50);
      const deBravo = await alertaDesde(d2, 'de-bravo');

      const malos: unknown[] = [deBravo, 999_999, String(deBravo), deBravo + 0.5, -1, 0, null, 1e300];
      for (const [i, alertId] of malos.entries()) {
        d1.ws.send(JSON.stringify({ type: 'event', eventType: 'TARGET_MOVING', message: `malo-${i}`, alertId }));
        const ev = await opWs.waitFor((m) => m.type === 'event' && m.event.message === `malo-${i}`);
        expect(ev.event.alert_id, JSON.stringify(alertId)).toBeNull();
        const meta = JSON.parse(ev.event.meta);
        expect(meta, JSON.stringify(alertId)).not.toHaveProperty('alerta');
        expect(meta.drone.hash).toBe(DRON.alfa);
      }
    });

    it('una posición inválida en el evento no deja ubicación', async () => {
      const opWs = await conn(op);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      await wait(50);
      const malas: unknown[][] = [[0, 0], ['-34.85', '-56.2'], [-34.85, 200], [-34.85, null], [undefined, undefined]];
      for (const [i, [lat, lon]] of malas.entries()) {
        d1.ws.send(JSON.stringify({ type: 'event', eventType: 'TARGET_STOPPED', message: `pos-${i}`, lat, lon }));
        const ev = await opWs.waitFor((m) => m.type === 'event' && m.event.message === `pos-${i}`);
        expect(JSON.parse(ev.event.meta), JSON.stringify([lat, lon])).not.toHaveProperty('ubicacion');
      }
    });
  });

  describe('reconexión: las decisiones que se tomaron con el dron caído', () => {
    it('al conectarse, el dron recibe las decisiones de SUS alertas de los últimos 10 minutos, en orden', async () => {
      // Todo se decide con Alfa desconectado: sendToDrone no tiene a quién mandarle
      const decidir = (id: number, decision: string) =>
        api(srv.base, `/api/alerts/${id}/decision`, op, { method: 'POST', body: JSON.stringify({ decision }) });

      const descartada = createAlert('PERSON', DRON.alfa, -34.85, -56.2, null);
      const validada = createAlert('VEHICLE', DRON.alfa, -34.85, -56.2, null);
      const vieja = createAlert('PERSON', DRON.alfa, -34.85, -56.2, null);
      const casiVieja = createAlert('VEHICLE', DRON.alfa, -34.85, -56.2, null);
      const pendiente = createAlert('PERSON', DRON.alfa, -34.85, -56.2, null);
      const ajena = createAlert('PERSON', DRON.bravo, -34.85, -56.2, null);
      // Si las dos caen en el mismo milisegundo, el orden lo desempata el id
      expect((await decidir(descartada.id, 'DISMISSED')).status).toBe(200);
      expect((await decidir(validada.id, 'VALIDATED')).status).toBe(200);
      expect((await decidir(vieja.id, 'DISMISSED')).status).toBe(200);
      expect((await decidir(casiVieja.id, 'DISMISSED')).status).toBe(200);
      expect((await decidir(ajena.id, 'DISMISSED')).status).toBe(200);
      // Las dos puntas de la ventana: la vieja se decidió hace 11 minutos y
      // queda afuera; la de hace 9 entra. Sin la de 9, una ventana de un minuto
      // pasaría este test igual, y un corte largo es justo el caso que importa.
      const haceMinutos = (min: number) => new Date(Date.now() - min * 60 * 1000).toISOString();
      db.prepare('UPDATE alerts SET decided_at = ? WHERE id = ?').run(haceMinutos(11), vieja.id);
      db.prepare('UPDATE alerts SET decided_at = ? WHERE id = ?').run(haceMinutos(9), casiVieja.id);

      const d1 = await conn(tokenDeDron(DRON.alfa));
      await d1.waitFor((m) => m.type === 'alert_decision' && m.alertId === validada.id);
      await wait(100);
      const ids = [descartada.id, validada.id, vieja.id, casiVieja.id, pendiente.id, ajena.id];
      const recibidas = d1.got.filter((m) => m.type === 'alert_decision' && ids.includes(m.alertId));
      // en el orden en que se decidieron: la de hace 9 minutos primero
      // marcadas como reenvío: la app solo las aplica si son su alerta exacta
      expect(recibidas).toEqual([
        { type: 'alert_decision', alertId: casiVieja.id, decision: 'DISMISSED', decidedBy: 'operador', resent: true },
        { type: 'alert_decision', alertId: descartada.id, decision: 'DISMISSED', decidedBy: 'operador', resent: true },
        { type: 'alert_decision', alertId: validada.id, decision: 'VALIDATED', decidedBy: 'operador', resent: true },
      ]);
    });
  });

  describe('el hub suelta el control solo: el objetivo no se abandona', () => {
    /** Piloto con el control de Alfa, y Alfa reportando el status pedido. */
    async function pilotoConControl(status: Record<string, unknown>) {
      const pilotoWs = await conn(piloto);
      const d1 = await conn(tokenDeDron(DRON.alfa));
      expect((await api(srv.base, `/api/drones/${DRON.alfa}/control`, piloto, { method: 'POST' })).status).toBe(200);
      d1.ws.send(mkStatus({ state: 'MANUAL', battery: 66, ...status }));
      // con el status ya en la consola del piloto, el hub lo tiene guardado
      await pilotoWs.waitFor((m) => m.type === 'status' && m.battery === 66);
      d1.got.length = 0;
      return { pilotoWs, d1 };
    }

    it('si al titular se le cae la consola con un objetivo en seguimiento, se suelta sin resume_patrol', async () => {
      const { pilotoWs, d1 } = await pilotoConControl({ target: OBJETIVO });
      await pilotoWs.close();
      await d1.waitFor((m) => m.type === 'control_released');
      await wait(150);
      // con resume_patrol la app TERMINARÍA el seguimiento (§2)
      expect(d1.got.some((m) => m.type === 'resume_patrol')).toBe(false);
    });

    it('sin objetivo (target null o ausente), se suelta con last: el dron vuelve a la ruta', async () => {
      for (const status of [{ target: null }, {}, { target: [] }]) {
        const { pilotoWs, d1 } = await pilotoConControl(status);
        await pilotoWs.close();
        await d1.waitFor((m) => m.type === 'control_released');
        const reanuda = await d1.waitFor((m) => m.type === 'resume_patrol');
        expect(reanuda.fromIndex, JSON.stringify(status)).toBeUndefined();
        await d1.close();
        await wait(50);
      }
    });

    it('suspender el control del titular con un objetivo en seguimiento tampoco lo termina', async () => {
      const { d1 } = await pilotoConControl({ target: OBJETIVO });
      try {
        const r = await api(srv.base, '/api/users/piloto', sup, { method: 'PATCH', body: JSON.stringify({ canControl: false }) });
        expect(r.status).toBe(200);
        await d1.waitFor((m) => m.type === 'control_released');
        await wait(150);
        expect(d1.got.some((m) => m.type === 'resume_patrol')).toBe(false);
      } finally {
        await api(srv.base, '/api/users/piloto', sup, { method: 'PATCH', body: JSON.stringify({ canControl: true }) });
      }
    });
  });
});
