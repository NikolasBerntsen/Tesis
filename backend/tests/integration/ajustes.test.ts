import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDS, DRON, api, connectWs, login, seed, startServer, tokenDeDron, wait, type TestServer, type WsClient } from '../helpers';

// Los ajustes del dron que fija el operador y la app aplica (PROTOCOLS §2
// `ajustes`, §5 `PATCH /drones/:droneId/ajustes`, §6; VUELO §10): la velocidad
// de órbita, la reacción a una detección y el silencio al retomar. Son del dron
// y no del vuelo: se guardan, viajan ENTEROS al conectarse y cada vez que
// alguno cambia, y la ficha los trae para que la consola muestre los vigentes.
// Los cuerpos válidos e inválidos son los de docs/contrato/ajustes.json.

const A = DRON.alfa;
const DE_FABRICA = { velocidadOrbitaMs: null, reaccionADeteccion: null, silencioAlRetomarS: null };
const DRON_ALFA = { hash: A, displayName: 'Alfa', model: 'DJI Mini 3' };

interface Ejemplo {
  caso: string;
  porque?: string;
  cuerpo: Record<string, unknown>;
}

const CONTRATO = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../docs/contrato/ajustes.json'), 'utf8'),
) as { ejemplos: { validos: Ejemplo[]; invalidos: Ejemplo[] } };

