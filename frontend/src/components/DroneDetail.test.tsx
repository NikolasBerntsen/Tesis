import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DroneDetail from './DroneDetail';
import { api, rutasDeBase } from '../api';
import { makeDrone, makeEvent, makeMe, makeRoute, makeStatus } from '../test/fixtures';

vi.mock('./DronesMap', () => ({ default: () => <div data-testid="mapa-mock" /> }));
vi.mock('../api', () => ({ api: vi.fn(), rutasDeBase: vi.fn() }));
const apiMock = vi.mocked(api);
const rutasDeBaseMock = vi.mocked(rutasDeBase);

function renderDetail(props: Partial<Parameters<typeof DroneDetail>[0]> = {}) {
  const base = {
    me: makeMe({ username: 'admin1', role: 'admin', canControl: true }),
    drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true }),
    status: makeStatus({ droneId: 'd1', state: 'PATROLLING', routeId: null }),
    frame: null as string | null,
    liveEvents: [],
    routes: [makeRoute({ id: 1, name: 'Ruta Perimetral' })],
    onBack: vi.fn(),
    onRename: vi.fn(),
    onWaypointLabel: vi.fn(),
  };
  const merged = { ...base, ...props } as Parameters<typeof DroneDetail>[0];
  render(<DroneDetail {...merged} />);
  return merged;
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith('/events')) return Promise.resolve([]);
    return Promise.resolve({});
  });
  // Por defecto la base del dron tiene habilitada la ruta que traen los tests.
  rutasDeBaseMock.mockReset();
  rutasDeBaseMock.mockResolvedValue([makeRoute({ id: 1, name: 'Ruta Perimetral' })]);
});

describe('DroneDetail', () => {
  it('muestra el encabezado, pide el historial y vuelve con el botón', async () => {
    const props = renderDetail();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/events?droneId=d1'));
    expect(screen.getByText('Alfa')).toBeInTheDocument();
    expect(screen.getByText('En vuelo')).toBeInTheDocument();
    expect(screen.getByTestId('mapa-mock')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Volver a Drones/ }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('marca desconectado y muestra quién tiene el control manual', async () => {
    renderDetail({ drone: makeDrone({ online: false, controlledBy: 'oper9' }) });
    expect(await screen.findByText('Desconectado')).toBeInTheDocument();
    expect(screen.getByText('Control manual: oper9')).toBeInTheDocument();
  });

  it('fusiona los eventos en vivo del dron con el historial', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([makeEvent({ id: 1, message: 'del historial' })]);
      return Promise.resolve({});
    });
    renderDetail({
      liveEvents: [
        makeEvent({ id: 2, drone_id: 'd1', message: 'evento fresco' }),
        makeEvent({ id: 3, drone_id: 'otro', message: 'de otro dron' }),
      ],
    });
    expect(await screen.findByText('del historial')).toBeInTheDocument();
    expect(screen.getByText('evento fresco')).toBeInTheDocument();
    expect(screen.queryByText('de otro dron')).not.toBeInTheDocument();
  });

  it('muestra la ruta activa cuando el estado la referencia', async () => {
    renderDetail({
      status: makeStatus({ routeId: 1, waypointIndex: 1 }),
      routes: [makeRoute({ id: 1, name: 'Ruta Perimetral' })],
    });
    expect(await screen.findByText(/Ruta Perimetral · nodo 2 de 2/)).toBeInTheDocument();
  });

  it('comienza e interrumpe una ruta', async () => {
    renderDetail({ status: makeStatus({ state: 'PATROLLING', routeId: null }) });

    const select = screen.getByRole('combobox');
    // Las opciones llegan cuando responde `rutasDeBase`: sin esperarlas el
    // selector todavía está vacío.
    await within(select).findByRole('option', { name: /Ruta Perimetral/ });
    await userEvent.selectOptions(select, '1');
    await userEvent.click(screen.getByRole('button', { name: 'Comenzar' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/route/start', {
        method: 'POST',
        body: JSON.stringify({ routeId: 1 }),
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Interrumpir' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/route/stop', { method: 'POST' }),
    );
  });

  it('oculta el panel de control si el usuario no está autorizado', async () => {
    renderDetail({ me: makeMe({ canControl: false }) });
    expect(await screen.findByText('Alfa')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Control del dron' })).not.toBeInTheDocument();
  });

  it('permite tomar el control manual cuando nadie lo tiene', async () => {
    renderDetail({ drone: makeDrone({ online: true, controlledBy: null }) });
    await userEvent.click(screen.getByRole('button', { name: 'Tomar control manual' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', { method: 'POST' }));
  });

  it('mueve el dron y devuelve el control cuando soy el controlador', async () => {
    renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1' }),
    });
    // Las flechas son SVG sin texto: el nombre accesible lo pone el aria-label
    for (const rumbo of ['norte', 'sur', 'este', 'oeste']) {
      expect(screen.getByRole('button', { name: `Mover al ${rumbo}` })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByTitle('Norte'));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/manual_move', {
        method: 'POST',
        body: JSON.stringify({ bearing: 0, distanceM: 25 }),
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Devolver al patrullaje' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', {
        method: 'DELETE',
        body: JSON.stringify({ resume: 'last' }),
      }),
    );
  });

  it('un supervisor puede quitarle el control a otro operador', async () => {
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
    });
    expect(screen.getByText(/Controlado por/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', expect.objectContaining({ method: 'DELETE' })));
  });

  it('no repite el panel de alertas: se atienden en la campana del encabezado', () => {
    renderDetail();
    expect(screen.queryByRole('button', { name: 'Validar alerta' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Alertas/ })).not.toBeInTheDocument();
  });

  it('retoma la ruta cuando el patrullaje está interrumpido', async () => {
    renderDetail({ status: makeStatus({ state: 'MANUAL' }), drone: makeDrone({ online: true }) });
    const retomar = screen.getByRole('button', { name: 'Retomar ruta' });
    expect(retomar).toBeEnabled();
    await userEvent.click(retomar);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/resume', { method: 'POST', body: '{}' }),
    );
  });

  it('muestra el error si una acción falla', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([]);
      return Promise.reject(new Error('Backend caído'));
    });
    renderDetail({ drone: makeDrone({ controlledBy: null }) });
    await userEvent.click(screen.getByRole('button', { name: 'Tomar control manual' }));
    const aviso = await screen.findByText('Backend caído');
    expect(aviso).toBeInTheDocument();
    expect(aviso).toHaveAttribute('role', 'alert');
  });

  it('rotula los cuatro símbolos del mapa en la leyenda', async () => {
    renderDetail();
    const leyenda = await screen.findByTestId('leyenda-mapa');
    for (const simbolo of ['Dron', 'Base', 'Nodo pendiente', 'Nodo recorrido']) {
      expect(within(leyenda).getByText(simbolo)).toBeInTheDocument();
    }
  });
});

