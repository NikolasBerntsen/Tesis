import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, rutasDeBase, traerBases, traerRutas } from '../api';
import { nombresDeBotones } from '../test/botones';
import { makeMe } from '../test/fixtures';
import { estadoMapa, fondosPuestos, limpiarEstadoMapa, pintarComoLeaflet } from '../test/dobleLeaflet';
import { ProveedorDeAvisos } from './AvisosFlotantes';
import BasesView from './BasesView';

vi.mock('../api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  api: vi.fn(),
  traerBases: vi.fn(),
  traerRutas: vi.fn(async () => []),
  rutasDeBase: vi.fn(async () => []),
}));
vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());

const apiMock = vi.mocked(api);
const basesMock = vi.mocked(traerBases);
const rutasMock = vi.mocked(traerRutas);
const rutasDeBaseMock = vi.mocked(rutasDeBase);
const ADMIN = makeMe({ username: 'admin1', role: 'admin' });
const CAMPO = makeMe({ username: 'campo1', role: 'field_operator' });
const OPERADOR = makeMe({ username: 'oper1', role: 'operator' });

function base(over: Partial<{ id: number; name: string; lat: number; lon: number; active: boolean; deleted: boolean; deletedAt: string | null }> = {}) {
  return {
    id: 1, name: 'Base Norte', lat: -34.8565, lon: -56.2075,
    active: true, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'admin1', deleted: false, deletedAt: null,
    ...over,
  };
}

