import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAlert, makeDrone, makeEmergencia, makeEvent, makeFoto, makeMe, makeRelevo, makeStatus } from '../test/fixtures';
import type { Alert, Drone, Emergencia, EventRow, Me, Relevo } from '../types';
import Console from './Console';

/*
 * La consola con los relevos y las emergencias (RELEVOS §6): lo que llega por
 * REST al montar y al reconectar, lo que llega por el WebSocket, y adónde se
 * ve. El backend es un doble en `fetch` y el canal, uno de useWebSocket, como
 * en Console.test.tsx.
 */

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
vi.mock('./DronesMap', () => ({ default: () => <div data-testid="mapa-mock" /> }));
vi.mock('./Minimapa', () => ({ default: () => <div data-testid="minimapa-mock" /> }));

let wsHandler: (msg: unknown) => void = () => {};
/** Si el canal está arriba. Cambiarlo y forzar un render simula una reconexión. */
let conectadoFix = true;
vi.mock('../useWebSocket', () => ({
  useWebSocket: (cb: (msg: unknown) => void) => {
    wsHandler = cb;
    return { conectado: conectadoFix, enviar: () => true };
  },
}));

type Pedido = { metodo: string; ruta: string };
let pedidos: Pedido[] = [];
/** Pedidos que el backend rechaza, con su código. */
let rechazos: Record<string, number> = {};

let meFix: Me = makeMe({ username: 'oper1', role: 'operator' });
const ALFA = makeDrone({ droneId: 'a1', hash: 'a1', displayName: 'Alfa', online: true });
const BRAVO = makeDrone({ droneId: 'b2', hash: 'b2', displayName: 'Bravo', online: true });
let dronesFix: Drone[] = [];
let alertasFix: Alert[] = [];
let relevosFix: unknown = [];
let emergenciasFix: Emergencia[] = [];
let eventosFix: EventRow[] = [];
/** Lo que devuelve la ficha de una emergencia (GET /emergencias/:id). */
let fichaFix: (id: number) => unknown = () => ({});
let recuperadaFix: (id: number) => unknown = () => ({});

function responder(metodo: string, ruta: string): unknown {
  if (ruta === '/me') return meFix;
  if (ruta.startsWith('/drones')) return dronesFix;
  if (ruta.startsWith('/alerts')) return alertasFix;
  if (ruta.startsWith('/relevos')) return relevosFix;
  const recuperada = /^\/emergencias\/(\d+)\/recuperada$/.exec(ruta);
  if (metodo === 'POST' && recuperada) return recuperadaFix(Number(recuperada[1]));
  const ficha = /^\/emergencias\/(\d+)$/.exec(ruta);
  if (ficha) return fichaFix(Number(ficha[1]));
  if (ruta.startsWith('/emergencias')) return emergenciasFix;
  if (ruta.startsWith('/events')) return eventosFix;
  if (/^\/bases\/\d+\/routes/.test(ruta) || ruta.startsWith('/routes')) return [];
  return [];
}

function rutas(): string[] {
  return pedidos.map((p) => `${p.metodo} ${p.ruta}`);
}

