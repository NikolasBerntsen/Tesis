import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { seed, startServer, login, api, CREDS, type TestServer } from '../helpers';

describe('integración — login y /me', () => {
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

  it('login correcto devuelve token y user', async () => {
    const r = await api(srv.base, '/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ username: 'operador', password: CREDS.operador }),
    });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.user).toEqual({ username: 'operador', role: 'operator' });
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

  it('/me de un dron trae displayName y base', async () => {
    const tok = await login(srv.base, 'drone1', CREDS.drone1);
    const r = await api(srv.base, '/api/me', tok);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('drone');
    expect(r.body.displayName).toBe('Alfa');
    expect(r.body.base).toEqual({ name: 'Base Norte', lat: -34.8565, lon: -56.2075 });
  });

  it('una cuenta desactivada no puede iniciar sesión y su token viejo deja de servir', async () => {
    const adm = await login(srv.base, 'admin', CREDS.admin);
    // alta de un operador de prueba
    const alta = await api(srv.base, '/api/users', adm, {
      method: 'POST',
      body: JSON.stringify({ username: 'temporal', password: 'temporal1', role: 'operator' }),
    });
    expect(alta.status).toBe(201);

    const tokViejo = await login(srv.base, 'temporal', 'temporal1');
    expect(tokViejo).toBeTruthy();

    // desactivación
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
});
