import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, traerBases } from '../api';
import { estadoMapa, limpiarEstadoMapa } from '../test/dobleLeaflet';
import { makeMe } from '../test/fixtures';
import type { BaseAsset } from '../types';
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
const ADMIN = makeMe({ username: 'admin1', role: 'admin' });

function base(over: Partial<BaseAsset> = {}): BaseAsset {
  return {
    id: 1,
    name: 'Base Norte',
    lat: -34.8565,
    lon: -56.2075,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'admin1',
    deleted: false,
    deletedAt: null,
    ...over,
  };
}

// El ejemplo del contrato (docs/contrato/relevos.json, POST /api/bases): 20 m
// al norte de Base Norte.
const PUNTO = { aterrizajeLat: -34.85632, aterrizajeLon: -56.2075 };

describe('BasesView — punto de aterrizaje para visitantes (RELEVOS §0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  async function abrirAlta() {
    basesMock.mockResolvedValue([]);
    apiMock.mockResolvedValue(base({ id: 9 }));
    render(<BasesView me={ADMIN} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Base Norte');
    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.8565');
    await userEvent.type(within(dialogo).getByLabelText('Longitud'), '-56.2075');
    return dialogo;
  }

  it('el alta con el punto lo manda, y dice a cuánto queda de la base', async () => {
    const dialogo = await abrirAlta();
    await userEvent.type(within(dialogo).getByLabelText('Latitud para visitantes'), '-34.85632');
    await userEvent.type(within(dialogo).getByLabelText('Longitud para visitantes'), '-56.2075');
    expect(within(dialogo).getByTestId('distancia-visitantes')).toHaveTextContent('A 20 m de la base.');

    await userEvent.click(within(dialogo).getByRole('button', { name: /dar de alta/i }));
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1]!.body as string)).toEqual({
      name: 'Base Norte',
      lat: -34.8565,
      lon: -56.2075,
      ...PUNTO,
    });
  });

  it.each([
    ['a 5 m de la plataforma', '-34.856455', /ahora está a 5 m/],
    ['a unos 90 m, ya fuera de la base', '-34.8557', /ahora está a 89 m/],
  ])('un punto %s no deja guardar y explica el rango', async (_caso, lat, distancia) => {
    const dialogo = await abrirAlta();
    await userEvent.type(within(dialogo).getByLabelText('Latitud para visitantes'), lat);
    await userEvent.type(within(dialogo).getByLabelText('Longitud para visitantes'), '-56.2075');

    const error = within(dialogo).getByText(/tiene que estar entre 10 y 50 m de la base/);
    expect(error).toHaveTextContent(distancia);
    const campo = within(dialogo).getByLabelText('Latitud para visitantes');
    expect(campo).toHaveAttribute('aria-invalid', 'true');
    expect(campo).toHaveAttribute('aria-describedby', error.id);
    expect(within(dialogo).getByRole('button', { name: /dar de alta/i })).toBeDisabled();
    expect(within(dialogo).getByText('Revisá el punto para visitantes.')).toBeInTheDocument();
  });

  it('una sola coordenada del punto no alcanza: van las dos o ninguna', async () => {
    const dialogo = await abrirAlta();
    await userEvent.type(within(dialogo).getByLabelText('Latitud para visitantes'), '-34.85632');
    expect(
      within(dialogo).getByText(/Completá la latitud y la longitud del punto para visitantes/),
    ).toBeInTheDocument();
    expect(within(dialogo).getByRole('button', { name: /dar de alta/i })).toBeDisabled();

    // "Quitar el punto" lo vuelve a dejar como opcional.
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Quitar el punto' }));
    expect(within(dialogo).getByLabelText('Latitud para visitantes')).toHaveValue('');
    expect(within(dialogo).getByLabelText('Latitud para visitantes')).toHaveAttribute('aria-invalid', 'false');
    expect(within(dialogo).getByRole('button', { name: 'Quitar el punto' })).toBeDisabled();
    expect(within(dialogo).getByRole('button', { name: /dar de alta/i })).toBeEnabled();
  });

  it('sin el punto de la base todavía, el de visitantes no se puede medir y no se reclama', async () => {
    basesMock.mockResolvedValue([]);
    render(<BasesView me={ADMIN} />);
    await screen.findByText(/todavía no hay bases/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva base/i }));
    const dialogo = screen.getByRole('dialog');
    // Sin base no hay adónde acercarse.
    const vistas = estadoMapa.vistas.length;
    await userEvent.click(within(dialogo).getByRole('button', { name: 'El punto para visitantes' }));
    expect(estadoMapa.vistas).toHaveLength(vistas);
    await userEvent.type(within(dialogo).getByLabelText('Latitud para visitantes'), '-34.85632');
    await userEvent.type(within(dialogo).getByLabelText('Longitud para visitantes'), '-56.2075');
    expect(within(dialogo).queryByTestId('distancia-visitantes')).not.toBeInTheDocument();
    expect(within(dialogo).queryByText(/tiene que estar entre/)).not.toBeInTheDocument();
  });

  it('el clic en el mapa marca el punto que se eligió: la base o el de visitantes', async () => {
    const dialogo = await abrirAlta();
    const deVisitantes = within(dialogo).getByRole('button', { name: 'El punto para visitantes' });
    expect(within(dialogo).getByRole('button', { name: 'La base' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(deVisitantes);
    expect(deVisitantes).toHaveAttribute('aria-pressed', 'true');
    // A 10 o 50 m de la base no se distingue nada con el zoom de la ciudad: se acerca.
    expect(estadoMapa.vistas.at(-1)).toEqual({ centro: [-34.8565, -56.2075], zoom: 19 });
    act(() => estadoMapa.clic!({ latlng: { lat: -34.85632, lng: -56.2075 } }));
    expect(within(dialogo).getByLabelText('Latitud para visitantes')).toHaveValue('-34.856320');
    expect(within(dialogo).getByLabelText('Latitud')).toHaveValue('-34.8565');
    const aro = estadoMapa.puestas.find((c) => c.clase === 'circleMarker');
    expect(aro).toMatchObject({ latlng: [-34.85632, -56.2075], etiqueta: 'Punto para visitantes' });

    // Moverlo no crea otro marcador: corre el que había.
    act(() => estadoMapa.clic!({ latlng: { lat: -34.8564, lng: -56.2075 } }));
    expect(estadoMapa.puestas.filter((c) => c.clase === 'circleMarker')).toHaveLength(1);
    expect(aro?.latlng).toEqual([-34.8564, -56.2075]);

    await userEvent.click(within(dialogo).getByRole('button', { name: 'La base' }));
    act(() => estadoMapa.clic!({ latlng: { lat: -34.857, lng: -56.208 } }));
    expect(within(dialogo).getByLabelText('Latitud')).toHaveValue('-34.857000');

    // Quitarlo saca el aro del mapa.
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Quitar el punto' }));
    expect(estadoMapa.sacadas.some((c) => c.clase === 'circleMarker')).toBe(true);
  });

  it('editar precarga el punto, y el PATCH lo manda siempre: el que hay, o null si se quitó', async () => {
    basesMock.mockResolvedValue([base(PUNTO)]);
    apiMock.mockResolvedValue(base());
    render(<BasesView me={ADMIN} />);
    // La tabla dice a cuánto está, debajo de las coordenadas.
    expect(await screen.findByText('Visitantes a 20 m')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    let dialogo = screen.getByRole('dialog');
    expect(within(dialogo).getByLabelText('Latitud para visitantes')).toHaveValue('-34.85632');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1]!.body as string)).toEqual({
      name: 'Base Norte',
      lat: -34.8565,
      lon: -56.2075,
      ...PUNTO,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Quitar el punto' }));
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1]!.body as string)).toMatchObject({
      aterrizajeLat: null,
      aterrizajeLon: null,
    });
  });

  it('mover la base sin mover el punto lo puede dejar fuera de rango, y se avisa antes de guardar', async () => {
    basesMock.mockResolvedValue([base(PUNTO)]);
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.clear(within(dialogo).getByLabelText('Latitud'));
    await userEvent.type(within(dialogo).getByLabelText('Latitud'), '-34.86');
    expect(within(dialogo).getByText(/tiene que estar entre 10 y 50 m/)).toBeInTheDocument();
    expect(within(dialogo).getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
  });

  it('una base de un backend viejo, sin el campo, se edita sin punto', async () => {
    basesMock.mockResolvedValue([base()]);
    apiMock.mockResolvedValue(base());
    render(<BasesView me={ADMIN} />);
    await screen.findByText('Base Norte');
    expect(screen.queryByText(/Visitantes a/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const dialogo = screen.getByRole('dialog');
    expect(within(dialogo).getByLabelText('Latitud para visitantes')).toHaveValue('');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1]!.body as string)).toMatchObject({
      aterrizajeLat: null,
      aterrizajeLon: null,
    });
  });
});
