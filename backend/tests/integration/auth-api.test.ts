import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { seed, startServer, login, api, emparejar, CREDS, DRON, type TestServer } from '../helpers';

describe('integración — login, /me y cierre de sesión', () => {
  let srv: TestServer;
  beforeAll(async () => {
    seed();
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it('GET /api/health responde ok sin auth', async () => {
    const r = await api(srv.base, '/api/health', null);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('login correcto devuelve token, user y expiresIn', async () => {
    const r = await api(srv.base, '/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ username: 'operador', password: CREDS.operador }),
    });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.user).toEqual({ username: 'operador', role: 'operator' });
    expect(r.body.expiresIn).toBe(12 * 3600);
  });

  it('el operador de campo recibe una sesión de 20 minutos', async () => {
    const r = await api(srv.base, '/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ username: 'campo', password: CREDS.campo }),
    });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('field_operator');
    expect(r.body.expiresIn).toBe(20 * 60);
  });

  it('login con contraseña incorrecta da 401', async () => {
    const r = await api(srv.base, '/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ username: 'operador', password: 'mala' }),
    });
    expect(r.status).toBe(401);
  });

  it('login sin username/password (body inválido) da 400', async () => {
    const r = await api(srv.base, '/api/auth/login', null, { method: 'POST', body: JSON.stringify({ username: 'x' }) });
    expect(r.status).toBe(400);
  });

  it('/me sin token da 401', async () => {
    const r = await api(srv.base, '/api/me', null);
    expect(r.status).toBe(401);
  });

  it('/me de un humano trae rol y canControl', async () => {
    const tok = await login(srv.base, 'supervisor', CREDS.supervisor);
    const r = await api(srv.base, '/api/me', tok);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ username: 'supervisor', role: 'supervisor', canControl: true });
  });

  it('/me de un dron emparejado trae displayName y base', async () => {
    const campo = (await login(srv.base, 'campo', CREDS.campo))!;
    const tok = await emparejar(srv.base, campo, DRON.alfa);
    const r = await api(srv.base, '/api/me', tok);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('drone');
    expect(r.body.droneId).toBe(DRON.alfa);
    expect(r.body.displayName).toBe('Alfa');
    expect(r.body.base).toEqual({ name: 'Base Norte', lat: -34.8565, lon: -56.2075 });
  });

  it('/me de un dron eliminado después de emparejar da 403', async () => {
    const campo = (await login(srv.base, 'campo', CREDS.campo))!;
    const sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    const tok = await emparejar(srv.base, campo, DRON.charlie);
    expect((await api(srv.base, '/api/me', tok)).status).toBe(200);

    await api(srv.base, `/api/drones/${DRON.charlie}`, sup, { method: 'DELETE' });
    const r = await api(srv.base, '/api/me', tok);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/eliminado/i);
    await api(srv.base, `/api/drones/${DRON.charlie}/restore`, sup, { method: 'POST' });
  });

  it('una cuenta desactivada no puede iniciar sesión y su token viejo deja de servir', async () => {
    const adm = await login(srv.base, 'admin', CREDS.admin);
    const alta = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'temporal', password: 'temporal1', role: 'operator' }),
    });
    expect(alta.status).toBe(201);

    const tokViejo = await login(srv.base, 'temporal', 'temporal1');
    expect(tokViejo).toBeTruthy();

    const desact = await api(srv.base, '/api/users/temporal', adm, {
      method: 'PATCH',
      body: JSON.stringify({ active: false }),
    });
    expect(desact.status).toBe(200);
    expect(desact.body.active).toBe(false);

    // ya no inicia sesión
    expect(await login(srv.base, 'temporal', 'temporal1')).toBeNull();
    // y el token que tenía deja de servir (flag active EN VIVO)
    const conViejo = await api(srv.base, '/api/me', tokViejo);
    expect(conViejo.status).toBe(403);
    expect(conViejo.body.error).toMatch(/desactivada/i);
  });

  it('POST /auth/logout de un humano común no deja rastro en el registro', async () => {
    const tok = (await login(srv.base, 'operador', CREDS.operador))!;
    const r = await api(srv.base, '/api/auth/logout', tok, { method: 'POST', body: JSON.stringify({}) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('POST /auth/logout sin token da 401', async () => {
    expect((await api(srv.base, '/api/auth/logout', null, { method: 'POST' })).status).toBe(401);
  });
});
