import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HistorialDeEventos, { EVENTOS_DEL_HISTORIAL, EVENTOS_POR_PAGINA } from './HistorialDeEventos';
import { ContextoDeAlertas, SIN_CONSOLA, type AlertasEnVivo } from '../alertasEnVivo';
import { api } from '../api';
import { makeAlert, makeDrone, makeEvent } from '../test/fixtures';
import { limpiarEstadoMapa } from '../test/dobleLeaflet';
import type { EventRow } from '../types';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

/** `n` eventos del dron d1 con ids de `desde` para abajo (el más nuevo primero, como el backend). */
function eventos(n: number, desde = n): EventRow[] {
  return Array.from({ length: n }, (_, i) => makeEvent({ id: desde - i, message: `evento ${desde - i}` }));
}

function montar(
  { liveEvents = [] as EventRow[], vivo = null as AlertasEnVivo | null } = {},
) {
  const onCerrar = vi.fn();
  const historial = (
    <HistorialDeEventos droneId="d1" nombre="Alfa" liveEvents={liveEvents} onCerrar={onCerrar} />
  );
  const envolver = (hijo: ReactNode) =>
    vivo ? <ContextoDeAlertas.Provider value={vivo}>{hijo}</ContextoDeAlertas.Provider> : hijo;
  const { unmount } = render(envolver(historial));
  return { onCerrar, unmount };
}

const fila = (mensaje: string) => screen.getByRole('button', { name: new RegExp(`: ${mensaje}$`) });
const info = () => screen.getByText(/^Página/);

