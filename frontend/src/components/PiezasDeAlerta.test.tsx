import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ajustarDron } from '../api';
import { makeDrone } from '../test/fixtures';
import type { Drone } from '../types';
import { BotonesDeDecision, ConsecuenciasDeDecidir } from './PiezasDeAlerta';
import { ESPERA_PARA_GUARDAR_MS } from './useAjusteDelDron';

vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  ajustarDron: vi.fn(),
}));
const ajustarMock = vi.mocked(ajustarDron);

const ALFA = makeDrone({ droneId: 'd1', displayName: 'Alfa', silencioAlRetomarS: 10, reaccionADeteccion: null });

const engranaje = () => screen.getByRole('button', { name: 'Silencio al retomar' });
const globo = () => screen.getByRole('dialog', { name: 'Silencio al retomar · Alfa' });
const deslizador = () => screen.getByRole('slider', { name: 'Silencio al retomar' }) as HTMLInputElement;
const esperarGuardado = () => act(() => vi.advanceTimersByTimeAsync(ESPERA_PARA_GUARDAR_MS + 10));

function montar(dron: Drone | null = ALFA) {
  const onDecidir = vi.fn();
  const resultado = render(<BotonesDeDecision ocupado={false} dron={dron} onDecidir={onDecidir} />);
  return { ...resultado, onDecidir };
}

