import { describe, expect, it } from 'vitest';
import { MAX_RASTRO, sumarAlRastro, type RastroObjetivo } from './rastro';
import type { ObjetivoEnSeguimiento } from './types';

function objetivo(over: Partial<ObjetivoEnSeguimiento> = {}): ObjetivoEnSeguimiento {
  return {
    alertId: 12,
    type: 'VEHICLE',
    lat: -34.6,
    lon: -58.38,
    speedMs: 4.2,
    courseDeg: 90,
    moving: true,
    lost: false,
    lastSeenMs: 500,
    decision: 'PENDING',
    ...over,
  };
}

describe('sumarAlRastro', () => {
  it('el primer status con objetivo arranca el rastro con su posición', () => {
    expect(sumarAlRastro(undefined, objetivo())).toEqual({ alertId: 12, puntos: [[-34.6, -58.38]] });
  });

  it('cada posición nueva se suma al final', () => {
    let rastro = sumarAlRastro(undefined, objetivo());
    rastro = sumarAlRastro(rastro, objetivo({ lon: -58.379 }));
    rastro = sumarAlRastro(rastro, objetivo({ lon: -58.378 }));
    expect(rastro?.puntos).toEqual([
      [-34.6, -58.38],
      [-34.6, -58.379],
      [-34.6, -58.378],
    ]);
  });

  it('sin objetivo el rastro se borra', () => {
    const rastro = sumarAlRastro(undefined, objetivo());
    expect(sumarAlRastro(rastro, null)).toBeUndefined();
    // Una app vieja no manda `target`: tampoco hay rastro que mostrar.
    expect(sumarAlRastro(rastro, undefined)).toBeUndefined();
  });

  it('un objetivo quieto no repite el punto, y devuelve el mismo rastro', () => {
    const rastro = sumarAlRastro(undefined, objetivo());
    const otraVez = sumarAlRastro(rastro, objetivo({ moving: false, lastSeenMs: 1500 }));
    // El mismo objeto: así el mapa no se redibuja por un objetivo que no se movió.
    expect(otraVez).toBe(rastro);
    expect(otraVez?.puntos).toHaveLength(1);
  });

  it('guarda sólo el último minuto: las posiciones más viejas se caen', () => {
    let rastro: RastroObjetivo | undefined;
    for (let i = 0; i < MAX_RASTRO + 15; i++) rastro = sumarAlRastro(rastro, objetivo({ lon: -58.38 + i * 1e-4 }));
    expect(rastro?.puntos).toHaveLength(MAX_RASTRO);
    // La que queda primera es la número 15: las quince de antes se fueron.
    expect(rastro?.puntos[0][1]).toBeCloseTo(-58.38 + 15e-4, 10);
  });

  it('el alert_ack le pone el id al rastro sin empezarlo de nuevo', () => {
    const sinId = sumarAlRastro(undefined, objetivo({ alertId: null }));
    const conId = sumarAlRastro(sinId, objetivo({ alertId: 12, lon: -58.379 }));
    expect(conId).toEqual({ alertId: 12, puntos: [[-34.6, -58.38], [-34.6, -58.379]] });
  });

  it('el id puesto queda aunque el status siguiente no lo traiga', () => {
    const conId = sumarAlRastro(undefined, objetivo({ alertId: 12 }));
    expect(sumarAlRastro(conId, objetivo({ alertId: null, lon: -58.379 }))?.alertId).toBe(12);
  });

  it('otro objetivo (otra alerta) empieza un rastro nuevo: no se unen dos trayectorias', () => {
    const viejo = sumarAlRastro(sumarAlRastro(undefined, objetivo()), objetivo({ lon: -58.379 }));
    const nuevo = sumarAlRastro(viejo, objetivo({ alertId: 13, lat: -34.7, lon: -58.5 }));
    expect(nuevo).toEqual({ alertId: 13, puntos: [[-34.7, -58.5]] });
  });

  it('una posición rota no suma, pero no borra lo que había', () => {
    const rastro = sumarAlRastro(undefined, objetivo());
    expect(sumarAlRastro(rastro, objetivo({ lat: 0, lon: 0 }))).toBe(rastro);
    expect(sumarAlRastro(rastro, objetivo({ lat: Number.NaN }))).toBe(rastro);
  });

  it('una posición rota en el primer status deja un rastro vacío con el id', () => {
    expect(sumarAlRastro(undefined, objetivo({ lat: Number.NaN }))).toEqual({ alertId: 12, puntos: [] });
  });
});
