import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    conectado: true,
    liveEvents: [],
    routes: [makeRoute({ id: 1, name: 'Ruta Perimetral' })],
    onBack: vi.fn(),
    onRename: vi.fn(),
    onWaypointLabel: vi.fn(),
    // Devuelve true: el mensaje salió por el socket. Que devuelva false es el
    // caso del enlace cortado, y tiene su propio test.
    onMando: vi.fn(() => true),
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

describe('DroneDetail — mando virtual', () => {
  const mando = () => screen.queryByRole('group', { name: 'Mando virtual de vuelo continuo' });

  it('el mando no se muestra si no tengo el control tomado', async () => {
    renderDetail({ drone: makeDrone({ controlledBy: null }) });
    expect(await screen.findByRole('button', { name: 'Tomar control manual' })).toBeInTheDocument();
    expect(mando()).not.toBeInTheDocument();
  });

  it('el mando tampoco se muestra si el control lo tiene otro', async () => {
    renderDetail({
      me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }),
      drone: makeDrone({ controlledBy: 'oper9' }),
    });
    expect(await screen.findByText(/Controlado por/)).toBeInTheDocument();
    expect(mando()).not.toBeInTheDocument();
  });

  it('con el control tomado convive con el pad y los ejes suben por la prop', async () => {
    const props = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1' }),
      // El status viene como lo reenvía el Comando Central: con el dueño del lock
      // estampado, o sea que es POSTERIOR a que se tomara el control.
      status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1' }),
    });

    // Las dos formas de comandar conviven: el pad de 25 m sigue estando.
    expect(screen.getByRole('button', { name: 'Mover al norte' })).toBeInTheDocument();
    const bloque = mando() as HTMLElement;
    expect(bloque).toBeInTheDocument();

    // Y se aclara que no hacen lo mismo: salto puntual contra vuelo continuo.
    expect(screen.getByRole('heading', { name: 'Desplazamiento puntual' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Vuelo continuo' })).toBeInTheDocument();
    expect(screen.getByText(/es un salto puntual/)).toBeInTheDocument();
    // El dron ya confirmó el vuelo manual: no hay nada que esperar ni que avisar.
    expect(screen.queryByTestId('mando-esperando')).not.toBeInTheDocument();

    fireEvent.keyDown(bloque, { key: 'w' });
    expect(props.onMando).toHaveBeenCalledWith({ pitch: 0, roll: 0, yaw: 0, throttle: 1 });

    fireEvent.keyUp(bloque, { key: 'w' });
    expect(props.onMando).toHaveBeenLastCalledWith({ pitch: 0, roll: 0, yaw: 0, throttle: 0 });
    // Con todo en orden no hay ningún motivo escrito en el mando.
    expect(screen.queryByTestId('mando-impedimento')).not.toBeInTheDocument();
  });

  /**
   * Tener el lock no alcanza para que el dron obedezca: el backend no lo suelta
   * cuando la app se va sola a volver a base, y el socket de la consola se cae
   * y reconecta cada 3 s. En todos esos casos el mando se muestra igual —que
   * desaparezca parece que le sacaron el control— pero inerte y con el motivo,
   * como los botones de arriba, que ya están `disabled` por lo mismo.
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

  it.each(IMPEDIMENTOS)('$caso: el mando queda inerte y dice por qué', async ({ props, motivo }) => {
    const usados = renderDetail({ me: makeMe({ username: 'admin1', canControl: true }), ...props });
    // Se espera el bloque en vez de buscarlo en seco: el detalle pide el
    // historial y las rutas de la base al montar, y sin esperarlos las
    // respuestas caen fuera del test.
    const bloque = await screen.findByRole('group', { name: 'Mando virtual de vuelo continuo' });
    expect(screen.getByTestId('mando-impedimento')).toHaveTextContent(motivo);
    expect(bloque).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('mando-esperando')).not.toBeInTheDocument();

    fireEvent.keyDown(bloque, { key: 'w' });
    expect(usados.onMando).not.toHaveBeenCalled();
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

  it.each(ESPERANDO)('$caso: el mando emite igual y avisa que falta la confirmación', async ({ status }) => {
    const usados = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status,
    });
    const bloque = await screen.findByRole('group', { name: 'Mando virtual de vuelo continuo' });
    expect(bloque).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByTestId('mando-impedimento')).not.toBeInTheDocument();
    expect(screen.getByTestId('mando-esperando')).toHaveTextContent(/todavía no confirmó el vuelo manual/);

    // Y lo que importa: el gesto no se traga, el eje sale.
    fireEvent.keyDown(bloque, { key: 'w' });
    expect(usados.onMando).toHaveBeenCalledWith({ pitch: 0, roll: 0, yaw: 0, throttle: 1 });
    fireEvent.keyUp(bloque, { key: 'w' });
  });

  it('llegado el status con el vuelo manual, el aviso de espera se va solo', async () => {
    const usados = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status: makeStatus({ state: 'PATROLLING', controlledBy: null }),
    });
    expect(await screen.findByTestId('mando-esperando')).toBeInTheDocument();

    // Un segundo después llega el status de la app con el control ya aplicado.
    usados.volverARenderizar({ status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1' }) });
    expect(screen.queryByTestId('mando-esperando')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mando-impedimento')).not.toBeInTheDocument();
  });

  it('si el enlace se corta en pleno vuelo manual, el mando dice el motivo Y que el comando no salió', async () => {
    const onMando = vi.fn(() => true);
    const usados = renderDetail({
      me: makeMe({ username: 'admin1', canControl: true }),
      drone: makeDrone({ controlledBy: 'admin1', online: true }),
      status: makeStatus({ state: 'MANUAL', controlledBy: 'admin1' }),
      onMando,
    });
    const bloque = await screen.findByRole('group', { name: 'Mando virtual de vuelo continuo' });
    fireEvent.keyDown(bloque, { key: 'ArrowUp' });
    expect(onMando).toHaveBeenCalledWith({ pitch: 1, roll: 0, yaw: 0, throttle: 0 });

    // Se cae el socket de la consola: `conectado` pasa a false y el `enviar` del
    // canal empieza a devolver false, las dos cosas por el mismo motivo. Esta es
    // la única combinación con la que se ve el aviso de "no salió", y la consola
    // sí la produce: el padre pone el impedimento y el hijo se queda sin salida.
    onMando.mockReturnValue(false);
    usados.volverARenderizar({ conectado: false, onMando });

    expect(screen.getByTestId('mando-impedimento')).toHaveTextContent(
      'Sin conexión con el Comando Central: el mando no responde.',
    );
    expect(screen.getByTestId('mando-no-salio')).toHaveTextContent(/El último comando no salió/);
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
