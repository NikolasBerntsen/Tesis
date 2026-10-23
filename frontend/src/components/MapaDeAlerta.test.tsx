import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MapaDeAlerta from './MapaDeAlerta';
import { estadoMapa, fondosPuestos, limpiarEstadoMapa, pintarComoLeaflet } from '../test/dobleLeaflet';
import type { ObjetivoEnSeguimiento } from '../types';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());

const OBJETIVO: ObjetivoEnSeguimiento = {
  alertId: 7,
  type: 'PERSON',
  lat: -34.6041,
  lon: -58.3817,
  speedMs: 1.2,
  courseDeg: 90,
  moving: true,
  lost: false,
  lastSeenMs: 400,
  decision: 'PENDING',
};

const DETECCION: [number, number] = [-34.6037, -58.3816];
const DRON = { nombre: 'Alfa', posicion: [-34.6045, -58.382] as [number, number] };

const marcadores = () => estadoMapa.puestas.filter((c) => c.clase === 'marker');

describe('MapaDeAlerta', () => {
  beforeEach(() => {
    limpiarEstadoMapa();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marca la detección, el objetivo ahora y el dron, con su leyenda', () => {
    render(<MapaDeAlerta deteccion={DETECCION} objetivo={OBJETIVO} dron={DRON} />);

    expect(screen.getByTestId('mapa-alerta')).toBeInTheDocument();
    expect(marcadores().map((m) => m.latlng)).toEqual([DETECCION, [OBJETIVO.lat, OBJETIVO.lon], DRON.posicion]);
    expect(marcadores().map((m) => m.etiqueta)).toEqual(['Detección', 'Objetivo ahora', 'Alfa']);

    const leyenda = screen.getByTestId('leyenda-mapa-alerta');
    expect(leyenda).toHaveTextContent('Detección');
    expect(leyenda).toHaveTextContent('Objetivo ahora');
    expect(leyenda).toHaveTextContent('Dron');
    // Mientras la alerta espera, el objetivo va en el óxido de las alertas.
    expect(screen.getByText('Objetivo ahora')).toHaveClass('estado', 'bad');
  });

  it('con varios puntos los encuadra a todos; con uno solo, se acerca a la cuadra', () => {
    const { unmount } = render(<MapaDeAlerta deteccion={DETECCION} objetivo={null} dron={DRON} />);
    expect(estadoMapa.encuadres).toEqual([[DETECCION, DRON.posicion]]);
    // Sólo la vista de arranque: el encuadre de dos puntos no es un setView.
    expect(estadoMapa.vistas).toHaveLength(1);
    unmount();

    limpiarEstadoMapa();
    render(<MapaDeAlerta deteccion={DETECCION} objetivo={null} dron={null} />);
    // La de arranque y la del encuadre, las dos sobre la detección.
    expect(estadoMapa.encuadres).toHaveLength(0);
    expect(estadoMapa.vistas.at(-1)).toEqual({ centro: DETECCION, zoom: 17 });
  });

  it('un objetivo validado va en oro, como en el mapa de la flota', () => {
    render(<MapaDeAlerta deteccion={null} objetivo={{ ...OBJETIVO, decision: 'VALIDATED' }} dron={null} />);
    expect(screen.getByText('Objetivo ahora')).toHaveClass('estado', 'accent');
    expect(screen.queryByText('Detección')).not.toBeInTheDocument();
    // Sin detección, arranca sobre el objetivo.
    expect(estadoMapa.vistas[0]).toEqual({ centro: [OBJETIVO.lat, OBJETIVO.lon], zoom: 17 });
  });

  it('sin detección ni objetivo arranca sobre el dron', () => {
    render(<MapaDeAlerta deteccion={null} objetivo={null} dron={DRON} />);
    expect(estadoMapa.vistas[0]).toEqual({ centro: DRON.posicion, zoom: 17 });
    expect(screen.getByText('Dron')).toHaveClass('estado', 'accent');
  });

  it('sin ningún punto arranca en el centro por defecto y no encuadra nada', () => {
    render(<MapaDeAlerta deteccion={null} objetivo={null} dron={null} />);
    expect(estadoMapa.vistas).toHaveLength(1);
    expect(marcadores()).toHaveLength(0);
  });

  it('el nombre del dron va escapado en su etiqueta: Leaflet la pinta como HTML', () => {
    render(
      <MapaDeAlerta deteccion={null} objetivo={null} dron={{ nombre: '<img src=x onerror=alert(1)>', posicion: DRON.posicion }} />,
    );
    const pintada = pintarComoLeaflet(marcadores()[0].etiqueta);
    expect(pintada.querySelector('img')).toBeNull();
    expect(pintada.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('no se rehace con cada status, y sólo reencuadra cuando cambia lo que hay para mostrar', () => {
    const { rerender } = render(<MapaDeAlerta deteccion={DETECCION} objetivo={OBJETIVO} dron={null} />);
    const vistasAntes = estadoMapa.vistas.length;

    // El objetivo se movió: se redibuja, pero no se le saca el zoom al operador.
    rerender(<MapaDeAlerta deteccion={DETECCION} objetivo={{ ...OBJETIVO, lat: -34.605 }} dron={null} />);
    expect(estadoMapa.mapasCreados).toBe(1);
    expect(estadoMapa.vistas).toHaveLength(vistasAntes);
    expect(marcadores().at(-1)!.latlng).toEqual([-34.605, OBJETIVO.lon]);

    // Se fue el objetivo: queda la detección sola, y ahí sí se reencuadra.
    rerender(<MapaDeAlerta deteccion={DETECCION} objetivo={null} dron={null} />);
    expect(estadoMapa.vistas.at(-1)).toEqual({ centro: DETECCION, zoom: 17 });
  });

  it('tiene los dos fondos y se destruye al cerrarse, sin dejar el remedido colgado', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<MapaDeAlerta deteccion={DETECCION} objetivo={null} dron={null} />);
    expect(fondosPuestos().some((u) => u.includes('openstreetmap'))).toBe(true);
    // El remedido corre después de la animación de entrada del pop-up.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();

    await userEvent.click(screen.getByRole('button', { name: 'Satélite' }));
    expect(fondosPuestos().some((u) => u.includes('World_Imagery'))).toBe(true);

    unmount();
    expect(estadoMapa.mapasDestruidos).toBe(1);
  });
});
