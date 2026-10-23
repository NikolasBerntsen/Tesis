import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinadorDeRelevos, PLAZOS } from '../../src/relevos';
import { createAlert, createDrone, decideAlert, getAlert, softDeleteRoute } from '../../src/store';
import { cumpleContrato } from '../contrato';
import { DRON, limpiarBase, seed } from '../helpers';

// El coordinador de relevos sin sockets: un banco con el reloj en la mano, que
// junta lo que el hub le manda a cada dron y lo que difunde a las consolas.
// Cada mensaje que sale hacia un dron se controla además contra el contrato
// (§2.b): una prueba que pasa con un mensaje roto no prueba nada.

const A = DRON.alfa;
const B = DRON.bravo;
const C = DRON.charlie;
/** Base Norte de la semilla: la de Alfa (id 1). */
const NORTE = { lat: -34.8565, lon: -56.2075 };
/** Base Sur de la semilla: la de Bravo (id 2). */
const SUR = { lat: -34.86, lon: -56.205 };
const T0 = Date.parse('2026-10-23T15:00:00.000Z');
const EN_ESPERA = { enEspera: true, disponible: true, relayId: null, rol: null, fase: null };

/** Una posición a tantos metros al norte de otra. */
function alNorte(p: { lat: number; lon: number }, metros: number) {
  return { lat: p.lat + metros / 111_320, lon: p.lon };
}

/** El objetivo que A informa en su status (§1, `target`). */
function objetivo(alertId: number, extra: Record<string, unknown> = {}) {
  return {
    alertId, type: 'VEHICLE', lat: -34.85, lon: -56.2, speedMs: 4, courseDeg: 90, moving: true, lost: false,
    lastSeenMs: 600, decision: 'PENDING', ...extra,
  };
}

class Banco {
  t = T0;
  readonly salidas: { a: string; msg: any }[] = [];
  readonly consolas: any[] = [];
  readonly conectados = new Set<string>();
  readonly coord: CoordinadorDeRelevos;

  constructor() {
    this.coord = this.nuevoCoordinador();
  }

  /** Un coordinador nuevo sobre la MISMA tabla: es lo que queda después de reiniciar el hub. */
  nuevoCoordinador(): CoordinadorDeRelevos {
    return new CoordinadorDeRelevos({
      enviar: (a, msg) => {
        if (!this.conectados.has(a)) return false;
        expect(cumpleContrato(msg), JSON.stringify(msg)).toBe(true);
        this.salidas.push({ a, msg });
        return true;
      },
      difundir: (msg) => {
        this.consolas.push(msg);
      },
      ahora: () => this.t,
      conectado: (d) => this.conectados.has(d),
    });
  }

  avanzar(ms: number) {
    this.t += ms;
  }

  conectar(...drones: string[]) {
    for (const d of drones) {
      this.conectados.add(d);
      this.coord.alConectar(d);
    }
  }

  desconectar(d: string) {
    this.conectados.delete(d);
    this.coord.alDesconectar(d);
  }

  status(d: string, s: Record<string, unknown>) {
    this.coord.alRecibirStatus(d, s);
  }

  /** Un dron en el suelo, en espera y disponible, en la posición pedida. */
  enEspera(d: string, pos = NORTE, extra: Record<string, unknown> = {}) {
    this.status(d, { state: 'IDLE', battery: 90, ...pos, alt: 0, flying: false, relevo: EN_ESPERA, ...extra });
  }

  /** A en el aire. */
  volando(d: string, extra: Record<string, unknown> = {}) {
    this.status(d, { state: 'RETURNING_HOME_BATTERY', battery: 24, lat: -34.855, lon: -56.206, alt: 40, flying: true, ...extra });
  }

  manda(d: string, msg: Record<string, unknown>) {
    return this.coord.alRecibirMensaje(d, msg);
  }

  a(d: string, tipo?: string): any[] {
    return this.salidas.filter((s) => s.a === d && (!tipo || s.msg.type === tipo)).map((s) => s.msg);
  }

  ultimo(d: string, tipo: string): any {
    return this.a(d, tipo).at(-1);
  }

  eventos(tipo?: string): any[] {
    return this.consolas.filter((m) => m.type === 'event' && (!tipo || m.event.type === tipo)).map((m) => m.event);
  }

  relevo(id: number) {
    return this.coord.listar(false).find((r) => r.id === id)!;
  }

  limpiar() {
    this.salidas.length = 0;
    this.consolas.length = 0;
  }
}

let avisos: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  limpiarBase();
  seed();
  avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  avisos.mockRestore();
});

/** A pide un relevo de patrulla de la ruta 1 hacia el nodo 2. */
function pedirPatrulla(b: Banco, ref = 'p1') {
  b.manda(A, { type: 'relay_request', ref, motivo: 'patrulla', routeId: 1, fromIndex: 2 });
  return b.ultimo(A, 'relay_status');
}

/** Bravo y Charlie en espera en la base de Alfa, Charlie con más batería. */
function dosEnEspera(b: Banco) {
  b.enEspera(B, NORTE, { battery: 80 });
  b.enEspera(C, alNorte(NORTE, 10), { battery: 95 });
}

