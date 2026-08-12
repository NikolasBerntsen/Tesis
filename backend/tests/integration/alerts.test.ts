import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { seed, startServer, login, api, connectWs, tokenDeDron, CREDS, DRON, type TestServer, type WsClient } from '../helpers';
import { createAlert } from '../../src/store';

// Ciclo de vida de alertas y la decisión del operador (VALIDATED/DISMISSED),
// con el ruteo de la decisión al dron de origen.
describe('integración — alertas', () => {
  let srv: TestServer;
  let op = '';
  let alfa: WsClient;

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    alfa = await connectWs(srv.wsUrl, tokenDeDron(DRON.alfa));
  });
  afterAll(async () => {
    await alfa.close();
    await srv.close();
  });

  it('GET /alerts lista y filtra por estado', async () => {
    const a1 = createAlert('PERSON', DRON.alfa, -34.8, -56.2, null);
    const a2 = createAlert('VEHICLE', DRON.alfa, -34.8, -56.2, null);
    // decide una para que quede en otro estado
    await api(srv.base, `/api/alerts/${a2.id}/decision`, op, { method: 'POST', body: JSON.stringify({ decision: 'VALIDATED' }) });

    const todas = await api(srv.base, '/api/alerts', op);
    expect(todas.status).toBe(200);
    expect(todas.body.length).toBeGreaterThanOrEqual(2);

    const pendientes = await api(srv.base, '/api/alerts?status=PENDING', op);
    expect(pendientes.body.some((a: any) => a.id === a1.id)).toBe(true);
    expect(pendientes.body.every((a: any) => a.status === 'PENDING')).toBe(true);
  });

  it('GET /alerts/:id trae la alerta completa con el snapshot; inexistente da 404', async () => {
    const a = createAlert('PERSON', DRON.alfa, -34.81, -56.21, 'JPEG-BASE64');
    const r = await api(srv.base, `/api/alerts/${a.id}`, op);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(a.id);
    expect(r.body.snapshot).toBe('JPEG-BASE64');
    expect(r.body.drone_id).toBe(DRON.alfa);
    expect((await api(srv.base, '/api/alerts/99999', op)).status).toBe(404);
  });

  it('VALIDATED confirma la alerta y avisa al dron de origen', async () => {
    const a = createAlert('PERSON', DRON.alfa, -34.8, -56.2, 'JPG');
    alfa.got.length = 0;
    const r = await api(srv.base, `/api/alerts/${a.id}/decision`, op, {
      method: 'POST',
      body: JSON.stringify({ decision: 'VALIDATED' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('VALIDATED');
    expect(r.body.decided_by).toBe('operador');
    await alfa.waitFor((m) => m.type === 'alert_decision' && m.alertId === a.id && m.decision === 'VALIDATED');
  });

  it('la decisión queda registrada con antes/después y la ficha del dron', async () => {
    const a = createAlert('VEHICLE', DRON.alfa, -34.8, -56.2, null);
    await api(srv.base, `/api/alerts/${a.id}/decision`, op, { method: 'POST', body: JSON.stringify({ decision: 'DISMISSED' }) });

    const evs = (await api(srv.base, '/api/events?limit=100', op)).body;
    const ev = evs.find((e: any) => e.type === 'ALERT_DISMISSED' && e.alert_id === a.id);
    expect(ev).toBeDefined();
    const meta = JSON.parse(ev.meta);
    expect(meta.alerta).toEqual({ id: a.id, tipo: 'VEHICLE' });
    expect(meta.decision).toBe('DISMISSED');
    expect(meta.por).toBe('operador');
    expect(meta.antes).toEqual({ estado: 'PENDING' });
    expect(meta.despues.estado).toBe('DISMISSED');
    expect(meta.despues.decidedBy).toBe('operador');
    expect(meta.drone).toEqual({ hash: DRON.alfa, displayName: 'Alfa', model: 'DJI Mini 3' });
  });

  it('decidir dos veces la misma alerta da 409', async () => {
    const a = createAlert('PERSON', DRON.alfa, -34.8, -56.2, null);
    await api(srv.base, `/api/alerts/${a.id}/decision`, op, { method: 'POST', body: JSON.stringify({ decision: 'DISMISSED' }) });
    const segunda = await api(srv.base, `/api/alerts/${a.id}/decision`, op, {
      method: 'POST',
      body: JSON.stringify({ decision: 'VALIDATED' }),
    });
    expect(segunda.status).toBe(409);
  });

  it('decisión inválida da 400 y alerta inexistente da 404', async () => {
    const a = createAlert('PERSON', DRON.alfa, -34.8, -56.2, null);
    expect(
      (await api(srv.base, `/api/alerts/${a.id}/decision`, op, { method: 'POST', body: JSON.stringify({ decision: 'MAYBE' }) }))
        .status,
    ).toBe(400);
    expect(
      (await api(srv.base, '/api/alerts/99999/decision', op, { method: 'POST', body: JSON.stringify({ decision: 'VALIDATED' }) }))
        .status,
    ).toBe(404);
  });

  it('una alerta sin dron asociado se decide igual (sin ruteo al dron)', async () => {
    const a = createAlert('PERSON', null, null, null, null);
    const r = await api(srv.base, `/api/alerts/${a.id}/decision`, op, {
      method: 'POST',
      body: JSON.stringify({ decision: 'DISMISSED' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.drone_id).toBeNull();
  });
});
