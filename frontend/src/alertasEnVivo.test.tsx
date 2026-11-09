import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ContextoDeAlertas, SIN_CONSOLA, useDronDeLaAlerta } from './alertasEnVivo';
import { makeAlert, makeDrone } from './test/fixtures';

const ALFA = makeDrone({ droneId: 'd1', displayName: 'Alfa' });
const BRAVO = makeDrone({ droneId: 'd2', displayName: 'Bravo' });

function conConsola({ children }: Readonly<{ children: ReactNode }>) {
  return <ContextoDeAlertas.Provider value={{ ...SIN_CONSOLA, drones: [ALFA, BRAVO] }}>{children}</ContextoDeAlertas.Provider>;
}

/**
 * La ficha del dron de una alerta sale de la consola en vivo: es lo que el
 * engranaje del silencio y las consecuencias de decidir necesitan, y tiene que
 * ser la del dron que la sigue AHORA (RELEVOS §3.6), no la del que la creó.
 */
describe('useDronDeLaAlerta', () => {
  it('devuelve la ficha del dron que creó la alerta', () => {
    const { result } = renderHook(() => useDronDeLaAlerta(makeAlert({ drone_id: 'd1' })), { wrapper: conConsola });
    expect(result.current).toBe(ALFA);
  });

  it('después de un traspaso, la del dron que la sigue ahora', () => {
    const { result } = renderHook(() => useDronDeLaAlerta(makeAlert({ drone_id: 'd1', seguidaPor: 'd2' })), {
      wrapper: conConsola,
    });
    expect(result.current).toBe(BRAVO);
  });

  it('sin dron, con un dron que ya no está en la flota, o sin la consola alrededor, null', () => {
    expect(renderHook(() => useDronDeLaAlerta(makeAlert({ drone_id: null })), { wrapper: conConsola }).result.current).toBeNull();
    expect(renderHook(() => useDronDeLaAlerta(makeAlert({ drone_id: 'd9' })), { wrapper: conConsola }).result.current).toBeNull();
    expect(renderHook(() => useDronDeLaAlerta(makeAlert({ drone_id: 'd1' }))).result.current).toBeNull();
  });
});
