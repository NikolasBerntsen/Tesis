import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
import { estadoMapa, fondosPuestos, limpiarEstadoMapa } from '../test/dobleLeaflet';
import Minimapa from './Minimapa';

beforeEach(() => {
  limpiarEstadoMapa();
});

describe('Minimapa', () => {
  it('sigue al dron: se recentra con cada posición nueva, sin rehacer el mapa', () => {
    const { rerender } = render(<Minimapa posicion={[-34.6, -58.4]} rumbo={90} />);
    expect(estadoMapa.mapasCreados).toBe(1);
    // Sólo el callejero: en un recuadro tan chico el satelital no se lee.
    expect(fondosPuestos()).toEqual(['https://tile.openstreetmap.org/{z}/{x}/{y}.png']);
    expect(estadoMapa.vistas.at(-1)?.centro).toEqual([-34.6, -58.4]);

    rerender(<Minimapa posicion={[-34.61, -58.41]} rumbo={90} />);
    expect(estadoMapa.vistas.at(-1)?.centro).toEqual([-34.61, -58.41]);
    expect(estadoMapa.mapasCreados).toBe(1);
  });

  it('la flecha del dron gira con el rumbo y lo dice en su nombre', () => {
    render(<Minimapa posicion={[-34.6, -58.4]} rumbo={135} />);
    const flecha = screen.getByRole('img', { name: 'El dron, mirando a 135° SE' });
    expect(flecha.style.transform).toContain('rotate(135deg)');
    expect(screen.queryByTestId('minimapa-sin-gps')).not.toBeInTheDocument();
  });

  it('sin rumbo informado, la flecha apunta al norte', () => {
    render(<Minimapa posicion={[-34.6, -58.4]} />);
    const flecha = screen.getByRole('img', { name: 'El dron' });
    expect(flecha.style.transform).toContain('rotate(0deg)');
  });

  it('sin GPS el recuadro sigue ahí y dice "Sin GPS", sin flecha ni recentrado', () => {
    render(<Minimapa posicion={null} rumbo={20} />);
    expect(screen.getByTestId('minimapa-sin-gps')).toHaveTextContent('Sin GPS');
    expect(screen.queryByTestId('minimapa-dron')).not.toBeInTheDocument();
    // Sólo la vista inicial: nadie lo recentra en una posición que no hay.
    expect(estadoMapa.vistas).toHaveLength(1);
  });

  it('al desmontarse destruye el mapa', () => {
    const { unmount } = render(<Minimapa posicion={[-34.6, -58.4]} />);
    unmount();
    expect(estadoMapa.mapasDestruidos).toBe(1);
  });
});
