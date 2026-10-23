import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emergencias } from '../../src/emergencias';
import { cumpleContrato, ejemplos } from '../contrato';
import { DRON, limpiarBase, seed } from '../helpers';

// El protocolo de última ubicación del lado del hub, sin sockets: un reloj en
// la mano y lo que el hub le contesta al dron y les difunde a las consolas.

const A = DRON.alfa;
const B = DRON.bravo;
const T0 = Date.parse('2026-10-23T15:04:05.300Z');
const JPEG = ejemplos('app_al_hub', 'emergency_photo').validos[0].mensaje.jpegBase64 as string;

function aviso(ref = 'e1', extra: Record<string, unknown> = {}) {
  return { type: 'emergency_landing', ref, motivo: 'autonomia', lat: -34.8702, lon: -56.1902, alt: 38, bateria: 9, ts: 1_792_767_845_000, ...extra };
}

function foto(ref = 'e1', seq = 0, extra: Record<string, unknown> = {}) {
  return {
    type: 'emergency_photo', ref, seq, tipo: 'oblicua', rumbo: 270, inclinacion: -70, lat: -34.8702, lon: -56.1902,
    alt: 38, jpegBase64: JPEG, ts: 1_792_767_847_000, ...extra,
  };
}

function aterrizo(ref = 'e1', extra: Record<string, unknown> = {}) {
  return { type: 'emergency_landed', ref, lat: -34.87021, lon: -56.19018, alt: 0.2, ts: 1_792_767_870_000, ...extra };
}

class Banco {
  t = T0;
  readonly salidas: { a: string; msg: any }[] = [];
  readonly consolas: any[] = [];
  readonly aterrizados: string[] = [];
  readonly em = new Emergencias({
    enviar: (a, msg) => {
      expect(cumpleContrato(msg), JSON.stringify(msg)).toBe(true);
      this.salidas.push({ a, msg });
      return true;
    },
    difundir: (msg) => {
      this.consolas.push(msg);
    },
    ahora: () => this.t,
    alAterrizar: (d) => {
      this.aterrizados.push(d);
    },
  });

  manda(d: string, msg: Record<string, unknown>) {
    return this.em.alRecibirMensaje(d, msg);
  }

  a(d: string) {
    return this.salidas.filter((s) => s.a === d).map((s) => s.msg);
  }

  difundidos(tipo: string) {
    return this.consolas.filter((m) => m.type === tipo);
  }

