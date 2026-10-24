import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvisoDelControl, PedidoDeControl } from '../control';
import AvisosDelControl from './AvisosDelControl';
import { ProveedorDeCapaDePilotaje, useAnotarCapaDePilotaje } from './CapaDePilotaje';

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
  it('dice quién lo pide y de qué dron, cuenta los 10 s y se va solo al vencer', () => {
    montar();
    const algo = screen.getByRole('button', { name: 'Algo de la página' });
    const aviso = screen.getByTestId('pedido-al-titular');
    expect(within(aviso).getByRole('heading', { name: 'relevo quiere tomar el control' })).toBeInTheDocument();
    expect(aviso).toHaveTextContent('Le pidió a la consola el control de Alfa');
    expect(screen.getByTestId('cuenta-regresiva')).toHaveTextContent('10 s');
    // el plazo, una vez, para el lector de pantalla: la cuenta va oculta
    expect(screen.getByTestId('cuenta-regresiva')).toHaveAttribute('aria-hidden', 'true');
    expect(aviso).toHaveTextContent('Tenés 10 segundos para contestar.');
    expect(algo).not.toHaveFocus();

    pasar(3_000);
    expect(screen.getByTestId('cuenta-regresiva')).toHaveTextContent('7 s');
    pasar(7_000);
    expect(screen.queryByTestId('pedido-al-titular')).not.toBeInTheDocument();
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
  /** Un doble de la vista: se anota como capa mientras está montada. */
  function VistaFalsa() {
    const raiz = useRef<HTMLElement>(null);
    useAnotarCapaDePilotaje(raiz);
    return <section ref={raiz} data-testid="vista-de-pilotaje" />;
  }

  function Pantalla({ pilotando }: Readonly<{ pilotando: boolean }>) {
    return (
      <ProveedorDeCapaDePilotaje>
        {pilotando && <VistaFalsa />}
        <AvisosDelControl
          yo="piloto"
          pedidos={[pedido()]}
          nombreDe={nombreDe}
          avisos={[]}
          onContestar={async () => {}}
          onCancelar={async () => {}}
          onDescartar={() => {}}
        />
      </ProveedorDeCapaDePilotaje>
    );
  }

  it('con la vista abierta se cuelga adentro de ella; cerrada, vuelve al body', () => {
    const { rerender } = render(<Pantalla pilotando />);
    const vista = screen.getByTestId('vista-de-pilotaje');
    expect(vista).toContainElement(screen.getByTestId('pedido-al-titular'));

    rerender(<Pantalla pilotando={false} />);
    const aviso = screen.getByTestId('pedido-al-titular');
    expect(aviso.closest('.avisos-del-control')?.parentElement).toBe(document.body);
  });
});
