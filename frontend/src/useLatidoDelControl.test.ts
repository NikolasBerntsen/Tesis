import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATIDO_MS } from './control';
import { useLatidoDelControl } from './useLatidoDelControl';

// La señal de vida de la consola mientras tiene el control de un dron: sale
// sola, mande o no mande el operador, y es lo que el hub mira para no soltarle
// el control. Con el reloj falso de vitest, sin esperar los 5 s de verdad.

type Props = { conectado: boolean; drones: readonly string[] };

function montar(inicial: Props) {
  const enviar = vi.fn((_mensaje: unknown) => true);
  const hook = renderHook((p: Props) => useLatidoDelControl({ enviar, ...p }), { initialProps: inicial });
  const latidos = () => enviar.mock.calls.map(([m]) => (m as { droneId: string }).droneId);
  return { ...hook, enviar, latidos };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLatidoDelControl', () => {
  it('sin el control de ningún dron no late', () => {
    const { enviar } = montar({ conectado: true, drones: [] });
    act(() => vi.advanceTimersByTime(LATIDO_MS * 3));
    expect(enviar).not.toHaveBeenCalled();
  });

  it('con el control late en el acto y cada 5 s por cada dron, sin que nadie mande nada', () => {
    const { enviar, latidos } = montar({ conectado: true, drones: ['d2', 'd1'] });
    expect(enviar).toHaveBeenCalledWith({ type: 'control_heartbeat', droneId: 'd1' });
    expect(latidos()).toEqual(['d1', 'd2']);
    act(() => vi.advanceTimersByTime(LATIDO_MS - 1));
    expect(latidos()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(latidos()).toEqual(['d1', 'd2', 'd1', 'd2']);
  });

  it('con el canal cerrado no late, y al reconectarse late en el acto', () => {
    const { enviar, rerender, latidos } = montar({ conectado: false, drones: ['d1'] });
    act(() => vi.advanceTimersByTime(LATIDO_MS * 2));
    expect(enviar).not.toHaveBeenCalled();
    rerender({ conectado: true, drones: ['d1'] });
    expect(latidos()).toEqual(['d1']);
  });

  it('al soltar el control deja de latir', () => {
    const { rerender, latidos } = montar({ conectado: true, drones: ['d1'] });
    rerender({ conectado: true, drones: [] });
    act(() => vi.advanceTimersByTime(LATIDO_MS * 3));
    expect(latidos()).toEqual(['d1']);
  });

  it('la misma lista armada de nuevo en cada render no reinicia el ritmo', () => {
    const { rerender, latidos } = montar({ conectado: true, drones: ['d1'] });
    act(() => vi.advanceTimersByTime(LATIDO_MS - 100));
    rerender({ conectado: true, drones: ['d1'] });
    act(() => vi.advanceTimersByTime(100));
    expect(latidos()).toEqual(['d1', 'd1']);
  });

  it('un mensaje del hub late si ya toca, y no de más: es lo que sigue andando con la pestaña en segundo plano', () => {
    const { result, latidos } = montar({ conectado: true, drones: ['d1'] });
    // recién latió: un status que llega no lo repite
    act(() => vi.advanceTimersByTime(LATIDO_MS - 1));
    act(() => result.current.alRecibirDelHub());
    expect(latidos()).toHaveLength(1);
    // el navegador espació el temporizador: el mensaje que llega late igual
    vi.setSystemTime(Date.now() + LATIDO_MS);
    act(() => result.current.alRecibirDelHub());
    expect(latidos()).toHaveLength(2);
  });

  it('sin control, un mensaje del hub no late', () => {
    const { result, enviar } = montar({ conectado: true, drones: [] });
    vi.setSystemTime(Date.now() + LATIDO_MS * 2);
    act(() => result.current.alRecibirDelHub());
    expect(enviar).not.toHaveBeenCalled();
  });

  it('al desmontar se apaga el temporizador', () => {
    const { unmount, latidos } = montar({ conectado: true, drones: ['d1'] });
    unmount();
    act(() => vi.advanceTimersByTime(LATIDO_MS * 3));
    expect(latidos()).toEqual(['d1']);
  });
});
