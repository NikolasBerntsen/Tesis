import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DroneDetail from './DroneDetail';
import type { MapItem } from './DronesMap';
import { api, rutasDeBase } from '../api';
import { makeAlert, makeDrone, makeEvent, makeMe, makeRoute, makeStatus } from '../test/fixtures';
import type { Alert, ObjetivoEnSeguimiento } from '../types';

// El mapa anota los items que recibe: es la forma de ver que el rastro del
// objetivo baja hasta él sin correr Leaflet.
const { mapa } = vi.hoisted(() => ({ mapa: { items: [] as MapItem[] } }));
vi.mock('./DronesMap', () => ({
  default: ({ items }: { items: MapItem[] }) => {
    mapa.items = items;
    return <div data-testid="mapa-mock" />;
  },
}));
vi.mock('../api', () => ({ api: vi.fn(), rutasDeBase: vi.fn() }));
// El minimapa de la vista de pilotaje sí usa Leaflet: va el doble compartido.
vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
const apiMock = vi.mocked(api);
const rutasDeBaseMock = vi.mocked(rutasDeBase);

/** La vista de pilotaje abierta, o `null`. */
const vistaDePilotaje = () => screen.queryByRole('dialog', { name: 'Pilotaje de Alfa' });

/**
 * Abre la vista de pilotaje desde la tarjeta, que es como se vuelve a ella con
 * el control ya tomado. Espera la carga del detalle antes: sin eso las
 * respuestas del historial caen fuera del test.
 */
async function abrirPilotaje(): Promise<HTMLElement> {
  await esperarCarga();
  fireEvent.click(screen.getByRole('button', { name: 'Volver a la vista de pilotaje' }));
  return screen.getByRole('dialog', { name: 'Pilotaje de Alfa' });
}

/** Una tecla de vuelo: la vista escucha la ventana, no un elemento enfocado. */
const apretar = (code: string) => fireEvent.keyDown(window, { code });
const soltar = (code: string) => fireEvent.keyUp(window, { code });

function renderDetail(props: Partial<Parameters<typeof DroneDetail>[0]> = {}) {
  const base = {
    me: makeMe({ username: 'admin1', role: 'admin', canControl: true }),
    drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true }),
    status: makeStatus({ droneId: 'd1', state: 'PATROLLING', routeId: null }),
    frame: null as string | null,
    conectado: true,
    liveEvents: [],
    routes: [makeRoute({ id: 1, name: 'Ruta Perimetral' })],
    alertas: [] as Alert[],
    onDecidir: vi.fn(),
    onBack: vi.fn(),
    onRename: vi.fn(),
    onWaypointLabel: vi.fn(),
    // Devuelve true: el mensaje salió por el socket. Que devuelva false es el
    // caso del enlace cortado, y tiene su propio test.
    onMando: vi.fn(() => true),
    onCamara: vi.fn(() => true),
  };
  const merged = { ...base, ...props } as Parameters<typeof DroneDetail>[0];
  const { rerender } = render(<DroneDetail {...merged} />);
  // Volver a renderizar con algo cambiado es la única forma de probar lo que le
  // pasa al mando EN el momento en que se cae el enlace o llega el primer status:
  // con un render nuevo el estado del mando arrancaría de cero.
  const volverARenderizar = (cambios: Partial<Parameters<typeof DroneDetail>[0]>) =>
    rerender(<DroneDetail {...merged} {...cambios} />);
  return { ...merged, volverARenderizar };
}

/**
 * Espera a que el detalle termine de cargar lo que pide al montar (historial y
 * rutas de la base). Sin esto, las respuestas caen después del test y React
 * avisa que hubo una actualización fuera de `act`.
 */
