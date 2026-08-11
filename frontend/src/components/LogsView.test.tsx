import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LogsView from './LogsView';
import { api } from '../api';
import { makeEvent } from '../test/fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);

describe('LogsView', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue([]);
  });

  it('carga todos los registros al montar (sin categoría)', async () => {
    apiMock.mockResolvedValue([makeEvent({ id: 1, message: 'arranque del sistema', category: 'sistema' })]);
    render(<LogsView />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/logs?limit=500'));
    expect(await screen.findByText('arranque del sistema')).toBeInTheDocument();
  });

  it('muestra el vacío cuando no hay registros', async () => {
    render(<LogsView />);
    expect(await screen.findByText('Sin registros.')).toBeInTheDocument();
  });

  it('filtra por categoría al cambiar de pestaña', async () => {
    render(<LogsView />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Drones' }));
    await waitFor(() => expect(apiMock).toHaveBeenLastCalledWith('/logs?category=drone&limit=500'));

    await userEvent.click(screen.getByRole('button', { name: 'Usuarios' }));
    await waitFor(() => expect(apiMock).toHaveBeenLastCalledWith('/logs?category=usuarios&limit=500'));
  });

  it('el botón Actualizar vuelve a pedir la categoría actual', async () => {
    render(<LogsView />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
  });

  it('despliega el detalle antes/después cuando el evento trae meta', async () => {
    apiMock.mockResolvedValue([
      makeEvent({ id: 1, type: 'USER_UPDATED', message: 'cambio de rol', meta: JSON.stringify({ antes: 'operator', despues: 'admin' }) }),
    ]);
    render(<LogsView />);
    expect(await screen.findByText('antes / después')).toBeInTheDocument();
    expect(screen.getByText(/"despues": "admin"/)).toBeInTheDocument();
  });
});
