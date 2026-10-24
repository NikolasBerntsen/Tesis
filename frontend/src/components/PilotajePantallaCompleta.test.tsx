import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
import { limpiarEstadoMapa } from '../test/dobleLeaflet';
import { makeAlert, makeStatus } from '../test/fixtures';
import { CONTROLES_POR_DEFECTO } from '../preferenciasDeControl';
import { EJES_EN_CERO, type Ejes } from './MandoVirtual';
import PilotajePantallaCompleta from './PilotajePantallaCompleta';

/*
 * jsdom no tiene pantalla completa, ni captura del puntero, ni Keyboard Lock.
 * Los dobles de abajo se portan como Chromium: pedir la pantalla completa la
 * pone y avisa con `fullscreenchange`; pedir la captura la pone y avisa con
 * `pointerlockchange`. Así se prueba lo que hace la vista con cada cambio, que
 * es lo que importa, y cada test puede romperlos a su gusto para probar el
 * navegador que se niega.
 *
 * El bloqueo del teclado queda esperando la respuesta del navegador hasta que
 * el test la da con `cumplirBloqueo` o `negarBloqueo`: lo que cambia con él
 * (si Ctrl baja) depende de esa respuesta, y así cada test elige cuándo llega.
 */
let enPantallaCompleta: Element | null = null;
let capturado: Element | null = null;
let cumplirBloqueo: () => void = () => {};
let negarBloqueo: () => void = () => {};
const teclado = {
  lock: vi.fn(
    () =>
      new Promise<void>((cumplir, negar) => {
        cumplirBloqueo = cumplir;
        negarBloqueo = () => negar(new DOMException('No se pudo bloquear', 'AbortError'));
      }),
  ),
  unlock: vi.fn(),
};

/** El navegador contesta el pedido de bloqueo, y la vista se entera. */
async function contestarBloqueo(cumplido: boolean) {
  await act(async () => {
    if (cumplido) cumplirBloqueo();
    else negarBloqueo();
  });
}

function avisar(evento: string) {
  act(() => {
    document.dispatchEvent(new Event(evento));
  });
}

const pedirPantalla = vi.fn(function (this: Element) {
  enPantallaCompleta = this;
  document.dispatchEvent(new Event('fullscreenchange'));
  return Promise.resolve();
});
const salirDePantalla = vi.fn(() => {
  enPantallaCompleta = null;
  document.dispatchEvent(new Event('fullscreenchange'));
  return Promise.resolve();
});
const pedirCaptura = vi.fn(function (this: Element) {
  capturado = this;
  document.dispatchEvent(new Event('pointerlockchange'));
  return Promise.resolve();
});
const soltarCaptura = vi.fn(() => {
  capturado = null;
  document.dispatchEvent(new Event('pointerlockchange'));
});

beforeEach(() => {
  limpiarEstadoMapa();
  enPantallaCompleta = null;
  capturado = null;
  Object.defineProperty(document, 'fullscreenElement', { get: () => enPantallaCompleta, configurable: true });
  Object.defineProperty(document, 'pointerLockElement', { get: () => capturado, configurable: true });
  HTMLElement.prototype.requestFullscreen = pedirPantalla as unknown as HTMLElement['requestFullscreen'];
  HTMLElement.prototype.requestPointerLock = pedirCaptura as unknown as HTMLElement['requestPointerLock'];
  document.exitFullscreen = salirDePantalla as unknown as Document['exitFullscreen'];
  document.exitPointerLock = soltarCaptura;
  Object.defineProperty(navigator, 'keyboard', { value: teclado, configurable: true });
  for (const doble of [pedirPantalla, salirDePantalla, pedirCaptura, soltarCaptura, teclado.lock, teclado.unlock]) {
    doble.mockClear();
  }
});

afterEach(() => {
  vi.useRealTimers();
  // Lo que jsdom no tiene se vuelve a sacar: otros archivos de test prueban
  // justamente el navegador sin estas APIs.
  const proto = HTMLElement.prototype as Partial<HTMLElement>;
  delete proto.requestFullscreen;
  delete proto.requestPointerLock;
  const doc = document as Partial<Document> & Record<string, unknown>;
  delete doc.exitFullscreen;
  delete doc.exitPointerLock;
  delete doc.fullscreenElement;
  delete doc.pointerLockElement;
  delete (navigator as unknown as Record<string, unknown>).keyboard;
});

type Props = Parameters<typeof PilotajePantallaCompleta>[0];

function montar(cambios: Partial<Props> = {}) {
  const props: Props = {
    nombre: 'Alfa',
    droneId: 'd1',
    enLinea: true,
    status: makeStatus({ state: 'MANUAL', controlledBy: 'oper1', flying: true, alt: 12.34, heading: 90, battery: 76 }),
    frame: null,
    alertas: [],
    controlTomado: true,
    impedimento: null,
    camaraDisponible: true,
    esperandoConfirmacion: false,
    enElSuelo: false,
    enElAire: true,
    avisoDeOrden: null,
    error: '',
    hayObjetivo: false,
    suspendido: false,
    onMando: vi.fn<(ejes: Ejes) => boolean>(() => true),
    onCamara: vi.fn<(pitch: number) => boolean>(() => true),
    onOrden: vi.fn(),
    onCerrar: vi.fn(),
    onSalir: vi.fn(),
    onDevolverFoco: vi.fn(),
    ...cambios,
  };
  const resultado = render(<PilotajePantallaCompleta {...props} />);
  const vista = screen.getByRole('dialog', { name: 'Pilotaje de Alfa' });
  const video = screen.getByTestId('pilotaje-video');
  // jsdom no maqueta: la imagen mide 200×100 a partir del borde de la pantalla.
  video.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const volverARenderizar = (otros: Partial<Props>) => resultado.rerender(<PilotajePantallaCompleta {...props} {...otros} />);
  return { ...props, ...resultado, vista, video, volverARenderizar };
}

const hud = (dato: string) => screen.getByTestId(`hud-${dato}`).textContent;

/** Una muesca de rueda: hacia arriba es deltaY negativo. */
function rueda(elemento: Element, muescas: number, init: WheelEventInit = {}) {
  return fireEvent.wheel(elemento, { deltaY: muescas * 100, deltaMode: 0, ...init });
}

/** Un movimiento del mouse con la captura puesta: sólo trae `movementX/Y`. */
function moverMouse(dx: number, dy: number) {
  const ev = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(ev, 'movementX', { value: dx });
  Object.defineProperty(ev, 'movementY', { value: dy });
  act(() => {
    document.dispatchEvent(ev);
  });
}

describe('PilotajePantallaCompleta — pantalla completa', () => {
  it('se pone en pantalla completa al abrir, bloquea el teclado y no ofrece el botón', () => {
    const { vista } = montar();
    expect(pedirPantalla).toHaveBeenCalledTimes(1);
    expect(pedirPantalla.mock.contexts[0]).toBe(vista);
    expect(teclado.lock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Pantalla completa' })).not.toBeInTheDocument();
    // El foco entra a la vista: el teclado vuela desde el primer momento.
    expect(vista).toHaveFocus();
  });

  it('si se sale de la pantalla completa, desbloquea el teclado, sigue tapando todo y ofrece volver', () => {
    montar();
    act(() => {
      void document.exitFullscreen();
    });
    expect(teclado.unlock).toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Pilotaje de Alfa' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pantalla completa' }));
    expect(pedirPantalla).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Pantalla completa' })).not.toBeInTheDocument();
  });

  it('si el navegador la niega, la vista queda igual y ofrece el botón', async () => {
    pedirPantalla.mockImplementationOnce(() => Promise.reject(new Error('Permissions check failed')));
    montar();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Pantalla completa' })).toBeInTheDocument();
    expect(teclado.lock).not.toHaveBeenCalled();
  });

  it('un navegador sin pantalla completa ni Keyboard Lock no rompe nada', () => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
    delete (navigator as unknown as Record<string, unknown>).keyboard;
    montar();
    expect(screen.getByRole('button', { name: 'Pantalla completa' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pantalla completa' }));
    expect(screen.getByRole('dialog', { name: 'Pilotaje de Alfa' })).toBeInTheDocument();
  });

  it('una API que tira en el acto tampoco', () => {
    pedirPantalla.mockImplementationOnce(() => {
      throw new TypeError('no permitido');
    });
    montar();
    expect(screen.getByRole('button', { name: 'Pantalla completa' })).toBeInTheDocument();
  });

  it('al cerrarse suelta la pantalla completa, la captura y el teclado', () => {
    const { unmount } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    expect(capturado).not.toBeNull();
    unmount();
    expect(soltarCaptura).toHaveBeenCalled();
    expect(salirDePantalla).toHaveBeenCalled();
    expect(teclado.unlock).toHaveBeenCalled();
    expect(enPantallaCompleta).toBeNull();
  });

  it('mientras está abierta, lo de atrás queda inerte; al cerrarse vuelve', () => {
    const atras = document.createElement('div');
    const yaInerte = document.createElement('div');
    yaInerte.setAttribute('inert', '');
    document.body.append(atras, yaInerte);
    const { unmount, vista } = montar();
    expect(atras).toHaveAttribute('inert');
    expect(vista).not.toHaveAttribute('inert');
    unmount();
    expect(atras).not.toHaveAttribute('inert');
    // Lo que ya estaba inerte por otro motivo no se toca.
    expect(yaInerte).toHaveAttribute('inert');
    atras.remove();
    yaInerte.remove();
  });
});

