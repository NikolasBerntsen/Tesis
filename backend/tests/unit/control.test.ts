import { beforeEach, describe, expect, it } from 'vitest';
import { CoordinadorDelControl, PLAZOS_DEL_CONTROL } from '../../src/control';
import { DRON, limpiarBase, seed } from '../helpers';

// El coordinador del control manual sin sockets: un hub de mentira que guarda
// los locks en un mapa, anota lo que se le pide (tomar, traspasar, soltar) y
// junta lo que se difunde a las consolas, con el reloj en la mano.

const A = DRON.alfa;
const T0 = Date.parse('2026-10-24T12:00:00.000Z');

class Banco {
  t = T0;
  readonly locks = new Map<string, string>();
  readonly consolas: any[] = [];
  readonly tomas: [string, string][] = [];
  readonly traspasos: { droneId: string; de: string; a: string; motivo: string }[] = [];
  readonly soltados: [string, string][] = [];
  /** Cuentas que perdieron el permiso de pilotear. */
  readonly sinPermiso = new Set<string>();
  /** Cuentas sin ninguna consola conectada (el resto, sí). */
  readonly sinConsola = new Set<string>();
  readonly coord: CoordinadorDelControl;

  constructor() {
    this.coord = new CoordinadorDelControl({
      ahora: () => this.t,
      locks: () => this.locks.entries(),
      titular: (droneId) => this.locks.get(droneId) ?? null,
      tomar: (droneId, username) => {
        this.locks.set(droneId, username);
        this.tomas.push([droneId, username]);
        this.coord.alTomar(droneId);
      },
      traspasar: (droneId, de, a, motivo) => {
        this.locks.set(droneId, a);
        this.traspasos.push({ droneId, de, a, motivo });
      },
      soltarPorInactividad: (droneId, titular) => {
        this.locks.delete(droneId);
        this.soltados.push([droneId, titular]);
        this.coord.alSoltar(droneId, `${titular} estuvo 30 s sin dar señales`);
      },
      puedeControlar: (username) => !this.sinPermiso.has(username),
      tieneConsola: (username) => !this.sinConsola.has(username),
      difundir: (msg) => this.consolas.push(msg),
    });
  }

  /** `titular` toma el control de Alfa. */
  conTitular(titular = 'piloto') {
    expect(this.coord.pedir(A, titular)).toEqual({ resultado: 'otorgado' });
    return this;
  }

  de(tipo: string): any[] {
    return this.consolas.filter((m) => m.type === tipo);
  }

  eventos(tipo: string): any[] {
    return this.de('event').filter((m) => m.event.type === tipo).map((m) => m.event);
  }
}

beforeEach(() => {
  limpiarBase();
  seed();
});

describe('control — señales de vida del titular', () => {
  it('tomar un dron libre lo da en el acto y es la primera señal de vida', () => {
    const b = new Banco().conTitular();
    expect(b.tomas).toEqual([[A, 'piloto']]);
    b.t += PLAZOS_DEL_CONTROL.sinSenalesMs - 1;
    b.coord.barrer();
    expect(b.soltados).toEqual([]);
    b.t += 1;
    b.coord.barrer();
    expect(b.soltados).toEqual([[A, 'piloto']]);
  });

  it('el latido del titular reinicia la cuenta; el de cualquier otro no cuenta', () => {
    const b = new Banco().conTitular();
    b.t += 20_000;
    expect(b.coord.latido(A, 'otro')).toBe(false);
    expect(b.coord.latido(A, 'piloto')).toBe(true);
    b.t += PLAZOS_DEL_CONTROL.sinSenalesMs - 1;
    b.coord.barrer();
    expect(b.soltados).toEqual([]);
    // un dron sin lock no tiene titular que latir
    expect(b.coord.latido(DRON.bravo, 'piloto')).toBe(false);
  });

  it('pedir el control que ya es tuyo también es una señal de vida, sin volver a tomarlo', () => {
    const b = new Banco().conTitular();
    b.t += 20_000;
    expect(b.coord.pedir(A, 'piloto')).toEqual({ resultado: 'otorgado' });
    expect(b.tomas).toHaveLength(1);
    b.t += 20_000;
    b.coord.barrer();
    expect(b.soltados).toEqual([]);
  });

  it('un lock sin señal anotada empieza a contar desde el barrido, no se suelta en el acto', () => {
    const b = new Banco();
    b.locks.set(A, 'heredado');
    b.coord.barrer();
    expect(b.soltados).toEqual([]);
    b.t += PLAZOS_DEL_CONTROL.sinSenalesMs;
    b.coord.barrer();
    expect(b.soltados).toEqual([[A, 'heredado']]);
  });
});

