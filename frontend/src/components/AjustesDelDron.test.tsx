import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ajustarDron } from '../api';
import { makeDrone } from '../test/fixtures';
import type { Drone } from '../types';
import AjustesDelDron from './AjustesDelDron';
import { ESPERA_PARA_GUARDAR_MS } from './useAjusteDelDron';

vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  ajustarDron: vi.fn(),
}));
const ajustarMock = vi.mocked(ajustarDron);

interface Contrato {
  ajustes: {
    velocidadOrbitaMs: { minimo: number; maximo: number; paso: number; porDefecto: number };
    reaccionADeteccion: { valores: string[]; porDefecto: string; rotulos: Record<string, string> };
    silencioAlRetomarS: { minimo: number; maximo: number; paso: number; porDefecto: number };
  };
}
// Los controles se comparan con el contrato que valida el backend, no con las
// constantes de la consola: si las dos puntas se desfasan, se entera este test.
const contrato = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/contrato/ajustes.json'), 'utf8'),
) as Contrato;

const orbita = () => screen.getByRole('slider', { name: 'Velocidad de órbita' }) as HTMLInputElement;
const silencio = () => screen.getByRole('slider', { name: 'Silencio al retomar' }) as HTMLInputElement;
const interruptor = () => screen.getByRole('switch', { name: 'Seguir al objetivo tras una detección' }) as HTMLInputElement;
const opcion = (nombre: string) => screen.getByRole('radio', { name: nombre }) as HTMLInputElement;
const esperarGuardado = () => act(() => vi.advanceTimersByTimeAsync(ESPERA_PARA_GUARDAR_MS + 10));

function montar(ficha: Partial<Drone> = {}, puedeAjustar = true) {
  const drone = makeDrone({ droneId: 'd1', velocidadOrbitaMs: null, reaccionADeteccion: null, silencioAlRetomarS: null, ...ficha });
  const { rerender } = render(<AjustesDelDron drone={drone} puedeAjustar={puedeAjustar} />);
  const conFicha = (cambios: Partial<Drone>) => rerender(<AjustesDelDron drone={{ ...drone, ...cambios }} puedeAjustar={puedeAjustar} />);
  return { drone, conFicha };
}