describe('relevos — caso A: relevo de patrulla', () => {
  it('el pedido reserva en la base de A al de más batería, sin avisarle; A recibe relay_status', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.volando(A);
    dosEnEspera(b);
    const st = pedirPatrulla(b);

    expect(st).toEqual({
      type: 'relay_status', ref: 'p1', relayId: 1, estado: 'RESERVADO',
      relevo: { droneId: C, displayName: 'Charlie' }, etaS: null, motivoFin: null,
    });
    // la reserva es tentativa: B no se entera de nada
    expect(b.a(C)).toEqual([]);
    expect(b.eventos().map((e) => e.type)).toEqual(['RELAY_REQUESTED']);
    const meta = JSON.parse(b.eventos('RELAY_REQUESTED')[0].meta);
    expect(meta.detalle).toEqual({
      relevoId: 1, motivo: 'patrulla', estado: 'RESERVADO', motivoFin: null, origen: 'Alfa', relevo: 'Charlie',
      relevoHash: C, rutaId: 1, desdeNodo: 3, motivoDeB: null,
    });
    expect(b.eventos('RELAY_REQUESTED')[0]).toMatchObject({ drone_id: A, source: 'backend', alert_id: null });
    expect(b.relevo(1)).toMatchObject({ estado: 'RESERVADO', baseId: 1, routeId: 1, fromIndex: 2, venceEn: null });
    expect(b.consolas.filter((m) => m.type === 'relay_updated')).toHaveLength(1);
  });

  it('a igual batería gana el que hace más que está en espera', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.enEspera(B, NORTE, { battery: 90 });
    b.avanzar(1000);
    b.enEspera(C, alNorte(NORTE, 10), { battery: 90 });
    // seguir reportando en espera no le reinicia la cuenta a Bravo
    b.enEspera(B, NORTE, { battery: 90 });
    expect(pedirPatrulla(b).relevo.droneId).toBe(B);
  });

  it('el mismo ref no crea otro relevo, y uno nuevo se adopta en el que ya está activo', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    expect(pedirPatrulla(b, 'p1').relayId).toBe(1);
    b.limpiar();
    // reintento del mismo pedido
    expect(pedirPatrulla(b, 'p1')).toMatchObject({ ref: 'p1', relayId: 1, estado: 'RESERVADO' });
    // la app se reinició y perdió el ref: el relevo activo lo adopta
    expect(pedirPatrulla(b, 'p2')).toMatchObject({ ref: 'p2', relayId: 1 });
    // y el viejo sigue contestando por el mismo relevo
    expect(pedirPatrulla(b, 'p1')).toMatchObject({ ref: 'p1', relayId: 1 });
    expect(b.eventos()).toEqual([]);
    expect(b.coord.listar(false)).toHaveLength(1);
  });

  it('A empieza a bajar: B recibe relay_start; despega con relay_go recién con A abajo; relay_ready completa', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.volando(A);
    dosEnEspera(b);
    pedirPatrulla(b);
    b.limpiar();

    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    // prefiere al reservado
    const start = b.ultimo(C, 'relay_start');
    expect(start).toMatchObject({
      relayId: 1, motivo: 'patrulla', fromIndex: 2, de: { droneId: A, displayName: 'Alfa' },
      ruta: { id: 1, name: 'Perímetro Norte' },
    });
    expect(start.ruta.waypoints).toHaveLength(4);
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'ORDENADO', relevo: { droneId: C } });
    expect(b.relevo(1).venceEn).toBe(new Date(T0 + PLAZOS.respuestaDeBMs).toISOString());
    expect(b.eventos().map((e) => e.type)).toEqual(['RELAY_ASSIGNED']);

    b.avanzar(3000);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'EN_CAMINO' });
    // el plazo del despegue cuenta desde la orden
    expect(b.relevo(1).venceEn).toBe(new Date(T0 + PLAZOS.relevoDespegueMs).toISOString());
    expect(b.a(C, 'relay_go')).toEqual([]);

    // A todavía arriba: nada
    b.volando(A, { alt: 12 });
    expect(b.a(C, 'relay_go')).toEqual([]);
    // A a 5 m: B ya puede despegar
    b.volando(A, { alt: 5 });
    expect(b.a(C, 'relay_go')).toEqual([{ type: 'relay_go', relayId: 1 }]);
    expect(b.relevo(1).venceEn).toBeNull();
    b.volando(A, { alt: 0 });
    expect(b.a(C, 'relay_go')).toHaveLength(1);

    b.manda(C, { type: 'relay_ready', relayId: 1 });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'COMPLETADO', motivoFin: null });
    expect(b.eventos().map((e) => e.type)).toEqual(['RELAY_ASSIGNED', 'RELAY_STARTED', 'RELAY_COMPLETED']);
    expect(b.coord.listar(true)).toEqual([]);
  });

  it('landed_at_base también da el relay_go; desde RESERVADO despacha start y go juntos', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.limpiar();
    // el landing_at_base se perdió: A aterriza con B todavía reservado
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    expect(b.a(B).map((m) => m.type)).toEqual(['relay_start', 'relay_go']);
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    // ya tenía el go: no vence por despegue ni se lo repite
    expect(b.relevo(1)).toMatchObject({ estado: 'EN_CAMINO', venceEn: null });
    expect(b.a(B, 'relay_go')).toHaveLength(1);
  });

  it('con B en camino, landed_at_base manda el relay_go en el acto', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    expect(b.a(B, 'relay_go')).toEqual([]);
    b.manda(A, { type: 'landed_at_base', relayId: null, baseId: 1, lat: null, lon: null });
    expect(b.a(B, 'relay_go')).toHaveLength(1);
  });

  it('A abajo antes de que B conteste: el relay_go sale al aceptar', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    expect(b.a(B, 'relay_go')).toEqual([]);
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    expect(b.a(B, 'relay_go')).toHaveLength(1);
    expect(b.relevo(1).venceEn).toBeNull();
  });

  it('sin candidato queda SIN_RELEVO (un solo RELAY_UNAVAILABLE) y el barrido asigna cuando aparece uno', () => {
    const b = new Banco();
    b.conectar(A, B);
    expect(pedirPatrulla(b)).toMatchObject({ estado: 'SIN_RELEVO', relevo: null });
    expect(b.relevo(1).baseId).toBeNull();
    b.coord.barrer();
    b.avanzar(1000);
    b.coord.barrer();
    expect(b.eventos().map((e) => e.type)).toEqual(['RELAY_REQUESTED', 'RELAY_UNAVAILABLE']);
    expect(JSON.parse(b.eventos('RELAY_UNAVAILABLE')[0].meta).detalle).toMatchObject({ relevo: null, relevoHash: null });

    b.enEspera(B);
    b.coord.barrer();
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'RESERVADO', relevo: { droneId: B } });
  });

  it('landed_at_base con el pedido sin candidato lo vence (sin_relevo)', () => {
    const b = new Banco();
    b.conectar(A);
    pedirPatrulla(b);
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo', relevo: null });
    expect(b.eventos().at(-1).type).toBe('RELAY_CANCELLED');
  });

  it('un aterrizaje fuera de base también vence el pedido sin candidato', () => {
    const b = new Banco();
    b.conectar(A);
    pedirPatrulla(b);
    b.coord.alAterrizarFueraDeBase(B); // de otro dron: no toca nada
    expect(b.relevo(1).estado).toBe('SIN_RELEVO');
    b.coord.alAterrizarFueraDeBase(A);
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
  });

  it('no son candidatos: status viejo, no disponible, sin posición, en otra base, desconectado, ocupado o con relevo inválido', () => {
    const escenarios: [string, (b: Banco) => void][] = [
      ['status de hace más de 5 s', (b) => { b.enEspera(B); b.avanzar(PLAZOS.vigenciaStatusMs + 1); }],
      ['no disponible', (b) => b.enEspera(B, NORTE, { relevo: { ...EN_ESPERA, disponible: false } })],
      ['sin relevo informado (app vieja)', (b) => b.enEspera(B, NORTE, { relevo: undefined })],
      ['relevo inválido', (b) => b.enEspera(B, NORTE, { relevo: { ...EN_ESPERA, enEspera: false } })],
      ['sin posición', (b) => b.enEspera(B, NORTE, { lat: null, lon: null })],
      ['en otra base', (b) => b.enEspera(B, SUR)],
      ['a 50 m de la base', (b) => b.enEspera(B, alNorte(NORTE, 50.5))],
      ['desconectado', (b) => { b.enEspera(B); b.desconectar(B); }],
      ['ya pidió su propio relevo', (b) => {
        b.enEspera(B);
        b.manda(B, { type: 'relay_request', ref: 'deB', motivo: 'patrulla', routeId: 2, fromIndex: 0 });
      }],
    ];
    for (const [caso, preparar] of escenarios) {
      limpiarBase();
      seed();
      const b = new Banco();
      b.conectar(A, B);
      preparar(b);
      expect(pedirPatrulla(b, `p-${caso}`).estado, caso).toBe('SIN_RELEVO');
    }
  });

  it('A que pide desde una base se busca en ESA base, aunque tenga otra asignada', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.volando(A, { ...SUR, alt: 30 });
    b.enEspera(B, SUR);
    b.enEspera(C, NORTE);
    expect(pedirPatrulla(b).relevo.droneId).toBe(B);
    expect(b.relevo(1).baseId).toBe(2);
  });

  it('A sin base asignada y lejos de toda base: no hay dónde buscar', () => {
    const b = new Banco();
    const huerfano = createDrone({ displayName: 'Huérfano' }, 'supervisor').hash;
    b.conectar(huerfano, B);
    b.enEspera(B);
    b.manda(huerfano, { type: 'relay_request', ref: 'h', motivo: 'patrulla', routeId: 1, fromIndex: 0 });
    expect(b.ultimo(huerfano, 'relay_status').estado).toBe('SIN_RELEVO');
  });

  it('landing_at_base sin pedido previo crea el relevo y ordena en el acto', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    b.manda(A, { type: 'landing_at_base', ref: 'nuevo', relayId: null, baseId: null, lat: null, lon: null, routeId: 1, fromIndex: 3 });
    expect(b.eventos().map((e) => e.type)).toEqual(['RELAY_REQUESTED', 'RELAY_ASSIGNED']);
    expect(b.ultimo(B, 'relay_start')).toMatchObject({ relayId: 1, fromIndex: 3 });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ ref: 'nuevo', estado: 'ORDENADO' });
    // un pedido posterior con ese ref es el mismo relevo
    expect(pedirPatrulla(b, 'nuevo').relayId).toBe(1);
  });

  it('landing_at_base que encuentra el pedido por el ref, sin relayId', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b, 'p1');
    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    expect(b.ultimo(B, 'relay_start').relayId).toBe(1);
    expect(b.coord.listar(false)).toHaveLength(1);
    // repetido no ordena otra vez
    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    expect(b.a(B, 'relay_start')).toHaveLength(1);
  });

  it('landing_at_base que no corresponde se descarta', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    const malos = [
      { ref: 'x', relayId: null, baseId: 1, ...NORTE, routeId: 99, fromIndex: 0 },
      { ref: 'x', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 4 },
      { ref: 'x', relayId: 77, baseId: 1, ...NORTE, routeId: 1, fromIndex: 0 },
    ];
    for (const m of malos) b.manda(A, { type: 'landing_at_base', ...m });
    softDeleteRoute(2, 'supervisor');
    b.manda(A, { type: 'landing_at_base', ref: 'x', relayId: null, baseId: 1, ...NORTE, routeId: 2, fromIndex: 0 });
    expect(b.coord.listar(false)).toEqual([]);
    expect(b.salidas).toEqual([]);
    expect(avisos).toHaveBeenCalledTimes(4);

    // el relevo de patrulla ya terminado tampoco se reabre
    pedirPatrulla(b, 'p1');
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    b.manda(B, { type: 'relay_ready', relayId: 1 });
    b.limpiar();
    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    expect(b.salidas).toEqual([]);
  });

  it('B rechaza: se ofrece al siguiente; si rechazan todos, SIN_RELEVO con la lista de rechazados', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    dosEnEspera(b);
    pedirPatrulla(b);
    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    b.limpiar();

    b.manda(C, { type: 'relay_reject', relayId: 1, motivo: 'cancelado_en_campo', detalle: 'Cancelado desde el teléfono' });
    expect(b.ultimo(B, 'relay_start').relayId).toBe(1);
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'ORDENADO', relevo: { droneId: B } });
    const rechazo = JSON.parse(b.eventos('RELAY_REJECTED')[0].meta).detalle;
    expect(rechazo).toMatchObject({ relevoHash: C, relevo: 'Charlie', motivoDeB: 'cancelado_en_campo' });

    // un rechazo después de aceptar (el mando virtual falló en el suelo) también vale
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    b.manda(B, { type: 'relay_reject', relayId: 1, motivo: 'virtual_stick' });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'SIN_RELEVO', relevo: null });
    expect(b.relevo(1).rechazados).toEqual([C, B]);
    expect(b.eventos().map((e) => e.type)).toEqual([
      'RELAY_REJECTED', 'RELAY_ASSIGNED', 'RELAY_STARTED', 'RELAY_REJECTED', 'RELAY_UNAVAILABLE',
    ]);
    // a los que rechazaron no se les vuelve a ofrecer
    b.coord.barrer();
    expect(b.relevo(1).estado).toBe('SIN_RELEVO');
  });

  it('con A ya aterrizado, si nadie más puede, el pedido vence en vez de quedar pendiente', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    b.manda(B, { type: 'relay_reject', relayId: 1, motivo: 'no_disponible' });
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
  });

  it('sin respuesta en 10 s cuenta como rechazo: B recibe relay_cancel vencido y se prueba el siguiente', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    dosEnEspera(b);
    pedirPatrulla(b);
    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    b.avanzar(PLAZOS.respuestaDeBMs - 1);
    b.enEspera(B, NORTE, { battery: 80 });
    b.coord.barrer();
    expect(b.relevo(1).relevo?.droneId).toBe(C);
    b.avanzar(1);
    b.coord.barrer();
    expect(b.ultimo(C, 'relay_cancel')).toEqual({ type: 'relay_cancel', relayId: 1, motivo: 'vencido' });
    expect(JSON.parse(b.eventos('RELAY_REJECTED')[0].meta).detalle.motivoDeB).toBe('sin_respuesta');
    expect(b.ultimo(B, 'relay_start').relayId).toBe(1);

    // la respuesta tardía de C recibe otra vez el cancel
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    expect(b.a(C, 'relay_cancel')).toHaveLength(2);
    // el accept de B vale, y repetido no hace nada
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    expect(b.eventos('RELAY_STARTED')).toHaveLength(1);
  });

  it('un relay_accept de un relevo que no existe también recibe relay_cancel vencido', () => {
    const b = new Banco();
    b.conectar(B);
    b.manda(B, { type: 'relay_accept', relayId: 42 });
    expect(b.a(B)).toEqual([{ type: 'relay_cancel', relayId: 42, motivo: 'vencido' }]);
  });

  it('sin relay_go a los 120 s de la orden, FALLIDO sin_despegue y B recibe relay_cancel', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    b.avanzar(PLAZOS.relevoDespegueMs - 1);
    b.coord.barrer();
    expect(b.relevo(1).estado).toBe('EN_CAMINO');
    b.avanzar(1);
    b.coord.barrer();
    expect(b.relevo(1)).toMatchObject({ estado: 'FALLIDO', motivoFin: 'sin_despegue' });
    expect(b.ultimo(B, 'relay_cancel')).toMatchObject({ motivo: 'vencido' });
    expect(b.eventos().at(-1).type).toBe('RELAY_FAILED');
  });

  it('relay_status cada 5 s mientras B está en camino', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    const antes = b.a(A, 'relay_status').length;
    b.avanzar(4999);
    b.coord.barrer();
    expect(b.a(A, 'relay_status')).toHaveLength(antes);
    b.avanzar(1);
    b.coord.barrer();
    b.coord.barrer();
    expect(b.a(A, 'relay_status')).toHaveLength(antes + 1);
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ ref: 'p1', estado: 'EN_CAMINO', etaS: null });
  });

  it('relay_abort deja el relevo FALLIDO con el motivo de B', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    b.manda(B, { type: 'relay_abort', relayId: 1, motivo: 'subida', detalle: 'no llegó a 60 m en 40 s' });
    expect(b.relevo(1)).toMatchObject({ estado: 'FALLIDO', motivoFin: 'relevo_abortado' });
    expect(JSON.parse(b.eventos('RELAY_FAILED')[0].meta).detalle.motivoDeB).toBe('subida');
    // repetido, ya no corresponde
    b.manda(B, { type: 'relay_abort', relayId: 1, motivo: 'subida' });
    expect(b.eventos('RELAY_FAILED')).toHaveLength(1);
  });
});

