import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UsersView from './UsersView';
import { api, buscarUsuarios } from '../api';
import { makeMe, makeUser } from '../test/fixtures';
import type { RolConsola, UserView } from '../types';

vi.mock('../api', () => ({ api: vi.fn(), buscarUsuarios: vi.fn() }));
const apiMock = vi.mocked(api);
const traerMock = vi.mocked(buscarUsuarios);

const BORRADO = '2024-03-01T10:00:00.000Z';

function montar(role: RolConsola = 'admin', username = 'admin1') {
  return render(<UsersView me={makeMe({ username, role })} />);
}

/** La fila de la tabla que corresponde a un usuario, por su nombre. */
function fila(username: string): HTMLElement {
  return screen.getByRole('cell', { name: new RegExp(`^${username}( \\(vos\\))?$`) }).closest('tr') as HTMLElement;
}

function servir(...listas: UserView[][]) {
  traerMock.mockReset();
  // Cada carga puede devolver algo distinto: la última se repite para las
  // recargas que dispara cada acción.
  for (const lista of listas) traerMock.mockResolvedValueOnce(lista);
  traerMock.mockResolvedValue(listas[listas.length - 1]);
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({ username: 'nuevo', password: 'ABCD-EFGH-JKLM-NPQR' });
  traerMock.mockReset();
  traerMock.mockResolvedValue([makeUser()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UsersView', () => {
  it('renderiza la tabla con usuarios, roles y marca al usuario propio', async () => {
    servir([
      makeUser({ username: 'admin1', role: 'admin' }),
      makeUser({ username: 'oper1', role: 'operator' }),
      makeUser({ username: 'super1', role: 'supervisor' }),
      makeUser({ username: 'campo1', role: 'field_operator', canControl: false }),
    ]);
    montar();

    expect(await screen.findByText('oper1')).toBeInTheDocument();
    expect(traerMock).toHaveBeenCalledWith({ incluirEliminados: false, q: '' });
    // Los roles aparecen también en el <select> del alta, por eso se acota a la celda.
    expect(screen.getByText('Operador', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('Supervisor', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('Administrador', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('Operador de campo', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('(vos)')).toBeInTheDocument();
    // El operador de campo no pilotea drones: el permiso no está suspendido, no
    // corresponde, y el backend rechaza con un 400 cualquier intento de darlo.
    expect(within(fila('campo1')).getByText('No aplica')).toBeInTheDocument();
    expect(within(fila('campo1')).queryByRole('button', { name: 'Autorizar' })).not.toBeInTheDocument();
  });

  it('muestra el estado vacío cuando no hay a quién listar', async () => {
    servir([]);
    montar('supervisor', 'super1');

    expect(await screen.findByText('No hay usuarios para mostrar.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('el admin suspende el control de un operador', async () => {
    servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1', canControl: true })]);
    montar();
    await screen.findByText('oper1');

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Suspender' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', {
        method: 'PATCH',
        body: JSON.stringify({ canControl: false }),
      }),
    );
    // La acción recarga la lista para no quedar mostrando el estado viejo.
    await waitFor(() => expect(traerMock).toHaveBeenCalledTimes(2));
  });

  it('vuelve a autorizar el control de un operador suspendido', async () => {
    servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1', canControl: false })]);
    montar();
    await screen.findByText('oper1');

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Autorizar' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', {
        method: 'PATCH',
        body: JSON.stringify({ canControl: true }),
      }),
    );
  });

  it('el admin desactiva y reactiva una cuenta', async () => {
    servir(
      [makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1', active: true })],
      [makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1', active: false })],
    );
    montar();
    await screen.findByText('oper1');

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Desactivar' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', { method: 'PATCH', body: JSON.stringify({ active: false }) }),
    );
    const reactivar = await within(fila('oper1')).findByRole('button', { name: 'Reactivar' });
    expect(within(fila('oper1')).getByText('Desactivado')).toBeInTheDocument();

    await userEvent.click(reactivar);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', { method: 'PATCH', body: JSON.stringify({ active: true }) }),
    );
  });

  it('nadie se toca a sí mismo: sin desactivar ni eliminar en la fila propia', async () => {
    servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })]);
    montar();
    await screen.findByText('oper1');

    const propia = within(fila('admin1'));
    expect(propia.queryByRole('button', { name: 'Desactivar' })).not.toBeInTheDocument();
    expect(propia.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(propia.queryByRole('button', { name: 'Suspender' })).not.toBeInTheDocument();
  });

  describe('borrado lógico', () => {
    const conBorrado = [
      makeUser({ username: 'admin1', role: 'admin' }),
      makeUser({ username: 'oper1', deletedAt: BORRADO }),
    ];

    it('el pop-up explica que la baja se puede deshacer y no se elimina si se cancela', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })]);
      montar();
      await screen.findByText('oper1');

      await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Eliminar' }));
      const dialogo = await screen.findByRole('dialog');
      expect(within(dialogo).getByRole('heading', { name: 'Eliminar a oper1' })).toBeInTheDocument();
      expect(dialogo).toHaveTextContent(/restaurarla más adelante/);
      expect(dialogo).not.toHaveTextContent(/definitivamente/i);

      await userEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(apiMock).not.toHaveBeenCalledWith('/users/oper1', { method: 'DELETE' });
    });

    it('confirmar el pop-up elimina y la fila desaparece del listado', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })], [conBorrado[0]]);
      montar();
      await screen.findByText('oper1');

      await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Eliminar' }));
      const dialogo = await screen.findByRole('dialog');
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));

      await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/users/oper1', { method: 'DELETE' }));
      await waitFor(() => expect(screen.queryByText('oper1')).not.toBeInTheDocument());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('el pop-up se cierra con Escape y clickeando el fondo', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })]);
      const { container } = montar();
      await screen.findByText('oper1');

      await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Eliminar' }));
      await screen.findByRole('dialog');
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Eliminar' }));
      await screen.findByRole('dialog');
      const fondo = document.body.querySelector('.modal-fondo') as HTMLElement;
      expect(container).not.toContainElement(fondo);
      await userEvent.click(fondo);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(apiMock).not.toHaveBeenCalledWith('/users/oper1', { method: 'DELETE' });
    });

    it('no se cierra si el arrastre para seleccionar el texto termina en el fondo', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })]);
      montar();
      await screen.findByText('oper1');

      await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Eliminar' }));
      const dialogo = await screen.findByRole('dialog');
      const fondo = dialogo.parentElement as HTMLElement;
      const titulo = within(dialogo).getByRole('heading', { name: 'Eliminar a oper1' });

      await userEvent.pointer([
        { keys: '[MouseLeft>]', target: titulo },
        { target: fondo },
        { keys: '[/MouseLeft]', target: fondo },
      ]);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('el pop-up atrapa el foco y lo devuelve a la fila al cerrarse', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })]);
      montar();
      await screen.findByText('oper1');

      const abrir = within(fila('oper1')).getByRole('button', { name: 'Eliminar' });
      await userEvent.click(abrir);
      const dialogo = await screen.findByRole('dialog');
      expect(dialogo).toHaveFocus();

      const cruz = within(dialogo).getByRole('button', { name: 'Cerrar la confirmación' });
      const borrar = within(dialogo).getByRole('button', { name: 'Eliminar' });
      borrar.focus();
      await userEvent.tab();
      expect(cruz).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(borrar).toHaveFocus();

      await userEvent.keyboard('{Escape}');
      expect(abrir).toHaveFocus();
    });

    it('avisa si el backend rechaza el borrado', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })]);
      apiMock.mockRejectedValue(new Error('El usuario ya estaba eliminado'));
      montar();
      await screen.findByText('oper1');

      await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Eliminar' }));
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Eliminar' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('El usuario ya estaba eliminado');
    });

    it('el toggle pide los eliminados, los marca y no les ofrece las acciones normales', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' })], conBorrado);
      montar();
      await screen.findByText('admin1');
      expect(screen.queryByText('oper1')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Ver eliminados' }));
      await waitFor(() => expect(traerMock).toHaveBeenLastCalledWith({ incluirEliminados: true, q: '' }));

      await screen.findByText('oper1');
      const eliminada = within(fila('oper1'));
      expect(fila('oper1')).toHaveClass('fila-eliminada');
      expect(eliminada.getByText('Eliminado')).toBeInTheDocument();
      expect(eliminada.queryByRole('button', { name: 'Suspender' })).not.toBeInTheDocument();
      expect(eliminada.queryByRole('button', { name: 'Desactivar' })).not.toBeInTheDocument();
      expect(eliminada.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();

      // Y el toggle vuelve a esconderlos.
      await userEvent.click(screen.getByRole('button', { name: 'Ocultar eliminados' }));
      await waitFor(() => expect(traerMock).toHaveBeenLastCalledWith({ incluirEliminados: false, q: '' }));
    });

    it('el admin restaura a un usuario eliminado', async () => {
      servir(conBorrado, conBorrado, [makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })]);
      montar();
      await userEvent.click(await screen.findByRole('button', { name: 'Ver eliminados' }));
      await screen.findByText('oper1');

      await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Restaurar' }));
      await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/users/oper1/restore', { method: 'POST' }));
      await waitFor(() => expect(fila('oper1')).not.toHaveClass('fila-eliminada'));
    });

    it('el supervisor ve los eliminados pero no puede restaurarlos', async () => {
      servir([makeUser({ username: 'oper1' })], [makeUser({ username: 'oper1', deletedAt: BORRADO })]);
      montar('supervisor', 'super1');
      await screen.findByText('oper1');

      await userEvent.click(screen.getByRole('button', { name: 'Ver eliminados' }));
      await waitFor(() => expect(traerMock).toHaveBeenLastCalledWith({ incluirEliminados: true, q: '' }));

      expect(await screen.findByText('Eliminado')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Restaurar' })).not.toBeInTheDocument();
    });
  });

  describe('alta', () => {
    it('el admin crea un supervisor y limpia el formulario', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' })]);
      montar();
      const alta = await screen.findByRole('form', { name: 'Crear usuario' });

      const usuario = within(alta).getByLabelText('Usuario');
      await userEvent.type(usuario, 'nuevo1');
      await userEvent.type(within(alta).getByLabelText('Nombre y apellido'), 'Persona Nueva');
      await userEvent.selectOptions(within(alta).getByLabelText('Rol'), 'supervisor');
      await userEvent.click(within(alta).getByRole('button', { name: 'Crear' }));

      await waitFor(() =>
        expect(JSON.parse(apiMock.mock.calls.at(-1)![1].body)).toEqual({
          username: 'nuevo1',
          fullName: 'Persona Nueva',
          role: 'supervisor',
          canControl: true,
        }),
      );
      await waitFor(() => expect((usuario as HTMLInputElement).value).toBe(''));
    });

    it('el operador de campo no puede controlar drones: la casilla queda deshabilitada y explicada', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' })]);
      montar();
      const alta = await screen.findByRole('form', { name: 'Crear usuario' });

      const casilla = within(alta).getByLabelText('Puede controlar drones');
      expect(casilla).toBeEnabled();
      expect(casilla).toBeChecked();

      await userEvent.selectOptions(within(alta).getByLabelText('Rol'), 'field_operator');
      expect(casilla).toBeDisabled();
      expect(casilla).not.toBeChecked();
      expect(screen.getByText(/sólo los da de alta y los empareja por QR/)).toBeInTheDocument();

      await userEvent.type(within(alta).getByLabelText('Usuario'), 'campo1');
      await userEvent.type(within(alta).getByLabelText('Nombre y apellido'), 'Persona Nueva');
      await userEvent.click(within(alta).getByRole('button', { name: 'Crear' }));

      await waitFor(() =>
        expect(JSON.parse(apiMock.mock.calls.at(-1)![1].body)).toEqual({
          username: 'campo1',
          fullName: 'Persona Nueva',
          role: 'field_operator',
          canControl: false,
        }),
      );
      // Al volver a un rol que sí opera, la casilla se rehabilita.
      await userEvent.selectOptions(within(alta).getByLabelText('Rol'), 'operator');
      expect(casilla).toBeEnabled();
      expect(screen.queryByText(/sólo los da de alta y los empareja por QR/)).not.toBeInTheDocument();
    });

    it('avisa si el nombre de usuario ya está ocupado', async () => {
      servir([makeUser({ username: 'admin1', role: 'admin' })]);
      apiMock.mockRejectedValue(new Error('El nombre de usuario ya está en uso'));
      montar();
      const alta = await screen.findByRole('form', { name: 'Crear usuario' });

      await userEvent.type(within(alta).getByLabelText('Usuario'), 'oper1');
      await userEvent.type(within(alta).getByLabelText('Nombre y apellido'), 'Persona Nueva');
      await userEvent.click(within(alta).getByRole('button', { name: 'Crear' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('El nombre de usuario ya está en uso');
      // El formulario no se vacía: el nombre rechazado sigue ahí para corregirlo.
      expect(within(alta).getByLabelText('Usuario')).toHaveValue('oper1');
    });
  });

  describe('permisos', () => {
    it('el supervisor no ve el alta ni el borrado, y sólo suspende operadores', async () => {
      servir([
        makeUser({ username: 'oper1', role: 'operator' }),
        makeUser({ username: 'super2', role: 'supervisor' }),
      ]);
      montar('supervisor', 'super1');
      await screen.findByText('oper1');

      expect(screen.queryByRole('form', { name: 'Crear usuario' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Desactivar' })).not.toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Acciones' })).not.toBeInTheDocument();
      expect(within(fila('oper1')).getByRole('button', { name: 'Suspender' })).toBeInTheDocument();
      expect(within(fila('super2')).queryByRole('button', { name: 'Suspender' })).not.toBeInTheDocument();
    });

    it('sin rango de supervisor no se ofrece ver los eliminados', async () => {
      servir([makeUser({ username: 'oper1' })]);
      montar('operator', 'oper1');
      await screen.findByText('oper1');

      expect(screen.queryByRole('button', { name: 'Ver eliminados' })).not.toBeInTheDocument();
    });
  });

  it('muestra el error si falla la carga', async () => {
    traerMock.mockRejectedValue(new Error('Sin permiso'));
    montar();

    expect(await screen.findByRole('alert')).toHaveTextContent('Sin permiso');
  });

  it('muestra el error si falla una acción', async () => {
    servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })]);
    apiMock.mockRejectedValue(new Error('No autorizado'));
    montar();
    await screen.findByText('oper1');

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Suspender' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No autorizado');
  });
});
