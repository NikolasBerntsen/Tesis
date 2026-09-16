import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MandoVirtual, { EJES_EN_CERO, type Ejes } from './MandoVirtual';

/**
 * jsdom no maqueta: `getBoundingClientRect` devuelve todo en cero y sin esto no
 * habría forma de calcular un eje a partir de dónde cayó el puntero. Se le
 * planta al plato una caja de 200x200 (el centro queda a 100 px de su borde
 * izquierdo, así cada 100 px de corrimiento valen un eje entero) y se puede
 * correr con `izquierda`, que es lo que hace falta para probar los dos platos
 * uno al lado del otro.
 */
function medirPlato(plato: HTMLElement, izquierda = 0) {
  plato.getBoundingClientRect = () =>
    ({ left: izquierda, top: 0, width: 200, height: 200, right: izquierda + 200, bottom: 200, x: izquierda, y: 0, toJSON: () => ({}) }) as DOMRect;
}

/**
 * Un dedo como lo trae un TouchEvent. El `identifier` es lo que distingue un
 * dedo del otro: sin él no se puede probar el caso de los dos pulgares.
 */
function dedo(identifier: number, clientX: number, clientY: number) {
  return { identifier, clientX, clientY };
}

function montar(impedimento: string | null = null) {
  // Devuelve true: el canal está abierto y el mensaje sale. El caso contrario
  // tiene su propio test.
  const onMando = vi.fn<(ejes: Ejes) => boolean>(() => true);
  const { unmount } = render(<MandoVirtual onMando={onMando} impedimento={impedimento} />);
  const mando = screen.getByRole('group', { name: 'Mando virtual de vuelo continuo' });
  return { onMando, mando, unmount };
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
  vi.restoreAllMocks();
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
    const { onMando, mando, unmount } = montar();
    fireEvent.keyDown(mando, { key: 'w' });

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
    // en la ventana, no en el círculo. Va con el botón apretado, que es lo que
    // el navegador informa mientras se arrastra de verdad.
    fireEvent.mouseMove(window, { clientX: 150, clientY: 50, buttons: 1 });
    expect(lectura('pitch')).toBe('50% adelante');
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, roll: 0.5, pitch: 0.5 });

    fireEvent.mouseUp(window);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(screen.getByTestId('perilla-derecha')).toHaveStyle({ left: '50%', top: '50%' });

    // Y una vez soltado el mouse, moverlo ya no comanda nada.
    const emitidos = onMando.mock.calls.length;
    fireEvent.mouseMove(window, { clientX: 0, clientY: 0, buttons: 1 });
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

    const pulgar = dedo(3, 100, 0);
    fireEvent.touchStart(plato, { touches: [pulgar], changedTouches: [pulgar] });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });

    const movido = dedo(3, 100, 150);
    fireEvent.touchMove(plato, { touches: [movido], changedTouches: [movido] });
    expect(lectura('pitch')).toBe('50% atrás');
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: -0.5 });

    fireEvent.touchEnd(plato, { touches: [], changedTouches: [movido] });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(lectura('pitch')).toBe('sin comando');
  });

  it('un toque cancelado por el sistema también devuelve la palanca al centro', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-izquierda');
    medirPlato(plato);

    const pulgar = dedo(0, 100, 0);
    fireEvent.touchStart(plato, { touches: [pulgar], changedTouches: [pulgar] });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1 });

    fireEvent.touchCancel(plato, { touches: [], changedTouches: [pulgar] });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('con los dos pulgares apoyados cada palanca lee SU dedo, no el del otro plato', () => {
    const { onMando } = montar();
    const izquierdo = screen.getByTestId('palanca-izquierda');
    const derecho = screen.getByTestId('palanca-derecha');
    // Los dos platos uno al lado del otro, como en la tablet de operación: el
    // izquierdo con centro en x=100, el derecho con centro en x=400.
    medirPlato(izquierdo);
    medirPlato(derecho, 300);

    // Primero el pulgar izquierdo, a fondo arriba: el dron sube.
    const zurdo = dedo(0, 100, 0);
    fireEvent.touchStart(izquierdo, { touches: [zurdo], changedTouches: [zurdo] });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1 });

    // Y ahora el derecho, a fondo a la derecha. El toque del plato derecho
    // llega con los DOS dedos en `touches`, y el primero de la lista es el
    // izquierdo: leyendo `touches[0]` este plato tomaría el pulgar del otro
    // —a 300 px de su centro, o sea roll = -1— y el dron se iría de costado a
    // 5 m/s para el lado contrario al que pidió el operador.
    const diestro = dedo(1, 500, 100);
    fireEvent.touchStart(derecho, { touches: [zurdo, diestro], changedTouches: [diestro] });
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1, roll: 1 });
    expect(lectura('roll')).toBe('100% a la derecha');
    expect(lectura('throttle')).toBe('100% subiendo');

    // Mover un dedo mueve solamente su palanca.
    const zurdoMovido = dedo(0, 100, 50);
    fireEvent.touchMove(izquierdo, { touches: [zurdoMovido, diestro], changedTouches: [zurdoMovido] });
    expect(lectura('throttle')).toBe('50% subiendo');
    expect(lectura('roll')).toBe('100% a la derecha');

    // Y levantar un dedo suelta solamente su palanca: la otra sigue comandada.
    fireEvent.touchEnd(izquierdo, { touches: [diestro], changedTouches: [zurdoMovido] });
    expect(lectura('throttle')).toBe('sin comando');
    expect(lectura('roll')).toBe('100% a la derecha');
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, roll: 1 });
  });

  it('un dedo que cae sobre una palanca ya tomada no se la pelea al primero', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    const primero = dedo(0, 100, 0);
    fireEvent.touchStart(plato, { touches: [primero], changedTouches: [primero] });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });

    // Un segundo dedo sobre el mismo plato: manda el que llegó primero, y
    // levantarlo no suelta la palanca del otro.
    const segundo = dedo(1, 200, 100);
    fireEvent.touchStart(plato, { touches: [primero, segundo], changedTouches: [segundo] });
    expect(lectura('pitch')).toBe('100% adelante');
    expect(lectura('roll')).toBe('sin comando');

    fireEvent.touchEnd(plato, { touches: [primero], changedTouches: [segundo] });
    expect(lectura('pitch')).toBe('100% adelante');

    fireEvent.touchEnd(plato, { touches: [], changedTouches: [primero] });
    expect(lectura('pitch')).toBe('sin comando');
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('un dedo que no tomó esta palanca no la mueve', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    // Un touchmove sobre un plato que nadie tomó —el dedo ya se levantó, o el
    // toque es del otro plato— no tiene nada que mover: antes cualquier dedo
    // de la pantalla le movía la palanca.
    const ajeno = dedo(7, 200, 0);
    fireEvent.touchMove(plato, { touches: [ajeno], changedTouches: [ajeno] });
    expect(lectura('pitch')).toBe('sin comando');
    expect(lectura('roll')).toBe('sin comando');
    act(() => vi.advanceTimersByTime(500));
    expect(onMando).not.toHaveBeenCalled();
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

describe('MandoVirtual — arrastres que no se sueltan solos', () => {
  /**
   * Anota cuántos listeners de cada tipo quedan vivos en la ventana. Es la
   * única forma de exigir que el componente se desengance: un `mousemove` que
   * sobrevive al desmontaje queda tocando un componente muerto en cada
   * movimiento del mouse, y eso no se ve desde afuera.
   */
  function espiarListenersDeVentana(): Map<string, number> {
    const vivos = new Map<string, number>();
    const agregar = window.addEventListener.bind(window);
    const quitar = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((tipo, fn, opciones) => {
      vivos.set(tipo, (vivos.get(tipo) ?? 0) + 1);
      agregar(tipo, fn, opciones);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((tipo, fn, opciones) => {
      vivos.set(tipo, (vivos.get(tipo) ?? 0) - 1);
      quitar(tipo, fn, opciones);
    });
    return vivos;
  }

  it('si la ventana pierde el foco en pleno arrastre, la palanca se suelta', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    fireEvent.mouseDown(plato, { clientX: 100, clientY: 0 });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });

    // Alt+Tab con el botón apretado: el `mouseup` se suelta sobre otra ventana
    // y a la página no llega nunca. Sin esto la palanca queda trabada mandando
    // pitch 1 a 10 Hz para siempre —el watchdog de la app no salva nada, porque
    // los mensajes siguen llegando— y el dron se va de largo a 5 m/s.
    fireEvent.blur(window);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(lectura('pitch')).toBe('sin comando');

    const emitidos = onMando.mock.calls.length;
    fireEvent.mouseMove(window, { clientX: 100, clientY: 200, buttons: 1 });
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenCalledTimes(emitidos);
  });

  it('un movimiento sin botón apretado también suelta: el mouseup se perdió', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-izquierda');
    medirPlato(plato);

    fireEvent.mouseDown(plato, { clientX: 100, clientY: 0 });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1 });

    // El operador soltó el botón afuera de la ventana y volvió el puntero a la
    // página: sin esto el dron se pondría a seguir el cursor.
    fireEvent.mouseMove(window, { clientX: 150, clientY: 100, buttons: 0 });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(lectura('throttle')).toBe('sin comando');

    const emitidos = onMando.mock.calls.length;
    fireEvent.mouseMove(window, { clientX: 100, clientY: 0, buttons: 1 });
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenCalledTimes(emitidos);
  });

  it('desmontar en pleno arrastre desengancha los listeners de la ventana', () => {
    const vivos = espiarListenersDeVentana();
    const { onMando, unmount } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    fireEvent.mouseDown(plato, { clientX: 200, clientY: 100 });
    expect(vivos.get('mousemove')).toBe(1);
    expect(vivos.get('mouseup')).toBe(1);
    expect(vivos.get('blur')).toBe(1);

    // El supervisor le saca el control al operador en pleno arrastre: el mando
    // se va del DOM sin que nadie suelte el mouse.
    unmount();
    expect(vivos.get('mousemove')).toBe(0);
    expect(vivos.get('mouseup')).toBe(0);
    expect(vivos.get('blur')).toBe(0);

    const emitidos = onMando.mock.calls.length;
    fireEvent.mouseMove(window, { clientX: 0, clientY: 0, buttons: 1 });
    act(() => vi.advanceTimersByTime(500));
    expect(onMando).toHaveBeenCalledTimes(emitidos);
  });

  it('cada palanca engancha SU juego de listeners: agarrar una no desengancha la otra', () => {
    const vivos = espiarListenersDeVentana();
    const { onMando, unmount } = montar();
    const izquierdo = screen.getByTestId('palanca-izquierda');
    const derecho = screen.getByTestId('palanca-derecha');
    medirPlato(izquierdo);
    medirPlato(derecho, 300);

    fireEvent.mouseDown(izquierdo, { clientX: 100, clientY: 0 });
    fireEvent.mouseDown(derecho, { clientX: 500, clientY: 100 });
    // Con UNA sola limpieza para las dos palancas, agarrar la derecha corría la
    // de la izquierda: le sacaba a la izquierda su propio `mouseup` y la dejaba
    // trabada a fondo arriba, mandando throttle 1 a 10 Hz sin nadie sosteniendo
    // nada. Son dos juegos vivos, uno por palanca.
    expect(vivos.get('mousemove')).toBe(2);
    expect(vivos.get('mouseup')).toBe(2);
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1, roll: 1 });

    // El `mouseup` se escucha en la ventana, así que soltar el botón suelta las
    // DOS palancas —con un solo mouse no hay forma de soltar una sola— y no deja
    // ni un listener colgado. Lo que se exige acá es eso: que ninguna de las dos
    // quede comandando ni escuchando después de soltar.
    fireEvent.mouseUp(window);
    expect(lectura('throttle')).toBe('sin comando');
    expect(lectura('roll')).toBe('sin comando');
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(vivos.get('mousemove')).toBe(0);
    expect(vivos.get('mouseup')).toBe(0);

    const emitidos = onMando.mock.calls.length;
    fireEvent.mouseMove(window, { clientX: 150, clientY: 50, buttons: 1 });
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenCalledTimes(emitidos);
    unmount();
    expect(vivos.get('mousemove')).toBe(0);
  });

  it('volver a agarrar la misma palanca no deja colgado el juego del arrastre anterior', () => {
    const vivos = espiarListenersDeVentana();
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    // Dos `mousedown` seguidos sobre la MISMA palanca sin `mouseup` en el medio:
    // pasa de verdad cuando el que soltó se lo comió otra ventana y el operador
    // vuelve a agarrar. El arrastre nuevo tiene que desenganchar al anterior.
    fireEvent.mouseDown(plato, { clientX: 200, clientY: 100 });
    fireEvent.mouseDown(plato, { clientX: 100, clientY: 0 });
    expect(vivos.get('mousemove')).toBe(1);
    expect(vivos.get('mouseup')).toBe(1);
    // El que comanda es el arrastre nuevo; el eje sale en el próximo tick de los
    // 10 Hz, que es el ritmo con el que se emite siempre.
    expect(lectura('pitch')).toBe('100% adelante');
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });

    // Y con el juego viejo colgado, este `mouseup` no lo alcanzaba: su
    // `mousemove` se quedaba en la ventana y la palanca se ponía a seguir el
    // cursor sin ningún botón apretado.
    fireEvent.mouseUp(window);
    expect(vivos.get('mousemove')).toBe(0);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);

    const emitidos = onMando.mock.calls.length;
    fireEvent.mouseMove(window, { clientX: 200, clientY: 200, buttons: 1 });
    act(() => vi.advanceTimersByTime(500));
    expect(onMando).toHaveBeenCalledTimes(emitidos);
    expect(lectura('pitch')).toBe('sin comando');
  });

  it('un pointercancel suelta la palanca: con el puntero cancelado no va a llegar ningún mouseup', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    fireEvent.mouseDown(plato, { clientX: 100, clientY: 0 });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });

    // El sistema se queda con el puntero en pleno arrastre (un gesto del sistema
    // operativo, el mouse que se desenchufa): no hay `mouseup` ni `blur` ni
    // `mousemove` después de esto, así que sin atender `pointercancel` la palanca
    // seguiría a fondo adelante.
    fireEvent.pointerCancel(window);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(lectura('pitch')).toBe('sin comando');

    const emitidos = onMando.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenCalledTimes(emitidos);
  });
});