describe('DroneDetail — distribución y previsualización de la ruta', () => {
  it('el estado va arriba de la grilla, no adentro de una columna', () => {
    renderDetail();
    const container = document.body;
    const estado = container.querySelector('.status-grid');
    const grilla = container.querySelector('.grid-operacion');
    expect(estado).toBeTruthy();
    expect(grilla).toBeTruthy();
    // el estado no está contenido en la grilla: la cruza por arriba
    expect(grilla!.contains(estado!)).toBe(false);
  });

  it('el video y la ubicación cruzan todo el ancho, arriba de los controles', () => {
    renderDetail();
    const par = document.body.querySelector('.par-video-mapa');
    const grilla = document.body.querySelector('.grid-operacion');
    expect(par).toBeTruthy();
    // el par no está adentro de la grilla de controles: la cruza por arriba
    expect(grilla!.contains(par!)).toBe(false);
    expect(par!.querySelector('.video, .video.placeholder')).toBeTruthy();
    expect(par!.querySelector('.mapa-head')).toBeTruthy();
  });

  it('la base del dron se lee en el segundo nivel del estado', () => {
    renderDetail({ drone: makeDrone({ base: { name: 'Base Obelisco', lat: -34.6037, lon: -58.3816 } }) });
    const segundoNivel = document.body.querySelector('.status-segundo-nivel') as HTMLElement;
    expect(within(segundoNivel).getByText('Base')).toBeInTheDocument();
    expect(within(segundoNivel).getByText('Base Obelisco')).toBeInTheDocument();
    expect(within(segundoNivel).getByText('-34.60370, -58.38160')).toBeInTheDocument();
  });

  it('sólo ofrece las rutas habilitadas por la base del dron', async () => {
    rutasDeBaseMock.mockResolvedValue([makeRoute({ id: 2, name: 'Circuito Retiro' })]);
    renderDetail({
      routes: [
        makeRoute({ id: 1, name: 'Ruta Perimetral' }),
        makeRoute({ id: 2, name: 'Circuito Retiro' }),
      ],
    });

    await waitFor(() => expect(rutasDeBaseMock).toHaveBeenCalledWith(1));
    const select = screen.getByLabelText('Ruta de patrullaje');
    expect(await within(select).findByRole('option', { name: /Circuito Retiro/ })).toBeInTheDocument();
    // la que no está asignada a la base no se puede mandar a volar
    expect(within(select).queryByRole('option', { name: /Ruta Perimetral/ })).not.toBeInTheDocument();
  });

  it('avisa cuando la base no tiene rutas y deja el selector inhabilitado', async () => {
    rutasDeBaseMock.mockResolvedValue([]);
    renderDetail({ drone: makeDrone({ base: { name: 'Base Palermo', lat: -34.57, lon: -58.41 } }) });

    expect(await screen.findByText(/Base Palermo todavía no tiene rutas asignadas/)).toBeInTheDocument();
    expect(screen.getByLabelText('Ruta de patrullaje')).toBeDisabled();
  });

  it('un dron sin base no tiene ninguna ruta habilitada', async () => {
    renderDetail({ drone: makeDrone({ baseId: null, base: null }) });

    expect(await screen.findByText(/no tiene base asignada, así que no hay rutas/i)).toBeInTheDocument();
    expect(rutasDeBaseMock).not.toHaveBeenCalled();
    expect(screen.getByText('Sin base asignada')).toBeInTheDocument();
  });
});
