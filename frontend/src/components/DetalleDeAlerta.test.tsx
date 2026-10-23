import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DetalleDeAlerta from './DetalleDeAlerta';
import { ContextoDeAlertas, SIN_CONSOLA, type AlertasEnVivo } from '../alertasEnVivo';
import { api } from '../api';
import { makeAlert, makeDrone, makeStatus } from '../test/fixtures';
import { estadoMapa, limpiarEstadoMapa } from '../test/dobleLeaflet';
import type { Alert, ObjetivoEnSeguimiento } from '../types';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

const OBJETIVO: ObjetivoEnSeguimiento = {
  alertId: 7,
  type: 'PERSON',
  lat: -34.6041,
  lon: -58.3817,
  speedMs: 1.2,
  courseDeg: 90,
  moving: true,
  lost: false,
  lastSeenMs: 400,
  decision: 'PENDING',
};

const ALFA = makeDrone({ droneId: 'd1', hash: 'c54ae4a0aad98bdc6ae5ab810751335c', displayName: 'Alfa', model: 'DJI Mini 4 Pro' });

/** La consola en vivo con lo que cada test necesite cambiar. */
function consola(over: Partial<AlertasEnVivo> = {}): AlertasEnVivo {
  return {
    ...SIN_CONSOLA,
    alertas: [makeAlert({ id: 7, drone_id: 'd1', snapshot: 'QUFB' })],
    drones: [ALFA],
    statuses: { d1: makeStatus({ droneId: 'd1', state: 'ORBITING', battery: 64, target: OBJETIVO }) },
    decidir: vi.fn(),
    verDron: vi.fn(),
    abrirAlerta: vi.fn(),
    ...over,
  };
}

function montar(
  props: Partial<Parameters<typeof DetalleDeAlerta>[0]> = {},
  vivo: AlertasEnVivo | null = consola(),
) {
  const onIrAlVideo = vi.fn();
  const detalle = <DetalleDeAlerta alertaId={7} onIrAlVideo={onIrAlVideo} {...props} />;
  const envolver = (hijo: ReactNode) =>
    vivo ? <ContextoDeAlertas.Provider value={vivo}>{hijo}</ContextoDeAlertas.Provider> : hijo;
  const { rerender, unmount } = render(envolver(detalle));
  const conConsola = (nueva: AlertasEnVivo) =>
    rerender(<ContextoDeAlertas.Provider value={nueva}>{detalle}</ContextoDeAlertas.Provider>);
  return { onIrAlVideo, vivo, conConsola, unmount };
}

/** El valor de una fila de datos, buscado por su rótulo. */
function dato(rotulo: string): HTMLElement {
  const dt = screen.getAllByText(rotulo, { selector: 'dt' })[0];
  return dt.nextElementSibling as HTMLElement;
}

