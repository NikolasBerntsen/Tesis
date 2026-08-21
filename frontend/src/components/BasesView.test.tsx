import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, rutasDeBase, traerBases, traerRutas } from '../api';
import { makeMe } from '../test/fixtures';
import { estadoMapa, fondosPuestos, limpiarEstadoMapa } from '../test/dobleLeaflet';
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
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar' }));

    expect(apiMock).toHaveBeenCalledWith('/bases/1', expect.objectContaining({ method: 'PATCH' }));
  });

  it('desactivar y eliminar pegan a los endpoints que corresponden', async () => {
    basesMock.mockResolvedValue([base()]);
    apiMock.mockResolvedValue(base());
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1].body)).toEqual({ active: false });

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(apiMock).toHaveBeenLastCalledWith('/bases/1', { method: 'DELETE' });
  });

  it('muestra el error del backend al intentar eliminar una base en uso', async () => {
    basesMock.mockResolvedValue([base()]);
    apiMock.mockRejectedValue(new Error('La base tiene 2 drones asignados: reasignalos antes de eliminarla'));
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(await screen.findByText(/2 drones asignados/)).toBeInTheDocument();
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
});
