import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import Dashboard from './Dashboard';
import type { MapItem } from './DronesMap';
import { makeAlert, makeDrone, makeStatus } from '../test/fixtures';

// DronesMap manipula Leaflet contra el DOM real: se mockea con un stub que
// anota los items que recibe, para ver qué le llega al mapa de la flota.
const { mapa } = vi.hoisted(() => ({ mapa: { items: [] as MapItem[] } }));
vi.mock('./DronesMap', () => ({
  default: ({ items }: { items: MapItem[] }) => {
    mapa.items = items;
    return <div data-testid="mapa-mock" />;
  },
}));

function renderDashboard(props: Partial<Parameters<typeof Dashboard>[0]> = {}) {
  const base = {
    drones: [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true })],
    statuses: { d1: makeStatus({ droneId: 'd1' }) },
    frames: {},
    alerts: [],
    pendingAlerts: {},
    onDecidir: vi.fn(),
    onOpenDrone: vi.fn(),
    onRename: vi.fn(),
  };
  const merged = { ...base, ...props } as Parameters<typeof Dashboard>[0];
  render(<Dashboard {...merged} />);
  return merged;
}

describe('Dashboard', () => {
  it('muestra una cámara por cada dron en vuelo y omite los desconectados', () => {
    renderDashboard({
      drones: [
        makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true }),
        makeDrone({ droneId: 'd2', displayName: 'Bravo', online: false }),
      ],
    });
    expect(screen.getByText('Alfa')).toBeInTheDocument();
    expect(screen.queryByText('Bravo')).not.toBeInTheDocument();
    expect(screen.getByText('1 en vuelo · 2 registrados')).toBeInTheDocument();
  });

  it('muestra el vacío cuando no hay drones activos', () => {
    renderDashboard({ drones: [makeDrone({ online: false })] });
    expect(screen.getByText('No hay drones activos.')).toBeInTheDocument();
  });

  it('cambia entre la vista de cámaras y la de mapa', async () => {
    renderDashboard();
    expect(screen.queryByTestId('mapa-mock')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mapa' }));
    expect(screen.getByTestId('mapa-mock')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cámaras' }));
    expect(screen.queryByTestId('mapa-mock')).not.toBeInTheDocument();
  });

  it('muestra la alerta sin atender con su dron, y el nombre abre la vista del dron', async () => {
    const props = renderDashboard({
      alerts: [makeAlert({ id: 5, type: 'PERSON', status: 'PENDING', drone_id: 'd1', snapshot: 'QUFB' })],
    });
    const tarjeta = screen.getByRole('region', { name: '1 alerta sin atender' });
    expect(tarjeta).toHaveClass('apaisada');
    expect(within(tarjeta).getByText('PERSONA')).toBeInTheDocument();
    expect(within(tarjeta).getByAltText('Captura que disparó la detección')).toBeInTheDocument();
    // Una sola: no hay nada que recorrer.
    expect(within(tarjeta).queryByTestId('carrusel-cuenta')).not.toBeInTheDocument();

    await userEvent.click(within(tarjeta).getByRole('button', { name: 'Alfa' }));
    expect(props.onOpenDrone).toHaveBeenCalledWith('d1');
  });

  it('recorre todas las pendientes de la flota, la más nueva primero', async () => {
    renderDashboard({
      drones: [
        makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true }),
        makeDrone({ droneId: 'd2', displayName: 'Bravo', online: true }),
      ],
      alerts: [
        ...Array.from({ length: 5 }, (_, i) => makeAlert({ id: i + 1, status: 'PENDING', drone_id: 'd1' })),
        makeAlert({ id: 6, type: 'VEHICLE', status: 'PENDING', drone_id: 'd2' }),
        makeAlert({ id: 7, status: 'DISMISSED', drone_id: 'd2' }),
      ],
    });
    const tarjeta = screen.getByRole('region', { name: '6 alertas sin atender' });
    expect(screen.getByTestId('carrusel-cuenta')).toHaveTextContent('1 de 6');
    expect(within(tarjeta).getByRole('button', { name: 'Bravo' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Alerta siguiente, más vieja' }));
    expect(screen.getByTestId('carrusel-cuenta')).toHaveTextContent('2 de 6');
    expect(within(tarjeta).getByRole('button', { name: 'Alfa' })).toBeInTheDocument();
  });

  it('valida desde el tablero con el id de la alerta en pantalla', async () => {
    const props = renderDashboard({ alerts: [makeAlert({ id: 5, status: 'PENDING', drone_id: 'd1' })] });
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(props.onDecidir).toHaveBeenCalledWith(5, 'VALIDATED');
  });

  it('avisa si algún dron está sobre el objetivo de la alerta', () => {
    renderDashboard({
      alerts: [makeAlert({ id: 12, status: 'PENDING', drone_id: 'd1' })],
      statuses: {
        d1: makeStatus({
          droneId: 'd1',
          state: 'ORBITING',
          target: {
            alertId: 12,
            type: 'PERSON',
            lat: -34.6,
            lon: -58.4,
            speedMs: null,
            courseDeg: null,
            moving: false,
            lost: false,
            lastSeenMs: 300,
            decision: 'PENDING',
          },
        }),
      },
    });
    expect(screen.getByText(/El dron está sobre este objetivo/)).toBeInTheDocument();
  });

  it('no muestra alertas cuando no hay pendientes', () => {
    renderDashboard({ alerts: [makeAlert({ status: 'VALIDATED' })] });
    expect(screen.queryByText(/sin atender/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
  });

  it('"en vuelo" cuenta sólo los que están en el aire: uno apoyado tiene cámara pero no vuela', () => {
    renderDashboard({
      drones: [
        makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true }),
        makeDrone({ droneId: 'd2', displayName: 'Bravo', online: true }),
        makeDrone({ droneId: 'd3', displayName: 'Charlie', online: true }),
      ],
      statuses: {
        d1: makeStatus({ droneId: 'd1', flying: true }),
        d2: makeStatus({ droneId: 'd2', flying: false, state: 'LANDED' }),
        // Una app vieja no manda `flying`: se la cuenta como antes.
        d3: makeStatus({ droneId: 'd3' }),
      },
    });
    expect(screen.getByText('2 en vuelo · 3 registrados')).toBeInTheDocument();
    // Las tres cámaras se muestran igual: el que está apoyado también transmite.
    expect(screen.getAllByRole('button', { name: /^Ver detalle de / })).toHaveLength(3);
  });

  it('le pasa al mapa de la flota el rastro del objetivo de cada dron', async () => {
    renderDashboard({
      rastros: { d1: { alertId: 12, puntos: [[-34.6, -58.38], [-34.6, -58.379]] } },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Mapa' }));
    expect(mapa.items[0].rastroObjetivo).toEqual([[-34.6, -58.38], [-34.6, -58.379]]);
  });

  it('sin rastros el mapa recibe los items sin rastro', async () => {
    renderDashboard();
    await userEvent.click(screen.getByRole('button', { name: 'Mapa' }));
    expect(mapa.items[0].rastroObjetivo).toBeUndefined();
  });

  it('abre el detalle al clickear una cámara', async () => {
    const props = renderDashboard();
    // El mosaico entero es clickeable por CSS (.tile-abrir), pero jsdom no
    // calcula posiciones: acá se usa el control accesible, que es el que
    // recibe el click en el navegador.
    await userEvent.click(screen.getByRole('button', { name: /^Ver detalle de / }));
    expect(props.onOpenDrone).toHaveBeenCalledWith('d1');
  });
});
