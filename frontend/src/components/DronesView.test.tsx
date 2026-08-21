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

function formulario(nombre: string): HTMLElement {
  return screen.getByRole('form', { name: nombre });
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

  it('muestra el estado vacío cuando no hay drones', async () => {
    traerMock.mockResolvedValue([]);
    montar();

    expect(await screen.findByText('Todavía no hay drones dados de alta.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
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




  it('da de alta un dron con inventario y base elegida del desplegable', async () => {
    traerMock.mockResolvedValue([]);
    basesMock.mockResolvedValue([
      { id: 7, name: 'Base Norte', lat: -34.85, lon: -56.2, active: true, createdAt: '', createdBy: null, deleted: false, deletedAt: null },
      { id: 8, name: 'Base Sur', lat: -34.9, lon: -56.1, active: true, createdAt: '', createdBy: null, deleted: false, deletedAt: null },
    ]);
    apiMock.mockResolvedValue(makeDrone({ hash: 'nuevo', displayName: 'Delta' }));
    render(<DronesView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText(/todavía no hay drones/i);

    await userEvent.type(screen.getByLabelText('Nombre'), 'Delta');
    await userEvent.type(screen.getByLabelText('Número de inventario'), 'INV-9');

    // el buscador filtra a medida que se escribe
    const buscador = screen.getByLabelText('Buscar base');
    await userEvent.type(buscador, 'sur');
    expect(screen.queryByRole('option', { name: /Base Norte/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: /Base Sur/ }));

    await userEvent.click(screen.getByRole('button', { name: /dar de alta/i }));

    expect(apiMock).toHaveBeenCalledWith('/drones', expect.objectContaining({ method: 'POST' }));
    const cuerpo = JSON.parse(apiMock.mock.calls.at(-1)![1].body);
    expect(cuerpo).toEqual({ displayName: 'Delta', model: '', inventoryCode: 'INV-9', baseId: 8 });
    // el sticker se abre solo
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('el alta sin base no manda baseId', async () => {
    traerMock.mockResolvedValue([]);
    basesMock.mockResolvedValue([]);
    apiMock.mockResolvedValue(makeDrone({ hash: 'nuevo' }));
    render(<DronesView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText(/todavía no hay drones/i);

    await userEvent.type(screen.getByLabelText('Nombre'), 'Sin base');
    await userEvent.click(screen.getByRole('button', { name: /dar de alta/i }));

    const cuerpo = JSON.parse(apiMock.mock.calls.at(-1)![1].body);
    expect(cuerpo.baseId).toBeUndefined();
    // y el selector avisa por qué no hay nada para elegir
    expect(screen.getByLabelText('Buscar base')).toBeDisabled();
  });

  it('la latitud y la longitud del dron no se pueden escribir a mano', async () => {
    traerMock.mockResolvedValue([]);
    basesMock.mockResolvedValue([]);
    render(<DronesView me={makeMe({ username: 'admin1', role: 'admin' })} />);
    await screen.findByText(/todavía no hay drones/i);

    // son un dato de la base, no del dron: no hay campos para tipearlas
    expect(screen.queryByLabelText('Latitud')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Longitud')).not.toBeInTheDocument();
  });

  it('muestra el error del backend al dar de alta', async () => {
    apiMock.mockRejectedValue(new Error('displayName no puede superar 40 caracteres'));
    montar();
    await screen.findByText('Alfa', { selector: 'div' });

    const alta = formulario('Dar de alta un dron');
    await userEvent.type(within(alta).getByLabelText('Nombre'), 'Delta');
    await userEvent.click(within(alta).getByRole('button', { name: 'Dar de alta' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('displayName no puede superar 40 caracteres');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

    await userEvent.click(within(fila('Bravo')).getByRole('button', { name: 'Editar' }));
    await userEvent.type(within(formulario('Editar Bravo')).getByLabelText('Modelo'), 'DJI Air 3');
    await userEvent.click(within(formulario('Editar Bravo')).getByRole('button', { name: 'Guardar' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/drones/${HASH_BRAVO}`, {
        method: 'PATCH',
        body: JSON.stringify({ model: 'DJI Air 3' }),
      }),
    );
  });


  it('deja la edición abierta si el backend rechaza el cambio', async () => {
    apiMock.mockRejectedValue(new Error('Solo un supervisor puede modificar el activo'));
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    await userEvent.click(within(fila('Alfa')).getByRole('button', { name: 'Editar' }));
    await userEvent.type(within(formulario('Editar Alfa')).getByLabelText('Modelo'), ' Pro');
    await userEvent.click(within(formulario('Editar Alfa')).getByRole('button', { name: 'Guardar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Solo un supervisor puede modificar el activo');
    expect(formulario('Editar Alfa')).toBeInTheDocument();
  });

  it('se sale de la edición con Cancelar y con el mismo botón de Editar', async () => {
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    await userEvent.click(within(fila('Alfa')).getByRole('button', { name: 'Editar' }));
    await userEvent.click(within(formulario('Editar Alfa')).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('form', { name: 'Editar Alfa' })).not.toBeInTheDocument();

    await userEvent.click(within(fila('Alfa')).getByRole('button', { name: 'Editar' }));
    await userEvent.click(within(fila('Alfa')).getByRole('button', { name: 'Editar' }));
    expect(screen.queryByRole('form', { name: 'Editar Alfa' })).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('cierra la edición sin pegarle al backend si no se cambió nada', async () => {
    montar('supervisor');
    await screen.findByText('Alfa', { selector: 'div' });

    await userEvent.click(within(fila('Alfa')).getByRole('button', { name: 'Editar' }));
    await userEvent.click(within(formulario('Editar Alfa')).getByRole('button', { name: 'Guardar' }));

    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('form', { name: 'Editar Alfa' })).not.toBeInTheDocument();
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

    expect(formulario('Dar de alta un dron')).toBeInTheDocument();
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

    expect(screen.queryByRole('form', { name: 'Dar de alta un dron' })).not.toBeInTheDocument();
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
    expect(formulario('Dar de alta un dron')).toBeInTheDocument();
    expect(within(fila('Alfa')).getByRole('checkbox')).toBeInTheDocument();
    expect(within(fila('Alfa')).getByRole('button', { name: 'Editar' })).toBeInTheDocument();
    expect(within(fila('Alfa')).getByRole('button', { name: 'Eliminar' })).toBeInTheDocument();
  });
});
