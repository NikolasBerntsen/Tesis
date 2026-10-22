import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { db } from '../../src/db';
import {
  crearUsuario, seed, startServer, login, api, connectWs, limpiarBase, wsCloseCode, CREDS, DRON, type TestServer, type WsClient,
} from '../helpers';
import { SESION_DE_OTRO_ROL, ttlEnSegundos } from '../../src/auth';
import { config } from '../../src/config';

// ABM de usuarios: alta/baja lógica por admin, alcance del supervisor (solo
// canControl de operadores), auto-protección y el registro con antes/después.
describe('integración — ABM de usuarios', () => {
  let srv: TestServer;
  let adm = '';
  let sup = '';

  beforeAll(async () => {
    seed();
    srv = await startServer();
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
  });
  afterAll(async () => {
    await srv.close();
  });

  // cada test parte de la semilla limpia (los tokens por username siguen válidos)
  beforeEach(() => {
    limpiarBase();
    seed();
  });

  it('admin crea un operador (201) con canControl explícito', async () => {
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'nuevo1', fullName: 'Persona nuevo1', dni: '30.123.456', role: 'operator', canControl: false }),
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      username: 'nuevo1', fullName: 'Persona nuevo1', role: 'operator', active: true, canControl: false, deletedAt: null,
    });
    // la contraseña la genera el sistema y viaja UNA sola vez, en esta respuesta
    expect(r.body.password).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(await login(srv.base, 'nuevo1', r.body.password)).toBeTruthy();

    // y no se puede volver a leer: el listado nunca la trae
    const lista = await api(srv.base, '/api/users', adm);
    const ficha = lista.body.find((u: { username: string }) => u.username === 'nuevo1');
    expect(ficha.password).toBeUndefined();
  });

  it('canControl por defecto es true si no se envía', async () => {
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'nuevo2', fullName: 'Persona nuevo2', dni: '30123457', role: 'supervisor' }),
    });
    expect(r.status).toBe(201);
    expect(r.body.canControl).toBe(true);
    expect(r.body.role).toBe('supervisor');
  });

  it('al operador de campo se le fuerza canControl:false aunque lo pidan true', async () => {
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'campo2', fullName: 'Persona campo2', dni: '30123458', role: 'field_operator', canControl: true }),
    });
    expect(r.status).toBe(201);
    expect(r.body.role).toBe('field_operator');
    expect(r.body.canControl).toBe(false);
  });

  // El alta fuerza el invariante; el PATCH tenía que hacer lo mismo o el flag
  // terminaba mintiendo en /api/me y en la lista de usuarios.
  it('a un operador de campo no se le puede encender canControl por PATCH', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'campo3', fullName: 'Persona campo3', dni: '30123459', role: 'field_operator' }),
    });
    const r = await api(srv.base, '/api/users/campo3', adm, { method: 'PATCH', body: JSON.stringify({ canControl: true }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no controla drones/i);
    expect((await api(srv.base, '/api/users?includeDeleted=1', adm)).body.find((u: any) => u.username === 'campo3').canControl).toBe(
      false,
    );
    // apagarlo (que ya está apagado) no es un error
    expect(
      (await api(srv.base, '/api/users/campo3', adm, { method: 'PATCH', body: JSON.stringify({ canControl: false }) })).status,
    ).toBe(200);
  });

  it('alta inválida: username corto/ilegal 400, nombre faltante 400, rol inválido 400, duplicado 409', async () => {
    expect(
      (await api(srv.base, '/api/users', adm, { method: 'POST', body: JSON.stringify({ username: 'ab', fullName: 'Persona ab' }) }))
        .status,
    ).toBe(400);
    expect(
      (
        await api(srv.base, '/api/users', adm, {
          method: 'POST',
          body: JSON.stringify({ username: 'con espacio', fullName: 'Persona con espacio' }),
        })
      ).status,
    ).toBe(400);
    // sin nombre completo, o con uno demasiado largo
    expect((await api(srv.base, '/api/users', adm, { method: 'POST', body: JSON.stringify({ username: 'okuser' }) })).status).toBe(400);
    expect(
      (await api(srv.base, '/api/users', adm, {
        method: 'POST',
        body: JSON.stringify({ username: 'okuser', fullName: 'n'.repeat(61) }),
      })).status,
    ).toBe(400);
    for (const role of ['admin', 'drone']) {
      expect(
        (
          await api(srv.base, '/api/users', adm, {
            method: 'POST',
            body: JSON.stringify({ username: 'okuser', fullName: 'Persona okuser', role }),
          })
        ).status,
      ).toBe(400);
    }
    // duplicado del operador sembrado
    expect(
      (
        await api(srv.base, '/api/users', adm, {
          method: 'POST',
          body: JSON.stringify({ username: 'operador', fullName: 'Persona operador', dni: '30123460', role: 'operator' }),
        })
      ).status,
    ).toBe(409);
  });

  it('un supervisor cambia el canControl de un operador', async () => {
    const r = await api(srv.base, '/api/users/operador', sup, {
      method: 'PATCH',
      body: JSON.stringify({ canControl: false }),
    });
    expect(r.status).toBe(200);
    expect(r.body.canControl).toBe(false);
  });

  it('un supervisor NO puede tocar a un admin ni a otro supervisor (403)', async () => {
    expect(
      (await api(srv.base, '/api/users/admin', sup, { method: 'PATCH', body: JSON.stringify({ canControl: false }) })).status,
    ).toBe(403);
  });

  it('un supervisor no puede cambiar active ni el nombre (queda sin cambios => 400)', async () => {
    // active y fullName los ignora si no es admin: patch vacío => 400
    for (const body of [{ active: false }, { fullName: 'Otro Nombre' }]) {
      const r = await api(srv.base, '/api/users/operador', sup, { method: 'PATCH', body: JSON.stringify(body) });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('la contraseña solo se regenera, y la nueva pisa a la anterior', async () => {
    // fijarla a mano ya no es posible: hay un endpoint propio que deja rastro
    const aMano = await api(srv.base, '/api/users/operador', adm, {
      method: 'PATCH',
      body: JSON.stringify({ password: 'nuevaclave' }),
    });
    expect(aMano.status).toBe(400);
    expect(aMano.body.error).toMatch(/regenerar/i);

    const regen = await api(srv.base, '/api/users/operador/regenerate-password', adm, { method: 'POST' });
    expect(regen.status).toBe(200);
    expect(regen.body.password).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(await login(srv.base, 'operador', regen.body.password)).toBeTruthy();
    expect(await login(srv.base, 'operador', CREDS.operador)).toBeNull();

    // regenerar dos veces da claves distintas y la anterior deja de servir
    const segunda = await api(srv.base, '/api/users/operador/regenerate-password', adm, { method: 'POST' });
    expect(segunda.body.password).not.toBe(regen.body.password);
    expect(await login(srv.base, 'operador', regen.body.password)).toBeNull();

    // solo el admin, y no sobre un usuario inexistente
    expect((await api(srv.base, '/api/users/operador/regenerate-password', sup, { method: 'POST' })).status).toBe(403);
    expect((await api(srv.base, '/api/users/fantasma/regenerate-password', adm, { method: 'POST' })).status).toBe(404);
  });

  it('PATCH: usuario inexistente 404, hash de dron 404, uno mismo 400, nada para cambiar 400', async () => {
    expect(
      (await api(srv.base, '/api/users/fantasma', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) })).status,
    ).toBe(404);
    // los drones ya no son cuentas: su hash no existe en /users
    expect(
      (await api(srv.base, `/api/users/${DRON.alfa}`, adm, { method: 'PATCH', body: JSON.stringify({ active: false }) })).status,
    ).toBe(404);
    expect(
      (await api(srv.base, '/api/users/admin', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) })).status,
    ).toBe(400); // no podés modificarte a vos mismo
    expect((await api(srv.base, '/api/users/operador', adm, { method: 'PATCH', body: JSON.stringify({}) })).status).toBe(400);
  });

  it('el borrado es lógico: la cuenta no inicia sesión pero la fila queda', async () => {
    const bor0 = await crearUsuario(srv.base, adm, { username: 'borrame' });
    const baja = await api(srv.base, '/api/users/borrame', adm, { method: 'DELETE' });
    expect(baja.status).toBe(200);
    expect(baja.body.deletedAt).toBeTruthy();
    expect(await login(srv.base, 'borrame', bor0.password)).toBeNull();

    // no aparece en la lista normal, sí con includeDeleted
    const normal = (await api(srv.base, '/api/users', adm)).body;
    expect(normal.some((u: any) => u.username === 'borrame')).toBe(false);
    const conBorrados = (await api(srv.base, '/api/users?includeDeleted=1', adm)).body;
    const fila = conBorrados.find((u: any) => u.username === 'borrame');
    expect(fila.deletedAt).toBeTruthy();
    // el flag también se acepta como 'true'
    expect((await api(srv.base, '/api/users?includeDeleted=true', adm)).body.some((u: any) => u.username === 'borrame')).toBe(true);
  });

  it('el username borrado sigue ocupado: no se puede reusar', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'ocupado', fullName: 'Persona ocupado', dni: '30123461', role: 'operator' }),
    });
    await api(srv.base, '/api/users/ocupado', adm, { method: 'DELETE' });
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'ocupado', fullName: 'Persona ocupado', dni: '30123462', role: 'operator' }),
    });
    expect(r.status).toBe(409);
  });

  it('un usuario eliminado no se puede modificar hasta restaurarlo (409)', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'congelado', fullName: 'Persona congelado', dni: '30123463', role: 'operator' }),
    });
    await api(srv.base, '/api/users/congelado', adm, { method: 'DELETE' });
    const r = await api(srv.base, '/api/users/congelado', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/eliminado/i);
  });

  it('restaurar devuelve al usuario a la vida y le permite iniciar sesión', async () => {
    const vue0 = await crearUsuario(srv.base, adm, { username: 'vuelve' });
    await api(srv.base, '/api/users/vuelve', adm, { method: 'DELETE' });
    const r = await api(srv.base, '/api/users/vuelve/restore', adm, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.deletedAt).toBeNull();
    expect(await login(srv.base, 'vuelve', vue0.password)).toBeTruthy();
  });

  it('DELETE y restore: casos borde', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'borde', fullName: 'Persona borde', dni: '30123464', role: 'operator' }),
    });
    await api(srv.base, '/api/users/borde', adm, { method: 'DELETE' });
    // borrar dos veces
    expect((await api(srv.base, '/api/users/borde', adm, { method: 'DELETE' })).status).toBe(409);
    // restaurar uno que no estaba borrado
    expect((await api(srv.base, '/api/users/operador/restore', adm, { method: 'POST' })).status).toBe(409);
    // inexistentes
    expect((await api(srv.base, '/api/users/fantasma', adm, { method: 'DELETE' })).status).toBe(404);
    expect((await api(srv.base, '/api/users/fantasma/restore', adm, { method: 'POST' })).status).toBe(404);
    // uno mismo
    expect((await api(srv.base, '/api/users/admin', adm, { method: 'DELETE' })).status).toBe(400);
    // el supervisor no llega a restaurar (es de admin)
    expect((await api(srv.base, '/api/users/borde/restore', sup, { method: 'POST' })).status).toBe(403);
  });

  it('los cambios de usuario quedan registrados con antes y después', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'logtest', fullName: 'Persona logtest', dni: '30123465', role: 'operator' }),
    });
    await api(srv.base, '/api/users/logtest', adm, { method: 'PATCH', body: JSON.stringify({ canControl: false }) });
    await api(srv.base, '/api/users/logtest', adm, { method: 'DELETE' });
    await api(srv.base, '/api/users/logtest/restore', adm, { method: 'POST' });

    const logs = (await api(srv.base, '/api/logs?category=usuarios&pageSize=100', adm)).body.items;
    expect(logs.every((l: any) => l.category === 'usuarios')).toBe(true);
    expect(JSON.parse(logs.find((l: any) => l.type === 'USER_CREATED').meta).despues.username).toBe('logtest');

    const upd = JSON.parse(logs.find((l: any) => l.type === 'USER_UPDATED').meta);
    expect(upd.antes.canControl).toBe(true);
    expect(upd.despues.canControl).toBe(false);

    const del = JSON.parse(logs.find((l: any) => l.type === 'USER_DELETED').meta);
    expect(del.antes.deletedAt).toBeNull();
    expect(del.despues.deletedAt).toBeTruthy();

    const res = JSON.parse(logs.find((l: any) => l.type === 'USER_RESTORED').meta);
    expect(res.antes.deletedAt).toBeTruthy();
    expect(res.despues.deletedAt).toBeNull();
  });
});

