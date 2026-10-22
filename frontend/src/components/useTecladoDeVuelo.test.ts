import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EJES_EN_CERO, type Ejes } from './MandoVirtual';
import {
  NINGUNA_TECLA,
  apretarTecla,
  ejesDeTeclas,
  esRapido,
  esTeclaDeVuelo,
  soltarTecla,
  useTecladoDeVuelo,
  type TeclasSostenidas,
} from './useTecladoDeVuelo';

/** Aprieta y suelta una secuencia sobre el estado puro: `+KeyA` aprieta, `-KeyA` suelta. */
function secuencia(...pasos: string[]): TeclasSostenidas {
  return pasos.reduce(
    (estado, paso) => (paso.startsWith('+') ? apretarTecla(estado, paso.slice(1)) : soltarTecla(estado, paso.slice(1))),
    NINGUNA_TECLA,
  );
}

describe('teclas de vuelo — mapa', () => {
  const CASOS: { code: string; eje: keyof Ejes; valor: number }[] = [
    { code: 'KeyW', eje: 'pitch', valor: 0.5 },
    { code: 'KeyS', eje: 'pitch', valor: -0.5 },
    { code: 'KeyA', eje: 'roll', valor: -0.5 },
    { code: 'KeyD', eje: 'roll', valor: 0.5 },
    { code: 'KeyQ', eje: 'yaw', valor: -0.5 },
    { code: 'KeyE', eje: 'yaw', valor: 0.5 },
    { code: 'Space', eje: 'throttle', valor: 0.5 },
    { code: 'ControlLeft', eje: 'throttle', valor: -0.5 },
    { code: 'ControlRight', eje: 'throttle', valor: -0.5 },
    { code: 'KeyC', eje: 'throttle', valor: -0.5 },
  ];

  it.each(CASOS)('$code mueve sólo $eje, a velocidad intermedia', ({ code, eje, valor }) => {
    expect(ejesDeTeclas(secuencia(`+${code}`))).toEqual({ ...EJES_EN_CERO, [eje]: valor });
  });

  it('A y D son traslación pura: no giran el dron', () => {
    expect(ejesDeTeclas(secuencia('+KeyA')).yaw).toBe(0);
    expect(ejesDeTeclas(secuencia('+KeyD')).yaw).toBe(0);
  });

  it('con Shift sostenida todo va a fondo, y al soltarla vuelve a la mitad', () => {
    const rapido = secuencia('+KeyW', '+ShiftLeft', '+KeyE');
    expect(esRapido(rapido)).toBe(true);
    expect(ejesDeTeclas(rapido)).toEqual({ pitch: 1, roll: 0, yaw: 1, throttle: 0 });

    const normal = soltarTecla(rapido, 'ShiftLeft');
    expect(esRapido(normal)).toBe(false);
    expect(ejesDeTeclas(normal)).toEqual({ pitch: 0.5, roll: 0, yaw: 0.5, throttle: 0 });
  });

  it('las dos Shift cuentan: soltar una con la otra sostenida sigue rápido', () => {
    const estado = secuencia('+ShiftLeft', '+ShiftRight', '-ShiftLeft', '+Space');
    expect(ejesDeTeclas(estado).throttle).toBe(1);
  });

  it('distingue las teclas de vuelo del resto', () => {
    expect(esTeclaDeVuelo('KeyW', false)).toBe(true);
    expect(esTeclaDeVuelo('ShiftRight', false)).toBe(true);
    expect(esTeclaDeVuelo('KeyZ', true)).toBe(false);
    expect(esTeclaDeVuelo('Escape', true)).toBe(false);
  });

  it('las Ctrl son de vuelo sólo con el teclado bloqueado; la C, siempre', () => {
    expect(esTeclaDeVuelo('ControlLeft', true)).toBe(true);
    expect(esTeclaDeVuelo('ControlRight', true)).toBe(true);
    expect(esTeclaDeVuelo('ControlLeft', false)).toBe(false);
    expect(esTeclaDeVuelo('ControlRight', false)).toBe(false);
    expect(esTeclaDeVuelo('KeyC', false)).toBe(true);
  });
});