describe('control — pedido de control', () => {
  it('con otro al mando queda UN pedido con 10 s, que ven las consolas y queda en el registro', () => {
    const b = new Banco().conTitular();
    const r = b.coord.pedir(A, 'relevo');
    const vista = { solicitante: 'relevo', titular: 'piloto', venceEn: '2026-10-24T12:00:10.000Z', restanteMs: 10_000 };
    expect(r).toEqual({ resultado: 'pendiente', pedido: vista });
    expect(b.de('control_request')).toEqual([{ type: 'control_request', droneId: A, ...vista }]);
    const [ev] = b.eventos('CONTROL_REQUESTED');
    expect(ev).toMatchObject({ source: 'relevo', drone_id: A });
    expect(JSON.parse(ev.meta)).toEqual({
      drone: { hash: A, displayName: 'Alfa', model: 'DJI Mini 3' },
      detalle: { solicitante: 'relevo', titular: 'piloto' },
    });

    // el plazo que le queda baja con el reloj del hub
    b.t += 4_000;
    expect(b.coord.pedidoDe(A)).toEqual({ ...vista, restanteMs: 6_000 });
    // el mismo que vuelve a pedir recibe el mismo pedido, sin otro aviso
    expect(b.coord.pedir(A, 'relevo')).toEqual({ resultado: 'pendiente', pedido: { ...vista, restanteMs: 6_000 } });
    // y otro se entera de quién se le adelantó
    expect(b.coord.pedir(A, 'tercero')).toEqual({ resultado: 'ocupado', solicitante: 'relevo' });
    expect(b.de('control_request')).toHaveLength(1);
    expect(b.coord.pedidoDe(DRON.bravo)).toBeNull();
  });

  it('ceder: el control pasa sin soltarse y el que lo recibe arranca con su cuenta de señales', () => {
    const b = new Banco().conTitular();
    b.t += 25_000;
    b.coord.pedir(A, 'relevo');
    b.t += 3_000;
    expect(b.coord.contestar(A, 'piloto', 'ceder')).toEqual({ ok: true, resultado: 'cedido' });
    expect(b.traspasos).toEqual([{ droneId: A, de: 'piloto', a: 'relevo', motivo: 'cedido' }]);
    expect(b.de('control_request_result')).toEqual([
      { type: 'control_request_result', droneId: A, solicitante: 'relevo', titular: 'piloto', resultado: 'cedido', motivo: 'piloto cedió el control' },
    ]);
    expect(b.coord.pedidoDe(A)).toBeNull();
    // el registro del traspaso lo deja el hub (CONTROL_TRANSFERRED), no un final de pedido
    expect(b.eventos('CONTROL_REQUEST_ENDED')).toEqual([]);
    // la cuenta de señales del nuevo titular arranca ahora, no cuando la tomó el anterior
    b.t += PLAZOS_DEL_CONTROL.sinSenalesMs - 1;
    b.coord.barrer();
    expect(b.soltados).toEqual([]);
  });

  it('mantener: el titular sigue, cuenta como señal de vida, y el que pidió se entera', () => {
    const b = new Banco().conTitular();
    b.t += 25_000;
    b.coord.pedir(A, 'relevo');
    b.t += 3_000;
    expect(b.coord.contestar(A, 'piloto', 'mantener')).toEqual({ ok: true, resultado: 'mantenido' });
    expect(b.locks.get(A)).toBe('piloto');
    expect(b.de('control_request_result')[0]).toMatchObject({ resultado: 'mantenido', motivo: 'piloto decidió mantener el control' });
    const [ev] = b.eventos('CONTROL_REQUEST_ENDED');
    expect(ev.source).toBe('piloto');
    expect(JSON.parse(ev.meta).detalle).toEqual({
      solicitante: 'relevo', titular: 'piloto', resultado: 'mantenido', motivo: 'piloto decidió mantener el control',
    });
    b.t += 25_000;
    b.coord.barrer();
    expect(b.soltados).toEqual([]);
  });

  it('solo contesta el titular, y solo si hay un pedido', () => {
    const b = new Banco().conTitular();
    expect(b.coord.contestar(A, 'piloto', 'ceder')).toEqual({
      ok: false, status: 409, error: 'No hay ningún pedido de control pendiente para este dron',
    });
    b.coord.pedir(A, 'relevo');
    expect(b.coord.contestar(A, 'relevo', 'ceder')).toEqual({
      ok: false, status: 403, error: 'El pedido es para piloto, que tiene el control',
    });
    expect(b.traspasos).toEqual([]);
  });

  it('sin respuesta en 10 s, el barrido le pasa el control al que lo pidió', () => {
    const b = new Banco().conTitular();
    b.coord.pedir(A, 'relevo');
    b.t += PLAZOS_DEL_CONTROL.respuestaMs - 1;
    b.coord.barrer();
    expect(b.traspasos).toEqual([]);
    b.t += 1;
    b.coord.barrer();
    expect(b.traspasos).toEqual([{ droneId: A, de: 'piloto', a: 'relevo', motivo: 'vencido' }]);
    expect(b.de('control_request_result')[0]).toMatchObject({ resultado: 'vencido', motivo: 'piloto no contestó a tiempo' });
  });

  it('una respuesta que llega con el plazo vencido cuenta como no contestada: el control pasa igual', () => {
    const b = new Banco().conTitular();
    b.coord.pedir(A, 'relevo');
    b.t += PLAZOS_DEL_CONTROL.respuestaMs;
    expect(b.coord.contestar(A, 'piloto', 'mantener')).toEqual({ ok: true, resultado: 'vencido' });
    expect(b.locks.get(A)).toBe('relevo');
  });

  it('un titular fantasma con un pedido encima entrega el dron a los 10 s, antes del barrido de señales', () => {
    const b = new Banco().conTitular();
    b.t += PLAZOS_DEL_CONTROL.sinSenalesMs - 5_000;
    b.coord.pedir(A, 'relevo');
    b.t += PLAZOS_DEL_CONTROL.respuestaMs;
    b.coord.barrer();
    // el traspaso va primero, y el nuevo titular arranca con su cuenta: nadie se suelta
    expect(b.traspasos).toHaveLength(1);
    expect(b.soltados).toEqual([]);
  });

  it('si el que pidió perdió el permiso en la espera, no recibe el dron: el pedido termina cancelado', () => {
    for (const comoTermina of ['ceder', 'vencer'] as const) {
      const b = new Banco().conTitular();
      b.coord.pedir(A, 'relevo');
      b.sinPermiso.add('relevo');
      if (comoTermina === 'ceder') {
        expect(b.coord.contestar(A, 'piloto', 'ceder')).toEqual({ ok: true, resultado: 'cancelado' });
      } else {
        b.t += PLAZOS_DEL_CONTROL.respuestaMs;
        b.coord.barrer();
      }
      expect(b.traspasos, comoTermina).toEqual([]);
      expect(b.locks.get(A)).toBe('piloto');
      expect(b.de('control_request_result')[0]).toMatchObject({
        resultado: 'cancelado', motivo: 'relevo ya no puede controlar drones',
      });
      expect(b.eventos('CONTROL_REQUEST_ENDED')[0].source).toBe('backend');
    }
  });

  it('el que pidió lo cancela; nadie más puede, y sin pedido no hay nada que cancelar', () => {
    const b = new Banco().conTitular();
    expect(b.coord.cancelar(A, 'relevo')).toEqual({
      ok: false, status: 409, error: 'No hay ningún pedido de control pendiente para este dron',
    });
    b.coord.pedir(A, 'relevo');
    expect(b.coord.cancelar(A, 'piloto')).toEqual({
      ok: false, status: 403, error: 'El pedido es de relevo: solo quien lo pidió lo puede cancelar',
    });
    expect(b.coord.cancelar(A, 'relevo')).toEqual({ ok: true, resultado: 'cancelado' });
    expect(b.de('control_request_result')[0]).toMatchObject({ resultado: 'cancelado', motivo: 'relevo canceló el pedido' });
    expect(b.coord.pedidoDe(A)).toBeNull();
  });

  it('los pedidos de una cuenta que ya no puede recibir el control se cancelan; los de otras, no', () => {
    const b = new Banco().conTitular();
    b.locks.set(DRON.bravo, 'piloto');
    b.coord.pedir(A, 'relevo');
    b.coord.pedir(DRON.bravo, 'otro');
    b.coord.cancelarPedidosDe('relevo', 'relevo se desconectó del Comando Central');
    expect(b.coord.pedidoDe(A)).toBeNull();
    expect(b.coord.pedidoDe(DRON.bravo)).not.toBeNull();
    expect(b.de('control_request_result')).toEqual([
      expect.objectContaining({ droneId: A, resultado: 'cancelado', motivo: 'relevo se desconectó del Comando Central' }),
    ]);
  });

  it('si el lock se suelta mientras espera, el pedido termina liberado: el dron no se le da solo', () => {
    const b = new Banco().conTitular();
    b.coord.pedir(A, 'relevo');
    b.locks.delete(A);
    b.coord.alSoltar(A, 'supervisor le quitó el control a piloto');
    expect(b.traspasos).toEqual([]);
    expect(b.de('control_request_result')[0]).toMatchObject({
      resultado: 'liberado', motivo: 'supervisor le quitó el control a piloto',
    });
    // y sin pedido, soltar no avisa nada
    b.coord.alSoltar(A, 'otra vez');
    expect(b.de('control_request_result')).toHaveLength(1);
  });

  it('el titular sin señales con un pedido encima se lo pasa en el acto al que lo pidió, sin esperar los 10 s', () => {
    const b = new Banco().conTitular();
    b.t += PLAZOS_DEL_CONTROL.sinSenalesMs - 5_000;
    b.coord.pedir(A, 'relevo');
    // a los 30 s de la toma el pedido todavía no venció: igual pasa, porque el
    // barrido real de 1 s soltaba el lock antes y el pedido terminaba liberado
    b.t += 5_000;
    b.coord.barrer();
    expect(b.soltados).toEqual([]);
    expect(b.traspasos).toEqual([{ droneId: A, de: 'piloto', a: 'relevo', motivo: 'vencido' }]);
    expect(b.de('control_request_result')).toEqual([
      expect.objectContaining({ resultado: 'vencido', motivo: 'piloto estuvo 30 s sin dar señales' }),
    ]);
    expect(b.coord.pedidoDe(A)).toBeNull();
    // y el que lo recibió arranca su cuenta de señales ahora
    b.t += PLAZOS_DEL_CONTROL.sinSenalesMs - 1;
    b.coord.barrer();
    expect(b.soltados).toEqual([]);
  });

  it('si el que pidió ya no puede recibirlo, el titular sin señales se suelta igual', () => {
    const b = new Banco().conTitular();
    b.t += PLAZOS_DEL_CONTROL.sinSenalesMs - 5_000;
    b.coord.pedir(A, 'relevo');
    b.sinPermiso.add('relevo');
    b.t += 5_000;
    b.coord.barrer();
    expect(b.traspasos).toEqual([]);
    expect(b.soltados).toEqual([[A, 'piloto']]);
    expect(b.de('control_request_result')).toEqual([
      expect.objectContaining({ resultado: 'cancelado', motivo: 'relevo ya no puede controlar drones' }),
    ]);
  });
});

