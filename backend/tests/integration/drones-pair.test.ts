import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { seed, startServer, login, api, connectWs, crearDron, tokenDeDron, CREDS, DRON, type TestServer } from '../helpers';
import { config } from '../../src/config';

// Emparejamiento por QR: el celular escanea el hash y recibe el token de
// máquina del dron, con la instantánea GPS del operador en el registro.
describe('integración — emparejamiento por QR', () => {
  let srv: TestServer;
  let campo = '';
  let op = '';
  let sup = '';

  beforeAll(async () => {
    seed();
    srv = await startServer();
    campo = (await login(srv.base, 'campo', CREDS.campo))!;
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
  });
  afterAll(async () => {
    await srv.close();
  });

  async function ultimoPaired() {
    const evs = (await api(srv.base, '/api/events?limit=200', op)).body;
    return evs.find((e: any) => e.type === 'DRONE_PAIRED');
  }

  it('un hash válido devuelve el token del dron y su ficha', async () => {
    const r = await api(srv.base, '/api/drones/pair', campo, {
      method: 'POST',
      body: JSON.stringify({ hash: DRON.alfa, lat: -34.8566, lon: -56.2076, accuracyM: 7.5, deviceModel: 'Pixel 7a' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.drone.hash).toBe(DRON.alfa);
    expect(r.body.drone.displayName).toBe('Alfa');

    const payload = jwt.verify(r.body.token, config.jwtSecret) as jwt.JwtPayload;
    expect(payload.sub).toBe(DRON.alfa);
    expect(payload.role).toBe('drone');
    // el token de máquina dura todo un despliegue: 30 días
    expect(payload.exp! - payload.iat!).toBe(30 * 86400);

    // y sirve para hablar con el Comando Central por REST y por WS
    expect((await api(srv.base, '/api/me', r.body.token)).body.droneId).toBe(DRON.alfa);
    const ws = await connectWs(srv.wsUrl, r.body.token);
    await ws.close();
  });

  it('el emparejamiento queda registrado con la ubicación del operador', async () => {
    await api(srv.base, '/api/drones/pair', campo, {
      method: 'POST',
      body: JSON.stringify({ hash: DRON.bravo, lat: -34.86, lon: -56.205, accuracyM: 12, deviceModel: 'Moto G54' }),
    });
    const ev = await ultimoPaired();
    expect(ev.drone_id).toBe(DRON.bravo);
    expect(ev.source).toBe('campo');
    const meta = JSON.parse(ev.meta);
    expect(meta.por).toBe('campo');
    expect(meta.ubicacion).toEqual({ lat: -34.86, lon: -56.205, accuracyM: 12 });
    expect(meta.dispositivo).toBe('Moto G54');
    expect(meta.drone).toEqual({ hash: DRON.bravo, displayName: 'Bravo', model: 'DJI Mini 3' });
  });

  it('si se negó el permiso de ubicación el emparejamiento igual procede', async () => {
    const r = await api(srv.base, '/api/drones/pair', campo, {
      method: 'POST',
      body: JSON.stringify({ hash: DRON.charlie }),
    });
    expect(r.status).toBe(200);
    const meta = JSON.parse((await ultimoPaired()).meta);
    expect(meta.ubicacion).toBeNull();
    expect(meta.dispositivo).toBeNull();
  });

  it('una ubicación incompleta o fuera de rango se guarda como nula', async () => {
    const casos = [
      { lat: -34.86 },
      { lat: 'x', lon: -56.2 },
      { lat: 95, lon: -56.2 },
      { lat: -34.86, lon: 190 },
    ];
    for (const ubic of casos) {
      await api(srv.base, '/api/drones/pair', campo, { method: 'POST', body: JSON.stringify({ hash: DRON.alfa, ...ubic }) });
      expect(JSON.parse((await ultimoPaired()).meta).ubicacion, JSON.stringify(ubic)).toBeNull();
    }
    // con lat/lon válidos pero sin precisión, accuracyM queda en null
    await api(srv.base, '/api/drones/pair', campo, {
      method: 'POST',
      body: JSON.stringify({ hash: DRON.alfa, lat: -34.86, lon: -56.2 }),
    });
    expect(JSON.parse((await ultimoPaired()).meta).ubicacion).toEqual({ lat: -34.86, lon: -56.2, accuracyM: null });
  });

  it('sin hash da 400 y un hash desconocido da 404 con un mensaje entendible', async () => {
    expect((await api(srv.base, '/api/drones/pair', campo, { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
    const r = await api(srv.base, '/api/drones/pair', campo, { method: 'POST', body: JSON.stringify({ hash: 'a'.repeat(32) }) });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no corresponde a ningún dron registrado/i);
  });

  it('un dron eliminado o desactivado no se puede emparejar (403)', async () => {
    const borrado = await crearDron(srv.base, sup, { displayName: 'Emparejar-Baja' });
    await api(srv.base, `/api/drones/${borrado.hash}`, sup, { method: 'DELETE' });
    const rBorrado = await api(srv.base, '/api/drones/pair', campo, { method: 'POST', body: JSON.stringify({ hash: borrado.hash }) });
    expect(rBorrado.status).toBe(403);
    expect(rBorrado.body.error).toMatch(/eliminado/i);

    const apagado = await crearDron(srv.base, sup, { displayName: 'Emparejar-Apagado' });
    await api(srv.base, `/api/drones/${apagado.hash}`, sup, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    const rApagado = await api(srv.base, '/api/drones/pair', campo, { method: 'POST', body: JSON.stringify({ hash: apagado.hash }) });
    expect(rApagado.status).toBe(403);
    expect(rApagado.body.error).toMatch(/desactivado/i);
  });

  it('emparejar es de campo, supervisor y admin: ni el operador ni el propio dron pueden', async () => {
    expect((await api(srv.base, '/api/drones/pair', op, { method: 'POST', body: JSON.stringify({ hash: DRON.alfa }) })).status).toBe(403);
    expect(
      (await api(srv.base, '/api/drones/pair', tokenDeDron(DRON.alfa), { method: 'POST', body: JSON.stringify({ hash: DRON.alfa }) }))
        .status,
    ).toBe(403);
    expect((await api(srv.base, '/api/drones/pair', null, { method: 'POST', body: JSON.stringify({ hash: DRON.alfa }) })).status).toBe(401);
    expect((await api(srv.base, '/api/drones/pair', sup, { method: 'POST', body: JSON.stringify({ hash: DRON.alfa }) })).status).toBe(200);
  });

  it('el token de un dron emparejado deja de servir si después lo desactivan', async () => {
    const d = await crearDron(srv.base, sup, { displayName: 'Efímero' });
    const r = await api(srv.base, '/api/drones/pair', campo, { method: 'POST', body: JSON.stringify({ hash: d.hash }) });
    expect((await api(srv.base, '/api/me', r.body.token)).status).toBe(200);

    await api(srv.base, `/api/drones/${d.hash}`, sup, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    const luego = await api(srv.base, '/api/me', r.body.token);
    expect(luego.status).toBe(403);
    expect(luego.body.error).toMatch(/desactivado/i);
  });
});
