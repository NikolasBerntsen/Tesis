import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { traerEmergencia } from '../api';
import { fechaHoraLarga } from '../format';
import { ContextoDeRelevosYEmergencias, SIN_OPERACION, type RelevosYEmergenciasEnVivo } from '../relevosYEmergencias';
import { estadoMapa, limpiarEstadoMapa } from '../test/dobleLeaflet';
import { makeEmergencia, makeFoto } from '../test/fixtures';
import type { Emergencia, EmergenciaConFotos, FotoDeEmergencia } from '../types';
import DetalleDeEmergencia from './DetalleDeEmergencia';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  traerEmergencia: vi.fn(),
}));
const traerMock = vi.mocked(traerEmergencia);

const ATERRIZADA: Partial<Emergencia> = {
  aterrizadaEn: '2026-10-23T15:04:30.100Z',
  aterrizajeLat: -34.87021,
  aterrizajeLon: -56.19018,
  aterrizajeAlt: 0.2,
};

const FOTOS: FotoDeEmergencia[] = [
  makeFoto({ seq: 0, tipo: 'oblicua', rumbo: 270, inclinacion: -70, jpegBase64: '/9j/CERO' }),
  makeFoto({ seq: 1, tipo: 'cenital', rumbo: 270, inclinacion: -90, jpegBase64: '/9j/UNO' }),
  makeFoto({ seq: 4, tipo: 'panoramica', rumbo: 180, inclinacion: -30, jpegBase64: '/9j/CUATRO' }),
];

function ficha(over: Partial<Emergencia> = {}, fotos: FotoDeEmergencia[] = FOTOS): EmergenciaConFotos {
  const { fotos: _cantidad, ...resto } = makeEmergencia({ ...ATERRIZADA, ...over });
  return { ...resto, fotos };
}

function consola(over: Partial<RelevosYEmergenciasEnVivo> = {}): RelevosYEmergenciasEnVivo {
  return {
    ...SIN_OPERACION,
    emergencias: [makeEmergencia({ ...ATERRIZADA, fotos: 3 })],
    abrirEmergencia: vi.fn(),
    marcarRecuperada: vi.fn(async (id: number) =>
      makeEmergencia({ id, ...ATERRIZADA, fotos: 3, recuperadaEn: '2026-10-23T15:40:00.000Z', recuperadaPor: 'campo1' }),
    ),
    ...over,
  };
}

function montar(props: Partial<Parameters<typeof DetalleDeEmergencia>[0]> = {}, vivo = consola()) {
  const envolver = (v: RelevosYEmergenciasEnVivo, hijo: ReactNode) => (
    <ContextoDeRelevosYEmergencias.Provider value={v}>{hijo}</ContextoDeRelevosYEmergencias.Provider>
  );
  const detalle = <DetalleDeEmergencia emergenciaId={3} {...props} />;
  const resultado = render(envolver(vivo, detalle));
  return { ...resultado, vivo, conConsola: (nueva: RelevosYEmergenciasEnVivo) => resultado.rerender(envolver(nueva, detalle)) };
}

/**
 * La fecha larga como la lee toHaveTextContent: el navegador separa la hora de
 * "p. m." con espacios finos, y el matcher los normaliza sólo en lo que recibe.
 */
function fecha(ts: string): string {
  return fechaHoraLarga(ts).replace(/\s+/g, ' ');
}

/** El valor de una fila de datos, buscado por su rótulo. */
function dato(rotulo: string): HTMLElement {
  return screen.getByText(rotulo, { selector: 'dt' }).nextElementSibling as HTMLElement;
}

function marcadores() {
  return estadoMapa.puestas.filter((c) => c.clase === 'marker' || c.clase === 'circleMarker');
}

