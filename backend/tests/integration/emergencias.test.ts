import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cumpleContrato, ejemplos } from '../contrato';
import {
  CREDS, DRON, api, connectWs, login, seed, startServer, tokenDeDron, wait, type TestServer, type WsClient,
} from '../helpers';

// Protocolo de última ubicación de punta a punta: un dron falso que avisa, manda
// las fotos y aterriza; la consola del operador y la del operador de campo, que
// es quien sale a buscarlo; y la API con la que se lo marca recuperado.

const A = DRON.alfa;
const JPEG = ejemplos('app_al_hub', 'emergency_photo').validos[0].mensaje.jpegBase64 as string;

describe('integración — aterrizaje de emergencia', () => {
  let srv: TestServer;
  let op = '';
  let campo = '';
  const sockets: WsClient[] = [];

  const conn = async (token: string) => {
    const c = await connectWs(srv.wsUrl, token);
    sockets.push(c);
    return c;
  };
  const manda = (c: WsClient, m: Record<string, unknown>) => c.ws.send(JSON.stringify(m));
  const aviso = (ref: string) => ({
    type: 'emergency_landing', ref, motivo: 'autonomia', lat: -34.8702, lon: -56.1902, alt: 38, bateria: 9, ts: 1_792_767_845_000,
  });
  const foto = (ref: string, seq: number, jpegBase64 = JPEG) => ({
    type: 'emergency_photo', ref, seq, tipo: 'cenital', rumbo: 270, inclinacion: -90, lat: -34.8702, lon: -56.1902,
    alt: 30, jpegBase64, ts: 1_792_767_850_000 + seq,
  });

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
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

  it('aviso, fotos y aterrizaje: el dron recibe sus acuses y las dos consolas se enteran', async () => {
    const consola = await conn(op);
    const deCampo = await conn(campo);
    const a = await conn(tokenDeDron(A));
    await wait(50);

    manda(a, aviso('em-1'));
    const ack = await a.waitFor((m) => m.type === 'emergency_ack' && m.ref === 'em-1');
    expect(ack).toEqual({ type: 'emergency_ack', ref: 'em-1', emergencyId: expect.any(Number), aterrizada: false });
    const id = ack.emergencyId;
    for (const c of [consola, deCampo]) {
      const abierta = await c.waitFor((m) => m.type === 'emergency_updated' && m.emergencia.id === id);
      expect(abierta.emergencia).toMatchObject({ droneId: A, displayName: 'Alfa', motivo: 'autonomia', fotos: 0 });
    }
    await consola.waitFor((m) => m.type === 'event' && m.event.type === 'EMERGENCY_LANDING');

    manda(a, foto('em-1', 1));
    manda(a, foto('em-1', 0));
    await a.waitFor((m) => m.type === 'emergency_photo_ack' && m.seq === 0);
    const fotoEnCampo = await deCampo.waitFor((m) => m.type === 'emergency_photo' && m.seq === 1);
    expect(fotoEnCampo).toMatchObject({ emergenciaId: id, tipo: 'cenital', jpegBase64: JPEG });

    manda(a, { type: 'emergency_landed', ref: 'em-1', lat: -34.87021, lon: -56.19018, alt: 0.2, ts: 1_792_767_870_000 });
    expect(await a.waitFor((m) => m.type === 'emergency_ack' && m.aterrizada)).toEqual({
      type: 'emergency_ack', ref: 'em-1', emergencyId: id, aterrizada: true,
    });
    await consola.waitFor((m) => m.type === 'event' && m.event.type === 'EMERGENCY_LANDED');
    const ultima = await deCampo.waitFor((m) => m.type === 'emergency_updated' && m.emergencia.aterrizajeLat === -34.87021);
    expect(ultima.emergencia).toMatchObject({ fotos: 2, aterrizajeLon: -56.19018, aterrizajeAlt: 0.2 });

    // el operador de campo no recibe el registro: solo las novedades de la emergencia
    expect(deCampo.got.some((m) => m.type === 'event')).toBe(false);
    for (const m of a.got) expect(cumpleContrato(m), JSON.stringify(m)).toBe(true);

    // y la consulta por REST trae la ficha con las fotos en orden
    const lista = await api(srv.base, '/api/emergencias?abiertas=1', campo);
    expect(lista.status).toBe(200);
    expect(lista.body.map((e: any) => e.id)).toContain(id);
    const detalle = await api(srv.base, `/api/emergencias/${id}`, campo);
    expect(detalle.body.fotos.map((f: any) => f.seq)).toEqual([0, 1]);
    expect(detalle.body.fotos[0]).toEqual({
      seq: 0, tipo: 'cenital', rumbo: 270, inclinacion: -90, lat: -34.8702, lon: -56.1902, alt: 30, ts: 1_792_767_850_000, jpegBase64: JPEG,
    });
  });

  it('una foto de 400 000 caracteres entra sin cortar el socket del dron; una de más se descarta sin acuse', async () => {
    const a = await conn(tokenDeDron(A));
    await wait(50);
    manda(a, aviso('em-grande'));
    await a.waitFor((m) => m.type === 'emergency_ack' && m.ref === 'em-grande');

    const justa = `/9j/${'A'.repeat(400_000 - 4)}`;
    manda(a, foto('em-grande', 2, justa));
    await a.waitFor((m) => m.type === 'emergency_photo_ack' && m.ref === 'em-grande' && m.seq === 2);

    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      manda(a, foto('em-grande', 3, `${justa}A`));
      await wait(200);
      expect(a.got.some((m) => m.type === 'emergency_photo_ack' && m.seq === 3)).toBe(false);
      expect(avisos).toHaveBeenCalled();
    } finally {
      avisos.mockRestore();
    }
    expect(a.ws.readyState).toBe(a.ws.OPEN);
    // sigue andando: la siguiente se acusa
    manda(a, foto('em-grande', 4));
    await a.waitFor((m) => m.type === 'emergency_photo_ack' && m.seq === 4);
  });

  it('aterrizar de emergencia vence el pedido de patrulla que esperaba candidato', async () => {
    const a = await conn(tokenDeDron(A));
    await wait(50);
    manda(a, { type: 'relay_request', ref: 'em-patrulla', motivo: 'patrulla', routeId: 1, fromIndex: 0 });
    const st = await a.waitFor((m) => m.type === 'relay_status' && m.ref === 'em-patrulla');
    expect(st.estado).toBe('SIN_RELEVO');
    manda(a, aviso('em-2'));
    await a.waitFor((m) => m.type === 'emergency_ack' && m.ref === 'em-2');
    manda(a, { type: 'emergency_landed', ref: 'em-2', lat: null, lon: null, alt: 0, ts: 1_792_767_990_000 });
    const fin = await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'CANCELADO');
    expect(fin).toMatchObject({ relayId: st.relayId, motivoFin: 'sin_relevo' });
  });

  it('marcar recuperada: el operador de campo puede, una sola vez; 404 con ids que no son de una emergencia', async () => {
    const consola = await conn(op);
    const a = await conn(tokenDeDron(A));
    await wait(50);
    manda(a, aviso('em-rec'));
    const { emergencyId: id } = await a.waitFor((m) => m.type === 'emergency_ack' && m.ref === 'em-rec');

    const r = await api(srv.base, `/api/emergencias/${id}/recuperada`, campo, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, recuperadaPor: 'campo', fotos: 0 });
    expect(r.body.recuperadaEn).toEqual(expect.any(String));
    const ev = await consola.waitFor((m) => m.type === 'event' && m.event.type === 'EMERGENCY_RECOVERED');
    expect(ev.event).toMatchObject({ source: 'backend', drone_id: A });
    expect(JSON.parse(ev.event.meta).detalle).toEqual({ por: 'campo' });

    expect((await api(srv.base, `/api/emergencias/${id}/recuperada`, op, { method: 'POST' })).status).toBe(409);
    for (const malo of ['99999', 'abc', '0', '1.5', '-3']) {
      expect((await api(srv.base, `/api/emergencias/${malo}/recuperada`, op, { method: 'POST' })).status, malo).toBe(404);
      expect((await api(srv.base, `/api/emergencias/${malo}`, op)).status, malo).toBe(404);
    }
    const abiertas = (await api(srv.base, '/api/emergencias?abiertas=1', op)).body.map((e: any) => e.id);
    expect(abiertas).not.toContain(id);
    const todas = (await api(srv.base, '/api/emergencias', op)).body.map((e: any) => e.id);
    expect(todas).toContain(id);
    expect((await api(srv.base, '/api/emergencias', null)).status).toBe(401);
  });
});
