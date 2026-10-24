import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { traerEmergencia } from '../api';
import { aplicarEmergencia } from '../emergencias';
import { time } from '../format';
import { ContextoDeRelevosYEmergencias, SIN_OPERACION } from '../relevosYEmergencias';
import { limpiarEstadoMapa } from '../test/dobleLeaflet';
import { makeEmergencia, makeFoto } from '../test/fixtures';
import type { Emergencia } from '../types';
import AvisoDeEmergencias from './AvisoDeEmergencias';
import ProveedorDeEmergencias from './ProveedorDeEmergencias';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  traerEmergencia: vi.fn(),
}));
const traerMock = vi.mocked(traerEmergencia);

const RECUPERADA = { recuperadaEn: '2026-10-23T15:40:00.000Z', recuperadaPor: 'campo1' };

/**
 * La consola en miniatura: el aviso arriba, una vista con su título, y la
 * lista de emergencias en un estado que marcar recuperada actualiza, como en
 * Console.tsx.
 */
function Consola({ inicial, marcar }: { inicial: Emergencia[]; marcar: (id: number) => Promise<Emergencia> }) {
  const [emergencias, setEmergencias] = useState(inicial);
  async function marcarRecuperada(id: number) {
    const recuperada = await marcar(id);
    setEmergencias((prev) => aplicarEmergencia(prev, recuperada));
    return recuperada;
  }
  return (
    <ProveedorDeEmergencias relevos={[]} emergencias={emergencias} fotos={{}} marcarRecuperada={marcarRecuperada}>
      <AvisoDeEmergencias />
      <main>
        <h2 tabIndex={-1}>Operación</h2>
      </main>
    </ProveedorDeEmergencias>
  );
}

