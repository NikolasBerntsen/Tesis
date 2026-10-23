import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Console from './Console';
import type { MapItem, WaypointsLayer } from './DronesMap';
import { makeDrone, makeEvent, makeMe, makeRoute, makeStatus } from '../test/fixtures';
import type { EventRow, Me, ObjetivoEnSeguimiento } from '../types';

// El pop-up de una alerta lleva un mapa (MapaDeAlerta): Leaflet no corre en jsdom.
vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());

// El mapa se sustituye por un botón que dispara el renombre de un nodo: Leaflet
// no corre en jsdom, pero el cable que baja hasta Console sí se puede probar.
// Además anota los items que recibe, para seguir el rastro del objetivo.
const { mapa } = vi.hoisted(() => ({ mapa: { items: [] as MapItem[] } }));
vi.mock('./DronesMap', () => ({
  default: ({ items, waypoints }: { items: MapItem[]; waypoints?: WaypointsLayer | null }) => {
    mapa.items = items;
    return (
      <button data-testid="mapa-mock" onClick={() => waypoints?.onLabel(1, 'Portón')}>
        mapa
      </button>
    );
  },
}));

// El minimapa de la vista de pilotaje es Leaflet puro y acá no se prueba nada
// de él: con un recuadro vacío alcanza.
vi.mock('./Minimapa', () => ({ default: () => <div data-testid="minimapa-mock" /> }));

// Captura el handler de mensajes que Console le pasa a useWebSocket y anota todo
// lo que la consola manda por el canal, para poder empujar mensajes desde los
// tests y leer los que salen. Devuelve siempre "conectado".
let wsHandler: (msg: unknown) => void = () => {};
let enviados: unknown[] = [];
vi.mock('../useWebSocket', () => ({
  useWebSocket: (cb: (msg: unknown) => void) => {
    wsHandler = cb;
    return {
      conectado: true,
      enviar: (mensaje: unknown) => {
        enviados.push(mensaje);
        return true;
      },
    };
  },
}));

// El backend se interviene en `fetch` y no en el módulo `api`: las vistas usan
// los atajos (traerDrones, traerUsuarios, traerLogs), que por dentro llaman al
// `api` privado del módulo, así que mockear el export no los alcanzaría.
type Pedido = { metodo: string; ruta: string; cuerpo: string };
let pedidos: Pedido[] = [];
/** Pedidos que el backend rechaza en este test, como `PATCH /drones/d1`. */
let rechazados = new Set<string>();
/** Con qué código se rechaza cada uno (400 si no se dice otra cosa). */
let codigos: Record<string, number> = {};

let meFix: Me = makeMe({ username: 'oper1', role: 'operator' });
let dronesFix = [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true })];
let routesFix = [makeRoute()];
/** Lo que devuelve el Registro (GET /logs). */
let logsFix: EventRow[] = [];

function responder(metodo: string, ruta: string, cuerpo: string): unknown {
  if (ruta === '/me') return meFix;
  if (metodo === 'PATCH' && ruta.startsWith('/drones/')) return { ...dronesFix[0], ...JSON.parse(cuerpo) };
  if (ruta.startsWith('/drones')) return dronesFix;
  if (ruta.startsWith('/logs')) return { items: logsFix, total: logsFix.length, page: 1, pageSize: 25 };
  // Las rutas que la base del dron tiene habilitadas: son las que la vista de
  // detalle ofrece en el selector.
  if (/^\/bases\/\d+\/routes/.test(ruta)) return routesFix;
  if (ruta.startsWith('/bases')) return [];
  if (ruta.startsWith('/routes')) return metodo === 'PATCH' ? routesFix[0] : routesFix;
  if (ruta.startsWith('/alerts') || ruta.startsWith('/users') || ruta.startsWith('/events')) return [];
  return {};
}