describe('PilotajePantallaCompleta — HUD', () => {
  it('muestra velocidad, altura, batería, rumbo, cámara y zoom', () => {
    montar();
    expect(hud('velocidad')).toBe('Normal');
    expect(hud('altura')).toBe('12.3 m');
    expect(hud('bateria')).toBe('76 %');
    expect(hud('rumbo')).toBe('90° E');
    // Una app vieja no informa la cámara: se supone -30°.
    expect(hud('camara')).toBe('-30°');
    expect(hud('zoom')).toBe('1×');
  });

  it('sin status no inventa nada', () => {
    montar({ status: null });
    expect(hud('altura')).toBe('—');
    expect(hud('bateria')).toBe('—');
    expect(hud('rumbo')).toBe('—');
    expect(screen.getByTestId('minimapa-sin-gps')).toHaveTextContent('Sin GPS');
  });

  it('la cámara arranca donde la informa el dron', () => {
    montar({ status: makeStatus({ gimbalPitch: -55 }) });
    expect(hud('camara')).toBe('-55°');
  });

  it('con Shift sostenida dice "Rápido"', () => {
    montar();
    fireEvent.keyDown(window, { code: 'ShiftLeft' });
    expect(hud('velocidad')).toBe('Rápido');
    fireEvent.keyUp(window, { code: 'ShiftLeft' });
    expect(hud('velocidad')).toBe('Normal');
  });

  it('muestra el video a pantalla completa cuando hay imagen', () => {
    montar({ frame: 'QUFB' });
    expect(screen.getByAltText('Cámara de Alfa')).toHaveAttribute('src', 'data:image/jpeg;base64,QUFB');
    expect(screen.queryByText('Sin señal de video')).not.toBeInTheDocument();
  });

  it('el minimapa sigue al dron y su flecha gira con el rumbo', () => {
    montar();
    expect(screen.getByRole('img', { name: 'El dron, mirando a 90° E' })).toBeInTheDocument();
  });

  it('dice por qué el mando no responde', () => {
    montar({ impedimento: 'El dron está en el suelo: despegalo para usar el mando.' });
    expect(screen.getByTestId('pilotaje-impedimento')).toHaveTextContent('El dron está en el suelo');
  });

  it('mientras el Comando Central no confirma el control, lo dice y el teclado espera', () => {
    const { onMando } = montar({ controlTomado: false });
    expect(screen.getByTestId('pilotaje-esperando-control')).toBeInTheDocument();
    fireEvent.keyDown(window, { code: 'KeyW' });
    expect(onMando).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Modo mouse' })).toBeDisabled();
  });

  it('avisa la espera de la confirmación del vuelo manual y la orden en curso', () => {
    montar({ esperandoConfirmacion: true, avisoDeOrden: 'Despegue ordenado: ya va.' });
    expect(screen.getByTestId('pilotaje-esperando')).toHaveTextContent(/todavía no confirmó el vuelo manual/);
    expect(screen.getByTestId('pilotaje-orden-en-curso')).toHaveTextContent('Despegue ordenado: ya va.');
  });

  it('si el último comando no salió de la consola, lo avisa', () => {
    montar({ onMando: vi.fn(() => false) });
    fireEvent.keyDown(window, { code: 'KeyW' });
    expect(screen.getByTestId('pilotaje-no-salio')).toHaveAttribute('role', 'alert');
  });

  it('si el backend rechazó la orden, el motivo se lee adentro de la vista', () => {
    const { vista } = montar({ error: 'El dron rechazó el despegue' });
    const error = screen.getByTestId('pilotaje-error');
    expect(error).toHaveTextContent('El dron rechazó el despegue');
    expect(error).toHaveAttribute('role', 'alert');
    expect(vista.contains(error)).toBe(true);
  });

  it('sin error no hay aviso de error', () => {
    montar();
    expect(screen.queryByTestId('pilotaje-error')).not.toBeInTheDocument();
  });
});

