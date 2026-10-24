import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProveedorDeAvisos } from './AvisosFlotantes';
import DroneDetail from './DroneDetail';
import ProveedorDeAlertas from './ProveedorDeAlertas';
import type { MapItem, WaypointsLayer } from './DronesMap';
import { ErrorDeApi, api, pedirControl, rutasDeBase } from '../api';
import { makeAlert, makeDrone, makeEvent, makeMe, makeRelevo, makeRoute, makeStatus } from '../test/fixtures';
import type { Alert, ObjetivoEnSeguimiento } from '../types';

// El mapa anota los items que recibe: es la forma de ver que el rastro del
// objetivo baja hasta él sin correr Leaflet. Anota también la capa de nodos,
// que trae lo que hacen los botones del globo de cada nodo ("Forzar").
const { mapa } = vi.hoisted(() => ({
  mapa: { items: [] as MapItem[], waypoints: null as WaypointsLayer | null | undefined },
}));
vi.mock('./DronesMap', () => ({
  default: ({ items, waypoints }: { items: MapItem[]; waypoints?: WaypointsLayer | null }) => {
    mapa.items = items;
    mapa.waypoints = waypoints;
    return <div data-testid="mapa-mock" />;
  },
}));
// Sólo se doblan los pedidos: parsearMeta es el de verdad, el que usa el
// detalle de un evento del historial.
vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  api: vi.fn(),
  rutasDeBase: vi.fn(),
  pedirControl: vi.fn(),
}));
// El minimapa de la vista de pilotaje sí usa Leaflet: va el doble compartido.
vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
const apiMock = vi.mocked(api);
const rutasDeBaseMock = vi.mocked(rutasDeBase);
const pedirControlMock = vi.mocked(pedirControl);

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

/**
 * `conAvisos` lo monta adentro del proveedor de avisos, como en la consola:
 * sólo así se ve el "listo" que la vista dice al terminar una acción.
 */
function renderDetail(props: Partial<Parameters<typeof DroneDetail>[0]> = {}, { conAvisos = false } = {}) {
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
  const envolver = (vista: JSX.Element) => (conAvisos ? <ProveedorDeAvisos>{vista}</ProveedorDeAvisos> : vista);
  const { rerender } = render(envolver(<DroneDetail {...merged} />));
  // Volver a renderizar con algo cambiado es la única forma de probar lo que le
  // pasa al mando EN el momento en que se cae el enlace o llega el primer status:
  // con un render nuevo el estado del mando arrancaría de cero.
  const volverARenderizar = (cambios: Partial<Parameters<typeof DroneDetail>[0]>) =>
    rerender(envolver(<DroneDetail {...merged} {...cambios} />));
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
  pedirControlMock.mockReset();
  // Por defecto la base del dron tiene habilitada la ruta que traen los tests.
  rutasDeBaseMock.mockReset();
  rutasDeBaseMock.mockResolvedValue([makeRoute({ id: 1, name: 'Ruta Perimetral' })]);
});

