import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, traerRutas } from '../api';
import { nombresDeBotones } from '../test/botones';
import { makeMe, makeRoute } from '../test/fixtures';
import { estadoMapa, fondosPuestos, limpiarEstadoMapa, pintarComoLeaflet } from '../test/dobleLeaflet';
import { ProveedorDeAvisos } from './AvisosFlotantes';
import RutasView from './RutasView';

vi.mock('../api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  api: vi.fn(),
  traerRutas: vi.fn(),
}));
vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());

const apiMock = vi.mocked(api);
const rutasMock = vi.mocked(traerRutas);
const ADMIN = makeMe({ username: 'admin1', role: 'admin' });
const OPERADOR = makeMe({ username: 'oper1', role: 'operator' });

function ruta(over: Partial<ReturnType<typeof makeRoute>> = {}) {
  return { ...makeRoute({ id: 1, name: 'Perímetro Norte' }), createdBy: 'admin1', deleted: false, deletedAt: null, ...over };
}

describe('RutasView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lista las rutas con su cantidad de nodos', async () => {
    rutasMock.mockResolvedValue([ruta(), ruta({ id: 2, name: 'Acceso Este' })]);
    render(<RutasView me={ADMIN} />);

    expect((await screen.findAllByText('Perímetro Norte')).length).toBeGreaterThan(0);
    expect(screen.getByText('Acceso Este')).toBeInTheDocument();
  });

  it('distingue "todavía no llegó" de "no hay ninguna"', async () => {
    let resolver: (v: never[]) => void = () => {};
    rutasMock.mockReturnValue(new Promise((r) => { resolver = r as (v: never[]) => void; }));
    render(<RutasView me={ADMIN} />);
    expect(screen.getByText(/trayendo las rutas/i)).toBeInTheDocument();
    resolver([]);
    expect(await screen.findByText(/todavía no hay rutas/i)).toBeInTheDocument();
  });

  it('el operador común mira pero no crea ni edita', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    render(<RutasView me={OPERADOR} />);
    await screen.findAllByText('Perímetro Norte');

    expect(screen.queryByRole('button', { name: /nueva ruta/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
  });

  it('el editor agrega nodos, los reordena y no guarda con menos de dos', async () => {
    rutasMock.mockResolvedValue([]);
    render(<RutasView me={ADMIN} />);
    await screen.findByText(/todavía no hay rutas/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva ruta/i }));

    const dialogo = screen.getByRole('dialog');
    const guardar = within(dialogo).getByRole('button', { name: /guardar ruta/i });
    expect(guardar).toBeDisabled();
    expect(within(dialogo).getByText(/todavía no hay nodos/i)).toBeInTheDocument();
    // sin nodos tampoco se puede repasar
    expect(within(dialogo).getByRole('button', { name: /repasar/i })).toBeDisabled();
  });

  it('editar una ruta precarga sus nodos y permite subir y bajar', async () => {
    const conNodos = ruta({
      waypoints: [
        { lat: 1, lon: 1, alt: 40, label: 'Uno' },
        { lat: 2, lon: 2, alt: 40, label: 'Dos' },
        { lat: 3, lon: 3, alt: 40, label: 'Tres' },
      ],
    });
    rutasMock.mockResolvedValue([conNodos]);
    apiMock.mockResolvedValue(conNodos);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));

    const dialogo = screen.getByRole('dialog');
    expect(within(dialogo).getByDisplayValue('Uno')).toBeInTheDocument();

    // bajar el primero lo deja segundo
    await userEvent.click(within(dialogo).getByRole('button', { name: /bajar el nodo 1/i }));
    const apodos = within(dialogo).getAllByLabelText(/apodo del nodo/i) as HTMLInputElement[];
    expect(apodos[0].value).toBe('Dos');
    expect(apodos[1].value).toBe('Uno');

    await userEvent.click(within(dialogo).getByRole('button', { name: /guardar ruta/i }));
    const cuerpo = JSON.parse(apiMock.mock.calls.at(-1)![1].body);
    expect(cuerpo.waypoints.map((w: { label?: string }) => w.label)).toEqual(['Dos', 'Uno', 'Tres']);
  });

  it('quitar un nodo lo saca de la lista', async () => {
    const conNodos = ruta({
      waypoints: [
        { lat: 1, lon: 1, alt: 40, label: 'Uno' },
        { lat: 2, lon: 2, alt: 40, label: 'Dos' },
      ],
    });
    rutasMock.mockResolvedValue([conNodos]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));

    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: /quitar el nodo 1/i }));
    expect(within(dialogo).queryByDisplayValue('Uno')).not.toBeInTheDocument();
    // con un solo nodo ya no se puede guardar
    expect(within(dialogo).getByRole('button', { name: /guardar ruta/i })).toBeDisabled();
  });

  it('eliminar una ruta pregunta antes y recién ahí pega al endpoint que corresponde', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    apiMock.mockResolvedValue(ruta());
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    // Antes era un solo clic, al lado de "Editar", sin vuelta atrás a la vista.
    const dialogo = await screen.findByRole('dialog', { name: 'Eliminar la ruta Perímetro Norte' });
    expect(dialogo).toHaveTextContent('deja de ofrecerse para empezar un patrullaje');
    expect(apiMock).not.toHaveBeenCalled();

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    expect(apiMock).toHaveBeenLastCalledWith('/routes/1', { method: 'DELETE' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancelar la pregunta no elimina la ruta', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('si el backend rechaza la baja, el motivo queda en la pregunta abierta', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    apiMock.mockRejectedValue(new Error('La ruta ya estaba eliminada'));
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    const dialogo = await screen.findByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('La ruta ya estaba eliminada');
  });

  it('el nombre de la ruta la elige también con el teclado', async () => {
    rutasMock.mockResolvedValue([ruta(), ruta({ id: 2, name: 'Acceso Este' })]);
    render(<RutasView me={ADMIN} />);
    const primera = (await screen.findAllByRole('button', { name: 'Perímetro Norte' }))[0];
    expect(primera).toHaveAttribute('aria-current', 'true');

    const segunda = screen.getByRole('button', { name: 'Acceso Este' });
    segunda.focus();
    await userEvent.keyboard('{Enter}');
    expect(segunda).toHaveAttribute('aria-current', 'true');
    expect(primera).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { name: 'Acceso Este' })).toBeInTheDocument();
  });

  it('muestra el error del backend', async () => {
    rutasMock.mockRejectedValue(new Error('sin permiso'));
    render(<RutasView me={ADMIN} />);
    expect(await screen.findByText(/sin permiso/)).toBeInTheDocument();
  });
});

