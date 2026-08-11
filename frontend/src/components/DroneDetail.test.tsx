import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DroneDetail from './DroneDetail';
import { api } from '../api';
import { makeAlert, makeDrone, makeEvent, makeMe, makeRoute, makeStatus } from '../test/fixtures';

vi.mock('./DronesMap', () => ({ default: () => <div data-testid="mapa-mock" /> }));
vi.mock('../api', () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);

function renderDetail(props: Partial<Parameters<typeof DroneDetail>[0]> = {}) {
  const base = {
    me: makeMe({ username: 'admin1', role: 'admin', canControl: true }),
    drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true }),
    status: makeStatus({ droneId: 'd1', state: 'PATROLLING', routeId: null }),
    frame: null as string | null,
    alerts: [],
    liveEvents: [],
    routes: [makeRoute({ id: 1, name: 'Ruta Perimetral' })],
    onBack: vi.fn(),
    onRename: vi.fn(),
    onWaypointLabel: vi.fn(),
  };
  const merged = { ...base, ...props } as Parameters<typeof DroneDetail>[0];
  render(<DroneDetail {...merged} />);
  return merged;
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith('/events')) return Promise.resolve([]);
    return Promise.resolve({});
  });
});

describe('DroneDetail', () => {
  it('muestra el encabezado, pide el historial y vuelve con el botón', async () => {
    const props = renderDetail();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/events?droneId=d1'));
    expect(screen.getByText('Alfa')).toBeInTheDocument();
    expect(screen.getByText('En vuelo')).toBeInTheDocument();
    expect(screen.getByTestId('mapa-mock')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Volver al dashboard/ }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('marca desconectado y muestra quién tiene el control manual', async () => {
    renderDetail({ drone: makeDrone({ online: false, controlledBy: 'oper9' }) });
    expect(await screen.findByText('Desconectado')).toBeInTheDocument();
    expect(screen.getByText('Control manual: oper9')).toBeInTheDocument();
  });

  it('fusiona los eventos en vivo del dron con el historial', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([makeEvent({ id: 1, message: 'del historial' })]);
      return Promise.resolve({});
    });
    renderDetail({
      liveEvents: [
        makeEvent({ id: 2, drone_id: 'd1', message: 'evento fresco' }),
        makeEvent({ id: 3, drone_id: 'otro', message: 'de otro dron' }),
      ],
    });
    expect(await screen.findByText('del historial')).toBeInTheDocument();
    expect(screen.getByText('evento fresco')).toBeInTheDocument();
    expect(screen.queryByText('de otro dron')).not.toBeInTheDocument();
  });

  it('muestra la ruta activa cuando el estado la referencia', async () => {
    renderDetail({
      status: makeStatus({ routeId: 1, waypointIndex: 1 }),
      routes: [makeRoute({ id: 1, name: 'Ruta Perimetral' })],
    });
    expect(await screen.findByText(/Ruta Perimetral · nodo 2 de 2/)).toBeInTheDocument();
  });

  it('comienza e interrumpe una ruta', async () => {
    renderDetail({ status: makeStatus({ state: 'PATROLLING', routeId: null }) });

    const select = screen.getByRole('combobox');
    await userEvent.selectOptions(select, '1');
    await userEvent.click(screen.getByRole('button', { name: 'Comenzar' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/route/start', {
        method: 'POST',
        body: JSON.stringify({ routeId: 1 }),
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Interrumpir' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/route/stop', { method: 'POST' }),
    );
  });

  it('oculta el panel de control si el usuario no está autorizado', async () => {
    renderDetail({ me: makeMe({ canControl: false }) });
    expect(await screen.findByText('Alfa')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Control del dron' })).not.toBeInTheDocument();
  });

  it('permite tomar el control manual cuando nadie lo tiene', async () => {
    renderDetail({ drone: makeDrone({ online: true, controlledBy: null }) });
    await userEvent.click(screen.getByRole('button', { name: 'Tomar control manual' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', { method: 'POST' }));
  });

  it('mueve el dron y devuelve el control cuando soy el controlador', async () => {
    renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1' }),
    });
    await userEvent.click(screen.getByTitle('Norte'));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/manual_move', {
        method: 'POST',
        body: JSON.stringify({ bearing: 0, distanceM: 25 }),
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Devolver al patrullaje' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', {
        method: 'DELETE',
        body: JSON.stringify({ resume: 'last' }),
      }),
    );
  });

  it('un supervisor puede quitarle el control a otro operador', async () => {
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
    });
    expect(screen.getByText(/Controlado por/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', expect.objectContaining({ method: 'DELETE' })));
  });

  it('decide una alerta del dron desde el panel', async () => {
    renderDetail({ alerts: [makeAlert({ id: 42, drone_id: 'd1', status: 'PENDING' })] });
    await userEvent.click(screen.getByRole('button', { name: 'Validar alerta' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/alerts/42/decision', {
        method: 'POST',
        body: JSON.stringify({ decision: 'VALIDATED' }),
      }),
    );
  });

  it('retoma la ruta cuando el patrullaje está interrumpido', async () => {
    renderDetail({ status: makeStatus({ state: 'MANUAL' }), drone: makeDrone({ online: true }) });
    const retomar = screen.getByRole('button', { name: 'Retomar ruta' });
    expect(retomar).toBeEnabled();
    await userEvent.click(retomar);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/resume', { method: 'POST', body: '{}' }),
    );
  });

  it('muestra el error si una acción falla', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([]);
      return Promise.reject(new Error('Backend caído'));
    });
    renderDetail({ drone: makeDrone({ controlledBy: null }) });
    await userEvent.click(screen.getByRole('button', { name: 'Tomar control manual' }));
    expect(await screen.findByText('Backend caído')).toBeInTheDocument();
  });
});
