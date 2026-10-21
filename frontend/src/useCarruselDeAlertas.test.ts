import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { makeAlert } from './test/fixtures';
import type { Alert } from './types';
import {
  actualizarLista,
  estadoInicial,
  mirar,
  moverse,
  useCarruselDeAlertas,
  vecina,
  type EstadoCarrusel,
} from './useCarruselDeAlertas';

const alertas = (...ids: number[]): Alert[] => ids.map((id) => makeAlert({ id }));

const estado = (over: Partial<EstadoCarrusel>): EstadoCarrusel => ({
  ids: [],
  seleccionada: null,
  sinVer: [],
  llegadas: 0,
  ...over,
});

describe('estadoInicial', () => {
  it('arranca mirando la primera de la lista, sin nada nuevo', () => {
    expect(estadoInicial([9, 7, 3])).toEqual({ ids: [9, 7, 3], seleccionada: 9, sinVer: [], llegadas: 0 });
  });

  it('sin alertas no hay ninguna seleccionada', () => {
    expect(estadoInicial([]).seleccionada).toBeNull();
  });
});

describe('vecina', () => {
  it('la que le seguía en el orden, si sigue estando', () => {
    expect(vecina([9, 7, 5, 3], [9, 7, 3], 5)).toBe(3);
  });

  it('saltea las que también se fueron', () => {
    expect(vecina([9, 7, 5, 3, 1], [9, 1], 7)).toBe(1);
  });

  it('si era la última, la anterior', () => {
    expect(vecina([9, 7, 5], [9, 7], 5)).toBe(7);
    expect(vecina([9, 7, 5], [9], 5)).toBe(9);
  });

  it('si no sobrevive ninguna de antes, la más nueva de ahora', () => {
    expect(vecina([5, 3], [12, 10], 5)).toBe(12);
  });

  it('sin una perdida conocida, la más nueva; sin alertas, ninguna', () => {
    expect(vecina([], [4, 2], null)).toBe(4);
    expect(vecina([9, 7], [4], 99)).toBe(4);
    expect(vecina([9], [], 9)).toBeNull();
  });
});

describe('actualizarLista', () => {
  it('una alerta nueva no mueve la seleccionada, pero queda sin ver y enciende el pulso', () => {
    const despues = actualizarLista(estado({ ids: [9, 7], seleccionada: 7 }), [12, 9, 7]);
    expect(despues).toEqual({ ids: [12, 9, 7], seleccionada: 7, sinVer: [12], llegadas: 1 });
  });

  it('si se va la seleccionada, queda la vecina que le seguía', () => {
    const despues = actualizarLista(estado({ ids: [9, 7, 5, 3], seleccionada: 5 }), [9, 7, 3]);
    expect(despues.seleccionada).toBe(3);
    expect(despues.llegadas).toBe(0);
  });

  it('si se va otra, la seleccionada sigue siendo la misma', () => {
    expect(actualizarLista(estado({ ids: [9, 7, 5], seleccionada: 5 }), [7, 5]).seleccionada).toBe(5);
  });

  it('la primera carga no cuenta como alertas que llegaron', () => {
    expect(actualizarLista(estadoInicial([]), [9, 7])).toEqual({ ids: [9, 7], seleccionada: 9, sinVer: [], llegadas: 0 });
  });

  it('las sin ver que se decidieron en otro lado dejan de contarse', () => {
    const despues = actualizarLista(estado({ ids: [12, 11, 9], seleccionada: 9, sinVer: [12, 11], llegadas: 2 }), [11, 9]);
    expect(despues.sinVer).toEqual([11]);
    expect(despues.llegadas).toBe(2);
  });

  it('una nueva que queda en pantalla porque no sobrevivió otra no cuenta como sin ver', () => {
    const despues = actualizarLista(estado({ ids: [5], seleccionada: 5 }), [12]);
    expect(despues).toEqual({ ids: [12], seleccionada: 12, sinVer: [], llegadas: 1 });
  });

  it('sin alertas no queda ninguna seleccionada', () => {
    expect(actualizarLista(estado({ ids: [5], seleccionada: 5 }), []).seleccionada).toBeNull();
  });
});