describe('BasesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  it('lista las bases con sus coordenadas', async () => {
    basesMock.mockResolvedValue([base(), base({ id: 2, name: 'Base Sur', lat: -34.9, lon: -56.1 })]);
    render(<BasesView me={ADMIN} />);

    expect(await screen.findByText('Base Norte')).toBeInTheDocument();
    expect(screen.getByText('-34.85650, -56.20750')).toBeInTheDocument();
    expect(screen.getByText('Base Sur')).toBeInTheDocument();
  });

  it('distingue "todavía no llegó" de "no hay ninguna"', async () => {
    let resolver: (v: never[]) => void = () => {};
    basesMock.mockReturnValue(new Promise((r) => { resolver = r as (v: never[]) => void; }));
    render(<BasesView me={ADMIN} />);

    expect(screen.getByText(/trayendo las bases/i)).toBeInTheDocument();
    resolver([]);
    expect(await screen.findByText(/todavía no hay bases/i)).toBeInTheDocument();
  });

  it('muestra el error del backend sin afirmar que no hay bases', async () => {
    basesMock.mockRejectedValue(new Error('sin permiso'));
    render(<BasesView me={ADMIN} />);

    expect(await screen.findByText(/sin permiso/)).toBeInTheDocument();
    expect(screen.queryByText(/todavía no hay bases/i)).not.toBeInTheDocument();
  });

  it('el operador de campo puede dar de alta, el operador común no', async () => {
    basesMock.mockResolvedValue([base()]);
    const { unmount } = render(<BasesView me={CAMPO} />);
    expect(await screen.findByRole('button', { name: /nueva base/i })).toBeInTheDocument();
    unmount();

    render(<BasesView me={OPERADOR} />);
    await screen.findByText('Base Norte');
    expect(screen.queryByRole('button', { name: /nueva base/i })).not.toBeInTheDocument();
  });

  it('sólo el supervisor edita y elimina', async () => {
    basesMock.mockResolvedValue([base()]);
    const { unmount } = render(<BasesView me={CAMPO} />);
    await screen.findByText('Base Norte');
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ver eliminadas/i })).not.toBeInTheDocument();
    unmount();

    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');
    expect(screen.getByRole('button', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Eliminar' })).toBeInTheDocument();
  });

  it('el toggle de eliminadas pide la lista completa y ofrece restaurar', async () => {
    basesMock.mockResolvedValue([base()]);
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');
    expect(basesMock).toHaveBeenCalledWith({ incluirEliminadas: false });

    basesMock.mockResolvedValue([base({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' })]);
    await userEvent.click(screen.getByRole('button', { name: /ver eliminadas/i }));

    expect(basesMock).toHaveBeenLastCalledWith({ incluirEliminadas: true });
    expect(await screen.findByText('Eliminada')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restaurar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
  });

  it('el alta manda nombre y coordenadas, y espera a que estén completas', async () => {
    basesMock.mockResolvedValue([]);
    apiMock.mockResolvedValue(base({ id: 9, name: 'Base Río' }));
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);

    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    const dialogo = screen.getByRole('dialog');
    const guardar = within(dialogo).getByRole('button', { name: /dar de alta/i });
    expect(guardar).toBeDisabled();

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');
    expect(guardar).toBeDisabled(); // falta la coordenada

    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.9');
    await userEvent.type(within(dialogo).getByLabelText('Longitud'), '-56.15');
    expect(guardar).toBeEnabled();

    await userEvent.click(guardar);
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1].body)).toEqual({ name: 'Base Río', lat: -34.9, lon: -56.15 });
  });

  it('clickear el mapa completa las dos coordenadas', async () => {
    basesMock.mockResolvedValue([]);
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));

    expect(estadoMapa.clic).not.toBeNull();
    estadoMapa.clic!({ latlng: { lat: -34.123456, lng: -56.654321 } });

    expect(await screen.findByDisplayValue('-34.123456')).toBeInTheDocument();
    expect(screen.getByDisplayValue('-56.654321')).toBeInTheDocument();
  });

  it('"usar mi ubicación" completa con el GPS del dispositivo', async () => {
    basesMock.mockResolvedValue([]);
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: -34.5, longitude: -56.5 } }) },
      configurable: true,
    });
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    await userEvent.click(screen.getByRole('button', { name: /usar mi ubicación/i }));

    expect(await screen.findByDisplayValue('-34.500000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('-56.500000')).toBeInTheDocument();
  });

  it('si el dispositivo no informa ubicación lo dice y no bloquea el alta', async () => {
    basesMock.mockResolvedValue([]);
    const real = navigator.geolocation;
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    await userEvent.click(screen.getByRole('button', { name: /usar mi ubicación/i }));

    expect(await screen.findByText(/no informa su ubicación/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Latitud')).toBeEnabled();
    Object.defineProperty(navigator, 'geolocation', { value: real, configurable: true });
  });

  it('editar precarga los datos de la base y manda un PATCH', async () => {
    basesMock.mockResolvedValue([base()]);
    apiMock.mockResolvedValue(base({ name: 'Base Norte II' }));
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const dialogo = screen.getByRole('dialog');
    expect(within(dialogo).getByLabelText('Nombre')).toHaveValue('Base Norte');
    expect(within(dialogo).getByLabelText('Latitud')).toHaveValue('-34.8565');

    await userEvent.clear(within(dialogo).getByLabelText('Nombre'));
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Norte II');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));

    expect(apiMock).toHaveBeenCalledWith('/bases/1', expect.objectContaining({ method: 'PATCH' }));
    // guardado, el diálogo se cierra y la lista se vuelve a pedir
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(basesMock).toHaveBeenCalledTimes(2);
  });

  it('desactivar y eliminar preguntan antes y pegan a los endpoints que corresponden', async () => {
    basesMock.mockResolvedValue([base()]);
    apiMock.mockResolvedValue(base());
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    let dialogo = await screen.findByRole('dialog', { name: 'Desactivar la base Base Norte' });
    expect(dialogo).toHaveTextContent('no se le puede asignar a ningún dron');
    expect(apiMock).not.toHaveBeenCalled();
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Desactivar' }));
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1].body)).toEqual({ active: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    dialogo = await screen.findByRole('dialog', { name: 'Eliminar la base Base Norte' });
    expect(dialogo).toHaveTextContent('La baja se puede deshacer');
    expect(apiMock).not.toHaveBeenCalledWith('/bases/1', { method: 'DELETE' });
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    expect(apiMock).toHaveBeenLastCalledWith('/bases/1', { method: 'DELETE' });
  });

  it('eliminar sin confirmar no borra nada (antes era un solo clic)', async () => {
    basesMock.mockResolvedValue([base()]);
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('muestra el error del backend al intentar eliminar una base en uso, adentro de la pregunta', async () => {
    basesMock.mockResolvedValue([base()]);
    apiMock.mockRejectedValue(new Error('La base tiene 2 drones asignados: reasignalos antes de eliminarla'));
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    const dialogo = await screen.findByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent(/2 drones asignados/);
    // Sigue abierta: se puede cancelar e ir a reasignar los drones.
    expect(within(dialogo).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
  });
});

describe('BasesView — caminos que faltaban cubrir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  it('el marcador sigue a la coordenada y se va si se borra', async () => {
    basesMock.mockResolvedValue([]);
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));

    const lat = screen.getByLabelText('Latitud');
    const lon = screen.getByLabelText('Longitud');
    await userEvent.type(lat, '-34.9');
    await userEvent.type(lon, '-56.1');
    // mover el punto reusa el marcador en vez de crear otro
    await userEvent.clear(lat);
    await userEvent.type(lat, '-34.8');
    expect(screen.getByDisplayValue('-34.8')).toBeInTheDocument();
    // y vaciarlo lo saca del mapa
    await userEvent.clear(lat);
    expect(screen.getByRole('button', { name: /dar de alta/i })).toBeDisabled();
  });

  it('una coordenada fuera de rango no habilita el alta', async () => {
    basesMock.mockResolvedValue([]);
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));

    await userEvent.type(screen.getByLabelText('Nombre'), 'Imposible');
    await userEvent.type(screen.getByLabelText('Latitud'), '95');
    await userEvent.type(screen.getByLabelText('Longitud'), '-56.1');
    expect(screen.getByRole('button', { name: /dar de alta/i })).toBeDisabled();
  });

  it('se cancela el alta sin pegarle al backend', async () => {
    basesMock.mockResolvedValue([]);
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('si el GPS falla lo dice y deja seguir a mano', async () => {
    basesMock.mockResolvedValue([]);
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition: (_ok: unknown, err: () => void) => err() },
      configurable: true,
    });
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    await userEvent.click(screen.getByRole('button', { name: /usar mi ubicación/i }));

    expect(await screen.findByText(/no se pudo leer la ubicación/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Latitud')).toBeEnabled();
  });

  it('restaurar una base eliminada pega al endpoint de restauración', async () => {
    basesMock.mockResolvedValue([base({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' })]);
    apiMock.mockResolvedValue(base());
    render(<BasesView me={ADMIN} />);
    await userEvent.click(await screen.findByRole('button', { name: /ver eliminadas/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restaurar' }));

    expect(apiMock).toHaveBeenLastCalledWith('/bases/1/restore', { method: 'POST' });
  });
});

describe('BasesView — el alta y la edición son un diálogo de formulario', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  async function abrirAlta() {
    basesMock.mockResolvedValue([]);
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    return screen.getByRole('dialog', { name: 'Nueva base' });
  }

  async function abrirEdicion() {
    basesMock.mockResolvedValue([base()]);
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    return screen.getByRole('dialog', { name: 'Editar base' });
  }

  it('el estado vacío dice cómo dar de alta la primera', async () => {
    await abrirAlta();
    expect(screen.getByText(/Con «Nueva base» la das de alta/)).toBeInTheDocument();
  });

  it('al operador común el estado vacío no le ofrece un alta que no puede hacer', async () => {
    basesMock.mockResolvedValue([]);
    render(<BasesView me={OPERADOR} />);

    expect(await screen.findByText(/Las bases las dan de alta los operadores de campo/)).toBeInTheDocument();
  });

  it('el foco arranca en el nombre', async () => {
    const dialogo = await abrirAlta();
    expect(within(dialogo).getByLabelText('Nombre')).toHaveFocus();
  });

  it('el pie dice qué falta mientras el botón está apagado', async () => {
    const dialogo = await abrirAlta();
    expect(within(dialogo).getByText('Faltan el nombre y el punto de la base.')).toBeInTheDocument();

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');
    expect(within(dialogo).getByText(/Falta el punto: marcalo en el mapa/)).toBeInTheDocument();

    await userEvent.clear(within(dialogo).getByLabelText('Nombre'));
    act(() => estadoMapa.clic!({ latlng: { lat: -34.9, lng: -56.15 } }));
    expect(within(dialogo).getByText('Falta el nombre de la base.')).toBeInTheDocument();

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');
    expect(within(dialogo).queryByText(/^Falta/)).not.toBeInTheDocument();
    expect(within(dialogo).getByRole('button', { name: 'Dar de alta' })).toBeEnabled();
  });

  it('una coordenada fuera de rango se marca en el campo y explica el rango', async () => {
    const dialogo = await abrirAlta();
    const lat = within(dialogo).getByLabelText('Latitud');
    const lon = within(dialogo).getByLabelText('Longitud');

    await userEvent.type(lat, '95');
    expect(lat).toHaveAttribute('aria-invalid', 'true');
    expect(lat).toHaveAccessibleDescription(/la latitud va de -90 a 90/i);
    expect(lon).toHaveAttribute('aria-invalid', 'false');

    await userEvent.clear(lat);
    await userEvent.type(lon, 'oeste');
    expect(lon).toHaveAttribute('aria-invalid', 'true');
    expect(lat).toHaveAttribute('aria-invalid', 'false');

    await userEvent.clear(lon);
    expect(within(dialogo).queryByText(/la latitud va de -90 a 90/i)).not.toBeInTheDocument();
  });

  it('Enter en un campo da de alta, igual que el botón', async () => {
    apiMock.mockResolvedValue(base({ id: 9, name: 'Base Río' }));
    const dialogo = await abrirAlta();

    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.9');
    await userEvent.type(within(dialogo).getByLabelText('Longitud'), '-56.15');
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río{Enter}');

    expect(apiMock).toHaveBeenCalledWith('/bases', expect.objectContaining({ method: 'POST' }));
  });

  it('un formulario incompleto no se manda aunque el navegador lo intente', async () => {
    const dialogo = await abrirAlta();
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');

    fireEvent.submit(within(dialogo).getByLabelText('Nombre').closest('form')!);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('si el backend rechaza el alta, el error se lee adentro del diálogo, que sigue abierto', async () => {
    apiMock.mockRejectedValue(new Error('Ya existe una base con ese nombre'));
    const dialogo = await abrirAlta();

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');
    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.9');
    await userEvent.type(within(dialogo).getByLabelText('Longitud'), '-56.15');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Dar de alta' }));

    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('Ya existe una base con ese nombre');
    expect(within(dialogo).getByLabelText('Nombre')).toHaveValue('Base Río');
    // y el botón vuelve a estar disponible para reintentar
    expect(within(dialogo).getByRole('button', { name: 'Dar de alta' })).toBeEnabled();
    // no se pasó al paso de las rutas
    expect(screen.queryByText(/quedó dada de alta/i)).not.toBeInTheDocument();
  });

  it('si el backend rechaza la edición, el error también queda adentro', async () => {
    apiMock.mockRejectedValue(new Error('La base está eliminada'));
    const dialogo = await abrirEdicion();
    // el subtítulo dice cuál se está editando
    expect(dialogo).toHaveTextContent('Base Norte');

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), ' II');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));

    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('La base está eliminada');
    expect(screen.getByRole('dialog', { name: 'Editar base' })).toBeInTheDocument();
  });

  it('un rechazo que no es un Error igual se lee en el diálogo', async () => {
    apiMock.mockRejectedValue('sin conexión');
    const dialogo = await abrirEdicion();

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('sin conexión');
  });

  it('mientras guarda, el botón no deja mandar dos veces', async () => {
    apiMock.mockReturnValue(new Promise(() => {}));
    const dialogo = await abrirEdicion();

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));
    expect(within(dialogo).getByRole('button', { name: 'Guardando…' })).toBeDisabled();
  });

  it('con el alta en viaje el diálogo no se deja cerrar, y al volver pasa a las rutas de esa base', async () => {
    let contestar: (b: ReturnType<typeof base>) => void = () => {};
    apiMock.mockReturnValue(new Promise((r) => (contestar = r as typeof contestar)));
    const dialogo = await abrirAlta();

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');
    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.9');
    await userEvent.type(within(dialogo).getByLabelText('Longitud'), '-56.15');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Dar de alta' }));

    // el pedido ya salió: cancelar no lo deshace, así que no se ofrece
    expect(within(dialogo).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(within(dialogo).getByRole('button', { name: 'Cerrar' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    const velo = dialogo.parentElement!;
    fireEvent.mouseDown(velo);
    fireEvent.click(velo);
    expect(screen.getByRole('dialog', { name: 'Nueva base' })).toBeInTheDocument();

    await act(async () => contestar(base({ id: 9, name: 'Base Río' })));
    expect(await screen.findByRole('dialog', { name: 'Rutas de Base Río' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Nueva base' })).not.toBeInTheDocument();
  });

  it('si el alta en viaje falla, se vuelve a poder cancelar', async () => {
    let fallar: (e: Error) => void = () => {};
    apiMock.mockReturnValue(new Promise((_, rechazar) => (fallar = rechazar)));
    const dialogo = await abrirAlta();

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');
    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.9');
    await userEvent.type(within(dialogo).getByLabelText('Longitud'), '-56.15');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Dar de alta' }));
    await act(async () => fallar(new Error('Ya existe una base con ese nombre')));

    expect(within(dialogo).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('un diálogo que se abre mientras la lista se recarga no nace "Guardando…"', async () => {
    apiMock.mockResolvedValue(base({ name: 'Base Norte II' }));
    const dialogo = await abrirEdicion();
    // la recarga que sigue al guardado queda en viaje
    basesMock.mockReturnValue(new Promise(() => {}));

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), ' II');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const otra = screen.getByRole('dialog', { name: 'Editar base' });
    expect(within(otra).getByRole('button', { name: 'Guardar cambios' })).toBeEnabled();
    expect(within(otra).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
  });

  it('reabrir el alta después de un error arranca limpio', async () => {
    apiMock.mockRejectedValue(new Error('Ya existe una base con ese nombre'));
    let dialogo = await abrirAlta();
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');
    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.9');
    await userEvent.type(within(dialogo).getByLabelText('Longitud'), '-56.15');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Dar de alta' }));
    await within(dialogo).findByRole('alert');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    dialogo = screen.getByRole('dialog', { name: 'Nueva base' });
    expect(within(dialogo).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialogo).getByLabelText('Nombre')).toHaveValue('');
  });

  it('mientras el GPS contesta, el botón lo dice y no se puede volver a pedir', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition: () => {} },
      configurable: true,
    });
    const dialogo = await abrirAlta();

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Usar mi ubicación' }));
    expect(within(dialogo).getByRole('button', { name: 'Ubicando…' })).toBeDisabled();
  });

  it('una base inactiva ofrece activarla', async () => {
    basesMock.mockResolvedValue([base({ active: false })]);
    apiMock.mockResolvedValue(base());
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    expect(screen.getByText('Inactiva')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Activar' }));
    // Activar no rompe nada: no pregunta.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1].body)).toEqual({ active: true });
  });

  it('las acciones de cada fila van juntas: Editar primero y Eliminar al final', async () => {
    basesMock.mockResolvedValue([base()]);
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    const grupo = screen.getByRole('group', { name: 'Acciones de Base Norte' });
    expect(nombresDeBotones(within(grupo).getAllByRole('button'))).toEqual([
      'Editar',
      'Rutas',
      'Desactivar',
      'Eliminar',
    ]);
  });
});

describe('BasesView — asignar rutas apenas se da de alta la base', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  const nueva = { id: 5, name: 'Base Río', lat: -34.9, lon: -56.15, active: true, createdAt: '', createdBy: 'campo1', deleted: false, deletedAt: null };

  function rutaCerca() {
    return { id: 1, name: 'Perímetro cercano', description: '', waypoints: [{ lat: -34.9005, lon: -56.1505, alt: 40 }, { lat: -34.901, lon: -56.151, alt: 40 }], createdBy: null, deleted: false, deletedAt: null };
  }
  function rutaLejos() {
    // ~5 km al norte: bien pasado el umbral del kilómetro
    return { id: 2, name: 'Perímetro lejano', description: '', waypoints: [{ lat: -34.855, lon: -56.15, alt: 40 }, { lat: -34.856, lon: -56.151, alt: 40 }], createdBy: null, deleted: false, deletedAt: null };
  }

  async function llegarALasRutas() {
    basesMock.mockResolvedValue([]);
    apiMock.mockResolvedValue(nueva);
    rutasMock.mockResolvedValue([rutaLejos(), rutaCerca()]);
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));

    const dialogo = screen.getByRole('dialog');
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');
    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.9');
    await userEvent.type(within(dialogo).getByLabelText('Longitud'), '-56.15');
    await userEvent.click(within(dialogo).getByRole('button', { name: /dar de alta/i }));
  }

  it('después de guardar la base ofrece elegir sus rutas, más cercana primero', async () => {
    await llegarALasRutas();

    expect(await screen.findByText(/quedó dada de alta/i)).toBeInTheDocument();
    const opciones = screen.getAllByRole('option');
    // la cercana va arriba aunque en la lista original venía segunda
    expect(opciones[0]).toHaveTextContent('Perímetro cercano');
    expect(opciones[1]).toHaveTextContent('Perímetro lejano');
  });

  it('asignar una ruta cercana no pregunta nada', async () => {
    await llegarALasRutas();
    await screen.findByText(/quedó dada de alta/i);

    await userEvent.click(screen.getByRole('option', { name: /Perímetro cercano/ }));
    expect(screen.queryByText(/queda lejos de la base/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /asignar 1 ruta/i })).toBeInTheDocument();
  });

  it('una ruta cuyo primer nodo está a más de un kilómetro pide confirmación', async () => {
    await llegarALasRutas();
    await screen.findByText(/quedó dada de alta/i);

    await userEvent.click(screen.getByRole('option', { name: /Perímetro lejano/ }));
    expect(await screen.findByText(/queda lejos de la base/i)).toBeInTheDocument();
    // y el aviso dice la distancia, que es el dato con el que se decide
    // hay dos diálogos abiertos (el del alta y el aviso): se mira el aviso
    const aviso = screen.getByRole('dialog', { name: /queda lejos de la base/i });
    expect(aviso).toHaveTextContent(/\d+[.,]\d+ km/);

    // si se rechaza, no queda asignada
    await userEvent.click(screen.getByRole('button', { name: /no asignarla/i }));
    expect(screen.getByRole('button', { name: /sin rutas/i })).toBeInTheDocument();
  });

  it('se puede asignarla igual desde el aviso', async () => {
    await llegarALasRutas();
    await screen.findByText(/quedó dada de alta/i);

    await userEvent.click(screen.getByRole('option', { name: /Perímetro lejano/ }));
    await userEvent.click(await screen.findByRole('button', { name: /asignarla igual/i }));
    expect(screen.getByRole('button', { name: /asignar 1 ruta/i })).toBeInTheDocument();
  });

  it('el buscador filtra las rutas del paso 2', async () => {
    await llegarALasRutas();
    await screen.findByText(/quedó dada de alta/i);

    await userEvent.type(screen.getByLabelText('Buscar rutas'), 'cercano');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('guardar la asignación llama al endpoint de la base', async () => {
    await llegarALasRutas();
    await screen.findByText(/quedó dada de alta/i);

    await userEvent.click(screen.getByRole('option', { name: /Perímetro cercano/ }));
    await userEvent.click(screen.getByRole('button', { name: /asignar 1 ruta/i }));

    expect(apiMock).toHaveBeenCalledWith('/bases/5/routes', expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1].body)).toEqual({ routeIds: [1] });
  });

  it('se puede saltear el paso con "Después"', async () => {
    await llegarALasRutas();
    await screen.findByText(/quedó dada de alta/i);

    await userEvent.click(screen.getByRole('button', { name: 'Después' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('BasesView — rutas de una base que ya existe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  function ruta(id: number, name: string, lat: number, lon: number) {
    return {
      id, name, description: '',
      waypoints: [{ lat, lon, alt: 40 }, { lat: lat - 0.001, lon: lon - 0.001, alt: 40 }],
      createdBy: null, deleted: false, deletedAt: null,
    };
  }

  const CERCA = ruta(1, 'Perímetro cercano', -34.857, -56.208);
  const LEJOS = ruta(2, 'Perímetro lejano', -34.8, -56.208);

  async function abrirRutas(me = ADMIN) {
    basesMock.mockResolvedValue([base()]);
    rutasMock.mockResolvedValue([LEJOS, CERCA]);
    render(<BasesView me={me} />);
    await screen.findByText('Base Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Rutas' }));
    return screen.findByRole('dialog', { name: /rutas de base norte/i });
  }

  it('trae las rutas que la base ya tiene y las deja marcadas', async () => {
    rutasDeBaseMock.mockResolvedValue([CERCA]);
    const dialogo = await abrirRutas();

    expect(rutasDeBaseMock).toHaveBeenCalledWith(1);
    const opciones = await within(dialogo).findAllByRole('option');
    // la cercana primero, y ya seleccionada porque la base la tiene asignada
    expect(opciones[0]).toHaveTextContent('Perímetro cercano');
    expect(opciones[0]).toHaveAttribute('aria-selected', 'true');
    expect(opciones[1]).toHaveAttribute('aria-selected', 'false');
    expect(within(dialogo).getByRole('button', { name: /asignar 1 ruta/i })).toBeInTheDocument();
  });

  it('desmarcar y guardar le saca la ruta a la base', async () => {
    rutasDeBaseMock.mockResolvedValue([CERCA]);
    apiMock.mockResolvedValue({});
    const dialogo = await abrirRutas();
    await within(dialogo).findAllByRole('option');

    await userEvent.click(within(dialogo).getByRole('option', { name: /Perímetro cercano/ }));
    await userEvent.click(within(dialogo).getByRole('button', { name: /sin rutas/i }));

    expect(apiMock).toHaveBeenCalledWith('/bases/1/routes', expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1].body)).toEqual({ routeIds: [] });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('agregar una ruta lejana sigue pidiendo confirmación', async () => {
    rutasDeBaseMock.mockResolvedValue([]);
    const dialogo = await abrirRutas();
    await within(dialogo).findAllByRole('option');

    await userEvent.click(within(dialogo).getByRole('option', { name: /Perímetro lejano/ }));
    expect(await screen.findByRole('dialog', { name: /queda lejos de la base/i })).toBeInTheDocument();
  });

  it('el operador de campo también asigna rutas', async () => {
    rutasDeBaseMock.mockResolvedValue([CERCA]);
    const dialogo = await abrirRutas(CAMPO);
    expect(await within(dialogo).findAllByRole('option')).toHaveLength(2);
    // y sigue sin poder editar ni borrar la base
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
  });

  it('el operador común ni siquiera ve el botón', async () => {
    basesMock.mockResolvedValue([base()]);
    render(<BasesView me={OPERADOR} />);
    await screen.findByText('Base Norte');

    expect(screen.queryByRole('button', { name: 'Rutas' })).not.toBeInTheDocument();
    expect(rutasDeBaseMock).not.toHaveBeenCalled();
  });

  it('si el backend rechaza la asignación, el error se anuncia una vez, adentro del diálogo, que sigue abierto', async () => {
    rutasDeBaseMock.mockResolvedValue([CERCA]);
    apiMock.mockRejectedValueOnce(new Error('La ruta 1 está eliminada'));
    const dialogo = await abrirRutas();
    await within(dialogo).findAllByRole('option');

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Asignar 1 ruta' }));
    // Antes salía también el de la página, detrás del velo: dos avisos iguales.
    const avisos = await screen.findAllByRole('alert');
    expect(avisos).toHaveLength(1);
    expect(dialogo).toContainElement(avisos[0]);
    expect(avisos[0]).toHaveTextContent('La ruta 1 está eliminada');

    // Reintentar limpia el error; si sale bien, el diálogo se cierra.
    apiMock.mockResolvedValueOnce({});
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Asignar 1 ruta' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('el error de una asignación anterior no aparece al abrir la de otra base', async () => {
    basesMock.mockResolvedValue([base(), base({ id: 2, name: 'Base Sur' })]);
    rutasMock.mockResolvedValue([CERCA]);
    rutasDeBaseMock.mockResolvedValue([CERCA]);
    apiMock.mockRejectedValueOnce(new Error('sin permiso'));
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    await userEvent.click(within(screen.getByText('Base Norte').closest('article')!).getByRole('button', { name: 'Rutas' }));
    let dialogo = await screen.findByRole('dialog', { name: /rutas de base norte/i });
    await within(dialogo).findAllByRole('option');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Asignar 1 ruta' }));
    await within(dialogo).findByRole('alert');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));

    await userEvent.click(within(screen.getByText('Base Sur').closest('article')!).getByRole('button', { name: 'Rutas' }));
    dialogo = await screen.findByRole('dialog', { name: /rutas de base sur/i });
    await within(dialogo).findAllByRole('option');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('si el backend no devuelve las rutas, el error se lee adentro del diálogo', async () => {
    basesMock.mockResolvedValue([base()]);
    rutasMock.mockResolvedValue([]);
    rutasDeBaseMock.mockRejectedValue(new Error('sin permiso para ver las rutas'));
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Rutas' }));

    const dialogo = await screen.findByRole('dialog', { name: /rutas de base norte/i });
    expect(await within(dialogo).findByText(/sin permiso para ver las rutas/)).toBeInTheDocument();
  });

  it('se puede dibujar una ruta nueva desde la base y queda elegida', async () => {
    rutasDeBaseMock.mockResolvedValue([]);
    const dialogo = await abrirRutas();
    await within(dialogo).findAllByRole('option');

    await userEvent.click(within(dialogo).getByRole('button', { name: /nueva ruta/i }));
    const editor = await screen.findByRole('dialog', { name: /nueva ruta de patrullaje/i });

    await userEvent.type(within(editor).getByLabelText('Nombre'), 'Perímetro nuevo');
    // dos clics en el mapa: el editor toma el manejador al montarse
    act(() => {
      estadoMapa.clic!({ latlng: { lat: -34.858, lng: -56.209 } });
      estadoMapa.clic!({ latlng: { lat: -34.859, lng: -56.21 } });
    });

    apiMock.mockResolvedValue(ruta(7, 'Perímetro nuevo', -34.858, -56.209));
    await userEvent.click(await within(editor).findByRole('button', { name: /guardar ruta/i }));

    expect(apiMock).toHaveBeenCalledWith('/routes', expect.objectContaining({ method: 'POST' }));
    // el editor se cierra y la ruta recién dibujada queda marcada en la base
    expect(screen.queryByRole('dialog', { name: /nueva ruta de patrullaje/i })).not.toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /Perímetro nuevo/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('BasesView — mapas con doble fondo y la base como referencia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  it('el elector de coordenadas también ofrece la vista satelital', async () => {
    basesMock.mockResolvedValue([]);
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));

    expect(fondosPuestos().some((u) => u.includes('openstreetmap'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Satélite' }));
    expect(fondosPuestos().some((u) => u.includes('World_Imagery'))).toBe(true);
  });

  it('el marcador de la base es el rombo negro y ámbar, no uno pintado con tokens', async () => {
    basesMock.mockResolvedValue([]);
    render(<BasesView me={CAMPO} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    estadoMapa.clic!({ latlng: { lat: -34.6037, lng: -58.3816 } });

    const marcador = await screen.findByDisplayValue('-34.603700');
    expect(marcador).toBeInTheDocument();
    const puesto = estadoMapa.puestas.find((c) => c.clase === 'marker');
    const html = (puesto!.opciones!.icon as { icono: { html: string } }).icono.html;
    expect(html).toContain('#14120F');
    expect(html).not.toContain('var(--');
  });

  it('al dibujar una ruta desde una base, la base queda marcada en el mapa', async () => {
    basesMock.mockResolvedValue([
      { id: 1, name: 'Base Obelisco', lat: -34.6037, lon: -58.3816, active: true, createdAt: '', createdBy: 'admin1', deleted: false, deletedAt: null },
    ]);
    rutasMock.mockResolvedValue([]);
    rutasDeBaseMock.mockResolvedValue([]);
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Obelisco');
    await userEvent.click(screen.getByRole('button', { name: 'Rutas' }));
    await screen.findByRole('dialog', { name: /rutas de base obelisco/i });
    limpiarEstadoMapa();
    await userEvent.click(screen.getByRole('button', { name: /nueva ruta/i }));
    await screen.findByRole('dialog', { name: /nueva ruta de patrullaje/i });

    const marcador = estadoMapa.puestas.find((c) => c.clase === 'marker');
    expect(marcador?.latlng).toEqual([-34.6037, -58.3816]);
  });

  // El nombre de la base lo escribe un operador de campo y el editor lo pone
  // en la etiqueta del rombo, que Leaflet pinta con innerHTML.
  it('el nombre de la base, en la etiqueta del editor, se pinta como texto', async () => {
    const malicioso = 'Base <img src=x onerror=alert(1)>';
    basesMock.mockResolvedValue([
      { id: 1, name: malicioso, lat: -34.6037, lon: -58.3816, active: true, createdAt: '', createdBy: 'admin1', deleted: false, deletedAt: null },
    ]);
    rutasMock.mockResolvedValue([]);
    rutasDeBaseMock.mockResolvedValue([]);
    render(<BasesView me={ADMIN} />);
    await screen.findByText(malicioso);
    await userEvent.click(screen.getByRole('button', { name: 'Rutas' }));
    await screen.findByRole('dialog', { name: /rutas de base/i });
    limpiarEstadoMapa();
    await userEvent.click(screen.getByRole('button', { name: /nueva ruta/i }));
    await screen.findByRole('dialog', { name: /nueva ruta de patrullaje/i });

    const etiqueta = pintarComoLeaflet(estadoMapa.puestas.find((c) => c.clase === 'marker')?.etiqueta);
    expect(etiqueta.querySelector('img')).toBeNull();
    expect(etiqueta.textContent).toBe(malicioso);
  });
});

describe('BasesView — avisos de lo que salió bien', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  function montarConAvisos(me = ADMIN) {
    return render(
      <ProveedorDeAvisos>
        <BasesView me={me} />
      </ProveedorDeAvisos>,
    );
  }
  const aviso = () => document.querySelector('.avisos-flotantes') as HTMLElement;

  it('el alta lo dice antes de pasar a elegir sus rutas', async () => {
    basesMock.mockResolvedValue([]);
    apiMock.mockResolvedValue(base({ id: 9, name: 'Base Río' }));
    montarConAvisos(CAMPO);
    await screen.findByText(/todavía no hay bases/i);

    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Río');
    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.9');
    await userEvent.type(within(dialogo).getByLabelText('Longitud'), '-56.15');
    await userEvent.click(within(dialogo).getByRole('button', { name: /dar de alta/i }));

    await waitFor(() => expect(aviso()).toHaveTextContent('Base Base Río dada de alta.'));
  });

  it('la edición avisa que se guardó', async () => {
    basesMock.mockResolvedValue([base()]);
    apiMock.mockResolvedValue(base({ name: 'Base Norte II' }));
    montarConAvisos();
    await screen.findByText('Base Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.clear(within(dialogo).getByLabelText('Nombre'));
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Norte II');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Cambios de Base Norte II guardados.'));
  });

  it('desactivar, activar y eliminar lo dicen', async () => {
    basesMock.mockResolvedValue([base()]);
    apiMock.mockResolvedValue(base());
    montarConAvisos();
    await screen.findByText('Base Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Desactivar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Base Base Norte desactivada.'));

    basesMock.mockResolvedValue([base({ active: false })]);
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Base Base Norte eliminada.'));

    await userEvent.click(await screen.findByRole('button', { name: 'Activar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Base Base Norte activada.'));
  });

  it('restaurar lo dice', async () => {
    basesMock.mockResolvedValue([base({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' })]);
    apiMock.mockResolvedValue(base());
    montarConAvisos();
    await userEvent.click(await screen.findByRole('button', { name: 'Restaurar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Base Base Norte restaurada.'));
  });

  it('lo que no pregunta deja su error arriba de la tabla, sin avisar que salió bien', async () => {
    basesMock.mockResolvedValue([base({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' })]);
    apiMock.mockRejectedValue(new Error('Ya existe una base activa con ese nombre'));
    montarConAvisos();
    await userEvent.click(await screen.findByRole('button', { name: 'Restaurar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya existe una base activa con ese nombre');
    expect(aviso()).toBeEmptyDOMElement();
  });

  it('guardar las rutas de una base lo dice, y el botón cuenta en castellano', async () => {
    const CERCA_1 = { id: 1, name: 'Perímetro A', description: '', waypoints: [{ lat: -34.857, lon: -56.208, alt: 40 }, { lat: -34.858, lon: -56.209, alt: 40 }], createdBy: null, deleted: false, deletedAt: null };
    const CERCA_2 = { ...CERCA_1, id: 2, name: 'Perímetro B' };
    basesMock.mockResolvedValue([base()]);
    rutasMock.mockResolvedValue([CERCA_1, CERCA_2]);
    rutasDeBaseMock.mockResolvedValue([CERCA_1, CERCA_2]);
    apiMock.mockResolvedValue({});
    montarConAvisos();
    await screen.findByText('Base Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Rutas' }));
    const dialogo = await screen.findByRole('dialog', { name: /rutas de base norte/i });

    // "Asignar 2 rutas", no "Asignar 2 ruta(s)".
    const guardar = await within(dialogo).findByRole('button', { name: 'Asignar 2 rutas' });
    await userEvent.click(guardar);
    await waitFor(() => expect(aviso()).toHaveTextContent('Rutas de Base Norte guardadas.'));
  });
});

describe('BasesView — carga sin saltos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  it('la primera carga es un esqueleto; las recargas después de una acción no lo vuelven a mostrar', async () => {
    let contestar: (v: ReturnType<typeof base>[]) => void = () => {};
    basesMock.mockReturnValueOnce(new Promise((r) => (contestar = r)));
    render(<BasesView me={ADMIN} />);
    expect(screen.getByRole('status')).toHaveClass('esqueleto');
    await act(async () => contestar([base({ active: false })]));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Activar recarga la lista: las fichas se quedan, marcadas como ocupadas.
    let recargar: (v: ReturnType<typeof base>[]) => void = () => {};
    basesMock.mockReturnValueOnce(new Promise((r) => (recargar = r)));
    apiMock.mockResolvedValue(base());
    await userEvent.click(screen.getByRole('button', { name: 'Activar' }));
    const envoltorio = screen.getByRole('list', { name: 'Bases dadas de alta' });
    await waitFor(() => expect(envoltorio).toHaveAttribute('aria-busy', 'true'));
    expect(screen.queryByText(/trayendo las bases/i)).not.toBeInTheDocument();

    await act(async () => recargar([base()]));
    expect(envoltorio).not.toHaveAttribute('aria-busy');
  });

  it('el interruptor de eliminadas dice si está apretado, como los de las otras vistas', async () => {
    basesMock.mockResolvedValue([base()]);
    render(<BasesView me={ADMIN} />);
    const interruptor = await screen.findByRole('button', { name: 'Ver eliminadas' });
    expect(interruptor).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(interruptor);
    expect(interruptor).toHaveAttribute('aria-pressed', 'true');
    expect(interruptor).toHaveTextContent('Ver eliminadas');
  });
});

describe('BasesView — fichas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  it('cada base es una ficha: el nombre como título, el alfiler con sus coordenadas y si está activa', async () => {
    basesMock.mockResolvedValue([base(), base({ id: 2, name: 'Base Sur', active: false })]);
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    const norte = screen.getByRole('article', { name: 'Base Norte' });
    expect(within(norte).getByRole('heading', { name: 'Base Norte' })).toHaveClass('ficha-nombre');
    const lugar = within(norte).getByText('-34.85650, -56.20750');
    expect(lugar).toHaveClass('ficha-sub');
    expect(lugar.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(within(norte).getByText('Activa')).toHaveClass('estado', 'pastilla', 'ok');
    expect(within(screen.getByRole('article', { name: 'Base Sur' })).getByText('Inactiva')).toHaveClass('muted');
  });

  it('la cabecera cuenta las bases y las activas, sin las bajas', async () => {
    basesMock.mockResolvedValue([
      base(),
      base({ id: 2, name: 'Base Sur', active: false }),
      base({ id: 3, name: 'Vieja', deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    const { container } = render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');
    expect(container.querySelector('.vista-subtitulo')).toHaveTextContent('2 bases · 1 activa');
  });

  it('quien no gestiona bases ve las fichas sin acciones', async () => {
    basesMock.mockResolvedValue([base()]);
    render(<BasesView me={OPERADOR} />);
    await screen.findByText('Base Norte');
    expect(screen.queryByRole('group', { name: 'Acciones de Base Norte' })).not.toBeInTheDocument();
  });

  it('sin bases, el vacío lleva el medallón de la torre', async () => {
    basesMock.mockResolvedValue([]);
    const { container } = render(<BasesView me={ADMIN} />);
    await screen.findByText(/todavía no hay bases/i);
    expect(container.querySelector('.con-medalla .medalla svg')).not.toBeNull();
  });
});
