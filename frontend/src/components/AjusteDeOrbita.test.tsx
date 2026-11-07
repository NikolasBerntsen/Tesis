import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { makeDrone } from '../test/fixtures';
import AjusteDeOrbita, { ESPERA_PARA_GUARDAR_MS, VELOCIDAD_ORBITA_POR_DEFECTO_MS } from './AjusteDeOrbita';

vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

const deslizador = () => screen.getByRole('slider', { name: 'Velocidad de órbita' }) as HTMLInputElement;

describe('AjusteDeOrbita', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({});
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sin nada fijado muestra la de fábrica y lo dice', () => {
    render(<AjusteDeOrbita drone={makeDrone({ velocidadOrbitaMs: null })} puedeAjustar />);
    expect(screen.getByTestId('velocidad-orbita')).toHaveTextContent('4,0 m/s · la de fábrica');
    expect(deslizador().value).toBe(String(VELOCIDAD_ORBITA_POR_DEFECTO_MS));
    expect(deslizador()).toHaveAttribute('min', '1');
    expect(deslizador()).toHaveAttribute('max', '8');
    expect(screen.getByRole('button', { name: /Volver a la de fábrica/ })).toBeDisabled();
  });

  it('con una velocidad fijada la muestra, y la ficha nueva la actualiza', () => {
    const { rerender } = render(<AjusteDeOrbita drone={makeDrone({ velocidadOrbitaMs: 2.5 })} puedeAjustar />);
    expect(screen.getByTestId('velocidad-orbita')).toHaveTextContent('2,5 m/s');
    expect(screen.getByTestId('velocidad-orbita')).not.toHaveTextContent('fábrica');
    rerender(<AjusteDeOrbita drone={makeDrone({ velocidadOrbitaMs: 6 })} puedeAjustar />);
    expect(deslizador().value).toBe('6');
  });

  it('mover el deslizador guarda con la mano quieta, una sola vez, por el endpoint de ajustes', async () => {
    render(<AjusteDeOrbita drone={makeDrone({ droneId: 'd1', velocidadOrbitaMs: null })} puedeAjustar />);
    fireEvent.change(deslizador(), { target: { value: '2' } });
    fireEvent.change(deslizador(), { target: { value: '3' } });
    fireEvent.change(deslizador(), { target: { value: '3.5' } });
    expect(screen.getByTestId('velocidad-orbita')).toHaveTextContent('3,5 m/s');
    expect(apiMock).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(ESPERA_PARA_GUARDAR_MS + 10));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith('/drones/d1/ajustes', {
      method: 'PATCH',
      body: JSON.stringify({ velocidadOrbitaMs: 3.5 }),
    });
  });

  it('"Volver a la de fábrica" manda null en el acto', async () => {
    render(<AjusteDeOrbita drone={makeDrone({ droneId: 'd1', velocidadOrbitaMs: 6 })} puedeAjustar />);
    await userEvent.click(screen.getByRole('button', { name: /Volver a la de fábrica/ }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/ajustes', { method: 'PATCH', body: JSON.stringify({ velocidadOrbitaMs: null }) }),
    );
    expect(deslizador().value).toBe(String(VELOCIDAD_ORBITA_POR_DEFECTO_MS));
  });

  it('si el Comando Central rechaza el ajuste, el motivo queda a la vista', async () => {
    apiMock.mockRejectedValue(new Error('velocidadOrbitaMs tiene que estar entre 1 y 8 m/s'));
    render(<AjusteDeOrbita drone={makeDrone({ droneId: 'd1' })} puedeAjustar />);
    fireEvent.change(deslizador(), { target: { value: '7' } });
    await act(() => vi.advanceTimersByTimeAsync(ESPERA_PARA_GUARDAR_MS + 10));
    expect(await screen.findByRole('alert')).toHaveTextContent('velocidadOrbitaMs tiene que estar entre 1 y 8 m/s');
  });

  it('quien no opera drones ve el valor pero no lo cambia', () => {
    render(<AjusteDeOrbita drone={makeDrone({ velocidadOrbitaMs: 3 })} puedeAjustar={false} />);
    expect(deslizador()).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Volver a la de fábrica/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('velocidad-orbita')).toHaveTextContent('3,0 m/s');
  });
});
