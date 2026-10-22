import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DURACION_AVISO_MS, ProveedorDeAvisos, useAvisar } from './AvisosFlotantes';

/** Un botón que avisa lo que se le diga: es lo que hace cada vista al guardar. */
function Guardar({ texto }: { texto: string }) {
  const avisar = useAvisar();
  return (
    <button type="button" onClick={() => avisar(texto)}>
      Guardar
    </button>
  );
}

function montar(texto = 'Dron Alfa eliminado.') {
  render(
    <ProveedorDeAvisos>
      <Guardar texto={texto} />
    </ProveedorDeAvisos>,
  );
  return { guardar: () => act(() => screen.getByRole('button', { name: 'Guardar' }).click()) };
}

describe('AvisosFlotantes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('la región viva está desde el principio, vacía: así el lector anuncia lo que entra', () => {
    montar();
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('dice lo que acaba de pasar y se va solo', () => {
    const { guardar } = montar();
    guardar();
    expect(screen.getByRole('status')).toHaveTextContent('Dron Alfa eliminado.');

    act(() => vi.advanceTimersByTime(DURACION_AVISO_MS - 1));
    expect(screen.getByRole('status')).toHaveTextContent('Dron Alfa eliminado.');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('el mismo aviso dos veces se anuncia dos veces y vuelve a contar desde cero', () => {
    const { guardar } = montar();
    guardar();
    const primero = screen.getByText('Dron Alfa eliminado.');

    act(() => vi.advanceTimersByTime(DURACION_AVISO_MS - 100));
    guardar();
    // Es otro nodo (otra clave): el lector lo toma como texto nuevo.
    const segundo = screen.getByText('Dron Alfa eliminado.');
    expect(segundo).not.toBe(primero);

    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('status')).toHaveTextContent('Dron Alfa eliminado.');
    act(() => vi.advanceTimersByTime(DURACION_AVISO_MS));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('no se lleva el foco: el que guardó sigue donde estaba', () => {
    const { guardar } = montar();
    const boton = screen.getByRole('button', { name: 'Guardar' });
    boton.focus();
    guardar();
    expect(boton).toHaveFocus();
  });

  it('fuera de un proveedor avisar no hace nada y no rompe la vista', () => {
    const { result } = renderHook(() => useAvisar());
    expect(() => result.current('Guardado.')).not.toThrow();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
