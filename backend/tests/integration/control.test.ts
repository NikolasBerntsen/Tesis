import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { crearUsuario, seed, startServer, login, api, connectWs, tokenDeDron, tokenHumano, wait, CREDS, DRON, type TestServer, type WsClient } from '../helpers';
import { PLAZOS_DEL_CONTROL } from '../../src/control';
import { db } from '../../src/db';
import { relojDelHub } from '../../src/reloj';
import type { Role } from '../../src/store';
import { control } from '../../src/ws';

// Control manual exclusivo: toma, movimiento, liberación (titular y forzada por
// supervisor), y cómo la suspensión/desactivación cortan el control en el acto.
describe('integración — control manual exclusivo', () => {
  let srv: TestServer;
  let op = '';
  let sup = '';
  let adm = '';
  let oper2 = '';
  let noControl = '';
  let alfa: WsClient;
  let operWs: WsClient;

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;

    // segundo operador con control y un operador sin control
    const dos = await crearUsuario(srv.base, adm, { username: 'oper2', canControl: true });
    const sin = await crearUsuario(srv.base, adm, { username: 'sincontrol', canControl: false });
    oper2 = (await login(srv.base, 'oper2', dos.password))!;
    noControl = (await login(srv.base, 'sincontrol', sin.password))!;

    alfa = await connectWs(srv.wsUrl, tokenDeDron(DRON.alfa));
    operWs = await connectWs(srv.wsUrl, op);
  });

  afterAll(async () => {
    await alfa.close();
    await operWs.close();
    await srv.close();
  });

  // limpia los buffers de mensajes para no confundir con mensajes de tests previos
  beforeEach(() => {
    alfa.got.length = 0;
    operWs.got.length = 0;
  });

  // deja el dron libre y restaura los flags que algún test haya tocado
  afterEach(async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, adm, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
    await api(srv.base, '/api/users/operador', adm, { method: 'PATCH', body: JSON.stringify({ canControl: true }) });
  });

  /** Lee el titular del control desde la ficha que devuelve GET /drones. */
  async function titular(): Promise<string | null> {
    const lista = (await api(srv.base, '/api/drones', adm)).body;
    return lista.find((d: any) => d.droneId === DRON.alfa).controlledBy;
  }

  it('el operador toma el control y el dron recibe control_taken', async () => {
    const r = await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.controlledBy).toBe('operador');
    await alfa.waitFor((m) => m.type === 'control_taken' && m.by === 'operador');
    await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === 'operador');
  });

  it('el mismo titular puede re-tomar el control (idempotente)', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    const r = await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    expect(r.status).toBe(200);
  });

  it('un segundo usuario NO puede tomar un dron ya controlado (409)', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    const r = await api(srv.base, `/api/drones/${DRON.alfa}/control`, adm, { method: 'POST' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/operador/);
  });

  it('control: sin canControl da 403, dron inexistente da 404', async () => {
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/control`, noControl, { method: 'POST' })).status).toBe(403);
    expect((await api(srv.base, '/api/drones/fantasma/control', op, { method: 'POST' })).status).toBe(404);
  });

  it('el titular mueve el dron; otro usuario recibe 409; parámetros inválidos 400', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    const mv = await api(srv.base, `/api/drones/${DRON.alfa}/manual_move`, op, {
      method: 'POST',
      body: JSON.stringify({ bearing: 90, distanceM: 25 }),
    });
    expect(mv.status).toBe(200);
    await alfa.waitFor((m) => m.type === 'manual_move' && m.bearing === 90 && m.distanceM === 25);

    // otro usuario no es el titular
    const otro = await api(srv.base, `/api/drones/${DRON.alfa}/manual_move`, adm, {
      method: 'POST',
      body: JSON.stringify({ bearing: 0, distanceM: 25 }),
    });
    expect(otro.status).toBe(409);

    // distancia fuera de rango
    const malo = await api(srv.base, `/api/drones/${DRON.alfa}/manual_move`, op, {
      method: 'POST',
      body: JSON.stringify({ bearing: 90, distanceM: 999 }),
    });
    expect(malo.status).toBe(400);
  });

  it('el titular despega y aterriza el dron en el lugar, y queda registrado', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    for (const [orden, evento] of [['takeoff', 'TAKEOFF_ORDERED'], ['land', 'LANDING_ORDERED']]) {
      const r = await api(srv.base, `/api/drones/${DRON.alfa}/${orden}`, op, { method: 'POST' });
      expect(r.status, orden).toBe(200);
      expect(r.body).toEqual({ ok: true, delivered: true });
      const msg = await alfa.waitFor((m) => m.type === orden);
      expect(msg).toEqual({ type: orden, by: 'operador' });

      const ev = await operWs.waitFor((m) => m.type === 'event' && m.event.type === evento);
      expect(ev.event.drone_id).toBe(DRON.alfa);
      expect(ev.event.source).toBe('operador');
      expect(JSON.parse(ev.event.meta)).toEqual({
        drone: { hash: DRON.alfa, displayName: 'Alfa', model: 'DJI Mini 3' },
        detalle: { por: 'operador' },
      });
    }
  });

  it('despegar o aterrizar sin ser el titular da 409, aunque sea un supervisor', async () => {
    for (const orden of ['takeoff', 'land']) {
      // nadie tiene el control
      const libre = await api(srv.base, `/api/drones/${DRON.alfa}/${orden}`, op, { method: 'POST' });
      expect(libre.status, orden).toBe(409);
      expect(libre.body.error).toBe('No tenés el control manual de este dron');
    }
    // el control lo tiene otro: ni el operador ni el supervisor despegan por encima del titular
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, oper2, { method: 'POST' });
    alfa.got.length = 0;
    for (const tok of [op, sup]) {
      for (const orden of ['takeoff', 'land']) {
        expect((await api(srv.base, `/api/drones/${DRON.alfa}/${orden}`, tok, { method: 'POST' })).status).toBe(409);
      }
    }
    await new Promise((r) => setTimeout(r, 120));
    expect(alfa.got.some((m) => m.type === 'takeoff' || m.type === 'land')).toBe(false);
  });

  it('despegar o aterrizar: sin canControl da 403 y un dron inexistente da 404', async () => {
    for (const orden of ['takeoff', 'land']) {
      expect((await api(srv.base, `/api/drones/${DRON.alfa}/${orden}`, noControl, { method: 'POST' })).status).toBe(403);
      expect((await api(srv.base, `/api/drones/fantasma/${orden}`, op, { method: 'POST' })).status).toBe(404);
    }
    // canControl se lee de la base en cada request: quitárselo al titular le
    // suelta el lock, y aunque volviera a tenerlo, sin el permiso no despega
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    await api(srv.base, '/api/users/operador', adm, { method: 'PATCH', body: JSON.stringify({ canControl: false }) });
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/takeoff`, op, { method: 'POST' })).status).toBe(403);
  });

  it('despegar un dron desconectado responde delivered=false y la orden queda registrada', async () => {
    await api(srv.base, `/api/drones/${DRON.charlie}/control`, op, { method: 'POST' });
    try {
      const r = await api(srv.base, `/api/drones/${DRON.charlie}/takeoff`, op, { method: 'POST' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, delivered: false });
      const evs = (await api(srv.base, `/api/events?droneId=${DRON.charlie}`, op)).body;
      expect(evs.some((e: any) => e.type === 'TAKEOFF_ORDERED' && e.message.includes('Charlie'))).toBe(true);
    } finally {
      await api(srv.base, `/api/drones/${DRON.charlie}/control`, op, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
    }
  });

  it('un supervisor fuerza la liberación; el dron recibe control_released y resume', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    alfa.got.length = 0;
    const force = await api(srv.base, `/api/drones/${DRON.alfa}/control`, sup, {
      method: 'DELETE',
      body: JSON.stringify({ resume: 'last' }),
    });
    expect(force.status).toBe(200);
    expect(force.body.controlledBy).toBeNull();
    await alfa.waitFor((m) => m.type === 'control_released');
    await alfa.waitFor((m) => m.type === 'resume_patrol');
    await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === null);
  });

  it('el titular libera con resume=none (no manda resume_patrol)', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    alfa.got.length = 0;
    const r = await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, {
      method: 'DELETE',
      body: JSON.stringify({ resume: 'none' }),
    });
    expect(r.status).toBe(200);
    await alfa.waitFor((m) => m.type === 'control_released');
    // no debería haber resume_patrol
    expect(alfa.got.some((m) => m.type === 'resume_patrol')).toBe(false);
  });

  it('el titular libera con resume=<número> y el dron reanuda desde ese nodo', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    alfa.got.length = 0;
    const r = await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'DELETE', body: JSON.stringify({ resume: 2 }) });
    expect(r.status).toBe(200);
    await alfa.waitFor((m) => m.type === 'resume_patrol' && m.fromIndex === 2);
  });

  it('DELETE control sin lock da 409; un no-titular no-supervisor da 403', async () => {
    // sin lock
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'DELETE' })).status).toBe(409);
    // con lock de op, oper2 (operador) no puede quitarlo
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    const r = await api(srv.base, `/api/drones/${DRON.alfa}/control`, oper2, { method: 'DELETE' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/operador/);
  });

  it('reanudar (resume) libera el control si estaba tomado', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    alfa.got.length = 0;
    const r = await api(srv.base, `/api/drones/${DRON.alfa}/resume`, op, { method: 'POST', body: JSON.stringify({ fromIndex: 1 }) });
    expect(r.status).toBe(200);
    await alfa.waitFor((m) => m.type === 'control_released');
    await alfa.waitFor((m) => m.type === 'resume_patrol' && m.fromIndex === 1);
    expect(await titular()).toBeNull();
  });

  it('reanudar sin nodo mientras se tiene el control lo libera y sigue desde el último', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    alfa.got.length = 0;
    const r = await api(srv.base, `/api/drones/${DRON.alfa}/resume`, op, { method: 'POST', body: JSON.stringify({}) });
    expect(r.status).toBe(200);
    await alfa.waitFor((m) => m.type === 'control_released');
    const reanuda = await alfa.waitFor((m) => m.type === 'resume_patrol');
    expect(reanuda.fromIndex).toBeUndefined();
    expect(await titular()).toBeNull();
  });

  it('un comando de otro operador sobre un dron controlado por otro da 409', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    // oper2 es operador (no supervisor): no puede comandar un dron tomado por op
    expect(
      (
        await api(srv.base, `/api/drones/${DRON.alfa}/route/start`, oper2, {
          method: 'POST',
          body: JSON.stringify({ routeId: 1 }),
        })
      ).status,
    ).toBe(409);
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/route/stop`, oper2, { method: 'POST' })).status).toBe(409);
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/resume`, oper2, { method: 'POST' })).status).toBe(409);
    expect(
      (
        await api(srv.base, `/api/drones/${DRON.alfa}/goto`, oper2, {
          method: 'POST',
          body: JSON.stringify({ routeId: 1, index: 0 }),
        })
      ).status,
    ).toBe(409);
    // pero un supervisor sí puede (override jerárquico)
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/route/stop`, sup, { method: 'POST' })).status).toBe(200);
  });

  it('suspender canControl corta el control en el acto y bloquea nuevas tomas', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    alfa.got.length = 0;
    const susp = await api(srv.base, '/api/users/operador', sup, {
      method: 'PATCH',
      body: JSON.stringify({ canControl: false }),
    });
    expect(susp.status).toBe(200);
    expect(susp.body.canControl).toBe(false);
    // el lock se liberó
    await alfa.waitFor((m) => m.type === 'control_released');
    expect(await titular()).toBeNull();
    // suspendido no puede tomar control ni forzar goto
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' })).status).toBe(403);
    expect(
      (
        await api(srv.base, `/api/drones/${DRON.alfa}/goto`, op, { method: 'POST', body: JSON.stringify({ routeId: 1, index: 0 }) })
      ).status,
    ).toBe(403);
    // al restaurarlo, vuelve a poder
    await api(srv.base, '/api/users/operador', sup, { method: 'PATCH', body: JSON.stringify({ canControl: true }) });
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' })).status).toBe(200);
  });

  it('desactivar un usuario corta el control que tenía', async () => {
    const efi0 = await crearUsuario(srv.base, adm, { username: 'efimero' });
    const efi = (await login(srv.base, 'efimero', efi0.password))!;
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, efi, { method: 'POST' });
    expect(await titular()).toBe('efimero');

    const desact = await api(srv.base, '/api/users/efimero', adm, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    expect(desact.status).toBe(200);
    expect(await titular()).toBeNull();
  });

  it('eliminar al usuario que tiene el control lo libera', async () => {
    const abo0 = await crearUsuario(srv.base, adm, { username: 'aborrar' });
    const tok = (await login(srv.base, 'aborrar', abo0.password))!;
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, tok, { method: 'POST' });
    expect(await titular()).toBe('aborrar');

    expect((await api(srv.base, '/api/users/aborrar', adm, { method: 'DELETE' })).status).toBe(200);
    expect(await titular()).toBeNull();
  });

  it('desactivar el dron corta el control y le cierra el WebSocket', async () => {
    const bravo = await connectWs(srv.wsUrl, tokenDeDron(DRON.bravo));
    await api(srv.base, `/api/drones/${DRON.bravo}/control`, op, { method: 'POST' });

    const patch = await api(srv.base, `/api/drones/${DRON.bravo}`, sup, {
      method: 'PATCH',
      body: JSON.stringify({ active: false }),
    });
    expect(patch.status).toBe(200);
    expect(patch.body.active).toBe(false);
    await bravo.close();

    const lista = (await api(srv.base, '/api/drones', adm)).body;
    const ficha = lista.find((d: any) => d.droneId === DRON.bravo);
    expect(ficha.controlledBy).toBeNull();
    expect(ficha.online).toBe(false);

    await api(srv.base, `/api/drones/${DRON.bravo}`, sup, { method: 'PATCH', body: JSON.stringify({ active: true }) });
  });

  it('un rol que no está en la jerarquía no toma el control ni mueve el dron: el REST falla CERRADO', async () => {
    // La columna `role` no tiene CHECK ("validado en código") y las migraciones
    // copian el valor viejo tal cual, así que una fila puede traer un rol que no
    // está en ROLE_RANK. `undefined < ROLE_RANK.operator` es false en JS: sin el
    // control explícito en requireAuth, esa cuenta PASA el filtro de rol de toda
    // la API REST. Y el camino REST es el que menos revalida: manual_move solo
    // compara el lock, así que con el lock ya tomado movería el dron 25 m por
    // click. El mando por WebSocket ya falla cerrado; esta es la otra mitad.
    const vieja = await crearUsuario(srv.base, adm, { username: 'rolviejo', canControl: true });
    const tok = (await login(srv.base, 'rolviejo', vieja.password))!;

    // Con el rol bueno toma el lock, para que lo único que cambie después sea el rol.
    expect((await api(srv.base, `/api/drones/${DRON.alfa}/control`, tok, { method: 'POST' })).status).toBe(200);
    expect(await titular()).toBe('rolviejo');
    alfa.got.length = 0;

    db.prepare('UPDATE users SET role = ? WHERE username = ?').run('operador_viejo', 'rolviejo');
    // Con el token de antes el pedido rebotaría por sesión vieja (otro rol, 401)
    // sin llegar al rango. El token con el rol raro es el que tendría quien
    // inicie sesión después de que una migración dejó la fila así.
    const tokViejo = tokenHumano('rolviejo', 'operador_viejo' as Role);
    try {
      const mover = await api(srv.base, `/api/drones/${DRON.alfa}/manual_move`, tokViejo, {
        method: 'POST',
        body: JSON.stringify({ bearing: 90, distanceM: 25 }),
      });
      expect(mover.status).toBe(403);
      expect(mover.body.error).toMatch(/permiso/i);
      // Y al dron no le llegó nada: el 403 no es cosmético.
      await new Promise((r) => setTimeout(r, 120));
      expect(alfa.got.filter((m: any) => m.type === 'manual_move')).toHaveLength(0);

      // Tampoco puede tomar el lock de otro dron con ese rol.
      expect((await api(srv.base, `/api/drones/${DRON.charlie}/control`, tokViejo, { method: 'POST' })).status).toBe(403);
      // Ni leer el tablero, que también pide operator o más.
      expect((await api(srv.base, '/api/events', tokViejo)).status).toBe(403);
    } finally {
      // El rol se devuelve a mano: la fila sobrevive al test y los que siguen no
      // tienen por qué heredar una cuenta con el rol roto.
      db.prepare('UPDATE users SET role = ? WHERE username = ?').run('operator', 'rolviejo');
    }
  });

  describe('el titular que deja de dar señales de vida', () => {
    const relojReal = relojDelHub.ahora;
    let t = 0;

    beforeEach(() => {
      t = Date.now();
      relojDelHub.ahora = () => t;
    });

    afterEach(() => {
      relojDelHub.ahora = relojReal;
    });

    /** oper2 con una sola consola abierta y el control de Alfa. */
    async function oper2ConControl(): Promise<WsClient> {
      const o2ws = await connectWs(srv.wsUrl, oper2);
      expect((await api(srv.base, `/api/drones/${DRON.alfa}/control`, oper2, { method: 'POST' })).status).toBe(200);
      await alfa.waitFor((m) => m.type === 'control_taken' && m.by === 'oper2');
      await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === 'oper2');
      alfa.got.length = 0;
      operWs.got.length = 0;
      return o2ws;
    }

    it('cerrar su última consola no le suelta el control en el acto; 30 s sin señales, sí, y sin reanudar nada', async () => {
      const o2ws = await oper2ConControl();
      await o2ws.close();
      await wait(150);
      // una pestaña que recarga o un corte de dos segundos no le sacan el dron
      expect(await titular()).toBe('oper2');

      t += PLAZOS_DEL_CONTROL.sinSenalesMs - 1;
      control.barrer();
      expect(await titular()).toBe('oper2');

      t += 1;
      control.barrer();
      expect(await titular()).toBeNull();
      // la app lo atiende distinto: le devuelve el mando al control físico (§2)
      expect(await alfa.waitFor((m) => m.type === 'control_released')).toEqual({
        type: 'control_released', by: 'Comando Central', motivo: 'inactividad',
      });
      const cambio = await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === null);
      expect(cambio).toEqual({
        type: 'control_changed', droneId: DRON.alfa, controlledBy: null, teniaElControl: 'oper2', motivo: 'inactividad',
      });
      const ev = await operWs.waitFor((m) => m.type === 'event' && m.event.type === 'CONTROL_RELEASED');
      expect(JSON.parse(ev.event.meta).detalle).toEqual({
        por: 'Comando Central', teniaElControl: 'oper2', forzado: true, motivo: 'oper2 estuvo 30 s sin dar señales desde la consola',
      });
      await wait(100);
      // el dron no sale a patrullar porque a alguien se le cayó internet
      expect(alfa.got.some((m) => m.type === 'resume_patrol')).toBe(false);
    });

    it('el latido del titular lo mantiene aunque no mande ningún mando; el de otro no cuenta', async () => {
      const o2ws = await oper2ConControl();
      try {
        // otro operador no puede mantener vivo un control que no es suyo
        t += PLAZOS_DEL_CONTROL.sinSenalesMs - 1_000;
        operWs.ws.send(JSON.stringify({ type: 'control_heartbeat', droneId: DRON.alfa }));
        o2ws.ws.send(JSON.stringify({ type: 'control_heartbeat', droneId: DRON.alfa }));
        await wait(100);
        t += PLAZOS_DEL_CONTROL.sinSenalesMs - 1;
        control.barrer();
        expect(await titular()).toBe('oper2');

        // un mando aceptado también es una señal de vida
        o2ws.ws.send(JSON.stringify({ type: 'manual_stick', droneId: DRON.alfa, pitch: 0, roll: 0, yaw: 0, throttle: 0 }));
        await alfa.waitFor((m) => m.type === 'manual_stick');
        t += PLAZOS_DEL_CONTROL.sinSenalesMs - 1;
        control.barrer();
        expect(await titular()).toBe('oper2');

        // basura y un dron que no es suyo no rompen nada ni cuentan
        o2ws.ws.send(JSON.stringify({ type: 'control_heartbeat' }));
        o2ws.ws.send(JSON.stringify({ type: 'control_heartbeat', droneId: DRON.bravo }));
        await wait(100);
        t += 1;
        control.barrer();
        expect(await titular()).toBeNull();
      } finally {
        await o2ws.close();
      }
    });

    it('la sesión vencida no da señales de vida: el socket se cierra con 4401', async () => {
      const vence = Math.floor(Date.now() / 1000) + 1;
      const tok = tokenHumano('oper2', 'operator', 1);
      expect((await api(srv.base, `/api/drones/${DRON.alfa}/control`, oper2, { method: 'POST' })).status).toBe(200);
      const c = await connectWs(srv.wsUrl, tok);
      const cerrado = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
      while (Date.now() < vence * 1000 + 50) await wait(50);
      c.ws.send(JSON.stringify({ type: 'control_heartbeat', droneId: DRON.alfa }));
      expect(await cerrado).toBe(4401);
    });
  });

  describe('el dron que se reconecta: el hub le dice quién tiene el control', () => {
    const titularDeCharlie = async () =>
      (await api(srv.base, '/api/drones', adm)).body.find((d: any) => d.droneId === DRON.charlie).controlledBy;
    const delControl = (c: WsClient) =>
      c.got.filter((m) => ['control_released', 'control_taken', 'control_transferred'].includes(m.type));

    afterEach(async () => {
      await api(srv.base, `/api/drones/${DRON.charlie}/control`, adm, { method: 'DELETE', body: JSON.stringify({ resume: 'none' }) });
    });

    it('sin titular, al conectarse le suelta el control (a una app sin el control tomado no le hace nada)', async () => {
      const c = await connectWs(srv.wsUrl, tokenDeDron(DRON.charlie));
      try {
        expect(await c.waitFor((m) => m.type === 'control_released')).toEqual({ type: 'control_released', by: 'Comando Central' });
        await wait(100);
        expect(delControl(c)).toHaveLength(1);
        // soltarlo no es una orden de patrullar
        expect(c.got.some((m) => m.type === 'resume_patrol')).toBe(false);
      } finally {
        await c.close();
      }
    });

    it('si el dron se desconecta, el lock sigue; al volver le llega control_taken con resync', async () => {
      const antes = await connectWs(srv.wsUrl, tokenDeDron(DRON.charlie));
      await antes.waitFor((m) => m.type === 'control_released');
      expect((await api(srv.base, `/api/drones/${DRON.charlie}/control`, op, { method: 'POST' })).status).toBe(200);
      await antes.waitFor((m) => m.type === 'control_taken');
      operWs.got.length = 0;
      await antes.close();
      await wait(150);
      // el lock es del piloto, que sigue en su consola: no se borra sin avisarle a nadie
      expect(await titularDeCharlie()).toBe('operador');
      expect(operWs.got.some((m) => m.type === 'control_changed' && m.controlledBy === null)).toBe(false);

      const despues = await connectWs(srv.wsUrl, tokenDeDron(DRON.charlie));
      try {
        expect(await despues.waitFor((m) => m.type === 'control_taken')).toEqual({
          type: 'control_taken', by: 'operador', resync: true,
        });
        await wait(100);
        expect(delControl(despues)).toHaveLength(1);
      } finally {
        await despues.close();
      }
    });

    it('si la reconexión reemplaza al socket viejo, también le dice quién lo tiene', async () => {
      const viejo = await connectWs(srv.wsUrl, tokenDeDron(DRON.charlie));
      await viejo.waitFor((m) => m.type === 'control_released');
      expect((await api(srv.base, `/api/drones/${DRON.charlie}/control`, op, { method: 'POST' })).status).toBe(200);
      await viejo.waitFor((m) => m.type === 'control_taken');

      const nuevo = await connectWs(srv.wsUrl, tokenDeDron(DRON.charlie));
      try {
        await nuevo.waitFor((m) => m.type === 'bases');
        expect(delControl(nuevo)).toEqual([{ type: 'control_taken', by: 'operador', resync: true }]);
        expect(await titularDeCharlie()).toBe('operador');
      } finally {
        await nuevo.close();
        await viejo.close();
      }
    });

    it('la app que no tenía el control tomado lo dice (control_dropped) y el hub lo suelta, sin reanudar', async () => {
      const c = await connectWs(srv.wsUrl, tokenDeDron(DRON.charlie));
      try {
        await c.waitFor((m) => m.type === 'control_released');
        expect((await api(srv.base, `/api/drones/${DRON.charlie}/control`, op, { method: 'POST' })).status).toBe(200);
        await c.waitFor((m) => m.type === 'control_taken');
        operWs.got.length = 0;
        c.got.length = 0;

        // el aviso de un titular que ya no es el de ahora no suelta nada
        c.ws.send(JSON.stringify({ type: 'control_dropped', by: 'otro', motivo: 'viejo' }));
        c.ws.send(JSON.stringify({ type: 'control_dropped' }));
        await wait(100);
        expect(await titularDeCharlie()).toBe('operador');

        c.ws.send(JSON.stringify({ type: 'control_dropped', by: 'operador', motivo: '  la app estuvo 30 s sin el Comando Central  ' }));
        const cambio = await operWs.waitFor((m) => m.type === 'control_changed' && m.controlledBy === null);
        expect(cambio).toMatchObject({ controlledBy: null, teniaElControl: 'operador', motivo: 'app' });
        const ev = await operWs.waitFor((m) => m.type === 'event' && m.event.type === 'CONTROL_RELEASED');
        expect(JSON.parse(ev.event.meta).detalle.motivo).toBe('la app estuvo 30 s sin el Comando Central');
        expect(await c.waitFor((m) => m.type === 'control_released')).toMatchObject({ motivo: 'app' });
        await wait(100);
        expect(c.got.some((m) => m.type === 'resume_patrol')).toBe(false);

        // sin motivo, el registro dice uno genérico
        await api(srv.base, `/api/drones/${DRON.charlie}/control`, op, { method: 'POST' });
        operWs.got.length = 0;
        c.ws.send(JSON.stringify({ type: 'control_dropped', by: 'operador', motivo: 7 }));
        const ev2 = await operWs.waitFor((m) => m.type === 'event' && m.event.type === 'CONTROL_RELEASED');
        expect(JSON.parse(ev2.event.meta).detalle.motivo).toBe('la app del dron no tenía el control tomado');
      } finally {
        await c.close();
      }
    });
  });
});