function rutas(): string[] {
  return pedidos.map((p) => `${p.metodo} ${p.ruta}`);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('cc_token', 'tok');
  localStorage.setItem('cc_user', 'oper1');
  pedidos = [];
  enviados = [];
  rechazados = new Set();
  codigos = {};
  mapa.items = [];
  meFix = makeMe({ username: 'oper1', role: 'operator' });
  dronesFix = [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true })];
  routesFix = [];
  logsFix = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const metodo = init.method ?? 'GET';
      const ruta = String(url).replace(/^\/api/, '');
      const cuerpo = typeof init.body === 'string' ? init.body : '{}';
      pedidos.push({ metodo, ruta, cuerpo });
      const ok = !rechazados.has(`${metodo} ${ruta}`);
      return {
        ok,
        status: ok ? 200 : (codigos[`${metodo} ${ruta}`] ?? 400),
        json: async () => (ok ? responder(metodo, ruta, cuerpo) : { error: 'El backend dijo que no' }),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fire(msg: unknown) {
  act(() => wsHandler(msg));
}

/**
 * Abre el detalle del primer dron desde su mosaico. El mosaico entero es
 * clickeable por CSS (`.tile-abrir` estirado encima), pero jsdom no calcula
 * posiciones: acá se usa el control accesible, que es el que recibe el click
 * en el navegador.
 */
async function abrirDetalleDelPrimerDron() {
  await screen.findByText('Sin señal de video');
  await userEvent.click((await screen.findAllByRole('button', { name: /^Ver detalle de / }))[0]);
}

describe('Console', () => {
  it('carga los datos al montar y muestra el dashboard conectado', async () => {
    render(<Console onLogout={() => {}} />);
    expect(await screen.findByText('Alfa')).toBeInTheDocument();
    await waitFor(() => expect(rutas()).toContain('GET /me'));
    expect(rutas()).toContain('GET /drones');
    expect(rutas()).toContain('GET /alerts');
    expect(rutas()).toContain('GET /routes');
    // El enlace se dibuja con .estado (punto de currentColor), sin el carácter
    // decorativo que traía el texto.
    expect(screen.getByText('conectado')).toHaveClass('conn', 'estado', 'ok');
    // El operador arranca en su pantalla de trabajo. Ve el inventario y las
    // bases para ubicarse, pero no administra usuarios ni lee el registro.
    expect(screen.getByRole('button', { name: 'Operación' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Drones' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bases' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Secciones de la consola' })).toBeInTheDocument();
    // La barra lleva el escudo del proyecto, decorativo: el nombre lo dice el
    // título, escrito como se dice aunque la hoja lo pase a mayúsculas.
    const marca = screen.getByRole('heading', { name: 'Alta en el Cielo', level: 1 });
    expect(marca.closest('.marca')!.querySelector('img.marca-escudo')).toHaveAttribute('alt', '');
    expect(screen.getByText('Comando de drones')).toHaveClass('marca-lema');
    // Cada sección lleva su ícono, oculto al lector: el nombre es el rótulo.
    const operacion = screen.getByRole('button', { name: 'Operación' });
    expect(operacion.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // El nombre se recorta en una tableta: el title lo deja leer entero.
    expect(screen.getByText('oper1', { selector: '.username' })).toHaveAttribute('title', 'oper1');
    // La región de los avisos de "guardado" está desde el arranque, vacía.
    expect(document.querySelector('.avisos-flotantes')).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Usuarios' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Registro' })).not.toBeInTheDocument();
  });

  it('el admin navega entre Operación, Drones, Usuarios y Registro', async () => {
    meFix = makeMe({ username: 'admin1', role: 'admin' });
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');

    await userEvent.click(await screen.findByRole('button', { name: 'Drones' }));
    expect(await screen.findByRole('button', { name: 'Nuevo dron' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Usuarios' }));
    expect(await screen.findByRole('heading', { name: 'Usuarios' })).toBeInTheDocument();
    // La sección abierta lleva el filo dorado (.active) y se anuncia como actual
    expect(screen.getByRole('button', { name: 'Usuarios' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Usuarios' })).toHaveAttribute('aria-current', 'page');

    await userEvent.click(screen.getByRole('button', { name: 'Registro' }));
    expect(await screen.findByRole('heading', { name: 'Registro del sistema' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Operación' }));
    expect(await screen.findByText('Alfa')).toBeInTheDocument();
  });

  it('el supervisor ve Drones y Usuarios pero no Registro', async () => {
    meFix = makeMe({ username: 'super1', role: 'supervisor' });
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');
    expect(await screen.findByRole('button', { name: 'Drones' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Usuarios' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Registro' })).not.toBeInTheDocument();
  });

  it('al operador de campo le da una consola acotada: sólo activos, sin alertas ni rutas', async () => {
    meFix = makeMe({ username: 'campo1', role: 'field_operator', canControl: false });
    render(<Console onLogout={() => {}} />);

    expect(await screen.findByRole('button', { name: 'Nuevo dron' })).toBeInTheDocument();
    expect(screen.getByText('Sesión de campo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drones' })).toHaveClass('active');
    expect(screen.queryByRole('button', { name: 'Operación' })).not.toBeInTheDocument();

    // El backend no le manda nada de operación: pedirlo sería un 403 y una
    // pantalla vacía. El único /drones que sale es el de la vista de activos.
    expect(rutas()).not.toContain('GET /alerts');
    expect(rutas()).not.toContain('GET /routes');
    expect(rutas().filter((r) => r.startsWith('GET /drones'))).toEqual(['GET /drones']);
  });

  it('pinta la barra con el rol guardado y corrige la sección con /me', async () => {
    // Rol viejo en localStorage: la barra abre con las secciones del admin y el
    // backend contesta que es un operador, que no tiene ninguna de ésas.
    localStorage.setItem('cc_role', 'admin');
    meFix = makeMe({ username: 'oper1', role: 'operator' });
    render(<Console onLogout={() => {}} />);

    expect(screen.getByRole('button', { name: 'Registro' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Registro' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Operación' })).toHaveClass('active');
  });

  it('procesa los mensajes de WebSocket (alta, alerta, renombrado y baja)', async () => {
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');

    fire({ type: 'alert_created', alert: { id: 1, type: 'PERSON', status: 'PENDING', drone_id: 'd1', created_at: '2024-01-01T12:00:00.000Z' } });
    expect(await screen.findByText(/1 alerta(s)? sin atender/)).toBeInTheDocument();

    fire({ type: 'drone_online', drone: makeDrone({ droneId: 'd2', displayName: 'Bravo', online: true }) });
    expect(await screen.findByText('Bravo')).toBeInTheDocument();

    fire({ type: 'drone_renamed', droneId: 'd1', displayName: 'AlfaNuevo' });
    // Dos veces: en su cámara y en la alerta pendiente, que dice de qué dron es.
    expect(await screen.findAllByText('AlfaNuevo')).toHaveLength(2);

    // Estos ramales del switch se cubren empujando cada tipo de mensaje.
    fire({ type: 'alert_updated', alert: { id: 1, type: 'PERSON', status: 'VALIDATED', drone_id: 'd1', created_at: '2024-01-01T12:00:00.000Z' } });
    fire({ type: 'event', event: { id: 9, ts: '2024-01-01T12:00:00.000Z', type: 'X', message: 'm', drone_id: 'd1', category: 'drone', source: 's', alert_id: null, meta: null } });
    fire({ type: 'video_frame', droneId: 'd1', jpegBase64: 'AAAA' });
    fire({ type: 'route_updated', route: { id: 1, name: 'R', description: '', waypoints: [] } });
    fire({ type: 'control_changed', droneId: 'd1', controlledBy: 'oper1' });
    fire({ type: 'desconocido' });

    fire({ type: 'drone_offline', drone: makeDrone({ droneId: 'd2', displayName: 'Bravo', online: false }) });
    await waitFor(() => expect(screen.queryByText('Bravo')).not.toBeInTheDocument());
  });

  it('drone_updated refresca la tabla de activos sin volver a pedir la lista', async () => {
    meFix = makeMe({ username: 'admin1', role: 'admin' });
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');
    await userEvent.click(screen.getByRole('button', { name: 'Drones' }));
    await screen.findByRole('button', { name: 'Nuevo dron' });
    const pedidosPrevios = rutas().filter((r) => r.startsWith('GET /drones')).length;

    fire({ type: 'drone_updated', drone: makeDrone({ hash: 'd3', droneId: 'd3', displayName: 'Charlie' }) });

    expect(await screen.findByText('Charlie')).toBeInTheDocument();
    expect(rutas().filter((r) => r.startsWith('GET /drones'))).toHaveLength(pedidosPrevios);
  });

  it('base_updated actualiza la base de los drones que la tienen asignada', async () => {
    dronesFix = [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true, baseId: 4, base: { name: 'Base Vieja', lat: -34.6, lon: -58.4 } })];
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();
    await screen.findByRole('button', { name: /Volver a Operación/ });
    // La tarjeta de estado sólo se dibuja con telemetría: el buffer se vuelca
    // en el próximo tick.
    fire({ type: 'status', ...makeStatus({ droneId: 'd1' }) });
    const estado = (await screen.findByText('Modo y posición', undefined, { timeout: 3000 })).closest(
      '.status-segundo-nivel',
    ) as HTMLElement;
    expect(within(estado).getByText('Base Vieja')).toBeInTheDocument();

    // Mover o renombrar la base tiene que llegar a la ficha del dron sin
    // recargar la consola entera.
    act(() => {
      wsHandler({ type: 'base_updated', base: { id: 4, name: 'Base Obelisco', lat: -34.6037, lon: -58.3816 } });
    });

    expect(await within(estado).findByText('Base Obelisco')).toBeInTheDocument();
    expect(within(estado).queryByText('Base Vieja')).not.toBeInTheDocument();
  });

  it('una base ajena no toca la ficha del dron', async () => {
    dronesFix = [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true, baseId: 4, base: { name: 'Base Vieja', lat: -34.6, lon: -58.4 } })];
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();
    await screen.findByRole('button', { name: /Volver a Operación/ });
    fire({ type: 'status', ...makeStatus({ droneId: 'd1' }) });
    const estado = (await screen.findByText('Modo y posición', undefined, { timeout: 3000 })).closest(
      '.status-segundo-nivel',
    ) as HTMLElement;

    act(() => {
      wsHandler({ type: 'base_updated', base: { id: 99, name: 'Base Palermo', lat: -34.57, lon: -58.41 } });
    });

    expect(within(estado).getByText('Base Vieja')).toBeInTheDocument();
  });

  it('la conexión y el renombre de un dron también refrescan las fichas de activos', async () => {
    meFix = makeMe({ username: 'super1', role: 'supervisor' });
    dronesFix = [makeDrone({ hash: 'd1', droneId: 'd1', displayName: 'Alfa', online: false })];
    render(<Console onLogout={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Drones' }));

    const fichaAlfa = (await screen.findByText('Alfa', { selector: 'h3' })).closest('article') as HTMLElement;
    expect(within(fichaAlfa).getByText('Desconectado')).toBeInTheDocument();

    // El dron que se conecta emite `drone_online`, no `drone_updated`: sin esto
    // la pastilla de "En línea" quedaba congelada hasta salir y volver a la sección.
    fire({ type: 'drone_online', drone: makeDrone({ hash: 'd1', droneId: 'd1', displayName: 'Alfa', online: true }) });
    await waitFor(() => expect(within(fichaAlfa).getByText('En línea')).toBeInTheDocument());

    // Y el renombre iniciado desde la app llega solo, como `drone_renamed`
    fire({ type: 'drone_renamed', droneId: 'd1', displayName: 'Bravo' });
    expect(await screen.findByText('Bravo', { selector: 'h3' })).toBeInTheDocument();
  });

  it('un activo eliminado desaparece de la operación', async () => {
    meFix = makeMe({ username: 'admin1', role: 'admin' });
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');

    fire({
      type: 'drone_updated',
      drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', online: false, deleted: true, deletedAt: '2024-02-01T10:00:00.000Z' }),
    });

    await waitFor(() => expect(screen.queryByText('Alfa')).not.toBeInTheDocument());
    expect(screen.getByText(/0 en vuelo/)).toBeInTheDocument();
  });

  it('vuelca los status acumulados en cada tick', async () => {
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');

    fire({ type: 'status', ...makeStatus({ droneId: 'd1', battery: 30, signalPct: 40 }) });
    // El buffer se vuelca al estado en el próximo tick (1 s).
    expect(await screen.findByText('30%', undefined, { timeout: 3000 })).toBeInTheDocument();
  });

  it('abre el detalle de un dron y permite renombrarlo', async () => {
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();

    const volver = await screen.findByRole('button', { name: /Volver a Operación/ });
    expect(volver).toBeInTheDocument();

    // Renombrar desde el detalle dispara el PATCH del dron.
    const header = volver.closest('.detail-main') as HTMLElement;
    await userEvent.click(within(header).getByTitle('Renombrar dron'));
    const input = within(header).getByDisplayValue('Alfa');
    await userEvent.clear(input);
    await userEvent.type(input, 'Alfa2');
    await userEvent.click(within(header).getByTitle('Guardar'));

    await waitFor(() =>
      expect(pedidos).toContainEqual({
        metodo: 'PATCH',
        ruta: '/drones/d1',
        cuerpo: JSON.stringify({ displayName: 'Alfa2' }),
      }),
    );
  });

  it('renombra un nodo de la ruta desde el mapa del detalle', async () => {
    routesFix = [makeRoute({ id: 7 })];
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();
    await screen.findByRole('button', { name: /Volver a Operación/ });
    // El mapa sólo dibuja los nodos de la ruta elegida en el selector.
    await userEvent.selectOptions(screen.getByLabelText('Ruta de patrullaje'), '7');

    await userEvent.click(screen.getByTestId('mapa-mock'));

    await waitFor(() =>
      expect(pedidos).toContainEqual({
        metodo: 'PATCH',
        ruta: '/routes/7/waypoints/1',
        cuerpo: JSON.stringify({ label: 'Portón' }),
      }),
    );
  });

  it('si el backend rechaza el renombrado, el nombre queda como estaba', async () => {
    rechazados.add('PATCH /drones/d1');
    const enConsola = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();

    const volver = await screen.findByRole('button', { name: /Volver a Operación/ });
    const header = volver.closest('.detail-main') as HTMLElement;
    await userEvent.click(within(header).getByTitle('Renombrar dron'));
    await userEvent.clear(within(header).getByDisplayValue('Alfa'));
    await userEvent.type(within(header).getByRole('textbox'), 'Alfa3');
    await userEvent.click(within(header).getByTitle('Guardar'));

    await waitFor(() => expect(enConsola).toHaveBeenCalled());
    expect(within(header).getByText('Alfa')).toBeInTheDocument();
    enConsola.mockRestore();
  });

  it('la vista de pilotaje manda los ejes y la cámara por el WebSocket con el droneId del dron abierto', async () => {
    // Se comanda con el control manual tomado por uno mismo. El status viene
    // como lo reenvía el Comando Central —con el dueño del lock estampado— y con
    // el dron ya en MANUAL, que es el estado en el que la app aplica los ejes:
    // la telemetría entra por `lastStatus` y se vuelca en el tick.
    dronesFix = [
      makeDrone({
        droneId: 'd1',
        displayName: 'Alfa',
        online: true,
        controlledBy: 'oper1',
        lastStatus: makeStatus({ droneId: 'd1', state: 'MANUAL', controlledBy: 'oper1' }),
      }),
    ];
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();
    await userEvent.click(await screen.findByRole('button', { name: 'Volver a la vista de pilotaje' }));
    await screen.findByRole('dialog', { name: 'Pilotaje de Alfa' });

    // Los ejes van por el socket y NO por REST: a 10 Hz, un POST por mensaje
    // sería absurdo. Se cuentan los pedidos HTTP antes y después de la ráfaga:
    // si alguien mandara los ejes por REST —con cualquier path— este total se
    // movería, que es lo que se quiere afirmar.
    const pedidosAntes = pedidos.length;
    fireEvent.keyDown(window, { code: 'KeyW' });
    expect(enviados[0]).toEqual({ type: 'manual_stick', droneId: 'd1', pitch: 0.5, roll: 0, yaw: 0, throttle: 0 });

    // Al soltar, el último mensaje va en cero: el dron queda estacionario.
    fireEvent.keyUp(window, { code: 'KeyW' });
    expect(enviados.at(-1)).toEqual({ type: 'manual_stick', droneId: 'd1', pitch: 0, roll: 0, yaw: 0, throttle: 0 });
    expect(enviados).toHaveLength(2);

    // La rueda inclina la cámara: `manual_gimbal` con la inclinación absoluta,
    // por el mismo socket (una app vieja no informa la cámara: se parte de -30°).
    fireEvent.wheel(screen.getByTestId('pilotaje-video'), { deltaY: -100, deltaMode: 0 });
    expect(enviados.at(-1)).toEqual({ type: 'manual_gimbal', droneId: 'd1', pitch: -25 });
    expect(pedidos).toHaveLength(pedidosAntes);
  });

  it('apenas tomado el control el mando ya emite, sin esperar el status con el vuelo manual', async () => {
    // El camino más normal que hay, de punta a punta: el dron viene patrullando,
    // nadie tiene el control y el operador lo toma para volarlo a mano.
    dronesFix = [
      makeDrone({
        droneId: 'd1',
        displayName: 'Alfa',
        online: true,
        controlledBy: null,
        // El último status del patrullaje: sin dueño del lock estampado, porque
        // cuando el Comando Central lo reenvió todavía no había control tomado.
        lastStatus: makeStatus({ droneId: 'd1', state: 'PATROLLING', controlledBy: null }),
      }),
    ];
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();
    await userEvent.click(await screen.findByRole('button', { name: 'Tomar control manual' }));
    expect(rutas()).toContain('POST /drones/d1/control');

    // Tomar el control abre la vista de pilotaje. El backend broadcastea el
    // lock EN EL ACTO; el estado MANUAL, en cambio, tarda hasta un segundo de la
    // app (su `statusTicker`) más otro del volcado de la consola. Se espera a
    // que se vuelque el status del patrullaje para estar parados justo en esa
    // ventana: control tomado y el dron todavía sin confirmar.
    await screen.findByRole('dialog', { name: 'Pilotaje de Alfa' });
    fire({ type: 'control_changed', droneId: 'd1', controlledBy: 'oper1' });
    await waitFor(() => expect(screen.getByText('Patrullando')).toBeInTheDocument(), { timeout: 3000 });
    expect(await screen.findByTestId('pilotaje-esperando')).toBeInTheDocument();
    expect(screen.queryByTestId('pilotaje-impedimento')).not.toBeInTheDocument();

    // Y el teclado comanda: el gesto del operador no se traga ni un segundo.
    fireEvent.keyDown(window, { code: 'KeyW' });
    expect(enviados).toContainEqual({ type: 'manual_stick', droneId: 'd1', pitch: 0.5, roll: 0, yaw: 0, throttle: 0 });
    fireEvent.keyUp(window, { code: 'KeyW' });
    expect(enviados.at(-1)).toEqual({ type: 'manual_stick', droneId: 'd1', pitch: 0, roll: 0, yaw: 0, throttle: 0 });
  });

  it('un 409 al decidir una alerta se le explica al operador en la campana', async () => {
    rechazados.add('POST /alerts/1/decision');
    codigos['POST /alerts/1/decision'] = 409;
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');
    fire({ type: 'alert_created', alert: { id: 1, type: 'PERSON', status: 'PENDING', drone_id: 'd1', created_at: '2024-01-01T12:00:00.000Z' } });

    await userEvent.click(await screen.findByRole('button', { name: /1 pendiente/ }));
    const panel = screen.getByRole('region', { name: /alertas de detección/i });
    await userEvent.click(within(panel).getByRole('button', { name: 'Validar' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Esta alerta ya la decidió otro operador: la lista se actualiza sola.',
    );
    expect(pedidos).toContainEqual({
      metodo: 'POST',
      ruta: '/alerts/1/decision',
      cuerpo: JSON.stringify({ decision: 'VALIDATED' }),
    });
  });

  it('una alerta se abre desde la campana en su pop-up, y desde ahí se va al video del dron', async () => {
    meFix = makeMe({ username: 'admin1', role: 'admin' });
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');
    // Desde otra sección: el pop-up lleva al dron igual.
    await userEvent.click(screen.getByRole('button', { name: 'Registro' }));
    await screen.findByRole('heading', { name: 'Registro del sistema' });
    fire({
      type: 'alert_created',
      alert: {
        id: 3,
        type: 'PERSON',
        status: 'PENDING',
        drone_id: 'd1',
        lat: -34.6,
        lon: -58.4,
        snapshot: 'QUFB',
        decided_by: null,
        decided_at: null,
        created_at: '2024-01-01T12:00:00.000Z',
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: /1 pendiente/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    const dialogo = screen.getByRole('dialog', { name: 'Alerta de persona #3' });
    expect(within(dialogo).getByAltText('Captura de la detección')).toBeInTheDocument();
    expect(within(dialogo).getByText('En línea')).toBeInTheDocument();

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Ver feed en vivo' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Volver a Operación/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Operación' })).toHaveClass('active');
  });

  it('en el Registro, el evento de una alerta la muestra entera, se decide ahí y lleva al video', async () => {
    meFix = makeMe({ username: 'admin1', role: 'admin' });
    logsFix = [
      makeEvent({
        id: 9,
        type: 'ALERT_CREATED',
        alert_id: 5,
        message: 'Alerta de VEHÍCULO generada por Alfa',
        meta: JSON.stringify({ alerta: { id: 5, tipo: 'VEHICLE', lat: -34.6, lon: -58.4, ts: '2024-01-01T12:00:00.000Z' } }),
      }),
    ];
    rechazados.add('POST /alerts/5/decision');
    codigos['POST /alerts/5/decision'] = 409;
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');
    fire({
      type: 'alert_created',
      alert: {
        id: 5,
        type: 'VEHICLE',
        status: 'PENDING',
        drone_id: 'd1',
        lat: -34.6,
        lon: -58.4,
        snapshot: 'QkJC',
        decided_by: null,
        decided_at: null,
        created_at: '2024-01-01T12:00:00.000Z',
      },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Registro' }));
    await userEvent.click(await screen.findByRole('button', { name: /Ver el detalle de ALERT_CREATED/ }));
    const dialogo = screen.getByRole('dialog', { name: 'Alerta de VEHÍCULO generada por Alfa' });
    expect(within(dialogo).getByAltText('Captura de la detección')).toHaveAttribute('src', 'data:image/jpeg;base64,QkJC');

    // Otro operador ya la había decidido: el motivo se lee en el pop-up.
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Validar' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('ya la decidió otro operador');

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Ver feed en vivo' }));
    expect(await screen.findByRole('button', { name: /Volver a Operación/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('la alerta pendiente del dron se decide desde su vista, al lado del video', async () => {
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();
    fire({
      type: 'alert_created',
      alert: { id: 4, type: 'VEHICLE', status: 'PENDING', drone_id: 'd1', created_at: '2024-01-01T12:00:00.000Z', snapshot: 'QUFB' },
    });

    const tarjeta = await screen.findByRole('region', { name: 'Alerta en curso' });
    await userEvent.click(within(tarjeta).getByRole('button', { name: 'Descartar' }));
    await waitFor(() =>
      expect(pedidos).toContainEqual({
        metodo: 'POST',
        ruta: '/alerts/4/decision',
        cuerpo: JSON.stringify({ decision: 'DISMISSED' }),
      }),
    );

    // Decidida, la tarjeta se va sola cuando el backend avisa.
    fire({
      type: 'alert_updated',
      alert: { id: 4, type: 'VEHICLE', status: 'DISMISSED', drone_id: 'd1', created_at: '2024-01-01T12:00:00.000Z' },
    });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Alerta en curso' })).not.toBeInTheDocument());
  });

  const ALERTA_6 = { id: 6, type: 'PERSON', status: 'PENDING', drone_id: 'd1', created_at: '2024-01-01T12:00:00.000Z' };

  /**
   * Abre la alerta 6 desde el carrusel, la valida en el pop-up y hace que el
   * backend lo confirme: era la única pendiente, así que el carrusel se va
   * —con el botón que abrió el pop-up— y el pop-up queda abierto.
   */
  async function validarLaUnicaDesdeSuPopUp(carrusel: HTMLElement) {
    await userEvent.click(within(carrusel).getByRole('button', { name: 'Ver detalle' }));
    const dialogo = screen.getByRole('dialog', { name: 'Alerta de persona #6' });
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Validar' }));
    await waitFor(() => expect(rutas()).toContain('POST /alerts/6/decision'));
    fire({
      type: 'alert_updated',
      alert: { ...ALERTA_6, status: 'VALIDATED', decided_by: 'oper1', decided_at: '2024-01-01T12:01:00.000Z' },
    });
    await waitFor(() => expect(carrusel).not.toBeInTheDocument());
    expect(dialogo).toBeInTheDocument();
  }

  it('decidida en su pop-up la última alerta del tablero, al cerrarlo el foco va al título y no a <body>', async () => {
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');
    fire({ type: 'alert_created', alert: ALERTA_6 });
    await validarLaUnicaDesdeSuPopUp(await screen.findByRole('region', { name: '1 alerta sin atender' }));

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Operación' })).toHaveFocus();
  });

  it('en la vista del dron, el foco va al título con su nombre', async () => {
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();
    fire({ type: 'alert_created', alert: ALERTA_6 });
    await validarLaUnicaDesdeSuPopUp(await screen.findByRole('region', { name: 'Alerta en curso' }));

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /^Alfa/ })).toHaveFocus();
  });

  it('arma el rastro del objetivo con cada status y lo borra cuando el seguimiento termina', async () => {
    const objetivo = (lon: number): ObjetivoEnSeguimiento => ({
      alertId: 12,
      type: 'VEHICLE',
      lat: -34.6,
      lon,
      speedMs: 4,
      courseDeg: 90,
      moving: true,
      lost: false,
      lastSeenMs: 500,
      decision: 'PENDING',
    });
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();

    // Dos status en el mismo segundo: los dos puntos cuentan, aunque al mapa
    // le llegue un solo volcado.
    fire({ type: 'status', ...makeStatus({ droneId: 'd1', state: 'FOLLOWING', target: objetivo(-58.38) }) });
    fire({ type: 'status', ...makeStatus({ droneId: 'd1', state: 'FOLLOWING', target: objetivo(-58.379) }) });
    await waitFor(() => expect(mapa.items[0]?.rastroObjetivo).toHaveLength(2), { timeout: 3000 });

    fire({ type: 'status', ...makeStatus({ droneId: 'd1', state: 'FOLLOWING', target: objetivo(-58.378) }) });
    await waitFor(() => expect(mapa.items[0]?.rastroObjetivo).toHaveLength(3), { timeout: 3000 });
    expect(mapa.items[0].rastroObjetivo?.[2]).toEqual([-34.6, -58.378]);

    fire({ type: 'status', ...makeStatus({ droneId: 'd1', state: 'PATROLLING', target: null }) });
    await waitFor(() => expect(mapa.items[0]?.rastroObjetivo).toBeUndefined(), { timeout: 3000 });
  });

  it('el rastro arranca con el último status de la carga inicial, y se va con el dron', async () => {
    const objetivo: ObjetivoEnSeguimiento = {
      alertId: 12,
      type: 'PERSON',
      lat: -34.6,
      lon: -58.38,
      speedMs: 0,
      courseDeg: 0,
      moving: false,
      lost: false,
      lastSeenMs: 500,
      decision: 'VALIDATED',
    };
    dronesFix = [
      makeDrone({
        droneId: 'd1',
        displayName: 'Alfa',
        online: true,
        lastStatus: makeStatus({ droneId: 'd1', state: 'ORBITING', target: objetivo }),
      }),
    ];
    render(<Console onLogout={() => {}} />);
    await abrirDetalleDelPrimerDron();
    fire({ type: 'status', ...makeStatus({ droneId: 'd1', state: 'ORBITING', target: { ...objetivo, lon: -58.379 } }) });
    await waitFor(() => expect(mapa.items[0]?.rastroObjetivo).toHaveLength(2), { timeout: 3000 });

    fire({ type: 'drone_offline', drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', online: false }) });
    await waitFor(() => expect(mapa.items[0]?.rastroObjetivo).toBeUndefined(), { timeout: 3000 });
  });

  it('cierra sesión con el botón Salir', async () => {
    const onLogout = vi.fn();
    render(<Console onLogout={onLogout} />);
    await screen.findByText('Alfa');
    await userEvent.click(screen.getByRole('button', { name: 'Salir' }));
    expect(onLogout).toHaveBeenCalled();
  });
});