describe('PilotajePantallaCompleta — teclado', () => {
  it('W avanza a velocidad intermedia y Shift la lleva a fondo, por el mismo onMando', () => {
    vi.useFakeTimers();
    const { onMando } = montar();
    fireEvent.keyDown(window, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
    fireEvent.keyDown(window, { code: 'ShiftRight' });
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 1 });
    fireEvent.keyUp(window, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('con el teclado bloqueado en pantalla completa, Ctrl y C bajan', async () => {
    const { onMando } = montar();
    await contestarBloqueo(true);
    const ctrl = new KeyboardEvent('keydown', { code: 'ControlLeft', cancelable: true });
    act(() => {
      window.dispatchEvent(ctrl);
    });
    // Con el bloqueo la página recibe Ctrl+W: atajarla no cierra la pestaña.
    expect(ctrl.defaultPrevented).toBe(true);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: -0.5 });
    fireEvent.keyUp(window, { code: 'ControlLeft' });
    fireEvent.keyDown(window, { code: 'KeyC' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: -0.5 });
  });

  /**
   * Sin el bloqueo el navegador se queda con Ctrl+W aunque la página la ataje:
   * bajar con Ctrl mientras se avanzaba con W cerraba la pestaña en pleno vuelo.
   */
  const SIN_BLOQUEO = [
    { caso: 'mientras el navegador no contestó el pedido de bloqueo', preparar: async () => {} },
    { caso: 'si el navegador niega el bloqueo', preparar: () => contestarBloqueo(false) },
    {
      caso: 'en un navegador sin Keyboard Lock (Firefox, Safari)',
      antes: () => delete (navigator as unknown as Record<string, unknown>).keyboard,
      preparar: async () => {},
    },
    {
      caso: 'si el navegador no dejó poner la pantalla completa',
      antes: () => pedirPantalla.mockImplementationOnce(() => Promise.reject(new Error('Permissions check failed'))),
      preparar: async () => {},
    },
  ];

  it.each(SIN_BLOQUEO)('$caso, Ctrl no baja ni se ataja, y la C sí baja', async ({ antes, preparar }) => {
    antes?.();
    const { onMando } = montar();
    await preparar();
    const ctrl = new KeyboardEvent('keydown', { code: 'ControlRight', cancelable: true });
    act(() => {
      window.dispatchEvent(ctrl);
    });
    // Sostenida tampoco: la repetición automática no hace nada.
    fireEvent.keyDown(window, { code: 'ControlRight', repeat: true });
    expect(ctrl.defaultPrevented).toBe(false);
    expect(onMando).not.toHaveBeenCalled();
    fireEvent.keyUp(window, { code: 'ControlRight' });

    fireEvent.keyDown(window, { code: 'KeyC' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: -0.5 });
  });

  it('al salir de la pantalla completa Ctrl deja de bajar, aunque esté sostenida', async () => {
    const { onMando } = montar();
    await contestarBloqueo(true);
    vi.useFakeTimers();
    fireEvent.keyDown(window, { code: 'ControlLeft' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: -0.5 });

    act(() => {
      void document.exitFullscreen();
    });
    // El dron queda estacionario: esa Ctrl ya no es de la vista.
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    fireEvent.keyDown(window, { code: 'ControlLeft' });
    act(() => vi.advanceTimersByTime(500));
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('un bloqueo que llega cuando ya se salió de la pantalla completa no vale, ni al volver a ella', async () => {
    const { onMando } = montar();
    act(() => {
      void document.exitFullscreen();
    });
    await contestarBloqueo(true);
    fireEvent.keyDown(window, { code: 'ControlLeft' });
    expect(onMando).not.toHaveBeenCalled();
    fireEvent.keyUp(window, { code: 'ControlLeft' });

    // De nuevo en pantalla completa: el pedido nuevo todavía no tiene respuesta,
    // y la del viejo no lo reemplaza.
    fireEvent.click(screen.getByRole('button', { name: 'Pantalla completa' }));
    expect(teclado.lock).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { code: 'ControlLeft' });
    expect(onMando).not.toHaveBeenCalled();
    fireEvent.keyUp(window, { code: 'ControlLeft' });

    await contestarBloqueo(true);
    fireEvent.keyDown(window, { code: 'ControlLeft' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: -0.5 });
  });

  it('con un diálogo del detalle encima el teclado no vuela', () => {
    const { onMando, volverARenderizar } = montar();
    fireEvent.keyDown(window, { code: 'KeyW' });
    volverARenderizar({ suspendido: true });
    // Se soltó todo al abrirse el diálogo: el dron queda estacionario.
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    const llamadas = onMando.mock.calls.length;
    fireEvent.keyDown(window, { code: 'KeyD' });
    expect(onMando).toHaveBeenCalledTimes(llamadas);
  });

  it('con un impedimento el teclado no comanda', () => {
    const { onMando } = montar({ impedimento: 'Sin conexión con el Comando Central: el mando no responde.' });
    fireEvent.keyDown(window, { code: 'KeyW' });
    expect(onMando).not.toHaveBeenCalled();
  });

  it('al cerrarse con una tecla sostenida, el último mensaje es el cero', () => {
    const { onMando, unmount } = montar();
    fireEvent.keyDown(window, { code: 'KeyA' });
    unmount();
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });
});

describe('PilotajePantallaCompleta — cámara con la rueda', () => {
  it('cada muesca inclina 5°: hacia arriba sube, hacia abajo baja', () => {
    vi.useFakeTimers();
    const { video, onCamara } = montar();
    expect(rueda(video, -1)).toBe(false); // preventDefault: la página de atrás no se desplaza
    expect(onCamara).toHaveBeenLastCalledWith(-25);
    expect(hud('camara')).toBe('-25°');

    act(() => vi.advanceTimersByTime(200));
    rueda(video, 1);
    expect(onCamara).toHaveBeenLastCalledWith(-30);
  });

  it('respeta los topes del contrato y en el tope no manda nada', () => {
    vi.useFakeTimers();
    const { video, onCamara } = montar({ status: makeStatus({ gimbalPitch: 28 }) });
    rueda(video, -1);
    expect(onCamara).toHaveBeenLastCalledWith(30);
    act(() => vi.advanceTimersByTime(200));
    rueda(video, -1);
    expect(onCamara).toHaveBeenCalledTimes(1);
    expect(hud('camara')).toBe('30°');
  });

  it('a lo sumo 10 por segundo, y sale la última inclinación pedida', () => {
    vi.useFakeTimers();
    const { video, onCamara } = montar();
    rueda(video, 1);
    rueda(video, 1);
    rueda(video, 1);
    // La primera sale en el acto; las otras dos esperan el resto de los 100 ms.
    expect(onCamara).toHaveBeenCalledTimes(1);
    expect(onCamara).toHaveBeenLastCalledWith(-35);
    act(() => vi.advanceTimersByTime(100));
    expect(onCamara).toHaveBeenCalledTimes(2);
    expect(onCamara).toHaveBeenLastCalledWith(-45);
    act(() => vi.advanceTimersByTime(1000));
    expect(onCamara).toHaveBeenCalledTimes(2);
  });

  it('si la vista se cierra con una inclinación esperando su turno, no sale después', () => {
    vi.useFakeTimers();
    const { video, onCamara, unmount } = montar();
    rueda(video, 1);
    rueda(video, 1);
    unmount();
    act(() => vi.advanceTimersByTime(500));
    // La que esperaba no sale con la vista cerrada: el control ya se soltó.
    expect(onCamara).toHaveBeenCalledTimes(1);
  });

  it('el touchpad suma pedacitos hasta una muesca', () => {
    const { video, onCamara } = montar();
    rueda(video, -0.3);
    rueda(video, -0.3);
    rueda(video, -0.3);
    expect(onCamara).not.toHaveBeenCalled();
    rueda(video, -0.3);
    expect(onCamara).toHaveBeenLastCalledWith(-25);
  });

  it('sin el control, o con la cámara impedida, la rueda no mueve la cámara', () => {
    const sinControl = montar({ controlTomado: false });
    expect(rueda(sinControl.video, -1)).toBe(false);
    expect(sinControl.onCamara).not.toHaveBeenCalled();
    sinControl.unmount();

    const impedida = montar({ camaraDisponible: false });
    rueda(impedida.video, -1);
    expect(impedida.onCamara).not.toHaveBeenCalled();
    expect(hud('camara')).toBe('-30°');
  });

  it('la rueda sobre un panel del HUD no es de la cámara', () => {
    const { onCamara } = montar();
    // No se ataja: la rueda sobre el HUD no es un gesto sobre la imagen.
    expect(rueda(screen.getByTestId('hud-zoom'), -1)).toBe(true);
    expect(onCamara).not.toHaveBeenCalled();
  });

  it('lo que informa el dron manda cuando el operador no está moviendo la cámara', () => {
    vi.useFakeTimers();
    const { video, volverARenderizar } = montar({ status: makeStatus({ gimbalPitch: -30 }) });
    rueda(video, -1);
    expect(hud('camara')).toBe('-25°');
    // El status de hace un segundo todavía dice -30: no le gana al gesto.
    volverARenderizar({ status: makeStatus({ gimbalPitch: -28 }) });
    expect(hud('camara')).toBe('-25°');

    act(() => vi.advanceTimersByTime(2500));
    volverARenderizar({ status: makeStatus({ gimbalPitch: -40 }) });
    expect(hud('camara')).toBe('-40°');
  });

  it('si la cámara hace tope antes y el dron informa siempre lo mismo, el HUD se corrige igual', () => {
    vi.useFakeTimers();
    const { video, onCamara, volverARenderizar } = montar({ status: makeStatus({ gimbalPitch: 0 }) });
    // El operador sube la cámara hasta el tope del contrato...
    for (let i = 0; i < 6; i += 1) rueda(video, -1);
    expect(hud('camara')).toBe('30°');

    // ...pero la Mini no mira arriba del horizonte: informa 0 adentro de la
    // espera (no le gana al gesto) y sigue informando 0 después.
    volverARenderizar({ status: makeStatus({ gimbalPitch: 0 }) });
    expect(hud('camara')).toBe('30°');
    act(() => vi.advanceTimersByTime(2500));
    volverARenderizar({ status: makeStatus({ gimbalPitch: 0 }) });
    expect(hud('camara')).toBe('0°');

    // Y la muesca siguiente parte de donde está la cámara de verdad.
    rueda(video, 1);
    expect(onCamara).toHaveBeenLastCalledWith(-5);
    expect(hud('camara')).toBe('-5°');
  });

  it('un status sin la inclinación (una app vieja) no toca lo que muestra el HUD', () => {
    vi.useFakeTimers();
    const { video, volverARenderizar } = montar();
    rueda(video, -1);
    act(() => vi.advanceTimersByTime(2500));
    volverARenderizar({ status: makeStatus({}) });
    expect(hud('camara')).toBe('-25°');
  });
});

describe('PilotajePantallaCompleta — zoom con el botón derecho', () => {
  it('apretar el derecho hace 2× donde está el puntero, la rueda lo cambia y soltarlo vuelve a 1×', () => {
    const { video, onCamara } = montar();
    const encuadre = screen.getByTestId('pilotaje-encuadre');

    fireEvent.mouseDown(video, { button: 2, clientX: 50, clientY: 25 });
    expect(encuadre.style.transform).toBe('scale(2)');
    expect(encuadre.style.transformOrigin).toBe('25% 25%');
    expect(hud('zoom')).toBe('2×');

    // Con el derecho apretado la rueda es del zoom, no de la cámara.
    rueda(video, -1, { buttons: 2 });
    expect(hud('zoom')).toBe('2,5×');
    expect(onCamara).not.toHaveBeenCalled();
    for (let i = 0; i < 20; i += 1) rueda(video, -1);
    expect(hud('zoom')).toBe('8×');
    for (let i = 0; i < 20; i += 1) rueda(video, 1);
    expect(hud('zoom')).toBe('1×');

    rueda(video, -2);
    expect(hud('zoom')).toBe('2×');
    fireEvent.mouseUp(window, { button: 2 });
    expect(encuadre.style.transform).toBe('scale(1)');
    expect(hud('zoom')).toBe('1×');
  });

  it('el menú contextual no aparece sobre la vista', () => {
    const { video } = montar();
    expect(fireEvent.contextMenu(video)).toBe(false);
  });

  it('otro botón no hace zoom, y soltar otro botón no lo deshace', () => {
    const { video } = montar();
    fireEvent.mouseDown(video, { button: 0 });
    expect(hud('zoom')).toBe('1×');
    fireEvent.mouseDown(video, { button: 2, clientX: 100, clientY: 50 });
    fireEvent.mouseUp(window, { button: 0 });
    expect(hud('zoom')).toBe('2×');
  });

  it('el derecho sobre un botón del HUD no hace zoom', () => {
    montar();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Modo mouse' }), { button: 2 });
    expect(hud('zoom')).toBe('1×');
  });

  it('si la ventana pierde el foco con el derecho apretado, el zoom se va', () => {
    const { video } = montar();
    fireEvent.mouseDown(video, { button: 2, clientX: 10, clientY: 10 });
    fireEvent.blur(window);
    expect(hud('zoom')).toBe('1×');
  });

  it('una imagen sin medir hace zoom al centro', () => {
    const { video } = montar();
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
    fireEvent.mouseDown(video, { button: 2, clientX: 10, clientY: 10 });
    expect(screen.getByTestId('pilotaje-encuadre').style.transformOrigin).toBe('50% 50%');
  });
});

describe('PilotajePantallaCompleta — modo mouse', () => {
  it('captura el puntero, avisa cómo salir y Esc lo suelta', () => {
    const { vista } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    expect(pedirCaptura.mock.contexts[0]).toBe(vista);
    expect(screen.getByTestId('pilotaje-pista-mouse')).toHaveTextContent('Esc para salir del modo mouse');
    expect(screen.getByRole('button', { name: 'Modo mouse' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(soltarCaptura).toHaveBeenCalled();
    expect(screen.queryByTestId('pilotaje-pista-mouse')).not.toBeInTheDocument();
  });

  it('mover a los costados gira el dron y se apaga solo al frenar el mouse', () => {
    vi.useFakeTimers();
    const { onMando } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));

    // 6 px en un evento, con la sensibilidad por defecto, es medio giro.
    moverMouse(6, 0);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, yaw: 0.5 });
    expect(onMando).toHaveBeenCalledTimes(1);
    // Para el otro lado: el giro sigue al mouse y sale en el tick siguiente,
    // sin reiniciar el ritmo de 10 Hz.
    moverMouse(-50, 0);
    expect(onMando).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenCalledTimes(2);
    expect(onMando.mock.calls[1][0].yaw).toBeLessThan(0);

    // Sin movimiento, en 150 ms vuelve a cero y sale el mensaje de cierre.
    act(() => vi.advanceTimersByTime(150));
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    const llamadas = onMando.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenCalledTimes(llamadas);
  });

  it('cerrar la vista con el giro del mouse apagándose no deja nada corriendo', () => {
    vi.useFakeTimers();
    const { onMando, unmount } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    moverMouse(25, 0);
    unmount();
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    const llamadas = onMando.mock.calls.length;
    act(() => vi.advanceTimersByTime(500));
    expect(onMando).toHaveBeenCalledTimes(llamadas);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('mover arriba y abajo inclina la cámara, y el teclado sigue volando', () => {
    vi.useFakeTimers();
    const { onCamara, onMando } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));

    moverMouse(0, -50);
    // 50 px hacia arriba a 0,06 °/px: tres grados más alto.
    expect(onCamara).toHaveBeenLastCalledWith(-27);
    expect(hud('camara')).toBe('-27°');
    act(() => vi.advanceTimersByTime(200));
    moverMouse(0, 2000);
    expect(onCamara).toHaveBeenLastCalledWith(-90);

    fireEvent.keyDown(window, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
  });

  /**
   * Una fracción de grado por píxel, redondeada a la décima en cada paso, no
   * vuelve a donde estaba: con 0,15 °/px daba +0,2° por cada píxel para arriba y
   * -0,1° por cada uno para abajo, y la cámara subía sola con el pulso de la
   * mano. La cuenta va exacta y se redondea sólo lo que se ve y lo que sale.
   */
  it.each([
    { sentido: 'abajo', px: 1, ida: '-36°', idaPitch: -36 },
    { sentido: 'arriba', px: -1, ida: '-24°', idaPitch: -24 },
  ])('cien píxeles para $sentido son 6°, y volverlos deja la cámara donde estaba', ({ px, ida, idaPitch }) => {
    vi.useFakeTimers();
    const { onCamara } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    expect(hud('camara')).toBe('-30°');

    for (let i = 0; i < 100; i += 1) moverMouse(0, px);
    act(() => vi.advanceTimersByTime(200));
    expect(hud('camara')).toBe(ida);
    expect(onCamara).toHaveBeenLastCalledWith(idaPitch);

    for (let i = 0; i < 100; i += 1) moverMouse(0, -px);
    act(() => vi.advanceTimersByTime(200));
    expect(hud('camara')).toBe('-30°');
    expect(onCamara).toHaveBeenLastCalledWith(-30);
  });

  it('un temblor que no alcanza la décima no manda nada, pero cuenta para el siguiente', () => {
    const { onCamara } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    // Con la pantalla escalada el navegador entrega fracciones de píxel: 0,5 px
    // son 0,03°, que no mueven la décima.
    moverMouse(0, -0.5);
    expect(onCamara).not.toHaveBeenCalled();
    // El segundo suma 0,06°: ahora sí, y sale. Redondeando cada paso, los dos
    // se perdían.
    moverMouse(0, -0.5);
    expect(onCamara).toHaveBeenLastCalledWith(-29.9);
  });

  it('fuera del modo mouse, mover el mouse no hace nada', () => {
    const { onMando, onCamara } = montar();
    moverMouse(30, 30);
    expect(onMando).not.toHaveBeenCalled();
    expect(onCamara).not.toHaveBeenCalled();
  });

  it('el derecho en el modo mouse hace zoom al centro: no hay cursor que marque otro punto', () => {
    const { vista } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    fireEvent.mouseDown(vista, { button: 2, clientX: 10, clientY: 10 });
    expect(screen.getByTestId('pilotaje-encuadre').style.transformOrigin).toBe('50% 50%');
  });

  it('al abrirse un diálogo encima se suelta la captura, porque hace falta el cursor', () => {
    const { volverARenderizar } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    volverARenderizar({ suspendido: true });
    expect(soltarCaptura).toHaveBeenCalled();
  });

  it('si el navegador no tiene captura del puntero, lo dice', () => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).requestPointerLock;
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    expect(screen.getByTestId('pilotaje-aviso-navegador')).toHaveTextContent(/no permite esconder el cursor/);
  });

  it('si el navegador la niega, lo dice', async () => {
    pedirCaptura.mockImplementationOnce(() => Promise.reject(new Error('SecurityError')));
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    await act(async () => {});
    expect(screen.getByTestId('pilotaje-aviso-navegador')).toHaveTextContent(/no dejó esconder el cursor/);
  });

  it('si la captura tira en el acto, también lo dice', () => {
    pedirCaptura.mockImplementationOnce(() => {
      throw new Error('WrongDocumentError');
    });
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    expect(screen.getByTestId('pilotaje-aviso-navegador')).toHaveTextContent(/no dejó esconder el cursor/);
  });

  it('un navegador viejo que no devuelve promesa igual entra al modo mouse', () => {
    pedirCaptura.mockImplementationOnce(function (this: Element) {
      capturado = this;
      document.dispatchEvent(new Event('pointerlockchange'));
      return undefined as unknown as Promise<void>;
    });
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    expect(screen.getByTestId('pilotaje-pista-mouse')).toBeInTheDocument();
  });
});

