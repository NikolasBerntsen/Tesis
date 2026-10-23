import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONTRATO, claves, ejemplos } from '../contrato';
import {
  CREDS, DRON, api, connectWs, login, seed, startServer, tokenDeDron, wait, type TestServer, type WsClient,
} from '../helpers';

// Conformidad del hub con docs/contrato/relevos.json: lo que difunde a las
// consolas, lo que devuelve la API y las filas que deja en `events` tienen la
// misma forma que los ejemplos del archivo compartido. La consola y la app se
// escriben contra ese archivo: si el hub se aparta, se rompe acá primero.

const A = DRON.alfa;
const B = DRON.bravo;
const NORTE = { lat: -34.8565, lon: -56.2075 };
const EN_ESPERA = { enEspera: true, disponible: true, relayId: null, rol: null, fase: null };

describe('integración — conformidad con docs/contrato/relevos.json', () => {
  let srv: TestServer;
  let op = '';
  let adm = '';
  let campo = '';
  const sockets: WsClient[] = [];

  const conn = async (token: string) => {
    const c = await connectWs(srv.wsUrl, token);
    sockets.push(c);
    return c;
  };
  const manda = (c: WsClient, m: Record<string, unknown>) => c.ws.send(JSON.stringify(m));

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    campo = (await login(srv.base, 'campo', CREDS.campo))!;
  });

  afterEach(async () => {
    for (const s of sockets) await s.close();
    sockets.length = 0;
    await wait(50);
  });

  afterAll(async () => {
    await srv.close();
  });

  /** La fila de `events` del tipo pedido, como la devuelve el registro general. */
  async function evento(tipo: string) {
    const r = await api(srv.base, '/api/logs?pageSize=100', adm);
    return r.body.items.find((e: { type: string }) => e.type === tipo);
  }

  /** La fila del registro con la forma de los ejemplos de `eventos` del archivo. */
  function comoEnElContrato(fila: any) {
    return { type: fila.type, source: fila.source, category: fila.category, drone_id: fila.drone_id, alert_id: fila.alert_id, meta: JSON.parse(fila.meta) };
  }

  /** Mismas claves en la fila, en la meta y en cada objeto de la meta. */
  function mismaForma(real: any, ejemplo: any) {
    expect(claves(real)).toEqual(claves(ejemplo));
    expect(claves(real.meta)).toEqual(claves(ejemplo.meta));
    for (const k of Object.keys(ejemplo.meta)) {
      if (typeof ejemplo.meta[k] === 'object' && ejemplo.meta[k] !== null) {
        expect(claves(real.meta[k]), k).toEqual(claves(ejemplo.meta[k]));
      }
    }
  }

  it('los status del archivo pasan por el hub: relevo y autonomía quedan en los válidos y salen en los inválidos', async () => {
    const consola = await conn(op);
    const a = await conn(tokenDeDron(A));
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { validos, invalidos } = ejemplos('app_al_hub', 'status');
      for (const [i, e] of [...validos, ...invalidos].entries()) {
        manda(a, { ...e.mensaje, signalPct: 500 + i });
        const s = await consola.waitFor((m) => m.type === 'status' && m.signalPct === 500 + i);
        if (i < validos.length) {
          expect(s.relevo, e.caso).toEqual(e.mensaje.relevo);
          if (e.mensaje.autonomia) expect(s.autonomia, e.caso).toEqual(e.mensaje.autonomia);
          expect(s.state).toBe(e.mensaje.state);
        } else {
          const sacado = e.mensaje.autonomia ? 'autonomia' : 'relevo';
          expect(s, e.caso).not.toHaveProperty(sacado);
        }
      }
    } finally {
      avisos.mockRestore();
    }
  });

  it('relay_updated, alert_updated y los eventos de relevo tienen la forma del contrato', async () => {
    const consola = await conn(op);
    const a = await conn(tokenDeDron(A));
    const b = await conn(tokenDeDron(B));
    manda(a, { type: 'alert_request', alertType: 'VEHICLE', lat: -34.85062, lon: -56.19951, snapshotBase64: null, ref: 'c-obj' });
    const { alertId } = await a.waitFor((m) => m.type === 'alert_ack');
    manda(a, {
      type: 'status', state: 'FOLLOWING', battery: 38, lat: -34.8521, lon: -56.2012, alt: 40, flying: true,
      target: { alertId, type: 'VEHICLE', lat: -34.85062, lon: -56.19951, speedMs: 4.2, courseDeg: 90, moving: true, lost: false, lastSeenMs: 600, decision: 'PENDING' },
    });
    manda(b, { type: 'status', state: 'IDLE', battery: 96, ...NORTE, alt: 0, flying: false, relevo: EN_ESPERA });
    await consola.waitFor((m) => m.type === 'status' && m.droneId === B);
    manda(a, { type: 'relay_request', ref: 'c-seg', motivo: 'seguimiento', alertId, segundosDisponibles: 600 });
    const { relayId } = await b.waitFor((m) => m.type === 'relay_tracking');
    manda(b, { type: 'relay_accept', relayId });
    const enCamino = await consola.waitFor((m) => m.type === 'relay_updated' && m.relay.estado === 'EN_CAMINO');

    const [ejemplo] = ejemplos('hub_a_la_consola', 'relay_updated').validos;
    expect(claves(enCamino)).toEqual(claves(ejemplo.mensaje));
    expect(claves(enCamino.relay)).toEqual(claves(ejemplo.mensaje.relay));
    expect(claves(enCamino.relay.origen)).toEqual(claves(ejemplo.mensaje.relay.origen));
    expect(enCamino.relay).toMatchObject({ motivo: 'seguimiento', alertId, routeId: null, fromIndex: null, rechazados: [] });

    // REST: misma forma que el ejemplo de GET /api/relevos?activos=1
    const activos = (await api(srv.base, '/api/relevos?activos=1', op)).body;
    expect(claves(activos[0])).toEqual(claves(CONTRATO.rest['GET /api/relevos?activos=1'].respuesta[0]));

    // el evento de ejemplo es un RELAY_STARTED de seguimiento
    mismaForma(comoEnElContrato(await evento('RELAY_STARTED')), CONTRATO.eventos.RELAY_STARTED);
    expect(comoEnElContrato(await evento('RELAY_STARTED'))).toMatchObject({ source: 'backend', alert_id: alertId, drone_id: A });

    manda(b, { type: 'relay_ready', relayId });
    const traspaso = await consola.waitFor((m) => m.type === 'alert_updated' && m.alert.seguidaPor === B);
    const [ejemploAlerta] = ejemplos('hub_a_la_consola', 'alert_updated').validos;
    expect(claves(traspaso.alert)).toEqual(claves(ejemploAlerta.mensaje.alert));
  });

  it('RTH_DIVERTED y base_updated tienen la forma del contrato', async () => {
    const consola = await conn(adm);
    const a = await conn(tokenDeDron(A));
    manda(a, { type: 'rth_diverted', relayId: null, baseId: 2, lat: -34.879, lon: -56.185, motivo: 'otra_base' });
    await consola.waitFor((m) => m.type === 'event' && m.event.type === 'RTH_DIVERTED');
    const fila = comoEnElContrato(await evento('RTH_DIVERTED'));
    mismaForma(fila, CONTRATO.eventos.RTH_DIVERTED);
    // se levanta el bloqueo para no dejarlo puesto en el resto del archivo
    manda(a, { type: 'landed_at_base', relayId: null, baseId: 2, lat: null, lon: null });

    const r = await api(srv.base, '/api/bases/1', adm, {
      method: 'PATCH', body: JSON.stringify({ aterrizajeLat: -34.85632, aterrizajeLon: -56.2075 }),
    });
    expect(r.status).toBe(200);
    const aviso = await consola.waitFor((m) => m.type === 'base_updated' && m.base.id === 1);
    const [ejemploBase] = ejemplos('hub_a_la_consola', 'base_updated').validos;
    expect(claves(aviso.base)).toEqual(claves(ejemploBase.mensaje.base));
  });

  it('emergency_updated, emergency_photo, la API de emergencias y sus eventos tienen la forma del contrato', async () => {
    const consola = await conn(op);
    const deCampo = await conn(campo);
    const a = await conn(tokenDeDron(A));
    const [aviso] = ejemplos('app_al_hub', 'emergency_landing').validos;
    const fotos = ejemplos('app_al_hub', 'emergency_photo').validos;
    const [aterrizaje] = ejemplos('app_al_hub', 'emergency_landed').validos;

    manda(a, aviso.mensaje);
    const { emergencyId } = await a.waitFor((m) => m.type === 'emergency_ack');
    for (const f of fotos) manda(a, f.mensaje);
    manda(a, aterrizaje.mensaje);
    await a.waitFor((m) => m.type === 'emergency_ack' && m.aterrizada);

    const actualizada = await deCampo.waitFor((m) => m.type === 'emergency_updated' && m.emergencia.fotos === 2 && m.emergencia.aterrizadaEn);
    const [ejUpdated] = ejemplos('hub_a_la_consola', 'emergency_updated').validos;
    expect(claves(actualizada.emergencia)).toEqual(claves(ejUpdated.mensaje.emergencia));
    // los mismos valores que el ejemplo del archivo, salvo lo que pone el hub
    const { id: _id, droneId: _d, displayName: _n, creadaEn: _c, aterrizadaEn: _a, ...datos } = ejUpdated.mensaje.emergencia;
    expect(actualizada.emergencia).toMatchObject(datos);

    const foto = await consola.waitFor((m) => m.type === 'emergency_photo' && m.seq === 0);
    const [ejFoto] = ejemplos('hub_a_la_consola', 'emergency_photo').validos;
    expect(claves(foto)).toEqual(claves(ejFoto.mensaje));
    const { emergenciaId: _e, ...datosFoto } = ejFoto.mensaje;
    expect(foto).toMatchObject(datosFoto);

    const abiertas = (await api(srv.base, '/api/emergencias?abiertas=1', op)).body;
    expect(claves(abiertas[0])).toEqual(claves(CONTRATO.rest['GET /api/emergencias?abiertas=1'].respuesta[0]));
    const detalle = (await api(srv.base, `/api/emergencias/${emergencyId}`, op)).body;
    const ejDetalle = CONTRATO.rest['GET /api/emergencias/:id'].respuesta;
    expect(claves(detalle)).toEqual(claves(ejDetalle));
    expect(detalle.fotos).toEqual(ejDetalle.fotos);
    const recuperada = (await api(srv.base, `/api/emergencias/${emergencyId}/recuperada`, campo, { method: 'POST', body: '{}' })).body;
    expect(claves(recuperada)).toEqual(claves(CONTRATO.rest['POST /api/emergencias/:id/recuperada'].respuesta));

    mismaForma(comoEnElContrato(await evento('EMERGENCY_LANDING')), CONTRATO.eventos.EMERGENCY_LANDING);
    mismaForma(comoEnElContrato(await evento('EMERGENCY_RECOVERED')), CONTRATO.eventos.EMERGENCY_RECOVERED);
    const landed = comoEnElContrato(await evento('EMERGENCY_LANDED'));
    expect(claves(landed.meta)).toEqual(['detalle', 'drone', 'emergencia', 'ubicacion']);
    expect(landed.meta.detalle).toEqual({ alt: 0.2 });
  });

  it('los tipos de evento que crea el hub son los del archivo', async () => {
    const tipos = new Set(
      (await api(srv.base, '/api/logs?pageSize=100', adm)).body.items
        .map((e: { type: string }) => e.type)
        .filter((t: string) => /^(RELAY_|EMERGENCY_|RTH_DIVERTED)/.test(t)),
    );
    for (const t of tipos) expect(CONTRATO.enumerados.eventosDelHub).toContain(t);
    expect(tipos.size).toBeGreaterThanOrEqual(6);
  });
});