describe('control — el que pide tiene que estar mirando', () => {
  it('sin una consola conectada no queda pedido: ni aviso al titular ni registro', () => {
    const b = new Banco().conTitular();
    b.sinConsola.add('relevo');
    expect(b.coord.pedir(A, 'relevo')).toEqual({ resultado: 'sinConsola' });
    expect(b.coord.pedidoDe(A)).toBeNull();
    expect(b.de('control_request')).toEqual([]);
    expect(b.eventos('CONTROL_REQUESTED')).toEqual([]);
    // un dron libre se da igual, como tomarlo
    b.locks.delete(A);
    expect(b.coord.pedir(A, 'relevo')).toEqual({ resultado: 'otorgado' });
  });

  it('si al resolverse ya no tiene consola, el pedido termina cancelado y el titular sigue', () => {
    for (const comoTermina of ['ceder', 'vencer'] as const) {
      const b = new Banco().conTitular();
      b.coord.pedir(A, 'relevo');
      b.sinConsola.add('relevo');
      if (comoTermina === 'ceder') {
        expect(b.coord.contestar(A, 'piloto', 'ceder')).toEqual({ ok: true, resultado: 'cancelado' });
      } else {
        b.t += PLAZOS_DEL_CONTROL.respuestaMs;
        b.coord.barrer();
      }
      expect(b.traspasos, comoTermina).toEqual([]);
      expect(b.locks.get(A)).toBe('piloto');
      expect(b.de('control_request_result')[0]).toMatchObject({
        resultado: 'cancelado', motivo: 'relevo no tiene ninguna consola conectada',
      });
    }
  });
});