describe('PilotajePantallaCompleta — sticks virtuales', () => {
  it('se muestran y se esconden con el botón, sin su propio teclado', () => {
    const { onMando } = montar();
    expect(screen.queryByRole('group', { name: 'Mando virtual de vuelo continuo' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar sticks virtuales' }));
    const mando = screen.getByRole('group', { name: 'Mando virtual de vuelo continuo' });
    expect(screen.getByRole('button', { name: 'Ocultar sticks virtuales' })).toHaveAttribute('aria-expanded', 'true');
    // El teclado del mando está apagado: W no sube, vuela con el esquema de la vista.
    expect(mando).not.toHaveAttribute('tabindex');
    fireEvent.keyDown(mando, { key: 'w', code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
    fireEvent.keyUp(mando, { key: 'w', code: 'KeyW' });

    // Las palancas andan con el mouse.
    const plato = screen.getByTestId('palanca-izquierda');
    plato.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;
    fireEvent.mouseDown(plato, { clientX: 100, clientY: 0, buttons: 1 });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: 1 });
    fireEvent.mouseUp(window);

    fireEvent.click(screen.getByRole('button', { name: 'Ocultar sticks virtuales' }));
    expect(screen.queryByRole('group', { name: 'Mando virtual de vuelo continuo' })).not.toBeInTheDocument();
  });

  it('con una tecla sostenida y un stick agarrado sale UN solo flujo a 10 Hz, con los dos sumados', () => {
    vi.useFakeTimers();
    const { onMando } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar sticks virtuales' }));
    const plato = screen.getByTestId('palanca-izquierda');
    plato.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;

    fireEvent.keyDown(window, { code: 'KeyW' });
    // El stick de altura hasta arriba, con W todavía apretada.
    fireEvent.mouseDown(plato, { clientX: 100, clientY: 0, buttons: 1 });
    onMando.mockClear();
    act(() => vi.advanceTimersByTime(1000));
    // Diez mensajes, no veinte, y todos dicen lo mismo: avanzar Y subir. Con
    // dos emisores el dron recibía uno de cada uno, cada uno anulando al otro.
    expect(onMando).toHaveBeenCalledTimes(10);
    for (const [ejes] of onMando.mock.calls) expect(ejes).toEqual({ pitch: 0.5, roll: 0, yaw: 0, throttle: 1 });

    // Soltar el stick deja la tecla sola, en el tick siguiente.
    fireEvent.mouseUp(window);
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
    // Y soltar la tecla manda el cero de cierre, una sola vez.
    fireEvent.keyUp(window, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
    const llamadas = onMando.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(onMando).toHaveBeenCalledTimes(llamadas);
  });

  it('esconder los sticks con una palanca agarrada deja el dron en cero', () => {
    const { onMando } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar sticks virtuales' }));
    const plato = screen.getByTestId('palanca-derecha');
    plato.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;
    fireEvent.mouseDown(plato, { clientX: 200, clientY: 100, buttons: 1 });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, roll: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Ocultar sticks virtuales' }));
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('heredan el impedimento, y sin el control confirmado quedan inertes', () => {
    const { volverARenderizar } = montar({ impedimento: 'El dron está desconectado: el mando no responde.' });
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar sticks virtuales' }));
    expect(screen.getByTestId('mando-impedimento')).toHaveTextContent('El dron está desconectado');
    volverARenderizar({ impedimento: null, controlTomado: false });
    expect(screen.getByTestId('mando-impedimento')).toHaveTextContent(/Esperando que el Comando Central confirme/);
  });
});

describe('PilotajePantallaCompleta — ayuda', () => {
  it('el "?" abre arriba a la derecha los controles de cada modo, y Esc la cierra', () => {
    montar();
    const pregunta = screen.getByRole('button', { name: 'Ayuda de los controles' });
    expect(pregunta).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(pregunta);

    const ayuda = screen.getByRole('dialog', { name: 'Controles del dron' });
    expect(pregunta).toHaveAttribute('aria-controls', ayuda.id);
    for (const modo of ['Teclado', 'Cámara con el mouse', 'Modo mouse', 'Sticks virtuales']) {
      expect(within(ayuda).getByRole('heading', { name: modo })).toBeInTheDocument();
    }
    expect(within(ayuda).getByText('Adelante y atrás')).toBeInTheDocument();
    expect(within(ayuda).getByText('Sale del modo mouse')).toBeInTheDocument();
    // Ctrl no se promete a secas: fuera de la pantalla completa con Chrome o
    // Edge el navegador se queda con Ctrl+W.
    expect(within(ayuda).getByText('Bajar').closest('div')).toHaveTextContent(
      'C (o Ctrl en pantalla completa con Chrome o Edge)',
    );
    expect(within(ayuda).getByRole('button', { name: 'Cerrar la ayuda' })).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Controles del dron' })).not.toBeInTheDocument();
    expect(pregunta).toHaveFocus();
  });

  it('se cierra con su botón o volviendo a tocar el "?"', () => {
    montar();
    const pregunta = screen.getByRole('button', { name: 'Ayuda de los controles' });
    fireEvent.click(pregunta);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar la ayuda' }));
    expect(screen.queryByRole('dialog', { name: 'Controles del dron' })).not.toBeInTheDocument();
    fireEvent.click(pregunta);
    fireEvent.click(pregunta);
    expect(screen.queryByRole('dialog', { name: 'Controles del dron' })).not.toBeInTheDocument();
  });

  it('con la ayuda abierta el teclado sigue volando, y la rueda sobre ella no mueve la cámara', () => {
    const { onMando, onCamara } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Ayuda de los controles' }));
    fireEvent.keyDown(window, { code: 'KeyE' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, yaw: 0.5 });
    rueda(screen.getByRole('dialog', { name: 'Controles del dron' }), -1);
    expect(onCamara).not.toHaveBeenCalled();
  });

  it('Esc sin nada abierto no hace nada, y otra tecla tampoco cierra la ayuda', () => {
    montar();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Ayuda de los controles' }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Controles del dron' })).toBeInTheDocument();
  });
});

describe('PilotajePantallaCompleta — salir', () => {
  it('pide confirmación; al confirmar suelta todo lo del navegador y avisa al detalle', () => {
    const { onSalir, onCerrar } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Salir del control manual' }));
    const dialogo = screen.getByRole('dialog', { name: '¿Salir del control manual?' });
    expect(dialogo).toHaveTextContent('el dron vuelve a patrullar');
    // el `resume_patrol` de este soltar no le corta un aterrizaje (PROTOCOLS §2)
    expect(dialogo).toHaveTextContent('si está aterrizando, sigue bajando hasta el suelo');
    expect(onSalir).not.toHaveBeenCalled();

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salir del control manual' }));
    expect(onSalir).toHaveBeenCalledTimes(1);
    expect(onCerrar).not.toHaveBeenCalled();
    expect(salirDePantalla).toHaveBeenCalled();
    expect(teclado.unlock).toHaveBeenCalled();
  });

  it('con un objetivo cargado dice que el dron vuelve a él', () => {
    montar({ hayObjetivo: true });
    fireEvent.click(screen.getByRole('button', { name: 'Salir del control manual' }));
    expect(screen.getByRole('dialog', { name: '¿Salir del control manual?' })).toHaveTextContent(
      'el dron vuelve al objetivo que estaba siguiendo',
    );
  });

  it('en un relevo dice que el relevo sigue, y no que vuelve a patrullar (RELEVOS §3.9)', () => {
    montar({ enRelevo: true });
    fireEvent.click(screen.getByRole('button', { name: 'Salir del control manual' }));
    const dialogo = screen.getByRole('dialog', { name: '¿Salir del control manual?' });
    expect(dialogo).toHaveTextContent('Se suelta el control sin darle ninguna orden al dron: sigue con el relevo.');
    expect(dialogo).not.toHaveTextContent('patrullar');
  });

  it('en un relevo y con objetivo, vuelve al objetivo y el relevo sigue', () => {
    montar({ enRelevo: true, hayObjetivo: true });
    fireEvent.click(screen.getByRole('button', { name: 'Salir del control manual' }));
    expect(screen.getByRole('dialog', { name: '¿Salir del control manual?' })).toHaveTextContent(
      'Se suelta el control y el dron vuelve al objetivo que estaba siguiendo; el relevo sigue en marcha.',
    );
  });

  it('"Seguir piloteando" cierra el diálogo sin soltar nada', () => {
    const { onSalir, onCerrar, onMando } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Salir del control manual' }));
    // Con el diálogo abierto el teclado no vuela: Espacio es para sus botones.
    fireEvent.keyDown(window, { code: 'Space' });
    expect(onMando).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Seguir piloteando' }));
    expect(screen.queryByRole('dialog', { name: '¿Salir del control manual?' })).not.toBeInTheDocument();
    expect(onSalir).not.toHaveBeenCalled();
    expect(onCerrar).not.toHaveBeenCalled();
  });

  it('Esc cierra el diálogo de salida y no la vista', () => {
    const { onSalir } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Salir del control manual' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '¿Salir del control manual?' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Pilotaje de Alfa' })).toBeInTheDocument();
    expect(onSalir).not.toHaveBeenCalled();
  });

  it('se puede cerrar la vista sin soltar el control', () => {
    const { onSalir, onCerrar } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Salir del control manual' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar la vista sin soltar' }));
    expect(onCerrar).toHaveBeenCalledTimes(1);
    expect(onSalir).not.toHaveBeenCalled();
  });

  it('en pantalla completa el diálogo se abre adentro de la vista, que es lo único que se ve', () => {
    const { vista } = montar();
    fireEvent.click(screen.getByRole('button', { name: 'Salir del control manual' }));
    expect(vista.contains(screen.getByRole('dialog', { name: '¿Salir del control manual?' }))).toBe(true);
  });
});