describe('AvisoDeEmergencias', () => {
  beforeEach(() => {
    traerMock.mockReset();
    limpiarEstadoMapa();
  });

  it('sin emergencias abiertas no muestra nada, pero la región asertiva ya está', () => {
    const { container } = render(
      <ContextoDeRelevosYEmergencias.Provider
        value={{ ...SIN_OPERACION, emergencias: [makeEmergencia(RECUPERADA)], abrirEmergencia: vi.fn() }}
      >
        <AvisoDeEmergencias />
      </ContextoDeRelevosYEmergencias.Provider>,
    );
    const region = container.querySelector('.aviso-emergencias-region');
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toBeEmptyDOMElement();
  });

  it('una abierta: quién, desde cuándo y por qué, y el camino a su ficha', () => {
    render(
      <ContextoDeRelevosYEmergencias.Provider
        value={{ ...SIN_OPERACION, emergencias: [makeEmergencia()], abrirEmergencia: vi.fn() }}
      >
        <AvisoDeEmergencias />
      </ContextoDeRelevosYEmergencias.Provider>,
    );
    const aviso = screen.getByRole('region', { name: 'Aterrizaje de emergencia sin recuperar' });
    expect(within(aviso).getByText('Alfa')).toBeInTheDocument();
    expect(aviso).toHaveTextContent(`Bajando desde las ${time('2026-10-23T15:04:05.300Z')}`);
    expect(aviso).toHaveTextContent('No le alcanzaba la batería para volver');
    expect(
      within(aviso).getByRole('button', { name: 'Ver la ficha del aterrizaje de emergencia de Alfa' }),
    ).toHaveTextContent('Ver la ficha');
  });

  it('el título lleva el ícono del aterrizaje, cada dron su luz roja, y la ficha se abre como un camino', () => {
    render(
      <ContextoDeRelevosYEmergencias.Provider
        value={{ ...SIN_OPERACION, emergencias: [makeEmergencia()], abrirEmergencia: vi.fn() }}
      >
        <AvisoDeEmergencias />
      </ContextoDeRelevosYEmergencias.Provider>,
    );
    const aviso = screen.getByRole('region', { name: 'Aterrizaje de emergencia sin recuperar' });
    // Los dibujos son mudos: el nombre lo pone el texto.
    expect(within(aviso).getByRole('heading').querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(within(aviso).getByRole('listitem').querySelector('.punto-vivo')).toHaveAttribute('aria-hidden', 'true');
    const ficha = within(aviso).getByRole('button', { name: /Ver la ficha/ });
    expect(ficha).toHaveClass('enlace', 'versal');
    expect(ficha.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('varias: la más nueva arriba, las que tocaron tierra lo dicen, y las recuperadas no están', () => {
    render(
      <ContextoDeRelevosYEmergencias.Provider
        value={{
          ...SIN_OPERACION,
          abrirEmergencia: vi.fn(),
          emergencias: [
            makeEmergencia({ id: 1, displayName: 'Vieja', creadaEn: '2026-10-23T10:00:00.000Z', aterrizadaEn: '2026-10-23T10:01:00.000Z' }),
            makeEmergencia({ id: 2, displayName: 'Nueva', creadaEn: '2026-10-23T12:00:00.000Z', motivo: 'bateria_critica_dji' }),
            makeEmergencia({ id: 3, displayName: 'Cerrada', ...RECUPERADA }),
          ],
        }}
      >
        <AvisoDeEmergencias />
      </ContextoDeRelevosYEmergencias.Provider>,
    );
    const aviso = screen.getByRole('region', { name: '2 aterrizajes de emergencia sin recuperar' });
    const renglones = within(aviso).getAllByRole('listitem');
    expect(renglones.map((r) => within(r).getByText(/Vieja|Nueva/).textContent)).toEqual(['Nueva', 'Vieja']);
    expect(renglones[1]).toHaveTextContent(`En tierra desde las ${time('2026-10-23T10:01:00.000Z')}`);
    expect(renglones[0]).toHaveTextContent('el propio DJI forzó el aterrizaje');
    expect(screen.queryByText('Cerrada')).not.toBeInTheDocument();
  });

  it('fuera de la consola avisa igual, sin botón que no haga nada', () => {
    render(
      <ContextoDeRelevosYEmergencias.Provider value={{ ...SIN_OPERACION, emergencias: [makeEmergencia()] }}>
        <AvisoDeEmergencias />
      </ContextoDeRelevosYEmergencias.Provider>,
    );
    expect(screen.getByRole('region', { name: 'Aterrizaje de emergencia sin recuperar' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('la ficha de una emergencia abierta desde el aviso', () => {
  beforeEach(() => {
    traerMock.mockReset();
    limpiarEstadoMapa();
    traerMock.mockImplementation(async (id) => {
      const { fotos: _n, ...resto } = makeEmergencia({ id });
      return { ...resto, fotos: [makeFoto()] };
    });
  });

  it('se abre en el pop-up ancho, con el dron y la hora, y al cerrarla el foco vuelve al botón', async () => {
    render(<Consola inicial={[makeEmergencia()]} marcar={vi.fn()} />);
    const boton = screen.getByRole('button', { name: /Ver la ficha/ });
    await userEvent.click(boton);

    const ficha = screen.getByRole('dialog', { name: 'Aterrizaje de emergencia #3' });
    expect(ficha).toHaveClass('modal-ancho');
    expect(ficha).toHaveTextContent(`Alfa · ${time('2026-10-23T15:04:05.300Z')}`);
    expect(await within(ficha).findByTestId('galeria-emergencia')).toBeInTheDocument();
    expect(traerMock).toHaveBeenCalledWith(3);

    await userEvent.click(within(ficha).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(boton).toHaveFocus();
  });

  it('marcarla recuperada saca el aviso, la ficha queda abierta y el foco va al título al cerrarla', async () => {
    const marcar = vi.fn(async (id: number) => makeEmergencia({ id, ...RECUPERADA }));
    render(<Consola inicial={[makeEmergencia()]} marcar={marcar} />);
    await userEvent.click(screen.getByRole('button', { name: /Ver la ficha/ }));
    const ficha = screen.getByRole('dialog', { name: 'Aterrizaje de emergencia #3' });
    await within(ficha).findByTestId('galeria-emergencia');

    await userEvent.click(within(ficha).getByRole('button', { name: 'Marcar como recuperado' }));
    const confirmacion = screen.getByRole('dialog', { name: 'Marcar Alfa como recuperado' });
    await userEvent.click(within(confirmacion).getByRole('button', { name: 'Marcar como recuperado' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: /sin recuperar/ })).not.toBeInTheDocument());
    expect(marcar).toHaveBeenCalledWith(3);
    // La ficha no se fue con el aviso: dice que se recuperó.
    expect(within(ficha).getAllByText('Recuperado').length).toBeGreaterThan(0);

    await userEvent.click(within(ficha).getByRole('button', { name: 'Cerrar la ficha' }));
    expect(screen.getByRole('heading', { name: 'Operación' })).toHaveFocus();
  });

  it('si quedaba otra abierta, el foco va a la ficha de esa', async () => {
    const marcar = vi.fn(async (id: number) => makeEmergencia({ id, ...RECUPERADA }));
    render(
      <Consola
        inicial={[
          makeEmergencia({ id: 3, displayName: 'Alfa', creadaEn: '2026-10-23T12:00:00.000Z' }),
          makeEmergencia({ id: 4, displayName: 'Bravo', creadaEn: '2026-10-23T11:00:00.000Z' }),
        ]}
        marcar={marcar}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /de Alfa$/ }));
    const ficha = screen.getByRole('dialog', { name: 'Aterrizaje de emergencia #3' });
    await within(ficha).findByTestId('galeria-emergencia');
    await userEvent.click(within(ficha).getByRole('button', { name: 'Marcar como recuperado' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Marcar Alfa como recuperado' })).getByRole('button', {
        name: 'Marcar como recuperado',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: /de Alfa$/ })).not.toBeInTheDocument());

    await userEvent.click(within(ficha).getByRole('button', { name: 'Cerrar' }));
    expect(screen.getByRole('button', { name: /de Bravo$/ })).toHaveFocus();
  });
});