const esperarCarga = () => screen.findByRole('option', { name: /Ruta Perimetral/ });

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

  it('sin alertas pendientes no hay tarjeta de alerta', async () => {
    renderDetail({ alertas: [makeAlert({ id: 1, status: 'VALIDATED' })] });
    await esperarCarga();
    expect(screen.queryByRole('heading', { name: 'Alerta en curso' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
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

describe('DroneDetail — vuelo continuo y vista de pilotaje', () => {
  const mando = () => screen.queryByRole('group', { name: 'Mando virtual de vuelo continuo' });
  const volver = () => screen.queryByRole('button', { name: 'Volver a la vista de pilotaje' });

  it('sin el control tomado no hay vuelo continuo ni vista de pilotaje', async () => {
    renderDetail({ drone: makeDrone({ controlledBy: null }) });
    expect(await screen.findByRole('button', { name: 'Tomar control manual' })).toBeInTheDocument();
    expect(screen.getByText(/Se abre la vista de pilotaje/)).toBeInTheDocument();
    expect(mando()).not.toBeInTheDocument();
    expect(volver()).not.toBeInTheDocument();
  });

  it('tampoco si el control lo tiene otro', async () => {
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
    });
    expect(await screen.findByText(/Controlado por/)).toBeInTheDocument();
    expect(mando()).not.toBeInTheDocument();
    expect(volver()).not.toBeInTheDocument();
  });

  it('tomar el control abre la vista de pilotaje', async () => {
    renderDetail({ drone: makeDrone({ controlledBy: null }) });
    await esperarCarga();
    fireEvent.click(screen.getByRole('button', { name: 'Tomar control manual' }));
    expect(await screen.findByRole('dialog', { name: 'Pilotaje de Alfa' })).toBeInTheDocument();
    // El lock todavía no llegó (el `control_changed` viene después del POST):
    // la vista espera, no se cierra.
    expect(screen.getByTestId('pilotaje-esperando-control')).toBeInTheDocument();
  });

  it('si el backend no da el control, la vista no se abre', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([]);
      return Promise.reject(new Error('Otro operador ya tiene el control'));
    });
    renderDetail({ drone: makeDrone({ controlledBy: null }) });
    await userEvent.click(screen.getByRole('button', { name: 'Tomar control manual' }));
    expect(await screen.findByText('Otro operador ya tiene el control')).toBeInTheDocument();
    expect(vistaDePilotaje()).not.toBeInTheDocument();
  });

  it('con el control tomado la tarjeta conserva el pad y ofrece volver a la vista, donde vuela el teclado', async () => {
    const props = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1' }),
      // El status viene como lo reenvía el Comando Central: con el dueño del lock
      // estampado, o sea que es POSTERIOR a que se tomara el control.
      status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1' }),
    });

    // El pad de 25 m sigue en la tarjeta; el mando de palancas ya no.
    expect(screen.getByRole('button', { name: 'Mover al norte' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Desplazamiento puntual' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Vuelo continuo' })).toBeInTheDocument();
    expect(screen.getByText(/es un salto puntual/)).toBeInTheDocument();
    expect(mando()).not.toBeInTheDocument();
    // Sin la vista abierta, el teclado no vuela.
    apretar('KeyW');
    expect(props.onMando).not.toHaveBeenCalled();
    soltar('KeyW');

    const vista = await abrirPilotaje();
    // El dron ya confirmó el vuelo manual: no hay nada que esperar ni que avisar.
    expect(within(vista).queryByTestId('pilotaje-esperando')).not.toBeInTheDocument();
    expect(within(vista).queryByTestId('pilotaje-impedimento')).not.toBeInTheDocument();

    apretar('KeyW');
    expect(props.onMando).toHaveBeenCalledWith({ pitch: 0.5, roll: 0, yaw: 0, throttle: 0 });
    soltar('KeyW');
    expect(props.onMando).toHaveBeenLastCalledWith({ pitch: 0, roll: 0, yaw: 0, throttle: 0 });
  });

  /**
   * Tener el lock no alcanza para que el dron obedezca: el backend no lo suelta
   * cuando la app se va sola a volver a base, y el socket de la consola se cae
   * y reconecta cada 3 s. En todos esos casos la vista dice el motivo y el
   * teclado no comanda.
   */
  const IMPEDIMENTOS = [
    {
      caso: 'el dron se desconectó',
      props: {
        drone: makeDrone({ controlledBy: 'admin1', online: false }),
        status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1' }),
      },
      motivo: 'El dron está desconectado: el mando no responde.',
    },
    {
      caso: 'se cortó el canal con el Comando Central',
      props: {
        drone: makeDrone({ controlledBy: 'admin1' }),
        status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1' }),
        conectado: false,
      },
      motivo: 'Sin conexión con el Comando Central: el mando no responde.',
    },
    {
      // El status trae estampado al dueño del lock, así que es del dron YA con el
      // control tomado: cuando dice que no está en manual, no está en manual.
      caso: 'el dron confirmó que dejó el vuelo manual',
      props: {
        drone: makeDrone({ controlledBy: 'admin1' }),
        status: makeStatus({ state: 'RETURNING_HOME_BATTERY', controlledBy: 'admin1' }),
      },
      motivo: 'El dron no está en vuelo manual (Volviendo a base (batería baja)): el mando no responde.',
    },
  ] as const;

  it.each(IMPEDIMENTOS)('$caso: la vista dice por qué y el teclado no comanda', async ({ props, motivo }) => {
    const usados = renderDetail({ me: makeMe({ username: 'admin1', canControl: true }), ...props });
    const vista = await abrirPilotaje();
    expect(within(vista).getByTestId('pilotaje-impedimento')).toHaveTextContent(motivo);
    expect(within(vista).queryByTestId('pilotaje-esperando')).not.toBeInTheDocument();

    apretar('KeyW');
    expect(usados.onMando).not.toHaveBeenCalled();
    // Los sticks virtuales de la vista heredan el mismo motivo.
    fireEvent.click(within(vista).getByRole('button', { name: 'Mostrar sticks virtuales' }));
    expect(within(vista).getByTestId('mando-impedimento')).toHaveTextContent(motivo);
  });

  /**
   * El intervalo entre tomar el control y la confirmación del dron. El lock se
   * ve al instante —el backend broadcastea `control_changed` en el acto— pero el
   * estado `MANUAL` tarda hasta un segundo de la app (`statusTicker`, que manda
   * cada 1 s y no empuja nada al cambiar de estado) más otro del volcado de la
   * consola. Bloquear el mando ahí rompía el camino más normal que hay: tomar el
   * control y mover la palanca.
   */
  const ESPERANDO = [
    {
      caso: 'el status que hay es de antes de tomar el control',
      // Lo que el operador tiene en pantalla es el último status del patrullaje:
      // sin el dueño del lock estampado, porque cuando se reenvió no había lock.
      status: makeStatus({ state: 'PATROLLING', controlledBy: null }),
    },
    {
      // La app aplica el mando en cuanto entra en MANUAL, tenga o no telemetría
      // del DJI para reportar (`statusTicker` no manda status hasta que la hay),
      // así que "sin telemetría" no es motivo para tragarse el gesto.
      caso: 'todavía no llegó ningún status',
      status: null,
    },
  ] as const;

  it.each(ESPERANDO)('$caso: el teclado emite igual y la vista avisa que falta la confirmación', async ({ status }) => {
    const usados = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status,
    });
    const vista = await abrirPilotaje();
    expect(within(vista).queryByTestId('pilotaje-impedimento')).not.toBeInTheDocument();
    expect(within(vista).getByTestId('pilotaje-esperando')).toHaveTextContent(/todavía no confirmó el vuelo manual/);

    // Y lo que importa: el gesto no se traga, el eje sale.
    apretar('Space');
    expect(usados.onMando).toHaveBeenCalledWith({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5 });
    soltar('Space');
  });

  it('llegado el status con el vuelo manual, el aviso de espera se va solo', async () => {
    const usados = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status: makeStatus({ state: 'PATROLLING', controlledBy: null }),
    });
    await abrirPilotaje();
    expect(screen.getByTestId('pilotaje-esperando')).toBeInTheDocument();

    // Un segundo después llega el status de la app con el control ya aplicado.
    usados.volverARenderizar({ status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1' }) });
    expect(screen.queryByTestId('pilotaje-esperando')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pilotaje-impedimento')).not.toBeInTheDocument();
  });

  it('si el enlace se corta en pleno vuelo manual, la vista dice el motivo Y que el comando no salió', async () => {
    const onMando = vi.fn(() => true);
    const usados = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1' }),
      onMando,
    });
    await abrirPilotaje();
    apretar('KeyW');
    expect(onMando).toHaveBeenCalledWith({ pitch: 0.5, roll: 0, yaw: 0, throttle: 0 });

    // Se cae el socket de la consola: `conectado` pasa a false y el `enviar` del
    // canal empieza a devolver false, las dos cosas por el mismo motivo. El
    // cero de cierre ya no sale, y eso es lo que hay que decir.
    onMando.mockReturnValue(false);
    usados.volverARenderizar({ conectado: false, onMando });

    expect(screen.getByTestId('pilotaje-impedimento')).toHaveTextContent(
      'Sin conexión con el Comando Central: el mando no responde.',
    );
    expect(screen.getByTestId('pilotaje-no-salio')).toHaveTextContent(/El último comando no salió/);
  });

  it('la rueda inclina la cámara por la prop, también con el dron en el suelo', async () => {
    const usados = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1', flying: false }),
    });
    await abrirPilotaje();
    // En el suelo el mando no responde, pero inclinar la cámara no le hace
    // nada a nadie y sirve para mirar antes de despegar.
    expect(screen.getByTestId('pilotaje-impedimento')).toHaveTextContent('El dron está en el suelo');
    fireEvent.wheel(screen.getByTestId('pilotaje-video'), { deltaY: -100, deltaMode: 0 });
    expect(usados.onCamara).toHaveBeenCalledWith(-25);
  });

  it('sin enlace con el Comando Central la rueda no manda la cámara', async () => {
    const usados = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1' }),
      conectado: false,
    });
    await abrirPilotaje();
    fireEvent.wheel(screen.getByTestId('pilotaje-video'), { deltaY: -100, deltaMode: 0 });
    expect(usados.onCamara).not.toHaveBeenCalled();
  });
});