describe('mirar y moverse', () => {
  it('mirar una alerta la deja en pantalla y la saca de las sin ver', () => {
    expect(mirar(estado({ ids: [12, 9], seleccionada: 9, sinVer: [12] }), 12)).toMatchObject({ seleccionada: 12, sinVer: [] });
  });

  it('mirar una que no está en la lista no cambia nada', () => {
    const antes = estado({ ids: [9], seleccionada: 9 });
    expect(mirar(antes, 4)).toBe(antes);
  });

  it('se mueve de a un paso y no da la vuelta en las puntas', () => {
    const medio = estado({ ids: [9, 7, 5], seleccionada: 7 });
    expect(moverse(medio, -1).seleccionada).toBe(9);
    expect(moverse(medio, 1).seleccionada).toBe(5);

    const primera = estado({ ids: [9, 7, 5], seleccionada: 9 });
    expect(moverse(primera, -1)).toBe(primera);
    const ultima = estado({ ids: [9, 7, 5], seleccionada: 5 });
    expect(moverse(ultima, 1)).toBe(ultima);
  });

  it('sin seleccionada, avanzar lleva a la primera y retroceder no hace nada', () => {
    const vacia = estado({ ids: [9, 7], seleccionada: null });
    expect(moverse(vacia, 1).seleccionada).toBe(9);
    expect(moverse(vacia, -1)).toBe(vacia);
  });
});

describe('useCarruselDeAlertas', () => {
  it('ordena la más nueva primero, venga la lista en el orden que venga', () => {
    const { result } = renderHook(() => useCarruselDeAlertas(alertas(3, 9, 7)));
    expect(result.current.alertas.map((a) => a.id)).toEqual([9, 7, 3]);
    expect(result.current.actual?.id).toBe(9);
    expect(result.current).toMatchObject({ posicion: 1, total: 3, hayAnterior: false, haySiguiente: true, sinVer: 0 });
  });

  it('recorre con anterior y siguiente', () => {
    const { result } = renderHook(() => useCarruselDeAlertas(alertas(9, 7, 3)));
    act(() => result.current.siguiente());
    act(() => result.current.siguiente());
    expect(result.current).toMatchObject({ posicion: 3, hayAnterior: true, haySiguiente: false });
    expect(result.current.actual?.id).toBe(3);
    act(() => result.current.anterior());
    expect(result.current.actual?.id).toBe(7);
  });

  it('con una alerta nueva sigue en la misma, actualiza la cuenta y deja ir a la nueva', () => {
    const { result, rerender } = renderHook(({ lista }) => useCarruselDeAlertas(lista), {
      initialProps: { lista: alertas(9, 7) },
    });
    act(() => result.current.siguiente());
    rerender({ lista: alertas(12, 9, 7) });
    expect(result.current.actual?.id).toBe(7);
    expect(result.current).toMatchObject({ posicion: 3, total: 3, sinVer: 1, llegadas: 1 });

    act(() => result.current.irALaNueva());
    expect(result.current.actual?.id).toBe(12);
    expect(result.current.sinVer).toBe(0);

    // Sin ninguna sin ver, ir a la nueva no mueve nada.
    act(() => result.current.irALaNueva());
    expect(result.current.actual?.id).toBe(12);
  });

  it('si la que se mira desaparece, queda la vecina y no la primera', () => {
    const { result, rerender } = renderHook(({ lista }) => useCarruselDeAlertas(lista), {
      initialProps: { lista: alertas(9, 7, 5, 3) },
    });
    act(() => result.current.siguiente());
    act(() => result.current.siguiente());
    rerender({ lista: alertas(9, 7, 3) });
    expect(result.current.actual?.id).toBe(3);
    expect(result.current).toMatchObject({ posicion: 3, total: 3 });
  });

  it('una lista nueva con los mismos ids no cambia nada', () => {
    const { result, rerender } = renderHook(({ lista }) => useCarruselDeAlertas(lista), {
      initialProps: { lista: alertas(9, 7) },
    });
    act(() => result.current.siguiente());
    rerender({ lista: alertas(7, 9) });
    expect(result.current.actual?.id).toBe(7);
    expect(result.current.llegadas).toBe(0);
  });

  it('sin alertas no hay ninguna en pantalla', () => {
    const { result } = renderHook(() => useCarruselDeAlertas([]));
    expect(result.current.actual).toBeNull();
    expect(result.current).toMatchObject({ posicion: 0, total: 0, hayAnterior: false, haySiguiente: false });
  });
});
