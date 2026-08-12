import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seed, startServer, login, api, connectWs, crearBase, crearDron, limpiarBase, CREDS, DRON, type TestServer, type WsClient } from '../helpers';

// Los drones como activos: alta desde el campo, edición, borrado lógico y
// restauración, con la ficha (`DroneCard`) que consume la consola.
describe('integración — ABM de drones', () => {
  let srv: TestServer;
  let campo = '';
  let op = '';
  let sup = '';
  let adm = '';
  let operWs: WsClient;
  let oeste: { id: number };
  let sur: { id: number };

  beforeAll(async () => {
    seed();
    srv = await startServer();
    campo = (await login(srv.base, 'campo', CREDS.campo))!;
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    operWs = await connectWs(srv.wsUrl, op);
    oeste = await crearBase(srv.base, sup, { name: 'Base Oeste', lat: -34.85, lon: -56.21 });
    sur = await crearBase(srv.base, sup, { name: 'Base Sur Nueva', lat: -34.87, lon: -56.22 });
  });
  afterAll(async () => {
    await operWs.close();
    await srv.close();
  });

  beforeEach(() => {
    operWs.got.length = 0;
  });

  /** Lee el registro de drones más reciente del tipo pedido. */
  async function ultimoEvento(tipo: string) {
    const evs = (await api(srv.base, '/api/events?limit=200', op)).body;
    return evs.find((e: any) => e.type === tipo);
  }

  it('el operador de campo da de alta un dron y recibe el hash para el QR', async () => {
    const r = await api(srv.base, '/api/drones', campo, {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Delta', model: 'DJI Air 3', inventoryCode: 'INV-0042', baseId: oeste.id }),
    });
    expect(r.status).toBe(201);
    expect(r.body.hash).toMatch(/^[0-9a-f]{32}$/);
    // el hash y el droneId son el mismo valor con dos nombres
    expect(r.body.droneId).toBe(r.body.hash);
    expect(r.body.displayName).toBe('Delta');
    expect(r.body.model).toBe('DJI Air 3');
    expect(r.body.active).toBe(true);
    expect(r.body.deletedAt).toBeNull();
    expect(r.body.online).toBe(false);
    expect(r.body.controlledBy).toBeNull();
    expect(r.body.inventoryCode).toBe('INV-0042');
    expect(r.body.baseId).toBe(oeste.id);
    expect(r.body.base).toEqual({ name: 'Base Oeste', lat: -34.85, lon: -56.21 });

    // la consola se entera sin repollear
    const aviso = await operWs.waitFor((m) => m.type === 'drone_updated' && m.drone.hash === r.body.hash);
    expect(aviso.drone.displayName).toBe('Delta');

    const ev = await ultimoEvento('DRONE_CREATED');
    const meta = JSON.parse(ev.meta);
    expect(meta.drone).toEqual({ hash: r.body.hash, displayName: 'Delta', model: 'DJI Air 3' });
    expect(meta.despues).toEqual({
      displayName: 'Delta',
      model: 'DJI Air 3',
      inventario: 'INV-0042',
      operativo: true,
      eliminado: false,
      base: 'Base Oeste',
    });
    expect(ev.source).toBe('campo');
  });

  it('el alta acepta un dron mínimo: solo el nombre', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Mínimo' });
    expect(d.model).toBe('');
    expect(d.base).toBeNull();
  });

  it('alta inválida: nombre, modelo, inventario y base referenciada mal dan 400', async () => {
    const malos: object[] = [
      { displayName: '   ' },
      {},
      { displayName: 'x'.repeat(41) },
      { displayName: 'Ok', model: 'm'.repeat(41) },
      { displayName: 'Ok', inventoryCode: 'i'.repeat(31) },
      { displayName: 'Ok', baseId: 'Base Norte' },
      { displayName: 'Ok', baseId: 0 },
      { displayName: 'Ok', baseId: 1.5 },
      // una base que no existe no se puede asignar
      { displayName: 'Ok', baseId: 99999 },
    ];
    for (const body of malos) {
      const r = await api(srv.base, '/api/drones', sup, { method: 'POST', body: JSON.stringify(body) });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    // base explícitamente nula es válida: un dron puede no tener base asignada
    const sinBase = await crearDron(srv.base, sup, { displayName: 'SinBase', baseId: null });
    expect(sinBase.base).toBeNull();
    expect(sinBase.baseId).toBeNull();
  });

  it('no se puede asignar un dron a una base eliminada o desactivada', async () => {
    const muerta = await crearBase(srv.base, sup, { name: 'Base Fantasma', lat: -34.9, lon: -56.3 });
    await api(srv.base, `/api/bases/${muerta.id}`, sup, { method: 'DELETE' });
    const rBorrada = await api(srv.base, '/api/drones', sup, {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Huérfano', baseId: muerta.id }),
    });
    expect(rBorrada.status).toBe(400);
    expect(rBorrada.body.error).toMatch(/eliminada/i);

    const apagada = await crearBase(srv.base, sup, { name: 'Base Apagada', lat: -34.91, lon: -56.31 });
    await api(srv.base, `/api/bases/${apagada.id}`, sup, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    const rInactiva = await api(srv.base, '/api/drones', sup, {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Huérfano2', baseId: apagada.id }),
    });
    expect(rInactiva.status).toBe(400);
    expect(rInactiva.body.error).toMatch(/no está activa/i);
  });

  it('el operador de consola no da de alta drones (permiso lateral, no jerárquico)', async () => {
    expect((await api(srv.base, '/api/drones', op, { method: 'POST', body: JSON.stringify({ displayName: 'X' }) })).status).toBe(403);
    expect((await api(srv.base, '/api/drones', adm, { method: 'POST', body: JSON.stringify({ displayName: 'DesdeAdmin' }) })).status).toBe(201);
  });

  it('un operador solo puede renombrar; tocar el activo es de supervisor', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Editable', model: 'M1' });

    const soloNombre = await api(srv.base, `/api/drones/${d.hash}`, op, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Editable-2' }),
    });
    expect(soloNombre.status).toBe(200);
    expect(soloNombre.body.displayName).toBe('Editable-2');

    const conModelo = await api(srv.base, `/api/drones/${d.hash}`, op, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Editable-3', model: 'M2' }),
    });
    expect(conModelo.status).toBe(403);
    expect(conModelo.body.error).toMatch(/supervisor/i);

    const porSupervisor = await api(srv.base, `/api/drones/${d.hash}`, sup, {
      method: 'PATCH',
      body: JSON.stringify({ model: 'M2', active: false }),
    });
    expect(porSupervisor.status).toBe(200);
    expect(porSupervisor.body.model).toBe('M2');
    expect(porSupervisor.body.active).toBe(false);
  });

  it('PATCH registra el antes y el después campo a campo', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Comparable', model: 'M1', baseId: oeste.id });
    await api(srv.base, `/api/drones/${d.hash}`, sup, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Comparable-2', baseId: sur.id }),
    });

    const meta = JSON.parse((await ultimoEvento('DRONE_UPDATED')).meta);
    expect(meta.antes).toEqual({ displayName: 'Comparable', model: 'M1', inventario: '', operativo: true, eliminado: false, base: 'Base Oeste' });
    expect(meta.despues).toEqual({ displayName: 'Comparable-2', model: 'M1', inventario: '', operativo: true, eliminado: false, base: 'Base Sur Nueva' });
  });

  it('PATCH con baseId:null desasigna la base del dron', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'SinBaseLuego', baseId: oeste.id });
    const r = await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'PATCH', body: JSON.stringify({ baseId: null }) });
    expect(r.status).toBe(200);
    expect(r.body.base).toBeNull();
  });

  it('PATCH: sin cambios 400, validaciones 400, dron inexistente 404', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Bordes' });
    expect((await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'PATCH', body: JSON.stringify({}) })).status).toBe(400);
    expect(
      (await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'PATCH', body: JSON.stringify({ model: 'm'.repeat(41) }) }))
        .status,
    ).toBe(400);
    expect(
      (await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'PATCH', body: JSON.stringify({ base: { lat: 1 } }) })).status,
    ).toBe(400);
    expect(
      (await api(srv.base, '/api/drones/fantasma', sup, { method: 'PATCH', body: JSON.stringify({ model: 'M' }) })).status,
    ).toBe(404);
  });

  it('el borrado es lógico: sale de la lista pero la ficha sigue existiendo', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Baja', model: 'M1' });
    const baja = await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'DELETE' });
    expect(baja.status).toBe(200);
    expect(baja.body.deletedAt).toBeTruthy();

    const lista = (await api(srv.base, '/api/drones', sup)).body;
    expect(lista.some((x: any) => x.hash === d.hash)).toBe(false);
    const conBorrados = (await api(srv.base, '/api/drones?includeDeleted=1', sup)).body;
    expect(conBorrados.find((x: any) => x.hash === d.hash).deletedAt).toBeTruthy();

    const meta = JSON.parse((await ultimoEvento('DRONE_DELETED')).meta);
    expect(meta.antes.eliminado).toBe(false);
    expect(meta.despues.eliminado).toBe(true);
  });

  it('un dron eliminado no se modifica hasta restaurarlo (409) y no se borra dos veces (409)', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Congelado' });
    await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'DELETE' });
    const patch = await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'PATCH', body: JSON.stringify({ model: 'M' }) });
    expect(patch.status).toBe(409);
    expect(patch.body.error).toMatch(/eliminado/i);
    expect((await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'DELETE' })).status).toBe(409);
  });

  it('restaurar devuelve el dron a la lista y lo registra', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Resucita' });
    await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'DELETE' });
    const r = await api(srv.base, `/api/drones/${d.hash}/restore`, sup, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.deletedAt).toBeNull();
    expect((await api(srv.base, '/api/drones', sup)).body.some((x: any) => x.hash === d.hash)).toBe(true);

    const meta = JSON.parse((await ultimoEvento('DRONE_RESTORED')).meta);
    expect(meta.antes.eliminado).toBe(true);
    expect(meta.despues.eliminado).toBe(false);

    // restaurar uno que no estaba eliminado da 409, e inexistente 404
    expect((await api(srv.base, `/api/drones/${d.hash}/restore`, sup, { method: 'POST' })).status).toBe(409);
    expect((await api(srv.base, '/api/drones/fantasma/restore', sup, { method: 'POST' })).status).toBe(404);
    expect((await api(srv.base, '/api/drones/fantasma', sup, { method: 'DELETE' })).status).toBe(404);
  });

  it('dar de baja y restaurar es cosa de supervisor+', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Protegido' });
    expect((await api(srv.base, `/api/drones/${d.hash}`, op, { method: 'DELETE' })).status).toBe(403);
    expect((await api(srv.base, `/api/drones/${d.hash}/restore`, op, { method: 'POST' })).status).toBe(403);
    expect((await api(srv.base, `/api/drones/${d.hash}`, campo, { method: 'DELETE' })).status).toBe(403);
  });

  it('includeDeleted solo lo respeta supervisor+: al operador y al de campo se lo ignora', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Oculto' });
    await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'DELETE' });

    for (const token of [op, campo]) {
      const lista = (await api(srv.base, '/api/drones?includeDeleted=1', token)).body;
      expect(lista.some((x: any) => x.hash === d.hash)).toBe(false);
    }
    expect((await api(srv.base, '/api/drones?includeDeleted=1', adm)).body.some((x: any) => x.hash === d.hash)).toBe(true);
  });

  it('la ficha de un dron eliminado se sigue emitiendo por WS al restaurarlo', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Avisos' });
    operWs.got.length = 0;
    await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'DELETE' });
    const baja = await operWs.waitFor((m) => m.type === 'drone_updated' && m.drone.hash === d.hash && m.drone.deletedAt);
    expect(baja.drone.displayName).toBe('Avisos');

    await api(srv.base, `/api/drones/${d.hash}/restore`, sup, { method: 'POST' });
    await operWs.waitFor((m) => m.type === 'drone_updated' && m.drone.hash === d.hash && m.drone.deletedAt === null);
  });
});

// El listado que consume la consola: ficha completa de los drones sembrados.
describe('integración — listado de drones', () => {
  let srv: TestServer;
  let op = '';

  beforeAll(async () => {
    limpiarBase();
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
  });
  afterAll(async () => {
    await srv.close();
  });

  it('GET /drones devuelve la ficha completa ordenada por nombre', async () => {
    const r = await api(srv.base, '/api/drones', op);
    expect(r.status).toBe(200);
    expect(r.body.map((d: any) => d.displayName)).toEqual(['Alfa', 'Bravo', 'Charlie']);
    const alfa = r.body[0];
    expect(alfa).toEqual({
      hash: DRON.alfa,
      droneId: DRON.alfa,
      displayName: 'Alfa',
      model: 'DJI Mini 3',
      inventoryCode: '',
      active: true,
      deletedAt: null,
      baseId: expect.any(Number),
      base: { name: 'Base Norte', lat: -34.8565, lon: -56.2075 },
      online: false,
      lastStatus: null,
      controlledBy: null,
    });
  });
});
