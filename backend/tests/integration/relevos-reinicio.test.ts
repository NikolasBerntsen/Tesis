import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reinicio del hub en medio de un relevo: el estado vive en la tabla `relevos`
// de un archivo de verdad, el proceso "se cae" (se descarta todo el registro de
// módulos) y vuelve a arrancar sobre el mismo archivo. Igual que la prueba de
// migraciones, este archivo NO importa estáticamente nada del backend: cada
// arranque importa los módulos de nuevo con DB_FILE apuntando al archivo.

const archivo = path.join(os.tmpdir(), `cc-relevos-reinicio-${process.pid}-${Date.now()}.db`);

type Helpers = typeof import('../helpers');
type Hub = typeof import('../../src/ws');
type Reloj = typeof import('../../src/reloj');

/** Un arranque del hub sobre el archivo: módulos nuevos, mismo disco. */
async function arrancar(): Promise<{ h: Helpers; hub: Hub; reloj: Reloj }> {
  vi.resetModules();
  process.env.DB_FILE = archivo;
  const h = await import('../helpers');
  const hub = await import('../../src/ws');
  const reloj = await import('../../src/reloj');
  return { h, hub, reloj };
}

afterAll(() => {
  for (const f of [archivo, `${archivo}-wal`, `${archivo}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* la conexión del arranque anterior puede seguir abierta en Windows */
    }
  }
});

describe('integración — el hub se reinicia en medio de un relevo', () => {
  it('el relevo sigue en la tabla: B vuelve y recibe su orden, y el relay_go sale cuando A aterriza', async () => {
    const NORTE = { lat: -34.8565, lon: -56.2075 };
    const enEspera = { enEspera: true, disponible: true, relayId: null, rol: null, fase: null };

    // Primer arranque: A baja, B acepta y queda esperando el go.
    let { h } = await arrancar();
    h.seed();
    let srv = await h.startServer();
    let a = await h.connectWs(srv.wsUrl, h.tokenDeDron(h.DRON.alfa));
    let b = await h.connectWs(srv.wsUrl, h.tokenDeDron(h.DRON.bravo));
    b.ws.send(h.mkStatus({ state: 'IDLE', ...NORTE, alt: 0, relevo: enEspera }));
    await h.wait(80);
    a.ws.send(JSON.stringify({ type: 'landing_at_base', ref: 'rein', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 3 }));
    const { relayId } = await b.waitFor((m) => m.type === 'relay_start');
    b.ws.send(JSON.stringify({ type: 'relay_accept', relayId }));
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'EN_CAMINO');
    await a.close();
    await b.close();
    await srv.close();

    // Segundo arranque sobre el mismo archivo.
    let hub: Hub;
    ({ h, hub } = await arrancar());
    srv = await h.startServer();
    const op = (await h.login(srv.base, 'operador', h.CREDS.operador))!;
    const activos = (await h.api(srv.base, '/api/relevos?activos=1', op)).body;
    expect(activos).toEqual([expect.objectContaining({ id: relayId, estado: 'EN_CAMINO', fromIndex: 3 })]);

    b = await h.connectWs(srv.wsUrl, h.tokenDeDron(h.DRON.bravo));
    const suRelevo = { enEspera: false, disponible: false, relayId, rol: 'relevo', fase: 'esperando_despegue' };
    b.ws.send(h.mkStatus({ state: 'IDLE', ...NORTE, alt: 0, relevo: suRelevo }));
    expect(await b.waitFor((m) => m.type === 'relay_start')).toMatchObject({ relayId, fromIndex: 3 });
    await h.wait(80);
    expect(b.got.some((m) => m.type === 'relay_go')).toBe(false);

    a = await h.connectWs(srv.wsUrl, h.tokenDeDron(h.DRON.alfa));
    a.ws.send(JSON.stringify({ type: 'landed_at_base', relayId, baseId: 1, ...NORTE }));
    await b.waitFor((m) => m.type === 'relay_go' && m.relayId === relayId);
    b.ws.send(JSON.stringify({ type: 'relay_ready', relayId }));
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'COMPLETADO');
    expect(hub.relevos.listar(true)).toEqual([]);
    await a.close();
    await b.close();
    await srv.close();
  });

  it('si B no vuelve después del reinicio, el relevo falla a los 20 s del arranque', async () => {
    const NORTE = { lat: -34.8565, lon: -56.2075 };
    let { h } = await arrancar();
    let srv = await h.startServer();
    const a = await h.connectWs(srv.wsUrl, h.tokenDeDron(h.DRON.alfa));
    const b = await h.connectWs(srv.wsUrl, h.tokenDeDron(h.DRON.bravo));
    b.ws.send(h.mkStatus({ state: 'IDLE', ...NORTE, alt: 0, relevo: { enEspera: true, disponible: true, relayId: null, rol: null, fase: null } }));
    await h.wait(80);
    a.ws.send(JSON.stringify({ type: 'landing_at_base', ref: 'rein-2', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 0 }));
    const { relayId } = await b.waitFor((m) => m.type === 'relay_start');
    b.ws.send(JSON.stringify({ type: 'relay_accept', relayId }));
    await a.waitFor((m) => m.type === 'relay_status' && m.estado === 'EN_CAMINO');
    await a.close();
    await b.close();
    await srv.close();

    let hub: Hub;
    let reloj: Reloj;
    ({ h, hub, reloj } = await arrancar());
    let t = Date.now();
    reloj.relojDelHub.ahora = () => t;
    srv = await h.startServer();
    t += 20_000;
    hub.relevos.barrer();
    expect(hub.relevos.listar(true).map((r) => r.id)).toEqual([relayId]);
    t += 1;
    hub.relevos.barrer();
    expect(hub.relevos.listar(false).find((r) => r.id === relayId)).toMatchObject({
      estado: 'FALLIDO', motivoFin: 'relevo_desconectado',
    });
    await srv.close();
  });
});