describe('AjustesDelDron', () => {
  beforeEach(() => {
    ajustarMock.mockReset();
    ajustarMock.mockResolvedValue({});
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arma los tres controles con el contrato y, sin nada fijado, muestra lo de fábrica y lo dice', () => {
    montar();
    const { velocidadOrbitaMs, silencioAlRetomarS, reaccionADeteccion } = contrato.ajustes;
    expect(screen.getByRole('heading', { name: 'Ajustes del dron' })).toBeInTheDocument();

    expect(orbita()).toHaveAttribute('min', String(velocidadOrbitaMs.minimo));
    expect(orbita()).toHaveAttribute('max', String(velocidadOrbitaMs.maximo));
    expect(orbita()).toHaveAttribute('step', String(velocidadOrbitaMs.paso));
    expect(orbita().value).toBe(String(velocidadOrbitaMs.porDefecto));
    expect(screen.getByTestId('velocidad-orbita')).toHaveTextContent('4,0 m/s · de fábrica');

    expect(silencio()).toHaveAttribute('min', String(silencioAlRetomarS.minimo));
    expect(silencio()).toHaveAttribute('max', String(silencioAlRetomarS.maximo));
    expect(silencio()).toHaveAttribute('step', String(silencioAlRetomarS.paso));
    expect(silencio().value).toBe(String(silencioAlRetomarS.porDefecto));
    expect(screen.getByTestId('silencio-al-retomar')).toHaveTextContent('15 s · de fábrica');

    // El interruptor prendido (la de fábrica sigue al objetivo) y una opción
    // por cada reacción que sigue, con el rótulo del contrato; detenerse es el
    // interruptor apagado, no una opción.
    expect(interruptor()).toBeChecked();
    const queSiguen = reaccionADeteccion.valores.filter((v) => v !== 'detenerse');
    expect(screen.getAllByRole('radio')).toHaveLength(queSiguen.length);
    for (const valor of queSiguen) expect(opcion(reaccionADeteccion.rotulos[valor])).toBeInTheDocument();
    expect(opcion(reaccionADeteccion.rotulos[reaccionADeteccion.porDefecto])).toBeChecked();
    expect(screen.queryByRole('radio', { name: reaccionADeteccion.rotulos.detenerse })).not.toBeInTheDocument();
    // Cada opción explica qué hace (VUELO §5).
    expect(screen.getByText(/Orbita el lugar de la detección con el centro fijo/)).toBeInTheDocument();
    for (const boton of screen.getAllByRole('button', { name: /Volver a lo de fábrica/ })) expect(boton).toBeDisabled();
  });

  it('con valores fijados los muestra, y la ficha nueva manda', () => {
    const { conFicha } = montar({ velocidadOrbitaMs: 2.5, reaccionADeteccion: 'seguir', silencioAlRetomarS: 30 });
    expect(screen.getByTestId('velocidad-orbita')).toHaveTextContent('2,5 m/s');
    expect(screen.getByTestId('velocidad-orbita')).not.toHaveTextContent('fábrica');
    expect(opcion('Seguimiento')).toBeChecked();
    expect(screen.getByTestId('silencio-al-retomar')).toHaveTextContent('30 s');
    conFicha({ velocidadOrbitaMs: 6, silencioAlRetomarS: 0 });
    expect(orbita().value).toBe('6');
    expect(screen.getByTestId('silencio-al-retomar')).toHaveTextContent('Sin silencio');
    expect(silencio()).toHaveAttribute('aria-valuetext', 'Sin silencio');
  });

  it('cada control guarda sólo su campo, una vez, con la mano quieta', async () => {
    montar();
    fireEvent.change(orbita(), { target: { value: '2' } });
    fireEvent.change(orbita(), { target: { value: '3' } });
    fireEvent.change(orbita(), { target: { value: '3.5' } });
    expect(screen.getByTestId('velocidad-orbita')).toHaveTextContent('3,5 m/s');
    expect(ajustarMock).not.toHaveBeenCalled();
    await esperarGuardado();
    expect(ajustarMock).toHaveBeenCalledTimes(1);
    expect(ajustarMock).toHaveBeenCalledWith('d1', { velocidadOrbitaMs: 3.5 });

    fireEvent.change(silencio(), { target: { value: '20' } });
    expect(screen.getByTestId('silencio-al-retomar')).toHaveTextContent('20 s');
    await esperarGuardado();
    expect(ajustarMock).toHaveBeenLastCalledWith('d1', { silencioAlRetomarS: 20 });

    fireEvent.click(opcion('Órbita en el lugar'));
    expect(opcion('Órbita en el lugar')).toBeChecked();
    await esperarGuardado();
    expect(ajustarMock).toHaveBeenLastCalledWith('d1', { reaccionADeteccion: 'orbitar' });
    // Nunca dos campos en un pedido: lo que no se tocó no viaja.
    for (const [, cambios] of ajustarMock.mock.calls) expect(Object.keys(cambios)).toHaveLength(1);
  });

  it('el interruptor apagado manda detenerse y explica qué hace; prendido, devuelve la forma de seguir de antes', async () => {
    const { conFicha } = montar({ reaccionADeteccion: 'seguir' });
    fireEvent.click(interruptor());
    expect(interruptor()).not.toBeChecked();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText('Se detiene donde está, lo vigila con la cámara y avisa.')).toBeInTheDocument();
    await esperarGuardado();
    expect(ajustarMock).toHaveBeenLastCalledWith('d1', { reaccionADeteccion: 'detenerse' });

    // La ficha vuelve con lo guardado, y al prender no hay que elegir de nuevo.
    conFicha({ reaccionADeteccion: 'detenerse' });
    expect(interruptor()).not.toBeChecked();
    fireEvent.click(interruptor());
    expect(opcion('Seguimiento')).toBeChecked();
    await esperarGuardado();
    expect(ajustarMock).toHaveBeenLastCalledWith('d1', { reaccionADeteccion: 'seguir' });
  });

  it('con lo de fábrica, apagar y volver a prender vuelve a lo de fábrica (null), no a un valor escrito', async () => {
    const { conFicha } = montar({ reaccionADeteccion: null });
    fireEvent.click(interruptor());
    await esperarGuardado();
    expect(ajustarMock).toHaveBeenLastCalledWith('d1', { reaccionADeteccion: 'detenerse' });
    conFicha({ reaccionADeteccion: 'detenerse' });
    fireEvent.click(interruptor());
    expect(opcion('Seguimiento y órbita')).toBeChecked();
    await esperarGuardado();
    expect(ajustarMock).toHaveBeenLastCalledWith('d1', { reaccionADeteccion: null });
  });

  it('«Volver a lo de fábrica» manda null en el acto, por sección y con lo de fábrica escrito', async () => {
    montar({ velocidadOrbitaMs: 6, reaccionADeteccion: 'seguir', silencioAlRetomarS: 30 });
    fireEvent.click(screen.getByRole('button', { name: 'Volver a lo de fábrica (4,0 m/s)' }));
    await waitFor(() => expect(ajustarMock).toHaveBeenCalledWith('d1', { velocidadOrbitaMs: null }));
    expect(orbita().value).toBe('4');
    expect(screen.getByTestId('velocidad-orbita')).toHaveTextContent('de fábrica');

    fireEvent.click(screen.getByRole('button', { name: 'Volver a lo de fábrica (Seguimiento y órbita)' }));
    await waitFor(() => expect(ajustarMock).toHaveBeenCalledWith('d1', { reaccionADeteccion: null }));
    expect(opcion('Seguimiento y órbita')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Volver a lo de fábrica (15 s)' }));
    await waitFor(() => expect(ajustarMock).toHaveBeenCalledWith('d1', { silencioAlRetomarS: null }));
    expect(silencio().value).toBe('15');
    expect(ajustarMock).toHaveBeenCalledTimes(3);
  });

  it('si el Comando Central rechaza el cambio, el motivo queda a la vista y el control vuelve a lo guardado', async () => {
    ajustarMock.mockRejectedValue(new Error('silencioAlRetomarS tiene que ir de a 5'));
    montar({ silencioAlRetomarS: 10, reaccionADeteccion: 'seguir' });
    fireEvent.change(silencio(), { target: { value: '25' } });
    expect(silencio().value).toBe('25');
    await esperarGuardado();
    expect(await screen.findByRole('alert')).toHaveTextContent('silencioAlRetomarS tiene que ir de a 5');
    expect(silencio().value).toBe('10');

    // También el interruptor: lo rechazado no quedó.
    fireEvent.click(interruptor());
    expect(interruptor()).not.toBeChecked();
    await esperarGuardado();
    await waitFor(() => expect(interruptor()).toBeChecked());
    expect(opcion('Seguimiento')).toBeChecked();
  });

  it('mientras el pedido viaja lo dice, y después se calla', async () => {
    let resolver: () => void = () => {};
    ajustarMock.mockImplementation(() => new Promise<void>((r) => (resolver = r)));
    montar();
    fireEvent.change(orbita(), { target: { value: '5' } });
    await esperarGuardado();
    const seccion = orbita().closest('.card') as HTMLElement;
    expect(within(seccion).getByRole('status')).toHaveTextContent('Guardando…');
    await act(async () => resolver());
    expect(within(seccion).queryByRole('status')).not.toBeInTheDocument();
  });

  it('el operador de campo ve los valores pero no toca nada', () => {
    montar({ velocidadOrbitaMs: 3, reaccionADeteccion: 'orbitar', silencioAlRetomarS: 5 }, false);
    expect(orbita()).toBeDisabled();
    expect(silencio()).toBeDisabled();
    expect(interruptor()).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Volver a lo de fábrica/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('velocidad-orbita')).toHaveTextContent('3,0 m/s');
    expect(opcion('Órbita en el lugar')).toBeChecked();
    expect(screen.getByTestId('silencio-al-retomar')).toHaveTextContent('5 s');
  });
});