function fichaDe(e: Emergencia, fotos = [makeFoto()]) {
  const { fotos: _n, ...resto } = e;
  return { ...resto, fotos };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('cc_token', 'tok');
  localStorage.setItem('cc_user', 'oper1');
  pedidos = [];
  rechazos = {};
  conectadoFix = true;
  meFix = makeMe({ username: 'oper1', role: 'operator' });
  dronesFix = [ALFA, BRAVO];
  alertasFix = [];
  relevosFix = [];
  emergenciasFix = [];
  eventosFix = [];
  fichaFix = (id) => fichaDe(makeEmergencia({ id }));
  recuperadaFix = (id) => makeEmergencia({ id, recuperadaEn: '2026-10-23T15:40:00.000Z', recuperadaPor: 'oper1' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const metodo = init.method ?? 'GET';
      const ruta = String(url).replace(/^\/api/, '');
      pedidos.push({ metodo, ruta });
      const codigo = rechazos[`${metodo} ${ruta}`];
      return {
        ok: codigo === undefined,
        status: codigo ?? 200,
        json: async () => (codigo === undefined ? responder(metodo, ruta) : { error: 'El backend dijo que no' }),
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

/** El mosaico de un dron en el tablero. */
async function mosaico(nombre: string): Promise<HTMLElement> {
  const boton = await screen.findByRole('button', { name: `Ver detalle de ${nombre}` });
  return boton.closest('.camera-tile') as HTMLElement;
}

/** Simula que el canal se cae y vuelve: cada cambio de `conectado` vuelve a pedir lo que importa. */
function reconectar() {
  conectadoFix = false;
  fire({ type: 'drone_renamed', droneId: 'zz', displayName: 'nadie' });
  conectadoFix = true;
  fire({ type: 'drone_renamed', droneId: 'zz', displayName: 'nadie otra vez' });
}

describe('Console — relevos', () => {
  it('al montar pide los relevos activos y pinta las insignias de los dos drones', async () => {
    relevosFix = [makeRelevo()];
    render(<Console onLogout={() => {}} />);

    expect(await within(await mosaico('Alfa')).findByText('Relevo en camino: Bravo')).toBeInTheDocument();
    expect(within(await mosaico('Bravo')).getByText('Relevando a Alfa')).toBeInTheDocument();
    expect(rutas()).toContain('GET /relevos?activos=1');
  });

  it('relay_updated las mueve en vivo, y una versión vieja no pisa a la nueva', async () => {
    render(<Console onLogout={() => {}} />);
    const alfa = await mosaico('Alfa');
    expect(within(alfa).queryByTestId('insignias-relevo')).not.toBeInTheDocument();

    fire({ type: 'relay_updated', relay: makeRelevo({ estado: 'RESERVADO', actualizadoEn: '2026-10-23T15:04:06.000Z' }) });
    expect(within(alfa).getByText('Relevo asignado: Bravo')).toBeInTheDocument();
    fire({ type: 'relay_updated', relay: makeRelevo({ estado: 'EN_CAMINO' }) });
    expect(within(alfa).getByText('Relevo en camino: Bravo')).toBeInTheDocument();
    // Llega tarde la del ORDENADO: no vuelve atrás.
    fire({ type: 'relay_updated', relay: makeRelevo({ estado: 'ORDENADO', actualizadoEn: '2026-10-23T15:04:10.000Z' }) });
    expect(within(alfa).getByText('Relevo en camino: Bravo')).toBeInTheDocument();
    // Un mensaje roto no tumba nada.
    fire({ type: 'relay_updated', relay: { id: 'siete' } });
    fire({
      type: 'relay_updated',
      relay: makeRelevo({ estado: 'COMPLETADO', actualizadoEn: '2026-10-23T15:06:00.000Z' }),
    });
    expect(within(alfa).queryByTestId('insignias-relevo')).not.toBeInTheDocument();
  });

  it('«En espera para relevos» sale del status del dron', async () => {
    render(<Console onLogout={() => {}} />);
    const bravo = await mosaico('Bravo');
    fire({
      type: 'status',
      ...makeStatus({
        droneId: 'b2',
        state: 'IDLE',
        flying: false,
        relevo: { enEspera: true, disponible: true, relayId: null, rol: null, fase: null },
      }),
    });
    expect(await within(bravo).findByText('En espera para relevos', {}, { timeout: 3000 })).toHaveClass('badge', 'ok');
  });

  it('al reconectar vuelve a pedirlos, y se va el relevo que terminó mientras tanto', async () => {
    relevosFix = [makeRelevo()];
    render(<Console onLogout={() => {}} />);
    const alfa = await mosaico('Alfa');
    await within(alfa).findByText('Relevo en camino: Bravo');

    relevosFix = [];
    reconectar();
    await waitFor(() => expect(within(alfa).queryByTestId('insignias-relevo')).not.toBeInTheDocument());
    expect(rutas().filter((r) => r === 'GET /relevos?activos=1').length).toBeGreaterThanOrEqual(2);
  });

  it('un backend sin relevos (lista rota o error) deja la consola andando', async () => {
    relevosFix = { error: 'no' };
    rechazos['GET /emergencias?abiertas=1'] = 404;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Console onLogout={() => {}} />);
    expect(await mosaico('Alfa')).toBeInTheDocument();
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(screen.queryByTestId('insignias-relevo')).not.toBeInTheDocument();
    error.mockRestore();
  });

  it('la vista del dron lleva sus insignias en la cabecera', async () => {
    relevosFix = [makeRelevo()];
    render(<Console onLogout={() => {}} />);
    await within(await mosaico('Bravo')).findByText('Relevando a Alfa');
    await userEvent.click(screen.getByRole('button', { name: 'Ver detalle de Bravo' }));
    const cabecera = (await screen.findByRole('button', { name: 'Volver a Operación' })).closest('.detail-head') as HTMLElement;
    expect(within(cabecera).getByText('Relevando a Alfa')).toHaveClass('badge', 'oro');
    // Y la tarjeta de patrullaje avisa qué le hace al relevo una orden.
    expect(screen.getByTestId('aviso-relevo')).toHaveTextContent('Está yendo a relevar a Alfa');
  });
});

describe('Console — la alerta cambia de dueño', () => {
  it('alert_updated con seguidaPor mueve la pendiente al dron que la sigue', async () => {
    alertasFix = [makeAlert({ id: 12, drone_id: 'a1', status: 'PENDING' })];
    render(<Console onLogout={() => {}} />);
    const alfa = await mosaico('Alfa');
    expect(await within(alfa).findByText('Alertas pendientes')).toBeInTheDocument();

    fire({ type: 'alert_updated', alert: { ...alertasFix[0], seguidaPor: 'b2' } });
    expect(within(alfa).queryByText('Alertas pendientes')).not.toBeInTheDocument();
    expect(within(await mosaico('Bravo')).getByText('Alertas pendientes')).toBeInTheDocument();
  });

  it('«Ver feed en vivo» de una alerta relevada lleva al dron que la sigue', async () => {
    alertasFix = [makeAlert({ id: 12, drone_id: 'a1', seguidaPor: 'b2', status: 'PENDING' })];
    render(<Console onLogout={() => {}} />);
    await mosaico('Alfa');
    await userEvent.click(await screen.findByRole('button', { name: /^Alertas: 1 pendiente/ }));
    const panel = screen.getByRole('region', { name: 'Alertas de detección' });
    // El nombre que lleva a la vista es el del que la sigue.
    expect(within(panel).getByRole('button', { name: 'Bravo' })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Ver detalle' }));

    const popup = screen.getByRole('dialog', { name: /Alerta de persona #12/ });
    expect(popup).toHaveTextContent('Dron que la sigue');
    expect(popup).toHaveTextContent('La detectóAlfa');
    await userEvent.click(within(popup).getByRole('button', { name: 'Ver feed en vivo' }));
    expect(await screen.findByRole('button', { name: 'Volver a Operación' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /Bravo/ })).toBeInTheDocument();
  });
});

describe('Console — aterrizajes de emergencia', () => {
  it('al montar pide las abiertas y deja el aviso arriba de todo', async () => {
    emergenciasFix = [makeEmergencia()];
    render(<Console onLogout={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Aterrizaje de emergencia sin recuperar' })).toHaveTextContent('Alfa');
    expect(rutas()).toContain('GET /emergencias?abiertas=1');
  });

  it('emergency_updated abre el aviso, la ficha suma las fotos en vivo, y al recuperarse el aviso se va', async () => {
    render(<Console onLogout={() => {}} />);
    await mosaico('Alfa');
    expect(screen.queryByRole('region', { name: /sin recuperar/ })).not.toBeInTheDocument();

    fire({ type: 'emergency_updated', emergencia: makeEmergencia({ fotos: 1 }) });
    fire({ type: 'emergency_updated', emergencia: { id: 'roto' } });
    await userEvent.click(screen.getByRole('button', { name: /Ver la ficha/ }));
    const ficha = screen.getByRole('dialog', { name: 'Aterrizaje de emergencia #3' });
    await within(ficha).findByTestId('galeria-emergencia');
    expect(rutas()).toContain('GET /emergencias/3');
    expect(within(ficha).queryAllByRole('button', { name: /^Ver la foto/ })).toHaveLength(0);

    fire({ type: 'emergency_photo', emergenciaId: 3, ...makeFoto({ seq: 2, tipo: 'cenital', jpegBase64: '/9j/DOS' }) });
    fire({ type: 'emergency_photo', seq: 3, jpegBase64: '/9j/sin emergencia' });
    fire({ type: 'emergency_updated', emergencia: makeEmergencia({ fotos: 2 }) });
    expect(within(ficha).getAllByRole('button', { name: /^Ver la foto/ })).toHaveLength(2);
    expect(within(ficha).getByRole('button', { name: /^Ver la foto 2: Cenital/ })).toBeInTheDocument();

    fire({
      type: 'emergency_updated',
      emergencia: makeEmergencia({ fotos: 2, recuperadaEn: '2026-10-23T15:40:00.000Z', recuperadaPor: 'campo1' }),
    });
    expect(screen.queryByRole('region', { name: /sin recuperar/ })).not.toBeInTheDocument();
  });

  it('marcarla recuperada hace el POST y el aviso se va sin esperar al WebSocket', async () => {
    emergenciasFix = [makeEmergencia()];
    render(<Console onLogout={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /Ver la ficha/ }));
    const ficha = screen.getByRole('dialog', { name: 'Aterrizaje de emergencia #3' });
    await within(ficha).findByTestId('galeria-emergencia');
    await userEvent.click(within(ficha).getByRole('button', { name: 'Marcar como recuperado' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Marcar Alfa como recuperado' })).getByRole('button', {
        name: 'Marcar como recuperado',
      }),
    );

    await waitFor(() => expect(screen.queryByRole('region', { name: /sin recuperar/ })).not.toBeInTheDocument());
    expect(rutas()).toContain('POST /emergencias/3/recuperada');
  });

  it('si otra persona ya la había marcado (409), lo dice y vuelve a traer la ficha, que se cierra', async () => {
    emergenciasFix = [makeEmergencia()];
    rechazos['POST /emergencias/3/recuperada'] = 409;
    render(<Console onLogout={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /Ver la ficha/ }));
    const ficha = screen.getByRole('dialog', { name: 'Aterrizaje de emergencia #3' });
    await within(ficha).findByTestId('galeria-emergencia');

    fichaFix = (id) => fichaDe(makeEmergencia({ id, recuperadaEn: '2026-10-23T15:39:00.000Z', recuperadaPor: 'campo2' }));
    await userEvent.click(within(ficha).getByRole('button', { name: 'Marcar como recuperado' }));
    const confirmacion = screen.getByRole('dialog', { name: 'Marcar Alfa como recuperado' });
    await userEvent.click(within(confirmacion).getByRole('button', { name: 'Marcar como recuperado' }));

    expect(await within(confirmacion).findByRole('alert')).toHaveTextContent(
      'Otra persona ya la marcó como recuperada: la ficha se actualiza sola.',
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: /sin recuperar/ })).not.toBeInTheDocument());
    expect(rutas().filter((r) => r === 'GET /emergencias/3')).toHaveLength(2);
  });

  it('otro rechazo lo dice igual, sin volver a pedir la ficha', async () => {
    emergenciasFix = [makeEmergencia()];
    rechazos['POST /emergencias/3/recuperada'] = 500;
    render(<Console onLogout={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /Ver la ficha/ }));
    const ficha = screen.getByRole('dialog', { name: 'Aterrizaje de emergencia #3' });
    await within(ficha).findByTestId('galeria-emergencia');
    await userEvent.click(within(ficha).getByRole('button', { name: 'Marcar como recuperado' }));
    const confirmacion = screen.getByRole('dialog', { name: 'Marcar Alfa como recuperado' });
    await userEvent.click(within(confirmacion).getByRole('button', { name: 'Marcar como recuperado' }));
    expect(await within(confirmacion).findByRole('alert')).toHaveTextContent(
      'No se pudo marcar como recuperada: El backend dijo que no',
    );
    expect(rutas().filter((r) => r === 'GET /emergencias/3')).toHaveLength(1);
  });

  it('el aviso cruza todas las secciones, no sólo la operación', async () => {
    emergenciasFix = [makeEmergencia()];
    render(<Console onLogout={() => {}} />);
    await screen.findByRole('region', { name: /sin recuperar/ });
    for (const [seccion, titulo] of [
      ['Bases', 'Bases'],
      ['Rutas', 'Rutas de patrullaje'],
      ['Drones', 'Drones'],
    ]) {
      await userEvent.click(screen.getByRole('button', { name: seccion }));
      expect(await screen.findByRole('heading', { name: titulo, level: 2 })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: /sin recuperar/ })).toBeInTheDocument();
    }
  });

  it('al reconectar se va el aviso de la que se recuperó mientras tanto', async () => {
    emergenciasFix = [makeEmergencia()];
    render(<Console onLogout={() => {}} />);
    await screen.findByRole('region', { name: /sin recuperar/ });
    emergenciasFix = [];
    reconectar();
    await waitFor(() => expect(screen.queryByRole('region', { name: /sin recuperar/ })).not.toBeInTheDocument());
  });

  it('el operador de campo ve el aviso y la ficha, pero no pide relevos', async () => {
    meFix = makeMe({ username: 'campo1', role: 'field_operator', canControl: false });
    emergenciasFix = [makeEmergencia()];
    render(<Console onLogout={() => {}} />);
    expect(await screen.findByRole('region', { name: /sin recuperar/ })).toBeInTheDocument();
    expect(rutas()).toContain('GET /emergencias?abiertas=1');
    expect(rutas()).not.toContain('GET /relevos?activos=1');
    await userEvent.click(screen.getByRole('button', { name: /Ver la ficha/ }));
    const ficha = screen.getByRole('dialog', { name: 'Aterrizaje de emergencia #3' });
    expect(await within(ficha).findByRole('button', { name: 'Marcar como recuperado' })).toBeInTheDocument();
  });
});