describe('relevos — caso B: relevo de seguimiento', () => {
  /** Alerta de Alfa y Alfa siguiéndola, con el objetivo en su status. */
  function aSiguiendo(b: Banco, decision: 'PENDING' | 'VALIDATED' = 'PENDING', extraStatus: Record<string, unknown> = {}) {
    const alerta = createAlert('VEHICLE', A, -34.85, -56.2, null);
    if (decision === 'VALIDATED') decideAlert(alerta.id, 'VALIDATED', 'operador');
    b.status(A, {
      state: 'FOLLOWING', battery: 38, lat: -34.8507, lon: -56.1999, alt: 40, flying: true,
      target: objetivo(alerta.id), ...extraStatus,
    });
    return alerta.id;
  }

  function pedirSeguimiento(b: Banco, alertId: number, segundos: number | null = 400, ref = 's1') {
    b.manda(A, { type: 'relay_request', ref, motivo: 'seguimiento', alertId, segundosDisponibles: segundos });
    return b.ultimo(A, 'relay_status');
  }

  it('ordena en el acto al de menor eta, con el objetivo del status de A y la decisión de la base', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    const alertId = aSiguiendo(b);
    const statusDeA = b.t;
    b.avanzar(500);
    // Bravo en Base Sur (~1,1 km del objetivo) y Charlie en Base Este (~0,13 km)
    b.enEspera(B, SUR, { battery: 99 });
    b.enEspera(C, { lat: -34.8575, lon: -56.201 }, { battery: 70 });
    const st = pedirSeguimiento(b, alertId);

    const orden = b.ultimo(C, 'relay_tracking');
    expect(orden).toMatchObject({
      relayId: 1, alertId, decision: 'PENDING', de: { droneId: A, displayName: 'Alfa' }, ts: statusDeA,
    });
    expect(orden.objetivo).toMatchObject({ alertId, type: 'VEHICLE', lat: -34.85, lon: -56.2, decision: 'PENDING' });
    expect(orden.objetivo.vEsteMs).toBeCloseTo(4, 6);
    expect(st).toMatchObject({ ref: 's1', estado: 'ORDENADO', relevo: { droneId: C } });
    expect(st.etaS).toBeGreaterThan(30);
    expect(b.relevo(1)).toMatchObject({ motivo: 'seguimiento', alertId, baseId: 3, routeId: null });
    // el registro de un seguimiento queda encadenado a la alerta
    const ev = b.eventos('RELAY_ASSIGNED')[0];
    expect(ev.alert_id).toBe(alertId);
    expect(JSON.parse(ev.meta).alerta).toMatchObject({ id: alertId, tipo: 'VEHICLE' });
    expect(b.a(B)).toEqual([]);

    // la eta baja con el tiempo, nunca por debajo de cero
    b.avanzar(10_000);
    b.manda(A, { type: 'relay_request', ref: 's1', motivo: 'seguimiento', alertId, segundosDisponibles: 400 });
    expect(b.ultimo(A, 'relay_status').etaS).toBe(st.etaS - 10);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.avanzar(600_000);
    b.coord.barrer();
    expect(b.ultimo(A, 'relay_status').etaS).toBe(0);
  });

  it('un relevo que no llega a tiempo solo sale con la alerta validada; sin autonomía, tampoco', () => {
    for (const [decision, segundos, esperado] of [
      ['PENDING', 20, 'SIN_RELEVO'],
      ['PENDING', null, 'SIN_RELEVO'],
      ['VALIDATED', 20, 'ORDENADO'],
      ['VALIDATED', null, 'ORDENADO'],
      ['PENDING', 400, 'ORDENADO'],
    ] as const) {
      limpiarBase();
      seed();
      const b = new Banco();
      b.conectar(A, C);
      const alertId = aSiguiendo(b, decision);
      b.enEspera(C, { lat: -34.8575, lon: -56.201 });
      expect(pedirSeguimiento(b, alertId, segundos).estado, `${decision} ${segundos}`).toBe(esperado);
    }
  });

  it('a más de 1500 m del objetivo no es candidato, ni con la alerta validada', () => {
    const b = new Banco();
    b.conectar(A, B);
    const alertId = aSiguiendo(b, 'VALIDATED');
    b.enEspera(B, { lat: -34.87, lon: -56.2 }); // ~2,2 km
    expect(pedirSeguimiento(b, alertId).estado).toBe('SIN_RELEVO');
  });

  it('sin un objetivo válido de A no se puede elegir: queda pendiente hasta que llegue uno', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b, 'PENDING', { target: { ...objetivo(1), alertId: 999 } });
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    expect(pedirSeguimiento(b, alertId).estado).toBe('SIN_RELEVO');
    b.status(A, { state: 'FOLLOWING', battery: 37, lat: -34.8507, lon: -56.1999, alt: 40, target: objetivo(alertId) });
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    b.coord.barrer();
    expect(b.relevo(1).estado).toBe('ORDENADO');
  });

  it('el pedido pendiente se cae si A ya vuelve, y el que tiene B no', () => {
    const b = new Banco();
    b.conectar(A);
    const alertId = aSiguiendo(b);
    pedirSeguimiento(b, alertId);
    b.status(A, { state: 'RETURNING_HOME_BATTERY', battery: 20, lat: -34.851, lon: -56.2, alt: 40 });
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
  });

  it('no se aceptan pedidos de una alerta ajena, descartada, inexistente o con relevo de otro dron', () => {
    const b = new Banco();
    b.conectar(A, B);
    const deBravo = createAlert('PERSON', B, -34.85, -56.2, null);
    const descartada = createAlert('PERSON', A, -34.85, -56.2, null);
    decideAlert(descartada.id, 'DISMISSED', 'operador');
    for (const alertId of [deBravo.id, descartada.id, 999]) pedirSeguimiento(b, alertId, 100, `x${alertId}`);
    expect(b.salidas).toEqual([]);
    expect(b.coord.listar(false)).toEqual([]);

    // la alerta de Bravo con un relevo suyo: Alfa no puede pedir otro aunque se la pasen
    b.manda(B, { type: 'relay_request', ref: 'deB', motivo: 'seguimiento', alertId: deBravo.id, segundosDisponibles: null });
    expect(b.relevo(1).origen.droneId).toBe(B);
    b.coord['cambiarDueno'](deBravo.id, A);
    pedirSeguimiento(b, deBravo.id, 100, 'robo');
    expect(b.coord.listar(false)).toHaveLength(1);
  });

  it('un segundo pedido de seguimiento de A adopta el ref y actualiza los segundos', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    expect(pedirSeguimiento(b, alertId, 10).estado).toBe('SIN_RELEVO');
    expect(pedirSeguimiento(b, alertId, 400, 's2')).toMatchObject({ ref: 's2', relayId: 1 });
    b.coord.barrer();
    expect(b.relevo(1).estado).toBe('ORDENADO');
  });

  it('con B en camino, cada status de A sale como relay_target; sin status de A, cada 5 s sin_enlace', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b, 'VALIDATED');
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, alertId);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    expect(b.eventos().at(-1).type).toBe('RELAY_STARTED');

    b.avanzar(1000);
    b.status(A, {
      state: 'FOLLOWING', battery: 37, lat: -34.8508, lon: -56.1998, alt: 41,
      target: objetivo(alertId, { lat: -34.8506, lon: -56.1993, vNorteMs: -0.14, vEsteMs: 4 }),
    });
    const t1 = b.ultimo(C, 'relay_target');
    expect(t1).toMatchObject({
      relayId: 1, alertId, decision: 'VALIDATED', origen: 'en_linea', aLat: -34.8508, aLon: -56.1998, aAlt: 41, ts: b.t,
    });
    expect(t1.objetivo).toMatchObject({ lat: -34.8506, vNorteMs: -0.14, decision: 'VALIDATED' });

    // un objetivo que no pasa no se reenvía, pero el status de A sí sale: con
    // la posición nueva de A y el último objetivo que pasó, con SU ts
    b.status(A, { state: 'FOLLOWING', battery: 37, lat: -34.8509, lon: -56.1997, alt: 42, target: { ...objetivo(alertId), speedMs: 99 } });
    expect(b.a(C, 'relay_target')).toHaveLength(2);
    expect(b.ultimo(C, 'relay_target')).toMatchObject({
      origen: 'en_linea', aLat: -34.8509, aLon: -56.1997, aAlt: 42, ts: t1.ts, objetivo: t1.objetivo,
    });

    // A se calla: a los 5 s sin status sale la última estimación, sin_enlace
    b.avanzar(PLAZOS.aSinStatusParaSinEnlaceMs + 1);
    b.coord.barrer();
    expect(b.ultimo(C, 'relay_target')).toMatchObject({ origen: 'sin_enlace', ts: t1.ts, objetivo: t1.objetivo });
    b.avanzar(1000);
    b.coord.barrer();
    expect(b.a(C, 'relay_target')).toHaveLength(3);
    b.avanzar(PLAZOS.relayTargetSinEnlaceMs);
    b.desconectar(A);
    b.coord.barrer();
    expect(b.a(C, 'relay_target')).toHaveLength(4);
  });

  it('traspaso: la alerta pasa a B, A recibe relay_done; relay_released completa y B se entera de que A se fue', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, alertId);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.limpiar();

    b.manda(C, { type: 'relay_ready', relayId: 1 });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'TRASPASO' });
    expect(b.ultimo(A, 'relay_done')).toEqual({
      type: 'relay_done', relayId: 1, alertId, relevadoPor: { droneId: C, displayName: 'Charlie' },
    });
    expect(getAlert(alertId)?.seguidaPor).toBe(C);
    expect(b.consolas.find((m) => m.type === 'alert_updated').alert).toMatchObject({ id: alertId, seguidaPor: C });
    expect(b.eventos('RELAY_HANDOVER')).toHaveLength(1);
    expect(b.relevo(1).venceEn).toBe(new Date(b.t + PLAZOS.traspasoSinConfirmarMs).toISOString());

    // A se aleja: sus status siguen llegando a B como relay_target
    b.status(A, { state: 'FOLLOWING', battery: 33, lat: -34.851, lon: -56.2, alt: 40, target: objetivo(alertId) });
    expect(b.ultimo(C, 'relay_target').origen).toBe('en_linea');

    b.manda(A, { type: 'relay_released', relayId: 1 });
    expect(b.ultimo(C, 'relay_target').origen).toBe('retirado');
    expect(b.relevo(1)).toMatchObject({ estado: 'COMPLETADO', motivoFin: null });
    // tardío o repetido: nada
    b.manda(A, { type: 'relay_released', relayId: 1 });
    expect(b.eventos('RELAY_COMPLETED')).toHaveLength(1);
  });

  it('sin relay_released en 30 s: COMPLETADO origen_sin_confirmar, y B sigue sabiendo de A hasta que vuelve', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, alertId);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.manda(C, { type: 'relay_ready', relayId: 1 });
    b.avanzar(PLAZOS.traspasoSinConfirmarMs);
    b.coord.barrer();
    expect(b.relevo(1)).toMatchObject({ estado: 'COMPLETADO', motivoFin: 'origen_sin_confirmar' });

    b.limpiar();
    b.status(A, { state: 'FOLLOWING', battery: 30, lat: -34.851, lon: -56.2, alt: 40, target: objetivo(alertId) });
    expect(b.ultimo(C, 'relay_target').origen).toBe('en_linea');
    // A callado: sin_enlace cada 5 s
    b.avanzar(PLAZOS.aSinStatusParaSinEnlaceMs + 1);
    b.coord.barrer();
    expect(b.ultimo(C, 'relay_target').origen).toBe('sin_enlace');
    // A pasa a regreso: un último "retirado" y se termina
    b.status(A, { state: 'RETURNING_HOME_BATTERY', battery: 29, lat: -34.852, lon: -56.2, alt: 40, target: null });
    expect(b.ultimo(C, 'relay_target').origen).toBe('retirado');
    const total = b.a(C, 'relay_target').length;
    b.status(A, { state: 'RETURNING_HOME_BATTERY', battery: 29, lat: -34.853, lon: -56.2, alt: 40, target: null });
    b.avanzar(60_000);
    b.coord.barrer();
    expect(b.a(C, 'relay_target')).toHaveLength(total);
  });

  it('el seguimiento posterior se corta solo: con un relay_released tardío o a los 10 minutos', () => {
    for (const cortar of ['released', 'tiempo'] as const) {
      limpiarBase();
      seed();
      const b = new Banco();
      b.conectar(A, C);
      const alertId = aSiguiendo(b);
      b.enEspera(C, { lat: -34.8575, lon: -56.201 });
      pedirSeguimiento(b, alertId);
      b.manda(C, { type: 'relay_accept', relayId: 1 });
      b.manda(C, { type: 'relay_ready', relayId: 1 });
      b.avanzar(PLAZOS.traspasoSinConfirmarMs);
      b.coord.barrer();
      if (cortar === 'released') {
        b.manda(A, { type: 'relay_released', relayId: 1 });
        expect(b.ultimo(C, 'relay_target').origen).toBe('retirado');
      } else {
        b.avanzar(PLAZOS.seguimientoPosteriorMs);
        b.coord.barrer();
      }
      const total = b.a(C, 'relay_target').length;
      b.status(A, { state: 'FOLLOWING', battery: 30, lat: -34.851, lon: -56.2, alt: 40, target: objetivo(alertId) });
      expect(b.a(C, 'relay_target'), cortar).toHaveLength(total);
    }
  });

  it('relay_abort en el traspaso: la alerta vuelve a A', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, alertId);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.manda(C, { type: 'relay_ready', relayId: 1 });
    b.manda(C, { type: 'relay_abort', relayId: 1, motivo: 'senial' });
    expect(b.relevo(1)).toMatchObject({ estado: 'FALLIDO', motivoFin: 'relevo_abortado' });
    // A la creó: "la sigue A" es null en la columna
    expect(getAlert(alertId)?.seguidaPor).toBeNull();
    expect(b.consolas.filter((m) => m.type === 'alert_updated').at(-1).alert.seguidaPor).toBeNull();
  });

  it('A abandona con B en camino: la alerta pasa a B y B recibe "retirado"; repetido no hace nada', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, alertId);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.manda(A, { type: 'relay_abandon', relayId: 1, motivo: 'piso' });
    expect(getAlert(alertId)?.seguidaPor).toBe(C);
    expect(b.ultimo(C, 'relay_target')).toMatchObject({ origen: 'retirado' });
    expect(b.relevo(1).estado).toBe('EN_CAMINO');
    const enviados = b.salidas.length;
    b.manda(A, { type: 'relay_abandon', relayId: 1 });
    expect(b.salidas).toHaveLength(enviados);
    // los status de A que siguen llegan a B como "retirado"
    b.status(A, { state: 'FOLLOWING', battery: 20, lat: -34.851, lon: -56.2, alt: 40, target: objetivo(alertId) });
    expect(b.ultimo(C, 'relay_target').origen).toBe('retirado');
    // y si A se calla, la repetición de cada 5 s también dice "retirado", no "sin_enlace"
    const antes = b.a(C, 'relay_target').length;
    b.avanzar(PLAZOS.aSinStatusParaSinEnlaceMs + 1);
    b.coord.barrer();
    expect(b.a(C, 'relay_target')).toHaveLength(antes + 1);
    expect(b.ultimo(C, 'relay_target').origen).toBe('retirado');
  });

  it('A abandona con B sin contestar: la alerta pasa cuando acepta; si rechaza y no hay otro, origen_se_fue', () => {
    for (const respuesta of ['acepta', 'rechaza'] as const) {
      limpiarBase();
      seed();
      const b = new Banco();
      b.conectar(A, C);
      const alertId = aSiguiendo(b, 'VALIDATED');
      b.enEspera(C, { lat: -34.8575, lon: -56.201 });
      pedirSeguimiento(b, alertId);
      b.manda(A, { type: 'relay_abandon', relayId: 1, motivo: 'dji' });
      expect(getAlert(alertId)?.seguidaPor, respuesta).toBeNull();
      if (respuesta === 'acepta') {
        b.manda(C, { type: 'relay_accept', relayId: 1 });
        expect(getAlert(alertId)?.seguidaPor).toBe(C);
        expect(b.ultimo(C, 'relay_target').origen).toBe('retirado');
        // si después rechaza (antes de despegar), la alerta vuelve a A y el relevo se cae
        b.manda(C, { type: 'relay_reject', relayId: 1, motivo: 'virtual_stick' });
        expect(getAlert(alertId)?.seguidaPor).toBeNull();
      } else {
        b.manda(C, { type: 'relay_reject', relayId: 1, motivo: 'no_disponible' });
      }
      expect(b.relevo(1), respuesta).toMatchObject({ estado: 'CANCELADO', motivoFin: 'origen_se_fue' });
    }
  });

  it('A abandona sin B: CANCELADO origen_se_fue; en el traspaso ya no vale', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    pedirSeguimiento(b, alertId);
    b.manda(A, { type: 'relay_abandon', relayId: 1 });
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'origen_se_fue' });

    const otra = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, otra, 400, 's2');
    b.manda(C, { type: 'relay_accept', relayId: 2 });
    b.manda(C, { type: 'relay_ready', relayId: 2 });
    b.manda(A, { type: 'relay_abandon', relayId: 2 });
    expect(b.relevo(2).estado).toBe('TRASPASO');
    // ni un relay_abandon sobre un relevo de patrulla
    b.manda(A, { type: 'relay_request', ref: 'p', motivo: 'patrulla', routeId: 1, fromIndex: 0 });
    b.manda(A, { type: 'relay_abandon', relayId: 3 });
    expect(b.relevo(3).estado).not.toBe('CANCELADO');
  });

  it('un pedido de seguimiento le quita la reserva a uno de patrulla, que busca otro', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    // Charlie (ya en la base de Alfa) reservado para el relevo de patrulla de Bravo
    b.volando(B, { ...NORTE, alt: 30 });
    b.enEspera(C, alNorte(NORTE, 10));
    b.manda(B, { type: 'relay_request', ref: 'pb', motivo: 'patrulla', routeId: 1, fromIndex: 0 });
    expect(b.relevo(1)).toMatchObject({ estado: 'RESERVADO', relevo: { droneId: C } });

    const alertId = aSiguiendo(b, 'VALIDATED');
    pedirSeguimiento(b, alertId);
    expect(b.relevo(2)).toMatchObject({ estado: 'ORDENADO', relevo: { droneId: C } });
    expect(b.relevo(1)).toMatchObject({ estado: 'SIN_RELEVO', relevo: null });
    expect(b.ultimo(B, 'relay_status')).toMatchObject({ relayId: 1, estado: 'SIN_RELEVO' });
  });

  it('a uno ORDENADO no se le quita: el seguimiento queda sin relevo', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.volando(B, { ...NORTE, alt: 30 });
    b.enEspera(C, alNorte(NORTE, 10));
    b.manda(B, { type: 'relay_request', ref: 'pb', motivo: 'patrulla', routeId: 1, fromIndex: 0 });
    b.manda(B, { type: 'landing_at_base', ref: 'pb', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 0 });
    const alertId = aSiguiendo(b, 'VALIDATED');
    expect(pedirSeguimiento(b, alertId).estado).toBe('SIN_RELEVO');
  });

  it('una alerta descartada cancela su relevo y B recibe relay_cancel alerta_descartada', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, alertId);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.coord.alDescartarAlerta(alertId + 100); // otra alerta: nada
    expect(b.relevo(1).estado).toBe('EN_CAMINO');
    b.coord.alDescartarAlerta(alertId);
    expect(b.ultimo(C, 'relay_cancel')).toEqual({ type: 'relay_cancel', relayId: 1, motivo: 'alerta_descartada' });
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'alerta_descartada' });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'CANCELADO' });

    // sin B asignado se cancela igual, y no hay a quién avisarle
    const otra = aSiguiendo(b);
    pedirSeguimiento(b, otra, 1, 's2');
    const cancelaciones = b.a(C, 'relay_cancel').length;
    b.coord.alDescartarAlerta(otra);
    expect(b.relevo(2).motivoFin).toBe('alerta_descartada');
    expect(b.a(C, 'relay_cancel')).toHaveLength(cancelaciones);
  });

  it('un pedido por otra alerta no adopta el relevo abandonado de la anterior: es otro relevo, con su propio estado', () => {
    const b = new Banco();
    b.conectar(A, C);
    const primera = aSiguiendo(b, 'VALIDATED');
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, primera, 400, 'r1');
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    // el operador manda a A a otro lado: deja la primera, que pasa a Charlie
    b.coord.ordenDelOperador(A);
    expect(getAlert(primera)?.seguidaPor).toBe(C);

    // A sigue otro objetivo y con la batería baja pide relevo por esa alerta
    const segunda = aSiguiendo(b);
    b.limpiar();
    const st = pedirSeguimiento(b, segunda, 10, 'r2');
    // no le llega el EN_CAMINO ni la eta de un Charlie que va hacia el otro objetivo
    expect(st).toEqual({
      type: 'relay_status', ref: 'r2', relayId: 2, estado: 'SIN_RELEVO', relevo: null, etaS: null, motivoFin: null,
    });
    expect(b.relevo(2)).toMatchObject({ alertId: segunda, estado: 'SIN_RELEVO' });
    // el de la primera sigue igual, con Charlie, que no recibe nada nuevo
    expect(b.relevo(1)).toMatchObject({ alertId: primera, estado: 'EN_CAMINO', relevo: { droneId: C } });
    expect(b.a(C)).toEqual([]);
    // y un reintento por la segunda contesta por su propio relevo
    expect(pedirSeguimiento(b, segunda, 10, 'r3')).toMatchObject({ ref: 'r3', relayId: 2 });
  });

  it('pedir por otra alerta es dejar la anterior: con B en camino pasa a B, sin B se cancela, en el traspaso sigue', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    // un relevo de seguimiento de otro dron y uno de patrulla de A no se tocan
    b.manda(A, { type: 'relay_request', ref: 'pa', motivo: 'patrulla', routeId: 1, fromIndex: 0 });
    const deBravo = createAlert('PERSON', B, -34.85, -56.2, null);
    b.status(B, { state: 'ORBITING', battery: 30, lat: -34.8501, lon: -56.2, alt: 40, flying: true, target: objetivo(deBravo.id) });
    b.manda(B, { type: 'relay_request', ref: 'sb', motivo: 'seguimiento', alertId: deBravo.id, segundosDisponibles: 5 });

    const primera = aSiguiendo(b, 'VALIDATED');
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, primera, 400, 'r1');
    b.manda(C, { type: 'relay_accept', relayId: 3 });
    b.limpiar();

    // A pide por otra alerta sin haber avisado que dejó la primera
    const segunda = createAlert('PERSON', A, -34.851, -56.201, null).id;
    pedirSeguimiento(b, segunda, 10, 'r2');
    expect(getAlert(primera)?.seguidaPor).toBe(C);
    expect(b.ultimo(C, 'relay_target')).toMatchObject({ relayId: 3, origen: 'retirado' });
    expect(b.relevo(3).estado).toBe('EN_CAMINO');
    expect(b.relevo(4)).toMatchObject({ alertId: segunda, estado: 'SIN_RELEVO' });

    // el pedido sin B por la segunda se cancela al pedir por una tercera
    const tercera = createAlert('PERSON', A, -34.852, -56.202, null).id;
    pedirSeguimiento(b, tercera, 10, 'r3');
    expect(b.relevo(4)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'origen_se_fue' });
    expect(b.relevo(5)).toMatchObject({ alertId: tercera, estado: 'SIN_RELEVO' });
    expect(b.relevo(1)).toMatchObject({ motivo: 'patrulla', estado: 'SIN_RELEVO' });
    expect(b.relevo(2)).toMatchObject({ origen: { droneId: B }, estado: 'SIN_RELEVO' });

    // en el traspaso A ya está soltando: ese relevo termina solo
    b.manda(C, { type: 'relay_ready', relayId: 3 });
    const cuarta = createAlert('PERSON', A, -34.853, -56.203, null).id;
    pedirSeguimiento(b, cuarta, 10, 'r4');
    expect(b.relevo(3).estado).toBe('TRASPASO');
  });

  it('en el traspaso, cada status de A le llega a B aunque A ya no tenga objetivo: B ve a A alejarse', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, alertId);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.avanzar(1000);
    b.status(A, { state: 'ORBITING', battery: 33, lat: -34.851, lon: -56.2, alt: 40, target: objetivo(alertId) });
    const ultimo = b.ultimo(C, 'relay_target');
    b.manda(C, { type: 'relay_ready', relayId: 1 });
    b.limpiar();

    // A soltó su rastreador (status sin target) y se aleja hacia el norte, conectado
    for (let i = 1; i <= 10; i++) {
      b.avanzar(1000);
      b.status(A, { state: 'FOLLOWING', battery: 32, lat: -34.851 + i * 0.0002, lon: -56.2, alt: 40, target: null });
      b.coord.barrer();
    }
    const targets = b.a(C, 'relay_target');
    expect(targets).toHaveLength(10);
    // la posición de A es la de cada status; el objetivo y su ts, los del último que pasó
    expect(targets.map((m) => m.aLat)).toEqual(Array.from({ length: 10 }, (_, i) => -34.851 + (i + 1) * 0.0002));
    expect(targets.every((m) => m.origen === 'en_linea' && m.ts === ultimo.ts)).toBe(true);
    expect(targets.at(-1).objetivo).toEqual(ultimo.objetivo);
    // el retirado lleva el mismo ts: es el del objetivo, y B toma el origen igual (PROTOCOLS §2.b)
    b.manda(A, { type: 'relay_released', relayId: 1 });
    expect(b.ultimo(C, 'relay_target')).toMatchObject({ origen: 'retirado', ts: ultimo.ts });
  });

  it('después de un traspaso sin confirmar, los status de A sin objetivo también le llegan a B', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, alertId);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.manda(C, { type: 'relay_ready', relayId: 1 });
    b.avanzar(PLAZOS.traspasoSinConfirmarMs);
    b.coord.barrer();
    expect(b.relevo(1).motivoFin).toBe('origen_sin_confirmar');
    b.limpiar();
    b.status(A, { state: 'FOLLOWING', battery: 30, lat: -34.849, lon: -56.2, alt: 40, target: null });
    expect(b.ultimo(C, 'relay_target')).toMatchObject({ origen: 'en_linea', aLat: -34.849 });
  });

  it('el pedido pendiente también se cae con A en tierra, aunque su estado no lo diga', () => {
    const b = new Banco();
    b.conectar(A);
    const alertId = aSiguiendo(b);
    pedirSeguimiento(b, alertId);
    // un land ordenado desde la consola: MANUAL en el suelo
    b.status(A, { state: 'MANUAL', battery: 30, lat: -34.851, lon: -56.2, alt: 0, flying: false });
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
  });

  it('descartar la alerta corta el seguimiento posterior de un traspaso sin confirmar', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alertId = aSiguiendo(b);
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    pedirSeguimiento(b, alertId);
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.manda(C, { type: 'relay_ready', relayId: 1 });
    b.avanzar(PLAZOS.traspasoSinConfirmarMs);
    b.coord.barrer();
    b.coord.alDescartarAlerta(alertId);
    const total = b.a(C, 'relay_target').length;
    b.status(A, { state: 'FOLLOWING', battery: 30, lat: -34.851, lon: -56.2, alt: 40, target: objetivo(alertId) });
    expect(b.a(C, 'relay_target')).toHaveLength(total);
  });
});