describe('DroneDetail', () => {
  it('muestra el encabezado y vuelve con el botón', async () => {
    const props = renderDetail();
    await esperarCarga();
    expect(screen.getByText('Alfa')).toBeInTheDocument();
    expect(screen.getByText('En vuelo')).toBeInTheDocument();
    expect(screen.getByTestId('mapa-mock')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Volver a Operación/ }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('marca desconectado y muestra quién tiene el control manual', async () => {
    renderDetail({ drone: makeDrone({ online: false, controlledBy: 'oper9' }) });
    expect(await screen.findByText('Desconectado')).toBeInTheDocument();
    expect(screen.getByText('Control manual: oper9')).toBeInTheDocument();
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

  it('un supervisor puede quitarle el control a otro operador, después de confirmarlo', async () => {
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
    });
    expect(screen.getByText(/Controlado por/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));

    // Le corta el vuelo a otra persona: primero pregunta, con la consecuencia dicha.
    const dialogo = await screen.findByRole('dialog', { name: 'Quitarle el control a oper9' });
    expect(dialogo).toHaveTextContent('oper9 deja de pilotear Alfa en el acto y el dron vuelve a patrullar su ruta.');
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/control', expect.anything());

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Quitar control' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancelar la pregunta no le quita el control a nadie', async () => {
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/control', expect.anything());
  });

  it('si el backend no deja quitar el control, el motivo se lee en la pregunta, que sigue abierta', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === '/drones/d1/control') return Promise.reject(new Error('El dron ya no tiene el control tomado'));
      return Promise.resolve([]);
    });
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));
    const dialogo = await screen.findByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Quitar control' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('El dron ya no tiene el control tomado');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('quitar el control lo confirma con un aviso, no en silencio', async () => {
    renderDetail(
      {
        me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
        drone: makeDrone({ controlledBy: 'oper9' }),
      },
      { conAvisos: true },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Quitar control' }));
    await waitFor(() =>
      expect(document.querySelector('.avisos-flotantes')).toHaveTextContent('Se le quitó el control de Alfa a oper9.'),
    );
  });

  it('si el control cambia de manos con la pregunta abierta, la pregunta se descarta', async () => {
    const usados = renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));
    await screen.findByRole('dialog');

    usados.volverARenderizar({ drone: makeDrone({ controlledBy: null }) });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Y no reaparece cuando lo toma el próximo: esa sería otra pregunta.
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'oper7' }) });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

  it('forzar un nodo desde el mapa ordena el salto en la ruta activa y, si se rechaza, deja el motivo a la vista', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([]);
      if (path.endsWith('/goto')) return Promise.reject(new Error('El dron ya no patrulla esa ruta'));
      return Promise.resolve({});
    });
    renderDetail({ status: makeStatus({ droneId: 'd1', state: 'PATROLLING', routeId: 1, waypointIndex: 0 }) });
    await esperarCarga();

    // El mapa no espera nada de vuelta (`onForce` es void): el rechazo tiene
    // que quedar a la vista igual, porque nadie más lo va a mostrar.
    act(() => mapa.waypoints?.onForce?.(1));

    expect(apiMock).toHaveBeenCalledWith('/drones/d1/goto', {
      method: 'POST',
      body: JSON.stringify({ routeId: 1, index: 1 }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('El dron ya no patrulla esa ruta');
  });

  it('continuar desde un nodo del mapa retoma la ruta interrumpida a partir de ese nodo', async () => {
    renderDetail({ status: makeStatus({ droneId: 'd1', state: 'MANUAL', routeId: 1, waypointIndex: 0 }) });
    await esperarCarga();
    // Con el patrullaje interrumpido el globo del nodo ofrece "Continuar desde acá".
    expect(mapa.waypoints?.canContinue).toBe(true);

    await act(async () => mapa.waypoints?.onContinue?.(1));

    expect(apiMock).toHaveBeenCalledWith('/drones/d1/resume', {
      method: 'POST',
      body: JSON.stringify({ fromIndex: 1 }),
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

/**
 * Al cerrarse la vista el foco caía en el body, y con el teclado había que
 * volver a tabular desde arriba de la página. Vuelve a lo que lo tenía antes de
 * abrirla, o al botón del control que haya ahora, o al aviso de por qué se cerró.
 */
describe('DroneDetail — el foco al cerrarse la vista de pilotaje', () => {
  const conControl = () => ({
    me: makeMe({ username: 'admin1', canControl: true }),
    drone: makeDrone({ controlledBy: 'admin1', online: true }),
    status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1', flying: true }),
  });
  const volver = () => screen.getByRole('button', { name: 'Volver a la vista de pilotaje' });
  const tomar = () => screen.getByRole('button', { name: 'Tomar control manual' });

  /** Abre la vista con el teclado, como un operador que no usa el mouse. */
  async function abrirDesde(boton: () => HTMLElement): Promise<HTMLElement> {
    await esperarCarga();
    boton().focus();
    fireEvent.click(boton());
    return screen.findByRole('dialog', { name: 'Pilotaje de Alfa' });
  }

  function cerrarSinSoltar(vista: HTMLElement) {
    fireEvent.click(within(vista).getByRole('button', { name: 'Salir del control manual' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar la vista sin soltar' }));
  }

  it('cerrar sin soltar devuelve el foco al botón que la abrió', async () => {
    renderDetail(conControl());
    cerrarSinSoltar(await abrirDesde(volver));
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    expect(volver()).toHaveFocus();
  });

  it('abierta al tomar el control, el botón que la abrió ya no está: el foco va a "Volver a la vista"', async () => {
    const usados = renderDetail({ drone: makeDrone({ controlledBy: null, online: true }) });
    const vista = await abrirDesde(tomar);
    // Llega el lock: "Tomar control manual" se va y aparece "Volver a la vista".
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'admin1', online: true }) });
    cerrarSinSoltar(vista);
    expect(volver()).toHaveFocus();
  });

  it('al salir, el foco sigue al botón del control cuando "Volver" deja paso a "Tomar control manual"', async () => {
    const usados = renderDetail(conControl());
    const vista = await abrirDesde(volver);
    fireEvent.click(within(vista).getByRole('button', { name: 'Salir del control manual' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '¿Salir del control manual?' })).getByRole('button', {
        name: 'Salir del control manual',
      }),
    );
    expect(volver()).toHaveFocus();
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', expect.objectContaining({ method: 'DELETE' })),
    );

    // Llega la confirmación de que se soltó: sin heredar el foco, se iba al body.
    usados.volverARenderizar({
      drone: makeDrone({ controlledBy: null, online: true }),
      status: makeStatus({ state: 'PATROLLING', controlledBy: null }),
    });
    expect(tomar()).toHaveFocus();
  });

  it('un botón del control que se va sin el foco no le pasa nada al que entra', async () => {
    const usados = renderDetail(conControl());
    await esperarCarga();
    const afuera = screen.getByRole('button', { name: 'Volver a Operación' });
    afuera.focus();
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: null, online: true }) });
    expect(afuera).toHaveFocus();
  });

  it('si el control se suelta desde otra sesión, el foco va a "Tomar control manual"', async () => {
    const usados = renderDetail(conControl());
    await abrirDesde(volver);
    usados.volverARenderizar({
      drone: makeDrone({ controlledBy: null, online: true }),
      status: makeStatus({ state: 'PATROLLING', controlledBy: null }),
    });
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    expect(tomar()).toHaveFocus();
  });

  it('si otro se lleva el control no hay botón que lo reciba: el foco va al aviso de por qué se cerró', async () => {
    const usados = renderDetail(conControl());
    await abrirDesde(volver);
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'super1', online: true }) });
    expect(screen.getByTestId('aviso-pilotaje')).toHaveFocus();
  });

  it('si el botón con el foco se va y no entra otro en su lugar, el que aparezca mucho después no roba el foco', async () => {
    const usados = renderDetail(conControl());
    await esperarCarga();
    volver().focus();
    // Un supervisor se lleva el control con el foco en "Volver a la vista".
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'super1', online: true }) });
    const afuera = screen.getByRole('button', { name: 'Volver a Operación' });
    afuera.focus();
    // Un rato después lo suelta: aparece "Tomar control manual".
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: null, online: true }) });
    expect(afuera).toHaveFocus();
  });

  it('si el dron se desconecta, "Tomar control manual" está apagado: el foco va al aviso', async () => {
    const usados = renderDetail(conControl());
    await abrirDesde(volver);
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: null, online: false }), status: null });
    expect(tomar()).toBeDisabled();
    expect(screen.getByTestId('aviso-pilotaje')).toHaveFocus();
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

  it('si se pierde el control con la confirmación abierta, se cierra con la vista y no vuelve', async () => {
    const usados = renderDetail(conControl({ flying: false }));
    const vista = await abrirPilotaje();
    fireEvent.click(within(vista).getByRole('button', { name: 'Despegar' }));
    expect(screen.getByRole('dialog', { name: 'Despegar Alfa' })).toBeInTheDocument();

    // Un supervisor se lleva el control mientras el operador lee la pregunta.
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'super1', online: true }) });
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Despegar Alfa' })).not.toBeInTheDocument();

    // Cuando el control vuelve, la pregunta vieja no reaparece para despegar.
    usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'admin1', online: true }) });
    expect(screen.queryByRole('dialog', { name: 'Despegar Alfa' })).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/takeoff', expect.anything());
  });

  it('la confirmación pedida desde la tarjeta también se descarta al perder el control', async () => {
    const usados = renderDetail(conControl({ flying: true }));
    await esperarCarga();
    fireEvent.click(screen.getByRole('button', { name: 'Aterrizar' }));
    expect(screen.getByRole('dialog', { name: 'Aterrizar Alfa' })).toBeInTheDocument();

    usados.volverARenderizar({
      drone: makeDrone({ controlledBy: null, online: true }),
      status: makeStatus({ state: 'PATROLLING', controlledBy: null, flying: true }),
    });
    expect(screen.queryByRole('dialog', { name: 'Aterrizar Alfa' })).not.toBeInTheDocument();
  });

  /**
   * El caso que se veía en el campo: en pantalla completa la confirmación vive
   * adentro de la vista (es lo único que el navegador pinta). Al cerrarse la
   * vista por la pérdida del control, la caja se iba con ella pero el diálogo
   * quedaba montado: invisible, en la pila de diálogos, comiéndose el tabulador.
   */
  describe('en pantalla completa', () => {
    let enPantallaCompleta: Element | null = null;

    beforeEach(() => {
      enPantallaCompleta = null;
      Object.defineProperty(document, 'fullscreenElement', { get: () => enPantallaCompleta, configurable: true });
      HTMLElement.prototype.requestFullscreen = function (this: Element) {
        enPantallaCompleta = this;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      } as unknown as HTMLElement['requestFullscreen'];
      document.exitFullscreen = () => {
        enPantallaCompleta = null;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      };
    });

    afterEach(() => {
      // Lo que jsdom no tiene se vuelve a sacar: el resto corre sin pantalla completa.
      delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
      delete (document as Partial<Document>).exitFullscreen;
      delete (document as { fullscreenElement?: Element | null }).fullscreenElement;
    });

    it('la confirmación que se cierra con la vista no queda suelta comiéndose el tabulador', async () => {
      const usados = renderDetail(conControl({ flying: false }));
      const vista = await abrirPilotaje();
      expect(document.fullscreenElement).toBe(vista);
      fireEvent.click(within(vista).getByRole('button', { name: 'Despegar' }));
      expect(vista.contains(screen.getByRole('dialog', { name: 'Despegar Alfa' }))).toBe(true);

      usados.volverARenderizar({ drone: makeDrone({ controlledBy: 'super1', online: true }) });
      expect(vistaDePilotaje()).not.toBeInTheDocument();
      // Otro render cualquiera (llega un status): antes reaparecía en el body.
      usados.volverARenderizar({
        drone: makeDrone({ controlledBy: 'super1', online: true }),
        status: makeStatus({ state: 'MANUAL', controlledBy: 'super1', flying: false }),
      });
      expect(screen.queryByRole('dialog', { name: 'Despegar Alfa' })).not.toBeInTheDocument();

      // Y el tabulador vuelve a ser de la página.
      const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
      act(() => {
        document.dispatchEvent(tab);
      });
      expect(tab.defaultPrevented).toBe(false);
    });
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
  it('muestra la pendiente más nueva de ESTE dron al lado del video, y deja recorrer las demás', async () => {
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
    // La otra pendiente del mismo dron no se pierde: está a una flecha. Las de
    // otros drones y las ya decididas no cuentan.
    expect(within(tarjeta).getByTestId('carrusel-cuenta')).toHaveTextContent('1 de 2');
    await userEvent.click(within(tarjeta).getByRole('button', { name: 'Alerta siguiente, más vieja' }));
    expect(within(tarjeta).getByTestId('carrusel-cuenta')).toHaveTextContent('2 de 2');
    expect(within(tarjeta).getByText('PERSONA')).toBeInTheDocument();
    // En la vista del dron no se repite de qué dron es: es éste.
    expect(within(tarjeta).queryByRole('button', { name: 'Alfa' })).not.toBeInTheDocument();

    // Va en el par del video y el mapa, entre los dos.
    const par = document.body.querySelector('.par-video-mapa') as HTMLElement;
    expect(par).toHaveClass('con-alerta');
    expect(par.contains(tarjeta)).toBe(true);
  });

  it('al pasar a otro dron, el carrusel arranca de cero con las alertas de ése', async () => {
    const alertas = [
      makeAlert({ id: 3, drone_id: 'd1', status: 'PENDING' }),
      makeAlert({ id: 4, drone_id: 'd1', status: 'PENDING' }),
      makeAlert({ id: 8, drone_id: 'd2', status: 'PENDING' }),
      makeAlert({ id: 9, drone_id: 'd2', status: 'PENDING' }),
    ];
    const { volverARenderizar } = renderDetail({ alertas });
    await esperarCarga();
    await userEvent.click(screen.getByRole('button', { name: 'Alerta siguiente, más vieja' }));
    expect(screen.getByTestId('carrusel-cuenta')).toHaveTextContent('2 de 2');

    volverARenderizar({ drone: makeDrone({ droneId: 'd2', displayName: 'Bravo', online: true }) });
    await esperarCarga();
    // Las del otro dron no son "nuevas": no late la cuenta ni aparece el aviso.
    expect(screen.getByTestId('carrusel-cuenta')).toHaveTextContent('1 de 2');
    expect(screen.getByTestId('carrusel-cuenta')).not.toHaveClass('llego');
    expect(screen.queryByRole('button', { name: /alerta nueva/ })).not.toBeInTheDocument();
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

describe('DroneDetail — historial de eventos', () => {
  const abrirHistorial = () => userEvent.click(screen.getByRole('button', { name: 'Ver historial de eventos' }));
  const historial = () => screen.getByRole('dialog', { name: 'Historial de eventos' });

  it('ya no hay lista al pie: el historial se abre desde arriba a la derecha, sobre la telemetría', async () => {
    renderDetail();
    await esperarCarga();
    // Al entrar no se pide nada: el historial se trae cuando se lo abre.
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringMatching(/^\/events/));
    expect(screen.queryByText('Sin eventos registrados.')).not.toBeInTheDocument();

    const boton = screen.getByRole('button', { name: 'Ver historial de eventos' });
    const cabecera = document.querySelector('.detail-head')!;
    expect(cabecera.contains(boton)).toBe(true);
    // La cabecera va antes que la tarjeta de estado: el botón queda arriba de la telemetría.
    const estado = document.querySelector('.status-grid')!;
    expect(cabecera.compareDocumentPosition(estado) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await abrirHistorial();
    expect(historial()).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/events?droneId=d1&limit=100');
    expect(await within(historial()).findByText('Sin eventos registrados.')).toBeInTheDocument();
  });

  it('suma al historial los eventos en vivo de este dron', async () => {
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
    await esperarCarga();
    await abrirHistorial();
    expect(await within(historial()).findByText('del historial')).toBeInTheDocument();
    expect(within(historial()).getByText('evento fresco')).toBeInTheDocument();
    expect(within(historial()).queryByText('de otro dron')).not.toBeInTheDocument();
  });

  it('espera el historial antes de decir que está vacío', async () => {
    let contestar: (v: unknown[]) => void = () => {};
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/events') ? new Promise((r) => (contestar = r)) : Promise.resolve({}),
    );
    renderDetail();
    await esperarCarga();
    await abrirHistorial();
    expect(within(historial()).getByText('Trayendo los eventos del dron…')).toBeInTheDocument();
    expect(screen.queryByText('Sin eventos registrados.')).not.toBeInTheDocument();
    await act(async () => contestar([]));
    expect(within(historial()).getByText('Sin eventos registrados.')).toBeInTheDocument();
  });

  it('el historial de otro dron arranca de cero: la respuesta del anterior no se escribe', async () => {
    const contestar: Record<string, (v: unknown[]) => void> = {};
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/events')
        ? new Promise((r) => (contestar[new URLSearchParams(path.split('?')[1]).get('droneId')!] = r))
        : Promise.resolve({}),
    );
    const { volverARenderizar } = renderDetail();
    await esperarCarga();
    await abrirHistorial();
    await waitFor(() => expect(contestar.d1).toBeDefined());

    volverARenderizar({
      drone: makeDrone({ droneId: 'd2', displayName: 'Bravo', online: true }),
      status: makeStatus({ droneId: 'd2', state: 'PATROLLING', routeId: null }),
    });
    await waitFor(() => expect(contestar.d2).toBeDefined());
    expect(within(historial()).getByText('Bravo · los últimos 100')).toBeInTheDocument();

    await act(async () => contestar.d1([makeEvent({ id: 1, drone_id: 'd1', message: 'evento de Alfa' })]));
    expect(screen.queryByText('evento de Alfa')).not.toBeInTheDocument();
    expect(within(historial()).getByText('Trayendo los eventos del dron…')).toBeInTheDocument();

    await act(async () => contestar.d2([makeEvent({ id: 2, drone_id: 'd2', message: 'evento de Bravo' })]));
    expect(within(historial()).getByText('evento de Bravo')).toBeInTheDocument();
  });

  it('una alerta del historial se abre al lado, con su captura, su mapa y el camino al video', async () => {
    const alerta = makeAlert({ id: 7, drone_id: 'd1', snapshot: 'QUFB' });
    apiMock.mockImplementation((path: string) =>
      path.startsWith('/events')
        ? Promise.resolve([
            makeEvent({
              id: 5,
              type: 'ALERT_CREATED',
              alert_id: 7,
              message: 'Alerta de PERSONA generada por Alfa',
              meta: JSON.stringify({ alerta: { id: 7, tipo: 'PERSON', lat: -34.6, lon: -58.4, ts: null } }),
            }),
          ])
        : Promise.resolve({}),
    );
    const verDron = vi.fn();
    const drone = makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true });
    render(
      <ProveedorDeAlertas alertas={[alerta]} drones={[drone]} statuses={{}} decidir={vi.fn()} verDron={verDron}>
        <DroneDetail
          me={makeMe()}
          drone={drone}
          status={makeStatus({ droneId: 'd1', routeId: null })}
          frame={null}
          conectado
          liveEvents={[]}
          routes={[makeRoute({ id: 1, name: 'Ruta Perimetral' })]}
          alertas={[alerta]}
          onDecidir={vi.fn()}
          onBack={vi.fn()}
          onRename={vi.fn()}
          onWaypointLabel={vi.fn()}
          onMando={vi.fn(() => true)}
          onCamara={vi.fn(() => true)}
        />
      </ProveedorDeAlertas>,
    );
    await esperarCarga();
    await abrirHistorial();
    await userEvent.click(await within(historial()).findByRole('button', { name: /Alerta de PERSONA generada por Alfa/ }));

    const panel = within(historial()).getByRole('region', { name: 'Alerta de PERSONA generada por Alfa' });
    expect(within(panel).getByAltText('Captura de la detección')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Validar' })).toBeInTheDocument();

    // Ya se está en la vista de este dron: ir al video es cerrar el historial.
    await userEvent.click(within(panel).getByRole('button', { name: 'Ver feed en vivo' }));
    expect(verDron).toHaveBeenCalledWith('d1');
    expect(screen.queryByRole('dialog', { name: 'Historial de eventos' })).not.toBeInTheDocument();
  });

  it('al cerrar el historial el foco vuelve al botón que lo abrió', async () => {
    renderDetail();
    await esperarCarga();
    await abrirHistorial();
    await within(historial()).findByText('Sin eventos registrados.');
    await userEvent.click(within(historial()).getByRole('button', { name: 'Cerrar el historial' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver historial de eventos' })).toHaveFocus();
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
    const dialogo = await screen.findByRole('dialog');
    expect(dialogo).toHaveTextContent('el dron vuelve al objetivo que estaba siguiendo');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Quitar control' }));
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

  it('la cabecera habla como la de las demás vistas: el nombre es el título y el modelo va debajo', async () => {
    renderDetail({ drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', model: 'DJI Mini 4 Pro', online: true }) });
    await esperarCarga();
    const cabecera = document.querySelector('.detail-head') as HTMLElement;
    const titulo = within(cabecera).getByRole('heading', { level: 2, name: /^Alfa/ });
    expect(titulo).toHaveClass('vista-titulo');
    expect(within(cabecera).getByText('DJI Mini 4 Pro')).toHaveClass('vista-subtitulo');
    // El estado de vuelo en su pastilla, y los íconos son dibujo: el nombre
    // de cada botón sigue siendo su texto.
    expect(within(cabecera).getByText('En vuelo')).toHaveClass('estado', 'pastilla', 'ok');
    for (const nombre of ['Volver a Operación', 'Ver historial de eventos']) {
      const boton = within(cabecera).getByRole('button', { name: nombre });
      expect(boton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('sin modelo cargado no deja un subtítulo vacío', async () => {
    renderDetail({ drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', model: '', online: true }) });
    await esperarCarga();
    expect(document.querySelector('.detail-head .vista-subtitulo')).toBeNull();
  });

  it('las órdenes llevan su ícono sin cambiar su nombre: el mando para pilotear, la pausa para interrumpir', async () => {
    renderDetail();
    await esperarCarga();
    const icono = (nombre: string) => screen.getByRole('button', { name: nombre }).querySelector('svg');
    expect(icono('Tomar control manual')).toHaveAttribute('aria-hidden', 'true');
    expect(icono('Interrumpir')).toHaveAttribute('aria-hidden', 'true');
    expect(icono('Comenzar')).toHaveAttribute('aria-hidden', 'true');
    expect(icono('Retomar ruta')).toHaveAttribute('aria-hidden', 'true');
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

describe('DroneDetail — soltar el control de un dron en un relevo (RELEVOS §3.9)', () => {
  /** Alfa (d1) va a relevar a Charlie: está en camino y todavía no tiene objetivo (§3.5). */
  const VA_A_RELEVAR = makeRelevo({
    estado: 'EN_CAMINO',
    origen: { droneId: 'c3', displayName: 'Charlie' },
    relevo: { droneId: 'd1', displayName: 'Alfa' },
  });
  /** Alfa (d1) pidió el relevo de un seguimiento: tiene el objetivo y Bravo viene en camino. */
  const PIDIO_RELEVO = makeRelevo({ estado: 'EN_CAMINO', origen: { droneId: 'd1', displayName: 'Alfa' } });

  const conControl = (status: Parameters<typeof makeStatus>[0] = {}) => ({
    me: makeMe({ username: 'admin1', canControl: true }),
    drone: makeDrone({ controlledBy: 'admin1', online: true }),
    status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1', flying: true, routeId: null, target: null, ...status }),
  });

  const soltoCon = (resume: 'none' | 'last') =>
    waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/d1/control', { method: 'DELETE', body: JSON.stringify({ resume }) }),
    );

  async function salirDelPilotaje(): Promise<HTMLElement> {
    const vista = await abrirPilotaje();
    fireEvent.click(within(vista).getByRole('button', { name: 'Salir del control manual' }));
    const dialogo = screen.getByRole('dialog', { name: '¿Salir del control manual?' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salir del control manual' }));
    return dialogo;
  }

  it('salir de la vista de pilotaje del que va a relevar lo suelta sin orden: el relevo sigue', async () => {
    renderDetail({ ...conControl(), relevos: [VA_A_RELEVAR] });
    const vista = await abrirPilotaje();
    fireEvent.click(within(vista).getByRole('button', { name: 'Salir del control manual' }));
    expect(screen.getByRole('dialog', { name: '¿Salir del control manual?' })).toHaveTextContent('sigue con el relevo');
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '¿Salir del control manual?' })).getByRole('button', {
        name: 'Salir del control manual',
      }),
    );
    await soltoCon('none');
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/control', { method: 'DELETE', body: JSON.stringify({ resume: 'last' }) });
  });

  it('el supervisor que le quita el control al que va a relevar tampoco cancela el relevo', async () => {
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
      status: makeStatus({ state: 'MANUAL', controlledBy: 'oper9', target: null }),
      relevos: [VA_A_RELEVAR],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Quitarle el control a oper9' });
    expect(dialogo).toHaveTextContent('oper9 deja de pilotear Alfa en el acto y el dron sigue con el relevo.');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Quitar control' }));
    await soltoCon('none');
  });

  it('en la tarjeta, soltar sin orden va primero; reanudar queda aparte y dice qué le hace al relevo', async () => {
    renderDetail({ ...conControl(), relevos: [VA_A_RELEVAR] });
    await esperarCarga();
    expect(screen.queryByRole('button', { name: 'Devolver al patrullaje' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Soltar control (sigue el relevo)' }));
    await soltoCon('none');

    const aviso = screen.getByTestId('aviso-reanudar-en-relevo');
    expect(aviso).toHaveTextContent(
      'Está yendo a relevar a Charlie: reanudar el patrullaje cancela el relevo y Charlie se queda sin relevo.',
    );
    const reanudar = screen.getByRole('button', { name: 'Soltar y reanudar patrullaje' });
    expect(reanudar).toHaveAccessibleDescription(aviso.textContent ?? '');
    apiMock.mockClear();
    await userEvent.click(reanudar);
    // Es una orden explícita, y va por donde el hub la cuenta para el relevo:
    // soltar con 'last' a un dron en relevo el hub lo suelta sin orden.
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/resume', { method: 'POST', body: '{}' }));
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/control', expect.anything());
  });

  it('el que pidió el relevo también reanuda con la orden explícita, no soltando con "last"', async () => {
    renderDetail({ ...conControl({ target: OBJETIVO }), relevos: [PIDIO_RELEVO] });
    await esperarCarga();
    apiMock.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Soltar y reanudar patrullaje' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/drones/d1/resume', { method: 'POST', body: '{}' }));
    expect(apiMock).not.toHaveBeenCalledWith('/drones/d1/control', expect.anything());
  });

  it('si el hub rechaza reanudar, el motivo queda a la vista', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith('/events')) return Promise.resolve([]);
      if (path.endsWith('/resume')) return Promise.reject(new Error('El dron está controlado por oper9'));
      return Promise.resolve({});
    });
    renderDetail({ ...conControl(), relevos: [VA_A_RELEVAR] });
    await esperarCarga();
    await userEvent.click(screen.getByRole('button', { name: 'Soltar y reanudar patrullaje' }));
    expect(await screen.findByText('El dron está controlado por oper9')).toHaveAttribute('role', 'alert');
  });

  it('el que pidió el relevo con el objetivo cargado vuelve al objetivo, y el relevo sigue', async () => {
    renderDetail({ ...conControl({ target: OBJETIVO }), relevos: [PIDIO_RELEVO] });
    await esperarCarga();
    expect(screen.getByRole('button', { name: 'Soltar control (vuelve al objetivo, sigue el relevo)' })).toBeInTheDocument();
    expect(screen.getByTestId('aviso-reanudar-en-relevo')).toHaveTextContent('antes de que llegue Bravo');
    const dialogo = await salirDelPilotaje();
    expect(dialogo).toHaveTextContent('vuelve al objetivo que estaba siguiendo; el relevo sigue en marcha');
    await soltoCon('none');
  });

  it('el supervisor que se lo quita al que pidió el relevo dice las dos cosas', async () => {
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
      status: makeStatus({ state: 'MANUAL', controlledBy: 'oper9', target: OBJETIVO }),
      relevos: [PIDIO_RELEVO],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Quitar control' }));
    expect(await screen.findByRole('dialog', { name: 'Quitarle el control a oper9' })).toHaveTextContent(
      'el dron vuelve al objetivo que estaba siguiendo, y el relevo sigue en marcha.',
    );
  });

  it('alcanza con el relevo que informa el teléfono, aunque la consola no lo conozca', async () => {
    renderDetail(
      conControl({ relevo: { enEspera: false, disponible: false, relayId: 9, rol: 'relevo', fase: 'en_camino' } }),
    );
    await esperarCarga();
    expect(screen.getByTestId('aviso-reanudar-en-relevo')).toHaveTextContent('Está en un relevo');
    await salirDelPilotaje();
    await soltoCon('none');
  });

  it('un relevo que ya terminó no cuenta: soltar lo devuelve a su ruta, como siempre', async () => {
    renderDetail({ ...conControl(), relevos: [{ ...VA_A_RELEVAR, estado: 'CANCELADO' }] });
    await esperarCarga();
    expect(screen.getByRole('button', { name: 'Devolver al patrullaje' })).toBeInTheDocument();
    expect(screen.queryByTestId('aviso-reanudar-en-relevo')).not.toBeInTheDocument();
    await salirDelPilotaje();
    await soltoCon('last');
  });
});

describe('DroneDetail — pedirle el control a quien lo tiene', () => {
  const OPERADOR = makeMe({ username: 'oper1', role: 'operator', canControl: true });
  /** Otro tiene el control: es el caso en el que se pide en vez de tomarlo. */
  const conOtroAlMando = { me: OPERADOR, drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', controlledBy: 'piloto' }) };
  const pendiente = { resultado: 'pendiente' as const, pedido: { solicitante: 'oper1', titular: 'piloto', venceEn: '', restanteMs: 10_000 } };
  const pedidoPropio = { droneId: 'd1', solicitante: 'oper1', titular: 'piloto', venceEnMs: Date.now() + 10_000 };

  /** Abre la pregunta y devuelve el diálogo. */
  async function preguntar() {
    await esperarCarga();
    fireEvent.click(screen.getByRole('button', { name: 'Pedir el control' }));
    return screen.getByRole('dialog', { name: 'Pedir el control de Alfa' });
  }

  it('primero avisa que alguien lo está volando; confirmado, queda el pedido y la vista espera', async () => {
    pedirControlMock.mockResolvedValue(pendiente);
    renderDetail(conOtroAlMando);
    const dialogo = await preguntar();
    expect(dialogo).toHaveTextContent('piloto está piloteando este dron. ¿Querés pedirle el control?');
    expect(dialogo).toHaveTextContent('piloto tiene 10 segundos para cedértelo o mantenerlo.');
    // Sin confirmar no se pide nada.
    expect(pedirControlMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Pedir el control' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pedir el control de Alfa' })).not.toBeInTheDocument());
    expect(pedirControlMock).toHaveBeenCalledWith('d1');
    expect(vistaDePilotaje()).not.toBeInTheDocument();
  });

  it('cuando el control llega (cedido o sin respuesta), se abre la vista de pilotaje', async () => {
    pedirControlMock.mockResolvedValue(pendiente);
    const usados = renderDetail(conOtroAlMando);
    fireEvent.click(within(await preguntar()).getByRole('button', { name: 'Pedir el control' }));
    await waitFor(() => expect(pedirControlMock).toHaveBeenCalled());

    usados.volverARenderizar({ pedidoDeControl: pedidoPropio });
    expect(screen.getByTestId('pedido-de-control')).toHaveTextContent('Le pediste el control a piloto: esperando su respuesta.');
    expect(screen.getByRole('button', { name: 'Pedir el control' })).toBeDisabled();

    usados.volverARenderizar({ drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', controlledBy: 'oper1' }), pedidoDeControl: null });
    expect(vistaDePilotaje()).toBeInTheDocument();
  });

  it('si el titular lo mantiene, no se abre nada; un control que llega después, sin pedirlo, tampoco abre la vista', async () => {
    pedirControlMock.mockResolvedValue(pendiente);
    const usados = renderDetail(conOtroAlMando);
    fireEvent.click(within(await preguntar()).getByRole('button', { name: 'Pedir el control' }));
    await waitFor(() => expect(pedirControlMock).toHaveBeenCalled());
    usados.volverARenderizar({ pedidoDeControl: pedidoPropio });
    usados.volverARenderizar({ pedidoDeControl: null });
    expect(vistaDePilotaje()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pedir el control' })).toBeEnabled();

    usados.volverARenderizar({ drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', controlledBy: 'oper1' }), pedidoDeControl: null });
    expect(vistaDePilotaje()).not.toBeInTheDocument();
  });

  it('si en el medio quedó libre, el control se da en el acto y se abre la vista', async () => {
    pedirControlMock.mockResolvedValue({ resultado: 'otorgado', drone: makeDrone({ controlledBy: 'oper1' }) });
    renderDetail(conOtroAlMando);
    fireEvent.click(within(await preguntar()).getByRole('button', { name: 'Pedir el control' }));
    expect(await screen.findByRole('dialog', { name: 'Pilotaje de Alfa' })).toBeInTheDocument();
  });

  it('si otro ya lo pidió, el motivo se lee adentro del diálogo', async () => {
    pedirControlMock.mockRejectedValue(new ErrorDeApi('relevo ya pidió el control de este dron: esperá a que le contesten', 409));
    renderDetail(conOtroAlMando);
    const dialogo = await preguntar();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Pedir el control' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('relevo ya pidió el control de este dron');
  });

  it('con el pedido de otro en curso, el botón espera y dice de quién es', async () => {
    renderDetail({ ...conOtroAlMando, pedidoDeControl: { ...pedidoPropio, solicitante: 'tercero' } });
    await esperarCarga();
    expect(screen.getByRole('button', { name: 'Pedir el control' })).toBeDisabled();
    expect(screen.getByTestId('pedido-de-control')).toHaveTextContent('tercero ya le pidió el control a piloto: esperá a que le conteste.');
  });

  it('si el control cambia de manos mientras se lee la pregunta, la pregunta se va', async () => {
    const usados = renderDetail(conOtroAlMando);
    await preguntar();
    usados.volverARenderizar({ drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', controlledBy: 'otro' }) });
    expect(screen.queryByRole('dialog', { name: 'Pedir el control de Alfa' })).not.toBeInTheDocument();
  });
});