describe('PilotajePantallaCompleta — el foco al cerrarse', () => {
  /** Un botón de la página de atrás, enfocado antes de abrir la vista. */
  function botonQueAbre(): HTMLButtonElement {
    const boton = document.createElement('button');
    boton.textContent = 'Tomar control manual';
    document.body.append(boton);
    boton.focus();
    return boton;
  }

  it('vuelve a lo que lo tenía antes de abrir, ya sin lo de atrás inerte', () => {
    const abrio = botonQueAbre();
    // Mientras lo de atrás siga inerte el navegador no le da el foco a nada:
    // se anota cómo estaba el botón en el momento de enfocarlo.
    let inerteAlEnfocar: boolean | null = null;
    const enfocarDeVerdad = HTMLElement.prototype.focus;
    vi.spyOn(abrio, 'focus').mockImplementation(function (this: HTMLElement) {
      inerteAlEnfocar = this.closest('[inert]') !== null;
      enfocarDeVerdad.call(this);
    });
    const { vista, onDevolverFoco, unmount } = montar();
    expect(vista).toHaveFocus();
    expect(abrio).toHaveAttribute('inert');

    unmount();
    expect(abrio).toHaveFocus();
    expect(inerteAlEnfocar).toBe(false);
    expect(onDevolverFoco).not.toHaveBeenCalled();
    abrio.remove();
  });

  it('si lo que lo tenía ya no está en la página, le pregunta al detalle adónde', () => {
    // "Tomar control manual" se va apenas el control queda tomado.
    const abrio = botonQueAbre();
    const { onDevolverFoco, unmount } = montar();
    abrio.remove();
    unmount();
    expect(onDevolverFoco).toHaveBeenCalledTimes(1);
  });

  it('si no había nada enfocado al abrir, también le pregunta al detalle', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    const { onDevolverFoco, unmount } = montar();
    unmount();
    expect(onDevolverFoco).toHaveBeenCalledTimes(1);
  });
});

