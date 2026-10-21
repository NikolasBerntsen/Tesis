import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DronesView from './DronesView';
import { api, traerBases, traerDrones } from '../api';
import { makeDrone, makeMe } from '../test/fixtures';
import type { Drone, NovedadDron, RolConsola } from '../types';

// El QR se dibuja en el navegador con `qrcode`; el modal se prueba aparte.
const { generarQr } = vi.hoisted(() => ({ generarQr: vi.fn() }));
vi.mock('qrcode', () => ({ toDataURL: generarQr }));
vi.mock('../api', () => ({ api: vi.fn(), traerBases: vi.fn(async () => []),
  traerDrones: vi.fn() }));

const apiMock = vi.mocked(api);
const traerMock = vi.mocked(traerDrones);
const basesMock = vi.mocked(traerBases);
const escribirEnPortapapeles = vi.fn();

const HASH_ALFA = 'c54ae4a0aad98bdc6ae5ab810751335c';
const HASH_BRAVO = '9f8ce38c3f04a02cf3182cf1d2dc28e7';

function alfa(over: Partial<Drone> = {}): Drone {
  return makeDrone({ hash: HASH_ALFA, droneId: HASH_ALFA, displayName: 'Alfa', model: 'DJI Mini 3', ...over });
}

function bravo(over: Partial<Drone> = {}): Drone {
  return makeDrone({
    hash: HASH_BRAVO,
    droneId: HASH_BRAVO,
    displayName: 'Bravo',
    model: '',
    base: null,
    online: false,
    ...over,
  });
}

function montar(role: RolConsola = 'admin', novedad: NovedadDron | null = null) {
  return render(<DronesView me={makeMe({ username: 'admin1', role })} novedad={novedad} />);
}

/** La misma vista con una novedad del canal en vivo recién llegada. */
function conNovedad(novedad: NovedadDron) {
  return <DronesView me={makeMe({ username: 'admin1', role: 'supervisor' })} novedad={novedad} />;
}

/** La fila de la tabla que corresponde a un dron, por su nombre visible. */
function fila(nombre: string): HTMLElement {
  return screen.getByText(nombre, { selector: 'div' }).closest('tr') as HTMLElement;
}

/** El diálogo de alta o edición, por su título. */
function dialogo(titulo: 'Nuevo dron' | 'Editar dron'): HTMLElement {
  return screen.getByRole('dialog', { name: titulo });
}

async function abrirAlta() {
  await userEvent.click(screen.getByRole('button', { name: 'Nuevo dron' }));
  return dialogo('Nuevo dron');
}

async function abrirEdicion(nombre: string) {
  await userEvent.click(within(fila(nombre)).getByRole('button', { name: 'Editar' }));
  return dialogo('Editar dron');
}

