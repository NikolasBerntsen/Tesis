import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvisoDelControl, PedidoDeControl } from '../control';
import AvisosDelControl, { AVISO_EN_VUELO_MS } from './AvisosDelControl';
import { ProveedorDeCapaDePilotaje, useAnotarCapaDePilotaje } from './CapaDePilotaje';
import { EJES_EN_CERO, type Ejes } from './MandoVirtual';
import Modal from './Modal';
import { useTecladoDeVuelo } from './useTecladoDeVuelo';

// Los avisos del control manual: el pedido que le llega a quien vuela (con su
// cuenta regresiva y sus dos respuestas), la espera del que lo pidió y cómo
// terminó. Lo que más importa es lo que NO hacen: no se llevan el foco ni las
// teclas de vuelo de alguien que está piloteando, salvo que vaya a ellos.

const nombreDe = (droneId: string) => (droneId === 'd1' ? 'Alfa' : droneId);

function pedido(over: Partial<PedidoDeControl> = {}): PedidoDeControl {
  return { droneId: 'd1', solicitante: 'relevo', titular: 'piloto', venceEnMs: Date.now() + 10_000, ...over };
}

function montar({
  yo = 'piloto',
  pedidos = [pedido()],
  avisos = [] as AvisoDelControl[],
  onContestar = vi.fn(async () => {}),
  onCancelar = vi.fn(async () => {}),
  onDescartar = vi.fn(),
}: {
  yo?: string;
  pedidos?: PedidoDeControl[];
  avisos?: AvisoDelControl[];
  onContestar?: (droneId: string, respuesta: 'ceder' | 'mantener') => Promise<void>;
  onCancelar?: (droneId: string) => Promise<void>;
  onDescartar?: (id: number) => void;
} = {}) {
  render(
    <>
      <button type="button">Algo de la página</button>
      <AvisosDelControl
        yo={yo}
        pedidos={pedidos}
        nombreDe={nombreDe}
        avisos={avisos}
        onContestar={onContestar}
        onCancelar={onCancelar}
        onDescartar={onDescartar}
      />
    </>,
  );
  return { onContestar, onCancelar, onDescartar };
}

