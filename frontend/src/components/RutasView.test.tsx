import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, traerRutas } from '../api';
import { makeMe, makeRoute } from '../test/fixtures';
import { estadoMapa, fondosPuestos, limpiarEstadoMapa } from '../test/dobleLeaflet';
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
  return { ...makeRoute({ id: 1, name: 'Perímetro Norte' }), createdBy: 'admin1', deletedAt: null, ...over };
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

  it('eliminar una ruta pega al endpoint que corresponde', async () => {
    rutasMock.mockResolvedValue([ruta()]);
    apiMock.mockResolvedValue(ruta());
    render(<RutasView me={ADMIN} />);
    await screen.findAllByText('Perímetro Norte');

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(apiMock).toHaveBeenLastCalledWith('/routes/1', { method: 'DELETE' });
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
