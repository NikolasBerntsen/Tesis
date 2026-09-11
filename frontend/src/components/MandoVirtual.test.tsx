import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MandoVirtual, { EJES_EN_CERO, type Ejes } from './MandoVirtual';

/**
 * jsdom no maqueta: `getBoundingClientRect` devuelve todo en cero y sin esto no
 * habría forma de calcular un eje a partir de dónde cayó el puntero. Se le
 * planta al plato una caja de 200x200 en el origen, así el centro queda en
 * (100, 100) y cada 100 px de corrimiento valen un eje entero.
 */
function medirPlato(plato: HTMLElement) {
  plato.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function montar() {
  const onMando = vi.fn<(ejes: Ejes) => void>();
  render(<MandoVirtual onMando={onMando} />);
  const mando = screen.getByRole('group', { name: 'Mando virtual de vuelo continuo' });
  return { onMando, mando };
}

function lectura(eje: keyof Ejes): string {
  return screen.getByTestId(`eje-${eje}`).textContent ?? '';
}

beforeEach(() => {
  // Todo lo que importa de este componente es cuándo emite: el reloj se maneja
  // a mano en todos los tests del archivo.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MandoVirtual — teclado', () => {
  const CASOS = [
    { tecla: 'w', eje: 'throttle', valor: 1, texto: '100% subiendo' },
    { tecla: 's', eje: 'throttle', valor: -1, texto: '100% bajando' },
    { tecla: 'a', eje: 'yaw', valor: -1, texto: '100% antihorario' },
    { tecla: 'd', eje: 'yaw', valor: 1, texto: '100% horario' },
    { tecla: 'ArrowUp', eje: 'pitch', valor: 1, texto: '100% adelante' },
    { tecla: 'ArrowDown', eje: 'pitch', valor: -1, texto: '100% atrás' },
    { tecla: 'ArrowLeft', eje: 'roll', valor: -1, texto: '100% a la izquierda' },
    { tecla: 'ArrowRight', eje: 'roll', valor: 1, texto: '100% a la derecha' },
  ] as const;

  it.each(CASOS)('$tecla comanda $eje y al soltarla vuelve a cero', ({ tecla, eje, valor, texto }) => {
    const { onMando, mando } = montar();

    fireEvent.keyDown(mando, { key: tecla });
    expect(onMando).toHaveBeenCalledWith({ ...EJES_EN_CERO, [eje]: valor });
    expect(lectura(eje)).toBe(texto);

    fireEvent.keyUp(mando, { key: tecla });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(lectura(eje)).toBe('sin comando');
  });

  it('en reposo muestra los cuatro ejes sin comando y no manda nada', () => {
    const { onMando } = montar();
    for (const eje of ['pitch', 'roll', 'yaw', 'throttle'] as const) {
      expect(lectura(eje)).toBe('sin comando');
    }
    act(() => vi.advanceTimersByTime(2000));
    expect(onMando).not.toHaveBeenCalled();
  });

  it('atiende las mayúsculas: con Bloq Mayús el mando no puede dejar de responder', () => {
    const { onMando, mando } = montar();
    fireEvent.keyDown(mando, { key: 'W' });
    expect(onMando).toHaveBeenCalledWith({ ...EJES_EN_CERO, throttle: 1 });
  });

  it('dos teclas del mismo eje se anulan y las de palancas distintas se suman', () => {
    const { onMando, mando } = montar();
    fireEvent.keyDown(mando, { key: 'w' });
    fireEvent.keyDown(mando, { key: 'ArrowRight' });
    // La segunda tecla entra por el muestreo de 10 Hz, no por un envío suelto:
    // en pantalla se ve en el acto y al dron le llega en el próximo tick.
    expect(lectura('roll')).toBe('100% a la derecha');
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1, roll: 1 });

    // W y S apretadas juntas dejan la palanca en el centro, como un resorte.
    fireEvent.keyDown(mando, { key: 's' });
    expect(lectura('throttle')).toBe('sin comando');
    expect(lectura('roll')).toBe('100% a la derecha');
  });

  it('no se queda con el teclado de la página: sólo ataja sus propias teclas', () => {
    const { onMando, mando } = montar();
    // Tab tiene que seguir viaje o no se puede salir del mando sin mouse.
    expect(fireEvent.keyDown(mando, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyUp(mando, { key: 'Tab' })).toBe(true);
    expect(onMando).not.toHaveBeenCalled();
    // La flecha, en cambio, se ataja: si no, la página se desplaza sola.
    expect(fireEvent.keyDown(mando, { key: 'ArrowUp' })).toBe(false);
  });

  it('si el foco se va con una tecla apretada, el eje no queda clavado', () => {
    const { onMando, mando } = montar();
    fireEvent.keyDown(mando, { key: 'ArrowUp' });
    expect(lectura('pitch')).toBe('100% adelante');

    // Sin esto el keyup se lo lleva otro elemento y el dron seguiría de largo.
    fireEvent.blur(mando);
    expect(lectura('pitch')).toBe('sin comando');
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('el bloque es enfocable y se anuncia con su ayuda', () => {
    const { mando } = montar();
    expect(mando).toHaveAttribute('tabindex', '0');
    const ayuda = document.getElementById(mando.getAttribute('aria-describedby') ?? '');
    expect(ayuda).toHaveTextContent(/Arrastrá las palancas con el mouse o el dedo/);
  });
});

describe('MandoVirtual — ritmo de emisión', () => {
  it('emite a 10 Hz mientras la palanca esté sostenida', () => {
    const { onMando, mando } = montar();
    fireEvent.keyDown(mando, { key: 'w' });
    // El primero sale en el acto, sin esperar al tick.
    expect(onMando).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1000));
    // 1 inmediato + 10 del segundo: eso es 10 Hz.
    expect(onMando).toHaveBeenCalledTimes(11);
    for (const [ejes] of onMando.mock.calls) expect(ejes).toEqual({ ...EJES_EN_CERO, throttle: 1 });
  });

  it('mover la palanca no acelera el ritmo: sigue habiendo un mensaje cada 100 ms', () => {
    const { onMando, mando } = montar();
    fireEvent.keyDown(mando, { key: 'w' });
    // Cambiar los ejes vuelve a dibujar el componente varias veces; el
    // temporizador no se reinicia con cada cambio.
    fireEvent.keyDown(mando, { key: 'd' });
    fireEvent.keyUp(mando, { key: 'd' });
    fireEvent.keyDown(mando, { key: 'a' });
    expect(onMando).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(500));
    expect(onMando).toHaveBeenCalledTimes(6);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1, yaw: -1 });
  });

  it('al soltar manda UN cero y deja de mandar', () => {
    const { onMando, mando } = montar();
    fireEvent.keyDown(mando, { key: 'ArrowUp' });
    act(() => vi.advanceTimersByTime(300));
    fireEvent.keyUp(mando, { key: 'ArrowUp' });

    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    const emitidos = onMando.mock.calls.length;

    // El dron ya quedó en vuelo estacionario: repetirle el cero 10 veces por
    // segundo hasta el fin de los tiempos sería inundar el enlace al pedo.
    act(() => vi.advanceTimersByTime(5000));
    expect(onMando).toHaveBeenCalledTimes(emitidos);
  });

  it('irse de la vista con la palanca sostenida deja el dron en cero', () => {
    const onMando = vi.fn<(ejes: Ejes) => void>();
    const { unmount } = render(<MandoVirtual onMando={onMando} />);
    fireEvent.keyDown(screen.getByRole('group', { name: 'Mando virtual de vuelo continuo' }), { key: 'w' });

    unmount();
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });
});