describe('MandoVirtual — captura del puntero', () => {
  /**
   * Un `pointerdown` como el que manda el navegador. jsdom no tiene
   * `PointerEvent`, así que `fireEvent.pointerDown` arma un `Event` pelado y se
   * come el `pointerId`, que es justo el dato que hace falta para capturar.
   */
  function bajarPuntero(plato: HTMLElement, pointerId: number, pointerType = 'mouse') {
    const ev = new Event('pointerdown', { bubbles: true });
    Object.assign(ev, { pointerId, pointerType });
    fireEvent(plato, ev);
  }

  /**
   * jsdom no implementa `setPointerCapture`: se le planta al plato para poder
   * exigir que el componente la pida. Es lo único que garantiza que el
   * `pointerup` —y con él el `mouseup` de compatibilidad— le llegue a la página
   * cuando el operador suelta el botón AFUERA de la ventana: ese caso no lo
   * cierra ni el `blur` (soltar sobre otra aplicación sin clickearla no le quita
   * el foco a nadie) ni el `mousemove` con `buttons === 0` (con el puntero quieto
   * afuera no llega ningún movimiento), y mientras tanto la palanca sigue
   * emitiendo el último eje a 10 Hz.
   */
  function espiarCaptura(plato: HTMLElement) {
    const capturar = vi.fn();
    Object.assign(plato, { setPointerCapture: capturar });
    return capturar;
  }

  it('al empezar el arrastre pide la captura del puntero', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);
    const capturar = espiarCaptura(plato);

    bajarPuntero(plato, 7);
    fireEvent.mouseDown(plato, { clientX: 200, clientY: 100 });
    expect(capturar).toHaveBeenCalledWith(7);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, roll: 1 });
  });

  it('el dedo no se captura y el mando inerte tampoco captura nada', () => {
    const { unmount } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    const capturar = espiarCaptura(plato);
    // Un toque ya le entrega todos sus eventos al elemento donde empezó, y el
    // camino táctil de este componente no pasa por los eventos de puntero.
    bajarPuntero(plato, 2, 'touch');
    expect(capturar).not.toHaveBeenCalled();
    unmount();

    const impedido = montar('El dron está desconectado: el mando no responde.');
    const platoInerte = screen.getByTestId('palanca-derecha');
    const capturarInerte = espiarCaptura(platoInerte);
    bajarPuntero(platoInerte, 3);
    expect(capturarInerte).not.toHaveBeenCalled();
    expect(impedido.onMando).not.toHaveBeenCalled();
  });

  it('en un navegador sin captura de puntero el arrastre con mouse anda igual', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    // Sin plantarle nada: `setPointerCapture` no existe, como en jsdom y como en
    // los navegadores sin Pointer Events. El arrastre es el mismo de siempre.
    bajarPuntero(plato, 9);
    fireEvent.mouseDown(plato, { clientX: 200, clientY: 100 });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, roll: 1 });
    fireEvent.mouseUp(window);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });
});

