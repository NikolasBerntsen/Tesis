import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LogDetailModal from './LogDetailModal';
import { api } from '../api';
import { makeAlert, makeEvent } from '../test/fixtures';

// Leaflet dibuja contra el DOM real (teselas, tamaños): en jsdom se lo reemplaza
// por un doble que registra las llamadas, que es lo único que se puede afirmar.
const leaflet = vi.hoisted(() => {
  const capa = { addTo: vi.fn(() => capa) };
  const mapa = {
    setView: vi.fn(() => mapa),
    getPane: vi.fn(() => document.createElement('div')),
    invalidateSize: vi.fn(),
    remove: vi.fn(),
    attributionControl: { setPrefix: vi.fn(), getContainer: vi.fn(() => document.createElement('div')) },
  };
  const L = {
    map: vi.fn(() => mapa),
    tileLayer: vi.fn(() => capa),
    marker: vi.fn(() => capa),
    circle: vi.fn(() => capa),
    divIcon: vi.fn(() => ({})),
  };
  return { L, mapa, capa };
});
vi.mock('leaflet', () => ({ default: leaflet.L }));

vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

function abrir(over: Parameters<typeof makeEvent>[0] = {}) {
  const cerrar = vi.fn();
  const fila = makeEvent(over);
  render(<LogDetailModal fila={fila} onCerrar={cerrar} />);
  return { cerrar, fila };
}