describe('relevos — caso D: desvío a otra base', () => {
  it('rth_diverted deja RTH_DIVERTED una vez por destino y bloquea los despegues desde la base destino', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.manda(A, { type: 'rth_diverted', relayId: null, baseId: 2, lat: -34.859, lon: -56.2051, motivo: 'otra_base' });
    b.manda(A, { type: 'rth_diverted', relayId: null, baseId: 2, lat: -34.859, lon: -56.2051, motivo: 'otra_base' });
    const ev = b.eventos('RTH_DIVERTED');
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].meta)).toMatchObject({
      ubicacion: { lat: -34.859, lon: -56.2051, accuracyM: null },
      detalle: { motivo: 'otra_base', baseId: 2, base: 'Base Sur', relevoId: null },
    });
    expect(b.coord.baseBloqueada(2)).toBe(true);
    expect(b.coord.baseBloqueada(1)).toBe(false);

    // Charlie pide relevo desde Base Sur: Bravo está ahí pero la base está bloqueada
    b.volando(C, { ...SUR, alt: 30 });
    b.enEspera(B, SUR);
    b.manda(C, { type: 'relay_request', ref: 'pc', motivo: 'patrulla', routeId: 2, fromIndex: 0 });
    expect(b.relevo(1).estado).toBe('SIN_RELEVO');

    // A aterriza en la base 2: se levanta el bloqueo y el barrido asigna
    b.manda(A, { type: 'landed_at_base', relayId: null, baseId: 2, lat: null, lon: null });
    expect(b.coord.baseBloqueada(2)).toBe(false);
    b.enEspera(B, SUR);
    b.coord.barrer();
    expect(b.relevo(1)).toMatchObject({ estado: 'RESERVADO', relevo: { droneId: B } });
  });

  it('el bloqueo vence a los 10 minutos, y un destino nuevo es otro evento', () => {
    const b = new Banco();
    b.conectar(A);
    b.manda(A, { type: 'rth_diverted', relayId: null, baseId: 2, lat: null, lon: null, motivo: 'otra_base' });
    b.avanzar(PLAZOS.bloqueoBaseDestinoMs - 1);
    expect(b.coord.baseBloqueada(2)).toBe(true);
    b.avanzar(1);
    expect(b.coord.baseBloqueada(2)).toBe(false);
    b.manda(A, { type: 'rth_diverted', relayId: null, baseId: 3, lat: null, lon: null, motivo: 'otra_base' });
    b.manda(A, { type: 'rth_diverted', relayId: null, baseId: null, lat: null, lon: null, motivo: 'emergencia' });
    const eventos = b.eventos('RTH_DIVERTED').map((e) => JSON.parse(e.meta));
    expect(eventos.map((m) => m.detalle.base)).toEqual(['Base Sur', 'Base Este', null]);
    expect(eventos[2]).not.toHaveProperty('ubicacion');
    // aterrizar en una base distinta del destino no levanta nada, pero
    // un desvío por emergencia se cierra con cualquier aterrizaje en base
    b.manda(A, { type: 'landed_at_base', relayId: null, baseId: 1, lat: null, lon: null });
    b.manda(A, { type: 'rth_diverted', relayId: null, baseId: null, lat: null, lon: null, motivo: 'emergencia' });
    expect(b.eventos('RTH_DIVERTED')).toHaveLength(4);
  });

  it('un desvío a la misma base con el bloqueo vencido es otro desvío: se registra y la vuelve a bloquear', () => {
    const b = new Banco();
    b.conectar(A);
    const desvio = { type: 'rth_diverted', relayId: null, baseId: 2, lat: -34.857, lon: -56.2015, motivo: 'otra_base' };
    b.manda(A, desvio);
    expect(b.coord.baseBloqueada(2)).toBe(true);
    // el aterrizaje de ese vuelo nunca llegó (un land ordenado, un mensaje perdido)
    b.avanzar(3 * 3600_000);
    expect(b.coord.baseBloqueada(2)).toBe(false);
    b.manda(A, desvio);
    expect(b.coord.baseBloqueada(2)).toBe(true);
    expect(b.eventos('RTH_DIVERTED')).toHaveLength(2);
    // la repetición del mismo desvío (reconexión) no lo registra ni estira el bloqueo
    b.avanzar(PLAZOS.bloqueoBaseDestinoMs - 1);
    b.manda(A, desvio);
    expect(b.eventos('RTH_DIVERTED')).toHaveLength(2);
    b.avanzar(1);
    expect(b.coord.baseBloqueada(2)).toBe(false);
  });

  it('A en tierra cierra su desvío aunque no llegue el landed_at_base; el próximo vuelve a bloquear', () => {
    const b = new Banco();
    b.conectar(A);
    const desvio = { type: 'rth_diverted', relayId: null, baseId: 2, lat: -34.857, lon: -56.2015, motivo: 'otra_base' };
    b.manda(A, desvio);
    b.volando(A, { ...alNorte(SUR, 200), alt: 60 });
    expect(b.coord.baseBloqueada(2)).toBe(true);
    // aterriza en el punto para visitantes, con el enlace cortado justo al tocar tierra
    b.status(A, { state: 'LANDED', battery: 12, ...alNorte(SUR, 15), alt: 0, flying: false });
    expect(b.coord.baseBloqueada(2)).toBe(false);
    // otro vuelo, otro desvío a la misma base: se registra y bloquea, aunque no hayan pasado 10 minutos
    b.avanzar(60_000);
    b.volando(A, { ...alNorte(SUR, 300), alt: 60 });
    b.manda(A, desvio);
    expect(b.coord.baseBloqueada(2)).toBe(true);
    expect(b.eventos('RTH_DIVERTED')).toHaveLength(2);
  });

  it('landed_at_base sin baseId levanta el bloqueo por la posición', () => {
    const b = new Banco();
    b.conectar(A);
    b.manda(A, { type: 'rth_diverted', relayId: null, baseId: 2, lat: null, lon: null, motivo: 'otra_base' });
    b.manda(A, { type: 'landed_at_base', relayId: null, baseId: null, lat: null, lon: null });
    expect(b.coord.baseBloqueada(2)).toBe(true);
    b.manda(A, { type: 'landed_at_base', relayId: null, baseId: null, ...alNorte(SUR, 5) });
    expect(b.coord.baseBloqueada(2)).toBe(false);
  });

  it('A desviado con el relevo reservado: B sale en el acto con relay_start y relay_go', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.limpiar();
    b.manda(A, { type: 'rth_diverted', relayId: 1, baseId: 2, lat: -34.859, lon: -56.2051, motivo: 'otra_base' });
    expect(b.a(B).map((m) => m.type)).toEqual(['relay_start', 'relay_go']);
    expect(JSON.parse(b.eventos('RTH_DIVERTED')[0].meta).detalle.relevoId).toBe(1);
    // repetido al reconectar: nada nuevo
    b.manda(A, { type: 'rth_diverted', relayId: 1, baseId: 2, lat: -34.859, lon: -56.2051, motivo: 'otra_base' });
    expect(b.a(B)).toHaveLength(2);
  });

  it('A desviado con B ordenado: el go sale al aceptar; con B en camino, en el acto', () => {
    for (const momento of ['ordenado', 'en_camino'] as const) {
      limpiarBase();
      seed();
      const b = new Banco();
      b.conectar(A, B);
      b.enEspera(B);
      pedirPatrulla(b);
      b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
      if (momento === 'en_camino') b.manda(B, { type: 'relay_accept', relayId: 1 });
      b.manda(A, { type: 'rth_diverted', relayId: null, baseId: null, lat: null, lon: null, motivo: 'emergencia' });
      expect(b.a(B, 'relay_go'), momento).toHaveLength(momento === 'en_camino' ? 1 : 0);
      if (momento === 'ordenado') {
        b.manda(B, { type: 'relay_accept', relayId: 1 });
        expect(b.a(B, 'relay_go')).toHaveLength(1);
      }
    }
  });

  it('A desviado sin candidato: el pedido sigue y B sale con start y go cuando aparece', () => {
    const b = new Banco();
    b.conectar(A, B);
    pedirPatrulla(b);
    b.manda(A, { type: 'rth_diverted', relayId: 1, baseId: 3, lat: null, lon: null, motivo: 'otra_base' });
    expect(b.relevo(1).estado).toBe('SIN_RELEVO');
    b.enEspera(B);
    b.coord.barrer();
    expect(b.a(B).map((m) => m.type)).toEqual(['relay_start', 'relay_go']);
  });

  it('el relay_go espera a que se libere la base de B, y si no se libera a tiempo el relevo falla', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.volando(A, { ...SUR, alt: 30 });
    b.enEspera(B, SUR);
    b.manda(A, { type: 'relay_request', ref: 'pa', motivo: 'patrulla', routeId: 2, fromIndex: 0 });
    b.manda(A, { type: 'landing_at_base', ref: 'pa', relayId: 1, baseId: 2, ...SUR, routeId: 2, fromIndex: 0 });
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    // Charlie se desvía hacia Base Sur justo ahora
    b.manda(C, { type: 'rth_diverted', relayId: null, baseId: 2, lat: null, lon: null, motivo: 'otra_base' });
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 2, ...SUR });
    expect(b.a(B, 'relay_go')).toEqual([]);
    b.coord.barrer();
    expect(b.a(B, 'relay_go')).toEqual([]);
    // Charlie aterriza: el barrido manda el go
    b.manda(C, { type: 'landed_at_base', relayId: null, baseId: 2, lat: null, lon: null });
    b.coord.barrer();
    expect(b.a(B, 'relay_go')).toHaveLength(1);
  });

  it('un rth_diverted, landing o landed con el relevo de otro dron se descarta entero', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.manda(B, { type: 'relay_request', ref: 'pb', motivo: 'patrulla', routeId: 2, fromIndex: 0 });
    b.limpiar();
    b.manda(A, { type: 'rth_diverted', relayId: 1, baseId: 3, lat: null, lon: null, motivo: 'otra_base' });
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 3, lat: null, lon: null });
    expect(b.eventos()).toEqual([]);
    expect(b.coord.baseBloqueada(3)).toBe(false);
  });
});

