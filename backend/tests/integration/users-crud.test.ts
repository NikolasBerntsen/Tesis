import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seed, startServer, login, api, limpiarBase, CREDS, DRON, type TestServer } from '../helpers';

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
      body: JSON.stringify({ username: 'nuevo1', password: 'clave123', role: 'operator', canControl: false }),
    });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ username: 'nuevo1', role: 'operator', active: true, canControl: false, deletedAt: null });
    // puede iniciar sesión
    expect(await login(srv.base, 'nuevo1', 'clave123')).toBeTruthy();
  });

  it('canControl por defecto es true si no se envía', async () => {
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'nuevo2', password: 'clave123', role: 'supervisor' }),
    });
    expect(r.status).toBe(201);
    expect(r.body.canControl).toBe(true);
    expect(r.body.role).toBe('supervisor');
  });

  it('al operador de campo se le fuerza canControl:false aunque lo pidan true', async () => {
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'campo2', password: 'clave123', role: 'field_operator', canControl: true }),
    });
    expect(r.status).toBe(201);
    expect(r.body.role).toBe('field_operator');
    expect(r.body.canControl).toBe(false);
  });

  it('alta inválida: username corto/ilegal 400, password corta 400, rol inválido 400, duplicado 409', async () => {
    expect(
      (await api(srv.base, '/api/users', adm, { method: 'POST', body: JSON.stringify({ username: 'ab', password: 'clave123' }) }))
        .status,
    ).toBe(400);
    expect(
      (
        await api(srv.base, '/api/users', adm, {
          method: 'POST',
          body: JSON.stringify({ username: 'con espacio', password: 'clave123' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(srv.base, '/api/users', adm, { method: 'POST', body: JSON.stringify({ username: 'okuser', password: '123' }) }))
        .status,
    ).toBe(400);
    for (const role of ['admin', 'drone']) {
      expect(
        (
          await api(srv.base, '/api/users', adm, {
            method: 'POST',
            body: JSON.stringify({ username: 'okuser', password: 'clave123', role }),
          })
        ).status,
      ).toBe(400);
    }
    // duplicado del operador sembrado
    expect(
      (
        await api(srv.base, '/api/users', adm, {
          method: 'POST',
          body: JSON.stringify({ username: 'operador', password: 'clave123', role: 'operator' }),
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

  it('un supervisor no puede cambiar active/password (queda sin cambios => 400)', async () => {
    // active y password los ignora si no es admin: patch vacío => 400
    expect(
      (await api(srv.base, '/api/users/operador', sup, { method: 'PATCH', body: JSON.stringify({ active: false }) })).status,
    ).toBe(400);
    expect(
      (await api(srv.base, '/api/users/operador', sup, { method: 'PATCH', body: JSON.stringify({ password: 'otraclave' }) }))
        .status,
    ).toBe(400);
  });

  it('el admin cambia la contraseña y la nueva sirve para iniciar sesión', async () => {
    const r = await api(srv.base, '/api/users/operador', adm, {
      method: 'PATCH',
      body: JSON.stringify({ password: 'nuevaclave' }),
    });
    expect(r.status).toBe(200);
    expect(await login(srv.base, 'operador', 'nuevaclave')).toBeTruthy();
    expect(await login(srv.base, 'operador', CREDS.operador)).toBeNull();
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
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'borrame', password: 'clave123', role: 'operator' }),
    });
    const baja = await api(srv.base, '/api/users/borrame', adm, { method: 'DELETE' });
    expect(baja.status).toBe(200);
    expect(baja.body.deletedAt).toBeTruthy();
    expect(await login(srv.base, 'borrame', 'clave123')).toBeNull();

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
      body: JSON.stringify({ username: 'ocupado', password: 'clave123', role: 'operator' }),
    });
    await api(srv.base, '/api/users/ocupado', adm, { method: 'DELETE' });
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'ocupado', password: 'otraclave', role: 'operator' }),
    });
    expect(r.status).toBe(409);
  });

  it('un usuario eliminado no se puede modificar hasta restaurarlo (409)', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'congelado', password: 'clave123', role: 'operator' }),
    });
    await api(srv.base, '/api/users/congelado', adm, { method: 'DELETE' });
    const r = await api(srv.base, '/api/users/congelado', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/eliminado/i);
  });

  it('restaurar devuelve al usuario a la vida y le permite iniciar sesión', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'vuelve', password: 'clave123', role: 'operator' }),
    });
    await api(srv.base, '/api/users/vuelve', adm, { method: 'DELETE' });
    const r = await api(srv.base, '/api/users/vuelve/restore', adm, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.deletedAt).toBeNull();
    expect(await login(srv.base, 'vuelve', 'clave123')).toBeTruthy();
  });

  it('DELETE y restore: casos borde', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'borde', password: 'clave123', role: 'operator' }),
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
      body: JSON.stringify({ username: 'logtest', password: 'clave123', role: 'operator' }),
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