describe('EditorDeRuta — repaso, edición de nodos y arrastre', () => {
  beforeEach(() => vi.clearAllMocks());

  const conTres = () => ruta({
    waypoints: [
      { lat: 1, lon: 1, alt: 40, label: 'Uno' },
      { lat: 2, lon: 2, alt: 40, label: 'Dos' },
      { lat: 3, lon: 3, alt: 40, label: 'Tres' },
    ],
  });

  async function abrirEditor() {
    rutasMock.mockResolvedValue([conTres()]);
    apiMock.mockResolvedValue(conTres());
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    return screen.getByRole('dialog');
  }

  it('el repaso enciende los nodos uno por uno y termina solo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const dialogo = await abrirEditor();

    await userEvent.click(within(dialogo).getByRole('button', { name: /repasar/i }));
    expect(within(dialogo).getByText(/nodo 1 de 3/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(1000);
    expect(within(dialogo).getByText(/nodo 2 de 3/i)).toBeInTheDocument();

    // al llegar al final vuelve solo a la instrucción normal
    await vi.advanceTimersByTimeAsync(3000);
    expect(within(dialogo).getByText(/hacé clic en el mapa/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('se puede editar el apodo y la altura de cada nodo', async () => {
    const dialogo = await abrirEditor();

    const apodo = within(dialogo).getAllByLabelText(/apodo del nodo/i)[0];
    await userEvent.clear(apodo);
    await userEvent.type(apodo, 'Portón nuevo');

    const alt = within(dialogo).getAllByLabelText(/altura del nodo/i)[0];
    await userEvent.clear(alt);
    await userEvent.type(alt, '75');

    await userEvent.click(within(dialogo).getByRole('button', { name: /guardar ruta/i }));
    const cuerpo = JSON.parse(apiMock.mock.calls.at(-1)![1].body);
    expect(cuerpo.waypoints[0]).toMatchObject({ label: 'Portón nuevo', alt: 75 });
  });

  it('una altura que no es número deja la anterior', async () => {
    const dialogo = await abrirEditor();
    const alt = within(dialogo).getAllByLabelText(/altura del nodo/i)[0];
    await userEvent.type(alt, 'alto');

    await userEvent.click(within(dialogo).getByRole('button', { name: /guardar ruta/i }));
    const cuerpo = JSON.parse(apiMock.mock.calls.at(-1)![1].body);
    // lo tecleado no es número: queda la altura que ya tenía
    expect(cuerpo.waypoints[0].alt).toBe(40);
  });

  it('arrastrar una fila la mueve de lugar', async () => {
    const dialogo = await abrirEditor();
    const filas = within(dialogo).getAllByRole('listitem');

    // se arrastra la tercera sobre la primera
    fireEvent.dragStart(filas[2]);
    fireEvent.dragOver(filas[0]);
    fireEvent.drop(filas[0]);

    const apodos = within(dialogo).getAllByLabelText(/apodo del nodo/i) as HTMLInputElement[];
    expect(apodos.map((i) => i.value)).toEqual(['Tres', 'Uno', 'Dos']);
  });

  it('el editor muestra el error del backend y no se cierra', async () => {
    rutasMock.mockResolvedValue([conTres()]);
    apiMock.mockRejectedValue(new Error('nombre duplicado'));
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));

    await userEvent.click(screen.getByRole('button', { name: /guardar ruta/i }));
    expect(await screen.findByText(/nombre duplicado/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('se cancela sin guardar', async () => {
    const dialogo = await abrirEditor();
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('con la ruta en viaje el editor no se deja cerrar, y al volver se cierra solo', async () => {
    const dialogo = await abrirEditor();
    let contestar: (r: unknown) => void = () => {};
    apiMock.mockReturnValue(new Promise((r) => (contestar = r)));

    await userEvent.click(within(dialogo).getByRole('button', { name: /guardar ruta/i }));
    // el pedido ya salió: cancelar no lo deshace, y cerrar dejaría que su
    // respuesta cierre otro editor que se abra en el medio
    expect(within(dialogo).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(within(dialogo).getByRole('button', { name: 'Cerrar' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Editar ruta' })).toBeInTheDocument();

    await act(async () => contestar(conTres()));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('si la ruta en viaje falla, se vuelve a poder cancelar', async () => {
    const dialogo = await abrirEditor();
    let fallar: (e: Error) => void = () => {};
    apiMock.mockReturnValue(new Promise((_, rechazar) => (fallar = rechazar)));

    await userEvent.click(within(dialogo).getByRole('button', { name: /guardar ruta/i }));
    await act(async () => fallar(new Error('nombre duplicado')));

    expect(within(dialogo).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('RutasView — el editor es un formulario y la lista, más prolija', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  const CAMPO = makeMe({ username: 'campo1', role: 'field_operator' });

  async function abrirNueva() {
    rutasMock.mockResolvedValue([]);
    render(<RutasView me={ADMIN} />);
    await screen.findByText(/todavía no hay rutas/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva ruta/i }));
    return screen.getByRole('dialog', { name: 'Nueva ruta de patrullaje' });
  }

  function clicEnElMapa(lat: number, lng: number) {
    act(() => estadoMapa.clic!({ latlng: { lat, lng } }));
  }

  it('el estado vacío dice cómo dibujar la primera', async () => {
    rutasMock.mockResolvedValue([]);
    render(<RutasView me={CAMPO} />);
    expect(await screen.findByText(/Con «Nueva ruta» marcás los nodos en el mapa/)).toBeInTheDocument();
  });

  it('al operador común el estado vacío no le ofrece dibujar', async () => {
    rutasMock.mockResolvedValue([]);
    render(<RutasView me={OPERADOR} />);
    expect(await screen.findByText(/Las rutas las dibujan los operadores de campo/)).toBeInTheDocument();
  });

  it('el foco arranca en el nombre de la ruta', async () => {
    const dialogo = await abrirNueva();
    expect(within(dialogo).getByLabelText('Nombre')).toHaveFocus();
  });

  it('el pie dice qué le falta a la ruta para poder guardarla', async () => {
    const dialogo = await abrirNueva();
    const nota = () => dialogo.querySelector('.pie-nota')?.textContent ?? '';

    expect(nota()).toBe('Faltan el nombre y los nodos: marcá al menos dos en el mapa.');
    clicEnElMapa(-34.9, -56.15);
    expect(nota()).toBe('Faltan el nombre y un nodo más en el mapa.');
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Perímetro');
    expect(nota()).toBe('Falta un nodo más: una ruta necesita al menos dos.');
    clicEnElMapa(-34.91, -56.16);
    expect(nota()).toBe('');
    expect(within(dialogo).getByRole('button', { name: /guardar ruta/i })).toBeEnabled();

    await userEvent.clear(within(dialogo).getByLabelText('Nombre'));
    expect(nota()).toBe('Falta el nombre de la ruta.');

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Perímetro');
    await userEvent.click(within(dialogo).getByRole('button', { name: /quitar el nodo 2/i }));
    await userEvent.click(within(dialogo).getByRole('button', { name: /quitar el nodo 1/i }));
    expect(nota()).toBe('Faltan los nodos: marcá al menos dos en el mapa.');
  });

  it('Enter en el nombre guarda la ruta, igual que el botón', async () => {
    apiMock.mockResolvedValue(ruta());
    const dialogo = await abrirNueva();
    clicEnElMapa(-34.9, -56.15);
    clicEnElMapa(-34.91, -56.16);

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Perímetro{Enter}');

    expect(apiMock).toHaveBeenCalledWith('/routes', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(apiMock.mock.calls.at(-1)![1].body).name).toBe('Perímetro');
  });

  it('una ruta incompleta no se manda aunque el navegador lo intente', async () => {
    const dialogo = await abrirNueva();
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Perímetro');

    fireEvent.submit(within(dialogo).getByLabelText('Nombre').closest('form')!);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('Escape cierra el editor sin guardar', async () => {
    const dialogo = await abrirNueva();
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'A medias');
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('editar dice cuál ruta se está editando', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));

    const dialogo = screen.getByRole('dialog', { name: 'Editar ruta' });
    expect(dialogo.querySelector('.modal-subtitulo')).toHaveTextContent('Perímetro Norte');
  });

  it('las acciones de cada fila van juntas: Editar y después Eliminar', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');

    const grupo = screen.getByRole('group', { name: 'Acciones de Perímetro Norte' });
    expect(nombresDeBotones(within(grupo).getAllByRole('button'))).toEqual(['Editar', 'Eliminar']);
  });

  it('una ruta eliminada sólo ofrece restaurarla', async () => {
    rutasMock.mockResolvedValue([ruta({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' })]);
    apiMock.mockResolvedValue(ruta());
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');

    const grupo = screen.getByRole('group', { name: 'Acciones de Perímetro Norte' });
    expect(nombresDeBotones(within(grupo).getAllByRole('button'))).toEqual(['Restaurar']);
    await userEvent.click(within(grupo).getByRole('button', { name: 'Restaurar' }));
    expect(apiMock).toHaveBeenLastCalledWith('/routes/1/restore', { method: 'POST' });
  });
});

describe('RutasView y su editor — mapa doble y lista de nodos rotulada', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  it('el mapa del recorrido arranca en callejero y se puede pasar a satélite', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');

    expect(fondosPuestos().some((u) => u.includes('openstreetmap'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Satélite' }));
    expect(fondosPuestos().some((u) => u.includes('World_Imagery'))).toBe(true);
  });

  it('el editor rotula el apodo y la altura, que si no es un 40 suelto', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);

    const editor = await screen.findByRole('dialog', { name: /editar/i });
    const encabezado = editor.querySelector('.nodos-encabezado') as HTMLElement;
    expect(within(encabezado).getByText('Apodo')).toBeInTheDocument();
    expect(within(encabezado).getByText('Altura (m)')).toBeInTheDocument();
    expect(within(encabezado).getByText('Coordenadas')).toBeInTheDocument();
  });

  it('desde el catálogo el editor no dibuja ninguna base: no se abrió desde una', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    await screen.findByRole('dialog', { name: /editar/i });

    expect(estadoMapa.puestas.filter((c) => c.clase === 'marker')).toHaveLength(0);
  });
});

/*
 * El apodo de un nodo lo escribe un operador (hasta 40 caracteres) y Leaflet
 * pinta las etiquetas con innerHTML. Pasado crudo, un `<img onerror>` corría en
 * la consola de cualquiera que abriera la ruta, admins incluidos.
 */
describe('RutasView y su editor — el apodo de un nodo se pinta como texto', () => {
  const MALICIOSO = '<img src=x onerror=alert(1)>';
  const conApodoMalicioso = () =>
    ruta({
      waypoints: [
        { lat: 1, lon: 1, alt: 40, label: MALICIOSO },
        { lat: 2, lon: 2, alt: 40 },
      ],
    });
  const etiquetasDeNodos = () =>
    estadoMapa.puestas.filter((c) => c.clase === 'circleMarker').map((c) => pintarComoLeaflet(c.etiqueta));

  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  it('en el mapa del recorrido', async () => {
    rutasMock.mockResolvedValue([conApodoMalicioso()]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');

    const [primera, segunda] = etiquetasDeNodos();
    expect(primera.querySelector('img')).toBeNull();
    expect(primera.textContent).toBe(`1 · ${MALICIOSO}`);
    expect(segunda.textContent).toBe('2');
  });

  it('en el editor', async () => {
    rutasMock.mockResolvedValue([conApodoMalicioso()]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    limpiarEstadoMapa();
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    await screen.findByRole('dialog', { name: 'Editar ruta' });

    const etiquetas = etiquetasDeNodos();
    expect(etiquetas.length).toBeGreaterThanOrEqual(2);
    for (const e of etiquetas) expect(e.children).toHaveLength(0);
    expect(etiquetas.map((e) => e.textContent)).toContain(`1 · ${MALICIOSO}`);
  });
});

describe('RutasView — avisos y carga', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limpiarEstadoMapa();
  });

  function montarConAvisos() {
    return render(
      <ProveedorDeAvisos>
        <RutasView me={ADMIN} />
      </ProveedorDeAvisos>,
    );
  }
  const aviso = () => document.querySelector('.avisos-flotantes') as HTMLElement;

  it('crear una ruta lo dice', async () => {
    rutasMock.mockResolvedValue([]);
    apiMock.mockResolvedValue(ruta());
    montarConAvisos();
    await screen.findByText(/todavía no hay rutas/i);
    await userEvent.click(screen.getByRole('button', { name: /nueva ruta/i }));
    const dialogo = screen.getByRole('dialog', { name: 'Nueva ruta de patrullaje' });
    act(() => estadoMapa.clic!({ latlng: { lat: -34.9, lng: -56.15 } }));
    act(() => estadoMapa.clic!({ latlng: { lat: -34.91, lng: -56.16 } }));
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Perímetro Sur');
    await userEvent.click(within(dialogo).getByRole('button', { name: /guardar ruta/i }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Ruta Perímetro Sur creada.'));
  });

  it('editar, eliminar y restaurar lo dicen', async () => {
    const conNodos = ruta({
      waypoints: [
        { lat: 1, lon: 1, alt: 40 },
        { lat: 2, lon: 2, alt: 40 },
      ],
    });
    rutasMock.mockResolvedValue([conNodos]);
    apiMock.mockResolvedValue(conNodos);
    montarConAvisos();
    await screen.findAllByText('Perímetro Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /guardar ruta/i }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Cambios de Perímetro Norte guardados.'));

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Ruta Perímetro Norte eliminada.'));

    rutasMock.mockResolvedValue([ruta({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Ver eliminadas' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restaurar' }));
    await waitFor(() => expect(aviso()).toHaveTextContent('Ruta Perímetro Norte restaurada.'));
  });

  it('si restaurar falla, el error queda arriba de la tabla y no se avisa nada', async () => {
    rutasMock.mockResolvedValue([ruta({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' })]);
    apiMock.mockRejectedValue(new Error('Ya existe una ruta con ese nombre'));
    montarConAvisos();
    await userEvent.click(await screen.findByRole('button', { name: 'Restaurar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya existe una ruta con ese nombre');
    expect(aviso()).toBeEmptyDOMElement();
  });

  it('la primera carga es un esqueleto; con la lista a la vista, recargar la marca ocupada', async () => {
    let contestar: (v: ReturnType<typeof ruta>[]) => void = () => {};
    rutasMock.mockReturnValueOnce(new Promise((r) => (contestar = r)));
    render(<RutasView me={ADMIN} />);
    expect(screen.getByRole('status')).toHaveClass('esqueleto');
    await act(async () => contestar([ruta()]));

    let recargar: (v: ReturnType<typeof ruta>[]) => void = () => {};
    rutasMock.mockReturnValueOnce(new Promise((r) => (recargar = r)));
    await userEvent.click(screen.getByRole('button', { name: 'Ver eliminadas' }));
    const envoltorio = screen.getByRole('list', { name: 'Rutas de patrullaje' });
    expect(envoltorio).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => recargar([ruta()]));
    expect(envoltorio).not.toHaveAttribute('aria-busy');
  });
});

describe('RutasView — catálogo en placas', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cada ruta es una placa con cuántos nodos tiene y su descripción; la elegida lleva el filo de oro', async () => {
    rutasMock.mockResolvedValue([
      ruta({ description: 'vuelta al predio' }),
      ruta({ id: 2, name: 'Acceso Este', description: '' }),
    ]);
    render(<RutasView me={ADMIN} />);
    const primera = (await screen.findAllByRole('button', { name: 'Perímetro Norte' }))[0];

    const placa = primera.closest('li') as HTMLElement;
    expect(placa).toHaveClass('ruta-item', 'seleccionada');
    expect(placa.querySelector('.ruta-item-detalle')).toHaveTextContent('2 nodos · vuelta al predio');
    const otra = screen.getByRole('button', { name: 'Acceso Este' }).closest('li') as HTMLElement;
    expect(otra).not.toHaveClass('seleccionada');
    expect(otra.querySelector('.ruta-item-detalle')?.textContent).toBe('2 nodos');

    // La placa entera responde al mouse, no sólo el nombre.
    await userEvent.click(otra);
    expect(otra).toHaveClass('seleccionada');
    expect(placa).not.toHaveClass('seleccionada');
  });

  it('la cabecera cuenta las rutas y sus nodos, sin las eliminadas', async () => {
    rutasMock.mockResolvedValue([
      ruta(),
      ruta({ id: 2, name: 'Acceso Este' }),
      ruta({ id: 3, name: 'Vieja', deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    const { container } = render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    expect(container.querySelector('.vista-subtitulo')).toHaveTextContent('2 rutas · 4 nodos');
  });

  it('una ruta eliminada se ve tachada en su placa', async () => {
    rutasMock.mockResolvedValue([ruta({ deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' })]);
    render(<RutasView me={ADMIN} />);
    const nombre = (await screen.findAllByRole('button', { name: 'Perímetro Norte' }))[0];
    expect(nombre.closest('li')).toHaveClass('eliminada');
  });

  it('subir, bajar y quitar un nodo son íconos con el nombre del nodo para el lector', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const dialogo = screen.getByRole('dialog', { name: 'Editar ruta' });
    for (const nombre of ['Subir el nodo 2', 'Bajar el nodo 1', 'Quitar el nodo 1']) {
      const boton = within(dialogo).getByRole('button', { name: nombre });
      expect(boton).toHaveClass('icono-boton', 'cuadrado');
      expect(boton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    expect(within(dialogo).getByRole('button', { name: 'Quitar el nodo 1' })).toHaveClass('dismiss');
  });
});