describe('teclas de vuelo — manda la última', () => {
  it('con A sostenida, D manda; al soltar D vuelve A', () => {
    expect(ejesDeTeclas(secuencia('+KeyA')).roll).toBe(-0.5);
    expect(ejesDeTeclas(secuencia('+KeyA', '+KeyD')).roll).toBe(0.5);
    expect(ejesDeTeclas(secuencia('+KeyA', '+KeyD', '-KeyD')).roll).toBe(-0.5);
  });

  it('soltar la de abajo de la pila deja mandando la de arriba', () => {
    expect(ejesDeTeclas(secuencia('+KeyA', '+KeyD', '-KeyA')).roll).toBe(0.5);
    expect(ejesDeTeclas(secuencia('+KeyA', '+KeyD', '-KeyA', '-KeyD')).roll).toBe(0);
  });

  it('Espacio y Ctrl se pelean igual: manda la última apretada', () => {
    expect(ejesDeTeclas(secuencia('+Space', '+ControlLeft')).throttle).toBe(-0.5);
    expect(ejesDeTeclas(secuencia('+Space', '+ControlLeft', '-ControlLeft')).throttle).toBe(0.5);
    // C y Ctrl bajan las dos: soltar una con la otra sostenida sigue bajando.
    expect(ejesDeTeclas(secuencia('+KeyC', '+ControlRight', '-KeyC')).throttle).toBe(-0.5);
  });

  it('cada eje tiene su propia pila: avanzar no se pelea con girar', () => {
    expect(ejesDeTeclas(secuencia('+KeyW', '+KeyQ', '+KeyS'))).toEqual({ pitch: -0.5, roll: 0, yaw: -0.5, throttle: 0 });
  });

  it('la repetición automática no reordena la pila ni crea un estado nuevo', () => {
    const conDos = secuencia('+KeyA', '+KeyD');
    // El sistema repite el keydown de A mientras sigue sostenida: no la pone
    // por delante de D, que se apretó después.
    const repetida = apretarTecla(conDos, 'KeyA');
    expect(repetida).toBe(conDos);
    expect(ejesDeTeclas(repetida).roll).toBe(0.5);
    expect(apretarTecla(secuencia('+ShiftLeft'), 'ShiftLeft').rapidas).toEqual(['ShiftLeft']);
  });

  it('una tecla ajena o un keyup sin keydown devuelven el mismo estado', () => {
    const estado = secuencia('+KeyW');
    expect(apretarTecla(estado, 'KeyZ')).toBe(estado);
    expect(soltarTecla(estado, 'KeyZ')).toBe(estado);
    expect(soltarTecla(estado, 'KeyS')).toBe(estado);
    expect(soltarTecla(estado, 'ShiftLeft')).toBe(estado);
  });
});