describe('relevos — órdenes del operador', () => {
  it('hacia B en camino cancelan el relevo sin relay_cancel; a un B reservado se le quita la reserva', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    dosEnEspera(b);
    pedirPatrulla(b);
    expect(b.relevo(1).relevo?.droneId).toBe(C);
    b.coord.ordenDelOperador(C);
    expect(b.relevo(1)).toMatchObject({ estado: 'RESERVADO', relevo: { droneId: B } });

    b.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    expect(b.coord.participaDeUnRelevoActivo(B)).toBe(true);
    b.coord.ordenDelOperador(B);
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'orden_del_operador' });
    expect(b.a(B, 'relay_cancel')).toEqual([]);
    expect(b.coord.participaDeUnRelevoActivo(B)).toBe(false);
  });

  it('a un B reservado sin reemplazo, el pedido queda sin relevo', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.coord.ordenDelOperador(B);
    expect(b.relevo(1)).toMatchObject({ estado: 'SIN_RELEVO', relevo: null });
  });

  it('hacia A en un seguimiento cuentan como relay_abandon; en una patrulla no tocan nada', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alerta = createAlert('VEHICLE', A, -34.85, -56.2, null);
    b.status(A, { state: 'FOLLOWING', battery: 38, lat: -34.8507, lon: -56.1999, alt: 40, target: objetivo(alerta.id) });
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    b.manda(A, { type: 'relay_request', ref: 's', motivo: 'seguimiento', alertId: alerta.id, segundosDisponibles: 400 });
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    expect(b.coord.participaDeUnRelevoActivo(A)).toBe(true);
    b.coord.ordenDelOperador(A);
    expect(getAlert(alerta.id)?.seguidaPor).toBe(C);
    expect(b.relevo(1).estado).toBe('EN_CAMINO');

    b.manda(A, { type: 'relay_request', ref: 'p', motivo: 'patrulla', routeId: 1, fromIndex: 0 });
    b.coord.ordenDelOperador(A);
    expect(b.relevo(2).estado).toBe('SIN_RELEVO');
  });
});