describe('DroneDetail — salir de la vista de pilotaje', () => {
  const conControl = (status: Parameters<typeof makeStatus>[0] = {}) => ({
    me: makeMe({ username: 'admin1', canControl: true }),
    drone: makeDrone({ controlledBy: 'admin1', online: true }),
    status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1', flying: true, ...status }),
  });

  async function confirmarSalida(vista: HTMLElement) {
    fireEvent.click(within(vista).getByRole('button', { name: 'Salir del control manual' }));
    const dialogo = screen.getByRole('dialog', { name: '¿Salir del control manual?' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salir del control manual' }));
  }

  it('sin objetivo, salir suelta el control y el dron vuelve a patrullar', async () => {
    renderDetail(conControl());
    await confirmarSalida(await abrirPilotaje());
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', {
        method: 'DELETE',
        body: JSON.stringify({ resume: 'last' }),
      }),
    );
    // Lo cerró el operador: no hay nada que explicarle.
    expect(screen.queryByTestId('aviso-pilotaje')).not.toBeInTheDocument();
  });

  it('con objetivo, salir lo devuelve al objetivo', async () => {
    renderDetail(conControl({ target: OBJETIVO }));
    await confirmarSalida(await abrirPilotaje());
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', {
        method: 'DELETE',
        body: JSON.stringify({ resume: 'none' }),
      }),
    );
  });

  it('cerrar la vista sin soltar deja el control y la tarjeta ofrece volver', async () => {
    renderDetail(conControl());
    const vista = await abrirPilotaje();
    fireEvent.click(within(vista).getByRole('button', { name: 'Salir del control manual' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar la vista sin soltar' }));
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/control', expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByRole('button', { name: 'Volver a la vista de pilotaje' })).toBeInTheDocument();
  });

  it('si un supervisor se lleva el control, la vista se cierra y dice quién', async () => {
    const usados = renderDetail(conControl());
    await abrirPilotaje();
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'super1', online: true }) });
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    expect(screen.getByTestId('aviso-pilotaje')).toHaveTextContent(
      'super1 tomó el control del dron: se cerró la vista de pilotaje.',
    );
  });

  it('si el control se suelta desde otra sesión, la vista se cierra y lo dice', async () => {
    const usados = renderDetail(conControl());
    await abrirPilotaje();
    usados.volverARenderizar({
      drone: makeDrone({ controlledBy: null, online: true }),
      status: makeStatus({ state: 'PATROLLING', controlledBy: null }),
    });
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    expect(screen.getByTestId('aviso-pilotaje')).toHaveTextContent('El control manual se soltó desde otra sesión');

    // Al volver a tomarlo, el aviso viejo se va.
    fireEvent.click(screen.getByRole('button', { name: 'Tomar control manual' }));
    expect(screen.queryByTestId('aviso-pilotaje')).not.toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: 'Pilotaje de Alfa' })).toBeInTheDocument();
  });

  it('si el dron se desconecta, la vista se cierra y dice que el control se soltó por eso', async () => {
    const usados = renderDetail(conControl());
    await abrirPilotaje();
    // `drone_offline`: el backend borra el lock del dron y la consola olvida
    // su telemetría, así que no queda nadie a cargo.
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: null, online: false }), status: null });
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    expect(screen.getByTestId('aviso-pilotaje')).toHaveTextContent(
      'El dron se desconectó del Comando Central y el control manual se soltó: se cerró la vista de pilotaje.',
    );
  });

  it('si se corta el canal y al reconectar el control ya no es suyo, dice que se soltó por el corte', async () => {
    const usados = renderDetail(conControl());
    await abrirPilotaje();
    // Se cae el canal: la consola todavía no sabe nada y la vista sigue.
    usados.volverARenderizar({ conectado: false });
    expect(vistaDePilotaje()).toBeInTheDocument();
    // Vuelve, todavía con la ficha de antes del corte.
    usados.volverARenderizar({ conectado: true });
    expect(vistaDePilotaje()).toBeInTheDocument();

    // Llega la lista de drones que la consola vuelve a pedir: el backend soltó
    // el control al cerrarse la última consola de la cuenta. El status de
    // antes del corte todavía lo nombra, así que la vista espera al próximo.
    const fichaNueva = makeDrone({ controlledBy: null, online: true });
    usados.volverARenderizar({ drone: fichaNueva });
    expect(vistaDePilotaje()).toBeInTheDocument();
    usados.volverARenderizar({ drone: fichaNueva, status: makeStatus({ state: 'PATROLLING', controlledBy: null }) });

    expect(vistaDePilotaje()).not.toBeInTheDocument();
    expect(screen.getByTestId('aviso-pilotaje')).toHaveTextContent(
      'Se cortó la conexión con el Comando Central y el control manual se soltó solo: se cerró la vista de pilotaje.',
    );
  });

  it('si el corte no le costó el control, una pérdida posterior no se le achaca al corte', async () => {
    const usados = renderDetail(conControl());
    await abrirPilotaje();
    usados.volverARenderizar({ conectado: false });
    // Había otra consola de la cuenta abierta: la ficha nueva sigue a su nombre.
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'admin1', online: true }) });
    expect(vistaDePilotaje()).toBeInTheDocument();

    usados.volverARenderizar({
      drone: makeDrone({ controlledBy: null, online: true }),
      status: makeStatus({ state: 'PATROLLING', controlledBy: null }),
    });
    expect(screen.getByTestId('aviso-pilotaje')).toHaveTextContent('El control manual se soltó desde otra sesión');
  });

  it('recién tomado, la vista espera el lock y cuando llega el teclado vuela', async () => {
    const usados = renderDetail({ drone: makeDrone({ controlledBy: null, online: true }) });
    await esperarCarga();
    fireEvent.click(screen.getByRole('button', { name: 'Tomar control manual' }));
    await screen.findByRole('dialog', { name: 'Pilotaje de Alfa' });
    apretar('KeyD');
    expect(usados.onMando).not.toHaveBeenCalled();
    soltar('KeyD');

    usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'admin1', online: true }) });
    expect(vistaDePilotaje()).toBeInTheDocument();
    apretar('KeyD');
    expect(usados.onMando).toHaveBeenCalledWith({ pitch: 0, roll: 0.5, yaw: 0, throttle: 0 });
    soltar('KeyD');
  });

  it('al cambiar de dron, la vista se cierra', async () => {
    const usados = renderDetail(conControl());
    await abrirPilotaje();
    usados.volverARenderizar({ drone: makeDrone({ droneId: 'd2', displayName: 'Beta', controlledBy: 'admin1' }) });
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    await esperarCarga();
  });

  it('una alerta de este dron que llega mientras se vuela se avisa en el HUD', async () => {
    const usados = renderDetail(conControl());
    const vista = await abrirPilotaje();
    usados.volverARenderizar({ alertas: [makeAlert({ id: 40, drone_id: 'd1', status: 'PENDING', type: 'VEHICLE' })] });
    expect(within(vista).getByTestId('pilotaje-alerta-nueva')).toHaveTextContent('Nueva alerta sin decidir: Vehículo.');
  });
});

