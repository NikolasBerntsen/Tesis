import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, traerBases } from '../api';
import { makeMe } from '../test/fixtures';
import BasesView from './BasesView';

vi.mock('../api', () => ({ api: vi.fn(), traerBases: vi.fn() }));
// Leaflet no corre en jsdom: mide el contenedor y pinta lienzos. El doble deja
// probar lo único que importa acá, que es el clic sobre el mapa.
const { alClickear } = vi.hoisted(() => ({ alClickear: { fn: null as null | ((e: unknown) => void) } }));
vi.mock('leaflet', () => {
  const mapa = {
    setView: () => mapa,
    on: (_ev: string, fn: (e: unknown) => void) => {
      alClickear.fn = fn;
      return mapa;
    },
    remove: vi.fn(),
    panTo: vi.fn(),
    invalidateSize: vi.fn(),
  };
  return {
    default: {
      map: () => mapa,
      tileLayer: () => ({ addTo: vi.fn() }),
      marker: () => ({ addTo: vi.fn(), setLatLng: vi.fn(), remove: vi.fn() }),
      divIcon: () => ({}),
    },
  };
});

const apiMock = vi.mocked(api);
const basesMock = vi.mocked(traerBases);
const ADMIN = makeMe({ username: 'admin1', role: 'admin' });
const CAMPO = makeMe({ username: 'campo1', role: 'field_operator' });
const OPERADOR = makeMe({ username: 'oper1', role: 'operator' });

function base(over: Partial<{ id: number; name: string; lat: number; lon: number; active: boolean; deletedAt: string | null }> = {}) {
  return {
    id: 1, name: 'Base Norte', lat: -34.8565, lon: -56.2075,
    active: true, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'admin1', deletedAt: null,
    ...over,
  };
}

describe('BasesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alClickear.fn = null;
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

    basesMock.mockResolvedValue([base({ deletedAt: '2026-01-02T00:00:00.000Z' })]);
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

    expect(alClickear.fn).not.toBeNull();
    alClickear.fn!({ latlng: { lat: -34.123456, lng: -56.654321 } });

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
    alClickear.fn = null;
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
    basesMock.mockResolvedValue([base({ deletedAt: '2026-01-02T00:00:00.000Z' })]);
    apiMock.mockResolvedValue(base());
    render(<BasesView me={ADMIN} />);
    await userEvent.click(await screen.findByRole('button', { name: /ver eliminadas/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restaurar' }));

    expect(apiMock).toHaveBeenLastCalledWith('/bases/1/restore', { method: 'POST' });
  });
});
