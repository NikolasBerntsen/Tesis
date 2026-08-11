import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UsersView from './UsersView';
import { api } from '../api';
import { makeMe, makeUser } from '../test/fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);

/** Mock de api: los GET a /users devuelven `lista`, el resto resuelve vacío. */
function serveUsers(lista = [makeUser()]) {
  apiMock.mockImplementation((path: string, opts?: RequestInit) => {
    if (path === '/users' && !opts) return Promise.resolve(lista);
    return Promise.resolve({});
  });
}

function rowOf(username: string): HTMLElement {
  return screen.getByText(username, { selector: 'td' }).closest('tr') as HTMLElement;
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UsersView', () => {
  it('renderiza la tabla con usuarios, roles y marca al usuario propio', async () => {
    serveUsers([
      makeUser({ username: 'admin1', role: 'admin' }),
      makeUser({ username: 'oper1', role: 'operator' }),
      makeUser({ username: 'super1', role: 'supervisor' }),
    ]);
    render(<UsersView me={makeMe({ username: 'admin1', role: 'admin' })} />);

    expect(await screen.findByText('oper1')).toBeInTheDocument();
    // Los roles aparecen también en el <select> del alta, por eso se acota a la celda.
    expect(screen.getByText('Operador', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('Supervisor', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('Administrador', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('(vos)')).toBeInTheDocument();
  });

  it('el admin suspende el control de un operador', async () => {
    serveUsers([
      makeUser({ username: 'admin1', role: 'admin' }),
      makeUser({ username: 'oper1', role: 'operator', canControl: true }),
    ]);
    render(<UsersView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText('oper1');

    await userEvent.click(within(rowOf('oper1')).getByRole('button', { name: 'Suspender' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', {
        method: 'PATCH',
        body: JSON.stringify({ canControl: false }),
      }),
    );
  });

  it('restaura el control de un operador suspendido', async () => {
    serveUsers([
      makeUser({ username: 'admin1', role: 'admin' }),
      makeUser({ username: 'oper1', role: 'operator', canControl: false }),
    ]);
    render(<UsersView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText('oper1');

    await userEvent.click(within(rowOf('oper1')).getByRole('button', { name: 'Restaurar' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', {
        method: 'PATCH',
        body: JSON.stringify({ canControl: true }),
      }),
    );
  });

  it('el admin desactiva una cuenta', async () => {
    serveUsers([
      makeUser({ username: 'admin1', role: 'admin' }),
      makeUser({ username: 'oper1', role: 'operator', active: true }),
    ]);
    render(<UsersView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText('oper1');

    await userEvent.click(within(rowOf('oper1')).getByRole('button', { name: 'Desactivar' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', {
        method: 'PATCH',
        body: JSON.stringify({ active: false }),
      }),
    );
  });

  it('elimina un usuario sólo si se confirma', async () => {
    serveUsers([
      makeUser({ username: 'admin1', role: 'admin' }),
      makeUser({ username: 'oper1', role: 'operator' }),
    ]);
    render(<UsersView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText('oper1');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(within(rowOf('oper1')).getByRole('button', { name: 'Eliminar' }));
    expect(apiMock).not.toHaveBeenCalledWith('/users/oper1', { method: 'DELETE' });

    confirmSpy.mockReturnValue(true);
    await userEvent.click(within(rowOf('oper1')).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', { method: 'DELETE' }),
    );
  });

  it('el admin crea un usuario nuevo y limpia el formulario', async () => {
    serveUsers([makeUser({ username: 'admin1', role: 'admin' })]);
    render(<UsersView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByRole('heading', { name: 'Crear usuario' });

    const usuario = screen.getByLabelText('Usuario');
    await userEvent.type(usuario, 'nuevo1');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'secreta');
    await userEvent.click(screen.getByRole('button', { name: 'Crear' }));

    await waitFor(() => {
      const call = apiMock.mock.calls.find(([p, o]) => p === '/users' && (o as RequestInit)?.method === 'POST');
      expect(call).toBeTruthy();
      expect((call![1] as RequestInit).body).toContain('"username":"nuevo1"');
    });
    await waitFor(() => expect((usuario as HTMLInputElement).value).toBe(''));
  });

  it('el supervisor no ve el alta ni el borrado, y sólo suspende operadores', async () => {
    serveUsers([
      makeUser({ username: 'super1', role: 'supervisor' }),
      makeUser({ username: 'oper1', role: 'operator' }),
      makeUser({ username: 'super2', role: 'supervisor' }),
    ]);
    render(<UsersView me={makeMe({ username: 'super1', role: 'supervisor', canControl: true })} />);
    await screen.findByText('oper1');

    expect(screen.queryByRole('heading', { name: 'Crear usuario' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    // Puede suspender al operador, pero no al otro supervisor
    expect(within(rowOf('oper1')).getByRole('button', { name: 'Suspender' })).toBeInTheDocument();
    expect(within(rowOf('super2')).queryByRole('button', { name: 'Suspender' })).not.toBeInTheDocument();
  });

  it('muestra el error si falla la carga', async () => {
    apiMock.mockRejectedValue(new Error('Sin permiso'));
    render(<UsersView me={makeMe()} />);
    expect(await screen.findByText('Sin permiso')).toBeInTheDocument();
  });

  it('muestra el error si falla una acción', async () => {
    apiMock.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === '/users' && !opts) {
        return Promise.resolve([
          makeUser({ username: 'admin1', role: 'admin' }),
          makeUser({ username: 'oper1', role: 'operator' }),
        ]);
      }
      return Promise.reject(new Error('No autorizado'));
    });
    render(<UsersView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText('oper1');

    await userEvent.click(within(rowOf('oper1')).getByRole('button', { name: 'Suspender' }));
    expect(await screen.findByText('No autorizado')).toBeInTheDocument();
  });
});