describe('MandoVirtual — mouse y dedo', () => {
  it('el arrastre con el mouse comanda los dos ejes de la palanca derecha', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    // Borde derecho, a la altura del centro: todo el roll, nada de pitch.
    fireEvent.mouseDown(plato, { clientX: 200, clientY: 100 });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, roll: 1 });
    expect(screen.getByTestId('perilla-derecha')).toHaveStyle({ left: '84%', top: '50%' });

    // El puntero sigue mandando aunque se vaya del plato: el seguimiento está
    // en la ventana, no en el círculo.
    fireEvent.mouseMove(window, { clientX: 150, clientY: 50 });
    expect(lectura('pitch')).toBe('50% adelante');
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, roll: 0.5, pitch: 0.5 });

    fireEvent.mouseUp(window);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(screen.getByTestId('perilla-derecha')).toHaveStyle({ left: '50%', top: '50%' });

    // Y una vez soltado el mouse, moverlo ya no comanda nada.
    const emitidos = onMando.mock.calls.length;
    fireEvent.mouseMove(window, { clientX: 0, clientY: 0 });
    act(() => vi.advanceTimersByTime(500));
    expect(onMando).toHaveBeenCalledTimes(emitidos);
  });

  it('la palanca izquierda maneja altura y giro, y el arrastre se recorta en ±1', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-izquierda');
    medirPlato(plato);

    // Bien afuera del plato y arriba a la izquierda: los ejes se acotan.
    fireEvent.mouseDown(plato, { clientX: -900, clientY: -900 });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, yaw: -1, throttle: 1 });
    expect(lectura('throttle')).toBe('100% subiendo');
    expect(lectura('yaw')).toBe('100% antihorario');
  });

  it('el dedo arrastra igual que el mouse y al levantarlo vuelve al centro', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    fireEvent.touchStart(plato, { touches: [{ clientX: 100, clientY: 0 }] });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });

    fireEvent.touchMove(plato, { touches: [{ clientX: 100, clientY: 150 }] });
    expect(lectura('pitch')).toBe('50% atrás');
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: -0.5 });

    fireEvent.touchEnd(plato);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(lectura('pitch')).toBe('sin comando');
  });

  it('un toque cancelado por el sistema también devuelve la palanca al centro', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-izquierda');
    medirPlato(plato);

    fireEvent.touchStart(plato, { touches: [{ clientX: 100, clientY: 0 }] });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1 });

    fireEvent.touchCancel(plato);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('mientras se arrastra una palanca, el teclado no le pisa los ejes', () => {
    const { onMando, mando } = montar();
    const plato = screen.getByTestId('palanca-izquierda');
    medirPlato(plato);

    fireEvent.mouseDown(plato, { clientX: 100, clientY: 50 });
    fireEvent.keyDown(mando, { key: 's' });
    // Manda el arrastre: la mano está en la palanca.
    expect(lectura('throttle')).toBe('50% subiendo');
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 0.5 });

    // Soltado el mouse, la tecla que quedó apretada toma el control del eje.
    fireEvent.mouseUp(window);
    expect(lectura('throttle')).toBe('100% bajando');
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: -1 });
  });
});