describe('DroneDetail — despegar y aterrizar desde la vista de pilotaje', () => {
  const conControl = (status: Parameters<typeof makeStatus>[0]) => ({
    me: makeMe({ username: 'admin1', canControl: true }),
    drone: makeDrone({ controlledBy: 'admin1', online: true }),
    status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1', ...status }),
  });

  it('en el suelo se despega desde la vista, con la misma confirmación, y el HUD avisa la orden', async () => {
    const usados = renderDetail(conControl({ flying: false }));
    const vista = await abrirPilotaje();
    fireEvent.click(within(vista).getByRole('button', { name: 'Despegar' }));

    const dialogo = screen.getByRole('dialog', { name: 'Despegar Alfa' });
    expect(dialogo).toHaveTextContent('El dron despega en el lugar y queda suspendido a ~1,2 m; funciona sin GPS');
    // Con el diálogo encima, el teclado no vuela: Espacio es del diálogo.
    apretar('Space');
    expect(usados.onMando).not.toHaveBeenCalled();

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Despegar' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/takeoff', { method: 'POST' }));
    expect(await within(vista).findByTestId('pilotaje-orden-en-curso')).toHaveTextContent(/Despegue ordenado/);
    expect(vistaDePilotaje()).toBeInTheDocument();
  });

  it('en el aire se aterriza desde la vista', async () => {
    renderDetail(conControl({ flying: true }));
    const vista = await abrirPilotaje();
    fireEvent.click(within(vista).getByRole('button', { name: 'Aterrizar' }));
    const dialogo = screen.getByRole('dialog', { name: 'Aterrizar Alfa' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Aterrizar' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/land', { method: 'POST' }));
    expect(await within(vista).findByTestId('pilotaje-orden-en-curso')).toHaveTextContent(/Aterrizaje ordenado/);
  });

  it('si el backend rechaza el despegue, el motivo se lee adentro de la vista', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([]);
      if (path.endsWith('/takeoff')) return Promise.reject(new Error('El dron rechazó el despegue'));
      return Promise.resolve({});
    });
    renderDetail(conControl({ flying: false }));
    const vista = await abrirPilotaje();
    fireEvent.click(within(vista).getByRole('button', { name: 'Despegar' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Despegar Alfa' })).getByRole('button', { name: 'Despegar' }));

    // El detalle de atrás está inerte (y en pantalla completa ni se pinta): si
    // el motivo sólo estuviera ahí, el operador no se enteraría de nada.
    expect(await within(vista).findByText('El dron rechazó el despegue')).toHaveAttribute('role', 'alert');
    expect(within(vista).queryByTestId('pilotaje-orden-en-curso')).not.toBeInTheDocument();
    expect(vistaDePilotaje()).toBeInTheDocument();
  });

  it('un error viejo del detalle no aparece al volver a la vista', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([]);
      if (path.endsWith('/manual_move')) return Promise.reject(new Error('El dron no pudo moverse'));
      return Promise.resolve({});
    });
    renderDetail(conControl({ flying: true }));
    await esperarCarga();
    fireEvent.click(screen.getByRole('button', { name: 'Mover al norte' }));
    expect(await screen.findByText('El dron no pudo moverse')).toBeInTheDocument();

    const vista = await abrirPilotaje();
    expect(within(vista).queryByTestId('pilotaje-error')).not.toBeInTheDocument();
    expect(screen.queryByText('El dron no pudo moverse')).not.toBeInTheDocument();
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

