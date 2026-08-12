import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { seed, startServer, login, api, crearBase, CREDS, type TestServer } from '../helpers';

describe('integración — ABM de rutas y su asignación a bases', () => {
  let srv: TestServer;
  let campo = '';
  let op = '';
  let sup = '';
  let adm = '';

  const NODOS = [
    { lat: -34.856, lon: -56.207, alt: 40 },
    { lat: -34.8532, lon: -56.207, alt: 40, label: 'Portón' },
    { lat: -34.8532, lon: -56.2036, alt: 40 },
  ];

  beforeAll(async () => {
    seed();
    srv = await startServer();
    campo = (await login(srv.base, 'campo', CREDS.campo))!;
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
  });
  afterAll(async () => {
    await srv.close();
  });

  async function crearRuta(token: string, nombre: string, nodos: object[] = NODOS) {
    const r = await api(srv.base, '/api/routes', token, {
      method: 'POST',
      body: JSON.stringify({ name: nombre, description: 'de prueba', waypoints: nodos }),
    });
    if (r.status !== 201) throw new Error(`no se pudo crear la ruta: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { id: number; name: string; waypoints: unknown[] };
  }

  it('el operador de campo crea una ruta con sus nodos', async () => {
    const ruta = await crearRuta(campo, 'Perímetro Oeste');
    expect(ruta.waypoints).toHaveLength(3);
    expect(ruta.name).toBe('Perímetro Oeste');

    const ev = (await api(srv.base, '/api/logs?pageSize=100', adm)).body.items
      .find((e: { type: string }) => e.type === 'ROUTE_CREATED');
    expect(JSON.parse(ev.meta).despues).toEqual({ nombre: 'Perímetro Oeste', descripcion: 'de prueba', nodos: 3, eliminada: false });
  });

  it('el operador común no crea rutas', async () => {
    const alta = await api(srv.base, '/api/routes', op, {
      method: 'POST',
      body: JSON.stringify({ name: 'No', waypoints: NODOS }),
    });
    expect(alta.status).toBe(403);
  });

  it('una ruta necesita al menos dos nodos y coordenadas válidas', async () => {
    const malos: object[] = [
      { name: 'Sin nodos' },
      { name: 'Uno solo', waypoints: [NODOS[0]] },
      { name: '', waypoints: NODOS },
      { name: 'Coord mala', waypoints: [{ lat: 'x', lon: 1 }, NODOS[1]] },
      { name: 'Fuera de rango', waypoints: [{ lat: 91, lon: 1 }, NODOS[1]] },
      { name: 'Altura absurda', waypoints: [{ lat: 1, lon: 1, alt: 900 }, NODOS[1]] },
      { name: 'Apodo largo', waypoints: [{ lat: 1, lon: 1, label: 'x'.repeat(41) }, NODOS[1]] },
    ];
    for (const body of malos) {
      const r = await api(srv.base, '/api/routes', sup, { method: 'POST', body: JSON.stringify(body) });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('editar reemplaza los nodos enteros y registra el antes y el después', async () => {
    const ruta = await crearRuta(sup, 'Editable');
    const r = await api(srv.base, `/api/routes/${ruta.id}`, sup, {
      method: 'PATCH',
      body: JSON.stringify({ waypoints: [NODOS[0], NODOS[1]] }),
    });
    expect(r.status).toBe(200);
    expect(r.body.waypoints).toHaveLength(2);

    const ev = (await api(srv.base, '/api/logs?pageSize=100', adm)).body.items
      .find((e: { type: string }) => e.type === 'ROUTE_UPDATED');
    const meta = JSON.parse(ev.meta);
    expect(meta.antes.nodos).toBe(3);
    expect(meta.despues.nodos).toBe(2);
  });

  it('el borrado es lógico y se puede restaurar', async () => {
    const ruta = await crearRuta(sup, 'Efímera');
    expect((await api(srv.base, `/api/routes/${ruta.id}`, sup, { method: 'DELETE' })).status).toBe(200);

    const normal = (await api(srv.base, '/api/routes', sup)).body;
    expect(normal.some((x: { id: number }) => x.id === ruta.id)).toBe(false);
    const conBorradas = (await api(srv.base, '/api/routes?includeDeleted=1', sup)).body;
    expect(conBorradas.some((x: { id: number }) => x.id === ruta.id)).toBe(true);

    expect((await api(srv.base, `/api/routes/${ruta.id}`, sup, { method: 'DELETE' })).status).toBe(409);
    expect((await api(srv.base, `/api/routes/${ruta.id}/restore`, sup, { method: 'POST' })).status).toBe(200);
    expect((await api(srv.base, `/api/routes/${ruta.id}/restore`, sup, { method: 'POST' })).status).toBe(409);
  });

  it('una base tiene varias rutas y la asignación se reemplaza de una', async () => {
    const base = await crearBase(srv.base, sup, { name: 'Base Rutas', lat: -34.85, lon: -56.2 });
    const a = await crearRuta(sup, 'Ruta A');
    const b = await crearRuta(sup, 'Ruta B');
    const c = await crearRuta(sup, 'Ruta C');

    const r = await api(srv.base, `/api/bases/${base.id}/routes`, campo, {
      method: 'PUT',
      body: JSON.stringify({ routeIds: [a.id, b.id] }),
    });
    expect(r.status).toBe(200);
    expect(r.body.map((x: { name: string }) => x.name).sort()).toEqual(['Ruta A', 'Ruta B']);

    // reemplaza, no acumula
    await api(srv.base, `/api/bases/${base.id}/routes`, sup, { method: 'PUT', body: JSON.stringify({ routeIds: [c.id] }) });
    const solo = (await api(srv.base, `/api/bases/${base.id}/routes`, op)).body;
    expect(solo.map((x: { name: string }) => x.name)).toEqual(['Ruta C']);

    // y se puede dejar sin ninguna
    await api(srv.base, `/api/bases/${base.id}/routes`, sup, { method: 'PUT', body: JSON.stringify({ routeIds: [] }) });
    expect((await api(srv.base, `/api/bases/${base.id}/routes`, op)).body).toEqual([]);
  });

  it('no se asigna una ruta inexistente o eliminada', async () => {
    const base = await crearBase(srv.base, sup, { name: 'Base Estricta', lat: -34.86, lon: -56.21 });
    const muerta = await crearRuta(sup, 'Muerta');
    await api(srv.base, `/api/routes/${muerta.id}`, sup, { method: 'DELETE' });

    for (const ids of [[99999], [muerta.id], ['x']]) {
      const r = await api(srv.base, `/api/bases/${base.id}/routes`, sup, { method: 'PUT', body: JSON.stringify({ routeIds: ids }) });
      expect(r.status, JSON.stringify(ids)).toBe(400);
    }
    expect((await api(srv.base, `/api/bases/${base.id}/routes`, sup, { method: 'PUT', body: JSON.stringify({}) })).status).toBe(400);
  });

  it('el listado se puede filtrar por base', async () => {
    const base = await crearBase(srv.base, sup, { name: 'Base Filtro', lat: -34.87, lon: -56.22 });
    const propia = await crearRuta(sup, 'Sólo de esta base');
    await api(srv.base, `/api/bases/${base.id}/routes`, sup, { method: 'PUT', body: JSON.stringify({ routeIds: [propia.id] }) });

    const filtradas = (await api(srv.base, `/api/routes?baseId=${base.id}`, op)).body;
    expect(filtradas.map((x: { name: string }) => x.name)).toEqual(['Sólo de esta base']);
  });

  it('editar o restaurar una ruta inexistente da 404', async () => {
    expect((await api(srv.base, '/api/routes/99999', sup, { method: 'PATCH', body: JSON.stringify({ name: 'X' }) })).status).toBe(404);
    expect((await api(srv.base, '/api/routes/99999', sup, { method: 'DELETE' })).status).toBe(404);
    expect((await api(srv.base, '/api/routes/99999/restore', sup, { method: 'POST' })).status).toBe(404);
    expect((await api(srv.base, '/api/bases/99999/routes', sup, { method: 'PUT', body: JSON.stringify({ routeIds: [] }) })).status).toBe(404);
  });
});