describe('integración — ajustes del dron', () => {
  let srv: TestServer;
  let op = '';
  let campo = '';
  let operWs: WsClient;

  const ajustar = (cuerpo: unknown, token = op) =>
    api(srv.base, `/api/drones/${A}/ajustes`, token, { method: 'PATCH', body: JSON.stringify(cuerpo) });
  const ficha = async () => (await api(srv.base, '/api/drones', op)).body.find((d: any) => d.droneId === A);
  const eventos = (tipo: string) => operWs.got.filter((m) => m.type === 'event' && m.event.type === tipo);
  const evento = (tipo: string) => operWs.waitFor((m) => m.type === 'event' && m.event.type === tipo);

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

  // Cada prueba arranca con los tres de fábrica y los buffers vacíos.
  beforeEach(async () => {
    expect((await ajustar(DE_FABRICA)).status).toBe(200);
    await wait(40);
    operWs.got.length = 0;
  });

  it('al conectarse el dron recibe sus ajustes enteros: sin nada fijado, los tres de fábrica (null)', async () => {
    const a = await connectWs(srv.wsUrl, tokenDeDron(A));
    try {
      const m = await a.waitFor((x) => x.type === 'ajustes');
      expect(m).toEqual({ type: 'ajustes', ...DE_FABRICA, by: 'Comando Central' });
      // Después de quién tiene el control y antes de los relevos, con las bases.
      const tipos = a.got.map((x) => x.type);
      expect(tipos.indexOf('control_released')).toBeLessThan(tipos.indexOf('ajustes'));
      expect(tipos.indexOf('bases')).toBeLessThan(tipos.indexOf('ajustes'));
    } finally {
      await a.close();
    }
  });

  it('fijar la velocidad la guarda, la manda al dron en el acto con los otros dos, queda en la ficha y en el registro', async () => {
    const a = await connectWs(srv.wsUrl, tokenDeDron(A));
    try {
      await a.waitFor((x) => x.type === 'ajustes');
      a.got.length = 0;

      const r = await ajustar({ velocidadOrbitaMs: 2.5 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ velocidadOrbitaMs: 2.5, reaccionADeteccion: null, silencioAlRetomarS: null });

      expect(await a.waitFor((x) => x.type === 'ajustes')).toEqual({
        type: 'ajustes', velocidadOrbitaMs: 2.5, reaccionADeteccion: null, silencioAlRetomarS: null, by: 'operador',
      });
      const actualizado = await operWs.waitFor((m) => m.type === 'drone_updated' && m.drone.droneId === A);
      expect(actualizado.drone.velocidadOrbitaMs).toBe(2.5);
      const ev = await evento('ORBIT_SPEED_SET');
      expect(ev.event.message).toBe('operador fijó la velocidad de órbita de "Alfa" en 2.5 m/s');
      expect(JSON.parse(ev.event.meta)).toEqual({
        drone: DRON_ALFA,
        antes: { velocidadOrbitaMs: null },
        despues: { velocidadOrbitaMs: 2.5 },
        detalle: { por: 'operador', velocidadOrbitaMs: 2.5 },
      });

      // La lista de drones también la trae.
      expect((await ficha()).velocidadOrbitaMs).toBe(2.5);
    } finally {
      await a.close();
    }
  });

  it('los tres a la vez: un mensaje con los tres, la ficha con los tres y un evento por cada uno, con su forma', async () => {
    const a = await connectWs(srv.wsUrl, tokenDeDron(A));
    try {
      await a.waitFor((x) => x.type === 'ajustes');
      a.got.length = 0;

      const r = await ajustar({ velocidadOrbitaMs: 4, reaccionADeteccion: 'seguir', silencioAlRetomarS: 30 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ velocidadOrbitaMs: 4, reaccionADeteccion: 'seguir', silencioAlRetomarS: 30 });
      expect(await a.waitFor((x) => x.type === 'ajustes')).toEqual({
        type: 'ajustes', velocidadOrbitaMs: 4, reaccionADeteccion: 'seguir', silencioAlRetomarS: 30, by: 'operador',
      });
      await wait(60);
      expect(a.got.filter((x) => x.type === 'ajustes')).toHaveLength(1);

      const reaccion = await evento('DETECTION_REACTION_SET');
      expect(reaccion.event.message).toBe('operador fijó la reacción a una detección de "Alfa" en «Seguimiento»');
      expect(reaccion.event).toMatchObject({ drone_id: A, source: 'operador', category: 'drone' });
      expect(JSON.parse(reaccion.event.meta)).toEqual({
        drone: DRON_ALFA,
        antes: { reaccionADeteccion: null },
        despues: { reaccionADeteccion: 'seguir' },
        detalle: { por: 'operador', reaccionADeteccion: 'seguir' },
      });
      const silencio = await evento('RESUME_SILENCE_SET');
      expect(silencio.event.message).toBe('operador fijó el silencio al retomar de "Alfa" en 30 s');
      expect(JSON.parse(silencio.event.meta)).toEqual({
        drone: DRON_ALFA,
        antes: { silencioAlRetomarS: null },
        despues: { silencioAlRetomarS: 30 },
        detalle: { por: 'operador', silencioAlRetomarS: 30 },
      });
      await evento('ORBIT_SPEED_SET');
      // una ficha nueva, con los tres
      const actualizados = operWs.got.filter((m) => m.type === 'drone_updated' && m.drone.droneId === A);
      expect(actualizados).toHaveLength(1);
      expect(actualizados[0].drone).toMatchObject({ velocidadOrbitaMs: 4, reaccionADeteccion: 'seguir', silencioAlRetomarS: 30 });
      expect(await ficha()).toMatchObject({ velocidadOrbitaMs: 4, reaccionADeteccion: 'seguir', silencioAlRetomarS: 30 });
    } finally {
      await a.close();
    }
  });

  it('un ajuste solo: deja un único evento, no toca los otros dos, y fijar lo que ya estaba no deja ninguno', async () => {
    expect((await ajustar({ reaccionADeteccion: 'detenerse' })).status).toBe(200);
    await evento('DETECTION_REACTION_SET');
    await wait(40);
    operWs.got.length = 0;

    const a = await connectWs(srv.wsUrl, tokenDeDron(A));
    try {
      await a.waitFor((x) => x.type === 'ajustes');
      a.got.length = 0;
      expect((await ajustar({ silencioAlRetomarS: 10 })).status).toBe(200);
      expect(await a.waitFor((x) => x.type === 'ajustes')).toEqual({
        type: 'ajustes', velocidadOrbitaMs: null, reaccionADeteccion: 'detenerse', silencioAlRetomarS: 10, by: 'operador',
      });
      await evento('RESUME_SILENCE_SET');
      await wait(60);
      expect(eventos('RESUME_SILENCE_SET')).toHaveLength(1);
      expect(eventos('DETECTION_REACTION_SET')).toHaveLength(0);
      expect(eventos('ORBIT_SPEED_SET')).toHaveLength(0);

      // lo mismo otra vez: la app recibe sus ajustes igual, el registro no se entera
      a.got.length = 0;
      operWs.got.length = 0;
      expect((await ajustar({ silencioAlRetomarS: 10, reaccionADeteccion: 'detenerse' })).status).toBe(200);
      await a.waitFor((x) => x.type === 'ajustes');
      await wait(80);
      expect(operWs.got.filter((m) => m.type === 'event')).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it('null vuelve al de fábrica (la velocidad además se redondea a un decimal)', async () => {
    expect((await ajustar({ velocidadOrbitaMs: 3.456, reaccionADeteccion: 'orbitar', silencioAlRetomarS: 5 })).body).toMatchObject({
      velocidadOrbitaMs: 3.5, reaccionADeteccion: 'orbitar', silencioAlRetomarS: 5,
    });
    await wait(40);
    operWs.got.length = 0;

    const r = await ajustar({ velocidadOrbitaMs: null, reaccionADeteccion: null, silencioAlRetomarS: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject(DE_FABRICA);
    expect((await evento('ORBIT_SPEED_SET')).event.message).toContain('en la de fábrica');
    const reaccion = await evento('DETECTION_REACTION_SET');
    expect(reaccion.event.message).toContain('en la de fábrica');
    expect(JSON.parse(reaccion.event.meta)).toMatchObject({ antes: { reaccionADeteccion: 'orbitar' }, despues: { reaccionADeteccion: null } });
    const silencio = await evento('RESUME_SILENCE_SET');
    expect(silencio.event.message).toContain('en el de fábrica');
    expect(JSON.parse(silencio.event.meta).detalle).toEqual({ por: 'operador', silencioAlRetomarS: null });
    expect(await ficha()).toMatchObject(DE_FABRICA);
  });

  it('los ajustes fijados le llegan al dron en la próxima conexión', async () => {
    await ajustar({ velocidadOrbitaMs: 6, reaccionADeteccion: 'seguir_y_orbitar', silencioAlRetomarS: 0 });
    const a = await connectWs(srv.wsUrl, tokenDeDron(A));
    try {
      expect(await a.waitFor((x) => x.type === 'ajustes')).toEqual({
        type: 'ajustes', velocidadOrbitaMs: 6, reaccionADeteccion: 'seguir_y_orbitar', silencioAlRetomarS: 0, by: 'Comando Central',
      });
    } finally {
      await a.close();
    }
  });

  it.each(CONTRATO.ejemplos.validos)('acepta el cuerpo del contrato: $caso', async ({ cuerpo }) => {
    const r = await ajustar(cuerpo);
    expect(r.status).toBe(200);
    // lo que vino queda en la ficha tal cual (la velocidad, redondeada a un decimal)
    for (const [clave, valor] of Object.entries(cuerpo)) {
      const esperado = clave === 'velocidadOrbitaMs' && typeof valor === 'number' ? Math.round(valor * 10) / 10 : valor;
      expect(r.body[clave], clave).toBe(esperado);
    }
  });

  it.each(CONTRATO.ejemplos.invalidos)('rechaza el cuerpo del contrato: $caso ($porque)', async ({ cuerpo }) => {
    const r = await ajustar(cuerpo);
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
  });

  it('un cuerpo con un valor malo no se aplica a medias: ni la ficha ni el dron cambian', async () => {
    const a = await connectWs(srv.wsUrl, tokenDeDron(A));
    try {
      await a.waitFor((x) => x.type === 'ajustes');
      // la conexión del dron también le llega a la consola (drone_online, DRONE_CONNECTED): no es lo que se mira acá
      await wait(40);
      a.got.length = 0;
      operWs.got.length = 0;
      const r = await ajustar({ velocidadOrbitaMs: 3, silencioAlRetomarS: 7 });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('silencioAlRetomarS tiene que ser un entero entre 0 y 30, de a 5, o null');
      await wait(80);
      expect(a.got).toEqual([]);
      expect(operWs.got.filter((m) => m.type === 'drone_updated' || m.type === 'event')).toEqual([]);
      expect(await ficha()).toMatchObject(DE_FABRICA);
    } finally {
      await a.close();
    }
  });

  it('una clave que no es un ajuste se ignora si viene con una conocida; sola, no hay nada para ajustar', async () => {
    const r = await ajustar({ silencioAlRetomarS: 25, velocidad: 9 });
    expect(r.status).toBe(200);
    expect(r.body.silencioAlRetomarS).toBe(25);
    expect((await ajustar({ velocidad: 9 })).status).toBe(400);
    expect((await ajustar({})).status).toBe(400);
  });

  it('un dron que no existe da 404, con un cuerpo válido o no', async () => {
    for (const cuerpo of [{ velocidadOrbitaMs: 3 }, { reaccionADeteccion: 'detenerse' }]) {
      const r = await api(srv.base, '/api/drones/00000000000000000000000000000000/ajustes', op, {
        method: 'PATCH', body: JSON.stringify(cuerpo),
      });
      expect(r.status).toBe(404);
    }
  });

  it('es una orden de operación: el operador de campo no la puede dar', async () => {
    expect((await ajustar({ velocidadOrbitaMs: 3 }, campo)).status).toBe(403);
    expect((await ajustar({ reaccionADeteccion: 'detenerse' }, campo)).status).toBe(403);
    await wait(20);
  });
});
