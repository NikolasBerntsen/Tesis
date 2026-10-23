import { describe, expect, it } from 'vitest';
import {
  aplicarEmergencia,
  dondeBuscar,
  emergenciaAbierta,
  esEmergencia,
  esFoto,
  esFotoEnVivo,
  fusionarEmergencia,
  inclinacion,
  juntarFotos,
  motivoDeEmergencia,
  pieDeFoto,
  reemplazarAbiertas,
  sinFotos,
  sumarFotoEnVivo,
  tipoDeFoto,
} from './emergencias';
import { makeEmergencia as emergencia, makeFoto as foto } from './test/fixtures';

const ATERRIZADA = {
  aterrizadaEn: '2026-10-23T15:04:30.100Z',
  aterrizajeLat: -34.87021,
  aterrizajeLon: -56.19018,
  aterrizajeAlt: 0.2,
};

describe('qué es una emergencia abierta', () => {
  it('es la que nadie marcó recuperada', () => {
    expect(emergenciaAbierta(emergencia())).toBe(true);
    expect(emergenciaAbierta(emergencia({ recuperadaEn: '2026-10-23T15:40:00.000Z' }))).toBe(false);
  });

  it('esEmergencia pide un id y de qué dron es', () => {
    expect(esEmergencia(emergencia())).toBe(true);
    expect(esEmergencia(null)).toBe(false);
    expect(esEmergencia({ id: '3', droneId: 'a1' })).toBe(false);
    expect(esEmergencia({ id: 3 })).toBe(false);
  });
});

describe('fusionarEmergencia: una emergencia sólo avanza', () => {
  it('una versión vieja no la vuelve a abrir ni le saca el aterrizaje o las fotos', () => {
    const vieja = emergencia({
      ...ATERRIZADA,
      recuperadaEn: '2026-10-23T15:40:00.000Z',
      recuperadaPor: 'campo1',
      fotos: 5,
    });
    const atrasada = emergencia({ fotos: 2, alt: 30 });
    const fusion = fusionarEmergencia(vieja, atrasada);
    expect(fusion).toMatchObject({
      ...ATERRIZADA,
      recuperadaEn: '2026-10-23T15:40:00.000Z',
      recuperadaPor: 'campo1',
      fotos: 5,
      // Lo demás es de la que llega.
      alt: 30,
    });
  });

  it('lo nuevo pasa: el aterrizaje, la recuperación y más fotos', () => {
    const fusion = fusionarEmergencia(
      emergencia({ fotos: 1 }),
      emergencia({ ...ATERRIZADA, recuperadaEn: 'x', recuperadaPor: 'campo1', fotos: 3 }),
    );
    expect(fusion).toMatchObject({ ...ATERRIZADA, recuperadaEn: 'x', recuperadaPor: 'campo1', fotos: 3 });
  });
});

describe('aplicarEmergencia y reemplazarAbiertas', () => {
  it('una nueva va adelante; una conocida se fusiona', () => {
    const lista = aplicarEmergencia([emergencia({ id: 1 })], emergencia({ id: 2 }));
    expect(lista.map((e) => e.id)).toEqual([2, 1]);
    const despues = aplicarEmergencia(lista, emergencia({ id: 1, fotos: 4 }));
    expect(despues.find((e) => e.id === 1)?.fotos).toBe(4);
    expect(despues).toHaveLength(2);
  });

  it('al reconectar se va la abierta que el hub ya no nombra, y se quedan las recuperadas', () => {
    const recuperada = emergencia({ id: 1, recuperadaEn: 'x' });
    const seRecupero = emergencia({ id: 2 });
    const sigue = emergencia({ id: 3, fotos: 1 });
    const resultado = reemplazarAbiertas([recuperada, seRecupero, sigue], [emergencia({ id: 3, fotos: 2 }), emergencia({ id: 4 }), 7]);
    expect(resultado.map((e) => e.id).sort()).toEqual([1, 3, 4]);
    expect(resultado.find((e) => e.id === 3)?.fotos).toBe(2);
  });

  it('sin una lista no toca nada', () => {
    const lista = [emergencia()];
    expect(reemplazarAbiertas(lista, {})).toBe(lista);
  });

  it('no saca la que llegó en vivo mientras el pedido iba y volvía: el aviso sigue hasta que la recuperen', () => {
    const recienAterrizada = emergencia({ id: 5, ...ATERRIZADA });
    const seRecupero = emergencia({ id: 2 });
    const resultado = reemplazarAbiertas([recienAterrizada, seRecupero], [], new Set([5]));
    expect(resultado).toEqual([recienAterrizada]);
  });

  it('sinFotos deja la cantidad en lugar de la lista', () => {
    const { fotos: _fotos, ...resto } = emergencia();
    expect(sinFotos({ ...resto, fotos: [foto(), foto({ seq: 1 })] }).fotos).toBe(2);
  });
});

