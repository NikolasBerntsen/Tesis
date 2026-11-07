import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDS, DRON, api, connectWs, login, seed, startServer, tokenDeDron, wait, type TestServer, type WsClient } from '../helpers';

// Los ajustes del dron que fija el operador y la app aplica (PROTOCOLS §2
// `ajustes`, §5 `PATCH /drones/:droneId/ajustes`): hoy, la velocidad de órbita.
// Es del dron y no del vuelo: se guarda, viaja al conectarse y cada vez que
// cambia, y la ficha la trae para que la consola muestre la vigente.

const A = DRON.alfa;

describe('integración — ajustes del dron (velocidad de órbita)', () => {
  let srv: TestServer;
  let op = '';
  let campo = '';
  let operWs: WsClient;

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    campo = (await login(srv.base, 'campo', CREDS.campo))!;
    operWs = await connectWs(srv.wsUrl, op);
  });

  afterAll(async () => {
    await operWs.close();
    await srv.close();
  });

  beforeEach(() => {
    operWs.got.length = 0;
  });

  const ajustar = (cuerpo: unknown, token = op) =>
    api(srv.base, `/api/drones/${A}/ajustes`, token, { method: 'PATCH', body: JSON.stringify(cuerpo) });

  it('al conectarse el dron recibe sus ajustes: sin nada fijado, la velocidad de fábrica (null)', async () => {
    const a = await connectWs(srv.wsUrl, tokenDeDron(A));
    try {
      const m = await a.waitFor((x) => x.type === 'ajustes');
      expect(m).toEqual({ type: 'ajustes', velocidadOrbitaMs: null, by: 'Comando Central' });
      // Después de quién tiene el control y antes de los relevos, con las bases.
      const tipos = a.got.map((x) => x.type);
      expect(tipos.indexOf('control_released')).toBeLessThan(tipos.indexOf('ajustes'));
      expect(tipos.indexOf('bases')).toBeLessThan(tipos.indexOf('ajustes'));
    } finally {
      await a.close();
    }
  });

  it('fijar la velocidad la guarda, la manda al dron en el acto, queda en la ficha y en el registro', async () => {
    const a = await connectWs(srv.wsUrl, tokenDeDron(A));
    try {
      await a.waitFor((x) => x.type === 'ajustes');
      a.got.length = 0;

      const r = await ajustar({ velocidadOrbitaMs: 2.5 });
      expect(r.status).toBe(200);
      expect(r.body.velocidadOrbitaMs).toBe(2.5);

      expect(await a.waitFor((x) => x.type === 'ajustes')).toEqual({ type: 'ajustes', velocidadOrbitaMs: 2.5, by: 'operador' });
      const ficha = await operWs.waitFor((m) => m.type === 'drone_updated' && m.drone.droneId === A);
      expect(ficha.drone.velocidadOrbitaMs).toBe(2.5);
      const ev = await operWs.waitFor((m) => m.type === 'event' && m.event.type === 'ORBIT_SPEED_SET');
      expect(ev.event.message).toContain('2.5 m/s');
      const meta = JSON.parse(ev.event.meta);
      expect(meta.antes).toEqual({ velocidadOrbitaMs: null });
      expect(meta.despues).toEqual({ velocidadOrbitaMs: 2.5 });
      expect(meta.detalle).toEqual({ por: 'operador', velocidadOrbitaMs: 2.5 });

      // La lista de drones también la trae.
      const lista = (await api(srv.base, '/api/drones', op)).body;
      expect(lista.find((d: any) => d.droneId === A).velocidadOrbitaMs).toBe(2.5);
    } finally {
      await a.close();
    }
  });

  it('la velocidad fijada le llega al dron en la próxima conexión', async () => {
    await ajustar({ velocidadOrbitaMs: 6 });
    const a = await connectWs(srv.wsUrl, tokenDeDron(A));
    try {
      expect(await a.waitFor((x) => x.type === 'ajustes')).toMatchObject({ velocidadOrbitaMs: 6 });
    } finally {
      await a.close();
    }
  });

  it('null vuelve a la de fábrica, y se redondea a un decimal', async () => {
    expect((await ajustar({ velocidadOrbitaMs: 3.456 })).body.velocidadOrbitaMs).toBe(3.5);
    const r = await ajustar({ velocidadOrbitaMs: null });
    expect(r.status).toBe(200);
    expect(r.body.velocidadOrbitaMs).toBeNull();
    const ev = await operWs.waitFor(
      (m) => m.type === 'event' && m.event.type === 'ORBIT_SPEED_SET' && m.event.message.includes('fábrica'),
    );
    expect(ev).toBeDefined();
  });

  it('rechaza lo que no es una velocidad: fuera de rango, texto, ausente; y un dron que no existe', async () => {
    expect((await ajustar({ velocidadOrbitaMs: 0.5 })).status).toBe(400);
    expect((await ajustar({ velocidadOrbitaMs: 8.1 })).status).toBe(400);
    expect((await ajustar({ velocidadOrbitaMs: '3' })).status).toBe(400);
    expect((await ajustar({ velocidadOrbitaMs: true })).status).toBe(400);
    expect((await ajustar({})).status).toBe(400);
    expect((await ajustar({ velocidadOrbitaMs: 1 })).status).toBe(200);
    expect((await ajustar({ velocidadOrbitaMs: 8 })).status).toBe(200);
    const inexistente = await api(srv.base, '/api/drones/00000000000000000000000000000000/ajustes', op, {
      method: 'PATCH', body: JSON.stringify({ velocidadOrbitaMs: 3 }),
    });
    expect(inexistente.status).toBe(404);
  });

  it('es una orden de operación: el operador de campo no la puede dar', async () => {
    expect((await ajustar({ velocidadOrbitaMs: 3 }, campo)).status).toBe(403);
    await wait(20);
  });
});
