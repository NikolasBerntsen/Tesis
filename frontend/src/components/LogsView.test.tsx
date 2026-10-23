import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LogsView from './LogsView';
import { traerLogs } from '../api';
import { makeEvent } from '../test/fixtures';
import type { EventRow, PaginaLogs } from '../types';

// El pop-up dibuja un mapa Leaflet cuando el evento trae ubicación; en jsdom no
// hay teselas ni tamaños, así que la biblioteca se reemplaza por un doble.
const leaflet = vi.hoisted(() => {
  const capa = { addTo: vi.fn(() => capa) };
  const mapa = {
    setView: vi.fn(() => mapa),
    getPane: vi.fn(() => document.createElement('div')),
    invalidateSize: vi.fn(),
    remove: vi.fn(),
    attributionControl: { setPrefix: vi.fn(), getContainer: vi.fn(() => document.createElement('div')) },
  };
  return {
    map: vi.fn(() => mapa),
    tileLayer: vi.fn(() => capa),
    marker: vi.fn(() => capa),
    circle: vi.fn(() => capa),
    divIcon: vi.fn(() => ({})),
  };
});
vi.mock('leaflet', () => ({ default: leaflet }));

// Sólo se dobla el pedido del registro: parsearMeta y los tamaños de página
// son los de verdad, que es justo lo que la vista tiene que respetar.
vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  traerLogs: vi.fn(),
}));
const traerLogsMock = vi.mocked(traerLogs);

function pagina(items: EventRow[], over: Partial<PaginaLogs> = {}): PaginaLogs {
  return { items, total: items.length, page: 1, pageSize: 25, ...over };
}

const paginador = () => screen.getByRole('navigation', { name: 'Paginación' });

