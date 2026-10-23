import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CONTRATO, cumpleContrato } from '../contrato';
import {
  CREDS, DRON, api, connectWs, crearBase, login, seed, startServer, tokenDeDron, wait, type TestServer, type WsClient,
} from '../helpers';

// Las bases que el hub le manda a cada dron (PROTOCOLS §2.b, `bases`) y el
// punto de aterrizaje para visitantes de cada base (§5): es lo que la app usa
// para decidir un desvío, así que tiene que estar siempre bien formado.

const A = DRON.alfa;

describe('integración — bases para el desvío', () => {
  let srv: TestServer;
  let sup = '';
  let campo = '';
  let adm = '';
  const sockets: WsClient[] = [];

  const conn = async (token: string) => {
    const c = await connectWs(srv.wsUrl, token);
    sockets.push(c);
    return c;
  };
  /** El último `bases` que recibió el dron, esperando a que llegue uno que cumpla el predicado. */
  const basesDe = (c: WsClient, pred: (m: any) => boolean = () => true) =>
    c.waitFor(() => {
      const ultimo = c.got.filter((m) => m.type === 'bases').at(-1);
      return ultimo && pred(ultimo);
    }).then(() => c.got.filter((m) => m.type === 'bases').at(-1));

  beforeAll(async () => {
    seed();
    srv = await startServer();
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    campo = (await login(srv.base, 'campo', CREDS.campo))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
  });

  afterEach(async () => {
    for (const s of sockets) {
      for (const m of s.got) expect(cumpleContrato(m), JSON.stringify(m)).toBe(true);
      await s.close();
    }
    sockets.length = 0;
    await wait(50);
  });

  afterAll(async () => {
    await srv.close();
  });

  /** Último evento del registro general del tipo pedido. */
  async function ultimoEvento(tipo: string) {
    const r = await api(srv.base, '/api/logs?pageSize=100', adm);
    return r.body.items.find((e: { type: string }) => e.type === tipo);
  }

  it('al conectarse, el dron recibe las bases activas y cuál es la suya', async () => {
    const a = await conn(tokenDeDron(A));
    const m = await basesDe(a);
    expect(m.propiaId).toBe(1);
    expect(m.bases).toContainEqual({ id: 1, nombre: 'Base Norte', lat: -34.8565, lon: -56.2075, aterrizajeLat: null, aterrizajeLon: null });
    expect(m.bases.map((b: any) => b.id).sort()).toEqual([1, 2, 3]);
  });

  it('alta con punto para visitantes: la API lo devuelve, la consola lo ve y los drones reciben la lista nueva', async () => {
    const consola = await conn(sup);
    const a = await conn(tokenDeDron(A));
    await basesDe(a);
    const [conPunto, sinPunto] = CONTRATO.rest['POST /api/bases'].validos;

    const r = await api(srv.base, '/api/bases', campo, { method: 'POST', body: JSON.stringify(conPunto.cuerpo) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ aterrizajeLat: -34.85632, aterrizajeLon: -56.2075 });
    const aviso = await consola.waitFor((m) => m.type === 'base_updated' && m.base.id === r.body.id);
    expect(aviso.base).toMatchObject({ aterrizajeLat: -34.85632, aterrizajeLon: -56.2075 });
    const lista = await basesDe(a, (m) => m.bases.some((b: any) => b.id === r.body.id));
    expect(lista.bases.find((b: any) => b.id === r.body.id)).toMatchObject({ aterrizajeLat: -34.85632, aterrizajeLon: -56.2075 });
    const ev = await ultimoEvento('BASE_CREATED');
    expect(JSON.parse(ev.meta).despues).toMatchObject({ aterrizajeLat: -34.85632, aterrizajeLon: -56.2075 });

    const sin = await api(srv.base, '/api/bases', campo, { method: 'POST', body: JSON.stringify(sinPunto.cuerpo) });
    expect(sin.status).toBe(201);
    expect(sin.body).toMatchObject({ aterrizajeLat: null, aterrizajeLon: null });
    // los dos en null, explícitos, es lo mismo que no mandarlos
    const nulos = await api(srv.base, '/api/bases', campo, {
      method: 'POST', body: JSON.stringify({ name: 'Base Nula', lat: -34.7, lon: -56.1, aterrizajeLat: null, aterrizajeLon: null }),
    });
    expect(nulos.body).toMatchObject({ aterrizajeLat: null, aterrizajeLon: null });
  });

  it('alta inválida: a 5 m, uno solo, a más de 50 m o una posición que no es tal dan 400', async () => {
    const [cerca, unaSola] = CONTRATO.rest['POST /api/bases'].invalidos;
    const r1 = await api(srv.base, '/api/bases', sup, { method: 'POST', body: JSON.stringify(cerca.cuerpo) });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe('El punto de aterrizaje para visitantes tiene que estar entre 10 y 50 m de la base');
    const r2 = await api(srv.base, '/api/bases', sup, { method: 'POST', body: JSON.stringify(unaSola.cuerpo) });
    expect(r2.body.error).toBe('aterrizajeLat y aterrizajeLon van juntos');
    for (const punto of [
      { aterrizajeLat: null, aterrizajeLon: -56.2075 },
      { aterrizajeLat: '-34.8563', aterrizajeLon: '-56.2075' },
      { aterrizajeLat: -34.8, aterrizajeLon: -56.2075 },
    ]) {
      const r = await api(srv.base, '/api/bases', sup, {
        method: 'POST', body: JSON.stringify({ name: 'Mala', lat: -34.8565, lon: -56.2075, ...punto }),
      });
      expect(r.status, JSON.stringify(punto)).toBe(400);
    }
  });

  it('edición: se borra con null, se mueve junto con la base y se controla con los valores finales', async () => {
    const consola = await conn(sup);
    const a = await conn(tokenDeDron(A));
    const b = await crearBase(srv.base, sup, { name: 'Base Editable', lat: -34.8565, lon: -56.2075 });
    const [borrar, mover] = CONTRATO.rest['PATCH /api/bases/:id'].validos;
    const [lejos] = CONTRATO.rest['PATCH /api/bases/:id'].invalidos;
    const patch = (cuerpo: object) => api(srv.base, `/api/bases/${b.id}`, sup, { method: 'PATCH', body: JSON.stringify(cuerpo) });

    expect((await patch(lejos.cuerpo)).status).toBe(400);
    expect((await patch({ aterrizajeLat: -34.85632 })).body.error).toBe('aterrizajeLat y aterrizajeLon van juntos');

    const con = await patch({ aterrizajeLat: -34.85632, aterrizajeLon: -56.2075 });
    expect(con.status).toBe(200);
    expect(con.body).toMatchObject({ aterrizajeLat: -34.85632, aterrizajeLon: -56.2075 });
    const ev = await ultimoEvento('BASE_UPDATED');
    expect(JSON.parse(ev.meta)).toMatchObject({
      antes: { aterrizajeLat: null, aterrizajeLon: null },
      despues: { aterrizajeLat: -34.85632, aterrizajeLon: -56.2075 },
    });
    await basesDe(a, (m) => m.bases.some((x: any) => x.id === b.id && x.aterrizajeLat === -34.85632));

    // mover la base 1 km sin mandar un punto nuevo lo dejaría lejos
    expect((await patch({ lat: -34.8475, lon: -56.2075 })).status).toBe(400);
    // renombrarla no toca el punto
    expect((await patch({ name: 'Base Renombrada' })).body).toMatchObject({ aterrizajeLat: -34.85632 });
    // moverla con el punto nuevo, sí
    const movida = await patch(mover.cuerpo);
    expect(movida.status).toBe(200);
    expect(movida.body).toMatchObject({ lat: -34.857, aterrizajeLat: -34.85682 });
    const borrada = await patch(borrar.cuerpo);
    expect(borrada.body).toMatchObject({ aterrizajeLat: null, aterrizajeLon: null });
    await consola.waitFor((m) => m.type === 'base_updated' && m.base.id === b.id && m.base.aterrizajeLat === null);
    // un punto que no es una posición
    expect((await patch({ aterrizajeLat: 0, aterrizajeLon: 0 })).status).toBe(400);
  });

  it('baja, restauración y desactivación de una base llegan a los drones; una base en 0,0 no se manda', async () => {
    const a = await conn(tokenDeDron(A));
    await basesDe(a);
    const b = await crearBase(srv.base, sup, { name: 'Base Efímera', lat: -34.6, lon: -56.0 });
    await basesDe(a, (m) => m.bases.some((x: any) => x.id === b.id));
    await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'DELETE' });
    await basesDe(a, (m) => !m.bases.some((x: any) => x.id === b.id));
    await api(srv.base, `/api/bases/${b.id}/restore`, sup, { method: 'POST' });
    await basesDe(a, (m) => m.bases.some((x: any) => x.id === b.id));
    await api(srv.base, `/api/bases/${b.id}`, sup, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    await basesDe(a, (m) => !m.bases.some((x: any) => x.id === b.id));

    const nula = await crearBase(srv.base, sup, { name: 'Null Island', lat: 0, lon: 0 });
    const ultima = await basesDe(a, (m) => m.bases.length > 0 && a.got.filter((x) => x.type === 'bases').length >= 6);
    expect(ultima.bases.some((x: any) => x.id === nula.id)).toBe(false);
  });

  it('al dron al que le cambian la base le llega su propiaId nueva; sin base, null', async () => {
    const a = await conn(tokenDeDron(A));
    await basesDe(a, (m) => m.propiaId === 1);
    await api(srv.base, `/api/drones/${A}`, sup, { method: 'PATCH', body: JSON.stringify({ baseId: 2 }) });
    await basesDe(a, (m) => m.propiaId === 2);
    await api(srv.base, `/api/drones/${A}`, sup, { method: 'PATCH', body: JSON.stringify({ baseId: null }) });
    await basesDe(a, (m) => m.propiaId === null);
    // reasignar la misma no manda nada nuevo
    const antes = a.got.filter((m) => m.type === 'bases').length;
    await api(srv.base, `/api/drones/${A}`, sup, { method: 'PATCH', body: JSON.stringify({ baseId: null, displayName: 'Alfa' }) });
    await wait(100);
    expect(a.got.filter((m) => m.type === 'bases')).toHaveLength(antes);
    await api(srv.base, `/api/drones/${A}`, sup, { method: 'PATCH', body: JSON.stringify({ baseId: 1 }) });
    await basesDe(a, (m) => m.propiaId === 1);
  });
});
