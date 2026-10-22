import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
import { limpiarEstadoMapa } from '../test/dobleLeaflet';
import { makeAlert, makeStatus } from '../test/fixtures';
import { EJES_EN_CERO, type Ejes } from './MandoVirtual';
import PilotajePantallaCompleta from './PilotajePantallaCompleta';

/*
 * jsdom no tiene pantalla completa, ni captura del puntero, ni Keyboard Lock.
 * Los dobles de abajo se portan como Chromium: pedir la pantalla completa la
 * pone y avisa con `fullscreenchange`; pedir la captura la pone y avisa con
 * `pointerlockchange`. Así se prueba lo que hace la vista con cada cambio, que
 * es lo que importa, y cada test puede romperlos a su gusto para probar el
 * navegador que se niega.
 */
let enPantallaCompleta: Element | null = null;
let capturado: Element | null = null;
const teclado = { lock: vi.fn(() => Promise.resolve()), unlock: vi.fn() };

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

  it('Ctrl y C bajan', () => {
    const { onMando } = montar();
    fireEvent.keyDown(window, { code: 'ControlLeft' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, throttle: -0.5 });
    fireEvent.keyUp(window, { code: 'ControlLeft' });
    fireEvent.keyDown(window, { code: 'KeyC' });
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

    moverMouse(12.5, 0);
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

    moverMouse(0, -20);
    // 20 px hacia arriba a 0,15 °/px: tres grados más alto.
    expect(onCamara).toHaveBeenLastCalledWith(-27);
    expect(hud('camara')).toBe('-27°');
    act(() => vi.advanceTimersByTime(200));
    moverMouse(0, 1000);
    expect(onCamara).toHaveBeenLastCalledWith(-90);

    fireEvent.keyDown(window, { code: 'KeyW' });
    expect(onMando).toHaveBeenLastCalledWith({ ...EJES_EN_CERO, pitch: 0.5 });
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