describe('Console — los eventos de relevos y emergencias se abren desde el historial', () => {
  it('un RELAY_STARTED muestra su rótulo, sus datos y cómo está el relevo ahora', async () => {
    relevosFix = [makeRelevo({ estado: 'EN_CAMINO', etaS: 40 })];
    eventosFix = [
      makeEvent({
        id: 50,
        type: 'RELAY_STARTED',
        message: 'Bravo sale a relevar a Alfa',
        drone_id: 'a1',
        source: 'backend',
        meta: JSON.stringify({
          drone: { hash: 'a1', displayName: 'Alfa', model: 'DJI Mini 4 Pro' },
          detalle: {
            relevoId: 7,
            motivo: 'seguimiento',
            estado: 'EN_CAMINO',
            motivoFin: null,
            origen: 'Alfa',
            relevo: 'Bravo',
            relevoHash: 'b2',
            rutaId: null,
            desdeNodo: null,
            motivoDeB: null,
          },
        }),
      }),
    ];
    render(<Console onLogout={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ver detalle de Alfa' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver historial de eventos' }));
    const historial = screen.getByRole('dialog', { name: 'Historial de eventos' });
    await userEvent.click(await within(historial).findByRole('button', { name: /RELAY_STARTED/ }));

    const panel = within(historial).getByRole('region', { name: 'Bravo sale a relevar a Alfa' });
    expect(panel).toHaveTextContent('Relevo en camino · RELAY_STARTED');
    expect(panel).toHaveTextContent('MotivoSeguimiento');
    expect(panel).toHaveTextContent('EstadoEn camino');
    expect(panel).toHaveTextContent('Dron de relevoBravo');
    expect(panel).not.toHaveTextContent('b2');
    const ahora = within(panel).getByTestId('relevo-ahora');
    expect(ahora).toHaveTextContent('En camino');
    expect(ahora).toHaveTextContent('Llega en40 s');
  });

  it('un EMERGENCY_LANDING abre la ficha entera de la emergencia, sin repetir el mapa', async () => {
    eventosFix = [
      makeEvent({
        id: 51,
        type: 'EMERGENCY_LANDING',
        message: 'Alfa inicia un aterrizaje de emergencia',
        drone_id: 'a1',
        source: 'backend',
        meta: JSON.stringify({
          drone: { hash: 'a1', displayName: 'Alfa', model: 'DJI Mini 4 Pro' },
          emergencia: { id: 3, motivo: 'autonomia', lat: -34.8702, lon: -56.1902, ts: '2026-10-23T15:04:05.300Z' },
          ubicacion: { lat: -34.8702, lon: -56.1902, accuracyM: null },
          detalle: { alt: 38, bateria: 9 },
        }),
      }),
    ];
    render(<Console onLogout={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ver detalle de Alfa' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver historial de eventos' }));
    const historial = screen.getByRole('dialog', { name: 'Historial de eventos' });
    const fila = await within(historial).findByRole('button', { name: /EMERGENCY_LANDING/ });
    expect(fila.querySelector('.event-type')).toHaveClass('bad');
    expect(fila.querySelector('.event-type')).toHaveAttribute('title', 'Aterrizaje de emergencia');
    await userEvent.click(fila);

    const panel = within(historial).getByRole('region', { name: 'Alfa inicia un aterrizaje de emergencia' });
    expect(await within(panel).findByTestId('detalle-emergencia')).toBeInTheDocument();
    expect(within(panel).queryByTestId('mapa-ubicacion')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('mapa-emergencia')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Altura38 m');
    expect(panel).toHaveTextContent('Batería9 %');
    expect(rutas()).toContain('GET /emergencias/3');
  });

  it('el historial del dron que fue a relevar suma en vivo los eventos del relevo', async () => {
    render(<Console onLogout={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ver detalle de Bravo' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver historial de eventos' }));
    const historial = screen.getByRole('dialog', { name: 'Historial de eventos' });
    await within(historial).findByText('Sin eventos registrados.');

    const delRelevo = (id: number, relevoHash: string, type = 'RELAY_ASSIGNED') =>
      makeEvent({
        id,
        type,
        drone_id: 'a1',
        message: `evento ${id}`,
        meta: JSON.stringify({ detalle: { relevoId: 7, relevoHash } }),
      });
    fire({ type: 'event', event: delRelevo(60, 'b2') });
    fire({ type: 'event', event: delRelevo(61, 'c3') });
    // Un evento cualquiera de A con el mismo campo no es de B.
    fire({ type: 'event', event: delRelevo(62, 'b2', 'PATROL_STARTED') });
    expect(within(historial).getByText('evento 60')).toBeInTheDocument();
    expect(within(historial).queryByText('evento 61')).not.toBeInTheDocument();
    expect(within(historial).queryByText('evento 62')).not.toBeInTheDocument();
  });
});

