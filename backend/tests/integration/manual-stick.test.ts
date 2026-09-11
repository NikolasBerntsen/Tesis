import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  crearUsuario, seed, startServer, login, api, connectWs, wait, tokenDeDron, tokenHumano,
  CREDS, DRON, type TestServer, type WsClient,
} from '../helpers';
import { db } from '../../src/db';
import { takeControl } from '../../src/ws';

/**
 * Mando virtual: el único mensaje que la consola manda HACIA el hub. Va por el
 * WebSocket que ya tiene abierto porque son ~10 mensajes por segundo mientras el
 * operador mantiene la palanca.
 *
 * Todo rechazo es silencioso, así que "no pasó nada" no se puede comprobar
 * esperando una respuesta de error: lo que se hace es mandar el mensaje que se
 * espera que el hub descarte, dejar pasar un rato corto para que lo procese, y
 * después mandar uno válido y contar cuántos `manual_stick` le llegaron al dron.
 * Si llegó uno solo y es el válido, el otro se descartó.
 */

/** Promesa con el código de cierre de un socket ya abierto. */
function cierreDe(c: WsClient): Promise<number> {
  return new Promise((resolve) => c.ws.once('close', (code) => resolve(code)));
}

describe('integración — mando virtual por WebSocket', () => {
  let srv: TestServer;
  let op = '';
  let adm = '';
  let oper2 = '';
  let alfa: WsClient; // el socket del dron: acá tiene que aterrizar el mando
  let operWs: WsClient; // consola de "operador" (con canControl)
  let oper2Ws: WsClient; // segunda consola con canControl, para disputar el lock
  let campoWs: WsClient; // consola de un operador de campo
  let sinWs: WsClient; // consola de un operador al que no se le permite volar

  beforeAll(async () => {
    seed();
    srv = await startServer();
    op = (await login(srv.base, 'operador', CREDS.operador))!;
    adm = (await login(srv.base, 'admin', CREDS.admin))!;

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
  });

  afterAll(async () => {
    for (const c of [alfa, operWs, oper2Ws, campoWs, sinWs]) await c.close();
    await srv.close();
  });

  beforeEach(() => {
    for (const c of [alfa, operWs, oper2Ws, campoWs, sinWs]) c.got.length = 0;
  });

  // El lock es de un dron, no de un test: se suelta siempre, sin importar quién
  // lo tenga (el admin puede forzar la liberación).
  afterEach(async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, adm, {
      method: 'DELETE',
      body: JSON.stringify({ resume: 'none' }),
    });
  });

  /** Mensaje de mando tal como lo arma la consola: los cuatro ejes siempre presentes. */
  function stick(over: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: 'manual_stick', droneId: DRON.alfa, pitch: 0, roll: 0, yaw: 0, throttle: 0, ...over });
  }

  /** Los `manual_stick` que efectivamente le llegaron al dron. */
  function mandosRecibidos() {
    return alfa.got.filter((m) => m.type === 'manual_stick');
  }

  /**
   * Manda un mando que el hub tiene que descartar y después uno válido desde la
   * consola que sí tiene el lock: si el dron recibe uno solo, el otro murió en
   * el camino. La espera del medio es para que el hub alcance a procesar (y
   * descartar) el primero antes de que el segundo lo pase de largo.
   */
  async function soloLlegaElValido(rechazado: () => void, valido: () => void | Promise<void>) {
    rechazado();
    await wait(80);
    await valido();
    const m = await alfa.waitFor((x) => x.type === 'manual_stick');
    expect(mandosRecibidos()).toHaveLength(1);
    return m;
  }

  it('el titular del control mueve las palancas y el mando llega al dron con su nombre', async () => {
    const toma = await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    expect(toma.status).toBe(200);

    operWs.ws.send(stick({ pitch: 0.6, roll: -0.25, yaw: 1, throttle: -0.5 }));
    const m = await alfa.waitFor((x) => x.type === 'manual_stick');
    expect(m).toMatchObject({ pitch: 0.6, roll: -0.25, yaw: 1, throttle: -0.5, by: 'operador' });
  });

  it('al soltar la palanca, el mensaje con los cuatro ejes en cero también viaja', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    // Ese último mensaje en cero es el que deja al dron estacionario: si el hub
    // lo filtrara por "no pasa nada", el dron seguiría con la última velocidad.
    operWs.ws.send(stick());
    const m = await alfa.waitFor((x) => x.type === 'manual_stick');
    expect(m).toMatchObject({ pitch: 0, roll: 0, yaw: 0, throttle: 0, by: 'operador' });
  });

  it('sin el control tomado el mando no llega al dron', async () => {
    const m = await soloLlegaElValido(
      () => operWs.ws.send(stick({ pitch: 1 })),
      async () => {
        await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
        operWs.ws.send(stick({ pitch: 0.1 }));
      },
    );
    expect(m.pitch).toBe(0.1);
  });

  it('con el control en manos de otro usuario el mando no llega', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, oper2, { method: 'POST' });
    const m = await soloLlegaElValido(
      () => operWs.ws.send(stick({ pitch: 1 })),
      () => oper2Ws.ws.send(stick({ pitch: -0.4 })),
    );
    expect(m).toMatchObject({ pitch: -0.4, by: 'oper2' });
  });

  it('el mando de un dron no se cuela en otro: el lock es por dron', async () => {
    const bravo = await connectWs(srv.wsUrl, tokenDeDron(DRON.bravo));
    try {
      await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
      // Tiene el lock de Alfa, no el de Bravo
      operWs.ws.send(stick({ droneId: DRON.bravo, pitch: 1 }));
      await wait(80);
      operWs.ws.send(stick({ pitch: 0.3 }));
      await alfa.waitFor((x) => x.type === 'manual_stick' && x.pitch === 0.3);
      expect(bravo.got.filter((m) => m.type === 'manual_stick')).toHaveLength(0);
    } finally {
      await bravo.close();
    }
  });

  it('un mando sin droneId no llega a ninguna parte', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    const m = await soloLlegaElValido(
      () => operWs.ws.send(JSON.stringify({ type: 'manual_stick', pitch: 1, roll: 0, yaw: 0, throttle: 0 })),
      () => operWs.ws.send(stick({ pitch: 0.2 })),
    );
    expect(m.pitch).toBe(0.2);
  });

  it('un operador de campo no vuela, ni sin lock ni con el lock puesto', async () => {
    // Sin el lock: muere en la primera comprobación
    campoWs.ws.send(stick({ pitch: 1 }));
    await wait(80);
    expect(mandosRecibidos()).toHaveLength(0);

    // Con el lock puesto A MANO: por la API un operador de campo no lo puede
    // tomar (ni puede tener canControl), así que el estado se fabrica acá.
    // Precisamente por eso el mando revalida el rol en cada mensaje: no confía
    // en lo que era cierto cuando el socket se abrió.
    db.prepare('UPDATE users SET can_control = 1 WHERE username = ?').run('campo');
    takeControl(DRON.alfa, 'campo');
    campoWs.ws.send(stick({ pitch: 1 }));
    await wait(80);
    expect(mandosRecibidos()).toHaveLength(0);
    db.prepare('UPDATE users SET can_control = 0 WHERE username = ?').run('campo');
  });

  it('un operador sin canControl no vuela aunque tenga el lock y el socket abierto', async () => {
    // El lock se pone a mano porque POST /control le responde 403: lo que se
    // prueba es que el permiso se relea de la base en cada mensaje de mando.
    takeControl(DRON.alfa, 'sincontrol');
    sinWs.ws.send(stick({ pitch: 1 }));
    await wait(80);
    expect(mandosRecibidos()).toHaveLength(0);
  });

  it('si la cuenta se da de baja con el socket abierto, el mando deja de pasar', async () => {
    const ef = await crearUsuario(srv.base, adm, { username: 'efimero', canControl: true });
    const tok = (await login(srv.base, 'efimero', ef.password))!;
    const efWs = await connectWs(srv.wsUrl, tok);
    try {
      await api(srv.base, `/api/drones/${DRON.alfa}/control`, tok, { method: 'POST' });
      alfa.got.length = 0;
      // Baja lógica directa en la base: por la API el borrado le cerraría el
      // socket y le soltaría el lock. Acá se deja el peor escenario posible
      // (socket vivo, lock puesto, cuenta inexistente) para ver que el mando
      // igual no sale.
      db.prepare('UPDATE users SET deleted = 1 WHERE username = ?').run('efimero');
      efWs.ws.send(stick({ pitch: 1 }));
      await wait(80);
      expect(mandosRecibidos()).toHaveLength(0);
    } finally {
      await efWs.close();
    }
  });

  it('los ejes fuera de rango llegan recortados a [-1, 1]', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    // La consola normaliza el arrastre del puntero: un 1.4 por redondeo es
    // plausible y significa "todo para adelante", no "descartame el mensaje".
    operWs.ws.send(stick({ pitch: 2, roll: -7, yaw: 1.4, throttle: -1.0001 }));
    const m = await alfa.waitFor((x) => x.type === 'manual_stick');
    expect(m).toMatchObject({ pitch: 1, roll: -1, yaw: 1, throttle: -1 });
  });

  it('un eje que no es número (texto, null, ausente o numérico en texto) descarta el mensaje', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    const basura = [
      { pitch: 'ahí' },
      { roll: null },
      { yaw: undefined }, // JSON.stringify lo borra: el eje viaja ausente
      { throttle: '0.5' }, // un número en texto tampoco: el contrato dice number
      { pitch: {} },
    ];
    for (const over of basura) operWs.ws.send(stick(over));
    await wait(120);
    expect(mandosRecibidos()).toHaveLength(0);

    // El socket sigue sirviendo: un mando bien formado después sí se entrega
    operWs.ws.send(stick({ throttle: 0.7 }));
    const m = await alfa.waitFor((x) => x.type === 'manual_stick');
    expect(m.throttle).toBe(0.7);
    expect(mandosRecibidos()).toHaveLength(1);
  });

  it('un frame que no es JSON y un type desconocido no rompen el hub', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    operWs.ws.send('esto no es json');
    operWs.ws.send(JSON.stringify({ type: 'saludo', hola: 'que tal' }));
    operWs.ws.send(JSON.stringify({ droneId: DRON.alfa, pitch: 1 })); // sin type
    await wait(120);
    expect(operWs.ws.readyState).toBe(WebSocket.OPEN);

    operWs.ws.send(stick({ yaw: -0.9 }));
    const m = await alfa.waitFor((x) => x.type === 'manual_stick');
    expect(m.yaw).toBe(-0.9);
    expect(mandosRecibidos()).toHaveLength(1);
  });

  it('el mando no deja entradas en el registro', async () => {
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    // Se cuenta DESPUÉS de tomar el control: lo que se registra es tomar y
    // soltar el mando, no cada palanca. A 10 Hz un registro por mensaje
    // inundaría el log y taparía todo lo demás.
    const antes = (await api(srv.base, '/api/logs?pageSize=25', adm)).body.total;
    for (let i = 0; i < 20; i += 1) operWs.ws.send(stick({ pitch: i / 20 }));
    await alfa.waitFor((x) => x.type === 'manual_stick' && x.pitch === 0.95);
    const despues = (await api(srv.base, '/api/logs?pageSize=25', adm)).body.total;
    expect(despues).toBe(antes);
    expect(mandosRecibidos()).toHaveLength(20);
  });

  it('una sesión vencida no vuela: el socket se cierra con 4401 y el mando se descarta', async () => {
    const corta = await connectWs(srv.wsUrl, tokenHumano('operador', 'operator', 2));
    const cerrado = cierreDe(corta);
    // El lock es del usuario, no del socket: lo toma "operador", que es quien
    // está detrás de las dos consolas abiertas.
    await api(srv.base, `/api/drones/${DRON.alfa}/control`, op, { method: 'POST' });
    await wait(2200);
    alfa.got.length = 0;

    corta.ws.send(stick({ pitch: 1 }));
    expect(await cerrado).toBe(4401);
    expect(mandosRecibidos()).toHaveLength(0);
    // La otra consola del mismo usuario, con token válido, sigue volando: el
    // lock no se perdió porque el usuario sigue conectado.
    operWs.ws.send(stick({ pitch: 0.5 }));
    const m = await alfa.waitFor((x) => x.type === 'manual_stick');
    expect(m.pitch).toBe(0.5);
    expect(mandosRecibidos()).toHaveLength(1);
  });

  it('si el dron no está conectado el mando se pierde sin romper nada', async () => {
    // Charlie existe como activo pero nunca abrió su socket
    await api(srv.base, `/api/drones/${DRON.charlie}/control`, op, { method: 'POST' });
    operWs.ws.send(stick({ droneId: DRON.charlie, pitch: 1 }));
    await wait(80);
    expect(operWs.ws.readyState).toBe(WebSocket.OPEN);
    await api(srv.base, `/api/drones/${DRON.charlie}/control`, adm, {
      method: 'DELETE',
      body: JSON.stringify({ resume: 'none' }),
    });
  });
});
