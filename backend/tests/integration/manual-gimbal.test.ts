import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  crearUsuario, seed, startServer, login, api, connectWs, mkStatus, wait, tokenDeDron, tokenHumano,
  CREDS, DRON, type TestServer, type WsClient,
} from '../helpers';
import { db } from '../../src/db';
import { takeControl } from '../../src/ws';

/**
 * Inclinación de la cámara desde la consola: `manual_gimbal` viaja por el mismo
 * socket que las palancas y pasa por los MISMOS controles (sesión, lock, ritmo,
 * cuenta, canControl y rol), así que cada control se prueba de nuevo acá en vez
 * de suponer que "ya lo cubre manual_stick". Si el handler de la cámara se
 * salteara uno, los tests de las palancas no lo notarían.
 *
 * Igual que con las palancas, todo rechazo es silencioso: se manda lo que el hub
 * tiene que descartar, se deja pasar un rato corto y después se manda uno válido
 * desde quien sí tiene el lock. Si al dron le llegó uno solo y es el válido, el
 * otro murió en el camino.
 */

/** Promesa con el código de cierre de un socket ya abierto. */
function cierreDe(c: WsClient): Promise<number> {
  return new Promise((resolve) => c.ws.once('close', (code) => resolve(code)));
}

describe('integración — inclinación de la cámara por WebSocket', () => {
  let srv: TestServer;
  let op = '';
  let adm = '';
  let sup = '';
  let oper2 = '';
  let alfa: WsClient; // el socket del dron: acá tiene que aterrizar la inclinación
  let operWs: WsClient; // consola de "operador" (con canControl)
  let oper2Ws: WsClient; // segunda consola con canControl, para disputar el lock
  let campoWs: WsClient; // consola de un operador de campo
  let sinWs: WsClient; // consola de un operador al que no se le permite volar
  let supWs: WsClient;
  let admWs: WsClient;

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;
    sup = (await login(srv.base, 'supervisor', CREDS.supervisor))!;

    const dos = await crearUsuario(srv.base, adm, { username: 'oper2', canControl: true });
    const sin = await crearUsuario(srv.base, adm, { username: 'sincontrol', canControl: false });
    oper2 = (await login(srv.base, 'oper2', dos.password))!;
    const campo = (await login(srv.base, 'campo', CREDS.campo))!;
    const sinTok = (await login(srv.base, 'sincontrol', sin.password))!;

    alfa = await connectWs(srv.wsUrl, tokenDeDron(DRON.alfa));
    operWs = await connectWs(srv.wsUrl, op);
    oper2Ws = await connectWs(srv.wsUrl, oper2);
    campoWs = await connectWs(srv.wsUrl, campo);
    sinWs = await connectWs(srv.wsUrl, sinTok);
    supWs = await connectWs(srv.wsUrl, sup);
    admWs = await connectWs(srv.wsUrl, adm);
  });

  afterAll(async () => {
    for (const c of [alfa, operWs, oper2Ws, campoWs, sinWs, supWs, admWs]) await c.close();
    await srv.close();
  });

  beforeEach(() => {
    for (const c of [alfa, operWs, oper2Ws, campoWs, sinWs, supWs, admWs]) c.got.length = 0;
  });

  // El lock es de un dron, no de un test: se suelta siempre, sin importar quién
  // lo tenga (el admin puede forzar la liberación).
  afterEach(async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, adm, {
      method: 'DELETE',
      body: JSON.stringify({ resume: 'none' }),
    });
  });

  /** Mensaje de cámara tal como lo arma la consola. */
  function camara(over: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: 'manual_gimbal', droneId: DRON.alfa, pitch: -30, ...over });
  }

  /** Mensaje de palancas, para comprobar que los dos mandos no se pisan el cupo. */
  function stick(over: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: 'manual_stick', droneId: DRON.alfa, pitch: 0, roll: 0, yaw: 0, throttle: 0, ...over });
  }

  /** Las inclinaciones que efectivamente le llegaron al dron. */
  function inclinacionesRecibidas() {
    return alfa.got.filter((m) => m.type === 'manual_gimbal');
  }

  async function tomar(token = op) {
    const toma = await api(srv.base, `/api/drones/${DRON.alfa}/control`, token, { method: 'POST' });
    expect(toma.status).toBe(200);
  }

  /** Ver la explicación del principio del archivo. */
  async function soloLlegaLaValida(rechazada: () => void, valida: () => void | Promise<void>) {
    rechazada();
    await wait(80);
    await valida();
    const m = await alfa.waitFor((x) => x.type === 'manual_gimbal');
    expect(inclinacionesRecibidas()).toHaveLength(1);
    return m;
  }

  it('el titular del control inclina la cámara y al dron le llega la inclinación con su nombre, y nada más', async () => {
    await tomar();
    operWs.ws.send(camara({ pitch: -45.5 }));
    const m = await alfa.waitFor((x) => x.type === 'manual_gimbal');
    // La forma exacta del contrato: sin el droneId (el dron ya sabe quién es) ni
    // nada que la consola haya agregado de más.
    expect(m).toEqual({ type: 'manual_gimbal', pitch: -45.5, by: 'operador' });
  });

  it('el horizonte (0) también viaja: no es un "no hay nada que mandar"', async () => {
    await tomar();
    operWs.ws.send(camara({ pitch: 0 }));
    const m = await alfa.waitFor((x) => x.type === 'manual_gimbal');
    expect(m.pitch).toBe(0);
  });

  it('la inclinación fuera de rango llega recortada a [-90, 30]', async () => {
    await tomar();
    operWs.ws.send(camara({ pitch: -120 }));
    await alfa.waitFor((x) => x.type === 'manual_gimbal' && x.pitch === -90);
    operWs.ws.send(camara({ pitch: 45 }));
    await alfa.waitFor((x) => x.type === 'manual_gimbal' && x.pitch === 30);
    // Los bordes exactos pasan tal cual
    operWs.ws.send(camara({ pitch: -90 }));
    operWs.ws.send(camara({ pitch: 30 }));
    await wait(80);
    expect(inclinacionesRecibidas().map((m) => m.pitch)).toEqual([-90, 30, -90, 30]);
  });

  it('una inclinación que no es número (texto, null, ausente, objeto) se descarta', async () => {
    await tomar();
    const basura = [{ pitch: '-30' }, { pitch: null }, { pitch: undefined }, { pitch: {} }, { pitch: [-30] }, { pitch: true }];
    for (const over of basura) operWs.ws.send(camara(over));
    await wait(120);
    expect(inclinacionesRecibidas()).toHaveLength(0);

    // El socket sigue sirviendo: una inclinación bien formada después sí se entrega
    operWs.ws.send(camara({ pitch: -12 }));
    const m = await alfa.waitFor((x) => x.type === 'manual_gimbal');
    expect(m.pitch).toBe(-12);
    expect(inclinacionesRecibidas()).toHaveLength(1);
  });

  it('sin el control tomado la inclinación no llega al dron', async () => {
    const m = await soloLlegaLaValida(
      () => operWs.ws.send(camara({ pitch: -80 })),
      async () => {
        await tomar();
        operWs.ws.send(camara({ pitch: -20 }));
      },
    );
    expect(m.pitch).toBe(-20);
  });

  it('con el control en manos de otro usuario la inclinación no llega', async () => {
    await tomar(oper2);
    const m = await soloLlegaLaValida(
      () => operWs.ws.send(camara({ pitch: -80 })),
      () => oper2Ws.ws.send(camara({ pitch: -10 })),
    );
    expect(m).toMatchObject({ pitch: -10, by: 'oper2' });
  });

  it('el lock es por dron: con el de Alfa no se le mueve la cámara a Bravo', async () => {
    const bravo = await connectWs(srv.wsUrl, tokenDeDron(DRON.bravo));
    try {
      await tomar();
      operWs.ws.send(camara({ droneId: DRON.bravo, pitch: -80 }));
      await wait(80);
      operWs.ws.send(camara({ pitch: -33 }));
      await alfa.waitFor((x) => x.type === 'manual_gimbal' && x.pitch === -33);
      expect(bravo.got.filter((m) => m.type === 'manual_gimbal')).toHaveLength(0);
    } finally {
      await bravo.close();
    }
  });

  it('una inclinación sin droneId no llega a ninguna parte', async () => {
    await tomar();
    const m = await soloLlegaLaValida(
      () => operWs.ws.send(JSON.stringify({ type: 'manual_gimbal', pitch: -80 })),
      () => operWs.ws.send(camara({ pitch: -5 })),
    );
    expect(m.pitch).toBe(-5);
  });

  it('un operador de campo no mueve la cámara, ni sin lock ni con el lock puesto', async () => {
    campoWs.ws.send(camara());
    await wait(80);
    expect(inclinacionesRecibidas()).toHaveLength(0);

    // Con el lock puesto A MANO (por la API no lo puede tomar): el rol se
    // revalida en cada mensaje, no se confía en lo que valía al abrir el socket.
    db.prepare('UPDATE users SET can_control = 1 WHERE username = ?').run('campo');
    try {
      takeControl(DRON.alfa, 'campo');
      campoWs.ws.send(camara());
      await wait(80);
      expect(inclinacionesRecibidas()).toHaveLength(0);
    } finally {
      db.prepare('UPDATE users SET can_control = 0 WHERE username = ?').run('campo');
    }
  });

  it('un operador sin canControl no mueve la cámara aunque tenga el lock', async () => {
    takeControl(DRON.alfa, 'sincontrol');
    sinWs.ws.send(camara());
    await wait(80);
    expect(inclinacionesRecibidas()).toHaveLength(0);
  });

  it('si la cuenta se da de baja con el socket abierto, la inclinación deja de pasar', async () => {
    const ef = await crearUsuario(srv.base, adm, { username: 'efimero', canControl: true });
    const tok = (await login(srv.base, 'efimero', ef.password))!;
    const efWs = await connectWs(srv.wsUrl, tok);
    try {
      await tomar(tok);
      db.prepare('UPDATE users SET deleted = 1 WHERE username = ?').run('efimero');
      efWs.ws.send(camara());
      await wait(80);
      expect(inclinacionesRecibidas()).toHaveLength(0);
    } finally {
      await efWs.close();
    }
  });

  it('el supervisor y el admin también la mueven: el mínimo es operator, no el rol exacto', async () => {
    for (const [quien, token, consola] of [
      ['supervisor', sup, supWs],
      ['admin', adm, admWs],
    ] as [string, string, WsClient][]) {
      alfa.got.length = 0;
      await tomar(token);
      consola.ws.send(camara({ pitch: -60 }));
      const m = await alfa.waitFor((x) => x.type === 'manual_gimbal');
      expect(m, quien).toMatchObject({ pitch: -60, by: quien });
      await api(srv.base, `/api/drones/${DRON.alfa}/control`, adm, {
        method: 'DELETE',
        body: JSON.stringify({ resume: 'none' }),
      });
    }
  });

  it('un rol que no está en la jerarquía no mueve la cámara: el control falla CERRADO', async () => {
    await tomar();
    db.prepare('UPDATE users SET role = ? WHERE username = ?').run('toString', 'operador');
    try {
      const m = await soloLlegaLaValida(
        () => operWs.ws.send(camara({ pitch: -80 })),
        () => {
          db.prepare('UPDATE users SET role = ? WHERE username = ?').run('operator', 'operador');
          operWs.ws.send(camara({ pitch: -15 }));
        },
      );
      expect(m.pitch).toBe(-15);
    } finally {
      db.prepare('UPDATE users SET role = ? WHERE username = ?').run('operator', 'operador');
    }
  });

  it('una sesión vencida no mueve la cámara: el socket se cierra con 4401', async () => {
    const corta = await connectWs(srv.wsUrl, tokenHumano('operador', 'operator', 2));
    const cerrado = cierreDe(corta);
    await tomar();
    await wait(2200);
    alfa.got.length = 0;

    corta.ws.send(camara({ pitch: -80 }));
    expect(await cerrado).toBe(4401);
    expect(inclinacionesRecibidas()).toHaveLength(0);
    // La otra consola del mismo usuario, con token válido, sigue mandando
    operWs.ws.send(camara({ pitch: -25 }));
    const m = await alfa.waitFor((x) => x.type === 'manual_gimbal');
    expect(m.pitch).toBe(-25);
  });

  it('un mensaje de cámara más largo que el tope se descarta sin parsearlo', async () => {
    await tomar();
    const m = await soloLlegaLaValida(
      () => operWs.ws.send(camara({ pitch: -80, relleno: 'x'.repeat(2000) })),
      () => operWs.ws.send(camara({ pitch: -40 })),
    );
    expect(m.pitch).toBe(-40);
  });

  it('la inclinación no deja entradas en el registro', async () => {
    await tomar();
    const antes = (await api(srv.base, '/api/logs?pageSize=25', adm)).body.total;
    for (let i = 0; i < 20; i += 1) operWs.ws.send(camara({ pitch: -i }));
    await alfa.waitFor((x) => x.type === 'manual_gimbal' && x.pitch === -19);
    const despues = (await api(srv.base, '/api/logs?pageSize=25', adm)).body.total;
    expect(despues).toBe(antes);
    expect(inclinacionesRecibidas()).toHaveLength(20);
  });

  it('una inundación de cámara se corta en su techo de ritmo y el socket sigue sirviendo', async () => {
    await tomar();
    // Consola aparte, para no gastarle el cupo a la que usa el resto del archivo
    const rafaga = await connectWs(srv.wsUrl, op);
    try {
      for (let i = 0; i < 400; i += 1) rafaga.ws.send(camara({ pitch: -50 }));
      await wait(300);
      const pasaron = inclinacionesRecibidas().length;
      expect(pasaron).toBeGreaterThan(0); // el balde arranca lleno
      expect(pasaron).toBeLessThan(100); // pero los 400 no pasan ni cerca

      alfa.got.length = 0;
      await wait(300);
      rafaga.ws.send(camara({ pitch: -70 }));
      const m = await alfa.waitFor((x) => x.type === 'manual_gimbal');
      expect(m.pitch).toBe(-70);
    } finally {
      await rafaga.close();
    }
  });

  it('la cámara tiene su propio cupo: una inundación de inclinaciones no le come el mando a las palancas', async () => {
    await tomar();
    const rafaga = await connectWs(srv.wsUrl, op);
    try {
      // Se agota el balde de la cámara de este socket...
      for (let i = 0; i < 400; i += 1) rafaga.ws.send(camara({ pitch: -50 }));
      await wait(300);
      expect(inclinacionesRecibidas().length).toBeLessThan(100);

      // ...y las palancas, desde el MISMO socket, salen enteras: el mensaje de
      // los cuatro ejes en cero que deja al dron estacionario no puede perderse
      // porque el operador arrastró la cámara.
      for (let i = 0; i < 30; i += 1) rafaga.ws.send(stick({ pitch: i / 100 }));
      await alfa.waitFor((x) => x.type === 'manual_stick' && x.pitch === 0.29);
      expect(alfa.got.filter((m) => m.type === 'manual_stick')).toHaveLength(30);
    } finally {
      await rafaga.close();
    }
  });

  it('y al revés: con el balde de las palancas agotado, la cámara sigue respondiendo', async () => {
    await tomar();
    const rafaga = await connectWs(srv.wsUrl, op);
    try {
      for (let i = 0; i < 400; i += 1) rafaga.ws.send(stick({ pitch: 0.5 }));
      await wait(300);
      expect(alfa.got.filter((m) => m.type === 'manual_stick').length).toBeLessThan(100);

      rafaga.ws.send(camara({ pitch: -77 }));
      const m = await alfa.waitFor((x) => x.type === 'manual_gimbal');
      expect(m.pitch).toBe(-77);
    } finally {
      await rafaga.close();
    }
  });

  it('si el dron no está conectado la inclinación se pierde sin romper nada', async () => {
    await api(srv.base, `/api/drones/${DRON.charlie}/control`, op, { method: 'POST' });
    try {
      operWs.ws.send(camara({ droneId: DRON.charlie }));
      await wait(80);
      expect(operWs.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      await api(srv.base, `/api/drones/${DRON.charlie}/control`, adm, {
        method: 'DELETE',
        body: JSON.stringify({ resume: 'none' }),
      });
    }
  });

  describe('status: la inclinación que informa la app', () => {
    it('un gimbalPitch numérico llega a las consolas tal cual, sin recortar', async () => {
      // Es lo que el gimbal dice que está haciendo, no una orden: no se toca.
      alfa.ws.send(mkStatus({ gimbalPitch: -42.5, battery: 51 }));
      const s = await operWs.waitFor((m) => m.type === 'status' && m.battery === 51);
      expect(s.gimbalPitch).toBe(-42.5);
      alfa.ws.send(mkStatus({ gimbalPitch: 0, battery: 52 }));
      expect((await operWs.waitFor((m) => m.type === 'status' && m.battery === 52)).gimbalPitch).toBe(0);
      alfa.ws.send(mkStatus({ gimbalPitch: 35, battery: 53 }));
      expect((await operWs.waitFor((m) => m.type === 'status' && m.battery === 53)).gimbalPitch).toBe(35);

      // Y queda en el último estado que guarda el hub (ficha del dron)
      const ficha = (await api(srv.base, '/api/drones', op)).body.find((d: any) => d.droneId === DRON.alfa);
      expect(ficha.lastStatus.gimbalPitch).toBe(35);
    });

    it('un gimbalPitch que no es número no viaja; uno ausente (app vieja) sigue ausente', async () => {
      const malos: unknown[] = ['-30', null, {}, [-30], true];
      for (const [i, gimbalPitch] of malos.entries()) {
        alfa.ws.send(mkStatus({ gimbalPitch, battery: 20 + i }));
        const s = await operWs.waitFor((m) => m.type === 'status' && m.battery === 20 + i);
        expect('gimbalPitch' in s, JSON.stringify(gimbalPitch)).toBe(false);
      }
      alfa.ws.send(mkStatus({ battery: 30 }));
      const vieja = await operWs.waitFor((m) => m.type === 'status' && m.battery === 30);
      expect('gimbalPitch' in vieja).toBe(false);
      // y el resto del status pasa igual
      expect(vieja).toMatchObject({ state: 'PATROLLING', heading: 120, displayName: 'Alfa' });
    });
  });
});