/** Deja correr el reloj falso y los renders que dispara. */
function pasar(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AvisosDelControl — el pedido al que tiene el control', () => {
  it('dice quién lo pide y de qué dron, cuenta su plazo y se va solo un segundo antes de que venza en el hub', () => {
    montar();
    const algo = screen.getByRole('button', { name: 'Algo de la página' });
    const aviso = screen.getByTestId('pedido-al-titular');
    expect(within(aviso).getByRole('heading', { name: 'relevo quiere tomar el control' })).toBeInTheDocument();
    expect(aviso).toHaveTextContent('Le pidió a la consola el control de Alfa');
    expect(aviso).toHaveTextContent('si lo estás volando a mano, el dron queda quieto donde está');
    // De los 10 s del hub se resta el margen del titular (MARGEN_DEL_TITULAR_MS).
    expect(screen.getByTestId('cuenta-regresiva')).toHaveTextContent('9 s');
    // el plazo, una vez, para el lector de pantalla: la cuenta va oculta
    expect(screen.getByTestId('cuenta-regresiva')).toHaveAttribute('aria-hidden', 'true');
    expect(aviso).toHaveTextContent('Tenés 9 segundos para contestar.');
    expect(algo).not.toHaveFocus();

    pasar(3_000);
    expect(screen.getByTestId('cuenta-regresiva')).toHaveTextContent('6 s');
    // con la pantalla en «1 s» todavía se contesta, y al llegar al margen ya no:
    // una respuesta que sale ahí le llegaría al hub vencida
    pasar(5_999);
    expect(screen.getByTestId('cuenta-regresiva')).toHaveTextContent('1 s');
    pasar(1);
    expect(screen.queryByTestId('pedido-al-titular')).not.toBeInTheDocument();
  });

  it('en modo mouse suelta el puntero al aparecer: si no, sus botones no se podrían apretar', () => {
    const salir = vi.fn();
    const capturado = document.createElement('section');
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => capturado });
    Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: salir });
    try {
      montar();
      expect(salir).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => null });
    }
    // sin captura no hay nada que soltar
    montar({ pedidos: [pedido({ droneId: 'd2' })] });
    expect(salir).toHaveBeenCalledTimes(1);
  });

  it('si el navegador no deja soltar el puntero, el aviso sale igual', () => {
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.body });
    Object.defineProperty(document, 'exitPointerLock', {
      configurable: true,
      value: () => {
        throw new Error('no ahora');
      },
    });
    try {
      montar();
      expect(screen.getByTestId('pedido-al-titular')).toBeInTheDocument();
    } finally {
      Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => null });
    }
  });

  it('no se lleva el foco: el que vuela sigue con el teclado donde lo tenía', () => {
    render(<button type="button">Volar</button>);
    const volar = screen.getByRole('button', { name: 'Volar' });
    volar.focus();
    montar();
    expect(volar).toHaveFocus();
  });

  it('«Mantener el control» va primero; cada botón contesta lo suyo', async () => {
    const { onContestar } = montar();
    const botones = within(screen.getByTestId('pedido-al-titular')).getAllByRole('button');
    expect(botones.map((b) => b.textContent)).toEqual(['Mantener el control', 'Ceder el control']);
    await act(async () => {
      fireEvent.click(botones[1]);
    });
    expect(onContestar).toHaveBeenCalledWith('d1', 'ceder');
    await act(async () => {
      fireEvent.click(botones[0]);
    });
    expect(onContestar).toHaveBeenLastCalledWith('d1', 'mantener');
  });

  it('una respuesta en viaje no sale dos veces, ni con Escape', async () => {
    let terminar: () => void = () => {};
    const onContestar = vi.fn(() => new Promise<void>((resolver) => (terminar = resolver)));
    montar({ onContestar });
    const mantener = screen.getByRole('button', { name: 'Mantener el control' });
    mantener.focus();
    fireEvent.keyDown(mantener, { key: 'Escape', code: 'Escape' });
    fireEvent.keyDown(mantener, { key: 'Escape', code: 'Escape' });
    expect(onContestar).toHaveBeenCalledTimes(1);
    await act(async () => terminar());
  });

  it('una respuesta rechazada deja el motivo a la vista y los botones vuelven a andar', async () => {
    const onContestar = vi.fn(async () => {
      throw new Error('No hay ningún pedido de control pendiente para este dron');
    });
    montar({ onContestar });
    fireEvent.click(screen.getByRole('button', { name: 'Mantener el control' }));
    expect(screen.getByRole('button', { name: 'Ceder el control' })).toBeDisabled();
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('No hay ningún pedido de control pendiente');
    expect(screen.getByRole('button', { name: 'Ceder el control' })).toBeEnabled();
  });

  it('con el foco adentro: las teclas de vuelo no vuelan, Escape mantiene y la tecla soltada de afuera llega', async () => {
    const { onContestar } = montar();
    const apretadas: string[] = [];
    const soltadas: string[] = [];
    const alApretar = (ev: KeyboardEvent) => apretadas.push(ev.code || ev.key);
    const alSoltar = (ev: KeyboardEvent) => soltadas.push(ev.code);
    window.addEventListener('keydown', alApretar);
    window.addEventListener('keyup', alSoltar);
    try {
      const ceder = screen.getByRole('button', { name: 'Ceder el control' });
      ceder.focus();
      // W y Espacio apretadas con el foco en el aviso son de los botones
      fireEvent.keyDown(ceder, { code: 'KeyW' });
      fireEvent.keyUp(ceder, { code: 'KeyW' });
      fireEvent.keyDown(ceder, { code: 'Space', key: ' ' });
      fireEvent.keyUp(ceder, { code: 'Space', key: ' ' });
      expect(apretadas).toEqual([]);
      expect(soltadas).toEqual([]);
      // la S se apretó antes de entrar al aviso: su soltada tiene que llegar
      // al teclado de vuelo, o el dron seguiría yendo para atrás
      fireEvent.keyUp(ceder, { code: 'KeyS' });
      expect(soltadas).toEqual(['KeyS']);
      // lo que no es de vuelo sigue de largo (el tabulador, Enter)
      fireEvent.keyDown(ceder, { code: 'Tab', key: 'Tab' });
      expect(apretadas).toEqual(['Tab']);

      await act(async () => {
        fireEvent.keyDown(ceder, { key: 'Escape', code: 'Escape' });
      });
      expect(onContestar).toHaveBeenCalledWith('d1', 'mantener');
      expect(apretadas).toEqual(['Tab']);
    } finally {
      window.removeEventListener('keydown', alApretar);
      window.removeEventListener('keyup', alSoltar);
    }
  });

  it('una tecla de vuelo sostenida desde afuera no se traba: su repetición adentro no le come la soltada', () => {
    const onMando = vi.fn<(ejes: Ejes) => boolean>(() => true);
    renderHook(() => useTecladoDeVuelo({ activo: true, inerte: false, onMando, giroExtra: 0 }));
    montar();
    const soltadas: string[] = [];
    const alSoltar = (ev: KeyboardEvent) => soltadas.push(ev.code);
    window.addEventListener('keyup', alSoltar);
    try {
      // W apretada volando, y el piloto entra al aviso con la W todavía abajo
      fireEvent.keyDown(window, { code: 'KeyW' });
      expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
      const ceder = screen.getByRole('button', { name: 'Ceder el control' });
      ceder.focus();
      // el navegador repite la tecla sostenida sobre el botón con el foco
      fireEvent.keyDown(ceder, { code: 'KeyW', repeat: true });
      fireEvent.keyDown(ceder, { code: 'KeyW', repeat: true });
      fireEvent.keyUp(ceder, { code: 'KeyW' });
      expect(soltadas).toEqual(['KeyW']);
      // y el teclado de vuelo la soltó: el dron frena en vez de seguir yendo para adelante
      expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    } finally {
      window.removeEventListener('keyup', alSoltar);
    }
  });

  it('una tecla apretada adentro y soltada afuera no le come después la soltada al teclado de vuelo', () => {
    const onMando = vi.fn<(ejes: Ejes) => boolean>(() => true);
    const { result } = renderHook(() => useTecladoDeVuelo({ activo: true, inerte: false, onMando, giroExtra: 0 }));
    montar();
    const mantener = screen.getByRole('button', { name: 'Mantener el control' });
    const afuera = screen.getByRole('button', { name: 'Algo de la página' });
    // Shift+Tab desde el primer botón del aviso: la Shift baja adentro y se
    // suelta con el foco ya afuera, donde la caja del aviso no la oye.
    mantener.focus();
    fireEvent.keyDown(mantener, { code: 'ShiftLeft', key: 'Shift' });
    afuera.focus();
    fireEvent.keyUp(afuera, { code: 'ShiftLeft', key: 'Shift' });
    // Después vuela con Shift+W desde afuera, entra al aviso y suelta la Shift ahí.
    fireEvent.keyDown(afuera, { code: 'ShiftLeft', key: 'Shift' });
    fireEvent.keyDown(afuera, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });
    mantener.focus();
    fireEvent.keyUp(mantener, { code: 'ShiftLeft', key: 'Shift' });
    // El teclado de vuelo la soltó: la W que sigue sostenida vuela normal.
    expect(result.current.rapido).toBe(false);
    pasar(100);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
    fireEvent.keyUp(mantener, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('una tecla apretada adentro y soltada en otra aplicación tampoco queda anotada', () => {
    const onMando = vi.fn<(ejes: Ejes) => boolean>(() => true);
    renderHook(() => useTecladoDeVuelo({ activo: true, inerte: false, onMando, giroExtra: 0 }));
    montar();
    const mantener = screen.getByRole('button', { name: 'Mantener el control' });
    const afuera = screen.getByRole('button', { name: 'Algo de la página' });
    mantener.focus();
    fireEvent.keyDown(mantener, { code: 'Space', key: ' ' });
    // La ventana pierde el foco con el Espacio abajo: su soltada no llega nunca.
    fireEvent.blur(window);
    afuera.focus();
    fireEvent.keyDown(afuera, { code: 'Space', key: ' ' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 0.5 });
    mantener.focus();
    fireEvent.keyUp(mantener, { code: 'Space', key: ' ' });
    // y el dron deja de subir
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('a quien no tiene el control ni lo pidió no le muestra nada', () => {
    montar({ yo: 'supervisor' });
    expect(screen.queryByTestId('pedido-al-titular')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pedido-en-espera')).not.toBeInTheDocument();
  });
});

describe('AvisosDelControl — la espera del que lo pidió', () => {
  it('cuenta lo que le queda al titular y deja cancelar; al vencer, dice que el control está pasando', async () => {
    const { onCancelar } = montar({ yo: 'relevo' });
    const espera = screen.getByTestId('pedido-en-espera');
    expect(within(espera).getByRole('heading', { name: 'Pediste el control de Alfa' })).toBeInTheDocument();
    expect(espera).toHaveTextContent('Esperando que piloto conteste: si no contesta en 10 s, el control pasa a vos.');
    await act(async () => {
      fireEvent.click(within(espera).getByRole('button', { name: 'Cancelar el pedido' }));
    });
    expect(onCancelar).toHaveBeenCalledWith('d1');

    pasar(10_000);
    expect(espera).toHaveTextContent('piloto no contestó: el control está pasando a vos.');
    expect(within(espera).getByRole('button', { name: 'Cancelar el pedido' })).toBeDisabled();
  });

  it('al lector de pantalla no le lee la cuenta en cada segundo: oye el plazo una vez', () => {
    montar({ yo: 'relevo' });
    const espera = screen.getByTestId('pedido-en-espera');
    // Lo que oye un lector de pantalla: el texto sin lo que va oculto.
    const loQueSeLee = () => {
      const copia = espera.cloneNode(true) as HTMLElement;
      copia.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      return copia.textContent;
    };
    const alAparecer = loQueSeLee();
    expect(alAparecer).toContain('Esperando que piloto conteste: si no contesta en 10 segundos, el control pasa a vos.');
    pasar(1_000);
    expect(espera).toHaveTextContent('si no contesta en 9 s');
    expect(loQueSeLee()).toBe(alAparecer);
    pasar(5_000);
    expect(loQueSeLee()).toBe(alAparecer);
    // el cambio que sí importa se lee
    pasar(4_000);
    expect(loQueSeLee()).toContain('piloto no contestó: el control está pasando a vos.');
  });
});

describe('AvisosDelControl — un rechazo que no es un Error', () => {
  it('igual se lee: el motivo, tal cual', async () => {
    montar({
      yo: 'relevo',
      onCancelar: vi.fn(async () => {
        // Lo que rechaza un fetch cortado a mitad de camino no siempre es un Error.
        const rechazo: unknown = 'sin conexión';
        throw rechazo;
      }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar el pedido' }));
    });
    expect(within(screen.getByTestId('pedido-en-espera')).getByRole('alert')).toHaveTextContent('sin conexión');
  });
});

describe('AvisosDelControl — cómo terminó', () => {
  it('cada aviso queda hasta que se lo cierra con su cruz', () => {
    const { onDescartar } = montar({
      pedidos: [],
      avisos: [{ id: 7, droneId: 'd1', texto: 'relevo te cedió el control de Alfa.', tono: 'bueno' }],
    });
    const aviso = screen.getByTestId('aviso-del-control');
    expect(aviso).toHaveTextContent('relevo te cedió el control de Alfa.');
    expect(aviso).toHaveClass('bueno');
    pasar(60_000);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar el aviso de Alfa' }));
    expect(onDescartar).toHaveBeenCalledWith(7);
  });
});

describe('AvisosDelControl — encima de la vista de pilotaje', () => {
  /** Un doble de la vista: se anota como capa mientras está montada, con el dron que se vuela. */
  function VistaFalsa({ dron }: Readonly<{ dron?: string }>) {
    const raiz = useRef<HTMLElement>(null);
    useAnotarCapaDePilotaje(raiz, dron);
    return <section ref={raiz} data-testid="vista-de-pilotaje" />;
  }

  function Pantalla({
    pilotando,
    dron,
    avisos = [],
    onDescartar = () => {},
    conDialogo = false,
  }: Readonly<{
    pilotando: boolean;
    dron?: string;
    avisos?: AvisoDelControl[];
    onDescartar?: (id: number) => void;
    conDialogo?: boolean;
  }>) {
    return (
      <ProveedorDeCapaDePilotaje>
        {pilotando && <VistaFalsa dron={dron} />}
        <AvisosDelControl
          yo="piloto"
          pedidos={[pedido()]}
          nombreDe={nombreDe}
          avisos={avisos}
          onContestar={async () => {}}
          onCancelar={async () => {}}
          onDescartar={onDescartar}
        />
        {/* La confirmación de aterrizar que el piloto abrió antes de que llegara el pedido. */}
        {conDialogo && (
          <Modal etiquetadoPor="titulo-aterrizar" onCerrar={() => {}}>
            <h2 id="titulo-aterrizar">¿Aterrizar Alfa?</h2>
            <button type="button">Cancelar</button>
          </Modal>
        )}
      </ProveedorDeCapaDePilotaje>
    );
  }

  const DE_ALFA: AvisoDelControl = { id: 1, droneId: 'd1', texto: 'Mantuviste el control de Alfa.', tono: 'neutro' };
  const DE_BRAVO: AvisoDelControl = { id: 2, droneId: 'd2', texto: 'Se soltó el control de d2.', tono: 'malo' };

  it('con la vista abierta se cuelga adentro de ella; cerrada, vuelve al body', () => {
    const { rerender } = render(<Pantalla pilotando avisos={[DE_BRAVO]} />);
    const vista = screen.getByTestId('vista-de-pilotaje');
    expect(vista).toContainElement(screen.getByTestId('pedido-al-titular'));
    // una vista que no dice qué dron vuela muestra todos los avisos
    expect(vista).toContainElement(screen.getByTestId('aviso-del-control'));

    rerender(<Pantalla pilotando={false} />);
    const aviso = screen.getByTestId('pedido-al-titular');
    expect(aviso.closest('.avisos-del-control')?.parentElement).toBe(document.body);
  });

  it('volando, de cómo terminó solo se ve lo del dron que se vuela, y se va solo; al cerrar la vista aparece lo demás', () => {
    const onDescartar = vi.fn();
    const { rerender } = render(<Pantalla pilotando dron="d1" avisos={[DE_ALFA, DE_BRAVO]} onDescartar={onDescartar} />);
    expect(screen.getAllByTestId('aviso-del-control').map((a) => a.textContent)).toEqual(['Mantuviste el control de Alfa.']);
    pasar(AVISO_EN_VUELO_MS - 1);
    expect(onDescartar).not.toHaveBeenCalled();
    pasar(1);
    expect(onDescartar).toHaveBeenCalledWith(1);

    rerender(<Pantalla pilotando={false} avisos={[DE_BRAVO]} onDescartar={onDescartar} />);
    expect(screen.getByTestId('aviso-del-control')).toHaveTextContent('Se soltó el control de d2.');
    // afuera de la vista se queda hasta que se lo cierra
    pasar(60_000);
    expect(onDescartar).toHaveBeenCalledTimes(1);
  });

  it('sin pantalla completa y con un diálogo abierto, el pedido no queda tapado y se llega con el tabulador', () => {
    // El diálogo se abre con la vista ya abierta, como la confirmación que se pide desde ella.
    const { rerender } = render(<Pantalla pilotando dron="d1" />);
    rerender(<Pantalla pilotando dron="d1" conDialogo />);
    const vista = screen.getByTestId('vista-de-pilotaje');
    expect(document.fullscreenElement ?? null).toBeNull();
    // el diálogo va adentro de la vista, como los avisos: su velo y el pedido
    // se apilan en la misma capa, y no el velo encima de la vista entera
    const dialogo = screen.getByRole('dialog', { name: '¿Aterrizar Alfa?' });
    expect(vista).toContainElement(dialogo);
    expect(vista).toContainElement(screen.getByTestId('pedido-al-titular'));

    const cancelar = within(dialogo).getByRole('button', { name: 'Cancelar' });
    const mantener = screen.getByRole('button', { name: 'Mantener el control' });
    const ceder = screen.getByRole('button', { name: 'Ceder el control' });
    cancelar.focus();
    fireEvent.keyDown(cancelar, { key: 'Tab' });
    expect(mantener).toHaveFocus();
    // y la vuelta sigue: del último del aviso al diálogo, y para atrás al revés
    ceder.focus();
    fireEvent.keyDown(ceder, { key: 'Tab' });
    expect(cancelar).toHaveFocus();
    fireEvent.keyDown(cancelar, { key: 'Tab', shiftKey: true });
    expect(ceder).toHaveFocus();
    mantener.focus();
    fireEvent.keyDown(mantener, { key: 'Tab', shiftKey: true });
    expect(cancelar).toHaveFocus();
  });
});