beforeEach(() => {
  apiMock.mockReset();
  traerMock.mockReset();
  traerMock.mockResolvedValue([alfa()]);
  generarQr.mockReset();
  generarQr.mockResolvedValue('data:image/png;base64,QR');
  escribirEnPortapapeles.mockReset();
  escribirEnPortapapeles.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: escribirEnPortapapeles },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DronesView', () => {
  it('lista los drones con el identificador abreviado, el modelo y si están en línea', async () => {
    traerMock.mockResolvedValue([alfa(), bravo()]);
    montar();

    await screen.findByText('Alfa', { selector: 'div' });
    expect(traerMock).toHaveBeenCalledWith({ incluirEliminados: false });
    expect(within(fila('Alfa')).getByText('c54ae4…335c')).toBeInTheDocument();
    expect(within(fila('Alfa')).getByText('DJI Mini 3')).toBeInTheDocument();
    expect(within(fila('Alfa')).getByText('Sí')).toBeInTheDocument();
    // La base se muestra debajo del nombre; el modelo vacío queda con una raya.
    expect(within(fila('Alfa')).getByText('Base Norte')).toBeInTheDocument();
    expect(within(fila('Bravo')).getByText('—')).toBeInTheDocument();
    expect(within(fila('Bravo')).getByText('No')).toBeInTheDocument();
  });

  it('muestra el estado vacío cuando no hay drones, con qué hacer para dar uno de alta', async () => {
    traerMock.mockResolvedValue([]);
    montar();

    expect(await screen.findByText('Todavía no hay drones dados de alta.')).toBeInTheDocument();
    expect(screen.getByText(/Con «Nuevo dron» se da de alta/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('al operador, el estado vacío no le ofrece un alta que no puede hacer', async () => {
    traerMock.mockResolvedValue([]);
    montar('operator');

    expect(await screen.findByText(/Cuando un supervisor o un operador de campo dé de alta uno/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuevo dron' })).not.toBeInTheDocument();
  });

  it('muestra el error si falla la carga, sin contradecirlo con el estado vacío', async () => {
    traerMock.mockRejectedValue(new Error('Sin permiso'));
    montar();

    expect(await screen.findByRole('alert')).toHaveTextContent('Sin permiso');
    expect(screen.queryByText('Todavía no hay drones dados de alta.')).not.toBeInTheDocument();
    expect(screen.queryByText('Trayendo los drones…')).not.toBeInTheDocument();
  });

  it('copia el identificador completo, no el abreviado', async () => {
    montar();
    await screen.findByText('Alfa', { selector: 'div' });

    await userEvent.click(screen.getByRole('button', { name: 'Copiar el identificador de Alfa' }));
    expect(escribirEnPortapapeles).toHaveBeenCalledWith(HASH_ALFA);
    expect(await screen.findByText('Copiado')).toBeInTheDocument();
  });

  it('avisa si el navegador no deja copiar', async () => {
    escribirEnPortapapeles.mockRejectedValue(new Error('sin permiso'));
    montar();
    await screen.findByText('Alfa', { selector: 'div' });

    await userEvent.click(screen.getByRole('button', { name: 'Copiar el identificador de Alfa' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo copiar el identificador');
  });




  it('el alta ya no vive en la página: se abre en un diálogo desde la cabecera', async () => {
    montar();
    await screen.findByText('Alfa', { selector: 'div' });

    // nada de formularios desplegados en la vista
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const alta = await abrirAlta();
    // y el foco arranca en el nombre, que es lo primero que hay que escribir
    expect(within(alta).getByLabelText('Nombre')).toHaveFocus();
  });

  it('da de alta un dron con inventario y base elegida del desplegable, y abre su sticker', async () => {
    traerMock.mockResolvedValue([]);
    basesMock.mockResolvedValue([
      { id: 7, name: 'Base Norte', lat: -34.85, lon: -56.2, active: true, createdAt: '', createdBy: null, deleted: false, deletedAt: null },
      { id: 8, name: 'Base Sur', lat: -34.9, lon: -56.1, active: true, createdAt: '', createdBy: null, deleted: false, deletedAt: null },
    ]);
    apiMock.mockResolvedValue(makeDrone({ hash: 'nuevo', droneId: 'nuevo', displayName: 'Delta' }));
    render(<DronesView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText(/todavía no hay drones/i);

    const alta = await abrirAlta();
    await userEvent.type(within(alta).getByLabelText('Nombre'), 'Delta');
    await userEvent.type(within(alta).getByLabelText('Número de inventario'), 'INV-9');

    // el buscador filtra a medida que se escribe
    await userEvent.type(within(alta).getByLabelText('Buscar base'), 'sur');
    expect(within(alta).queryByRole('option', { name: /Base Norte/ })).not.toBeInTheDocument();
    await userEvent.click(within(alta).getByRole('option', { name: /Base Sur/ }));

    await userEvent.click(within(alta).getByRole('button', { name: 'Dar de alta' }));

    expect(apiMock).toHaveBeenCalledWith('/drones', expect.objectContaining({ method: 'POST' }));
    const cuerpo = JSON.parse(apiMock.mock.calls.at(-1)![1].body);
    expect(cuerpo).toEqual({ displayName: 'Delta', model: '', inventoryCode: 'INV-9', baseId: 8 });
    // el diálogo del alta deja su lugar al sticker, que se abre solo
    expect(await screen.findByRole('dialog', { name: 'Sticker del dron Delta' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Nuevo dron' })).not.toBeInTheDocument();
    // y el dron nuevo ya está en la tabla, sin volver a pedir la lista
    expect(screen.getByText('Delta', { selector: 'div' })).toBeInTheDocument();
    expect(traerMock).toHaveBeenCalledTimes(1);
  });

  it('el alta sin base no manda baseId', async () => {
    traerMock.mockResolvedValue([]);
    basesMock.mockResolvedValue([]);
    apiMock.mockResolvedValue(makeDrone({ hash: 'nuevo' }));
    render(<DronesView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText(/todavía no hay drones/i);

    const alta = await abrirAlta();
    // y el selector avisa por qué no hay nada para elegir
    expect(within(alta).getByLabelText('Buscar base')).toBeDisabled();
    await userEvent.type(within(alta).getByLabelText('Nombre'), 'Sin base');
    await userEvent.click(within(alta).getByRole('button', { name: 'Dar de alta' }));

    const cuerpo = JSON.parse(apiMock.mock.calls.at(-1)![1].body);
    expect(cuerpo.baseId).toBeUndefined();
  });

  it('Enter en un campo da de alta, igual que el botón', async () => {
    apiMock.mockResolvedValue(makeDrone({ hash: 'nuevo', displayName: 'Eco' }));
    montar();
    await screen.findByText('Alfa', { selector: 'div' });

    const alta = await abrirAlta();
    await userEvent.type(within(alta).getByLabelText('Nombre'), 'Eco{Enter}');

    expect(apiMock).toHaveBeenCalledWith('/drones', expect.objectContaining({ method: 'POST' }));
  });

  it('la latitud y la longitud del dron no se pueden escribir a mano', async () => {
    traerMock.mockResolvedValue([]);
    basesMock.mockResolvedValue([]);
    render(<DronesView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText(/todavía no hay drones/i);

    const alta = await abrirAlta();
    // son un dato de la base, no del dron: no hay campos para tipearlas
    expect(within(alta).queryByLabelText('Latitud')).not.toBeInTheDocument();
    expect(within(alta).queryByLabelText('Longitud')).not.toBeInTheDocument();
  });

  it('muestra el error del backend adentro del diálogo de alta y lo deja abierto', async () => {
    apiMock.mockRejectedValue(new Error('displayName no puede superar 40 caracteres'));
    montar();
    await screen.findByText('Alfa', { selector: 'div' });

    const alta = await abrirAlta();
    await userEvent.type(within(alta).getByLabelText('Nombre'), 'Delta');
    await userEvent.click(within(alta).getByRole('button', { name: 'Dar de alta' }));

    expect(await within(alta).findByRole('alert')).toHaveTextContent('displayName no puede superar 40 caracteres');
    // lo escrito sigue ahí para corregirlo, y el sticker no se abrió
    expect(within(alta).getByLabelText('Nombre')).toHaveValue('Delta');
    expect(screen.queryByRole('dialog', { name: /sticker/i })).not.toBeInTheDocument();
  });

  it('cancelar el alta cierra el diálogo sin pegarle al backend', async () => {
    montar();
    await screen.findByText('Alfa', { selector: 'div' });

    const alta = await abrirAlta();
    await userEvent.type(within(alta).getByLabelText('Nombre'), 'A medias');
    await userEvent.click(within(alta).getByRole('button', { name: 'Cancelar' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
    // y reabrirlo arranca de cero
    expect(within(await abrirAlta()).getByLabelText('Nombre')).toHaveValue('');
  });

  it('el supervisor desactiva un dron con el interruptor', async () => {
    apiMock.mockResolvedValue(alfa({ active: false }));
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    await userEvent.click(within(fila('Alfa')).getByRole('checkbox'));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/drones/${HASH_ALFA}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: false }),
      }),
    );
    expect(await within(fila('Alfa')).findByText('No operativo')).toBeInTheDocument();
  });


  it('edita un dron sin base sin inventarle una', async () => {
    traerMock.mockResolvedValue([bravo()]);
    apiMock.mockResolvedValue(bravo({ model: 'DJI Air 3' }));
    montar('supervisor');
    await screen.findByText('Bravo', { selector: 'div' });

    const edicion = await abrirEdicion('Bravo');
    // el diálogo dice a qué dron se está editando
    expect(edicion).toHaveTextContent('Bravo');
    await userEvent.type(within(edicion).getByLabelText('Modelo'), 'DJI Air 3');
    await userEvent.click(within(edicion).getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/drones/${HASH_BRAVO}`, {
        method: 'PATCH',
        body: JSON.stringify({ model: 'DJI Air 3' }),
      }),
    );
    // guardado, el diálogo se cierra y la fila muestra la ficha que volvió
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(within(fila('Bravo')).getByText('DJI Air 3')).toBeInTheDocument();
  });

  it('la edición arranca con los datos del dron cargados', async () => {
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    const edicion = await abrirEdicion('Alfa');
    expect(within(edicion).getByLabelText('Nombre')).toHaveValue('Alfa');
    expect(within(edicion).getByLabelText('Modelo')).toHaveValue('DJI Mini 3');
    expect(within(edicion).getByLabelText('Número de inventario')).toHaveValue('INV-0001');
  });

  it('deja la edición abierta si el backend rechaza el cambio', async () => {
    apiMock.mockRejectedValue(new Error('Solo un supervisor puede modificar el activo'));
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    const edicion = await abrirEdicion('Alfa');
    await userEvent.type(within(edicion).getByLabelText('Modelo'), ' Pro');
    await userEvent.click(within(edicion).getByRole('button', { name: 'Guardar cambios' }));

    expect(await within(edicion).findByRole('alert')).toHaveTextContent('Solo un supervisor puede modificar el activo');
    expect(dialogo('Editar dron')).toBeInTheDocument();
  });

  it('se sale de la edición con Cancelar y con Escape, sin guardar', async () => {
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    let edicion = await abrirEdicion('Alfa');
    await userEvent.type(within(edicion).getByLabelText('Modelo'), ' Pro');
    await userEvent.click(within(edicion).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    edicion = await abrirEdicion('Alfa');
    // lo tipeado antes de cancelar no quedó guardado en ningún lado
    expect(within(edicion).getByLabelText('Modelo')).toHaveValue('DJI Mini 3');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('cierra la edición sin pegarle al backend si no se cambió nada', async () => {
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    const edicion = await abrirEdicion('Alfa');
    await userEvent.click(within(edicion).getByRole('button', { name: 'Guardar cambios' }));

    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('las acciones de cada fila van juntas y en el mismo orden: Editar, Ver QR, Eliminar', async () => {
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    const grupo = within(fila('Alfa')).getByRole('group', { name: 'Acciones de Alfa' });
    expect(within(grupo).getAllByRole('button').map((b) => b.textContent)).toEqual(['Editar', 'Ver QR', 'Eliminar']);
  });

  it('elimina un dron sólo si se confirma', async () => {
    apiMock.mockResolvedValue(alfa({ deleted: true, deletedAt: '2024-01-02T00:00:00.000Z' }));
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(within(fila('Alfa')).getByRole('button', { name: 'Eliminar' }));
    expect(apiMock).not.toHaveBeenCalled();

    confirmar.mockReturnValue(true);
    await userEvent.click(within(fila('Alfa')).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(`/drones/${HASH_ALFA}`, { method: 'DELETE' }));
    // Con el filtro por defecto, el dron eliminado desaparece de la tabla.
    await waitFor(() => expect(screen.queryByText('Alfa', { selector: 'div' })).not.toBeInTheDocument());
  });

  it('muestra el error si el backend rechaza una acción', async () => {
    apiMock.mockRejectedValue(new Error('El dron está eliminado: restauralo antes de modificarlo'));
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    await userEvent.click(within(fila('Alfa')).getByRole('checkbox'));
    expect(await screen.findByRole('alert')).toHaveTextContent('El dron está eliminado');
  });

  // La marca es la que manda: la fecha quedó como dato de auditoría y sola no
  // alcanza para dar por eliminada una fila.
  it('un dron con fecha de baja pero sin la marca se muestra como vivo', async () => {
    traerMock.mockResolvedValue([alfa({ deleted: false, deletedAt: '2024-01-02T00:00:00.000Z' })]);
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    expect(fila('Alfa')).not.toHaveClass('fila-eliminada');
    expect(within(fila('Alfa')).queryByText('Eliminado')).not.toBeInTheDocument();
  });

  it('el toggle de eliminados pide la lista completa y deja restaurar', async () => {
    const borrado = bravo({ deleted: true, deletedAt: '2024-01-02T00:00:00.000Z', active: false });
    traerMock.mockImplementation(({ incluirEliminados } = {}) =>
      Promise.resolve(incluirEliminados ? [alfa(), borrado] : [alfa()]),
    );
    apiMock.mockResolvedValue(bravo());
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });
    expect(screen.queryByText('Bravo', { selector: 'div' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Ver eliminados' }));
    await screen.findByText('Bravo', { selector: 'div' });
    expect(traerMock).toHaveBeenLastCalledWith({ incluirEliminados: true });
    expect(fila('Bravo')).toHaveClass('fila-eliminada');
    expect(within(fila('Bravo')).getByText('Eliminado')).toBeInTheDocument();
    // Un dron eliminado no se puede emparejar ni editar: sólo restaurar.
    expect(within(fila('Bravo')).queryByRole('button', { name: 'Ver QR' })).not.toBeInTheDocument();
    expect(within(fila('Bravo')).queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();

    await userEvent.click(within(fila('Bravo')).getByRole('button', { name: 'Restaurar' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(`/drones/${HASH_BRAVO}/restore`, { method: 'POST' }));
    await waitFor(() => expect(fila('Bravo')).not.toHaveClass('fila-eliminada'));

    await userEvent.click(screen.getByRole('button', { name: 'Ocultar eliminados' }));
    await waitFor(() => expect(traerMock).toHaveBeenLastCalledWith({ incluirEliminados: false }));
  });

  it('reabre el sticker de un dron ya dado de alta', async () => {
    montar('operator');
    await screen.findByText('Alfa', { selector: 'div' });

    await userEvent.click(within(fila('Alfa')).getByRole('button', { name: 'Ver QR' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Sticker del dron Alfa');
    await waitFor(() => expect(generarQr).toHaveBeenCalledWith(HASH_ALFA, expect.anything()));

    await userEvent.click(screen.getByRole('button', { name: 'Cerrar el sticker' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('se refresca con la ficha que llega por drone_updated, sin volver a pedir la lista', async () => {
    const { rerender } = montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    rerender(conNovedad({ tipo: 'ficha', drone: alfa({ displayName: 'Alfa renombrado', online: false }) }));

    expect(await screen.findByText('Alfa renombrado', { selector: 'div' })).toBeInTheDocument();
    expect(within(fila('Alfa renombrado')).getByText('No')).toBeInTheDocument();
    expect(traerMock).toHaveBeenCalledTimes(1);
  });

  it('suma a la tabla un dron que otra consola acaba de dar de alta', async () => {
    const { rerender } = montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    rerender(conNovedad({ tipo: 'ficha', drone: bravo() }));

    expect(await screen.findByText('Bravo', { selector: 'div' })).toBeInTheDocument();
  });

  it('se entera de que un dron se conectó y de que lo renombraron desde la app', async () => {
    const { rerender } = montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });
    expect(within(fila('Alfa')).getByText('Sí')).toBeInTheDocument();

    // `drone_online` y `drone_offline` traen la ficha entera
    rerender(conNovedad({ tipo: 'ficha', drone: alfa({ online: false }) }));
    await waitFor(() => expect(within(fila('Alfa')).getByText('No')).toBeInTheDocument());

    // El renombre que inicia la app llega sólo con el nombre nuevo
    rerender(conNovedad({ tipo: 'renombre', droneId: HASH_ALFA, displayName: 'Bravo' }));
    expect(await screen.findByText('Bravo', { selector: 'div' })).toBeInTheDocument();
    expect(screen.queryByText('Alfa', { selector: 'div' })).not.toBeInTheDocument();
    // Y ninguna de las dos novedades vuelve a pedir la lista entera
    expect(traerMock).toHaveBeenCalledTimes(1);
  });

  it('no afirma que no hay drones mientras el pedido está en vuelo', async () => {
    traerMock.mockReturnValue(new Promise(() => {}));
    montar();

    expect(await screen.findByText('Trayendo los drones…')).toBeInTheDocument();
    // Ese cartel es el que empuja a dar de alta un dron que ya existe
    expect(screen.queryByText('Todavía no hay drones dados de alta.')).not.toBeInTheDocument();
  });

  it('el operador de campo da de alta pero no toca el activo', async () => {
    montar('field_operator');
    await screen.findByText('Alfa', { selector: 'div' });

    expect(screen.getByRole('button', { name: 'Nuevo dron' })).toBeInTheDocument();
    expect(within(fila('Alfa')).getByRole('button', { name: 'Ver QR' })).toBeInTheDocument();
    expect(within(fila('Alfa')).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(fila('Alfa')).queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(within(fila('Alfa')).queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ver eliminados' })).not.toBeInTheDocument();
  });

  it('el operador sólo mira', async () => {
    traerMock.mockResolvedValue([alfa({ active: false })]);
    montar('operator');
    await screen.findByText('Alfa', { selector: 'div' });

    expect(screen.queryByRole('button', { name: 'Nuevo dron' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ver eliminados' })).not.toBeInTheDocument();
    expect(within(fila('Alfa')).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(fila('Alfa')).getByText('No operativo')).toBeInTheDocument();
    expect(within(fila('Alfa')).queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(within(fila('Alfa')).queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
  });

  it('el supervisor ve el toggle y los botones de gestión', async () => {
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    expect(screen.getByRole('button', { name: 'Ver eliminados' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nuevo dron' })).toBeInTheDocument();
    expect(within(fila('Alfa')).getByRole('checkbox')).toBeInTheDocument();
    expect(within(fila('Alfa')).getByRole('button', { name: 'Editar' })).toBeInTheDocument();
    expect(within(fila('Alfa')).getByRole('button', { name: 'Eliminar' })).toBeInTheDocument();
  });
});
