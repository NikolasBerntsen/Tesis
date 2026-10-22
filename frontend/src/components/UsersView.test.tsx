import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProveedorDeAvisos } from './AvisosFlotantes';
import UsersView from './UsersView';
import { api, buscarUsuarios } from '../api';
import { AYUDA_DNI } from '../dni';
import { makeMe, makeUser } from '../test/fixtures';
import type { RolConsola, UserView } from '../types';

vi.mock('../api', () => ({ api: vi.fn(), buscarUsuarios: vi.fn() }));
const apiMock = vi.mocked(api);
const traerMock = vi.mocked(buscarUsuarios);

const BORRADO = '2024-03-01T10:00:00.000Z';
const NOTA_CAMPO = /sólo los da de alta y los empareja por QR/;

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

/** El cuerpo, ya parseado, del último pedido a esa ruta con ese método. */
function cuerpoDe(ruta: string, metodo: string): unknown {
  const llamada = apiMock.mock.calls.filter(([r, o]) => r === ruta && o?.method === metodo).at(-1);
  return llamada ? JSON.parse(String(llamada[1]!.body)) : undefined;
}

/** Una promesa que el test resuelve o rechaza cuando quiere, para ver el estado intermedio. */
function pendiente<T>() {
  let resolver!: (valor: T) => void;
  let rechazar!: (motivo: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

const ADMIN1 = makeUser({ username: 'admin1', role: 'admin', fullName: 'Ada Admin', dni: '20111222' });

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

  it('muestra el DNI con puntos, y una raya en las cuentas que no lo tienen', async () => {
    servir([
      ADMIN1,
      makeUser({ username: 'oper1', dni: '30123456' }),
      makeUser({ username: 'mayor1', dni: '1234567' }),
      makeUser({ username: 'viejo1', dni: '' }),
      // un backend anterior al DNI directamente no manda el campo
      makeUser({ username: 'antiguo1' }),
    ]);
    montar();
    await screen.findByText('oper1');

    expect(screen.getByRole('columnheader', { name: 'DNI' })).toBeInTheDocument();
    expect(within(fila('oper1')).getByText('30.123.456')).toBeInTheDocument();
    expect(within(fila('mayor1')).getByText('1.234.567')).toBeInTheDocument();
    for (const u of ['viejo1', 'antiguo1']) {
      expect(within(fila(u)).getByText('—', { selector: '.dni span' })).toBeInTheDocument();
    }
  });

  it('el buscador avisa que también busca por DNI y pide lo tipeado', async () => {
    servir([ADMIN1]);
    montar();
    const buscador = await screen.findByRole('searchbox', { name: 'Buscar usuarios' });
    expect(buscador).toHaveAttribute('placeholder', expect.stringMatching(/DNI/));

    await userEvent.type(buscador, '30.123');
    await waitFor(() => expect(traerMock).toHaveBeenLastCalledWith({ incluirEliminados: false, q: '30.123' }));
  });

  it('muestra el estado vacío cuando no hay a quién listar', async () => {
    servir([]);
    montar('supervisor', 'super1');

    expect(await screen.findByText('No hay usuarios para mostrar.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('el admin suspende el control de un operador, después de confirmarlo', async () => {
    servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1', canControl: true })]);
    montar();
    await screen.findByText('oper1');

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Suspender' }));
    // Suspender le corta el vuelo si está piloteando: pregunta antes.
    const dialogo = await screen.findByRole('dialog', { name: 'Suspender el control de oper1' });
    expect(dialogo).toHaveTextContent('lo suelta en el acto');
    expect(apiMock).not.toHaveBeenCalled();
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Suspender' }));
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
    const dialogo = await screen.findByRole('dialog', { name: 'Desactivar a oper1' });
    expect(dialogo).toHaveTextContent('se le cierra en el acto');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Desactivar' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', { method: 'PATCH', body: JSON.stringify({ active: false }) }),
    );
    const reactivar = await within(fila('oper1')).findByRole('button', { name: 'Reactivar' });
    expect(within(fila('oper1')).getByText('Desactivado')).toBeInTheDocument();

    // Reactivar no le corta nada a nadie: no pregunta.
    await userEvent.click(reactivar);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/users/oper1', { method: 'PATCH', body: JSON.stringify({ active: true }) }),
    );
  });

  it('nadie se toca a sí mismo: sin desactivar, eliminar ni editar en la fila propia', async () => {
    servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1' })]);
    montar();
    await screen.findByText('oper1');

    const propia = within(fila('admin1'));
    expect(propia.queryByRole('button', { name: 'Desactivar' })).not.toBeInTheDocument();
    expect(propia.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(propia.queryByRole('button', { name: 'Suspender' })).not.toBeInTheDocument();
    expect(propia.queryByRole('button', { name: /^Editar/ })).not.toBeInTheDocument();
    // la contraseña propia sí se puede regenerar, como antes
    expect(propia.getByRole('button', { name: 'Regenerar contraseña' })).toBeInTheDocument();
  });

  it('regenerar la contraseña la muestra una sola vez y se puede copiar', async () => {
    servir([ADMIN1, makeUser({ username: 'oper1' })]);
    apiMock.mockResolvedValue({ username: 'oper1', password: 'NUEVA-CLAVE' });
    // userEvent instala su propio portapapeles en `navigator` al arrancar: el
    // espía va después, sobre ese, para que sea el que ve el botón.
    const usuario = userEvent.setup();
    const escribir = vi.spyOn(navigator.clipboard, 'writeText');
    montar();
    await screen.findByText('oper1');

    await usuario.click(within(fila('oper1')).getByRole('button', { name: 'Regenerar contraseña' }));
    // La anterior deja de servir en el acto: primero pregunta.
    const pregunta = await screen.findByRole('dialog', { name: 'Regenerar la contraseña de oper1' });
    expect(pregunta).toHaveTextContent('deja de servir en el acto');
    expect(apiMock).not.toHaveBeenCalled();
    await usuario.click(within(pregunta).getByRole('button', { name: 'Regenerar' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Contraseña regenerada' });
    expect(apiMock).toHaveBeenCalledWith('/users/oper1/regenerate-password', { method: 'POST' });
    expect(within(dialogo).getByText('NUEVA-CLAVE')).toBeInTheDocument();

    await usuario.click(within(dialogo).getByRole('button', { name: 'Copiar' }));
    expect(escribir).toHaveBeenCalledWith('NUEVA-CLAVE');
    await usuario.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('borrado lógico', () => {
    const conBorrado = [
      makeUser({ username: 'admin1', role: 'admin' }),
      makeUser({ username: 'oper1', deleted: true, deletedAt: BORRADO }),
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
      // El foco arranca en "Cancelar": un Enter apurado no borra a nadie.
      expect(within(dialogo).getByRole('button', { name: 'Cancelar' })).toHaveFocus();

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
      // a una cuenta eliminada no se la edita: primero se restaura
      expect(eliminada.queryByRole('button', { name: /^Editar/ })).not.toBeInTheDocument();

      // Y el toggle vuelve a esconderlos: el rótulo es el mismo, lo que cambia
      // es aria-pressed.
      expect(screen.getByRole('button', { name: 'Ver eliminados' })).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(screen.getByRole('button', { name: 'Ver eliminados' }));
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
      servir([makeUser({ username: 'oper1' })], [makeUser({ username: 'oper1', deleted: true, deletedAt: BORRADO })]);
      montar('supervisor', 'super1');
      await screen.findByText('oper1');

      await userEvent.click(screen.getByRole('button', { name: 'Ver eliminados' }));
      await waitFor(() => expect(traerMock).toHaveBeenLastCalledWith({ incluirEliminados: true, q: '' }));

      expect(await screen.findByText('Eliminado')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Restaurar' })).not.toBeInTheDocument();
    });
  });

  describe('alta en un diálogo', () => {
    async function abrirAlta() {
      servir([ADMIN1]);
      montar();
      await userEvent.click(await screen.findByRole('button', { name: 'Nuevo usuario' }));
      return screen.findByRole('dialog', { name: 'Nuevo usuario' });
    }

    async function completar(dialogo: HTMLElement, datos: { usuario?: string; nombre?: string; dni?: string }) {
      const d = within(dialogo);
      if (datos.usuario) await userEvent.type(d.getByLabelText('Usuario'), datos.usuario);
      if (datos.nombre) await userEvent.type(d.getByLabelText('Nombre y apellido'), datos.nombre);
      if (datos.dni) await userEvent.type(d.getByLabelText('DNI'), datos.dni);
    }

    it('ya no hay formulario suelto en la página: el alta se abre en un diálogo', async () => {
      servir([ADMIN1]);
      montar();
      await screen.findByText('admin1');
      expect(screen.queryByRole('form')).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('el admin crea un supervisor: manda el DNI sin puntos, cierra y muestra la contraseña una vez', async () => {
      const dialogo = await abrirAlta();
      // Como todo diálogo, arranca con el foco en la caja: el lector de
      // pantalla anuncia el título antes de caer en el primer campo.
      expect(dialogo).toHaveFocus();

      await completar(dialogo, { usuario: 'nuevo1', nombre: 'Persona Nueva', dni: '30.123.456' });
      await userEvent.selectOptions(within(dialogo).getByLabelText('Rol'), 'supervisor');
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Crear' }));

      await waitFor(() =>
        expect(cuerpoDe('/users', 'POST')).toEqual({
          username: 'nuevo1',
          fullName: 'Persona Nueva',
          dni: '30123456',
          role: 'supervisor',
          canControl: true,
        }),
      );
      const credencial = await screen.findByRole('dialog', { name: 'Usuario creado' });
      expect(within(credencial).getByText('ABCD-EFGH-JKLM-NPQR')).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Nuevo usuario' })).not.toBeInTheDocument();
      // El listado se vuelve a pedir para que aparezca la cuenta nueva.
      await waitFor(() => expect(traerMock).toHaveBeenCalledTimes(2));

      // Y al volver a abrir el alta, arranca vacía.
      await userEvent.click(within(credencial).getByRole('button', { name: 'Ya la anoté' }));
      await userEvent.click(screen.getByRole('button', { name: 'Nuevo usuario' }));
      const otra = await screen.findByRole('dialog', { name: 'Nuevo usuario' });
      expect(within(otra).getByLabelText('Usuario')).toHaveValue('');
      expect(within(otra).getByLabelText('DNI')).toHaveValue('');
    });

    it('un DNI mal tipeado se marca en el campo y no viaja al backend', async () => {
      const dialogo = await abrirAlta();
      await completar(dialogo, { usuario: 'nuevo1', nombre: 'Persona Nueva', dni: '30-123-456' });
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Crear' }));

      const dni = within(dialogo).getByLabelText('DNI');
      expect(dni).toHaveAttribute('aria-invalid', 'true');
      expect(dni).toHaveAccessibleDescription(AYUDA_DNI);
      expect(apiMock).not.toHaveBeenCalled();

      // Al corregirlo, el error se va.
      await userEvent.clear(dni);
      await userEvent.type(dni, '1234567');
      expect(dni).not.toHaveAttribute('aria-invalid');
      expect(within(dialogo).queryByText(AYUDA_DNI)).not.toBeInTheDocument();
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Crear' }));
      await waitFor(() => expect(cuerpoDe('/users', 'POST')).toMatchObject({ dni: '1234567' }));
    });

    it('sin DNI tampoco se crea', async () => {
      const dialogo = await abrirAlta();
      await completar(dialogo, { usuario: 'nuevo1', nombre: 'Persona Nueva' });
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Crear' }));
      expect(within(dialogo).getByText(AYUDA_DNI)).toBeInTheDocument();
      expect(apiMock).not.toHaveBeenCalled();
    });

    it('el operador de campo no puede controlar drones: la casilla queda deshabilitada y explicada', async () => {
      const dialogo = await abrirAlta();
      const d = within(dialogo);

      const casilla = d.getByLabelText('Puede controlar drones');
      expect(casilla).toBeEnabled();
      expect(casilla).toBeChecked();

      await userEvent.selectOptions(d.getByLabelText('Rol'), 'field_operator');
      expect(casilla).toBeDisabled();
      expect(casilla).not.toBeChecked();
      expect(casilla).toHaveAccessibleDescription(NOTA_CAMPO);

      await completar(dialogo, { usuario: 'campo1', nombre: 'Persona Nueva', dni: '40111222' });
      // Al volver a un rol que sí opera, la casilla se rehabilita...
      await userEvent.selectOptions(d.getByLabelText('Rol'), 'operator');
      expect(casilla).toBeEnabled();
      expect(d.queryByText(NOTA_CAMPO)).not.toBeInTheDocument();
      // ...y se puede apagar a mano.
      await userEvent.click(casilla);
      await userEvent.selectOptions(d.getByLabelText('Rol'), 'field_operator');
      await userEvent.click(d.getByRole('button', { name: 'Crear' }));

      await waitFor(() =>
        expect(cuerpoDe('/users', 'POST')).toMatchObject({ role: 'field_operator', canControl: false }),
      );
    });

    it('un rol que no está en la lista no se cuela por el select', async () => {
      const dialogo = await abrirAlta();
      const rol = within(dialogo).getByLabelText('Rol');
      await userEvent.selectOptions(rol, 'supervisor');
      fireEvent.change(rol, { target: { value: 'admin' } });
      expect(rol).toHaveValue('operator');
    });

    it('el rechazo del backend se muestra adentro del diálogo, que queda abierto con lo tipeado', async () => {
      const espera = pendiente<unknown>();
      apiMock.mockReturnValue(espera.promesa as Promise<never>);
      const dialogo = await abrirAlta();
      await completar(dialogo, { usuario: 'oper1', nombre: 'Persona Nueva', dni: '30123456' });
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Crear' }));

      // Mientras viaja, el botón no deja mandarla dos veces.
      expect(await within(dialogo).findByRole('button', { name: 'Creando…' })).toBeDisabled();
      espera.rechazar(new Error('Ese DNI ya está registrado a nombre de oper1'));

      expect(await within(dialogo).findByRole('alert')).toHaveTextContent('Ese DNI ya está registrado a nombre de oper1');
      expect(within(dialogo).getByLabelText('Usuario')).toHaveValue('oper1');
      expect(within(dialogo).getByRole('button', { name: 'Crear' })).toBeEnabled();
      // El error es del diálogo: la página no muestra otro aviso aparte.
      expect(screen.getAllByRole('alert')).toHaveLength(1);
    });

    it('un rechazo que no es un Error también se muestra, como texto', async () => {
      apiMock.mockRejectedValue('sin conexión con el Comando Central');
      const dialogo = await abrirAlta();
      await completar(dialogo, { usuario: 'nuevo1', nombre: 'Persona Nueva', dni: '30123456' });
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Crear' }));
      expect(await within(dialogo).findByRole('alert')).toHaveTextContent('sin conexión con el Comando Central');
    });

    it('cancelar, la cruz o Escape cierran el alta sin crear nada', async () => {
      let dialogo = await abrirAlta();
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Nuevo usuario' }));
      dialogo = await screen.findByRole('dialog', { name: 'Nuevo usuario' });
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Cerrar sin guardar' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Nuevo usuario' }));
      await screen.findByRole('dialog', { name: 'Nuevo usuario' });
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(apiMock).not.toHaveBeenCalled();
    });
  });

  describe('edición en un diálogo', () => {
    const OPER1 = makeUser({ username: 'oper1', fullName: 'Olga Operadora', dni: '30123456' });

    async function abrirEdicion(usuario: UserView, role: RolConsola = 'admin', yo = 'admin1') {
      servir([ADMIN1, usuario]);
      montar(role, yo);
      await screen.findByText(usuario.username);
      await userEvent.click(within(fila(usuario.username)).getByRole('button', { name: `Editar a ${usuario.username}` }));
      return screen.findByRole('dialog', { name: `Editar a ${usuario.username}` });
    }

    it('abre con la ficha actual de la cuenta', async () => {
      const dialogo = await abrirEdicion(OPER1);
      const d = within(dialogo);
      expect(d.getByLabelText('Nombre y apellido')).toHaveValue('Olga Operadora');
      expect(d.getByLabelText('DNI')).toHaveValue('30.123.456');
      expect(d.getByLabelText('Rol')).toHaveValue('operator');
      expect(d.getByLabelText('Puede controlar drones')).toBeChecked();
      expect(d.getByLabelText('Cuenta activa')).toBeChecked();
      expect(d.getByText('Operador', { selector: '.modal-subtitulo' })).toBeInTheDocument();
      // con el rol de siempre no hay nada que advertir
      expect(d.queryByRole('status')).not.toBeInTheDocument();
    });

    it('el admin cambia nombre, DNI y acceso: manda sólo lo que cambió, cierra y recarga', async () => {
      const dialogo = await abrirEdicion(OPER1);
      const d = within(dialogo);

      await userEvent.clear(d.getByLabelText('Nombre y apellido'));
      await userEvent.type(d.getByLabelText('Nombre y apellido'), 'Olga Otero ');
      await userEvent.clear(d.getByLabelText('DNI'));
      await userEvent.type(d.getByLabelText('DNI'), '30 123 457');
      await userEvent.click(d.getByLabelText('Puede controlar drones'));
      await userEvent.click(d.getByLabelText('Cuenta activa'));
      await userEvent.click(d.getByRole('button', { name: 'Guardar' }));

      await waitFor(() =>
        expect(cuerpoDe('/users/oper1', 'PATCH')).toEqual({
          fullName: 'Olga Otero',
          dni: '30123457',
          canControl: false,
          active: false,
        }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(traerMock).toHaveBeenCalledTimes(2);
    });

    it('guardar una ficha intacta sólo cierra el diálogo', async () => {
      const dialogo = await abrirEdicion(OPER1);
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(apiMock).not.toHaveBeenCalled();
    });

    it('cambiar el rol avisa que la cuenta tiene que volver a entrar, y volver al de antes no lo manda', async () => {
      const dialogo = await abrirEdicion(OPER1);
      const d = within(dialogo);

      await userEvent.selectOptions(d.getByLabelText('Rol'), 'supervisor');
      expect(d.getByRole('status')).toHaveTextContent('oper1 va a tener que volver a iniciar sesión');

      await userEvent.selectOptions(d.getByLabelText('Rol'), 'operator');
      expect(d.queryByRole('status')).not.toBeInTheDocument();

      await userEvent.selectOptions(d.getByLabelText('Rol'), 'supervisor');
      await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
      await waitFor(() => expect(cuerpoDe('/users/oper1', 'PATCH')).toEqual({ role: 'supervisor' }));
    });

    it('pasar a operador de campo le apaga el control a la vista y en lo que se manda', async () => {
      const dialogo = await abrirEdicion(OPER1);
      const d = within(dialogo);

      await userEvent.selectOptions(d.getByLabelText('Rol'), 'field_operator');
      const casilla = d.getByLabelText('Puede controlar drones');
      expect(casilla).toBeDisabled();
      expect(casilla).not.toBeChecked();
      expect(casilla).toHaveAccessibleDescription(NOTA_CAMPO);

      await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
      await waitFor(() =>
        expect(cuerpoDe('/users/oper1', 'PATCH')).toEqual({ role: 'field_operator', canControl: false }),
      );
    });

    it('un operador de campo que pasa a operador puede quedar autorizado en el mismo cambio', async () => {
      const campo = makeUser({ username: 'campo1', role: 'field_operator', canControl: false, fullName: 'Ceci Campo', dni: '40111222' });
      const dialogo = await abrirEdicion(campo);
      const d = within(dialogo);
      expect(d.getByLabelText('Puede controlar drones')).toBeDisabled();

      await userEvent.selectOptions(d.getByLabelText('Rol'), 'operator');
      await userEvent.click(d.getByLabelText('Puede controlar drones'));
      await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
      await waitFor(() => expect(cuerpoDe('/users/campo1', 'PATCH')).toEqual({ role: 'operator', canControl: true }));
    });

    it('un rol que no está en la lista se toma como "el de siempre"', async () => {
      const dialogo = await abrirEdicion(OPER1);
      const rol = within(dialogo).getByLabelText('Rol');
      await userEvent.selectOptions(rol, 'supervisor');
      fireEvent.change(rol, { target: { value: 'admin' } });
      expect(rol).toHaveValue('operator');
      expect(within(dialogo).queryByRole('status')).not.toBeInTheDocument();
    });

    it('un DNI inválido, o borrar uno cargado, se marca en el campo y no se manda', async () => {
      const dialogo = await abrirEdicion(OPER1);
      const dni = within(dialogo).getByLabelText('DNI');

      await userEvent.clear(dni);
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar' }));
      expect(dni).toHaveAttribute('aria-invalid', 'true');
      expect(dni).toHaveAccessibleDescription(AYUDA_DNI);

      await userEvent.type(dni, '12');
      expect(dni).not.toHaveAttribute('aria-invalid');
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar' }));
      expect(dni).toHaveAttribute('aria-invalid', 'true');
      expect(apiMock).not.toHaveBeenCalled();
    });

    it('a una cuenta vieja sin DNI se le puede editar el resto sin cargarlo, o cargárselo', async () => {
      const viejo = makeUser({ username: 'viejo1', fullName: 'Vito Viejo', dni: '' });
      const dialogo = await abrirEdicion(viejo);
      const d = within(dialogo);
      expect(d.getByLabelText('DNI')).toHaveValue('');

      await userEvent.type(d.getByLabelText('Nombre y apellido'), 'ni');
      await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
      await waitFor(() => expect(cuerpoDe('/users/viejo1', 'PATCH')).toEqual({ fullName: 'Vito Viejoni' }));
    });

    it('a una cuenta de un backend sin DNI se le puede cargar uno', async () => {
      const antiguo = makeUser({ username: 'antiguo1', fullName: 'Ana Antigua' });
      const dialogo = await abrirEdicion(antiguo);
      await userEvent.type(within(dialogo).getByLabelText('DNI'), '25.777.888');
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar' }));
      await waitFor(() => expect(cuerpoDe('/users/antiguo1', 'PATCH')).toEqual({ dni: '25777888' }));
    });

    it('a una cuenta vieja sin nombre se le carga el DNI sin tener que inventarle un nombre', async () => {
      // Las cuentas anteriores al nombre completo lo tienen vacío (la tabla
      // muestra una raya). Exigirlo trababa cualquier otro cambio de la ficha.
      const sinNombre = makeUser({ username: 'viejo2', fullName: '', dni: '' });
      const dialogo = await abrirEdicion(sinNombre);
      const d = within(dialogo);
      expect(d.getByLabelText('Nombre y apellido')).toHaveValue('');
      expect(d.getByLabelText('Nombre y apellido')).not.toBeRequired();

      await userEvent.type(d.getByLabelText('DNI'), '30123456');
      await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
      await waitFor(() => expect(cuerpoDe('/users/viejo2', 'PATCH')).toEqual({ dni: '30123456' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('el nombre que se le empieza a tipear a esa cuenta sí se exige, y se manda', async () => {
      const sinNombre = makeUser({ username: 'viejo3', fullName: '', dni: '' });
      const dialogo = await abrirEdicion(sinNombre);
      const nombre = within(dialogo).getByLabelText('Nombre y apellido');

      await userEvent.type(nombre, 'Vera');
      expect(nombre).toBeRequired();
      // borrarlo de nuevo la deja como estaba: sin nombre y sin exigírselo
      await userEvent.clear(nombre);
      expect(nombre).not.toBeRequired();

      await userEvent.type(nombre, 'Vera Vieja');
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar' }));
      await waitFor(() => expect(cuerpoDe('/users/viejo3', 'PATCH')).toEqual({ fullName: 'Vera Vieja' }));
    });

    it('a una cuenta que ya tiene nombre no se le puede vaciar', async () => {
      const dialogo = await abrirEdicion(OPER1);
      const nombre = within(dialogo).getByLabelText('Nombre y apellido');
      expect(nombre).toBeRequired();

      await userEvent.clear(nombre);
      expect(nombre).toBeRequired();
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar' }));
      expect(apiMock).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Editar a oper1' })).toBeInTheDocument();
    });

    it('el rechazo del backend queda adentro del diálogo, que sigue abierto', async () => {
      const espera = pendiente<unknown>();
      apiMock.mockReturnValue(espera.promesa as Promise<never>);
      const dialogo = await abrirEdicion(OPER1);
      const d = within(dialogo);
      await userEvent.clear(d.getByLabelText('DNI'));
      await userEvent.type(d.getByLabelText('DNI'), '28999111');
      await userEvent.click(d.getByRole('button', { name: 'Guardar' }));

      expect(await d.findByRole('button', { name: 'Guardando…' })).toBeDisabled();
      espera.rechazar(new Error('Ese DNI ya está registrado a nombre de beto'));

      expect(await d.findByRole('alert')).toHaveTextContent('Ese DNI ya está registrado a nombre de beto');
      expect(d.getByLabelText('DNI')).toHaveValue('28999111');
      expect(d.getByRole('button', { name: 'Guardar' })).toBeEnabled();
    });

    it('el rol de otro administrador no se cambia: el select queda fijo y explicado', async () => {
      const otroAdmin = makeUser({ username: 'admin2', role: 'admin', fullName: 'Otra Admin', dni: '20333444' });
      const dialogo = await abrirEdicion(otroAdmin);
      const rol = within(dialogo).getByLabelText('Rol');
      expect(rol).toBeDisabled();
      expect(rol).toHaveValue('admin');
      expect(within(rol).getAllByRole('option')).toHaveLength(1);
      expect(within(dialogo).getByText(/El rol de un administrador no se cambia/)).toBeInTheDocument();
    });

    it('la cruz y Cancelar cierran sin guardar', async () => {
      let dialogo = await abrirEdicion(OPER1);
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Cerrar sin guardar' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Editar a oper1' }));
      dialogo = await screen.findByRole('dialog', { name: 'Editar a oper1' });
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(apiMock).not.toHaveBeenCalled();
    });

    it('el supervisor sólo cambia el permiso de control: el resto de la ficha se ve bloqueado', async () => {
      const dialogo = await abrirEdicion(OPER1, 'supervisor', 'super1');
      const d = within(dialogo);
      expect(d.getByText(/Como supervisor podés autorizar o suspender/)).toBeInTheDocument();
      for (const campo of ['Nombre y apellido', 'DNI', 'Rol', 'Cuenta activa']) {
        expect(d.getByLabelText(campo), campo).toBeDisabled();
      }

      await userEvent.click(d.getByLabelText('Puede controlar drones'));
      await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
      await waitFor(() => expect(cuerpoDe('/users/oper1', 'PATCH')).toEqual({ canControl: false }));
    });
  });

  describe('permisos', () => {
    it('el supervisor no ve el alta ni el borrado, y sólo edita y suspende operadores', async () => {
      servir([
        makeUser({ username: 'oper1', role: 'operator' }),
        makeUser({ username: 'super2', role: 'supervisor' }),
      ]);
      montar('supervisor', 'super1');
      await screen.findByText('oper1');

      expect(screen.queryByRole('button', { name: 'Nuevo usuario' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Desactivar' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Regenerar contraseña' })).not.toBeInTheDocument();
      expect(within(fila('oper1')).getByRole('button', { name: 'Suspender' })).toBeInTheDocument();
      expect(within(fila('oper1')).getByRole('button', { name: 'Editar a oper1' })).toBeInTheDocument();
      expect(within(fila('super2')).queryByRole('button', { name: 'Suspender' })).not.toBeInTheDocument();
      expect(within(fila('super2')).queryByRole('button', { name: /^Editar/ })).not.toBeInTheDocument();
    });

    it('sin rango de supervisor no se ofrece ver los eliminados ni editar', async () => {
      servir([makeUser({ username: 'oper1' })]);
      montar('operator', 'oper1');
      await screen.findByText('oper1');

      expect(screen.queryByRole('button', { name: 'Ver eliminados' })).not.toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Acciones' })).not.toBeInTheDocument();
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
    const dialogo = await screen.findByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Suspender' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('No autorizado');
  });

  it('el error de lo que no pregunta (autorizar) queda arriba de la tabla', async () => {
    servir([makeUser({ username: 'admin1', role: 'admin' }), makeUser({ username: 'oper1', canControl: false })]);
    apiMock.mockRejectedValue(new Error('No autorizado'));
    montar();
    await screen.findByText('oper1');

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Autorizar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No autorizado');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('UsersView — avisos de lo que salió bien', () => {
  const ADMIN = makeUser({ username: 'admin1', role: 'admin' });

  function montarConAvisos() {
    return render(
      <ProveedorDeAvisos>
        <UsersView me={makeMe({ username: 'admin1', role: 'admin' })} />
      </ProveedorDeAvisos>,
    );
  }
  const aviso = () => document.querySelector('.avisos-flotantes') as HTMLElement;

  async function confirmar(boton: string) {
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: boton }));
  }

  it('suspender, desactivar y eliminar lo dicen', async () => {
    servir([ADMIN, makeUser({ username: 'oper1', canControl: true, active: true })]);
    apiMock.mockResolvedValue({});
    montarConAvisos();
    await screen.findByText('oper1');

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Suspender' }));
    await confirmar('Suspender');
    await waitFor(() => expect(aviso()).toHaveTextContent('Control de oper1 suspendido.'));

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Desactivar' }));
    await confirmar('Desactivar');
    await waitFor(() => expect(aviso()).toHaveTextContent('Cuenta de oper1 desactivada.'));

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Eliminar' }));
    await confirmar('Eliminar');
    await waitFor(() => expect(aviso()).toHaveTextContent('Cuenta de oper1 eliminada.'));
  });

  it('lo que no pregunta también avisa: autorizar, reactivar y restaurar', async () => {
    servir([ADMIN, makeUser({ username: 'oper1', canControl: false, active: false })]);
    apiMock.mockResolvedValue({});
    montarConAvisos();
    await screen.findByText('oper1');

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Autorizar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('oper1 puede volver a controlar drones.'));

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Reactivar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Cuenta de oper1 reactivada.'));

    servir([ADMIN, makeUser({ username: 'oper1', deleted: true, deletedAt: BORRADO })]);
    await userEvent.click(screen.getByRole('button', { name: 'Ver eliminados' }));
    await userEvent.click(await within(fila('oper1')).findByRole('button', { name: 'Restaurar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Cuenta de oper1 restaurada.'));
  });

  it('guardar la ficha lo dice', async () => {
    servir([ADMIN, makeUser({ username: 'oper1', fullName: 'Olga Operadora', dni: '30123456' })]);
    apiMock.mockResolvedValue({});
    montarConAvisos();
    await screen.findByText('oper1');

    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Editar a oper1' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Editar a oper1' });
    await userEvent.type(within(dialogo).getByLabelText('Nombre y apellido'), ' Pérez');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Cambios de oper1 guardados.'));
  });

  it('copiar la contraseña lo confirma, y si no se puede, lo dice al lado', async () => {
    servir([ADMIN, makeUser({ username: 'oper1' })]);
    apiMock.mockResolvedValue({ username: 'oper1', password: 'NUEVA-CLAVE' });
    const usuario = userEvent.setup();
    const escribir = vi.spyOn(navigator.clipboard, 'writeText');
    montarConAvisos();
    await screen.findByText('oper1');

    await usuario.click(within(fila('oper1')).getByRole('button', { name: 'Regenerar contraseña' }));
    await usuario.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Regenerar' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Contraseña regenerada' });

    await usuario.click(within(dialogo).getByRole('button', { name: 'Copiar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Contraseña copiada.'));

    escribir.mockRejectedValueOnce(new Error('denegado'));
    await usuario.click(within(dialogo).getByRole('button', { name: 'Copiar' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('copiala a mano');
  });

  it('sin portapapeles (fuera de un contexto seguro) también lo dice', async () => {
    servir([ADMIN, makeUser({ username: 'oper1' })]);
    apiMock.mockResolvedValue({ username: 'oper1', password: 'NUEVA-CLAVE' });
    montarConAvisos();
    await screen.findByText('oper1');
    await userEvent.click(within(fila('oper1')).getByRole('button', { name: 'Regenerar contraseña' }));
    await confirmar('Regenerar');
    const dialogo = await screen.findByRole('dialog', { name: 'Contraseña regenerada' });

    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    try {
      fireEvent.click(within(dialogo).getByRole('button', { name: 'Copiar' }));
      expect(await within(dialogo).findByRole('alert')).toHaveTextContent('No se pudo copiar');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

describe('UsersView — carga, vacío y tabla', () => {
  it('antes de la primera respuesta muestra el esqueleto, no que no hay usuarios', async () => {
    const espera = pendiente<UserView[]>();
    traerMock.mockReset();
    traerMock.mockReturnValue(espera.promesa);
    montar();
    expect(screen.getByRole('status')).toHaveTextContent('Trayendo los usuarios…');
    expect(screen.queryByText('No hay usuarios para mostrar.')).not.toBeInTheDocument();
    espera.resolver([]);
    expect(await screen.findByText('No hay usuarios para mostrar.')).toBeInTheDocument();
  });

  it('con una búsqueda sin resultados dice eso, y no que no hay usuarios', async () => {
    servir([ADMIN1], []);
    montar();
    await screen.findByText('admin1');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar usuarios' }), 'zzz');
    expect(await screen.findByText('Ningún usuario coincide con la búsqueda.')).toBeInTheDocument();
    expect(screen.queryByText('No hay usuarios para mostrar.')).not.toBeInTheDocument();
  });

  it('las acciones de cada fila van juntas en un grupo, como en las otras vistas', async () => {
    servir([ADMIN1, makeUser({ username: 'oper1' })]);
    montar();
    await screen.findByText('oper1');
    const grupo = within(fila('oper1')).getByRole('group', { name: 'Acciones de oper1' });
    expect(within(grupo).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Editar',
      'Regenerar contraseña',
      'Eliminar',
    ]);
    expect(screen.getByRole('columnheader', { name: 'Acciones' })).toHaveClass('columna-acciones');
  });

  it('la cabecera es la de todas las vistas: título, buscador y, al final, "Nuevo usuario"', async () => {
    servir([ADMIN1]);
    const { container } = montar();
    await screen.findByText('admin1');
    const cabecera = container.querySelector('.vista-cabecera') as HTMLElement;
    expect(within(cabecera).getByRole('heading', { name: 'Usuarios' })).toBeInTheDocument();
    expect(within(cabecera).getByRole('searchbox', { name: 'Buscar usuarios' })).toBeInTheDocument();
    expect(within(cabecera).getAllByRole('button').map((b) => b.textContent)).toEqual(['Ver eliminados', 'Nuevo usuario']);
  });
});