describe('DetalleDeAlerta', () => {
  beforeEach(() => {
    apiMock.mockReset();
    limpiarEstadoMapa();
  });

  it('con la alerta en la consola no la pide: muestra captura, mapa, dron y objetivo en vivo', () => {
    montar();

    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Alerta #7/ })).toHaveTextContent('Pendiente');
    expect(screen.getByAltText('Captura de la detección')).toHaveAttribute('src', 'data:image/jpeg;base64,QUFB');
    expect(screen.getByText('PERSONA')).toHaveClass('badge', 'person');
    expect(dato('Coordenadas')).toHaveTextContent('-34.600000, -58.400000');
    expect(dato('Objetivo ahora')).toHaveTextContent('-34.604100, -58.381700 · En movimiento');
    expect(dato('Resolución')).toHaveTextContent('Sin resolver');
    expect(dato('Detectada').querySelector('time')).toHaveAttribute('dateTime', '2024-01-01T12:00:00.000Z');

    // El dron: quién es y qué está haciendo ahora.
    expect(dato('Nombre')).toHaveTextContent('Alfa');
    expect(dato('Modelo')).toHaveTextContent('DJI Mini 4 Pro');
    expect(dato('Identificador')).toHaveTextContent('c54ae4…335c');
    expect(dato('Conexión')).toHaveTextContent('En línea');
    expect(dato('Estado')).toHaveTextContent('Orbitando objetivo');
    expect(dato('Batería')).toHaveTextContent('64');
    expect(dato('Posición actual')).toHaveTextContent('-34.601230, -58.404560');

    // El mapa marca los tres puntos.
    expect(screen.getByTestId('mapa-alerta')).toBeInTheDocument();
    expect(estadoMapa.puestas.filter((c) => c.clase === 'marker')).toHaveLength(3);
  });

  it('valida y descarta con el id de la alerta, y dice qué hace cada botón con el dron', async () => {
    const { vivo } = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(vivo!.decidir).toHaveBeenCalledWith(7, 'VALIDATED');
    await userEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(vivo!.decidir).toHaveBeenCalledWith(7, 'DISMISSED');
    expect(screen.getByText(/Validar: el dron se queda sobre el objetivo/)).toBeInTheDocument();
    // Está en la lista de la consola: la decisión vuelve por el WebSocket, no hay que pedirla.
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('mientras la decisión viaja no se puede volver a apretar, y un rechazo se lee al lado', async () => {
    let rechazar: (e: Error) => void = () => {};
    const decidir = vi.fn(() => new Promise<void>((_, r) => (rechazar = r)));
    montar({}, consola({ decidir }));

    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(screen.getByRole('button', { name: 'Validar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Descartar' })).toBeDisabled();

    await act(async () => rechazar(new Error('Esta alerta ya la decidió otro operador.')));
    expect(screen.getByRole('alert')).toHaveTextContent('ya la decidió otro operador');
    expect(screen.getByRole('button', { name: 'Validar' })).toBeEnabled();
  });

  it('"Ver feed en vivo" lleva a la vista del dron y cierra lo que lo contiene', async () => {
    const { vivo, onIrAlVideo } = montar();
    const boton = screen.getByRole('button', { name: 'Ver feed en vivo' });
    expect(boton).toHaveAttribute('title', 'Abrir la vista de Alfa');

    await userEvent.click(boton);
    expect(vivo!.verDron).toHaveBeenCalledWith('d1');
    expect(onIrAlVideo).toHaveBeenCalled();
  });

  it('una alerta de un dron que ya no está en la flota no ofrece el video', () => {
    montar({}, consola({ drones: [], statuses: {} }));
    expect(screen.getByRole('button', { name: 'Ver feed en vivo' })).toBeDisabled();
    expect(dato('Conexión')).toHaveTextContent('Ya no está en la flota');
    expect(dato('Nombre')).toHaveTextContent('Dron desconocido');
    // Sin status no hay estado, batería ni posición que mostrar.
    expect(screen.queryByText('Batería')).not.toBeInTheDocument();
  });

  it('con un dron desconectado lo dice, y su posición vieja no se dibuja', () => {
    montar({}, consola({ drones: [{ ...ALFA, online: false }], statuses: {} }));
    expect(dato('Conexión')).toHaveTextContent('Desconectado');
    // Sólo la detección: la consola ya no tiene telemetría de ese dron.
    expect(estadoMapa.puestas.filter((c) => c.clase === 'marker')).toHaveLength(1);
  });

  it('una alerta decidida no se puede volver a decidir: dice quién y cuándo', () => {
    const decidida = makeAlert({
      id: 7,
      drone_id: 'd1',
      status: 'VALIDATED',
      decided_by: 'oper1',
      decided_at: '2024-01-01T12:05:00.000Z',
    });
    montar({}, consola({ alertas: [decidida] }));
    expect(screen.queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Validar: el dron/)).not.toBeInTheDocument();
    expect(dato('Resolución')).toHaveTextContent(/^Validada por oper1 · /);
    expect(screen.getByRole('heading', { name: /Alerta #7/ })).toHaveTextContent('Validada');
    // El video sigue a mano: la decisión no cambia que se lo quiera ver.
    expect(screen.getByRole('button', { name: 'Ver feed en vivo' })).toBeEnabled();
  });

  it('una decidida sin quién ni cuándo (una fila vieja) lo dice con rayas', () => {
    montar({}, consola({ alertas: [makeAlert({ id: 7, drone_id: 'd1', status: 'DISMISSED' })] }));
    expect(dato('Resolución')).toHaveTextContent('Descartada por — · —');
  });

  it('quien no puede decidir no ve los botones de decisión', () => {
    montar({}, consola({ decidir: null }));
    expect(screen.queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver feed en vivo' })).toBeInTheDocument();
  });

  it('sigue a la consola: si otro operador la decide con el pop-up abierto, se ve en el acto', () => {
    const { conConsola } = montar();
    expect(screen.getByRole('button', { name: 'Validar' })).toBeInTheDocument();

    conConsola(
      consola({
        alertas: [makeAlert({ id: 7, drone_id: 'd1', status: 'DISMISSED', decided_by: 'oper2', decided_at: null })],
      }),
    );
    expect(screen.queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
    expect(dato('Resolución')).toHaveTextContent('Descartada por oper2 · —');
  });

  it('el objetivo de OTRA alerta no se muestra como el de ésta', () => {
    montar({}, consola({ statuses: { d1: makeStatus({ target: { ...OBJETIVO, alertId: 99 } }) } }));
    expect(screen.queryByText('Objetivo ahora')).not.toBeInTheDocument();
  });

  // El hub reenvía `target` tal cual lo manda la app: una posición en null o
  // NaN rompía el render (`null.toFixed`) o a Leaflet ("Invalid LatLng"), y sin
  // un límite de errores la consola entera quedaba en blanco.
  it.each([
    ['null', null],
    ['NaN', Number.NaN],
  ])('un objetivo con la latitud en %s no rompe el pop-up: se lo nombra sin posición y no va al mapa', (_, lat) => {
    const target = { ...OBJETIVO, lat: lat as unknown as number };
    montar({}, consola({ statuses: { d1: makeStatus({ droneId: 'd1', target }) } }));

    expect(screen.getByTestId('detalle-alerta')).toBeInTheDocument();
    // El seguimiento sigue siendo un dato: se dice qué hace, aunque no dónde está.
    expect(dato('Objetivo ahora')).toHaveTextContent('Sin posición estimada · En movimiento');
    // En el mapa quedan la detección y el dron; la mira del objetivo no se pone.
    const marcadores = estadoMapa.puestas.filter((c) => c.clase === 'marker');
    expect(marcadores.map((m) => m.etiqueta)).toEqual(['Detección', 'Alfa']);
    expect(within(screen.getByTestId('leyenda-mapa-alerta')).queryByText('Objetivo ahora')).not.toBeInTheDocument();
  });

  it('si lo único con coordenadas era un objetivo sin posición válida, no se arma el mapa', () => {
    const target = { ...OBJETIVO, lat: null as unknown as number, lon: null as unknown as number };
    montar(
      {},
      consola({
        alertas: [makeAlert({ id: 7, drone_id: 'd1', lat: null, lon: null })],
        statuses: { d1: makeStatus({ droneId: 'd1', gpsFix: false, target }) },
      }),
    );
    expect(screen.getByText('No hay coordenadas para ubicarla en el mapa.')).toBeInTheDocument();
    expect(estadoMapa.mapasCreados).toBe(0);
  });

  it('sin GPS dice cuántos satélites tiene, y una batería que no es número queda en raya', () => {
    montar(
      {},
      consola({
        statuses: { d1: makeStatus({ gpsFix: false, satellites: 3, battery: 'mucha' as unknown as number }) },
      }),
    );
    expect(dato('Posición actual')).toHaveTextContent('Sin GPS (3 satélites)');
    expect(dato('Batería')).toHaveTextContent('—');
  });

  it('sin ninguna coordenada lo dice en lugar del mapa', () => {
    montar({}, consola({ alertas: [makeAlert({ id: 7, drone_id: 'd1', lat: null, lon: null })], statuses: {} }));
    expect(screen.getByText('No hay coordenadas para ubicarla en el mapa.')).toBeInTheDocument();
    expect(screen.queryByTestId('mapa-alerta')).not.toBeInTheDocument();
  });

  it('sin la consola alrededor la trae del backend y no ofrece ni decidir ni ir al video', async () => {
    apiMock.mockResolvedValue(makeAlert({ id: 7, snapshot: null, type: 'VEHICLE' }));
    montar({}, null);

    expect(screen.getByText('Trayendo la alerta…')).toBeInTheDocument();
    expect(await screen.findByText('La detección no dejó captura.')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/alerts/7');
    expect(screen.queryByText('Trayendo la alerta…')).not.toBeInTheDocument();
    expect(screen.getByText('VEHÍCULO')).toBeInTheDocument();
    expect(dato('Conexión')).toHaveTextContent('—');
    expect(screen.queryByRole('button', { name: 'Ver feed en vivo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
  });

  it('si no la puede traer, muestra lo que guardó el evento y el dron del evento', async () => {
    apiMock.mockRejectedValue(new Error('Alerta inexistente'));
    montar(
      {
        referencia: { id: 7, tipo: 'PERSON', lat: -34.61, lon: -58.42, ts: '2024-02-02T10:00:00.000Z' },
        dronDeRespaldo: { hash: 'abc', displayName: 'Bravo', model: 'DJI Air 3' },
      },
      consola({ alertas: [] }),
    );
    expect(await screen.findByText('No se pudo traer la alerta: Alerta inexistente')).toBeInTheDocument();
    expect(screen.getByText('PERSONA')).toBeInTheDocument();
    expect(dato('Coordenadas')).toHaveTextContent('-34.610000, -58.420000');
    expect(dato('Detectada').querySelector('time')).toHaveAttribute('dateTime', '2024-02-02T10:00:00.000Z');
    expect(dato('Nombre')).toHaveTextContent('Bravo');
    expect(dato('Modelo')).toHaveTextContent('DJI Air 3');
    expect(dato('Identificador')).toHaveTextContent('abc');
    // Sin alerta no se sabe si está pendiente: no se ofrece decidirla.
    expect(screen.queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
  });

  it('un rechazo que no es un Error también se lee', async () => {
    apiMock.mockRejectedValue('se cortó');
    montar({}, null);
    expect(await screen.findByText('No se pudo traer la alerta: se cortó')).toBeInTheDocument();
    expect(dato('Tipo')).toHaveTextContent('—');
    expect(dato('Detectada')).toHaveTextContent('—');
  });

  it('la que trae quien la abre no se pide; al decidirla fuera de la lista se vuelve a pedir', async () => {
    const conocida = makeAlert({ id: 7, drone_id: 'd1' });
    apiMock.mockResolvedValue({ ...conocida, status: 'VALIDATED', decided_by: 'admin1' } as Alert);
    const decidir = vi.fn().mockResolvedValue(undefined);
    montar({ conocida, conTitulo: false }, consola({ alertas: [], decidir }));

    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: /Alerta #7/ })).not.toBeInTheDocument();

    // La consola no la sigue por el WebSocket: sin volver a pedirla, el
    // pop-up seguiría diciendo "Pendiente".
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/alerts/7'));
    expect(await screen.findByText(/^Validada por admin1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
  });

  it('la respuesta que llega con el detalle ya cerrado no se escribe', async () => {
    let contestar: (a: Alert) => void = () => {};
    let fallar: (e: Error) => void = () => {};
    apiMock.mockImplementationOnce(() => new Promise((r) => (contestar = r)));
    const primero = montar({}, null);
    primero.unmount();
    await act(async () => contestar(makeAlert({ id: 7 })));

    apiMock.mockImplementationOnce(() => new Promise((_, r) => (fallar = r)));
    const segundo = montar({}, null);
    segundo.unmount();
    await act(async () => fallar(new Error('tarde')));
    expect(screen.queryByText(/tarde/)).not.toBeInTheDocument();
  });

  it('el nombre del dron sin ficha en la flota cae al del evento, y si no hay, a "Dron"', () => {
    montar(
      {},
      consola({ drones: [], statuses: { d1: makeStatus({ droneId: 'd1' }) } }),
    );
    const detalle = screen.getByTestId('detalle-alerta');
    expect(within(detalle).getByText('Dron desconocido')).toBeInTheDocument();
    // En el mapa el dron se rotula igual, aunque no se sepa su nombre.
    const dron = estadoMapa.puestas.filter((c) => c.clase === 'marker').at(-1);
    expect(dron?.etiqueta).toBe('Dron');
  });
});