describe('relevos — pedidos que A deja sin aviso', () => {
  /** A en tierra en su base: posado, sin volar. */
  const enTierraEnNorte = { state: 'LANDED', battery: 20, ...NORTE, alt: 0, flying: false };
  const descenso = { type: 'landing_at_base', ref: 'x1', relayId: null, baseId: 1, ...NORTE, routeId: 1, fromIndex: 1 };

  it('A abajo por altura sin landed_at_base: el pedido sin candidato vence y un B que aparece horas después no despega', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.volando(A, { ...NORTE, alt: 30 });
    b.manda(A, descenso);
    expect(b.relevo(1).estado).toBe('SIN_RELEVO');
    b.volando(A, { ...NORTE, alt: 12 });
    expect(b.relevo(1).estado).toBe('SIN_RELEVO');
    // A a 4 m, y al teléfono se le corta el enlace: el landed_at_base no llega nunca
    b.volando(A, { ...NORTE, alt: 4 });
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
    expect(b.eventos().at(-1).type).toBe('RELAY_CANCELLED');

    b.avanzar(3 * 3600_000);
    b.enEspera(B);
    b.coord.barrer();
    expect(b.a(B)).toEqual([]);
    expect(b.coord.participaDeUnRelevoActivo(B)).toBe(false);
  });

  it('A abajo por altura con un B que recién aparece: sale con start y go, como con el landed_at_base', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.volando(A, { ...NORTE, alt: 30 });
    b.manda(A, descenso);
    // Bravo queda en espera justo antes de que corra el barrido
    b.enEspera(B);
    b.volando(A, { ...NORTE, alt: 3 });
    expect(b.a(B).map((m) => m.type)).toEqual(['relay_start', 'relay_go']);
    expect(b.relevo(1).estado).toBe('ORDENADO');
  });

  it('con A abajo por altura, si B rechaza y no hay otro, el pedido vence en vez de quedar pendiente', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.manda(A, { ...descenso, ref: 'p1', relayId: 1, fromIndex: 2 });
    // en tierra cuenta igual que a 5 m o menos
    b.status(A, { ...enTierraEnNorte, alt: null });
    expect(b.a(B, 'relay_go')).toEqual([]);
    b.manda(B, { type: 'relay_reject', relayId: 1, motivo: 'no_disponible' });
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
  });

  it('A en tierra sin aviso de descenso: el pedido sin candidato vence en el acto', () => {
    // A desviado a otra base, sin B: aterriza allá y no llega su landed_at_base
    const b = new Banco();
    b.conectar(A, B);
    pedirPatrulla(b);
    b.manda(A, { type: 'rth_diverted', relayId: 1, baseId: 3, lat: null, lon: null, motivo: 'otra_base' });
    b.volando(A, { lat: -34.8575, lon: -56.201, alt: 20 });
    expect(b.relevo(1).estado).toBe('SIN_RELEVO');
    b.status(A, { state: 'LANDED', battery: 9, lat: -34.8575, lon: -56.201, alt: 0, flying: false });
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
    b.enEspera(B);
    b.coord.barrer();
    expect(b.a(B)).toEqual([]);

    // un pedido que llega con A ya en tierra vence en el primer barrido
    b.manda(A, { type: 'relay_request', ref: 'tarde', motivo: 'patrulla', routeId: 1, fromIndex: 0 });
    expect(b.relevo(2).estado).toBe('SIN_RELEVO');
    b.coord.barrer();
    expect(b.relevo(2)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
  });

  it('reservado con A en tierra: espera el landed_at_base 10 s; si llega, despacha', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.volando(A);
    b.enEspera(B);
    pedirPatrulla(b);
    // el status de A en tierra llega antes que su landed_at_base
    b.status(A, enTierraEnNorte);
    b.avanzar(PLAZOS.avisoDeAterrizajeMs - 1);
    b.status(A, enTierraEnNorte);
    b.enEspera(B);
    b.coord.barrer();
    expect(b.relevo(1).estado).toBe('RESERVADO');
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    expect(b.a(B).map((m) => m.type)).toEqual(['relay_start', 'relay_go']);
  });

  it('reservado con A en tierra y sin landed_at_base: a los 10 s vence y B queda libre', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.volando(A);
    b.enEspera(B);
    pedirPatrulla(b, 'ayer');
    expect(b.coord.participaDeUnRelevoActivo(B)).toBe(true);
    // un land ordenado desde la consola: MANUAL en el suelo, sin aviso de base
    b.status(A, { ...enTierraEnNorte, state: 'MANUAL' });
    b.avanzar(PLAZOS.avisoDeAterrizajeMs);
    b.coord.barrer();
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
    expect(b.coord.participaDeUnRelevoActivo(B)).toBe(false);
    expect(b.a(B)).toEqual([]);

    // al día siguiente, el pedido de A es otro relevo, con su ruta y su nodo
    b.avanzar(24 * 3600_000);
    b.volando(A);
    b.enEspera(B);
    expect(pedirPatrulla(b, 'hoy')).toMatchObject({ ref: 'hoy', relayId: 2, estado: 'RESERVADO' });

    // y si A vuelve a despegar antes de los 10 s, el pedido sigue
    b.status(A, { ...enTierraEnNorte, state: 'MANUAL' });
    b.avanzar(PLAZOS.avisoDeAterrizajeMs - 1);
    b.volando(A);
    b.avanzar(PLAZOS.avisoDeAterrizajeMs);
    b.enEspera(B);
    b.coord.barrer();
    expect(b.relevo(2).estado).toBe('RESERVADO');
  });

  it('un pedido nuevo toma la ruta y el nodo nuevos mientras B no sepa nada; con B avisado, no', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.volando(A);
    b.enEspera(B);
    pedirPatrulla(b, 'p1');
    b.limpiar();
    // la app se reinició y perdió el relevo: pide de nuevo, por otra ruta
    b.manda(A, { type: 'relay_request', ref: 'p2', motivo: 'patrulla', routeId: 2, fromIndex: 0 });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ ref: 'p2', relayId: 1, estado: 'RESERVADO' });
    expect(b.relevo(1)).toMatchObject({ routeId: 2, fromIndex: 0 });
    expect(b.consolas.filter((m) => m.type === 'relay_updated').at(-1).relay).toMatchObject({ routeId: 2, fromIndex: 0 });
    // el mismo tramo otra vez no le avisa nada nuevo a la consola
    const avisosALaConsola = b.consolas.length;
    b.manda(A, { type: 'relay_request', ref: 'p3', motivo: 'patrulla', routeId: 2, fromIndex: 0 });
    expect(b.consolas).toHaveLength(avisosALaConsola);

    // el descenso en la base trae el tramo de este regreso, y su ref pasa a ser el del relevo
    b.manda(A, { type: 'landing_at_base', ref: 'p4', relayId: null, baseId: 1, ...NORTE, routeId: 2, fromIndex: 1 });
    expect(b.ultimo(B, 'relay_start')).toMatchObject({ relayId: 1, ruta: { id: 2 }, fromIndex: 1 });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ ref: 'p4', estado: 'ORDENADO' });

    // con B ya avisado, un pedido nuevo no le cambia el tramo
    b.manda(A, { type: 'relay_request', ref: 'p5', motivo: 'patrulla', routeId: 1, fromIndex: 3 });
    expect(b.relevo(1)).toMatchObject({ routeId: 2, fromIndex: 1, estado: 'ORDENADO' });
    // y queda en la tabla: un coordinador nuevo (reinicio del hub) lo ve igual
    expect(b.nuevoCoordinador().listar(true)[0]).toMatchObject({ routeId: 2, fromIndex: 1 });
  });

  it('el descenso sobre un pedido sin candidato también le cambia el tramo, y sigue pendiente', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.volando(A);
    expect(pedirPatrulla(b, 'p1')).toMatchObject({ estado: 'SIN_RELEVO' });
    b.limpiar();
    b.manda(A, { type: 'landing_at_base', ref: 'p2', relayId: 1, baseId: 1, ...NORTE, routeId: 2, fromIndex: 1 });
    expect(b.relevo(1)).toMatchObject({ estado: 'SIN_RELEVO', routeId: 2, fromIndex: 1 });
    expect(b.consolas.filter((m) => m.type === 'relay_updated').at(-1).relay).toMatchObject({ routeId: 2, fromIndex: 1 });
    // un solo RELAY_UNAVAILABLE: ya estaba sin candidato
    expect(b.eventos()).toEqual([]);
    // y Bravo, si aparece antes de que A baje del todo, sale a cubrir ESE tramo
    b.enEspera(B);
    b.coord.barrer();
    expect(b.ultimo(B, 'relay_start')).toMatchObject({ relayId: 1, ruta: { id: 2 }, fromIndex: 1 });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ ref: 'p2', estado: 'ORDENADO' });
  });

  it('un pedido sin B avisado vence a los 10 minutos sin ningún status de A; mientras A reporta en el aire, sigue', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.volando(A);
    b.enEspera(B);
    pedirPatrulla(b);
    // un seguimiento de Charlie sin candidato también
    const alerta = createAlert('VEHICLE', C, -34.85, -56.2, null);
    b.status(C, { state: 'ORBITING', battery: 30, lat: -34.8501, lon: -56.2, alt: 40, flying: true, target: objetivo(alerta.id) });
    b.manda(C, { type: 'relay_request', ref: 'sc', motivo: 'seguimiento', alertId: alerta.id, segundosDisponibles: null });
    expect(b.relevo(2).estado).toBe('SIN_RELEVO');

    // A sigue volviendo (un regreso largo, con el control tomado): su pedido sigue
    for (let i = 0; i < 12; i++) {
      b.avanzar(60_000);
      b.volando(A);
    }
    b.enEspera(B);
    b.coord.barrer();
    expect(b.relevo(1).estado).toBe('RESERVADO');
    // Charlie no mandó nada en 12 minutos: su pedido venció
    expect(b.relevo(2)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });

    // A se calla: a los 10 minutos de su último status, vence
    b.avanzar(PLAZOS.pedidoSinNoticiasDeAMs - 1);
    b.enEspera(B);
    b.coord.barrer();
    expect(b.relevo(1).estado).toBe('RESERVADO');
    b.avanzar(1);
    b.enEspera(B);
    b.coord.barrer();
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
  });

  it('después de un reinicio, los 10 minutos sin noticias de A cuentan desde el arranque', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.volando(A);
    b.enEspera(B);
    pedirPatrulla(b);
    // se cae el hub y vuelve al día siguiente: A nunca vuelve a conectarse
    b.conectados.clear();
    b.avanzar(24 * 3600_000);
    const nuevo = b.nuevoCoordinador();
    nuevo.iniciar();
    b.avanzar(PLAZOS.pedidoSinNoticiasDeAMs - 1);
    nuevo.barrer();
    expect(nuevo.listar(true)).toEqual([expect.objectContaining({ id: 1, estado: 'RESERVADO' })]);
    b.avanzar(1);
    nuevo.barrer();
    expect(nuevo.listar(false)[0]).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
    expect(nuevo.participaDeUnRelevoActivo(B)).toBe(false);
  });
});

