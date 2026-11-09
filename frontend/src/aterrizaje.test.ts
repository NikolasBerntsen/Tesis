import { describe, expect, it } from 'vitest';
import { marcaDeEventos, seCortoElAterrizaje } from './aterrizaje';
import { makeEvent } from './test/fixtures';

describe('marcaDeEventos', () => {
  it('es el id más nuevo, esté donde esté en la lista; 0 sin eventos', () => {
    expect(marcaDeEventos([])).toBe(0);
    expect(marcaDeEventos([makeEvent({ id: 7 }), makeEvent({ id: 12 }), makeEvent({ id: 3 })])).toBe(12);
  });
});

describe('seCortoElAterrizaje', () => {
  const problema = (id: number, message: string, drone_id = 'd1') =>
    makeEvent({ id, type: 'DRONE_PROBLEM', message, drone_id });

  it('una palanca que lo cortó, un aterrizaje que no se pudo y uno que no se da lo terminan', () => {
    expect(seCortoElAterrizaje([makeEvent({ id: 11, type: 'LANDING_CANCELLED', drone_id: 'd1' })], 'd1', 10)).toBe(true);
    expect(seCortoElAterrizaje([problema(11, 'No se pudo aterrizar: el dron no aceptó la orden')], 'd1', 10)).toBe(true);
    expect(
      seCortoElAterrizaje([problema(11, 'No se aterriza (oper1 ordenó aterrizar desde la consola): sin señal')], 'd1', 10),
    ).toBe(true);
  });

  it('lo de antes de la orden, lo de otro dron y otros problemas no', () => {
    expect(seCortoElAterrizaje([makeEvent({ id: 10, type: 'LANDING_CANCELLED', drone_id: 'd1' })], 'd1', 10)).toBe(false);
    expect(seCortoElAterrizaje([makeEvent({ id: 11, type: 'LANDING_CANCELLED', drone_id: 'd2' })], 'd1', 10)).toBe(false);
    expect(seCortoElAterrizaje([problema(11, 'No se pudo volver a la base: el GoHome no arrancó')], 'd1', 10)).toBe(false);
    expect(seCortoElAterrizaje([makeEvent({ id: 11, type: 'LANDING', drone_id: 'd1' })], 'd1', 10)).toBe(false);
  });
});
