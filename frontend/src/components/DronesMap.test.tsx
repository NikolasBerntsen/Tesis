import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DronesMap from './DronesMap';

// Leaflet no corre en jsdom. El doble registra qué capas se agregan y se quitan,
// que es lo que hace falta para probar el conmutador de fondo.
const { estado } = vi.hoisted(() => ({
  estado: { agregadas: [] as string[], quitadas: [] as string[], creadas: [] as string[] },
}));
vi.mock('leaflet', () => {
  // `vestir` usa style.setProperty: el doble necesita un elemento de verdad.
  const paneFalso = document.createElement('div');
  const mapa = {
    setView: () => mapa,
    on: () => mapa,
    off: () => mapa,
    remove: vi.fn(),
    getPane: () => paneFalso,
    removeLayer: (capa: { nombre: string }) => estado.quitadas.push(capa.nombre),
    addControl: vi.fn(),
    removeControl: vi.fn(),
    addLayer: vi.fn(),
    fitBounds: vi.fn(),
    getZoom: () => 15,
    attributionControl: { setPrefix: vi.fn(), getContainer: () => paneFalso },
  };
  function capa(url: string) {
    const nombre = url.includes('arcgis') ? 'satelite' : 'mapa';
    estado.creadas.push(nombre);
    return { nombre, addTo: () => estado.agregadas.push(nombre) };
  }
  return {
    default: {
      map: () => mapa,
      tileLayer: capa,
      divIcon: () => ({}),
      marker: () => ({ addTo: vi.fn(), setLatLng: vi.fn(), remove: vi.fn(), on: vi.fn(), bindPopup: vi.fn(), bindTooltip: vi.fn() }),
      polyline: () => ({ addTo: vi.fn(), remove: vi.fn(), setLatLngs: vi.fn(), setStyle: vi.fn(), bindTooltip: vi.fn() }),
      circleMarker: () => ({ addTo: vi.fn(), remove: vi.fn(), setStyle: vi.fn(), setTooltipContent: vi.fn(), bindTooltip: vi.fn(), on: vi.fn(), bindPopup: vi.fn() }),
      polygon: () => ({ addTo: vi.fn(), remove: vi.fn(), setLatLngs: vi.fn(), setStyle: vi.fn() }),
      Control: class { onAdd = () => paneFalso; addTo = () => this; remove = () => this; },
      DomUtil: { create: () => paneFalso },
      DomEvent: { disableClickPropagation: vi.fn(), disableScrollPropagation: vi.fn(), on: vi.fn() },
      latLngBounds: () => ({ isValid: () => false, pad: () => ({}) }),
    },
  };
});

describe('DronesMap — fondo del mapa', () => {
  beforeEach(() => {
    estado.agregadas.length = 0;
    estado.quitadas.length = 0;
    estado.creadas.length = 0;
  });

  it('arranca en el mapa callejero y ofrece el satélite', () => {
    render(<DronesMap items={[]} />);
    // las dos capas se crean una sola vez; sólo una se muestra
    expect(estado.creadas.sort()).toEqual(['mapa', 'satelite']);
    expect(estado.agregadas).toEqual(['mapa']);

    expect(screen.getByRole('button', { name: 'Mapa' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Satélite' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('cambiar a satélite intercambia la capa sin recrear el mapa', async () => {
    render(<DronesMap items={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Satélite' }));

    expect(estado.agregadas).toContain('satelite');
    expect(estado.quitadas).toContain('mapa');
    // no se crearon capas nuevas: se reusan las dos de siempre
    expect(estado.creadas.length).toBe(2);
    expect(screen.getByRole('button', { name: 'Satélite' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('se puede volver al callejero', async () => {
    render(<DronesMap items={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Satélite' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mapa' }));

    expect(estado.quitadas).toContain('satelite');
    expect(screen.getByRole('button', { name: 'Mapa' })).toHaveAttribute('aria-pressed', 'true');
  });
});