describe('relevos — reconexión y desconexión', () => {
  /** Relevo de patrulla con Bravo ya en camino y el go dado. */
  function bEnCamino(b: Banco) {
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    b.manda(B, { type: 'relay_accept', relayId: 1 });
    b.limpiar();
  }

  const relevoDeB = { enEspera: false, disponible: false, relayId: 1, rol: 'relevo', fase: 'en_camino' };

  it('B vuelve con su relayId: se le reenvía la orden y el go', () => {
    const b = new Banco();
    bEnCamino(b);
    b.desconectar(B);
    b.conectar(B);
    b.status(B, { state: 'RELEVANDO', battery: 90, ...NORTE, alt: 30, relevo: relevoDeB });
    expect(b.a(B).map((m) => m.type)).toEqual(['relay_start', 'relay_go']);
    // solo el primer status decide
    b.status(B, { state: 'RELEVANDO', battery: 90, ...NORTE, alt: 30, relevo: relevoDeB });
    expect(b.a(B)).toHaveLength(2);
  });

  it('B vuelve sin relevo en el aire: FALLIDO relevo_perdio_estado; en ORDENADO se le reenvía', () => {
    const b = new Banco();
    bEnCamino(b);
    b.desconectar(B);
    b.conectar(B);
    b.status(B, { state: 'IDLE', battery: 90, ...NORTE, alt: 30, relevo: { ...EN_ESPERA, disponible: false } });
    expect(b.relevo(1)).toMatchObject({ estado: 'FALLIDO', motivoFin: 'relevo_perdio_estado' });

    const c = new Banco();
    limpiarBase();
    seed();
    c.conectar(A, B);
    c.enEspera(B);
    pedirPatrulla(c);
    c.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    c.limpiar();
    c.conectar(B);
    c.status(B, { state: 'IDLE', battery: 90, ...NORTE, alt: 0 }); // app vieja: sin relevo es null
    expect(c.a(B).map((m) => m.type)).toEqual(['relay_start']);
  });

  it('un relevo terminado, inexistente o reasignado se cancela; A recibe su relay_status', () => {
    const b = new Banco();
    bEnCamino(b);
    b.manda(B, { type: 'relay_ready', relayId: 1 });
    b.limpiar();
    b.conectar(B);
    b.status(B, { state: 'PATROLLING', battery: 85, ...NORTE, alt: 40, relevo: relevoDeB });
    expect(b.a(B)).toEqual([{ type: 'relay_cancel', relayId: 1, motivo: 'terminado' }]);
    b.conectar(C);
    b.status(C, { state: 'IDLE', battery: 85, ...NORTE, alt: 0, relevo: { ...relevoDeB, relayId: 9 } });
    expect(b.a(C)).toEqual([{ type: 'relay_cancel', relayId: 9, motivo: 'inexistente' }]);

    // reasignado: C no contestó y el relevo pasó a otro
    limpiarBase();
    seed();
    const r = new Banco();
    r.conectar(A, B, C);
    dosEnEspera(r);
    pedirPatrulla(r);
    r.manda(A, { type: 'landing_at_base', ref: 'p1', relayId: 1, baseId: 1, ...NORTE, routeId: 1, fromIndex: 2 });
    r.avanzar(PLAZOS.respuestaDeBMs);
    r.enEspera(B, NORTE, { battery: 80 });
    r.coord.barrer();
    r.limpiar();
    r.conectar(C);
    r.status(C, { state: 'IDLE', battery: 95, ...NORTE, alt: 0, relevo: { ...relevoDeB, fase: 'cuenta_regresiva' } });
    expect(r.a(C)).toEqual([{ type: 'relay_cancel', relayId: 1, motivo: 'vencido' }]);
    // A vuelve con su relevo: relay_status
    r.conectar(A);
    r.status(A, { state: 'LANDED', battery: 20, ...NORTE, alt: 0, relevo: { ...relevoDeB, rol: 'origen', fase: 'aterrizando' } });
    expect(r.a(A)).toEqual([expect.objectContaining({ type: 'relay_status', relayId: 1, estado: 'ORDENADO' })]);
  });

  it('A vuelve en el traspaso: relay_status y relay_done', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alerta = createAlert('VEHICLE', A, -34.85, -56.2, null);
    b.status(A, { state: 'FOLLOWING', battery: 38, lat: -34.8507, lon: -56.1999, alt: 40, target: objetivo(alerta.id) });
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    b.manda(A, { type: 'relay_request', ref: 's', motivo: 'seguimiento', alertId: alerta.id, segundosDisponibles: 400 });
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.manda(C, { type: 'relay_ready', relayId: 1 });
    b.limpiar();
    b.conectar(A);
    b.status(A, { state: 'FOLLOWING', battery: 30, lat: -34.851, lon: -56.2, alt: 40, relevo: { enEspera: false, disponible: false, relayId: 1, rol: 'origen', fase: 'soltando' } });
    expect(b.a(A).map((m) => m.type)).toEqual(['relay_status', 'relay_done']);
    // y un B de seguimiento que vuelve recibe el relay_tracking otra vez
    b.conectar(C);
    b.status(C, { state: 'RELEVANDO', battery: 80, lat: -34.8503, lon: -56.1993, alt: 60, relevo: { ...relevoDeB, fase: 'traspaso' } });
    expect(b.ultimo(C, 'relay_tracking').relayId).toBe(1);
  });

  it('B desconectado más de 20 s: FALLIDO relevo_desconectado; si vuelve antes, sigue', () => {
    const b = new Banco();
    bEnCamino(b);
    b.desconectar(B);
    b.avanzar(PLAZOS.relevoDesconectadoMs);
    b.coord.barrer();
    expect(b.relevo(1).estado).toBe('EN_CAMINO');
    b.conectar(B);
    b.avanzar(PLAZOS.relevoDesconectadoMs);
    b.coord.barrer();
    expect(b.relevo(1).estado).toBe('EN_CAMINO');
    b.desconectar(B);
    b.avanzar(PLAZOS.relevoDesconectadoMs + 1);
    b.coord.barrer();
    expect(b.relevo(1)).toMatchObject({ estado: 'FALLIDO', motivoFin: 'relevo_desconectado' });
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ estado: 'FALLIDO' });
  });

  it('reinicio del hub: el relevo sigue en la tabla, el plazo de B cuenta desde el arranque', () => {
    const b = new Banco();
    bEnCamino(b);
    // se cae el hub: nadie está conectado y el coordinador nuevo solo tiene la tabla
    b.conectados.clear();
    b.avanzar(60_000);
    const nuevo = b.nuevoCoordinador();
    nuevo.iniciar();
    expect(nuevo.listar(true)).toEqual([expect.objectContaining({ id: 1, estado: 'EN_CAMINO', relevo: expect.objectContaining({ droneId: B }) })]);
    // B vuelve a tiempo y recibe su orden de nuevo
    b.conectados.add(B);
    nuevo.alConectar(B);
    nuevo.alRecibirStatus(B, { state: 'RELEVANDO', battery: 88, ...NORTE, alt: 50, relevo: relevoDeB });
    expect(b.a(B).map((m) => m.type)).toEqual(['relay_start', 'relay_go']);
    // A no vuelve; B se cae otra vez y no vuelve: falla a los 20 s
    b.conectados.delete(B);
    nuevo.alDesconectar(B);
    b.avanzar(PLAZOS.relevoDesconectadoMs + 1);
    nuevo.barrer();
    expect(nuevo.listar(true)).toEqual([]);

    // y un reinicio con B que nunca vuelve
    limpiarBase();
    seed();
    const c = new Banco();
    bEnCamino(c);
    c.conectados.clear();
    const otro = c.nuevoCoordinador();
    otro.iniciar();
    c.avanzar(PLAZOS.relevoDesconectadoMs + 1);
    otro.barrer();
    expect(otro.listar(false)[0]).toMatchObject({ estado: 'FALLIDO', motivoFin: 'relevo_desconectado' });
  });
});

