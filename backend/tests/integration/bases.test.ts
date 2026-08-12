import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  seed, startServer, login, api, connectWs, crearBase, crearDron, CREDS,
  type TestServer, type WsClient,
} from '../helpers';

describe('integración — bases como activo propio', () => {
  let srv: TestServer;
  let campo = '';
  let op = '';
  let sup = '';
  let adm = '';
  let operWs: WsClient;

  beforeAll(async () => {
    seed();
    srv = await startServer();
    campo = (await login(srv.base, 'campo', CREDS.campo))!;
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    operWs = await connectWs(srv.wsUrl, op);
  });
  afterAll(async () => {
    await operWs.close();
    await srv.close();
  });
  beforeEach(() => {
    operWs.got.length = 0;
  });

  /** Último evento del registro general del tipo pedido. */
  async function ultimoEvento(tipo: string) {
    const r = await api(srv.base, '/api/logs?pageSize=100', adm);
    return r.body.items.find((e: { type: string }) => e.type === tipo);
  }

  it('el operador de campo da de alta una base y la consola se entera sin repollear', async () => {
    const r = await api(srv.base, '/api/bases', campo, {
      method: 'POST',
      body: JSON.stringify({ name: 'Base Río', lat: -34.9, lon: -56.15 }),
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Base Río', lat: -34.9, lon: -56.15, active: true, deletedAt: null });
    expect(r.body.createdBy).toBe('campo');

    const aviso = await operWs.waitFor((m) => m.type === 'base_updated' && m.base.id === r.body.id);
    expect(aviso.base.name).toBe('Base Río');

    const ev = await ultimoEvento('BASE_CREATED');
    const meta = JSON.parse(ev.meta);
    expect(meta.despues).toEqual({ nombre: 'Base Río', lat: -34.9, lon: -56.15, activa: true, eliminada: false });
    // la coordenada se guarda como ubicación para que el pop-up dibuje el mapa
    expect(meta.ubicacion).toEqual({ lat: -34.9, lon: -56.15, accuracyM: null });
    expect(ev.source).toBe('campo');
  });

  it('el operador común ve las bases pero no las da de alta', async () => {
    const lista = await api(srv.base, '/api/bases', op);
    expect(lista.status).toBe(200);
    expect(Array.isArray(lista.body)).toBe(true);

    const alta = await api(srv.base, '/api/bases', op, {
      method: 'POST',
      body: JSON.stringify({ name: 'No Debería', lat: 1, lon: 2 }),
    });
    expect(alta.status).toBe(403);
  });

  it('alta inválida: nombre y coordenadas fuera de rango dan 400', async () => {
    const malos: object[] = [
      {},
      { name: '   ', lat: 1, lon: 2 },
      { name: 'x'.repeat(61), lat: 1, lon: 2 },
      { name: 'Ok' },
      { name: 'Ok', lat: 1 },
      { name: 'Ok', lat: '1', lon: '2' },
      { name: 'Ok', lat: 91, lon: 2 },
      { name: 'Ok', lat: 1, lon: 181 },
    ];
    for (const body of malos) {
      const r = await api(srv.base, '/api/bases', sup, { method: 'POST', body: JSON.stringify(body) });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('solo el supervisor edita, elimina y restaura; el borrado es lógico', async () => {
    const b = await crearBase(srv.base, sup, { name: 'Base Temporal', lat: -34.8, lon: -56.1 });

    // el operador de campo puede crear, pero no editar el activo
    const ajeno = await api(srv.base, `/api/bases/${b.id}`, campo, { method: 'PATCH', body: JSON.stringify({ name: 'Otra' }) });
    expect(ajeno.status).toBe(403);

    const editada = await api(srv.base, `/api/bases/${b.id}`, sup, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Base Renombrada', lat: -34.81, lon: -56.11 }),
    });
    expect(editada.status).toBe(200);
    expect(editada.body).toMatchObject({ name: 'Base Renombrada', lat: -34.81, lon: -56.11 });

    const evEdit = await ultimoEvento('BASE_UPDATED');
    const metaEdit = JSON.parse(evEdit.meta);
    expect(metaEdit.antes.nombre).toBe('Base Temporal');
    expect(metaEdit.despues.nombre).toBe('Base Renombrada');

    const borrada = await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'DELETE' });
    expect(borrada.status).toBe(200);
    expect(borrada.body.deletedAt).toBeTruthy();

    // desaparece del listado normal pero sigue estando para el supervisor
    const normal = await api(srv.base, '/api/bases', sup);
    expect(normal.body.some((x: { id: number }) => x.id === b.id)).toBe(false);
    const conBorradas = await api(srv.base, '/api/bases?includeDeleted=1', sup);
    expect(conBorradas.body.some((x: { id: number }) => x.id === b.id)).toBe(true);

    // borrar dos veces no es idempotente en silencio: avisa
    expect((await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'DELETE' })).status).toBe(409);

    const restaurada = await api(srv.base, `/api/bases/${b.id}/restore`, sup, { method: 'POST' });
    expect(restaurada.status).toBe(200);
    expect(restaurada.body.deletedAt).toBeNull();
    expect((await api(srv.base, `/api/bases/${b.id}/restore`, sup, { method: 'POST' })).status).toBe(409);
    expect(await ultimoEvento('BASE_RESTORED')).toBeTruthy();
  });

  it('el flag includeDeleted lo ignora quien no es supervisor', async () => {
    const b = await crearBase(srv.base, sup, { name: 'Base Oculta', lat: -34.7, lon: -56.05 });
    await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'DELETE' });

    for (const token of [campo, op]) {
      const r = await api(srv.base, '/api/bases?includeDeleted=1', token);
      expect(r.body.some((x: { id: number }) => x.id === b.id)).toBe(false);
    }
  });

  it('no se elimina una base que todavía tiene drones asignados', async () => {
    const b = await crearBase(srv.base, sup, { name: 'Base Con Drones', lat: -34.75, lon: -56.08 });
    const dron = await crearDron(srv.base, sup, { displayName: 'Asignado', baseId: b.id });

    const r = await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'DELETE' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/1 dron asignado/);

    // reasignando el dron, la base se libera
    await api(srv.base, `/api/drones/${dron.hash}`, sup, { method: 'PATCH', body: JSON.stringify({ baseId: null }) });
    expect((await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'DELETE' })).status).toBe(200);
  });

  it('la base del dron es una referencia viva: renombrarla se refleja en su ficha', async () => {
    const b = await crearBase(srv.base, sup, { name: 'Base Vieja', lat: -34.6, lon: -56.0 });
    const dron = await crearDron(srv.base, sup, { displayName: 'Referenciado', baseId: b.id });
    expect(dron.base).toEqual({ name: 'Base Vieja', lat: -34.6, lon: -56.0 });

    await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'PATCH', body: JSON.stringify({ name: 'Base Nueva' }) });
    const ficha = await api(srv.base, '/api/drones', sup);
    const actualizado = ficha.body.find((d: { hash: string }) => d.hash === dron.hash);
    expect(actualizado.base.name).toBe('Base Nueva');
  });

  it('soloActivas deja afuera las desactivadas', async () => {
    const viva = await crearBase(srv.base, sup, { name: 'Base Encendida', lat: -34.5, lon: -55.9 });
    const apagada = await crearBase(srv.base, sup, { name: 'Base Apagada 2', lat: -34.51, lon: -55.91 });
    await api(srv.base, `/api/bases/${apagada.id}`, sup, { method: 'PATCH', body: JSON.stringify({ active: false }) });

    const r = await api(srv.base, '/api/bases?soloActivas=1', campo);
    const ids = r.body.map((x: { id: number }) => x.id);
    expect(ids).toContain(viva.id);
    expect(ids).not.toContain(apagada.id);
  });

  it('editar o restaurar una base inexistente da 404, y editar una eliminada da 409', async () => {
    expect((await api(srv.base, '/api/bases/99999', sup, { method: 'PATCH', body: JSON.stringify({ name: 'X' }) })).status).toBe(404);
    expect((await api(srv.base, '/api/bases/99999', sup, { method: 'DELETE' })).status).toBe(404);
    expect((await api(srv.base, '/api/bases/99999/restore', sup, { method: 'POST' })).status).toBe(404);

    const b = await crearBase(srv.base, sup, { name: 'Base Muerta', lat: -34.4, lon: -55.8 });
    await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'DELETE' });
    const r = await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'PATCH', body: JSON.stringify({ name: 'X' }) });
    expect(r.status).toBe(409);

    // patch vacío no es un no-op silencioso
    const viva = await crearBase(srv.base, sup, { name: 'Base Viva', lat: -34.3, lon: -55.7 });
    expect((await api(srv.base, `/api/bases/${viva.id}`, sup, { method: 'PATCH', body: '{}' })).status).toBe(400);
  });
});