const OBJETIVO: ObjetivoEnSeguimiento = {
  alertId: 12,
  type: 'VEHICLE',
  lat: -34.60412,
  lon: -58.3817,
  speedMs: 4.2,
  courseDeg: 118,
  moving: true,
  lost: false,
  lastSeenMs: 600,
  decision: 'PENDING',
};

describe('DroneDetail — alerta en curso', () => {
  it('muestra la pendiente más nueva de ESTE dron al lado del video', async () => {
    renderDetail({
      alertas: [
        makeAlert({ id: 3, drone_id: 'd1', status: 'PENDING', type: 'PERSON' }),
        makeAlert({ id: 9, drone_id: 'd1', status: 'PENDING', type: 'VEHICLE', snapshot: 'QUFB' }),
        makeAlert({ id: 20, drone_id: 'otro', status: 'PENDING' }),
        makeAlert({ id: 15, drone_id: 'd1', status: 'DISMISSED' }),
      ],
    });
    const tarjeta = await screen.findByRole('region', { name: 'Alerta en curso' });
    // La de id 9: la más nueva de las pendientes de d1, aunque llegue segunda.
    expect(within(tarjeta).getByText('VEHÍCULO')).toBeInTheDocument();
    expect(within(tarjeta).getByAltText('Captura que disparó la detección')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,QUFB',
    );
    // La otra pendiente del mismo dron no se pierde: se avisa que está en la campana.
    expect(within(tarjeta).getByText(/otra alerta sin decidir/)).toBeInTheDocument();

    // Va en el par del video y el mapa, entre los dos.
    const par = document.body.querySelector('.par-video-mapa') as HTMLElement;
    expect(par).toHaveClass('con-alerta');
    expect(par.contains(tarjeta)).toBe(true);
  });

  it('valida y descarta desde la tarjeta con el id de la alerta', async () => {
    const props = renderDetail({ alertas: [makeAlert({ id: 9, drone_id: 'd1' })] });
    const tarjeta = await screen.findByRole('region', { name: 'Alerta en curso' });
    await userEvent.click(within(tarjeta).getByRole('button', { name: 'Validar' }));
    expect(props.onDecidir).toHaveBeenCalledWith(9, 'VALIDATED');
    await userEvent.click(within(tarjeta).getByRole('button', { name: 'Descartar' }));
    expect(props.onDecidir).toHaveBeenCalledWith(9, 'DISMISSED');
  });

  it('el rechazo de la decisión se muestra en la tarjeta', async () => {
    renderDetail({
      alertas: [makeAlert({ id: 9, drone_id: 'd1' })],
      onDecidir: vi.fn().mockRejectedValue(new Error('Esta alerta ya la decidió otro operador.')),
    });
    const tarjeta = await screen.findByRole('region', { name: 'Alerta en curso' });
    await userEvent.click(within(tarjeta).getByRole('button', { name: 'Validar' }));
    expect(await within(tarjeta).findByRole('alert')).toHaveTextContent('ya la decidió otro operador');
  });

  it('si el dron está sobre el objetivo de esa alerta, lo dice', async () => {
    renderDetail({
      alertas: [makeAlert({ id: 12, drone_id: 'd1' })],
      status: makeStatus({ state: 'ORBITING', target: OBJETIVO }),
    });
    const tarjeta = await screen.findByRole('region', { name: 'Alerta en curso' });
    expect(within(tarjeta).getByText(/El dron está sobre este objetivo/)).toBeInTheDocument();
  });
});