describe('PilotajePantallaCompleta — despegar y aterrizar', () => {
  it('en el suelo ofrece despegar, y lo pide al detalle (que confirma)', () => {
    const { onOrden } = montar({ enElSuelo: true, enElAire: false });
    expect(screen.queryByRole('button', { name: 'Aterrizar' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Despegar' }));
    expect(onOrden).toHaveBeenCalledWith('despegar');
  });

  it('en el aire ofrece aterrizar', () => {
    const { onOrden } = montar();
    expect(screen.queryByRole('button', { name: 'Despegar' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Aterrizar' }));
    expect(onOrden).toHaveBeenCalledWith('aterrizar');
  });

  it('con el dron desconectado o sin el control confirmado, no se puede', () => {
    const { volverARenderizar } = montar({ enElSuelo: true, enElAire: false, enLinea: false });
    expect(screen.getByRole('button', { name: 'Despegar' })).toBeDisabled();
    volverARenderizar({ enElSuelo: false, enElAire: true, enLinea: true, controlTomado: false });
    expect(screen.getByRole('button', { name: 'Aterrizar' })).toBeDisabled();
  });

  it('una app vieja que no dice si vuela no ofrece ninguna de las dos', () => {
    montar({ enElSuelo: false, enElAire: false });
    expect(screen.queryByRole('button', { name: 'Despegar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aterrizar' })).not.toBeInTheDocument();
  });
});

describe('PilotajePantallaCompleta — alertas nuevas', () => {
  it('avisa con discreción las alertas de este dron que llegan mientras se vuela', () => {
    const vieja = makeAlert({ id: 3, drone_id: 'd1', status: 'PENDING' });
    // Lo que ya estaba al abrir, en cualquier orden y de cualquier dron: la
    // referencia es el id más alto de ESTE dron (el 3), no el de otro (el 4).
    const masVieja = makeAlert({ id: 2, drone_id: 'd1', status: 'DISMISSED' });
    const deOtro = makeAlert({ id: 4, drone_id: 'otro', status: 'PENDING' });
    const { volverARenderizar } = montar({ alertas: [vieja, masVieja, deOtro] });
    // La que ya estaba al abrir se decide en el detalle: no se avisa.
    expect(screen.queryByTestId('pilotaje-alerta-nueva')).not.toBeInTheDocument();

    const nueva = makeAlert({ id: 5, drone_id: 'd1', status: 'PENDING', type: 'PERSON' });
    const ajena = makeAlert({ id: 6, drone_id: 'otro', status: 'PENDING' });
    volverARenderizar({ alertas: [ajena, nueva, vieja] });
    expect(screen.getByTestId('pilotaje-alerta-nueva')).toHaveTextContent('Nueva alerta sin decidir: Persona.');

    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    expect(screen.queryByTestId('pilotaje-alerta-nueva')).not.toBeInTheDocument();

    // Llegan dos más: el aviso vuelve, con la cuenta y la última.
    const otra = makeAlert({ id: 8, drone_id: 'd1', status: 'PENDING', type: 'VEHICLE' });
    const otraMas = makeAlert({ id: 7, drone_id: 'd1', status: 'PENDING', type: 'PERSON' });
    volverARenderizar({ alertas: [otra, otraMas, nueva, vieja] });
    expect(screen.getByTestId('pilotaje-alerta-nueva')).toHaveTextContent(
      '2 alertas nuevas sin decidir; la última, Vehículo.',
    );
  });

  it('una alerta nueva que ya se decidió no se avisa', () => {
    const { volverARenderizar } = montar();
    volverARenderizar({ alertas: [makeAlert({ id: 9, drone_id: 'd1', status: 'DISMISSED' })] });
    expect(screen.queryByTestId('pilotaje-alerta-nueva')).not.toBeInTheDocument();
  });
});

describe('PilotajePantallaCompleta — ajustes del control', () => {
  /*
   * El Comando Central se interviene en `fetch`: GET y PUT de
   * /api/me/preferencias. Cada test elige qué contesta (o lo deja esperando).
   */
  type Pedido = { metodo: string; ruta: string; cuerpo: unknown };
  let pedidos: Pedido[] = [];
  let alPedirGet: () => Promise<Response>;
  let alPedirPut: () => Promise<Response>;
  const responder = (body: unknown, status = 200) =>
    Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
  const puts = () => pedidos.filter((p) => p.metodo === 'PUT');
  /** Una respuesta que queda pendiente hasta que el test la cumple o la rechaza. */
  function enEspera() {
    const control = {} as { cumplir: (r: Response) => void; rechazar: (e: unknown) => void };
    const promesa = new Promise<Response>((cumplir, rechazar) => Object.assign(control, { cumplir, rechazar }));
    return { promesa, ...control };
  }

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('cc_token', 'tok');
    localStorage.setItem('cc_user', 'oper1');
    pedidos = [];
    alPedirGet = () => responder({ controles: {}, actualizadoEn: null });
    alPedirPut = () => responder({ controles: {}, actualizadoEn: '2026-10-24T00:00:00.000Z' });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit = {}) => {
        const metodo = init.method ?? 'GET';
        pedidos.push({ metodo, ruta: url, cuerpo: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
        return metodo === 'PUT' ? alPedirPut() : alPedirGet();
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /** Monta la vista y deja que conteste el GET de las preferencias. */
  async function montarConAjustes(cambios: Partial<Props> = {}) {
    const montada = montar(cambios);
    await act(async () => {});
    return montada;
  }

  const engranaje = () => screen.getByRole('button', { name: 'Ajustes del control' });
  const panel = () => screen.queryByRole('dialog', { name: 'Ajustes del control' });
  const deslizador = (nombre: string) => screen.getByRole('slider', { name: nombre });
  const HORIZONTAL = 'Sensibilidad horizontal del mouse (giro)';
  const VERTICAL = 'Sensibilidad vertical del mouse (cámara)';
  const RUEDA = 'Paso de la rueda para la cámara';
  const NORMAL = 'Velocidad normal (W A S D)';
  const mover = (nombre: string, valor: number) => fireEvent.change(deslizador(nombre), { target: { value: String(valor) } });
  const pasoGuardado = (pedido: Pedido | undefined) => (pedido?.cuerpo as { controles: { pasoDeRueda: number } }).controles.pasoDeRueda;
  /** El valor que se lee al lado del rótulo de un deslizador. */
  const valorVisible = (nombre: string) => deslizador(nombre).closest('.ajuste')?.querySelector('.ajuste-valor')?.textContent;

  it('el engranaje, al lado del "?", abre los ajustes con el foco adentro; cerrarlos lo devuelve', async () => {
    await montarConAjustes();
    const boton = engranaje();
    // Va justo antes del "?": la ayuda sigue siendo lo de la esquina.
    expect(boton.nextElementSibling).toBe(screen.getByRole('button', { name: 'Ayuda de los controles' }));
    expect(boton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(boton);

    const ajustes = panel()!;
    expect(boton).toHaveAttribute('aria-expanded', 'true');
    expect(boton).toHaveAttribute('aria-controls', ajustes.id);
    expect(within(ajustes).getByRole('button', { name: 'Cerrar los ajustes' })).toHaveFocus();
    for (const nombre of [
      HORIZONTAL,
      VERTICAL,
      RUEDA,
      NORMAL,
      'Multiplicador con Shift',
      'Velocidad de subida y bajada',
      'Velocidad de giro con Q/E',
    ]) {
      expect(within(ajustes).getByRole('slider', { name: nombre })).toBeInTheDocument();
    }
    expect(within(ajustes).getByRole('switch', { name: 'Invertir eje vertical' })).not.toBeChecked();
    // Cada deslizador dice su valor a la vista y al lector de pantalla.
    expect(deslizador(HORIZONTAL)).toHaveAttribute('aria-valuetext', '1 vez');
    expect(deslizador(NORMAL)).toHaveAttribute('aria-valuetext', '50 por ciento de la palanca');
    expect(within(ajustes).getByText('5°')).toBeInTheDocument();

    fireEvent.click(within(ajustes).getByRole('button', { name: 'Cerrar los ajustes' }));
    expect(panel()).not.toBeInTheDocument();
    expect(boton).toHaveFocus();
    // El engranaje también lo cierra.
    fireEvent.click(boton);
    fireEvent.click(boton);
    expect(panel()).not.toBeInTheDocument();
  });

  it('un globo a la vez: abrir los ajustes cierra la ayuda, y al revés', async () => {
    await montarConAjustes();
    fireEvent.click(screen.getByRole('button', { name: 'Ayuda de los controles' }));
    fireEvent.click(engranaje());
    expect(screen.queryByRole('dialog', { name: 'Controles del dron' })).not.toBeInTheDocument();
    expect(panel()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ayuda de los controles' }));
    expect(panel()).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Controles del dron' })).toBeInTheDocument();
  });

  it('la sensibilidad horizontal escala el giro que pide el mouse, en pleno vuelo', async () => {
    vi.useFakeTimers();
    const { onMando } = await montarConAjustes();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    moverMouse(3, 0);
    // 3 px a 1× son un cuarto de giro.
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, yaw: 0.25 });
    act(() => vi.advanceTimersByTime(300));

    fireEvent.click(engranaje());
    mover(HORIZONTAL, 2);
    expect(valorVisible(HORIZONTAL)).toBe('2×');
    expect(deslizador(HORIZONTAL)).toHaveAttribute('aria-valuetext', '2 veces');
    // Abrir los ajustes soltó la captura (hace falta el cursor): se vuelve a entrar.
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    moverMouse(3, 0);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, yaw: 0.5 });
  });

  it('la sensibilidad vertical escala la inclinación, y el interruptor invierte el eje', async () => {
    vi.useFakeTimers();
    const { onCamara } = await montarConAjustes();
    fireEvent.click(engranaje());
    mover(VERTICAL, 0.5);
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));

    // 100 px hacia arriba a 0,06 °/px por 0,5: tres grados más alto.
    moverMouse(0, -100);
    expect(onCamara).toHaveBeenLastCalledWith(-27);
    act(() => vi.advanceTimersByTime(200));

    fireEvent.click(screen.getByRole('switch', { name: 'Invertir eje vertical' }));
    expect(screen.getByRole('switch', { name: 'Invertir eje vertical' })).toBeChecked();
    // Invertido, el mismo gesto hacia arriba baja la cámara.
    moverMouse(0, -100);
    expect(onCamara).toHaveBeenLastCalledWith(-30);
  });

  it('el paso de la rueda cambia cuánto inclina cada muesca, y la ayuda lo dice', async () => {
    const { onCamara, video } = await montarConAjustes();
    fireEvent.click(engranaje());
    mover(RUEDA, 2);
    rueda(video, -1);
    expect(onCamara).toHaveBeenLastCalledWith(-28);
    fireEvent.click(screen.getByRole('button', { name: 'Ayuda de los controles' }));
    expect(screen.getByText('Inclina la cámara 2° por muesca: hacia arriba mira más alto')).toBeInTheDocument();
  });

  it('las velocidades del teclado y el multiplicador de Shift salen por el mismo mando', async () => {
    vi.useFakeTimers();
    const { onMando, vista } = await montarConAjustes();
    fireEvent.click(engranaje());
    mover(NORMAL, 0.3);
    mover('Velocidad de subida y bajada', 0.4);
    mover('Velocidad de giro con Q/E', 0.7);
    mover('Multiplicador con Shift', 3);
    expect(valorVisible(NORMAL)).toBe('30 %');
    expect(valorVisible('Multiplicador con Shift')).toBe('3×');
    // Es lo que hace tocar la imagen (ver "tocar la imagen…", más abajo: con el
    // reloj falso, user-event no termina nunca el clic).
    act(() => vista.focus());

    fireEvent.keyDown(vista, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.3 });
    fireEvent.keyDown(vista, { code: 'Space' });
    fireEvent.keyDown(vista, { code: 'KeyE' });
    act(() => vi.advanceTimersByTime(100));
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.3, yaw: 0.7, throttle: 0.4 });
    fireEvent.keyDown(vista, { code: 'ShiftLeft' });
    act(() => vi.advanceTimersByTime(100));
    // Con Shift, por tres y con tope en el fondo de la palanca.
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.9, yaw: 1, throttle: 1 });
    expect(screen.getByTestId('hud-velocidad')).toHaveTextContent('Rápido');
  });

  it('tocar la imagen con los ajustes abiertos devuelve el foco a la vista, y el teclado vuelve a volar', async () => {
    const { onMando, vista, video } = await montarConAjustes();
    fireEvent.click(engranaje());
    const ajustes = panel()!;
    expect(ajustes).toContainElement(document.activeElement as HTMLElement);
    // user-event mueve el foco en el mousedown, como el navegador: si algo le
    // cortara el efecto al botón izquierdo, el teclado quedaría mudo con el
    // panel abierto y sin otra salida que el tabulador.
    await userEvent.click(video);
    expect(vista).toHaveFocus();
    expect(panel()).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
  });

  it('con el multiplicador en 1×, Shift no cambia nada y el HUD no dice "Rápido"', async () => {
    const { onMando, vista } = await montarConAjustes();
    fireEvent.click(engranaje());
    mover('Multiplicador con Shift', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar los ajustes' }));
    fireEvent.keyDown(vista, { code: 'ShiftLeft' });
    fireEvent.keyDown(vista, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
    expect(screen.getByTestId('hud-velocidad')).toHaveTextContent('Normal');
  });

  it('la ayuda y los ajustes son el mismo globo, colgado del hueco que termina arriba del pie', async () => {
    await montarConAjustes();
    // Lo que fija pilotaje.test.ts sólo vale si el marcado lo sigue.
    const marco = (globo: HTMLElement) => {
      const cabecera = globo.firstElementChild as HTMLElement;
      return {
        globo: globo.className.split(' ')[0],
        hueco: globo.parentElement?.className,
        cabecera: cabecera.className,
        cerrar: within(cabecera).getByRole('button').className,
      };
    };
    fireEvent.click(screen.getByRole('button', { name: 'Ayuda de los controles' }));
    const deLaAyuda = marco(screen.getByRole('dialog', { name: 'Controles del dron' }));
    expect(deLaAyuda).toEqual({
      globo: 'pilotaje-globo',
      hueco: 'pilotaje-globos',
      cabecera: 'pilotaje-globo-cabecera',
      cerrar: 'modal-cerrar',
    });
    fireEvent.click(engranaje());
    expect(marco(panel()!)).toEqual(deLaAyuda);
  });

  it('"Restablecer valores por defecto" vuelve todo a fábrica, y el mouse con ellos', async () => {
    vi.useFakeTimers();
    const { onMando } = await montarConAjustes();
    fireEvent.click(engranaje());
    mover(HORIZONTAL, 3);
    fireEvent.click(screen.getByRole('switch', { name: 'Invertir eje vertical' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restablecer valores por defecto' }));

    expect(deslizador(HORIZONTAL)).toHaveValue('1');
    expect(screen.getByRole('switch', { name: 'Invertir eje vertical' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    moverMouse(3, 0);
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, yaw: 0.25 });
    // Y lo que se guarda es el juego de fábrica entero.
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(puts().at(-1)?.cuerpo).toEqual({ controles: CONTROLES_POR_DEFECTO });
  });

  it('carga los del Comando Central al abrirse: son los que valen en cualquier computadora', async () => {
    alPedirGet = () => responder({ controles: { ...CONTROLES_POR_DEFECTO, sensibilidadVertical: 0.4 }, actualizadoEn: 'ayer' });
    await montarConAjustes();
    expect(pedidos[0]).toMatchObject({ metodo: 'GET', ruta: '/api/me/preferencias' });
    fireEvent.click(engranaje());
    expect(deslizador(VERTICAL)).toHaveValue('0.4');
    // Y quedan en la copia local de ESTE usuario.
    expect(JSON.parse(localStorage.getItem('cc_controles:oper1')!).sensibilidadVertical).toBe(0.4);
  });

  it('arranca con la copia local del usuario mientras el Comando Central no contesta, sin pasar por los de fábrica', () => {
    localStorage.setItem('cc_controles:oper1', JSON.stringify({ ...CONTROLES_POR_DEFECTO, sensibilidadHorizontal: 2.5 }));
    localStorage.setItem('cc_controles:otra', JSON.stringify({ ...CONTROLES_POR_DEFECTO, sensibilidadHorizontal: 0.2 }));
    alPedirGet = () => new Promise<Response>(() => {});
    montar();
    fireEvent.click(engranaje());
    expect(deslizador(HORIZONTAL)).toHaveValue('2.5');
  });

  it('sin red se vuela con la copia local, y no se avisa nada: no hay nada que guardar', async () => {
    localStorage.setItem('cc_controles:oper1', JSON.stringify({ ...CONTROLES_POR_DEFECTO, pasoDeRueda: 8 }));
    alPedirGet = () => Promise.reject(new TypeError('Failed to fetch'));
    const { onCamara, video } = await montarConAjustes();
    rueda(video, -1);
    expect(onCamara).toHaveBeenLastCalledWith(-22);
    expect(screen.queryByTestId('pilotaje-aviso-ajustes')).not.toBeInTheDocument();
  });

  it('si la persona ya movió algo, lo que conteste tarde el Comando Central no lo pisa', async () => {
    vi.useFakeTimers();
    const get = enEspera();
    alPedirGet = () => get.promesa;
    montar();
    fireEvent.click(engranaje());
    mover(VERTICAL, 2);
    const tarde = { controles: { ...CONTROLES_POR_DEFECTO, sensibilidadVertical: 0.4, pasoDeRueda: 9 }, actualizadoEn: 'ayer' };
    await act(async () => {
      get.cumplir({ ok: true, status: 200, json: async () => tarde } as Response);
    });
    expect(deslizador(VERTICAL)).toHaveValue('2');
    // Lo que no tocó sí es lo del Comando Central, y el guardado que esperaba
    // su turno sale uno solo, ya combinado.
    expect(deslizador(RUEDA)).toHaveValue('9');
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(puts()).toHaveLength(1);
    expect(puts()[0].cuerpo).toEqual({ controles: { ...CONTROLES_POR_DEFECTO, sensibilidadVertical: 2, pasoDeRueda: 9 } });
  });

  it('lo que contesta el Comando Central con la vista ya cerrada no se aplica ni se copia', async () => {
    const get = enEspera();
    alPedirGet = () => get.promesa;
    const { unmount } = montar();
    unmount();
    await act(async () => {
      get.cumplir({ ok: true, status: 200, json: async () => ({ controles: { pasoDeRueda: 9 }, actualizadoEn: 'ayer' }) } as Response);
    });
    expect(localStorage.getItem('cc_controles:oper1')).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it('un ajuste movido antes de que conteste el Comando Central no pisa allá los demás de la persona', async () => {
    vi.useFakeTimers();
    const get = enEspera();
    alPedirGet = () => get.promesa;
    montar();
    fireEvent.click(engranaje());
    mover(RUEDA, 3);
    // La mano se quedó quieta antes de que contestara: salió lo único que se sabía.
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(puts()).toHaveLength(1);

    const deOtraComputadora = { ...CONTROLES_POR_DEFECTO, sensibilidadVertical: 0.4, invertirVertical: true };
    await act(async () => {
      get.cumplir({ ok: true, status: 200, json: async () => ({ controles: deOtraComputadora, actualizadoEn: 'ayer' }) } as Response);
    });
    expect(deslizador(VERTICAL)).toHaveValue('0.4');
    expect(screen.getByRole('switch', { name: 'Invertir eje vertical' })).toBeChecked();
    expect(deslizador(RUEDA)).toHaveValue('3');
    // Y el juego combinado reemplaza en el Comando Central al que salió sin saberlo.
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(puts()).toHaveLength(2);
    expect(puts()[1].cuerpo).toEqual({ controles: { ...deOtraComputadora, pasoDeRueda: 3 } });
  });

  it('guarda cuando la mano se queda quieta: un PUT con el juego entero, y la copia local en el acto', async () => {
    vi.useFakeTimers();
    await montarConAjustes();
    fireEvent.click(engranaje());
    mover(HORIZONTAL, 1.5);
    mover(HORIZONTAL, 1.8);
    expect(JSON.parse(localStorage.getItem('cc_controles:oper1')!).sensibilidadHorizontal).toBe(1.8);
    act(() => vi.advanceTimersByTime(600));
    expect(puts()).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ ruta: '/api/me/preferencias' });
    expect(puts()[0].cuerpo).toEqual({ controles: { ...CONTROLES_POR_DEFECTO, sensibilidadHorizontal: 1.8 } });
  });

  it('cerrar los ajustes, o la vista, guarda en el acto lo que esperaba su turno', async () => {
    const { unmount } = await montarConAjustes();
    fireEvent.click(engranaje());
    mover(RUEDA, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar los ajustes' }));
    expect(puts()).toHaveLength(1);
    expect(pasoGuardado(puts()[0])).toBe(3);
    // Cerrar sin haber cambiado nada no manda nada.
    fireEvent.click(engranaje());
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar los ajustes' }));
    expect(puts()).toHaveLength(1);

    fireEvent.click(engranaje());
    mover(RUEDA, 4);
    unmount();
    // Sale apenas vuelve el anterior (ver "los guardados van de a uno"), aunque
    // la vista ya no esté.
    await act(async () => {});
    expect(puts()).toHaveLength(2);
    expect(pasoGuardado(puts()[1])).toBe(4);
  });

  it('si no se pudo guardar, el ajuste sigue valiendo y lo avisa sin trabar nada; "Reintentar" lo vuelve a mandar', async () => {
    alPedirPut = () => responder({ error: 'Error interno' }, 500);
    const { onCamara, video } = await montarConAjustes();
    fireEvent.click(engranaje());
    mover(RUEDA, 2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar los ajustes' }));
    });
    const aviso = screen.getByTestId('pilotaje-aviso-ajustes');
    expect(aviso).toHaveAttribute('role', 'status');
    expect(aviso).toHaveTextContent('No se pudieron guardar tus ajustes del control en el Comando Central');
    rueda(video, -1);
    expect(onCamara).toHaveBeenLastCalledWith(-28);

    alPedirPut = () => responder({ controles: {}, actualizadoEn: 'hoy' });
    await act(async () => {
      fireEvent.click(within(aviso).getByRole('button', { name: 'Reintentar' }));
    });
    expect(puts().at(-1)?.cuerpo).toEqual({ controles: { ...CONTROLES_POR_DEFECTO, pasoDeRueda: 2 } });
    expect(screen.queryByTestId('pilotaje-aviso-ajustes')).not.toBeInTheDocument();
  });

  it('los guardados van de a uno: el siguiente sale cuando vuelve el anterior, sólo el último, y un fallo viejo no lo tapa', async () => {
    const primero = enEspera();
    alPedirPut = () => primero.promesa;
    await montarConAjustes();
    const cerrarAjustes = () => fireEvent.click(screen.getByRole('button', { name: 'Cerrar los ajustes' }));
    fireEvent.click(engranaje());
    mover(RUEDA, 2);
    cerrarAjustes();
    alPedirPut = () => responder({ controles: {}, actualizadoEn: 'hoy' });
    // Mientras el primero no vuelve, los que siguen esperan: dos en paralelo
    // podían llegar al revés y dejar guardado el viejo.
    for (const paso of [3, 4]) {
      fireEvent.click(engranaje());
      mover(RUEDA, paso);
      cerrarAjustes();
    }
    await act(async () => {});
    expect(puts()).toHaveLength(1);

    // Cuando vuelve, aunque sea con un fallo, sale sólo el último juego.
    await act(async () => primero.rechazar(new TypeError('sin red')));
    expect(puts()).toHaveLength(2);
    expect(pasoGuardado(puts()[1])).toBe(4);
    expect(screen.queryByTestId('pilotaje-aviso-ajustes')).not.toBeInTheDocument();
  });

  it('con los ajustes abiertos, el guardado que falló se avisa adentro del panel, y "Reintentar" anda desde ahí', async () => {
    vi.useFakeTimers();
    alPedirPut = () => responder({ error: 'Error interno' }, 500);
    await montarConAjustes();
    fireEvent.click(engranaje());
    mover(RUEDA, 2);
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    // Uno solo, y en el panel: en el centro del HUD el panel le tapaba la punta.
    const aviso = within(panel()!).getByTestId('pilotaje-aviso-ajustes');
    expect(screen.getAllByTestId('pilotaje-aviso-ajustes')).toEqual([aviso]);
    expect(aviso).toHaveAttribute('role', 'status');
    expect(aviso).toHaveTextContent('No se pudieron guardar tus ajustes del control en el Comando Central');

    alPedirPut = () => responder({ controles: {}, actualizadoEn: 'hoy' });
    await act(async () => {
      fireEvent.click(within(aviso).getByRole('button', { name: 'Reintentar' }));
    });
    expect(puts().at(-1)?.cuerpo).toEqual({ controles: { ...CONTROLES_POR_DEFECTO, pasoDeRueda: 2 } });
    expect(screen.queryByTestId('pilotaje-aviso-ajustes')).not.toBeInTheDocument();
  });

  it('un guardado que falló no se pierde: cerrar la vista lo reintenta, y la próxima manda la copia local en vez de creerle al GET', async () => {
    alPedirPut = () => responder({ error: 'Sesión vencida' }, 401);
    const primera = await montarConAjustes();
    fireEvent.click(engranaje());
    mover(RUEDA, 2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar los ajustes' }));
    });
    expect(screen.getByTestId('pilotaje-aviso-ajustes')).toBeInTheDocument();
    primera.unmount();
    await act(async () => {});
    expect(puts()).toHaveLength(2);
    expect(pasoGuardado(puts()[1])).toBe(2);

    // De vuelta en la vista, el Comando Central todavía tiene lo de antes.
    pedidos = [];
    alPedirGet = () => responder({ controles: { ...CONTROLES_POR_DEFECTO, pasoDeRueda: 9 }, actualizadoEn: 'ayer' });
    alPedirPut = () => responder({ controles: {}, actualizadoEn: 'hoy' });
    const { onCamara, video } = await montarConAjustes();
    expect(pedidos.map((p) => p.metodo)).toEqual(['PUT']);
    expect(pasoGuardado(puts()[0])).toBe(2);
    rueda(video, -1);
    expect(onCamara).toHaveBeenLastCalledWith(-28);
    // Ya guardada, la copia está al día: la próxima vez vuelve a mandar el GET.
    expect(JSON.parse(localStorage.getItem('cc_controles:oper1')!)).toEqual({ ...CONTROLES_POR_DEFECTO, pasoDeRueda: 2 });
  });

  it('lo que se teclea en los ajustes no mueve el dron: las flechas son del deslizador, Espacio del interruptor', async () => {
    const { onMando } = await montarConAjustes();
    fireEvent.click(engranaje());
    const horizontal = deslizador(HORIZONTAL);
    act(() => horizontal.focus());
    for (const code of ['ArrowRight', 'ArrowUp', 'KeyW', 'KeyQ', 'ShiftLeft', 'KeyC']) {
      fireEvent.keyDown(horizontal, { code });
      fireEvent.keyUp(horizontal, { code });
    }
    const interruptor = screen.getByRole('switch', { name: 'Invertir eje vertical' });
    act(() => interruptor.focus());
    // Espacio no se ataja: el navegador lo usa para prender el interruptor.
    expect(fireEvent.keyDown(interruptor, { code: 'Space' })).toBe(true);
    expect(fireEvent.keyUp(interruptor, { code: 'Space' })).toBe(true);
    expect(onMando).not.toHaveBeenCalled();
    expect(screen.getByTestId('hud-velocidad')).toHaveTextContent('Normal');
  });

  it('la tecla que se venía sosteniendo para volar se suelta aunque el foco ya esté en los ajustes', async () => {
    const { onMando, vista } = await montarConAjustes();
    fireEvent.keyDown(vista, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
    fireEvent.click(engranaje());
    fireEvent.keyUp(deslizador(HORIZONTAL), { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith(EJES_EN_CERO);
  });

  it('con los ajustes abiertos, el teclado vuela desde la imagen y la rueda sobre ellos no mueve la cámara', async () => {
    const { onMando, onCamara, vista } = await montarConAjustes();
    fireEvent.click(engranaje());
    fireEvent.keyDown(vista, { code: 'KeyE' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, yaw: 0.5 });
    rueda(panel()!, -1);
    expect(onCamara).not.toHaveBeenCalled();
  });

  it('abrir los ajustes suelta la captura del puntero: se tocan con el cursor', async () => {
    await montarConAjustes();
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    expect(document.pointerLockElement).not.toBeNull();
    fireEvent.click(engranaje());
    expect(soltarCaptura).toHaveBeenCalled();
    expect(document.pointerLockElement).toBeNull();
  });

  it('Esc suelta primero el modo mouse y después cierra los ajustes, devolviendo el foco al engranaje', async () => {
    await montarConAjustes();
    fireEvent.click(engranaje());
    // Con los ajustes abiertos se puede entrar al modo mouse para probar.
    fireEvent.click(screen.getByRole('button', { name: 'Modo mouse' }));
    expect(document.pointerLockElement).not.toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.pointerLockElement).toBeNull();
    expect(panel()).toBeInTheDocument();

    fireEvent.keyDown(deslizador(VERTICAL), { key: 'Escape' });
    expect(panel()).not.toBeInTheDocument();
    expect(engranaje()).toHaveFocus();
    // Un Esc más no hace nada: no queda nada abierto.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Pilotaje de Alfa' })).toBeInTheDocument();
  });

  it('con el diálogo de salida encima, Esc es del diálogo y los ajustes quedan como estaban', async () => {
    await montarConAjustes();
    fireEvent.click(engranaje());
    fireEvent.click(screen.getByRole('button', { name: 'Salir del control manual' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).toBeInTheDocument();
  });
});