describe('integración — nombre completo, buscador y contraseñas generadas', () => {
  let srv: TestServer;
  let adm = '';
  let sup = '';

  beforeAll(async () => {
    limpiarBase();
    seed();
    srv = await startServer();
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
  });
  afterAll(async () => {
    await srv.close();
  });

  it('el alta guarda el nombre completo y se puede corregir después', async () => {
    const creada = await crearUsuario(srv.base, adm, { username: 'nombrado', fullName: 'Ana María Pérez' });
    expect(creada.fullName).toBe('Ana María Pérez');

    const editada = await api(srv.base, '/api/users/nombrado', adm, {
      method: 'PATCH',
      body: JSON.stringify({ fullName: 'Ana María Pérez Gómez' }),
    });
    expect(editada.status).toBe(200);
    expect(editada.body.fullName).toBe('Ana María Pérez Gómez');
  });

  it('el buscador filtra por usuario, nombre y rol en un solo campo', async () => {
    await crearUsuario(srv.base, adm, { username: 'jperez', fullName: 'Juan Pérez', role: 'operator' });
    await crearUsuario(srv.base, adm, { username: 'mgomez', fullName: 'María Gómez', role: 'supervisor' });
    await crearUsuario(srv.base, adm, { username: 'rcampo', fullName: 'Rosa Campos', role: 'field_operator' });

    const buscar = async (q: string) =>
      (await api(srv.base, `/api/users?q=${encodeURIComponent(q)}`, adm)).body.map((u: { username: string }) => u.username);

    // por nombre de usuario
    expect(await buscar('jperez')).toEqual(['jperez']);
    // por apellido, sin importar mayúsculas
    expect(await buscar('gómez')).toContain('mgomez');
    // por nombre de pila
    expect(await buscar('Rosa')).toEqual(['rcampo']);
    // por el rol tal como se ve en pantalla, en español
    const porRol = await buscar('operador de campo');
    expect(porRol).toContain('rcampo');
    expect(porRol).not.toContain('mgomez');
    // por el rol interno
    expect(await buscar('supervisor')).toContain('mgomez');
    // sin resultados no rompe
    expect(await buscar('nadie con ese nombre')).toEqual([]);
    // vacío devuelve todo
    expect((await buscar('')).length).toBeGreaterThan(3);
  });

  it('el buscador respeta lo que cada rol puede ver', async () => {
    await crearUsuario(srv.base, adm, { username: 'ssecreto', fullName: 'Sonia Secreto', role: 'supervisor' });
    // el supervisor solo administra operadores: buscar un supervisor no se lo trae
    const vistaSup = (await api(srv.base, '/api/users?q=Sonia', sup)).body;
    expect(vistaSup).toEqual([]);
    const vistaAdm = (await api(srv.base, '/api/users?q=Sonia', adm)).body;
    expect(vistaAdm.map((u: { username: string }) => u.username)).toEqual(['ssecreto']);
  });

  it('la contraseña generada es distinta en cada alta y no viaja en los listados', async () => {
    const a = await crearUsuario(srv.base, adm, { username: 'gen1' });
    const b = await crearUsuario(srv.base, adm, { username: 'gen2' });
    expect(a.password).not.toBe(b.password);
    // formato legible: cuatro bloques de cuatro, sin caracteres ambiguos
    expect(a.password).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(a.password).not.toMatch(/[O0Il1]/);

    const lista = (await api(srv.base, '/api/users?includeDeleted=1', adm)).body;
    for (const u of lista) expect(u.password).toBeUndefined();
  });
});