describe('DroneDetail — objetivo', () => {
  it('con objetivo muestra su panel, lo marca en la leyenda y le pasa el rastro al mapa', async () => {
    renderDetail({
      status: makeStatus({ state: 'FOLLOWING', target: OBJETIVO }),
      rastro: { alertId: 12, puntos: [[-34.6, -58.38], [-34.6041, -58.3817]] },
    });
    expect(await screen.findByRole('heading', { name: 'Objetivo' })).toBeInTheDocument();
    expect(screen.getByTestId('coordenadas-objetivo')).toHaveTextContent('-34.604120, -58.381700');
    expect(within(screen.getByTestId('leyenda-mapa')).getByText('Objetivo y su rastro')).toHaveClass('bad');
    expect(mapa.items[0].rastroObjetivo).toEqual([[-34.6, -58.38], [-34.6041, -58.3817]]);
  });

  it('un objetivo validado va en oro en la leyenda', async () => {
    renderDetail({ status: makeStatus({ state: 'ORBITING', target: { ...OBJETIVO, decision: 'VALIDATED' } }) });
    expect(await screen.findByText('Objetivo y su rastro')).toHaveClass('accent');
  });

  it('sin objetivo no hay panel ni leyenda del objetivo', async () => {
    renderDetail({ status: makeStatus({ state: 'PATROLLING', target: null }) });
    await esperarCarga();
    expect(screen.queryByRole('heading', { name: 'Objetivo' })).not.toBeInTheDocument();
    expect(screen.queryByText('Objetivo y su rastro')).not.toBeInTheDocument();
    expect(mapa.items[0].rastroObjetivo).toBeUndefined();
  });

  it('sin control tomado, reanudar dice que se deja el objetivo', async () => {
    renderDetail({ status: makeStatus({ state: 'ORBITING', target: OBJETIVO }), drone: makeDrone({ controlledBy: null }) });
    await userEvent.click(screen.getByRole('button', { name: 'Dejar el objetivo y reanudar patrullaje' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/resume', { method: 'POST', body: '{}' }),
    );
  });

  it('con el objetivo cargado, soltar el control por defecto lo devuelve al objetivo', async () => {
    renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1' }),
      status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1', flying: true, target: OBJETIVO }),
    });
    expect(screen.queryByRole('button', { name: 'Devolver al patrullaje' })).not.toBeInTheDocument();
    // El de reanudar de la tarjeta de estado no aparece: con el control tomado,
    // dejar el objetivo es una de las dos formas de soltar.
    expect(screen.queryByRole('button', { name: 'Dejar el objetivo y reanudar patrullaje' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Soltar control (el dron vuelve al objetivo)' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', {
        method: 'DELETE',
        body: JSON.stringify({ resume: 'none' }),
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Soltar y reanudar patrullaje' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', {
        method: 'DELETE',
        body: JSON.stringify({ resume: 'last' }),
      }),
    );
  });

  it('un supervisor que quita el control con objetivo lo devuelve al objetivo', async () => {
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
      status: makeStatus({ state: 'MANUAL', controlledBy: 'oper9', target: OBJETIVO }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', {
        method: 'DELETE',
        body: JSON.stringify({ resume: 'none' }),
      }),
    );
  });

  it('"Retomar ruta" avisa en su ayuda que deja el objetivo', async () => {
    renderDetail({ status: makeStatus({ state: 'MANUAL', target: OBJETIVO }) });
    await esperarCarga();
    expect(screen.getByRole('button', { name: 'Retomar ruta' })).toHaveAttribute(
      'title',
      'Deja el objetivo y vuelve al patrullaje, hacia el próximo nodo de la ruta',
    );
  });
});