describe('LogsView', () => {
  beforeEach(() => {
    traerLogsMock.mockReset();
    traerLogsMock.mockResolvedValue(pagina([]));
  });

  it('trae la primera página de todas las categorías al montar', async () => {
    traerLogsMock.mockResolvedValue(
      pagina([makeEvent({ id: 1, message: 'arranque del sistema', category: 'sistema', type: 'LOGIN' })]),
    );
    render(<LogsView />);

    await waitFor(() => expect(traerLogsMock).toHaveBeenCalledWith({ category: '', page: 1, pageSize: 25 }));
    expect(await screen.findByText('arranque del sistema')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Todos' })).toHaveAttribute('aria-selected', 'true');
  });

  it('muestra el vacío cuando no hay registros', async () => {
    render(<LogsView />);
    expect(await screen.findByText('Sin registros.')).toBeInTheDocument();
    expect(paginador()).toHaveTextContent('Página 1 de 1 · 0 registros');
  });

  it('cambia de pestaña pidiéndole la categoría al backend y vuelve a la página 1', async () => {
    traerLogsMock.mockResolvedValue(pagina([makeEvent({ id: 1, message: 'evento de dron' })], { total: 120 }));
    render(<LogsView />);
    await waitFor(() => expect(traerLogsMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    await waitFor(() => expect(traerLogsMock).toHaveBeenLastCalledWith({ category: '', page: 2, pageSize: 25 }));

    await userEvent.click(screen.getByRole('tab', { name: 'Usuarios' }));
    await waitFor(() =>
      expect(traerLogsMock).toHaveBeenLastCalledWith({ category: 'usuarios', page: 1, pageSize: 25 }),
    );
    expect(screen.getByRole('tab', { name: 'Usuarios' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('tab', { name: 'Drones' }));
    await waitFor(() => expect(traerLogsMock).toHaveBeenLastCalledWith({ category: 'drone', page: 1, pageSize: 25 }));
  });

  it('el selector de tamaño cambia el pageSize y vuelve a la página 1', async () => {
    traerLogsMock.mockResolvedValue(pagina([makeEvent()], { total: 300 }));
    render(<LogsView />);
    await waitFor(() => expect(traerLogsMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Última' }));
    await waitFor(() => expect(traerLogsMock).toHaveBeenLastCalledWith({ category: '', page: 12, pageSize: 25 }));

    await userEvent.selectOptions(screen.getByLabelText('Por página'), '100');
    await waitFor(() => expect(traerLogsMock).toHaveBeenLastCalledWith({ category: '', page: 1, pageSize: 100 }));
    expect(paginador()).toHaveTextContent('Página 1 de 3 · 300 registros');
  });

  it('pagina con primera, anterior, siguiente y última', async () => {
    traerLogsMock.mockResolvedValue(pagina([makeEvent()], { total: 120 }));
    render(<LogsView />);
    await waitFor(() => expect(traerLogsMock).toHaveBeenCalledTimes(1));

    expect(paginador()).toHaveTextContent('Página 1 de 5 · 120 registros');
    expect(screen.getByRole('button', { name: 'Primera' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Última' }));
    await waitFor(() => expect(paginador()).toHaveTextContent('Página 5 de 5'));
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Última' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Anterior' }));
    await waitFor(() => expect(traerLogsMock).toHaveBeenLastCalledWith({ category: '', page: 4, pageSize: 25 }));

    await userEvent.click(screen.getByRole('button', { name: 'Primera' }));
    await waitFor(() => expect(traerLogsMock).toHaveBeenLastCalledWith({ category: '', page: 1, pageSize: 25 }));
  });

  it('el ícono de actualizar repite el pedido y gira mientras carga', async () => {
    let liberar: (p: PaginaLogs) => void = () => {};
    traerLogsMock.mockImplementation(
      () =>
        new Promise<PaginaLogs>((resolver) => {
          liberar = resolver;
        }),
    );
    render(<LogsView />);

    const actualizar = screen.getByRole('button', { name: 'Actualizar' });
    expect(actualizar).toHaveClass('girando');
    await act(async () => liberar(pagina([])));
    expect(actualizar).not.toHaveClass('girando');

    await userEvent.click(actualizar);
    expect(actualizar).toHaveClass('girando');
    expect(traerLogsMock).toHaveBeenCalledTimes(2);
    await act(async () => liberar(pagina([])));
    expect(actualizar).not.toHaveClass('girando');
  });

  it('muestra el error del backend cuando el rol no alcanza', async () => {
    traerLogsMock.mockRejectedValue(new Error('Requiere rol admin'));
    render(<LogsView />);

    expect(await screen.findByText('No se pudo traer el registro: Requiere rol admin')).toBeInTheDocument();
    expect(screen.queryByText('Sin registros.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ver el detalle/ })).not.toBeInTheDocument();
  });

  it('un pedido fallido no le borra el contexto al paginador', async () => {
    traerLogsMock.mockResolvedValue(pagina([makeEvent()], { total: 200 }));
    render(<LogsView />);
    await waitFor(() => expect(traerLogsMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Última' }));
    await waitFor(() => expect(paginador()).toHaveTextContent('Página 8 de 8 · 200 registros'));

    // Se corta la red justo cuando se pide actualizar
    traerLogsMock.mockRejectedValue(new Error('Falló la base'));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByText('No se pudo traer el registro: Falló la base')).toBeInTheDocument();

    // Poner el total en cero dejaba "Página 1 de 1 · 0 registros" y "Anterior"
    // devolvía al principio del registro, sin forma de volver a donde estabas.
    expect(paginador()).toHaveTextContent('Página 8 de 8 · 200 registros');
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Anterior' }));
    await waitFor(() => expect(traerLogsMock).toHaveBeenLastCalledWith({ category: '', page: 7, pageSize: 25 }));
  });

  it('cada fila lleva la fecha además de la hora, y en castellano', async () => {
    traerLogsMock.mockResolvedValue(
      pagina([
        makeEvent({ id: 1, ts: '2024-01-04T15:30:00.000Z', message: 'el de enero' }),
        makeEvent({ id: 2, ts: '2024-08-04T15:30:00.000Z', message: 'el de agosto' }),
      ]),
    );
    render(<LogsView />);

    await screen.findByText('el de enero');
    const momentos = [...document.querySelectorAll('.log-row time')];
    expect(momentos).toHaveLength(2);
    for (const momento of momentos) {
      // El registro pagina el historial entero: sin la fecha, dos eventos a
      // meses de distancia se leían idénticos. Y nada de "3:30:00 PM".
      expect(momento.textContent).toMatch(/^\d{2}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2}$/);
    }
    expect(momentos[0].textContent).not.toBe(momentos[1].textContent);
    expect(momentos[0]).toHaveAttribute('dateTime', '2024-01-04T15:30:00.000Z');
  });

  it('abre el pop-up al clickear una fila y devuelve el foco al cerrarlo', async () => {
    traerLogsMock.mockResolvedValue(
      pagina([makeEvent({ id: 4, type: 'DRONE_UPDATED', message: 'se actualizó Alfa', meta: null })]),
    );
    render(<LogsView />);

    const fila = await screen.findByRole('button', { name: 'Ver el detalle de DRONE_UPDATED: se actualizó Alfa' });
    await userEvent.click(fila);

    const popup = screen.getByRole('dialog');
    expect(popup).toHaveAttribute('aria-modal', 'true');
    expect(popup).toHaveFocus();
    expect(screen.getByRole('heading', { name: 'se actualizó Alfa' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cerrar el detalle' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fila).toHaveFocus();
  });

  it('abre el pop-up con el teclado y lo cierra con Escape', async () => {
    traerLogsMock.mockResolvedValue(pagina([makeEvent({ id: 5, type: 'LOGIN', message: 'ingresó admin' })]));
    render(<LogsView />);

    const fila = await screen.findByRole('button', { name: 'Ver el detalle de LOGIN: ingresó admin' });
    fila.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fila).toHaveFocus();
  });

  it('abre el pop-up con la barra espaciadora e ignora las demás teclas', async () => {
    traerLogsMock.mockResolvedValue(pagina([makeEvent({ id: 7, type: 'LOGIN', message: 'ingresó admin' })]));
    render(<LogsView />);

    const fila = await screen.findByRole('button', { name: /Ver el detalle/ });
    fila.focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.keyboard(' ');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('descarta la respuesta de una pestaña que ya nadie está mirando', async () => {
    const pendientes: ((p: PaginaLogs) => void)[] = [];
    traerLogsMock.mockImplementation(
      () =>
        new Promise<PaginaLogs>((resolver) => {
          pendientes.push(resolver);
        }),
    );
    render(<LogsView />);
    await waitFor(() => expect(pendientes).toHaveLength(1));

    await userEvent.click(screen.getByRole('tab', { name: 'Sistema' }));
    await waitFor(() => expect(pendientes).toHaveLength(2));

    // La de "Todos" llega tarde, después de la de "Sistema": no puede pisarla.
    await act(async () => {
      pendientes[0](pagina([makeEvent({ id: 1, message: 'de la pestaña vieja' })]));
      pendientes[1](pagina([makeEvent({ id: 2, message: 'de la pestaña nueva' })]));
    });

    expect(screen.queryByText('de la pestaña vieja')).not.toBeInTheDocument();
    expect(screen.getByText('de la pestaña nueva')).toBeInTheDocument();
  });

  it('ya no muestra el JSON crudo del meta en la lista', async () => {
    traerLogsMock.mockResolvedValue(
      pagina([makeEvent({ id: 6, meta: JSON.stringify({ antes: { activo: true }, despues: { activo: false } }) })]),
    );
    render(<LogsView />);

    await screen.findByText('un evento');
    expect(screen.queryByText('antes / después')).not.toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('la primera carga es un esqueleto; cambiar de pestaña deja la lista de antes, apagada, hasta que llega la nueva', async () => {
    let liberar: (p: PaginaLogs) => void = () => {};
    traerLogsMock.mockImplementation(() => new Promise<PaginaLogs>((r) => (liberar = r)));
    render(<LogsView />);
    expect(screen.getByRole('status')).toHaveTextContent('Trayendo el registro…');
    expect(screen.queryByText('Sin registros.')).not.toBeInTheDocument();

    await act(async () => liberar(pagina([makeEvent({ id: 1, message: 'arranque del sistema' })])));
    const panel = screen.getByRole('tabpanel');
    expect(panel).not.toHaveAttribute('aria-busy');

    await userEvent.click(screen.getByRole('tab', { name: 'Usuarios' }));
    // Ni parpadeo de "sin registros" ni esqueleto: la lista sigue, ocupada.
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('arranque del sistema')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => liberar(pagina([])));
    expect(panel).not.toHaveAttribute('aria-busy');
    expect(screen.getByText('Sin registros.')).toBeInTheDocument();
  });

  it('el vacío dice qué va a aparecer acá', async () => {
    render(<LogsView />);
    expect(await screen.findByText(/va a quedar anotado acá/)).toBeInTheDocument();
  });

  it('el error se anuncia solo, como los de las otras vistas', async () => {
    traerLogsMock.mockRejectedValue(new Error('Requiere rol admin'));
    render(<LogsView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo traer el registro: Requiere rol admin');
  });

  it('la cabecera es la de todas las vistas, con el tamaño de página y actualizar a la derecha', () => {
    traerLogsMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<LogsView />);
    const cabecera = container.querySelector('.vista-cabecera') as HTMLElement;
    expect(cabecera).toContainElement(screen.getByRole('heading', { name: 'Registro del sistema' }));
    expect(cabecera.querySelector('.vista-opciones')).toContainElement(screen.getByLabelText('Por página'));
    expect(cabecera.querySelector('.vista-opciones')).toContainElement(screen.getByRole('button', { name: 'Actualizar' }));
    expect(screen.getByRole('tablist', { name: 'Categorías del registro' })).toBeInTheDocument();
  });
});


describe('LogsView — filtros en la cabecera', () => {
  beforeEach(() => {
    traerLogsMock.mockReset();
    traerLogsMock.mockResolvedValue(pagina([makeEvent({ id: 1, message: 'arranque del sistema', category: 'sistema' })]));
  });

  it('las categorías van al medio de la cabecera, donde las otras vistas tienen el buscador', async () => {
    const { container } = render(<LogsView />);
    await screen.findByText('arranque del sistema');
    const filtros = container.querySelector('.vista-cabecera .vista-filtros') as HTMLElement;
    expect(filtros).toContainElement(screen.getByRole('tablist', { name: 'Categorías del registro' }));
    // Y siguen gobernando su panel, aunque ya no estén pegadas a él.
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'pestania-todos');
    expect(screen.getByRole('tab', { name: 'Todos' })).toHaveAttribute('id', 'pestania-todos');
  });

  it('la categoría de cada evento es un sello, y la hora se lee con las cifras del cuerpo', async () => {
    const { container } = render(<LogsView />);
    await screen.findByText('arranque del sistema');
    expect(screen.getByText('Sistema', { selector: '.cat-badge' })).toHaveClass('cat-sistema');
    expect(container.querySelector('.log-row time')).not.toHaveClass('mono');
  });

  it('sin registros, el vacío lleva el medallón de la hoja', async () => {
    traerLogsMock.mockResolvedValue(pagina([]));
    const { container } = render(<LogsView />);
    await screen.findByText('Sin registros.');
    expect(container.querySelector('.con-medalla .medalla svg')).not.toBeNull();
  });
});