describe('LogDetailModal', () => {
  beforeEach(() => {
    apiMock.mockReset();
    leaflet.mapa.remove.mockClear();
    leaflet.L.map.mockClear();
    leaflet.L.circle.mockClear();
  });

  it('muestra la cabecera con mensaje, categoría, tipo, fecha completa y origen', () => {
    const { fila } = abrir({
      type: 'USER_UPDATED',
      category: 'usuarios',
      source: 'admin',
      message: 'admin cambió a oper1',
      ts: '2024-03-04T15:30:00.000Z',
    });

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'admin cambió a oper1' })).toBeInTheDocument();
    expect(screen.getByText('Usuarios')).toBeInTheDocument();
    expect(screen.getByText('USER_UPDATED')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    const momento = document.querySelector('time');
    expect(momento).toHaveAttribute('dateTime', fila.ts);
    expect(momento?.textContent).toMatch(/2024/);
  });

  it('compara antes y después resaltando sólo los campos que cambiaron', () => {
    abrir({
      type: 'DRONE_UPDATED',
      meta: JSON.stringify({
        antes: { displayName: 'Alfa', model: 'DJI Mini 3', activo: true },
        despues: { displayName: 'Alfa', model: 'DJI Air 3', activo: false },
      }),
    });

    expect(screen.getByText('Antes')).toBeInTheDocument();
    expect(screen.getByText('Después')).toBeInTheDocument();
    // El modelo cambió en las dos columnas; el nombre quedó igual en las dos.
    expect(screen.getByText('DJI Mini 3')).toHaveClass('cambiado');
    expect(screen.getByText('DJI Air 3')).toHaveClass('cambiado');
    for (const nombre of screen.getAllByText('Alfa')) expect(nombre).toHaveClass('sin-cambio');
    // Los booleanos se leen en castellano, no como true/false
    expect(screen.getByText('Sí')).toHaveClass('cambiado');
    expect(screen.getByText('No')).toHaveClass('cambiado');
  });

  it('lee las fechas ISO de la comparación en vez de mostrarlas crudas', () => {
    abrir({
      type: 'ALERT_VALIDATED',
      meta: JSON.stringify({
        antes: { estado: 'PENDING', decidedAt: null },
        despues: { estado: 'VALIDATED', decidedAt: '2026-08-11T13:41:30.000Z' },
      }),
    });

    expect(screen.queryByText('2026-08-11T13:41:30.000Z')).not.toBeInTheDocument();
    expect(screen.getByText(/^11\/8\/26/)).toHaveClass('cambiado');
    expect(screen.getByText('Pendiente')).toBeInTheDocument();
  });

  it('avisa cuando el evento trae antes/después idénticos', () => {
    abrir({ meta: JSON.stringify({ antes: { activo: true }, despues: { activo: true } }) });
    expect(screen.getByText('No cambió ningún campo.')).toBeInTheDocument();
  });

  it('lista el estado resultante cuando el evento sólo trae después', () => {
    abrir({
      type: 'USER_CREATED',
      category: 'usuarios',
      meta: JSON.stringify({ despues: { username: 'campo1', role: 'field_operator', canControl: false } }),
    });

    expect(screen.getByText('Estado resultante')).toBeInTheDocument();
    expect(screen.queryByText('Antes')).not.toBeInTheDocument();
    expect(screen.getByText('campo1')).toBeInTheDocument();
    // El rol se traduce; el nombre de usuario no, aunque coincida con un rol
    expect(screen.getByText('Operador de campo')).toBeInTheDocument();
  });

  it('dibuja el mini mapa con las coordenadas del emparejamiento y lo destruye al cerrarse', () => {
    const { unmount } = render(
      <LogDetailModal
        fila={makeEvent({
          type: 'DRONE_PAIRED',
          meta: JSON.stringify({
            por: 'campo1',
            dispositivo: 'Pixel 7',
            ubicacion: { lat: -34.857512, lon: -56.204533, accuracyM: 8.4 },
          }),
        })}
        onCerrar={vi.fn()}
      />,
    );

    expect(screen.getByTestId('mapa-ubicacion')).toBeInTheDocument();
    expect(leaflet.L.map).toHaveBeenCalledTimes(1);
    expect(leaflet.L.circle).toHaveBeenCalledWith([-34.857512, -56.204533], expect.objectContaining({ radius: 8.4 }));
    expect(screen.getByText(/-34\.857512, -56\.204533/)).toHaveTextContent('precisión ±8 m');
    expect(screen.getByText('campo1')).toBeInTheDocument();
    expect(screen.getByText('Pixel 7')).toBeInTheDocument();

    // Sin esto el mapa se queda con sus listeners colgados y pierde memoria
    unmount();
    expect(leaflet.mapa.remove).toHaveBeenCalledTimes(1);
  });

  it('trae la alerta y muestra la captura, el tipo y quién la resolvió', async () => {
    apiMock.mockResolvedValue(
      makeAlert({
        id: 7,
        type: 'PERSON',
        status: 'VALIDATED',
        snapshot: 'BASE64',
        decided_by: 'operador',
        decided_at: '2024-01-01T13:00:00.000Z',
      }),
    );
    abrir({
      type: 'ALERT_VALIDATED',
      alert_id: 7,
      meta: JSON.stringify({
        alerta: { id: 7, tipo: 'PERSON' },
        decision: 'VALIDATED',
        por: 'operador',
        drone: { hash: 'c54ae4a0aad98bdc6ae5ab810751335c', displayName: 'Alfa', model: 'DJI Mini 3' },
      }),
    });

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/alerts/7'));
    const captura = await screen.findByAltText('Captura de la detección');
    expect(captura).toHaveAttribute('src', 'data:image/jpeg;base64,BASE64');
    expect(screen.getByText('PERSONA')).toBeInTheDocument();
    expect(screen.getByText('-34.600000, -58.400000')).toBeInTheDocument();
    expect(screen.getByText(/Validada por operador/)).toBeInTheDocument();
    // La decisión también se lee en castellano en la cabecera del detalle
    expect(screen.getByText('Validada', { selector: 'dd' })).toBeInTheDocument();
  });

  it('avisa cuando la alerta no se puede traer, sin perder lo que guardó el evento', async () => {
    apiMock.mockRejectedValue(new Error('Alerta inexistente'));
    abrir({
      type: 'ALERT_CREATED',
      meta: JSON.stringify({ alerta: { id: 9, tipo: 'VEHICLE', lat: -34.6, lon: -58.4, ts: '2024-01-01T12:00:00.000Z' } }),
    });

    expect(await screen.findByText('No se pudo traer la alerta: Alerta inexistente')).toBeInTheDocument();
    expect(screen.getByText('VEHÍCULO')).toBeInTheDocument();
    expect(screen.getByText('-34.600000, -58.400000')).toBeInTheDocument();
    expect(screen.getByText('Sin resolver')).toBeInTheDocument();
  });

  it('avisa cuando la detección no dejó captura', async () => {
    apiMock.mockResolvedValue(makeAlert({ id: 3, snapshot: null }));
    abrir({ meta: JSON.stringify({ alerta: { id: 3, tipo: 'PERSON' } }) });

    expect(await screen.findByText('La detección no dejó captura.')).toBeInTheDocument();
    expect(screen.queryByAltText('Captura de la detección')).not.toBeInTheDocument();
  });

  it('muestra la ficha del dron con el hash abreviado y usa su nombre como origen', () => {
    abrir({
      source: 'c54ae4a0aad98bdc6ae5ab810751335c',
      meta: JSON.stringify({
        drone: { hash: 'c54ae4a0aad98bdc6ae5ab810751335c', displayName: 'Alfa', model: 'DJI Mini 3' },
      }),
    });

    expect(screen.getByText('c54ae4…335c')).toBeInTheDocument();
    expect(screen.queryByText('c54ae4a0aad98bdc6ae5ab810751335c')).not.toBeInTheDocument();
    // El origen de los eventos de dron es el hash: se muestra el nombre
    expect(screen.getAllByText('Alfa').length).toBeGreaterThan(0);
  });

  it('lista el detalle en clave/valor', () => {
    abrir({
      type: 'FIELD_SESSION_CLOSED',
      category: 'sistema',
      meta: JSON.stringify({ detalle: { por: 'campo1', motivo: 'emparejamiento completado' } }),
    });

    expect(screen.getByText('Detalle')).toBeInTheDocument();
    expect(screen.getByText('Motivo')).toBeInTheDocument();
    expect(screen.getByText('emparejamiento completado')).toBeInTheDocument();
  });

  it('no rompe con un meta nulo o roto', () => {
    const { unmount } = render(<LogDetailModal fila={makeEvent({ meta: 'no es json' })} onCerrar={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('Cambios')).not.toBeInTheDocument();
    unmount();

    render(<LogDetailModal fila={makeEvent({ meta: null })} onCerrar={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('mapa-ubicacion')).not.toBeInTheDocument();
  });

  it('pone guiones donde el evento no trajo dato y omite el círculo sin precisión', async () => {
    apiMock.mockResolvedValue(makeAlert({ id: 2, lat: null, lon: null, status: 'PENDING' }));
    abrir({
      ts: 'una fecha rota',
      source: '',
      meta: JSON.stringify({
        ubicacion: { lat: -34.9, lon: -56.2 },
        drone: { hash: 'corto', displayName: 'Alfa', model: '' },
        detalle: { nodo: 3, motivo: null },
        alerta: { id: 2, tipo: 'OTRO' },
      }),
    });

    // Sin exactitud del GPS no hay radio que dibujar, sólo el marcador
    expect(leaflet.L.circle).not.toHaveBeenCalled();
    expect(screen.getByText('-34.900000, -56.200000')).not.toHaveTextContent('precisión');
    // El hash corto (una base migrada) se muestra entero: no hay nada que abreviar
    expect(screen.getByText('corto')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(document.querySelector('time')).toHaveTextContent('una fecha rota');
    expect(await screen.findByText('OTRO')).toBeInTheDocument();
    // Origen, modelo, motivo y las coordenadas de la alerta quedan en guión
    expect(screen.getAllByText('—').length).toBe(4);
  });

  it('se cierra con la cruz, con el pie, con el velo y con Escape, pero no al tocar la caja', async () => {
    const { cerrar } = abrir();

    await userEvent.click(screen.getByRole('dialog'));
    expect(cerrar).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cerrar el detalle' }));
    expect(cerrar).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(cerrar).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole('dialog').parentElement!);
    expect(cerrar).toHaveBeenCalledTimes(3);

    await userEvent.keyboard('{Escape}');
    expect(cerrar).toHaveBeenCalledTimes(4);
  });

  it('mete el foco en el diálogo y no lo deja salir con el tabulador', async () => {
    abrir();
    expect(screen.getByRole('dialog')).toHaveFocus();

    const cruz = screen.getByRole('button', { name: 'Cerrar el detalle' });
    const pie = screen.getByRole('button', { name: 'Cerrar' });

    pie.focus();
    await userEvent.tab();
    expect(cruz).toHaveFocus();

    await userEvent.tab({ shift: true });
    expect(pie).toHaveFocus();
  });

  it('no rehace el mini mapa cuando el padre vuelve a renderizar', () => {
    const fila = makeEvent({
      type: 'DRONE_PAIRED',
      meta: JSON.stringify({ ubicacion: { lat: -34.857512, lon: -56.204533, accuracyM: 8.4 } }),
    });
    const { rerender } = render(<LogDetailModal fila={fila} onCerrar={vi.fn()} />);
    expect(leaflet.L.map).toHaveBeenCalledTimes(1);

    // La consola vuelca los status con un setInterval de 1 s y cada video_frame
    // suma otro render: el pop-up se re-renderiza con un `onCerrar` nuevo cada vez.
    for (let i = 0; i < 5; i++) rerender(<LogDetailModal fila={fila} onCerrar={vi.fn()} />);

    // Un mapa nuevo por render parpadea, descarta el arrastre del usuario y
    // repide las teselas a tile.openstreetmap.org sin parar.
    expect(leaflet.L.map).toHaveBeenCalledTimes(1);
    expect(leaflet.mapa.remove).not.toHaveBeenCalled();
  });

  it('no se cierra si el arrastre para seleccionar texto termina sobre el velo', async () => {
    const { cerrar } = abrir({ message: 'un mensaje largo para seleccionar' });
    const velo = screen.getByRole('dialog').parentElement!;
    const titulo = screen.getByRole('heading', { name: 'un mensaje largo para seleccionar' });

    // Apretar sobre el título, arrastrar para seleccionar y soltar un poco
    // afuera: el `click` se dispara en el velo, que es el ancestro común.
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: titulo },
      { target: velo },
      { keys: '[/MouseLeft]', target: velo },
    ]);

    expect(cerrar).not.toHaveBeenCalled();
  });

  it('devuelve el foco a la fila que lo abrió', async () => {
    const fila = document.createElement('div');
    fila.tabIndex = 0;
    document.body.appendChild(fila);
    fila.focus();

    const { unmount } = render(<LogDetailModal fila={makeEvent()} onCerrar={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveFocus();

    unmount();
    expect(fila).toHaveFocus();
    fila.remove();
  });
});