describe('BotonesDeDecision — el engranaje del silencio al retomar', () => {
  beforeEach(() => {
    ajustarMock.mockReset();
    ajustarMock.mockResolvedValue({});
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sin la ficha del dron no hay engranaje: el par queda solo y decide igual', () => {
    const { onDecidir } = montar(null);
    expect(screen.queryByRole('button', { name: 'Silencio al retomar' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onDecidir).toHaveBeenCalledWith('DISMISSED');
  });

  it('con la ficha, el engranaje va al lado de Descartar, dice el silencio vigente y abre el globo con el foco adentro', () => {
    montar();
    const boton = engranaje();
    expect(boton).toHaveAttribute('aria-expanded', 'false');
    expect(boton).toHaveAttribute('aria-haspopup', 'dialog');
    expect(boton).toHaveAttribute('title', 'Silencio al retomar: 10 s');
    expect(boton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // Después de Descartar, en el mismo renglón.
    const descartar = screen.getByRole('button', { name: 'Descartar' });
    expect(descartar.compareDocumentPosition(boton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(boton.parentElement).toBe(descartar.parentElement);

    fireEvent.click(boton);
    expect(boton).toHaveAttribute('aria-expanded', 'true');
    expect(boton).toHaveAttribute('aria-controls', globo().id);
    // No es modal: la decisión sigue a mano.
    expect(globo()).toHaveAttribute('aria-modal', 'false');
    expect(deslizador().value).toBe('10');
    expect(screen.getByTestId('silencio-al-retomar')).toHaveTextContent('10 s');
    expect(screen.getByText(/no se detiene por otra detección durante este tiempo/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar el silencio al retomar' })).toHaveFocus();
  });

  it('se cierra con la cruz (el foco vuelve al engranaje), con Esc y con un clic afuera', () => {
    montar();
    fireEvent.click(engranaje());
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar el silencio al retomar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(engranaje()).toHaveFocus();
    expect(engranaje()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(engranaje());
    // Esc se queda en el globo: lo de afuera (la campana, que también cierra
    // con Esc) no se entera, y se cierra de a uno por Esc.
    const afuera = vi.fn();
    document.addEventListener('keydown', afuera);
    fireEvent.keyDown(deslizador(), { key: 'Escape' });
    document.removeEventListener('keydown', afuera);
    expect(afuera).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(engranaje()).toHaveFocus();

    fireEvent.click(engranaje());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Un clic adentro no lo cierra.
    fireEvent.click(engranaje());
    fireEvent.mouseDown(deslizador());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Y el propio engranaje lo pliega.
    fireEvent.click(engranaje());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('mover el deslizador guarda el silencio del dron de ESA alerta, con la mano quieta, y el engranaje lo dice', async () => {
    montar();
    fireEvent.click(engranaje());
    fireEvent.change(deslizador(), { target: { value: '20' } });
    fireEvent.change(deslizador(), { target: { value: '25' } });
    expect(screen.getByTestId('silencio-al-retomar')).toHaveTextContent('25 s');
    expect(ajustarMock).not.toHaveBeenCalled();
    await esperarGuardado();
    expect(ajustarMock).toHaveBeenCalledTimes(1);
    expect(ajustarMock).toHaveBeenCalledWith('d1', { silencioAlRetomarS: 25 });
    expect(engranaje()).toHaveAttribute('title', 'Silencio al retomar: 25 s');
  });

  it('cerrar el globo con un cambio esperando su turno no lo pierde', async () => {
    montar();
    fireEvent.click(engranaje());
    fireEvent.change(deslizador(), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar el silencio al retomar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await esperarGuardado();
    expect(ajustarMock).toHaveBeenCalledWith('d1', { silencioAlRetomarS: 0 });
    expect(engranaje()).toHaveAttribute('title', 'Silencio al retomar: Sin silencio');
  });

  it('si la decisión se va (se decidió la alerta) con un cambio esperando, el cambio sale igual', () => {
    const { unmount } = montar();
    fireEvent.click(engranaje());
    fireEvent.change(deslizador(), { target: { value: '30' } });
    unmount();
    expect(ajustarMock).toHaveBeenCalledWith('d1', { silencioAlRetomarS: 30 });
  });

  it('«Volver a lo de fábrica» manda null en el acto; un rechazo se lee adentro y el deslizador vuelve', async () => {
    montar();
    fireEvent.click(engranaje());
    fireEvent.click(within(globo()).getByRole('button', { name: 'Volver a lo de fábrica (15 s)' }));
    await waitFor(() => expect(ajustarMock).toHaveBeenCalledWith('d1', { silencioAlRetomarS: null }));
    expect(deslizador().value).toBe('15');

    ajustarMock.mockRejectedValue(new Error('silencioAlRetomarS tiene que ir de a 5'));
    fireEvent.change(deslizador(), { target: { value: '5' } });
    await esperarGuardado();
    expect(await within(globo()).findByRole('alert')).toHaveTextContent('tiene que ir de a 5');
    expect(deslizador().value).toBe('10');
  });
});

describe('ConsecuenciasDeDecidir', () => {
  it('sin la ficha del dron dice lo de siempre', () => {
    render(<ConsecuenciasDeDecidir />);
    expect(screen.getByText(/Validar: el dron se queda sobre el objetivo hasta que lo mandes a patrullar\./)).toBeInTheDocument();
    expect(screen.getByText(/Descartar: retoma la ruta hacia el próximo nodo\./)).toBeInTheDocument();
  });

  it('con la ficha dice cómo sigue el dron según su reacción y cuánto calla al retomar', () => {
    render(<ConsecuenciasDeDecidir dron={makeDrone({ reaccionADeteccion: 'detenerse', silencioAlRetomarS: 30 })} />);
    expect(screen.getByText(/Validar: .*lo sigue vigilando desde donde está\./)).toBeInTheDocument();
    expect(screen.getByText(/Descartar: .*no se detiene por otra detección durante 30 s\./)).toBeInTheDocument();
  });

  it('con el silencio en cero lo dice: otra detección lo puede frenar enseguida', () => {
    render(<ConsecuenciasDeDecidir dron={makeDrone({ reaccionADeteccion: 'orbitar', silencioAlRetomarS: 0 })} />);
    expect(screen.getByText(/Validar: .*sigue orbitando el lugar\./)).toBeInTheDocument();
    expect(screen.getByText(/Descartar: .*sin silencio: otra detección lo puede frenar enseguida\./)).toBeInTheDocument();
  });
});
