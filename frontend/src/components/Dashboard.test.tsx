import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import Dashboard from './Dashboard';
import { makeAlert, makeDrone, makeStatus } from '../test/fixtures';

// DronesMap manipula Leaflet contra el DOM real: se mockea con un stub.
vi.mock('./DronesMap', () => ({ default: () => <div data-testid="mapa-mock" /> }));

function renderDashboard(props: Partial<Parameters<typeof Dashboard>[0]> = {}) {
  const base = {
    drones: [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true })],
    statuses: { d1: makeStatus({ droneId: 'd1' }) },
    frames: {},
    alerts: [],
    pendingAlerts: {},
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

  it('muestra la franja de alertas sin atender y abre el dron al tocar un chip', async () => {
    const props = renderDashboard({
      alerts: [makeAlert({ id: 5, type: 'PERSON', status: 'PENDING', drone_id: 'd1' })],
    });
    expect(screen.getByText('1 alerta sin atender')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /PERSONA/ }));
    expect(props.onOpenDrone).toHaveBeenCalledWith('d1');
  });

  it('condensa la franja cuando hay más alertas que chips', () => {
    renderDashboard({
      alerts: Array.from({ length: 6 }, (_, i) =>
        makeAlert({ id: i + 1, type: 'PERSON', status: 'PENDING', drone_id: 'd1' }),
      ),
    });
    expect(screen.getByText('6 alertas sin atender')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /PERSONA/ })).toHaveLength(4);
    expect(screen.getByText('+2 más')).toBeInTheDocument();
  });

  it('no muestra la franja cuando no hay alertas pendientes', () => {
    renderDashboard({ alerts: [makeAlert({ status: 'VALIDATED' })] });
    expect(screen.queryByText(/sin atender/)).not.toBeInTheDocument();
  });

  it('abre el detalle al clickear una cámara', async () => {
    const props = renderDashboard();
    await userEvent.click(screen.getByText('Sin señal de video'));
    expect(props.onOpenDrone).toHaveBeenCalledWith('d1');
  });
});