describe('relevos — mensajes inválidos o que no corresponden', () => {
  it('se descartan sin contestar, sin eventos y con un aviso en el log', () => {
    const b = new Banco();
    b.conectar(A, B);
    const malos: Record<string, unknown>[] = [
      { type: 'relay_request', ref: 'x', motivo: 'rescate' },
      { type: 'relay_accept', relayId: '1' },
      { type: 'relay_reject', relayId: 1 },
      { type: 'relay_ready' },
      { type: 'relay_abort', relayId: 1 },
      { type: 'relay_abandon', relayId: -1 },
      { type: 'relay_released', relayId: 1.5 },
      { type: 'landing_at_base', ref: 'r', relayId: 1 },
      { type: 'landed_at_base', relayId: 1, baseId: 1, lat: 0, lon: 0 },
      { type: 'rth_diverted', relayId: null, baseId: null, lat: null, lon: null, motivo: 'otra_base' },
    ];
    for (const m of malos) expect(b.manda(A, m), String(m.type)).toBe(true);
    expect(b.salidas).toEqual([]);
    expect(b.consolas).toEqual([]);
    expect(avisos).toHaveBeenCalledTimes(malos.length);
    expect(String(avisos.mock.calls[0][0])).toContain(A);
    expect(String(avisos.mock.calls[0][0])).toContain('motivo');
  });

  it('bien formados pero de otro dron o en otro estado: también se descartan', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.enEspera(B);
    pedirPatrulla(b);
    b.limpiar();
    // C no es el B de este relevo; el relevo está RESERVADO, no ORDENADO
    b.manda(C, { type: 'relay_reject', relayId: 1, motivo: 'ocupado' });
    b.manda(B, { type: 'relay_reject', relayId: 1, motivo: 'ocupado' });
    b.manda(B, { type: 'relay_ready', relayId: 1 });
    b.manda(B, { type: 'relay_abort', relayId: 1, motivo: 'otro' });
    b.manda(B, { type: 'relay_released', relayId: 1 });
    b.manda(B, { type: 'relay_abandon', relayId: 1 });
    b.manda(A, { type: 'relay_released', relayId: 99 });
    expect(b.salidas).toEqual([]);
    expect(b.consolas).toEqual([]);
    // un tipo que no es de relevos no es asunto del coordinador
    expect(b.manda(A, { type: 'status' })).toBe(false);
    expect(b.manda(A, { type: 'emergency_landing' })).toBe(false);
  });

  it('relay_released fuera del traspaso no completa nada', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alerta = createAlert('VEHICLE', A, -34.85, -56.2, null);
    b.status(A, { state: 'FOLLOWING', battery: 38, lat: -34.8507, lon: -56.1999, alt: 40, target: objetivo(alerta.id) });
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    b.manda(A, { type: 'relay_request', ref: 's', motivo: 'seguimiento', alertId: alerta.id, segundosDisponibles: 400 });
    b.manda(A, { type: 'relay_released', relayId: 1 });
    expect(b.relevo(1).estado).toBe('ORDENADO');
  });
});

describe('relevos — bordes', () => {
  it('relay_request de patrulla con una ruta inexistente, eliminada o un nodo afuera se descarta', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    softDeleteRoute(2, 'supervisor');
    b.manda(A, { type: 'relay_request', ref: 'x1', motivo: 'patrulla', routeId: 99, fromIndex: 0 });
    b.manda(A, { type: 'relay_request', ref: 'x2', motivo: 'patrulla', routeId: 2, fromIndex: 0 });
    b.manda(A, { type: 'relay_request', ref: 'x3', motivo: 'patrulla', routeId: 1, fromIndex: 4 });
    expect(b.salidas).toEqual([]);
    expect(b.coord.listar(false)).toEqual([]);
    expect(avisos).toHaveBeenCalledTimes(3);
  });

  it('landed_at_base con el reservado ya ocupado y nadie más: el pedido vence', () => {
    const b = new Banco();
    b.conectar(A, B);
    b.enEspera(B);
    pedirPatrulla(b);
    b.enEspera(B, NORTE, { relevo: { ...EN_ESPERA, disponible: false } });
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    expect(b.relevo(1)).toMatchObject({ estado: 'CANCELADO', motivoFin: 'sin_relevo' });
    expect(b.a(B)).toEqual([]);
  });

  it('un desvío hacia una base que no existe se registra igual, sin nombre', () => {
    const b = new Banco();
    b.conectar(A);
    b.manda(A, { type: 'rth_diverted', relayId: null, baseId: 99, lat: null, lon: null, motivo: 'otra_base' });
    const ev = b.eventos('RTH_DIVERTED')[0];
    expect(ev.message).toContain('la base 99');
    expect(JSON.parse(ev.meta).detalle).toEqual({ motivo: 'otra_base', baseId: 99, base: null, relevoId: null });
  });

  it('una batería que no es número cuenta como cero al ordenar', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.enEspera(B, NORTE, { battery: 'llena' });
    b.enEspera(C, alNorte(NORTE, 10), { battery: 61 });
    expect(pedirPatrulla(b).relevo.droneId).toBe(C);
  });

  it('seguimiento: a igual eta gana la batería; un B fuera de toda base sale con la suya asignada o sin base', () => {
    const b = new Banco();
    const sinBase = createDrone({ displayName: 'Delta' }, 'supervisor').hash;
    b.conectar(A, B, C, sinBase);
    const alerta = createAlert('VEHICLE', A, -34.85, -56.2, null);
    b.status(A, { state: 'FOLLOWING', battery: 38, lat: -34.8507, lon: -56.1999, alt: 40, target: objetivo(alerta.id) });
    const campo = { lat: -34.852, lon: -56.2 };
    b.enEspera(B, campo, { battery: 60 });
    b.enEspera(C, campo, { battery: 70 });
    b.manda(A, { type: 'relay_request', ref: 's', motivo: 'seguimiento', alertId: alerta.id, segundosDisponibles: 400 });
    expect(b.relevo(1)).toMatchObject({ relevo: { droneId: C }, baseId: 3 });

    b.manda(C, { type: 'relay_reject', relayId: 1, motivo: 'ocupado' });
    expect(b.relevo(1)).toMatchObject({ relevo: { droneId: B }, baseId: 2 });
    b.enEspera(sinBase, campo);
    b.manda(B, { type: 'relay_reject', relayId: 1, motivo: 'ocupado' });
    expect(b.relevo(1)).toMatchObject({ relevo: { droneId: sinBase }, baseId: null });
  });

  it('B de seguimiento que vuelve sin relevo en el traspaso: FALLIDO y la alerta vuelve a A; un reservado que vuelve no cambia nada', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    const alerta = createAlert('VEHICLE', A, -34.85, -56.2, null);
    b.status(A, { state: 'FOLLOWING', battery: 38, lat: -34.8507, lon: -56.1999, alt: 40, target: objetivo(alerta.id) });
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    b.manda(A, { type: 'relay_request', ref: 's', motivo: 'seguimiento', alertId: alerta.id, segundosDisponibles: 400 });
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.manda(C, { type: 'relay_ready', relayId: 1 });
    expect(getAlert(alerta.id)?.seguidaPor).toBe(C);
    b.conectar(C);
    b.status(C, { state: 'IDLE', battery: 80, lat: -34.8503, lon: -56.1993, alt: 60 });
    expect(b.relevo(1)).toMatchObject({ estado: 'FALLIDO', motivoFin: 'relevo_perdio_estado' });
    expect(getAlert(alerta.id)?.seguidaPor).toBeNull();

    b.enEspera(B);
    pedirPatrulla(b, 'p');
    b.limpiar();
    b.conectar(B);
    b.enEspera(B);
    expect(b.relevo(2).estado).toBe('RESERVADO');
    expect(b.a(B)).toEqual([]);
  });

  it('en el traspaso, con A callado, B recibe la última estimación cada 5 s', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alerta = createAlert('VEHICLE', A, -34.85, -56.2, null);
    // A sin GPS ni altura en su último status
    b.status(A, { state: 'FOLLOWING', battery: 38, lat: null, lon: null, target: objetivo(alerta.id) });
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    b.manda(A, { type: 'relay_request', ref: 's', motivo: 'seguimiento', alertId: alerta.id, segundosDisponibles: 400 });
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.manda(C, { type: 'relay_ready', relayId: 1 });
    b.avanzar(PLAZOS.aSinStatusParaSinEnlaceMs + 1);
    b.coord.barrer();
    expect(b.ultimo(C, 'relay_target')).toMatchObject({ origen: 'sin_enlace', aLat: null, aLon: null, aAlt: null });
  });

  it('reinicio con un seguimiento en camino: el barrido avisa a A y le manda a B la estimación, aunque A no haya vuelto', () => {
    const b = new Banco();
    b.conectar(A, C);
    const alerta = createAlert('VEHICLE', A, -34.85, -56.2, null);
    b.status(A, { state: 'FOLLOWING', battery: 38, lat: -34.8507, lon: -56.1999, alt: 40, target: objetivo(alerta.id) });
    b.enEspera(C, { lat: -34.8575, lon: -56.201 });
    b.manda(A, { type: 'relay_request', ref: 's', motivo: 'seguimiento', alertId: alerta.id, segundosDisponibles: 400 });
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.limpiar();

    const nuevo = b.nuevoCoordinador();
    b.conectados.delete(A);
    nuevo.iniciar();
    nuevo.barrer();
    // sin ningún status de A desde el arranque: la estimación guardada, sin la posición de A
    expect(b.ultimo(C, 'relay_target')).toMatchObject({ origen: 'sin_enlace', aLat: null, aAlt: null, ts: T0 });
    b.conectados.add(A);
    b.avanzar(PLAZOS.relayStatusEnCaminoMs);
    nuevo.barrer();
    expect(b.ultimo(A, 'relay_status')).toMatchObject({ relayId: 1, estado: 'EN_CAMINO', ref: 's' });
  });
});

describe('relevos — lo que ve la consola', () => {
  it('listar: los activos o los últimos 100, más recientes primero, con la forma de §3', () => {
    const b = new Banco();
    b.conectar(A, B, C);
    b.enEspera(C);
    pedirPatrulla(b);
    b.manda(A, { type: 'landed_at_base', relayId: 1, baseId: 1, ...NORTE });
    b.manda(C, { type: 'relay_accept', relayId: 1 });
    b.manda(C, { type: 'relay_ready', relayId: 1 });
    b.manda(B, { type: 'relay_request', ref: 'pb', motivo: 'patrulla', routeId: 2, fromIndex: 1 });
    expect(b.coord.listar(true).map((r) => r.id)).toEqual([2]);
    const todos = b.coord.listar(false);
    expect(todos.map((r) => r.id)).toEqual([2, 1]);
    expect(Object.keys(todos[1]).sort()).toEqual([
      'actualizadoEn', 'alertId', 'baseId', 'creadoEn', 'estado', 'etaS', 'fromIndex', 'id', 'motivo', 'motivoFin',
      'origen', 'rechazados', 'relevo', 'routeId', 'venceEn',
    ]);
    expect(todos[1]).toMatchObject({
      motivo: 'patrulla', estado: 'COMPLETADO', origen: { droneId: A, displayName: 'Alfa' },
      relevo: { droneId: C, displayName: 'Charlie' }, creadoEn: new Date(T0).toISOString(),
    });
  });
});
