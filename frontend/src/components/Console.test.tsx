import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Console from './Console';
import type { WaypointsLayer } from './DronesMap';
import { makeDrone, makeMe, makeRoute, makeStatus } from '../test/fixtures';
import type { Me } from '../types';

// El mapa se sustituye por un botón que dispara el renombre de un nodo: Leaflet
// no corre en jsdom, pero el cable que baja hasta Console sí se puede probar.
vi.mock('./DronesMap', () => ({
  default: ({ waypoints }: { waypoints?: WaypointsLayer | null }) => (
    <button data-testid="mapa-mock" onClick={() => waypoints?.onLabel(1, 'Portón')}>
      mapa
    </button>
  ),
}));

// Captura el handler de mensajes que Console le pasa a useWebSocket, para poder
// empujar mensajes desde los tests. Devuelve siempre "conectado".
let wsHandler: (msg: unknown) => void = () => {};
vi.mock('../useWebSocket', () => ({
  useWebSocket: (cb: (msg: unknown) => void) => {
    wsHandler = cb;
    return true;
  },
}));

// El backend se interviene en `fetch` y no en el módulo `api`: las vistas usan
// los atajos (traerDrones, traerUsuarios, traerLogs), que por dentro llaman al
// `api` privado del módulo, así que mockear el export no los alcanzaría.
type Pedido = { metodo: string; ruta: string; cuerpo: string };
let pedidos: Pedido[] = [];
/** Pedidos que el backend rechaza en este test, como `PATCH /drones/d1`. */
let rechazados = new Set<string>();

let meFix: Me = makeMe({ username: 'oper1', role: 'operator' });
let dronesFix = [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true })];
let routesFix = [makeRoute()];

function responder(metodo: string, ruta: string, cuerpo: string): unknown {
  if (ruta === '/me') return meFix;
  if (metodo === 'PATCH' && ruta.startsWith('/drones/')) return { ...dronesFix[0], ...JSON.parse(cuerpo) };
  if (ruta.startsWith('/drones')) return dronesFix;
  if (ruta.startsWith('/logs')) return { items: [], total: 0, page: 1, pageSize: 25 };
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
  rechazados = new Set();
  meFix = makeMe({ username: 'oper1', role: 'operator' });
  dronesFix = [makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true })];
  routesFix = [];
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
        status: ok ? 200 : 400,
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
    // Un operador sólo tiene su pantalla de trabajo: ni activos, ni usuarios,
    // ni registro.
    expect(screen.getByRole('button', { name: 'Operación' })).toHaveClass('active');
    expect(screen.queryByRole('button', { name: 'Drones' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Usuarios' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Registro' })).not.toBeInTheDocument();
  });

  it('el admin navega entre Operación, Drones, Usuarios y Registro', async () => {
    meFix = makeMe({ username: 'admin1', role: 'admin' });
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');

    await userEvent.click(await screen.findByRole('button', { name: 'Drones' }));
    expect(await screen.findByRole('heading', { name: 'Dar de alta un dron' })).toBeInTheDocument();

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

    expect(await screen.findByRole('heading', { name: 'Dar de alta un dron' })).toBeInTheDocument();
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
    expect(await screen.findByText('AlfaNuevo')).toBeInTheDocument();

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
    await screen.findByRole('heading', { name: 'Dar de alta un dron' });
    const pedidosPrevios = rutas().filter((r) => r.startsWith('GET /drones')).length;

    fire({ type: 'drone_updated', drone: makeDrone({ hash: 'd3', droneId: 'd3', displayName: 'Charlie' }) });

    expect(await screen.findByText('Charlie')).toBeInTheDocument();
    expect(rutas().filter((r) => r.startsWith('GET /drones'))).toHaveLength(pedidosPrevios);
  });

  it('la conexión y el renombre de un dron también refrescan la tabla de activos', async () => {
    meFix = makeMe({ username: 'super1', role: 'supervisor' });
    dronesFix = [makeDrone({ hash: 'd1', droneId: 'd1', displayName: 'Alfa', online: false })];
    render(<Console onLogout={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Drones' }));

    const filaAlfa = (await screen.findByText('Alfa', { selector: 'div' })).closest('tr') as HTMLElement;
    expect(within(filaAlfa).getByText('No')).toBeInTheDocument();

    // El dron que se conecta emite `drone_online`, no `drone_updated`: sin esto
    // la columna "En línea" quedaba congelada hasta salir y volver a la sección.
    fire({ type: 'drone_online', drone: makeDrone({ hash: 'd1', droneId: 'd1', displayName: 'Alfa', online: true }) });
    await waitFor(() => expect(within(filaAlfa).getByText('Sí')).toBeInTheDocument());

    // Y el renombre iniciado desde la app llega solo, como `drone_renamed`
    fire({ type: 'drone_renamed', droneId: 'd1', displayName: 'Bravo' });
    expect(await screen.findByText('Bravo', { selector: 'div' })).toBeInTheDocument();
  });

  it('un activo eliminado desaparece de la operación', async () => {
    meFix = makeMe({ username: 'admin1', role: 'admin' });
    render(<Console onLogout={() => {}} />);
    await screen.findByText('Alfa');

    fire({
      type: 'drone_updated',
      drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', online: false, deletedAt: '2024-02-01T10:00:00.000Z' }),
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
    await screen.findByText('Sin señal de video');
    await userEvent.click(screen.getByText('Sin señal de video'));

    const volver = await screen.findByRole('button', { name: /Volver a Drones/ });
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
    await screen.findByText('Sin señal de video');
    await userEvent.click(screen.getByText('Sin señal de video'));
    await screen.findByRole('button', { name: /Volver a Drones/ });
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
    await screen.findByText('Sin señal de video');
    await userEvent.click(screen.getByText('Sin señal de video'));

    const volver = await screen.findByRole('button', { name: /Volver a Drones/ });
    const header = volver.closest('.detail-main') as HTMLElement;
    await userEvent.click(within(header).getByTitle('Renombrar dron'));
    await userEvent.clear(within(header).getByDisplayValue('Alfa'));
    await userEvent.type(within(header).getByRole('textbox'), 'Alfa3');
    await userEvent.click(within(header).getByTitle('Guardar'));

    await waitFor(() => expect(enConsola).toHaveBeenCalled());
    expect(within(header).getByText('Alfa')).toBeInTheDocument();
    enConsola.mockRestore();
  });

  it('cierra sesión con el botón Salir', async () => {
    const onLogout = vi.fn();
    render(<Console onLogout={onLogout} />);
    await screen.findByText('Alfa');
    await userEvent.click(screen.getByRole('button', { name: 'Salir' }));
    expect(onLogout).toHaveBeenCalled();
  });
});