describe('integración — DNI de los usuarios', () => {
  let srv: TestServer;
  let adm = '';
  let sup = '';

  beforeAll(async () => {
    limpiarBase();
    seed();
    srv = await startServer();
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
  });
  afterAll(async () => {
    await srv.close();
  });
  beforeEach(() => {
    limpiarBase();
    seed();
  });

  const alta = (body: object) => api(srv.base, '/api/users', adm, { method: 'POST', body: JSON.stringify(body) });
  const editar = (username: string, body: object, token = adm) =>
    api(srv.base, `/api/users/${username}`, token, { method: 'PATCH', body: JSON.stringify(body) });

  it('el alta exige un DNI válido y lo guarda sin puntos', async () => {
    const base = { username: 'condni', fullName: 'Persona condni', role: 'operator' };
    for (const dni of [undefined, '', '123456', '123456789', '30-123-456', 30123456]) {
      const r = await alta({ ...base, dni });
      expect(r.status, String(dni)).toBe(400);
      expect(r.body.error).toMatch(/DNI/);
    }
    const ok = await alta({ ...base, dni: '30.123.456' });
    expect(ok.status).toBe(201);
    expect(ok.body.dni).toBe('30123456');
    // Los de 7 dígitos también valen.
    expect((await alta({ ...base, username: 'mayor', dni: '1 234 567' })).body.dni).toBe('1234567');
  });

  it('el listado trae el DNI, y vacío para las cuentas anteriores', async () => {
    await crearUsuario(srv.base, adm, { username: 'nueva', dni: '30123456' });
    const lista = (await api(srv.base, '/api/users', adm)).body;
    expect(lista.find((u: any) => u.username === 'nueva').dni).toBe('30123456');
    // las sembradas por los tests no tienen DNI, como las de antes del cambio
    expect(lista.find((u: any) => u.username === 'operador').dni).toBe('');
  });

  it('un DNI no se repite entre cuentas vivas, pero la baja lógica lo libera', async () => {
    await crearUsuario(srv.base, adm, { username: 'primera', dni: '30123456' });
    const repetido = await alta({ username: 'segunda', fullName: 'Persona segunda', dni: '30.123.456', role: 'operator' });
    expect(repetido.status).toBe(409);
    expect(repetido.body.error).toBe('Ese DNI ya está registrado a nombre de primera');

    // Desactivada sigue siendo de esa persona: el DNI sigue ocupado.
    await editar('primera', { active: false });
    expect((await alta({ username: 'segunda', fullName: 'Persona segunda', dni: '30123456', role: 'operator' })).status).toBe(409);

    await api(srv.base, '/api/users/primera', adm, { method: 'DELETE' });
    const vuelve = await alta({ username: 'segunda', fullName: 'Persona segunda', dni: '30123456', role: 'operator' });
    expect(vuelve.status).toBe(201);
  });

  it('el buscador también encuentra por DNI, con o sin puntos', async () => {
    await crearUsuario(srv.base, adm, { username: 'jperez', fullName: 'Juan Pérez', dni: '30123456' });
    await crearUsuario(srv.base, adm, { username: 'mgomez', fullName: 'María Gómez', dni: '28999111' });
    const buscar = async (q: string) =>
      (await api(srv.base, `/api/users?q=${encodeURIComponent(q)}`, adm)).body.map((u: { username: string }) => u.username);
    expect(await buscar('30.123')).toEqual(['jperez']);
    expect(await buscar('28999111')).toEqual(['mgomez']);
  });

  it('el admin corrige el DNI; inválido 400, ajeno 409 y el propio no choca consigo mismo', async () => {
    await crearUsuario(srv.base, adm, { username: 'ana', dni: '30123456' });
    await crearUsuario(srv.base, adm, { username: 'beto', dni: '28999111' });

    const ok = await editar('ana', { dni: '30.123.457' });
    expect(ok.status).toBe(200);
    expect(ok.body.dni).toBe('30123457');

    // Un DNI cargado no se puede vaciar ni reemplazar por cualquier cosa.
    for (const dni of ['', '12', 'abc']) expect((await editar('ana', { dni })).status, dni).toBe(400);

    const ajeno = await editar('ana', { dni: '28999111' });
    expect(ajeno.status).toBe(409);
    expect(ajeno.body.error).toMatch(/a nombre de beto/);

    expect((await editar('ana', { dni: '30123457' })).status).toBe(200);
  });

  it('a una cuenta vieja sin DNI se le puede cargar uno', async () => {
    const r = await editar('operador', { dni: '35333444' });
    expect(r.status).toBe(200);
    expect(r.body.dni).toBe('35333444');
  });

  it('el supervisor no toca el DNI: se ignora como el nombre', async () => {
    await crearUsuario(srv.base, adm, { username: 'ana', dni: '30123456' });
    expect((await editar('ana', { dni: '28999111' }, sup)).status).toBe(400);
    const r = await editar('ana', { dni: '28999111', canControl: false }, sup);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dni: '30123456', canControl: false });
  });

  it('no se restaura una cuenta cuyo DNI ya tomó otra cuenta viva', async () => {
    await crearUsuario(srv.base, adm, { username: 'vieja', dni: '30123456' });
    await api(srv.base, '/api/users/vieja', adm, { method: 'DELETE' });
    await crearUsuario(srv.base, adm, { username: 'nueva', dni: '30123456' });

    const r = await api(srv.base, '/api/users/vieja/restore', adm, { method: 'POST' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/a nombre de nueva: no se puede restaurar/);

    // Con el DNI libre otra vez, sí.
    await api(srv.base, '/api/users/nueva', adm, { method: 'DELETE' });
    expect((await api(srv.base, '/api/users/vieja/restore', adm, { method: 'POST' })).status).toBe(200);
  });

  it('una cuenta vieja sin DNI se restaura sin chequeo de DNI', async () => {
    await api(srv.base, '/api/users/operador', adm, { method: 'DELETE' });
    const r = await api(srv.base, '/api/users/operador/restore', adm, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.dni).toBe('');
  });

  // "05123456" es el 5.123.456 escrito como figura adentro del CUIL. Si se
  // guardaba tal cual, la misma persona podía tener una segunda cuenta viva
  // con sólo agregarle el cero: el índice y el chequeo comparaban texto.
  describe('el cero del CUIL no hace de un DNI otro distinto', () => {
    it('el alta guarda la forma canónica y rechaza con 409 el mismo número con ceros adelante', async () => {
      const primera = await alta({ username: 'mayor', fullName: 'Persona Mayor', dni: '05.123.456', role: 'operator' });
      expect(primera.status).toBe(201);
      expect(primera.body.dni).toBe('5123456');

      for (const dni of ['5123456', '05123456', '005123456']) {
        const r = await alta({ username: 'segunda', fullName: 'Persona segunda', dni, role: 'operator' });
        expect(r.status, dni).toBe(409);
        expect(r.body.error).toBe('Ese DNI ya está registrado a nombre de mayor');
      }
    });

    it('al revés también: con el número sin ceros cargado, el de ceros adelante choca', async () => {
      await crearUsuario(srv.base, adm, { username: 'mayor', dni: '5123456' });
      const r = await alta({ username: 'segunda', fullName: 'Persona segunda', dni: '05123456', role: 'operator' });
      expect(r.status).toBe(409);
    });

    it('un DNI de puros ceros no es un DNI', async () => {
      const r = await alta({ username: 'ceros', fullName: 'Persona ceros', dni: '00.000.000', role: 'operator' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/DNI/);
    });

    it('la edición rechaza con 409 el DNI de otra cuenta escrito con el cero adelante', async () => {
      await crearUsuario(srv.base, adm, { username: 'mayor', dni: '5123456' });
      await crearUsuario(srv.base, adm, { username: 'ana', dni: '30123456' });

      const r = await editar('ana', { dni: '05.123.456' });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/a nombre de mayor/);
      // Y el propio, escrito con el cero, no choca consigo mismo ni cambia nada.
      const propio = await editar('mayor', { dni: '05123456' });
      expect(propio.status).toBe(200);
      expect(propio.body.dni).toBe('5123456');
    });

    it('no se restaura una cuenta cuyo DNI tomó otra con el cero adelante', async () => {
      await crearUsuario(srv.base, adm, { username: 'vieja', dni: '05123456' });
      await api(srv.base, '/api/users/vieja', adm, { method: 'DELETE' });
      await crearUsuario(srv.base, adm, { username: 'nueva', dni: '5123456' });

      const r = await api(srv.base, '/api/users/vieja/restore', adm, { method: 'POST' });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/a nombre de nueva: no se puede restaurar/);
    });

    it('el buscador encuentra el DNI escrito con el cero adelante', async () => {
      await crearUsuario(srv.base, adm, { username: 'mayor', fullName: 'Persona Mayor', dni: '5123456' });
      const r = await api(srv.base, `/api/users?q=${encodeURIComponent('05.123.456')}`, adm);
      expect(r.body.map((u: { username: string }) => u.username)).toEqual(['mayor']);
    });

    // Sacarle los ceros a "0" la dejaba vacía, y una búsqueda vacía no
    // encontraba ningún DNI: "0" tiene que traer a todos los que tienen un cero.
    it('una búsqueda hecha solo de ceros encuentra los DNI que tienen ceros adentro', async () => {
      await crearUsuario(srv.base, adm, { username: 'conzero', fullName: 'Con Cero', dni: '30012345' });
      await crearUsuario(srv.base, adm, { username: 'sinzero', fullName: 'Sin Cero', dni: '31234567' });
      // "0.0" busca "00", que está adentro de 30.012.345.
      for (const q of ['0', '00', '0.0']) {
        const nombres = (await api(srv.base, `/api/users?q=${encodeURIComponent(q)}`, adm)).body.map(
          (u: { username: string }) => u.username,
        );
        expect(nombres).toContain('conzero');
        expect(nombres).not.toContain('sinzero');
      }
    });
  });

  it('el cambio de DNI queda registrado con antes y después', async () => {
    await crearUsuario(srv.base, adm, { username: 'ana', dni: '30123456' });
    await editar('ana', { dni: '30123457' });
    const logs = (await api(srv.base, '/api/logs?category=usuarios&pageSize=100', adm)).body.items;
    const upd = logs.find((l: any) => l.type === 'USER_UPDATED');
    expect(upd.message).toMatch(/\(dni\)/);
    const meta = JSON.parse(upd.meta);
    expect(meta.antes.dni).toBe('30123456');
    expect(meta.despues.dni).toBe('30123457');
  });
});

