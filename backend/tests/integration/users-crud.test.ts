import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seed, startServer, login, api, CREDS, type TestServer } from '../helpers';
import { db } from '../../src/db';

// ABM de usuarios: alta/baja por admin, alcance del supervisor (solo canControl
// de operadores), auto-protección y el registro con antes/después.
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
    db.exec('DELETE FROM events; DELETE FROM alerts; DELETE FROM patrol_routes; DELETE FROM users; DELETE FROM sqlite_sequence;');
    seed();
  });

  it('admin crea un operador (201) con canControl explícito', async () => {
    const r = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'nuevo1', password: 'clave123', role: 'operator', canControl: false }),
    });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ username: 'nuevo1', role: 'operator', active: true, canControl: false });
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
    expect(
      (
        await api(srv.base, '/api/users', adm, {
          method: 'POST',
          body: JSON.stringify({ username: 'okuser', password: 'clave123', role: 'admin' }),
        })
      ).status,
    ).toBe(400);
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

  it('PATCH: usuario inexistente 404, cuenta de dron 404, uno mismo 400, nada para cambiar 400', async () => {
    expect(
      (await api(srv.base, '/api/users/fantasma', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) })).status,
    ).toBe(404);
    expect(
      (await api(srv.base, '/api/users/drone1', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) })).status,
    ).toBe(404);
    expect(
      (await api(srv.base, '/api/users/admin', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) })).status,
    ).toBe(400); // no podés modificarte a vos mismo
    expect((await api(srv.base, '/api/users/operador', adm, { method: 'PATCH', body: JSON.stringify({}) })).status).toBe(400);
  });

  it('el admin elimina un usuario; casos borde de DELETE', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'borrame', password: 'clave123', role: 'operator' }),
    });
    expect((await api(srv.base, '/api/users/borrame', adm, { method: 'DELETE' })).status).toBe(200);
    expect(await login(srv.base, 'borrame', 'clave123')).toBeNull();
    // inexistente y dron
    expect((await api(srv.base, '/api/users/borrame', adm, { method: 'DELETE' })).status).toBe(404);
    expect((await api(srv.base, '/api/users/drone1', adm, { method: 'DELETE' })).status).toBe(404);
    // uno mismo
    expect((await api(srv.base, '/api/users/admin', adm, { method: 'DELETE' })).status).toBe(400);
  });

  it('los cambios de usuario quedan registrados con antes y después', async () => {
    await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'logtest', password: 'clave123', role: 'operator' }),
    });
    await api(srv.base, '/api/users/logtest', adm, { method: 'PATCH', body: JSON.stringify({ canControl: false }) });
    await api(srv.base, '/api/users/logtest', adm, { method: 'DELETE' });

    const logs = (await api(srv.base, '/api/logs?category=usuarios&limit=100', adm)).body;
    expect(logs.every((l: any) => l.category === 'usuarios')).toBe(true);
    expect(logs.some((l: any) => l.type === 'USER_CREATED')).toBe(true);
    expect(logs.some((l: any) => l.type === 'USER_DELETED')).toBe(true);
    const upd = logs.find((l: any) => l.type === 'USER_UPDATED');
    expect(upd).toBeDefined();
    const meta = JSON.parse(upd.meta);
    expect(meta.antes.canControl).toBe(true);
    expect(meta.despues.canControl).toBe(false);
  });
});