describe('useTecladoDeVuelo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function montar(props: Partial<Parameters<typeof useTecladoDeVuelo>[0]> = {}) {
    const onMando = vi.fn<(ejes: Ejes) => boolean>(() => true);
    const inicial = { activo: true, inerte: false, onMando, giroExtra: 0, ...props };
    const hook = renderHook((p: Parameters<typeof useTecladoDeVuelo>[0]) => useTecladoDeVuelo(p), {
      initialProps: inicial,
    });
    return { ...hook, onMando, inicial };
  }

  const apretar = (code: string) => fireEvent.keyDown(window, { code });
  const soltar = (code: string) => fireEvent.keyUp(window, { code });

  it('emite en el acto, sigue a 10 Hz y al soltar manda un único cero', () => {
    const { onMando } = montar();
    apretar('KeyW');
    expect(onMando).toHaveBeenCalledTimes(1);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });

    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenCalledTimes(11);

    soltar('KeyW');
    expect(onMando).toHaveBeenCalledTimes(12);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);

    // En reposo no se repite el cero: el dron ya quedó estacionario.
    act(() => vi.advanceTimersByTime(2000));
    expect(onMando).toHaveBeenCalledTimes(12);
  });

  it('el cambio de una tecla sale en el tick siguiente, sin reiniciar el ritmo', () => {
    const { onMando } = montar();
    apretar('KeyW');
    act(() => vi.advanceTimersByTime(50));
    apretar('ShiftLeft');
    expect(onMando).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(50));
    expect(onMando).toHaveBeenCalledTimes(2);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });
  });

  it('ataja las teclas de vuelo (Espacio no aprieta el botón enfocado) y deja pasar el resto', () => {
    montar();
    const espacioAbajo = new KeyboardEvent('keydown', { code: 'Space', cancelable: true });
    const espacioArriba = new KeyboardEvent('keyup', { code: 'Space', cancelable: true });
    const tab = new KeyboardEvent('keydown', { code: 'Tab', cancelable: true });
    act(() => {
      window.dispatchEvent(espacioAbajo);
      window.dispatchEvent(espacioArriba);
      window.dispatchEvent(tab);
    });
    expect(espacioAbajo.defaultPrevented).toBe(true);
    expect(espacioArriba.defaultPrevented).toBe(true);
    expect(tab.defaultPrevented).toBe(false);
    const tabArriba = new KeyboardEvent('keyup', { code: 'Tab', cancelable: true });
    act(() => {
      window.dispatchEvent(tabArriba);
    });
    expect(tabArriba.defaultPrevented).toBe(false);
  });

  it('informa la velocidad elegida', () => {
    const { result } = montar();
    expect(result.current.rapido).toBe(false);
    apretar('ShiftRight');
    expect(result.current.rapido).toBe(true);
    soltar('ShiftRight');
    expect(result.current.rapido).toBe(false);
  });

  it('si la ventana pierde el foco, suelta todo y manda el cero', () => {
    const { onMando, result } = montar();
    apretar('KeyD');
    apretar('Space');
    expect(result.current.ejes).toEqual({ pitch: 0, roll: 0.5, yaw: 0, throttle: 0.5 });

    fireEvent.blur(window);
    expect(result.current.ejes).toEqual(EJES_EN_CERO);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    // Y el keyup que llegue después no resucita nada.
    soltar('KeyD');
    expect(result.current.ejes).toEqual(EJES_EN_CERO);
  });

  it('si la pestaña se oculta, suelta todo; si vuelve a verse, no hace nada', () => {
    const { onMando, result } = montar();
    apretar('KeyS');
    const visibilidad = vi.spyOn(document, 'visibilityState', 'get');
    visibilidad.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(result.current.ejes.pitch).toBe(-0.5);

    visibilidad.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(result.current.ejes).toEqual(EJES_EN_CERO);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    visibilidad.mockRestore();
  });

  it('inactivo no escucha ni comanda; al desactivarse con teclas sostenidas manda el cero', () => {
    const { onMando, rerender, inicial, result } = montar({ activo: false });
    apretar('KeyW');
    expect(onMando).not.toHaveBeenCalled();

    rerender({ ...inicial, activo: true });
    apretar('KeyW');
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });

    // Un diálogo encima: deja de escuchar y el dron queda estacionario.
    rerender({ ...inicial, activo: false });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    expect(result.current.ejes).toEqual(EJES_EN_CERO);
  });

  it('inerte, los ejes van en cero; al levantarse el impedimento, lo sostenido se olvida', () => {
    const { onMando, rerender, inicial, result } = montar({ inerte: true });
    apretar('KeyW');
    expect(result.current.ejes).toEqual(EJES_EN_CERO);
    expect(onMando).not.toHaveBeenCalled();

    // El dron terminó de despegar con W apretada: no sale disparado solo.
    rerender({ ...inicial, inerte: false });
    expect(result.current.ejes).toEqual(EJES_EN_CERO);
    expect(onMando).not.toHaveBeenCalled();
  });

  it('la repetición automática no vuelve a meter una tecla que se olvidó al levantarse el impedimento', () => {
    const { onMando, rerender, inicial, result } = montar({ inerte: true });
    apretar('KeyW');
    // El dron terminó de despegar con W todavía sostenida: el sistema sigue
    // mandando keydown repetidos de W, y ninguno puede hacerlo avanzar.
    rerender({ ...inicial, inerte: false });
    const repetida = new KeyboardEvent('keydown', { code: 'KeyW', repeat: true, cancelable: true });
    act(() => {
      window.dispatchEvent(repetida);
    });
    // Se ataja igual: la repetición de Espacio tampoco puede apretar un botón.
    expect(repetida.defaultPrevented).toBe(true);
    expect(result.current.ejes).toEqual(EJES_EN_CERO);
    expect(onMando).not.toHaveBeenCalled();

    // Recién soltarla y volver a apretarla vuela.
    soltar('KeyW');
    apretar('KeyW');
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
  });

  it('tampoco la de una tecla que se soltó al abrirse un diálogo', () => {
    const { onMando, rerender, inicial, result } = montar();
    apretar('KeyD');
    rerender({ ...inicial, activo: false });
    rerender({ ...inicial, activo: true });
    fireEvent.keyDown(window, { code: 'KeyD', repeat: true });
    expect(result.current.ejes).toEqual(EJES_EN_CERO);
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('suma los sticks virtuales a las teclas, eje por eje, por el mismo emisor', () => {
    const { onMando, rerender, inicial } = montar();
    // Un stick solo también comanda: sale en el acto, como una tecla.
    rerender({ ...inicial, sticks: { ...EJES_EN_CERO, roll: -0.6 } });
    expect(onMando).toHaveBeenCalledTimes(1);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, roll: -0.6 });

    // W sostenida mientras se arrastra: avanzar Y subir, y el avance del stick
    // se suma al de la tecla (0,5 + 0,8, recortado a 1).
    apretar('KeyW');
    rerender({ ...inicial, sticks: { ...EJES_EN_CERO, pitch: 0.8, throttle: 1 } });
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenCalledTimes(11);
    expect(onMando).toHaveBeenLastCalledWith({ pitch: 1, roll: 0, yaw: 0, throttle: 1 });

    // El stick vuelve al centro: queda la tecla, en el tick siguiente.
    rerender({ ...inicial, sticks: EJES_EN_CERO });
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
    soltar('KeyW');
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('suma el giro del mouse al de Q/E por el mismo emisor', () => {
    const { onMando, rerender, inicial } = montar({ giroExtra: 0.3 });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, yaw: 0.3 });
    apretar('KeyE');
    act(() => vi.advanceTimersByTime(100));
    // 0,5 de la tecla más 0,3 del mouse.
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, yaw: 0.8 });
    soltar('KeyE');
    rerender({ ...inicial, giroExtra: 0 });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('si el mensaje no sale, lo dice; el aviso se limpia cuando se levanta el impedimento', () => {
    const { onMando, result, rerender, inicial } = montar();
    onMando.mockReturnValue(false);
    apretar('KeyW');
    expect(result.current.ultimoSalio).toBe(false);

    rerender({ ...inicial, inerte: true });
    rerender({ ...inicial, inerte: false });
    expect(result.current.ultimoSalio).toBe(true);
  });

  it('al desmontar con una tecla sostenida, el último mensaje es el cero', () => {
    const { onMando, unmount } = montar();
    apretar('KeyQ');
    unmount();
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('sin el teclado bloqueado (por defecto), Ctrl no baja ni se ataja, ni sostenida; la C sí baja', () => {
    const { onMando, result } = montar();
    const abajo = new KeyboardEvent('keydown', { code: 'ControlLeft', cancelable: true });
    const repetida = new KeyboardEvent('keydown', { code: 'ControlLeft', repeat: true, cancelable: true });
    act(() => {
      window.dispatchEvent(abajo);
      window.dispatchEvent(repetida);
    });
    act(() => vi.advanceTimersByTime(500));
    // Ctrl queda para el navegador: si la página la atajara igual no podría
    // frenar Ctrl+W, y el dron bajaría con cada atajo.
    expect(abajo.defaultPrevented).toBe(false);
    expect(repetida.defaultPrevented).toBe(false);
    expect(result.current.ejes).toEqual(EJES_EN_CERO);
    expect(onMando).not.toHaveBeenCalled();
    const arriba = new KeyboardEvent('keyup', { code: 'ControlLeft', cancelable: true });
    act(() => {
      window.dispatchEvent(arriba);
    });
    expect(arriba.defaultPrevented).toBe(false);

    apretar('KeyC');
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: -0.5 });
  });

  it('con el teclado bloqueado, Ctrl baja y se ataja', () => {
    const { onMando } = montar({ ctrlBaja: true });
    const abajo = new KeyboardEvent('keydown', { code: 'ControlRight', cancelable: true });
    act(() => {
      window.dispatchEvent(abajo);
    });
    expect(abajo.defaultPrevented).toBe(true);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: -0.5 });
    soltar('ControlRight');
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('si el bloqueo se pierde con Ctrl sostenida, deja de bajar; lo demás sigue', () => {
    const { onMando, rerender, inicial, result } = montar({ ctrlBaja: true });
    apretar('KeyW');
    apretar('ControlLeft');
    expect(result.current.ejes).toEqual({ ...EJES_EN_CERO, pitch: 0.5, throttle: -0.5 });

    // Se salió de la pantalla completa: el keyup de esa Ctrl ya no es de la vista.
    rerender({ ...inicial, ctrlBaja: false });
    expect(result.current.ejes).toEqual({ ...EJES_EN_CERO, pitch: 0.5 });
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });

    // Y si el bloqueo vuelve, la Ctrl que quedó apretada no baja sola: hay que
    // volver a apretarla (la repetición automática no cuenta).
    rerender({ ...inicial, ctrlBaja: true });
    fireEvent.keyDown(window, { code: 'ControlLeft', repeat: true });
    expect(result.current.ejes).toEqual({ ...EJES_EN_CERO, pitch: 0.5 });
  });
});
