import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Console from './Console';
import { api } from '../api';
import { makeDrone, makeMe, makeStatus } from '../test/fixtures';
import type { Me } from '../types';

vi.mock('./DronesMap', () => ({ default: () => <div data-testid="mapa-mock" /> }));
vi.mock('../api', () => ({
  api: vi.fn(),
  getToken: () => 'tok',
  getUsername: () => 'oper1',
}));

// Captura el handler de mensajes que Console le pasa a useWebSocket, para poder
// empujar mensajes desde los tests. Devuelve siempre "conectado".
let wsHandler: (msg: unknown) => void = () => {};
vi.mock('../useWebSocket', () => ({
  useWebSocket: (cb: (msg: unknown) => void) => {
    wsHandler = cb;
    return true;
  },
}));

const apiMock = vi.mocked(api);

let meFix: Me = makeMe({ username: 'oper1', role: 'operator' });
let dronesFix = [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true })];

beforeEach(() => {
  meFix = makeMe({ username: 'oper1', role: 'operator' });
  dronesFix = [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true })];
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path === '/drones') return Promise.resolve(dronesFix);
    if (path === '/alerts') return Promise.resolve([]);
    if (path === '/routes') return Promise.resolve([]);
    if (path === '/me') return Promise.resolve(meFix);
    if (path === '/users') return Promise.resolve([]);
    if (path.startsWith('/logs')) return Promise.resolve([]);
    if (path.startsWith('/events')) return Promise.resolve([]);
    return Promise.resolve({});
  });
});

function fire(msg: unknown) {
  act(() => wsHandler(msg));
}

describe('Console', () => {
  it('carga los datos al montar y muestra el dashboard conectado', async () => {
    render(<Console onLogout={() => {}} />);
    expect(await screen.findByText('Alfa')).toBeInTheDocument();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/me'));
    expect(apiMock).toHaveBeenCalledWith('/drones');
    expect(apiMock).toHaveBeenCalledWith('/alerts');
    expect(apiMock).toHaveBeenCalledWith('/routes');
    // El enlace se dibuja con .estado (punto de currentColor), sin el carácter
    // decorativo que traía el texto.
    expect(screen.getByText('conectado')).toHaveClass('conn', 'estado', 'ok');
    // Un operador no ve Usuarios ni Registro
    expect(screen.queryByRole('button', { name: 'Usuarios' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Registro' })).not.toBeInTheDocument();
  });

  it('el admin navega entre Drones, Usuarios y Registro', async () => {
    meFix = makeMe({ username: 'admin1', role: 'admin' });
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');

    await userEvent.click(await screen.findByRole('button', { name: 'Usuarios' }));
    expect(await screen.findByRole('heading', { name: 'Usuarios' })).toBeInTheDocument();
    // La sección abierta lleva el filo dorado (.active) y se anuncia como actual
    expect(screen.getByRole('button', { name: 'Usuarios' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Usuarios' })).toHaveAttribute('aria-current', 'page');

    await userEvent.click(screen.getByRole('button', { name: 'Registro' }));
    expect(await screen.findByRole('heading', { name: 'Registro del sistema' })).toBeInTheDocument();
  });

  it('el supervisor ve Usuarios pero no Registro', async () => {
    meFix = makeMe({ username: 'super1', role: 'supervisor' });
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');
    expect(await screen.findByRole('button', { name: 'Usuarios' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Registro' })).not.toBeInTheDocument();
  });

  it('procesa los mensajes de WebSocket (alta, alerta, renombrado y baja)', async () => {
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');

    fire({ type: 'alert_created', alert: { id: 1, type: 'PERSON', status: 'PENDING', drone_id: 'd1', created_at: '2024-01-01T12:00:00.000Z' } });
    expect(await screen.findByText(/1 alerta(s)? sin atender/)).toBeInTheDocument();

    fire({ type: 'drone_online', drone: makeDrone({ droneId: 'd2', displayName: 'Bravo', online: true }) });
    expect(await screen.findByText('Bravo')).toBeInTheDocument();

    fire({ type: 'drone_renamed', droneId: 'd1', displayName: 'AlfaNuevo' });
    expect(await screen.findByText('AlfaNuevo')).toBeInTheDocument();

    // Estos ramales del switch se cubren empujando cada tipo de mensaje.
    fire({ type: 'alert_updated', alert: { id: 1, type: 'PERSON', status: 'VALIDATED', drone_id: 'd1', created_at: '2024-01-01T12:00:00.000Z' } });
    fire({ type: 'event', event: { id: 9, ts: '2024-01-01T12:00:00.000Z', type: 'X', message: 'm', drone_id: 'd1', category: 'drone', source: 's', alert_id: null, meta: null } });
    fire({ type: 'video_frame', droneId: 'd1', jpegBase64: 'AAAA' });
    fire({ type: 'route_updated', route: { id: 1, name: 'R', description: '', waypoints: [] } });
    fire({ type: 'control_changed', droneId: 'd1', controlledBy: 'oper1' });
    fire({ type: 'desconocido' });

    fire({ type: 'drone_offline', drone: makeDrone({ droneId: 'd2', displayName: 'Bravo', online: false }) });
    await waitFor(() => expect(screen.queryByText('Bravo')).not.toBeInTheDocument());
  });

  it('vuelca los status acumulados en cada tick', async () => {
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');

    fire({ type: 'status', ...makeStatus({ droneId: 'd1', battery: 30, signalPct: 40 }) });
    // El buffer se vuelca al estado en el próximo tick (1 s).
    expect(await screen.findByText('30%', undefined, { timeout: 3000 })).toBeInTheDocument();
  });

  it('abre el detalle de un dron y permite renombrarlo', async () => {
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Sin señal de video');
    await userEvent.click(screen.getByText('Sin señal de video'));

    const volver = await screen.findByRole('button', { name: /Volver a Drones/ });
    expect(volver).toBeInTheDocument();

    // Renombrar desde el detalle dispara el PATCH del dron.
    const header = volver.closest('.detail-main') as HTMLElement;
    await userEvent.click(within(header).getByTitle('Renombrar dron'));
    const input = within(header).getByDisplayValue('Alfa');
    await userEvent.clear(input);
    await userEvent.type(input, 'Alfa2');
    await userEvent.click(within(header).getByTitle('Guardar'));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: 'Alfa2' }),
      }),
    );
  });

  it('cierra sesión con el botón Salir', async () => {
    const onLogout = vi.fn();
    render(<Console onLogout={onLogout} />);
    await screen.findByText('Alfa');
    await userEvent.click(screen.getByRole('button', { name: 'Salir' }));
    expect(onLogout).toHaveBeenCalled();
  });
});