  eventos(tipo: string) {
    return this.consolas.filter((m) => m.type === 'event' && m.event.type === tipo).map((m) => m.event);
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

describe('emergencias — emergency_landing', () => {
  it('abre la emergencia, deja EMERGENCY_LANDING con la meta de §7 y acusa', () => {
    const b = new Banco();
    expect(b.manda(A, aviso())).toBe(true);
    expect(b.a(A)).toEqual([{ type: 'emergency_ack', ref: 'e1', emergencyId: 1, aterrizada: false }]);
    const [ev] = b.eventos('EMERGENCY_LANDING');
    expect(ev).toMatchObject({ drone_id: A, source: 'backend', category: 'drone', alert_id: null });
    expect(JSON.parse(ev.meta)).toEqual({
      drone: { hash: A, displayName: 'Alfa', model: 'DJI Mini 3' },
      emergencia: { id: 1, motivo: 'autonomia', lat: -34.8702, lon: -56.1902, ts: new Date(T0).toISOString() },
      ubicacion: { lat: -34.8702, lon: -56.1902, accuracyM: null },
      detalle: { alt: 38, bateria: 9 },
    });
    expect(b.difundidos('emergency_updated')[0].emergencia).toEqual({
      id: 1, droneId: A, displayName: 'Alfa', motivo: 'autonomia', lat: -34.8702, lon: -56.1902, alt: 38, bateria: 9,
      ts: 1_792_767_845_000, creadaEn: new Date(T0).toISOString(), aterrizadaEn: null, aterrizajeLat: null,
      aterrizajeLon: null, aterrizajeAlt: null, recuperadaEn: null, recuperadaPor: null, fotos: 0,
    });
  });

  it('sin GPS no deja ubicación en el registro', () => {
    const b = new Banco();
    b.manda(A, aviso('e1', { motivo: 'bateria_critica_dji', lat: null, lon: null }));
    expect(JSON.parse(b.eventos('EMERGENCY_LANDING')[0].meta)).not.toHaveProperty('ubicacion');
    expect(b.em.listar(true)[0]).toMatchObject({ lat: null, lon: null, motivo: 'bateria_critica_dji' });
  });

  it('el mismo ref es la misma emergencia; un ref nuevo reutiliza la abierta sin aterrizar de menos de 30 min', () => {
    const b = new Banco();
    b.manda(A, aviso('e1'));
    b.manda(A, aviso('e1'));
    b.t += 29 * 60 * 1000;
    b.manda(A, aviso('e2'));
    expect(b.a(A).map((m) => m.emergencyId)).toEqual([1, 1, 1]);
    expect(b.eventos('EMERGENCY_LANDING')).toHaveLength(1);
    // pasados los 30 minutos, otra
    b.t += 60 * 1000 + 1;
    b.manda(A, aviso('e3'));
    expect(b.a(A).at(-1).emergencyId).toBe(2);
    // la de otro dron nunca se reutiliza
    b.manda(B, aviso('e1'));
    expect(b.a(B)[0].emergencyId).toBe(3);
  });

  it('una aterrizada o recuperada no se reutiliza, y el acuse de un reintento dice si ya aterrizó', () => {
    const b = new Banco();
    b.manda(A, aviso('e1'));
    b.manda(A, aterrizo('e1'));
    b.manda(A, aviso('e1'));
    expect(b.a(A).at(-1)).toEqual({ type: 'emergency_ack', ref: 'e1', emergencyId: 1, aterrizada: true });
    b.manda(A, aviso('e2'));
    expect(b.a(A).at(-1).emergencyId).toBe(2);
    expect(b.em.marcarRecuperada(2, 'campo').ok).toBe(true);
    b.manda(A, aviso('e3'));
    expect(b.a(A).at(-1).emergencyId).toBe(3);
  });

  it('inválido: se descarta sin acuse y con un aviso en el log', () => {
    const b = new Banco();
    for (const e of ejemplos('app_al_hub', 'emergency_landing').invalidos) b.manda(A, e.mensaje);
    expect(b.salidas).toEqual([]);
    expect(b.consolas).toEqual([]);
    expect(avisos).toHaveBeenCalledTimes(2);
    expect(b.manda(A, { type: 'relay_request' })).toBe(false);
  });
});

describe('emergencias — emergency_photo', () => {
  it('guarda la foto una vez por seq, la difunde y la acusa siempre', () => {
    const b = new Banco();
    b.manda(A, aviso());
    b.manda(A, foto('e1', 4, { tipo: 'panoramica', rumbo: 180, inclinacion: -30 }));
    expect(b.a(A).at(-1)).toEqual({ type: 'emergency_photo_ack', ref: 'e1', seq: 4 });
    expect(b.difundidos('emergency_photo')).toEqual([{
      type: 'emergency_photo', emergenciaId: 1, seq: 4, tipo: 'panoramica', rumbo: 180, inclinacion: -30,
      lat: -34.8702, lon: -56.1902, alt: 38, ts: 1_792_767_847_000, jpegBase64: JPEG,
    }]);
    expect(b.difundidos('emergency_updated').at(-1).emergencia.fotos).toBe(1);

    // repetida (aunque traiga otra cosa): no pisa la guardada ni se difunde de nuevo
    b.manda(A, foto('e1', 4, { tipo: 'cenital' }));
    expect(b.a(A).at(-1)).toEqual({ type: 'emergency_photo_ack', ref: 'e1', seq: 4 });
    expect(b.difundidos('emergency_photo')).toHaveLength(1);
    expect(b.em.detalle(1)?.fotos.map((f) => f.tipo)).toEqual(['panoramica']);

    b.manda(A, foto('e1', 0));
    expect(b.em.detalle(1)?.fotos.map((f) => f.seq)).toEqual([0, 4]);
  });

  it('una secuencia que pasa a la variante de la cámara guarda todas: 0 y 1 con control, 6 y 7 sin él', () => {
    const b = new Banco();
    b.manda(A, aviso());
    b.manda(A, foto('e1', 0));
    b.manda(A, foto('e1', 1, { tipo: 'cenital', inclinacion: -90 }));
    // el DJI tomó el vuelo: la misma emergencia sigue con la cámara, en sus propios números
    b.manda(A, foto('e1', 6, { tipo: 'cenital', inclinacion: -90 }));
    b.manda(A, foto('e1', 7, { tipo: 'panoramica', inclinacion: -30 }));
    expect(b.a(A).filter((m) => m.type === 'emergency_photo_ack').map((m) => m.seq)).toEqual([0, 1, 6, 7]);
    expect(b.em.detalle(1)?.fotos.map((f) => [f.seq, f.tipo])).toEqual([
      [0, 'oblicua'], [1, 'cenital'], [6, 'cenital'], [7, 'panoramica'],
    ]);
    expect(b.difundidos('emergency_photo')).toHaveLength(4);
  });

  it('con un ref desconocido no hay acuse: la app la reintenta hasta que llegue su aviso', () => {
    const b = new Banco();
    b.manda(A, foto('nadie', 0));
    b.manda(A, aterrizo('nadie'));
    // el ref es por dron: el de Alfa no le sirve a Bravo
    b.manda(A, aviso('e1'));
    b.manda(B, foto('e1', 0));
    expect(b.a(B)).toEqual([]);
    expect(avisos).toHaveBeenCalledTimes(3);
  });

  it('inválida: los ejemplos del contrato se descartan sin acuse', () => {
    const b = new Banco();
    b.manda(A, aviso('9f8e7d6c-5b4a-4392-8172-6a5b4c3d2e1f'));
    for (const e of ejemplos('app_al_hub', 'emergency_photo').invalidos) b.manda(A, e.mensaje);
    expect(b.a(A).filter((m) => m.type === 'emergency_photo_ack')).toEqual([]);
  });
});

describe('emergencias — emergency_landed', () => {
  it('registra el aterrizaje una sola vez, avisa al coordinador y acusa con aterrizada', () => {
    const b = new Banco();
    b.manda(A, aviso());
    b.t += 25_000;
    b.manda(A, aterrizo());
    expect(b.a(A).at(-1)).toEqual({ type: 'emergency_ack', ref: 'e1', emergencyId: 1, aterrizada: true });
    expect(b.aterrizados).toEqual([A]);
    const [ev] = b.eventos('EMERGENCY_LANDED');
    expect(JSON.parse(ev.meta)).toMatchObject({
      emergencia: { id: 1, motivo: 'autonomia', ts: new Date(T0).toISOString() },
      ubicacion: { lat: -34.87021, lon: -56.19018, accuracyM: null },
      detalle: { alt: 0.2 },
    });
    expect(b.em.listar(true)[0]).toMatchObject({
      aterrizadaEn: new Date(T0 + 25_000).toISOString(), aterrizajeLat: -34.87021, aterrizajeLon: -56.19018, aterrizajeAlt: 0.2,
    });

    // repetido: acuse igual, nada más
    b.t += 5000;
    b.manda(A, aterrizo('e1', { lat: null, lon: null }));
    expect(b.a(A).at(-1).aterrizada).toBe(true);
    expect(b.eventos('EMERGENCY_LANDED')).toHaveLength(1);
    expect(b.aterrizados).toEqual([A]);
    expect(b.em.listar(true)[0].aterrizadaEn).toBe(new Date(T0 + 25_000).toISOString());
  });

  it('sin la última posición, el evento sale sin ubicación', () => {
    const b = new Banco();
    b.manda(A, aviso());
    b.manda(A, aterrizo('e1', { lat: null, lon: null }));
    expect(JSON.parse(b.eventos('EMERGENCY_LANDED')[0].meta)).not.toHaveProperty('ubicacion');
  });
});

describe('emergencias — consulta y recuperación', () => {
  it('listar abiertas o las últimas 100, más recientes primero; detalle con fotos; recuperar una sola vez', () => {
    const b = new Banco();
    b.manda(A, aviso('e1'));
    b.manda(B, aviso('e2'));
    expect(b.em.listar(true).map((e) => e.id)).toEqual([2, 1]);
    expect(b.em.detalle(99)).toBeUndefined();

    b.t += 60_000;
    const r = b.em.marcarRecuperada(1, 'campo');
    expect(r).toMatchObject({ ok: true, emergencia: { id: 1, recuperadaPor: 'campo', recuperadaEn: new Date(b.t).toISOString() } });
    expect(b.em.marcarRecuperada(1, 'campo')).toEqual({ ok: false, status: 409 });
    expect(b.em.marcarRecuperada(77, 'campo')).toEqual({ ok: false, status: 404 });
    expect(b.em.listar(true).map((e) => e.id)).toEqual([2]);
    expect(b.em.listar(false).map((e) => e.id)).toEqual([2, 1]);

    const [ev] = b.eventos('EMERGENCY_RECOVERED');
    expect(ev).toMatchObject({ drone_id: A, source: 'backend' });
    expect(JSON.parse(ev.meta)).toEqual({
      drone: { hash: A, displayName: 'Alfa', model: 'DJI Mini 3' },
      emergencia: { id: 1, motivo: 'autonomia', lat: -34.8702, lon: -56.1902, ts: new Date(T0).toISOString() },
      detalle: { por: 'campo' },
    });
    expect(b.difundidos('emergency_updated').at(-1).emergencia).toMatchObject({ id: 1, recuperadaPor: 'campo' });
  });
});