describe('fotos', () => {
  it('esFoto y esFotoEnVivo piden número e imagen, y la de en vivo además su emergencia', () => {
    expect(esFoto(foto())).toBe(true);
    expect(esFoto({ seq: '0', jpegBase64: 'x' })).toBe(false);
    expect(esFoto(undefined)).toBe(false);
    expect(esFotoEnVivo({ ...foto(), emergenciaId: 3 })).toBe(true);
    expect(esFotoEnVivo(foto())).toBe(false);
  });

  it('juntarFotos ordena por número y no repite: la que ya estaba gana', () => {
    const primera = foto({ seq: 2, rumbo: 90 });
    const juntas = juntarFotos([primera, foto({ seq: 0 })], [foto({ seq: 2, rumbo: 180 }), foto({ seq: 1 })]);
    expect(juntas.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(juntas[2]).toBe(primera);
  });

  it('sumarFotoEnVivo guarda la foto con su emergencia, sin el id adentro', () => {
    const fotos = sumarFotoEnVivo({}, { ...foto({ seq: 1 }), emergenciaId: 3 });
    expect(fotos[3]).toEqual([foto({ seq: 1 })]);
    const otra = sumarFotoEnVivo(fotos, { ...foto({ seq: 0 }), emergenciaId: 3 });
    expect(otra[3].map((f) => f.seq)).toEqual([0, 1]);
    // La repetida no cambia nada: la misma referencia, sin repintar.
    expect(sumarFotoEnVivo(otra, { ...foto({ seq: 0 }), emergenciaId: 3 })).toBe(otra);
  });
});

describe('rótulos y dónde buscar el dron', () => {
  it('traduce el motivo y el tipo de foto; lo desconocido pasa tal cual', () => {
    expect(motivoDeEmergencia('autonomia')).toBe('No le alcanzaba la batería para volver');
    expect(motivoDeEmergencia('bateria_critica_dji')).toMatch(/el propio DJI/);
    expect(motivoDeEmergencia('otro_motivo')).toBe('otro_motivo');
    expect(tipoDeFoto('panoramica')).toBe('Panorámica');
    expect(tipoDeFoto('termica')).toBe('termica');
  });

  it('la inclinación va con el signo menos tipográfico', () => {
    expect(inclinacion(-70)).toBe('−70°');
    expect(inclinacion(0)).toBe('0°');
    expect(inclinacion(12.4)).toBe('12°');
    expect(inclinacion(Number.NaN)).toBe('—');
  });

  it('el pie de una foto dice qué toma es, hacia dónde mira y cuánto baja la cámara', () => {
    expect(pieDeFoto(foto())).toBe('Oblicua · rumbo 270° O · inclinación −70°');
  });

  it('dondeBuscar prefiere dónde tocó tierra; si no, dónde arrancó; si no, nada', () => {
    expect(dondeBuscar(emergencia(ATERRIZADA))).toEqual({ lat: -34.87021, lon: -56.19018, aterrizo: true });
    expect(dondeBuscar(emergencia())).toEqual({ lat: -34.8702, lon: -56.1902, aterrizo: false });
    expect(dondeBuscar(emergencia({ lat: null, lon: null }))).toBeNull();
    // El 0,0 del SDK sin fix no es una posición.
    expect(dondeBuscar(emergencia({ lat: 0, lon: 0, aterrizajeLat: 0, aterrizajeLon: 0 }))).toBeNull();
  });
});