describe('MandoVirtual — zona muerta', () => {
  it('un roce dentro de la zona muerta no comanda ni emite nada', () => {
    const { onMando } = montar();
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);

    // 4 px arriba del centro sobre un plato de 200 px: eje 0,04. La app lo come
    // por zona muerta (`MandoVirtual.ZONA_MUERTA` = 0,05) y lo ejecuta como 0,
    // así que la consola no puede mostrar "4% adelante" ni ponerse a emitir: el
    // operador vería tráfico saliendo y un eje comandado que el dron no hace.
    fireEvent.mouseDown(plato, { clientX: 100, clientY: 96 });
    expect(lectura('pitch')).toBe('sin comando');
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).not.toHaveBeenCalled();

    // Apenas se pasa la zona muerta sí hay comando, y es el mismo número que va
    // a ejecutar el dron.
    fireEvent.mouseMove(window, { clientX: 100, clientY: 94, buttons: 1 });
    expect(lectura('pitch')).toBe('6% adelante');
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.06 });
  });
});

describe('MandoVirtual — sin poder comandar', () => {
  const MOTIVO = 'El dron está volviendo a base (batería baja): el mando no responde.';

  it('con un impedimento se muestra el motivo y las palancas quedan inertes', () => {
    const { onMando, mando } = montar(MOTIVO);
    expect(screen.getByTestId('mando-impedimento')).toHaveTextContent(MOTIVO);
    expect(mando).toHaveAttribute('aria-disabled', 'true');
    // Sigue a la vista: esconderlo de golpe le haría creer al operador que le
    // sacaron el control.
    expect(screen.getByTestId('palanca-izquierda')).toBeInTheDocument();
    expect(screen.getByTestId('palanca-derecha')).toBeInTheDocument();

    // Ni el teclado ni el mouse ni el dedo comandan nada.
    fireEvent.keyDown(mando, { key: 'ArrowUp' });
    const plato = screen.getByTestId('palanca-derecha');
    medirPlato(plato);
    fireEvent.mouseDown(plato, { clientX: 200, clientY: 100 });
    const pulgar = dedo(0, 200, 100);
    fireEvent.touchStart(plato, { touches: [pulgar], changedTouches: [pulgar] });
    expect(lectura('pitch')).toBe('sin comando');
    expect(lectura('roll')).toBe('sin comando');
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).not.toHaveBeenCalled();
  });

  it('si el impedimento aparece con la palanca sostenida, sale el cero y se corta', () => {
    const onMando = vi.fn<(ejes: Ejes) => boolean>(() => true);
    const { rerender } = render(<MandoVirtual onMando={onMando} />);
    const mando = screen.getByRole('group', { name: 'Mando virtual de vuelo continuo' });
    fireEvent.keyDown(mando, { key: 'w' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1 });

    // La app se fue sola a volver a base: el lock sigue puesto, pero el dron ya
    // descarta los ejes. La consola tiene que dejar de mandar y decirlo.
    rerender(<MandoVirtual onMando={onMando} impedimento={MOTIVO} />);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(lectura('throttle')).toBe('sin comando');
    expect(screen.getByTestId('mando-impedimento')).toHaveTextContent(MOTIVO);

    const emitidos = onMando.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenCalledTimes(emitidos);
  });

  /**
   * El aviso de "no salió" y el motivo del impedimento CONVIVEN, y no es un
   * detalle: `onMando` devuelve false por un solo motivo, el socket cerrado, que
   * es el mismo que el padre convierte en impedimento de conexión (ver
   * `impedimentoDelMando` en DroneDetail). Montar este componente con
   * `impedimento = null` y un `onMando` que devuelve false es una combinación que
   * la consola no muestra —las dos cosas llegan juntas—; el camino real es este:
   * el operador está volando y en el medio se corta el enlace.
   */
  const SIN_ENLACE = 'Sin conexión con el Comando Central: el mando no responde.';

  it('si el enlace se corta en pleno vuelo, avisa el motivo Y que el comando no salió', () => {
    const onMando = vi.fn<(ejes: Ejes) => boolean>(() => true);
    const { rerender } = render(<MandoVirtual onMando={onMando} />);
    const mando = screen.getByRole('group', { name: 'Mando virtual de vuelo continuo' });
    fireEvent.keyDown(mando, { key: 'ArrowUp' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });
    expect(screen.queryByTestId('mando-no-salio')).not.toBeInTheDocument();

    // Se cae el socket: el padre pone el impedimento y su `enviar` empieza a
    // devolver false, las dos cosas juntas y por el mismo motivo.
    onMando.mockReturnValue(false);
    rerender(<MandoVirtual onMando={onMando} impedimento={SIN_ENLACE} />);

    // El cierre en cero tampoco salió, así que el dron se quedó moviéndose con
    // pitch 1 (5 m/s) hasta que lo frene el watchdog de la app: eso es lo que el
    // operador tiene que leer, además del motivo.
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(screen.getByTestId('mando-impedimento')).toHaveTextContent(SIN_ENLACE);
    expect(screen.getByTestId('mando-no-salio')).toHaveTextContent(/El último comando no salió/);
    expect(screen.getByTestId('mando-no-salio')).toHaveTextContent(/1,5 s/);
  });

  it('vuelto el enlace, el aviso de "no salió" no queda colgado', () => {
    const onMando = vi.fn<(ejes: Ejes) => boolean>(() => true);
    const { rerender } = render(<MandoVirtual onMando={onMando} />);
    const mando = screen.getByRole('group', { name: 'Mando virtual de vuelo continuo' });
    fireEvent.keyDown(mando, { key: 'ArrowUp' });
    onMando.mockReturnValue(false);
    rerender(<MandoVirtual onMando={onMando} impedimento={SIN_ENLACE} />);
    expect(screen.getByTestId('mando-no-salio')).toBeInTheDocument();

    // El operador lee el aviso y suelta la palanca, que es lo que hay que hacer.
    fireEvent.keyUp(mando, { key: 'ArrowUp' });

    // El socket reconectó (3 s en el peor caso): a esa altura el watchdog de la
    // app ya frenó al dron, así que el cartel dejó de ser cierto. Con la palanca
    // soltada no hay ningún envío nuevo que lo actualice, así que si no se limpia
    // al levantarse el impedimento queda colgado en pantalla para siempre.
    onMando.mockReturnValue(true);
    rerender(<MandoVirtual onMando={onMando} impedimento={null} />);
    expect(screen.queryByTestId('mando-no-salio')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mando-impedimento')).not.toBeInTheDocument();
  });
});