describe('HistorialDeEventos', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue([]);
    limpiarEstadoMapa();
  });
  afterEach(() => {
    // jsdom no implementa scrollIntoView: algunos tests lo ponen para mirarlo.
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('pide los últimos cien eventos del dron y lo dice en la cabecera', async () => {
    montar();
    expect(screen.getByRole('dialog', { name: 'Historial de eventos' })).toBeInTheDocument();
    expect(screen.getByText(`Alfa · los últimos ${EVENTOS_DEL_HISTORIAL}`)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/events?droneId=d1&limit=100');
    expect(await screen.findByText('Sin eventos registrados.')).toBeInTheDocument();
    // Sin eventos no hay nada que paginar.
    expect(screen.queryByRole('navigation', { name: 'Páginas del historial' })).not.toBeInTheDocument();
  });

  it('mientras viaja el pedido no dice "sin eventos"', async () => {
    let contestar: (v: EventRow[]) => void = () => {};
    apiMock.mockImplementation(() => new Promise((r) => (contestar = r)));
    montar();
    expect(screen.getByText('Trayendo los eventos del dron…')).toBeInTheDocument();
    expect(screen.queryByText('Sin eventos registrados.')).not.toBeInTheDocument();

    await act(async () => contestar([makeEvent({ id: 1, message: 'despegó' })]));
    expect(fila('despegó')).toBeInTheDocument();
  });

  it('suma los que llegan en vivo, sin repetir y sin los de otros drones, del más nuevo al más viejo', async () => {
    apiMock.mockResolvedValue([makeEvent({ id: 5, message: 'del historial' }), makeEvent({ id: 3, message: 'viejo' })]);
    montar({
      liveEvents: [
        makeEvent({ id: 9, drone_id: 'd1', message: 'en vivo' }),
        makeEvent({ id: 8, drone_id: 'otro', message: 'de otro dron' }),
        makeEvent({ id: 5, drone_id: 'd1', message: 'del historial' }),
      ],
    });
    await screen.findByText('del historial');
    const mensajes = screen.getAllByRole('button', { name: /^Ver el detalle/ }).map((b) => b.textContent);
    expect(mensajes).toEqual([
      expect.stringContaining('en vivo'),
      expect.stringContaining('del historial'),
      expect.stringContaining('viejo'),
    ]);
    expect(screen.queryByText('de otro dron')).not.toBeInTheDocument();
    expect(info()).toHaveTextContent('Página 1 de 1 · 3 eventos');
  });

  it('pagina de a veinte y no pasa de cien, aunque lleguen más en vivo', async () => {
    apiMock.mockResolvedValue(eventos(100));
    montar({ liveEvents: [makeEvent({ id: 101, drone_id: 'd1', message: 'evento 101' })] });
    await screen.findByText('evento 101');

    expect(screen.getAllByRole('button', { name: /^Ver el detalle/ })).toHaveLength(EVENTOS_POR_PAGINA);
    expect(info()).toHaveTextContent('Página 1 de 5 · 100 eventos');
    // El más viejo quedó afuera: el título promete cien.
    const anterior = screen.getByRole('button', { name: 'Anterior' });
    const siguiente = screen.getByRole('button', { name: 'Siguiente' });
    expect(anterior).toBeDisabled();

    await userEvent.click(siguiente);
    expect(info()).toHaveTextContent('Página 2 de 5');
    expect(fila('evento 81')).toBeInTheDocument();
    expect(screen.queryByText('evento 101')).not.toBeInTheDocument();

    for (let i = 0; i < 3; i++) await userEvent.click(siguiente);
    expect(info()).toHaveTextContent('Página 5 de 5');
    expect(siguiente).toBeDisabled();
    expect(fila('evento 2')).toBeInTheDocument();
    expect(screen.queryByText('evento 1')).not.toBeInTheDocument();

    await userEvent.click(anterior);
    expect(info()).toHaveTextContent('Página 4 de 5');
  });

  it('cambiar de página vuelve la lista arriba', async () => {
    apiMock.mockResolvedValue(eventos(40));
    montar();
    await screen.findByText('evento 40');
    const lista = screen.getByRole('region', { name: 'Eventos del dron' });
    lista.scrollTop = 300;
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(lista.scrollTop).toBe(0);
  });

  it('abrir un evento muestra su detalle al lado de la lista, en el mismo pop-up', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    apiMock.mockResolvedValue([
      makeEvent({
        id: 2,
        type: 'DRONE_UPDATED',
        message: 'se renombró',
        meta: JSON.stringify({ antes: { displayName: 'Alfa' }, despues: { displayName: 'Alfa 2' } }),
      }),
      makeEvent({ id: 1, message: 'despegó' }),
    ]);
    montar();
    await userEvent.click(await screen.findByRole('button', { name: /se renombró/ }));

    // Un solo diálogo: el detalle no es otro pop-up encima.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const panel = screen.getByRole('region', { name: 'se renombró' });
    expect(within(panel).getByText('DRONE_UPDATED')).toBeInTheDocument();
    expect(within(panel).getByText('Cambios')).toBeInTheDocument();
    expect(within(panel).getByText('Alfa 2')).toHaveClass('cambiado');
    expect(fila('se renombró')).toHaveAttribute('aria-current', 'true');
    expect(panel.parentElement).toHaveClass('historial', 'con-detalle');
    // En una pantalla angosta el detalle queda abajo: se lo trae a la vista.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });

    // Se pasa a otro evento sin cerrar nada.
    await userEvent.click(fila('despegó'));
    expect(screen.getByRole('region', { name: 'despegó' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'se renombró' })).not.toBeInTheDocument();
  });

  it('cerrar el detalle devuelve el foco a la fila que lo abrió', async () => {
    apiMock.mockResolvedValue([makeEvent({ id: 1, message: 'despegó' })]);
    montar();
    await userEvent.click(await screen.findByRole('button', { name: /despegó/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar el detalle del evento' }));

    expect(screen.queryByRole('region', { name: 'despegó' })).not.toBeInTheDocument();
    expect(fila('despegó')).toHaveFocus();
    expect(fila('despegó')).not.toHaveAttribute('aria-current');
  });

  it('con un evento abierto, Escape cierra sólo el detalle y el foco vuelve a la fila; el segundo cierra el pop-up', async () => {
    apiMock.mockResolvedValue([makeEvent({ id: 2, message: 'aterrizó' }), makeEvent({ id: 1, message: 'despegó' })]);
    const { onCerrar } = montar();
    await userEvent.click(await screen.findByRole('button', { name: /despegó/ }));
    // El foco adentro del panel, que es lo que se va con el primer Escape.
    act(() => screen.getByRole('button', { name: 'Cerrar el detalle del evento' }).focus());

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'despegó' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Historial de eventos' })).toBeInTheDocument();
    expect(onCerrar).not.toHaveBeenCalled();
    expect(fila('despegó')).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });

  it('el detalle de una alerta trae captura, mapa y decisión, y el video cierra el historial', async () => {
    const vivo: AlertasEnVivo = {
      ...SIN_CONSOLA,
      alertas: [makeAlert({ id: 7, drone_id: 'd1', snapshot: 'QUFB' })],
      drones: [makeDrone({ droneId: 'd1', displayName: 'Alfa' })],
      decidir: vi.fn(),
      verDron: vi.fn(),
    };
    apiMock.mockResolvedValue([
      makeEvent({
        id: 3,
        type: 'ALERT_CREATED',
        alert_id: 7,
        message: 'Alerta de PERSONA generada por Alfa',
        meta: JSON.stringify({ alerta: { id: 7, tipo: 'PERSON', lat: -34.6, lon: -58.4, ts: null } }),
      }),
    ]);
    const { onCerrar } = montar({ vivo });
    await userEvent.click(await screen.findByRole('button', { name: /Alerta de PERSONA generada por Alfa/ }));

    const panel = screen.getByRole('region', { name: 'Alerta de PERSONA generada por Alfa' });
    expect(within(panel).getByAltText('Captura de la detección')).toBeInTheDocument();
    expect(within(panel).getByTestId('mapa-alerta')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Validar' }));
    expect(vivo.decidir).toHaveBeenCalledWith(7, 'VALIDATED');

    await userEvent.click(within(panel).getByRole('button', { name: 'Ver feed en vivo' }));
    expect(vivo.verDron).toHaveBeenCalledWith('d1');
    expect(onCerrar).toHaveBeenCalled();
  });

  it('si el pedido falla lo dice, sin un "sin eventos" que lo contradiga', async () => {
    apiMock.mockRejectedValue(new Error('Error 500'));
    montar();
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo traer el historial: Error 500');
    expect(screen.queryByText('Sin eventos registrados.')).not.toBeInTheDocument();
  });

  it('si el pedido falla, lo que llegó en vivo se sigue viendo', async () => {
    apiMock.mockRejectedValue('sin red');
    montar({ liveEvents: [makeEvent({ id: 4, drone_id: 'd1', message: 'en vivo' })] });
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo traer el historial: sin red');
    expect(fila('en vivo')).toBeInTheDocument();
    expect(info()).toHaveTextContent('Página 1 de 1 · 1 evento');
  });

  it('la respuesta que llega con el historial ya cerrado no se escribe', async () => {
    let contestar: (v: EventRow[]) => void = () => {};
    let fallar: (e: Error) => void = () => {};
    apiMock.mockImplementationOnce(() => new Promise((r) => (contestar = r)));
    montar().unmount();
    await act(async () => contestar(eventos(3)));

    apiMock.mockImplementationOnce(() => new Promise((_, r) => (fallar = r)));
    montar().unmount();
    await act(async () => fallar(new Error('tarde')));
    expect(screen.queryByText(/tarde/)).not.toBeInTheDocument();
  });

  it('se cierra con la cruz, con el pie y con Escape', async () => {
    const { onCerrar } = montar();
    await waitFor(() => expect(screen.getByText('Sin eventos registrados.')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar el historial' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    await userEvent.keyboard('{Escape}');
    expect(onCerrar).toHaveBeenCalledTimes(3);
  });
});
