import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { crearUsuario, seed, startServer, login, api, limpiarBase, CREDS, DRON, type TestServer } from '../helpers';

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
      body: JSON.stringify({ username: 'nuevo1', fullName: 'Persona nuevo1', role: 'operator', canControl: false }),
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      username: 'nuevo1', fullName: 'Persona nuevo1', role: 'operator', active: true, canControl: false, deletedAt: null,
    });
    // la contraseña la genera el sistema y viaja UNA sola vez, en esta respuesta
    expect(r.body.password).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
    expect(await login(srv.base, 'nuevo1', r.body.password)).toBeTruthy();

    // y no se puede volver a leer: el listado nunca la trae
    const lista = await api(srv.base, '/api/users', adm);
    const ficha = lista.body.find((u: { username: string }) => u.username === 'nuevo1');
    expect(ficha.password).toBeUndefined();
  });

  it('canControl por defecto es true si no se envía', async () => {
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'nuevo2', fullName: 'Persona nuevo2', role: 'supervisor' }),
    });
    expect(r.status).toBe(201);
    expect(r.body.canControl).toBe(true);
    expect(r.body.role).toBe('supervisor');
  });

  it('al operador de campo se le fuerza canControl:false aunque lo pidan true', async () => {
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'campo2', fullName: 'Persona campo2', role: 'field_operator', canControl: true }),
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
      body: JSON.stringify({ username: 'campo3', fullName: 'Persona campo3', role: 'field_operator' }),
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
          body: JSON.stringify({ username: 'operador', fullName: 'Persona operador', role: 'operator' }),
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
    expect(regen.body.password).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
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
      body: JSON.stringify({ username: 'ocupado', fullName: 'Persona ocupado', role: 'operator' }),
    });
    await api(srv.base, '/api/users/ocupado', adm, { method: 'DELETE' });
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'ocupado', fullName: 'Persona ocupado', role: 'operator' }),
    });
    expect(r.status).toBe(409);
  });

  it('un usuario eliminado no se puede modificar hasta restaurarlo (409)', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'congelado', fullName: 'Persona congelado', role: 'operator' }),
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
      body: JSON.stringify({ username: 'borde', fullName: 'Persona borde', role: 'operator' }),
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
      body: JSON.stringify({ username: 'logtest', fullName: 'Persona logtest', role: 'operator' }),
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
    expect(a.password).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
    expect(a.password).not.toMatch(/[O0Il1]/);

    const lista = (await api(srv.base, '/api/users?includeDeleted=1', adm)).body;
    for (const u of lista) expect(u.password).toBeUndefined();
  });
});