describe('DroneDetail — en el suelo, despegar y aterrizar', () => {
  const conControl = (status: Parameters<typeof makeStatus>[0]) => ({
    me: makeMe({ username: 'admin1', canControl: true }),
    drone: makeDrone({ controlledBy: 'admin1', online: true }),
    status: makeStatus({ controlledBy: 'admin1', ...status }),
  });

  it('con el dron apoyado el encabezado dice "En tierra", no "En vuelo"', async () => {
    renderDetail({ status: makeStatus({ state: 'LANDED', flying: false }) });
    await esperarCarga();
    expect(screen.getByText('En tierra')).toBeInTheDocument();
    expect(screen.queryByText('En vuelo')).not.toBeInTheDocument();
  });

  it('en el suelo el mando queda inerte con la leyenda, y se ofrece despegar', async () => {
    const usados = renderDetail(conControl({ state: 'MANUAL', flying: false }));
    await esperarCarga();
    // En la tarjeta: despegar, que es lo único que se puede hacer.
    expect(screen.getByRole('button', { name: 'Despegar' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Aterrizar' })).not.toBeInTheDocument();

    const vista = await abrirPilotaje();
    expect(within(vista).getByTestId('pilotaje-impedimento')).toHaveTextContent(
      'El dron está en el suelo: despegalo para usar el mando',
    );
    // El suelo no es una espera: no hay nada que el dron vaya a confirmar solo.
    expect(within(vista).queryByTestId('pilotaje-esperando')).not.toBeInTheDocument();
    apretar('KeyW');
    expect(usados.onMando).not.toHaveBeenCalled();
    // Y la vista también ofrece despegar: sin eso no podría hacer nada.
    expect(within(vista).getByRole('button', { name: 'Despegar' })).toBeEnabled();
  });

  it('el suelo vale aunque el status sea de antes de tomar el control', async () => {
    // `flying` es un dato físico: no necesita la confirmación del vuelo manual.
    renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status: makeStatus({ state: 'LANDED', controlledBy: null, flying: false }),
    });
    await abrirPilotaje();
    expect(screen.getByTestId('pilotaje-impedimento')).toHaveTextContent('El dron está en el suelo');
  });

  it('despegar pide confirmación y recién ahí ordena el despegue', async () => {
    renderDetail(conControl({ state: 'MANUAL', flying: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Despegar' }));

    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toHaveTextContent('El dron despega en el lugar y queda suspendido a ~1,2 m; funciona sin GPS');
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/takeoff', expect.anything());

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Despegar' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/takeoff', { method: 'POST' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByTestId('orden-en-curso')).toHaveTextContent(/Despegue ordenado/);
  });

  it('cancelar el diálogo no ordena nada', async () => {
    renderDetail(conControl({ state: 'MANUAL', flying: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Despegar' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/takeoff', expect.anything());
  });

  it('cuando el dron informa que está en el aire, el aviso se va y se ofrece aterrizar', async () => {
    const usados = renderDetail(conControl({ state: 'MANUAL', flying: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Despegar' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Despegar' }));
    expect(await screen.findByTestId('orden-en-curso')).toBeInTheDocument();

    usados.volverARenderizar({ status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1', flying: true, alt: 1.2 }) });
    await waitFor(() => expect(screen.queryByTestId('orden-en-curso')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Aterrizar' })).toBeEnabled();
    await abrirPilotaje();
    expect(screen.queryByTestId('pilotaje-impedimento')).not.toBeInTheDocument();
  });

  it('aterrizar también pide confirmación y ordena el aterrizaje', async () => {
    renderDetail(conControl({ state: 'MANUAL', flying: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Aterrizar' }));
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toHaveTextContent(/aterriza donde está/);
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Aterrizar' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/land', { method: 'POST' }));
    expect(await screen.findByTestId('orden-en-curso')).toHaveTextContent(/Aterrizaje ordenado/);
  });

  it('si el backend rechaza el despegue, se ve el motivo y no se anuncia nada', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([]);
      if (path.endsWith('/takeoff')) return Promise.reject(new Error('No tenés el control manual de este dron'));
      return Promise.resolve({});
    });
    renderDetail(conControl({ state: 'MANUAL', flying: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Despegar' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Despegar' }));
    expect(await screen.findByText('No tenés el control manual de este dron')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('orden-en-curso')).not.toBeInTheDocument();
  });

  it('una app vieja que no informa si vuela no ofrece ni despegar ni aterrizar', async () => {
    renderDetail(conControl({ state: 'MANUAL' }));
    await abrirPilotaje();
    expect(screen.queryByRole('button', { name: 'Despegar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aterrizar' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('pilotaje-impedimento')).not.toBeInTheDocument();
  });

  it('en el suelo las flechas también quedan deshabilitadas', async () => {
    renderDetail(conControl({ state: 'MANUAL', flying: false }));
    await esperarCarga();
    expect(screen.getByRole('button', { name: 'Mover al norte' })).toBeDisabled();
    expect(screen.getByTestId('pad-impedimento')).toHaveTextContent('El dron está en el suelo');
  });
});

describe('DroneDetail — sin GPS', () => {
  it('las flechas se deshabilitan y explican por qué; el vuelo continuo sigue', async () => {
    const usados = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status: makeStatus({
        state: 'MANUAL',
        controlledBy: 'admin1',
        flying: true,
        gpsFix: false,
        lat: null,
        lon: null,
        satellites: 2,
      }),
    });
    await esperarCarga();
    for (const rumbo of ['norte', 'sur', 'este', 'oeste']) {
      expect(screen.getByRole('button', { name: `Mover al ${rumbo}` })).toBeDisabled();
    }
    expect(screen.getByTestId('pad-impedimento')).toHaveTextContent(/Sin GPS/);
    await userEvent.click(screen.getByTitle('Norte'));
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/manual_move', expect.anything());

    // El vuelo continuo no depende de la posición: manda velocidades. El
    // minimapa de la vista dice que no sabe dónde está.
    const vista = await abrirPilotaje();
    expect(within(vista).queryByTestId('pilotaje-impedimento')).not.toBeInTheDocument();
    expect(within(vista).getByTestId('minimapa-sin-gps')).toHaveTextContent('Sin GPS');
    apretar('Space');
    expect(usados.onMando).toHaveBeenCalledWith({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5 });
    soltar('Space');
  });

  it('el mapa avisa que el dron no se dibuja por falta de GPS', async () => {
    renderDetail({ status: makeStatus({ lat: 0, lon: 0 }) });
    await esperarCarga();
    expect(screen.getByTestId('mapa-sin-gps')).toHaveTextContent(/sin GPS/);
  });

  it('con GPS no hay ningún aviso de posición', async () => {
    renderDetail({ status: makeStatus({ gpsFix: true }) });
    await esperarCarga();
    expect(screen.queryByTestId('mapa-sin-gps')).not.toBeInTheDocument();
  });
});
