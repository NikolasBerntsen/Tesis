import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { CONTROLES_POR_DEFECTO } from '../../src/preferencias';
import { api, crearUsuario, CREDS, DRON, login, seed, startServer, tokenDeDron, type TestServer } from '../helpers';

const CONTRATO = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../docs/contrato/preferencias.json'), 'utf8'),
) as { ejemplos: { invalidos: { caso: string; cuerpo: unknown }[] } };

const RUTA = '/api/me/preferencias';

describe('integración — preferencias de la persona (GET y PUT /api/me/preferencias)', () => {
  let srv: TestServer;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    seed();
    srv = await startServer();
    for (const [usuario, clave] of [
      ['operador', CREDS.operador],
      ['supervisor', CREDS.supervisor],
      ['admin', CREDS.admin],
      ['campo', CREDS.campo],
    ]) {
      tokens[usuario] = (await login(srv.base, usuario, clave))!;
    }
  });
  afterAll(async () => {
    await srv.close();
  });

  const poner = (token: string, cuerpo: unknown) => api(srv.base, RUTA, token, { method: 'PUT', body: JSON.stringify(cuerpo) });

  it('sin nada guardado devuelve los valores por defecto, sin fecha', async () => {
    const r = await api(srv.base, RUTA, tokens.supervisor);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ controles: CONTROLES_POR_DEFECTO, actualizadoEn: null });
  });

  it('PUT guarda el juego entero y GET lo devuelve, también desde otra sesión de la misma persona', async () => {
    const controles = { ...CONTROLES_POR_DEFECTO, sensibilidadHorizontal: 1.8, sensibilidadVertical: 0.4, invertirVertical: true };
    const r = await poner(tokens.operador, { controles });
    expect(r.status).toBe(200);
    expect(r.body.controles).toEqual(controles);
    expect(Date.parse(r.body.actualizadoEn)).not.toBeNaN();

    // Otra computadora es otra sesión: las preferencias son de la cuenta.
    const otraSesion = (await login(srv.base, 'operador', CREDS.operador))!;
    const leidas = await api(srv.base, RUTA, otraSesion);
    expect(leidas.body).toEqual(r.body);
  });

  it('PUT reemplaza: lo que no viene vuelve al valor por defecto', async () => {
    await poner(tokens.operador, { controles: { ...CONTROLES_POR_DEFECTO, pasoDeRueda: 9, velocidadGiro: 0.8 } });
    const r = await poner(tokens.operador, { controles: { velocidadGiro: 0.3 } });
    expect(r.body.controles).toEqual({ ...CONTROLES_POR_DEFECTO, velocidadGiro: 0.3 });
    // Y vacío es "restablecer".
    expect((await poner(tokens.operador, { controles: {} })).body.controles).toEqual(CONTROLES_POR_DEFECTO);
  });

  it('las de una persona no son las de otra', async () => {
    await poner(tokens.admin, { controles: { multiplicadorShift: 3.5 } });
    await poner(tokens.operador, { controles: { multiplicadorShift: 1.5 } });
    expect((await api(srv.base, RUTA, tokens.admin)).body.controles.multiplicadorShift).toBe(3.5);
    expect((await api(srv.base, RUTA, tokens.operador)).body.controles.multiplicadorShift).toBe(1.5);
    expect((await api(srv.base, RUTA, tokens.supervisor)).body.controles.multiplicadorShift).toBe(CONTROLES_POR_DEFECTO.multiplicadorShift);
  });

  it('no hay forma de escribir las de otro: nombrarlo en el cuerpo es un 400 y no toca nada', async () => {
    const antes = (await api(srv.base, RUTA, tokens.admin)).body;
    const r = await poner(tokens.operador, { controles: { pasoDeRueda: 14 }, username: 'admin' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Campo desconocido: username');
    expect((await api(srv.base, RUTA, tokens.admin)).body).toEqual(antes);
    // Ni con una ruta que nombre a otra persona: no existe.
    expect((await api(srv.base, `${RUTA}/admin`, tokens.operador)).status).toBe(404);
  });

  it.each(CONTRATO.ejemplos.invalidos)('rechaza con 400 y no guarda: $caso', async ({ cuerpo }) => {
    const antes = (await api(srv.base, RUTA, tokens.supervisor)).body;
    const r = await poner(tokens.supervisor, cuerpo);
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
    expect((await api(srv.base, RUTA, tokens.supervisor)).body).toEqual(antes);
  });

  it('un cuerpo de más de 2 KB es un 413, aunque sea JSON bien formado', async () => {
    const r = await poner(tokens.supervisor, { controles: {}, relleno: 'x'.repeat(3000) });
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/2048 bytes/);
  });

  it('un PUT sin cuerpo dice qué falta', async () => {
    const r = await api(srv.base, RUTA, tokens.supervisor, { method: 'PUT' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/controles es requerido/);
  });

  it('el operador de campo también tiene las suyas: son de la persona, no del permiso de volar', async () => {
    const r = await poner(tokens.campo, { controles: { sensibilidadVertical: 0.5 } });
    expect(r.status).toBe(200);
    expect((await api(srv.base, RUTA, tokens.campo)).body.controles.sensibilidadVertical).toBe(0.5);
  });

  it('sin sesión es un 401, y el token de un dron no tiene preferencias', async () => {
    expect((await api(srv.base, RUTA, null)).status).toBe(401);
    expect((await poner('no-es-un-token', { controles: {} })).status).toBe(401);
    const dron = tokenDeDron(DRON.alfa);
    expect((await api(srv.base, RUTA, dron)).status).toBe(403);
    expect((await poner(dron, { controles: {} })).status).toBe(403);
  });

  it('una cuenta desactivada ya no las lee ni las escribe', async () => {
    const creada = await crearUsuario(srv.base, tokens.admin, { username: 'pasajero' });
    const tok = (await login(srv.base, 'pasajero', creada.password))!;
    expect((await poner(tok, { controles: { pasoDeRueda: 2 } })).status).toBe(200);
    await api(srv.base, '/api/users/pasajero', tokens.admin, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    expect((await api(srv.base, RUTA, tok)).status).toBe(403);
    expect((await poner(tok, { controles: {} })).status).toBe(403);
  });

  it('guardar no deja registro: son ajustes de la interfaz, no operación', async () => {
    const antes = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    await poner(tokens.supervisor, { controles: { velocidadNormal: 0.7 } });
    await poner(tokens.supervisor, { controles: { velocidadNormal: 0.75 } });
    expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(antes);
  });
});