describe('DetalleDeEmergencia', () => {
  beforeEach(() => {
    traerMock.mockReset();
    limpiarEstadoMapa();
  });

  it('pide la ficha y muestra fotos, mapa, coordenadas y datos del aterrizaje', async () => {
    traerMock.mockResolvedValue(ficha());
    montar({ conTitulo: false });

    expect(traerMock).toHaveBeenCalledWith(3);
    expect(screen.getByText('Trayendo la ficha…')).toBeInTheDocument();
    const galeria = await screen.findByTestId('galeria-emergencia');
    expect(screen.queryByText('Trayendo la ficha…')).not.toBeInTheDocument();

    // La foto grande es la primera, con su pie: tipo, rumbo e inclinación.
    const principal = within(galeria).getByRole('img', { name: /^Foto 1 del lugar/ });
    expect(principal).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/CERO');
    expect(galeria.querySelector('figcaption')).toHaveTextContent(
      'Foto 1 de 3 Oblicua · rumbo 270° O · inclinación −70° · a 38 m de altura',
    );
    expect(within(galeria).getAllByRole('button', { name: /^Ver la foto/ })).toHaveLength(3);

    // El mapa: dónde tocó tierra (la gota) y dónde arrancó (el aro).
    expect(screen.getByTestId('leyenda-mapa-emergencia')).toHaveTextContent('Donde tocó tierraDonde arrancó el protocolo');
    const [aro, gota] = marcadores();
    expect(aro).toMatchObject({ clase: 'circleMarker', latlng: [-34.8702, -56.1902], etiqueta: 'Donde arrancó el protocolo' });
    expect(gota).toMatchObject({ clase: 'marker', latlng: [-34.87021, -56.19018], etiqueta: 'Donde tocó tierra' });
    expect(estadoMapa.encuadres).toHaveLength(1);

    expect(dato('Situación')).toHaveTextContent('En tierra, sin recuperar');
    expect(dato('Dron')).toHaveTextContent('Alfa');
    expect(dato('Motivo')).toHaveTextContent('No le alcanzaba la batería para volver');
    expect(dato('Comenzó')).toHaveTextContent(fecha('2026-10-23T15:04:05.300Z'));
    expect(dato('Al comenzar')).toHaveTextContent('batería 9 % · a 38 m de altura');
    expect(dato('Tocó tierra')).toHaveTextContent(fecha('2026-10-23T15:04:30.100Z'));
    expect(screen.getByTestId('coordenadas-emergencia')).toHaveTextContent('-34.870210, -56.190180');
    expect(screen.getByRole('button', { name: 'Copiar las coordenadas del dron' })).toBeInTheDocument();
    expect(dato('Recuperado')).toHaveTextContent('Todavía no');
    expect(screen.getByRole('button', { name: 'Marcar como recuperado' })).toBeInTheDocument();
  });

  it('habla como el pop-up de una alerta: la foto en el visor con escuadras, los datos al lado', async () => {
    traerMock.mockResolvedValue(ficha());
    const { container } = montar({ conTitulo: false });
    const galeria = await screen.findByTestId('galeria-emergencia');

    // La foto grande va en el visor negro, con su pie de visor; las miniaturas, en visores chicos.
    const principal = within(galeria).getByRole('img', { name: /^Foto 1 del lugar/ });
    expect(principal.closest('.visor-cuadro')?.parentElement).toHaveClass('visor', 'galeria-principal');
    expect(galeria.querySelector('figcaption')).toHaveClass('visor-pie');
    for (const miniatura of within(galeria).getAllByRole('button', { name: /^Ver la foto/ })) {
      expect(miniatura.querySelector('.visor-cuadro img')).not.toBeNull();
    }

    // Las fotos y el mapa a un lado; lo que se lee y se hace, al otro.
    const vistas = container.querySelector('.detalle-alerta-cuerpo > .detalle-alerta-vistas') as HTMLElement;
    const datos = container.querySelector('.detalle-alerta-cuerpo > .detalle-alerta-datos') as HTMLElement;
    expect(vistas).toContainElement(galeria);
    expect(vistas).toContainElement(screen.getByTestId('mapa-emergencia'));
    expect(within(datos).getByText('EMERGENCIA')).toHaveClass('chip', 'rojo');
    expect(within(datos).getByText('Alfa', { selector: '.chip' })).toHaveClass('chip', 'oro');
    expect(within(datos).getByText('En tierra, sin recuperar')).toHaveClass('estado', 'pastilla', 'bad');

    // «Marcar como recuperado» es la acción dorada, con su tilde.
    const marcar = within(datos).getByRole('button', { name: 'Marcar como recuperado' });
    expect(marcar).toHaveClass('primario');
    expect(marcar.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('las miniaturas cambian la foto grande', async () => {
    traerMock.mockResolvedValue(ficha());
    montar();
    const galeria = await screen.findByTestId('galeria-emergencia');
    const panoramica = within(galeria).getByRole('button', { name: /^Ver la foto 3: Panorámica/ });
    expect(panoramica).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(panoramica);
    expect(panoramica).toHaveAttribute('aria-pressed', 'true');
    expect(within(galeria).getByRole('img', { name: /^Foto 3 del lugar/ })).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,/9j/CUATRO',
    );
  });

  it('suma las fotos que llegan en vivo, sin repetir las que ya trajo', async () => {
    traerMock.mockResolvedValue(ficha({}, [FOTOS[0]]));
    const vivo = consola({ emergencias: [makeEmergencia({ ...ATERRIZADA, fotos: 1 })] });
    const { conConsola } = montar({}, vivo);
    await screen.findByTestId('galeria-emergencia');
    expect(screen.queryAllByRole('button', { name: /^Ver la foto/ })).toHaveLength(0);

    conConsola({
      ...vivo,
      emergencias: [makeEmergencia({ ...ATERRIZADA, fotos: 2 })],
      fotos: { 3: [FOTOS[0], FOTOS[2]] },
    });
    expect(screen.getAllByRole('button', { name: /^Ver la foto/ })).toHaveLength(2);
    expect(traerMock).toHaveBeenCalledTimes(1);
  });

  it('si la consola sabe de más fotos que las que hay, vuelve a pedir la ficha una sola vez', async () => {
    traerMock.mockResolvedValueOnce(ficha({}, [])).mockResolvedValueOnce(ficha({}, [FOTOS[0], FOTOS[1]]));
    montar();
    // La primera respuesta no trae ninguna, y la consola dice que hay tres.
    expect(await screen.findByText('Foto 1 de 3', { exact: false })).toBeInTheDocument();
    expect(traerMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('button', { name: /^Ver la foto/ })).toHaveLength(2);
    // Con dos de tres no se queda pidiendo en un lazo.
    await act(async () => {});
    expect(traerMock).toHaveBeenCalledTimes(2);
  });

  it('sin fotos todavía lo dice, distinto si se sabe que vienen en camino', async () => {
    traerMock.mockResolvedValue(ficha({}, []));
    const { unmount } = montar({}, consola({ emergencias: [] }));
    expect(await screen.findByText('Todavía no llegó ninguna foto del dron.')).toBeInTheDocument();
    unmount();

    traerMock.mockResolvedValue(ficha({}, []));
    montar({}, consola({ emergencias: [makeEmergencia({ ...ATERRIZADA, fotos: 2 })] }));
    expect(await screen.findByText('Las fotos todavía están llegando.')).toBeInTheDocument();
  });

  it('marcar como recuperado pregunta antes, y al confirmar la ficha lo dice', async () => {
    traerMock.mockResolvedValue(ficha());
    const { vivo } = montar({ conTitulo: false });
    await screen.findByTestId('galeria-emergencia');

    await userEvent.click(screen.getByRole('button', { name: 'Marcar como recuperado' }));
    const dialogo = screen.getByRole('dialog', { name: 'Marcar Alfa como recuperado' });
    expect(dialogo).toHaveTextContent('La emergencia se cierra y el aviso deja de verse en todas las consolas.');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Marcar como recuperado' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(vivo.marcarRecuperada).toHaveBeenCalledWith(3);
    // La consola de este test no cambia: es la ficha la que se puso al día.
    expect(dato('Recuperado')).toHaveTextContent(`Por campo1 · ${fecha('2026-10-23T15:40:00.000Z')}`);
    expect(dato('Situación')).toHaveTextContent('Recuperado');
    expect(screen.queryByRole('button', { name: 'Marcar como recuperado' })).not.toBeInTheDocument();
  });

  it('si el backend no deja marcarla, el motivo se lee en el diálogo, que sigue abierto', async () => {
    traerMock.mockResolvedValue(ficha());
    const vivo = consola({
      marcarRecuperada: vi.fn(async () => {
        throw new Error('Otra persona ya la marcó como recuperada: la ficha se actualiza sola.');
      }),
    });
    montar({}, vivo);
    await screen.findByTestId('galeria-emergencia');
    await userEvent.click(screen.getByRole('button', { name: 'Marcar como recuperado' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Marcar como recuperado' }));

    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('Otra persona ya la marcó como recuperada');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('marcarla con la ficha caída igual se puede: la consola la tiene', async () => {
    traerMock.mockRejectedValue(new Error('sin red'));
    const { vivo } = montar();
    expect(await screen.findByText('No se pudo traer la ficha completa: sin red')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Marcar como recuperado' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Marcar como recuperado' }));
    await waitFor(() => expect(vivo.marcarRecuperada).toHaveBeenCalledWith(3));
  });

  it('sin la ficha ni la consola, muestra lo que guardó el evento', async () => {
    traerMock.mockRejectedValue('caído');
    montar(
      { referencia: { id: 3, motivo: 'bateria_critica_dji', lat: -34.9, lon: -56.2, ts: '2026-10-23T15:04:05.300Z' } },
      SIN_OPERACION,
    );
    expect(await screen.findByText('No se pudo traer la ficha completa: caído')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Aterrizaje de emergencia #3' })).toBeInTheDocument();
    expect(dato('Motivo')).toHaveTextContent('Batería crítica: el propio DJI forzó el aterrizaje');
    expect(dato('Comenzó')).toHaveTextContent(fecha('2026-10-23T15:04:05.300Z'));
    expect(dato('Dron')).toHaveTextContent('—');
    expect(dato('Última posición')).toHaveTextContent('-34.900000, -56.200000');
    expect(dato('Última posición')).toHaveTextContent('todavía no informó dónde tocó tierra');
    expect(screen.getByText('Todavía no llegó ninguna foto del dron.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Marcar como recuperado' })).not.toBeInTheDocument();
  });

  it('una referencia sin posición ni motivo deja las rayas, y no hay mapa', async () => {
    traerMock.mockRejectedValue(new Error('x'));
    montar({ referencia: { id: 3, motivo: '', lat: null, lon: null, ts: null } }, SIN_OPERACION);
    expect(await screen.findByText('El dron no informó su posición: no hay un punto que mostrar.')).toBeInTheDocument();
    expect(dato('Motivo')).toHaveTextContent('—');
    expect(dato('Comenzó')).toHaveTextContent('—');
    expect(dato('Última posición')).toHaveTextContent('Sin posición');
    expect(screen.queryByTestId('mapa-emergencia')).not.toBeInTheDocument();
  });

  it('fuera de la consola la ficha se ve entera pero no ofrece marcarla', async () => {
    traerMock.mockResolvedValue(ficha());
    montar({}, SIN_OPERACION);
    await screen.findByTestId('galeria-emergencia');
    expect(screen.getByText('En tierra, sin recuperar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Marcar como recuperado' })).not.toBeInTheDocument();
  });

  it('mientras baja: la última posición es la del disparo, en un solo punto, y sin aterrizaje', async () => {
    traerMock.mockResolvedValue(ficha({ aterrizadaEn: null, aterrizajeLat: null, aterrizajeLon: null, aterrizajeAlt: null }));
    montar({}, consola({ emergencias: [] }));
    expect(await screen.findByText('Aterrizando')).toBeInTheDocument();
    expect(dato('Tocó tierra')).toHaveTextContent('Todavía no confirmó el aterrizaje');
    expect(dato('Última posición')).toHaveTextContent('-34.870200, -56.190200');
    expect(screen.getByTestId('leyenda-mapa-emergencia')).toHaveTextContent('Última posición');
    expect(marcadores()).toHaveLength(1);
    expect(marcadores()[0]).toMatchObject({ clase: 'marker', etiqueta: 'Última posición' });
    expect(estadoMapa.encuadres).toHaveLength(0);
  });

  it('cuando el dron toca tierra con la ficha abierta, el mapa suma el punto y encuadra los dos', async () => {
    const bajando = makeEmergencia({ fotos: 3 });
    traerMock.mockResolvedValue(ficha({ aterrizadaEn: null, aterrizajeLat: null, aterrizajeLon: null }));
    const { conConsola, vivo } = montar({}, consola({ emergencias: [bajando] }));
    await screen.findByTestId('galeria-emergencia');
    expect(estadoMapa.encuadres).toHaveLength(0);

    conConsola({ ...vivo, emergencias: [makeEmergencia({ ...ATERRIZADA, fotos: 3 })] });
    expect(estadoMapa.encuadres).toHaveLength(1);
    expect(estadoMapa.mapasCreados).toBe(1);
    expect(dato('Dónde quedó')).toHaveTextContent('-34.870210, -56.190180');
  });

  it('una ya recuperada dice quién y cuándo, y no ofrece el botón', async () => {
    traerMock.mockResolvedValue(ficha({ recuperadaEn: '2026-10-23T15:40:00.000Z', recuperadaPor: null }));
    montar({}, consola({ emergencias: [] }));
    expect(await screen.findByText('Recuperado', { selector: '.estado' })).toBeInTheDocument();
    expect(dato('Recuperado')).toHaveTextContent('Por —');
    expect(screen.queryByRole('button', { name: 'Marcar como recuperado' })).not.toBeInTheDocument();
  });

  it('una batería o una altura que no son números se leen como raya, y sin nombre el título no inventa uno', async () => {
    traerMock.mockResolvedValue(ficha({ displayName: '', bateria: Number.NaN, alt: Number.NaN }));
    montar({}, consola({ emergencias: [] }));
    await screen.findByTestId('galeria-emergencia');
    expect(dato('Al comenzar')).toHaveTextContent('batería — · altura —');
    await userEvent.click(screen.getByRole('button', { name: 'Marcar como recuperado' }));
    expect(screen.getByRole('dialog', { name: 'Marcar el dron como recuperado' })).toBeInTheDocument();
  });

  it('una respuesta que llega con la ficha ya cerrada no se aplica', async () => {
    let resolver: (f: EmergenciaConFotos) => void = () => {};
    traerMock.mockReturnValueOnce(new Promise((r) => (resolver = r)));
    const { unmount } = montar();
    unmount();
    await act(async () => resolver(ficha()));

    let rechazar: (e: Error) => void = () => {};
    traerMock.mockReturnValueOnce(new Promise((_r, j) => (rechazar = j)));
    const segunda = montar();
    segunda.unmount();
    await act(async () => rechazar(new Error('tarde')));
    expect(screen.queryByText(/tarde/)).not.toBeInTheDocument();
  });
});