describe('integración — cambio de rol', () => {
  let srv: TestServer;
  let adm = '';
  let sup = '';
  const abiertos: WsClient[] = [];

  beforeAll(async () => {
    limpiarBase();
    seed();
    srv = await startServer();
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
  });
  afterAll(async () => {
    for (const c of abiertos) await c.close();
    await srv.close();
  });
  beforeEach(() => {
    limpiarBase();
    seed();
  });

  const editar = (username: string, body: object, token = adm) =>
    api(srv.base, `/api/users/${username}`, token, { method: 'PATCH', body: JSON.stringify(body) });

  /** Crea la cuenta e inicia sesión con ella, para poder mirar qué le pasa a su consola. */
  async function conSesion(username: string, role = 'operator') {
    const creada = await crearUsuario(srv.base, adm, { username, role, canControl: role !== 'field_operator' });
    return (await login(srv.base, username, creada.password))!;
  }

  /** Abre la consola en vivo de un usuario y devuelve la promesa de su cierre (código y motivo). */
  async function consolaDe(token: string) {
    const c = await connectWs(srv.wsUrl, token);
    abiertos.push(c);
    const cierre = new Promise<{ code: number; motivo: string }>((resolve) =>
      c.ws.once('close', (code, motivo) => resolve({ code, motivo: motivo.toString() })),
    );
    return { c, cierre };
  }

  async function titularDeAlfa(): Promise<string | null> {
    const lista = (await api(srv.base, '/api/drones', adm)).body;
    return lista.find((d: any) => d.droneId === DRON.alfa).controlledBy;
  }

  it('el admin asciende a un operador a supervisor: queda registrado y le cierra la consola', async () => {
    const tok = await conSesion('ascenso');
    const { cierre } = await consolaDe(tok);

    const r = await editar('ascenso', { role: 'supervisor' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: 'supervisor', canControl: true });
    expect(await cierre).toEqual({ code: 4403, motivo: SESION_DE_OTRO_ROL });

    const logs = (await api(srv.base, '/api/logs?category=usuarios&pageSize=100', adm)).body.items;
    const upd = JSON.parse(logs.find((l: any) => l.type === 'USER_UPDATED').meta);
    expect(upd.antes.role).toBe('operator');
    expect(upd.despues.role).toBe('supervisor');

    const lista = (await api(srv.base, '/api/users', adm)).body;
    expect(lista.find((u: any) => u.username === 'ascenso').role).toBe('supervisor');
  });

  it('pasar a operador de campo le apaga el control y le suelta el dron que tenía', async () => {
    const tok = await conSesion('piloto');
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/control`, tok, { method: 'POST' })).status).toBe(200);
    expect(await titularDeAlfa()).toBe('piloto');

    const r = await editar('piloto', { role: 'field_operator' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: 'field_operator', canControl: false });
    expect(await titularDeAlfa()).toBeNull();

    const logs = (await api(srv.base, '/api/logs?category=drone&pageSize=100', adm)).body.items;
    const soltado = logs.find((l: any) => l.type === 'CONTROL_RELEASED');
    expect(JSON.parse(soltado.meta).detalle.motivo).toBe('pasó a ser operador de campo');
  });

  it('la sesión de antes del cambio de rol deja de valer: hay que volver a iniciar sesión', async () => {
    // Cerrarle el socket no alcanzaba: la consola se reconecta sola a los 3 s
    // con el MISMO token, y la cuenta sigue activa. Lo que obliga a volver a
    // entrar es que ese token ya no sirva, ni en el canal en vivo ni en la API.
    const creada = await crearUsuario(srv.base, adm, { username: 'rotado', role: 'operator', canControl: true });
    const viejo = (await login(srv.base, 'rotado', creada.password))!;
    expect((await api(srv.base, '/api/me', viejo)).body.role).toBe('operator');

    expect((await editar('rotado', { role: 'supervisor' })).status).toBe(200);

    expect(await wsCloseCode(srv.wsUrl, viejo)).toBe(4401);
    const me = await api(srv.base, '/api/me', viejo);
    // El 401 es lo que la consola entiende como "volvé a iniciar sesión".
    expect(me.status).toBe(401);
    expect(me.body.error).toBe(SESION_DE_OTRO_ROL);

    // Con la sesión nueva entra, y ya con el rol nuevo.
    const nuevo = (await login(srv.base, 'rotado', creada.password))!;
    expect((await api(srv.base, '/api/me', nuevo)).body).toMatchObject({ username: 'rotado', role: 'supervisor' });
    const consola = await connectWs(srv.wsUrl, nuevo);
    abiertos.push(consola);
    expect(consola.ws.readyState).toBe(consola.ws.OPEN);
  });

  it('el operador que pasa a ser de campo vuelve a entrar con el token corto del celular', async () => {
    const creada = await crearUsuario(srv.base, adm, { username: 'acampo', role: 'operator', canControl: true });
    const viejo = (await login(srv.base, 'acampo', creada.password))!;
    expect((await editar('acampo', { role: 'field_operator' })).status).toBe(200);

    // El token de la consola duraba 12 h: con el rol de campo ya no le sirve.
    expect((await api(srv.base, '/api/me', viejo)).status).toBe(401);
    const r = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'acampo', password: creada.password }),
    });
    const sesion = await r.json();
    expect(sesion.user.role).toBe('field_operator');
    expect(sesion.expiresIn).toBe(ttlEnSegundos(config.tokenTtlField));
  });

  it('el canControl que viene con el rol se juzga contra el rol nuevo', async () => {
    await conSesion('campito', 'field_operator');
    // de operador de campo a operador, autorizado en el mismo cambio
    const r = await editar('campito', { role: 'operator', canControl: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: 'operator', canControl: true });

    // y al revés no se puede pedir el permiso junto con el pase a campo
    const malo = await editar('campito', { role: 'field_operator', canControl: true });
    expect(malo.status).toBe(400);
    expect(malo.body.error).toMatch(/no controla drones/);
  });

  it('pedir el rol que ya tiene no es un cambio y no le cierra la consola', async () => {
    const tok = await conSesion('quieto');
    const { c } = await consolaDe(tok);
    expect((await editar('quieto', { role: 'operator' })).status).toBe(400);

    // con otro cambio al lado, se aplica ese y el rol no figura entre los cambios
    const r = await editar('quieto', { role: 'operator', fullName: 'Nombre Nuevo' });
    expect(r.status).toBe(200);
    const logs = (await api(srv.base, '/api/logs?category=usuarios&pageSize=100', adm)).body.items;
    expect(logs.find((l: any) => l.type === 'USER_UPDATED').message).toMatch(/\(fullName\)$/);
    expect(c.ws.readyState).toBe(c.ws.OPEN);
    // y su sesión sigue valiendo: el rol del token es el que la cuenta tiene
    expect((await api(srv.base, '/api/me', tok)).status).toBe(200);
  });

  it('desactivar y cambiar el rol a la vez cierra la consola como desactivación', async () => {
    const tok = await conSesion('doble');
    const { cierre } = await consolaDe(tok);
    expect((await editar('doble', { role: 'supervisor', active: false })).status).toBe(200);
    expect(await cierre).toEqual({ code: 4403, motivo: 'Cuenta desactivada' });
  });

  it('roles inválidos: nunca a admin ni a dron, y nunca desde admin', async () => {
    await conSesion('alguien');
    for (const role of ['admin', 'drone', 'jefe']) {
      const r = await editar('alguien', { role });
      expect(r.status, role).toBe(400);
    }
    // otro administrador: su rol no se toca, ni siquiera para bajarlo
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      'admin2', bcrypt.hashSync('x', 4), 'admin',
    );
    const r = await editar('admin2', { role: 'operator' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/administrador no se cambia/);
    // pero el resto de sus datos sí
    expect((await editar('admin2', { fullName: 'Otra Admin' })).status).toBe(200);
  });

  it('un supervisor no cambia roles, ni siquiera de operadores', async () => {
    await conSesion('subordinado');
    const r = await editar('subordinado', { role: 'supervisor' }, sup);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Solo un administrador cambia el rol/);
    expect((await api(srv.base, '/api/users', adm)).body.find((u: any) => u.username === 'subordinado').role).toBe('operator');
  });

  it('nadie se cambia el rol a sí mismo', async () => {
    expect((await editar('admin', { role: 'supervisor' })).status).toBe(400);
  });
});