describe('Console — los ejemplos del contrato (docs/contrato/relevos.json)', () => {
  const contrato = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/contrato/relevos.json'), 'utf8'),
  ) as {
    drones: Record<'alfa' | 'bravo', { droneId: string; displayName: string }>;
    mensajes: { hub_a_la_consola: Record<string, { validos: { mensaje: Record<string, unknown> }[] }> };
    rest: Record<string, { respuesta: unknown }>;
  };
  const mensaje = (tipo: string) => contrato.mensajes.hub_a_la_consola[tipo].validos[0].mensaje;

  it('cada mensaje de ejemplo para la consola se ve donde tiene que verse', async () => {
    const { alfa, bravo } = contrato.drones;
    dronesFix = [
      makeDrone({ ...alfa, hash: alfa.droneId, online: true, baseId: 1 }),
      makeDrone({ ...bravo, hash: bravo.droneId, online: true, baseId: 2 }),
    ];
    const alerta = mensaje('alert_updated').alert as Alert;
    alertasFix = [{ ...alerta, status: 'PENDING', seguidaPor: null }];
    relevosFix = contrato.rest['GET /api/relevos?activos=1'].respuesta as Relevo[];
    render(<Console onLogout={() => {}} />);

    const mosaicoAlfa = await mosaico('Alfa');
    // Del REST: Alfa tiene un seguimiento en camino y un pedido de patrulla sin candidato.
    expect(await within(mosaicoAlfa).findByText('Relevo en camino: Bravo')).toBeInTheDocument();
    expect(within(mosaicoAlfa).getByText('Sin relevo disponible')).toHaveClass('badge', 'malo');
    expect(within(mosaicoAlfa).getByText('Alertas pendientes')).toBeInTheDocument();

    for (const tipo of ['relay_updated', 'emergency_updated', 'emergency_photo', 'base_updated']) fire(mensaje(tipo));
    fire({ ...mensaje('alert_updated'), alert: { ...alerta, status: 'PENDING' } });

    expect(within(await mosaico('Bravo')).getByText('Relevando a Alfa')).toBeInTheDocument();
    expect(within(await mosaico('Bravo')).getByText('Alertas pendientes')).toBeInTheDocument();
    expect(within(mosaicoAlfa).queryByText('Alertas pendientes')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Aterrizaje de emergencia sin recuperar' })).toHaveTextContent(
      'En tierra desde las',
    );
  });
});

