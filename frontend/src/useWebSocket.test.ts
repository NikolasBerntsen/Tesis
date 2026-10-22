import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CIERRE_SESION_TERMINADA, useWebSocket } from './useWebSocket';

class FakeWebSocket {
  // Los estados del socket real: el hook mira `readyState` antes de mandar.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  close = vi.fn();
  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  /** Abre el socket como lo haría el navegador: estado + aviso al hook. */
  abrir() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** 1006 es el cierre sin aviso del otro lado: un corte de red, un backend que se reinicia. */
  cerrar(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('cc_token', 'tok');
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useWebSocket', () => {
  it('arranca desconectado y pasa a conectado al abrir el socket', async () => {
    const { result } = renderHook(() => useWebSocket(() => {}));
    expect(result.current.conectado).toBe(false);

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain('/ws?token=tok');
    act(() => ws.abrir());
    await waitFor(() => expect(result.current.conectado).toBe(true));
  });

  it('parsea los mensajes JSON y se los pasa al handler', () => {
    const onMessage = vi.fn();
    renderHook(() => useWebSocket(onMessage));
    const ws = FakeWebSocket.instances[0];
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'status', droneId: 'd1' }) }));
    expect(onMessage).toHaveBeenCalledWith({ type: 'status', droneId: 'd1' });
  });

  it('ignora mensajes que no son JSON sin romper', () => {
    const onMessage = vi.fn();
    renderHook(() => useWebSocket(onMessage));
    const ws = FakeWebSocket.instances[0];
    expect(() => act(() => ws.onmessage?.({ data: 'esto-no-es-json' }))).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('se reconecta 3 s después de un cierre', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWebSocket(() => {}));
    const ws = FakeWebSocket.instances[0];
    act(() => ws.abrir());
    expect(result.current.conectado).toBe(true);

    act(() => ws.cerrar());
    expect(result.current.conectado).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(3000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('se reconecta también cuando el backend le cierra la consola (4403), que no es lo mismo que terminar la sesión', () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket(() => {}));
    act(() => FakeWebSocket.instances[0].abrir());
    act(() => FakeWebSocket.instances[0].cerrar(4403));
    act(() => vi.advanceTimersByTime(3000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(localStorage.getItem('cc_token')).toBe('tok');
  });

  it('si la sesión terminó (4401) borra la sesión y recarga hacia el login en vez de reconectar', () => {
    // El caso de verdad: un admin le cambió el rol a la cuenta. El token viejo
    // ya no abre la consola, y reconectar con él rebotaría cada 3 s para siempre.
    vi.useFakeTimers();
    const original = window.location;
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    localStorage.setItem('cc_user', 'oper');
    localStorage.setItem('cc_role', 'operator');
    try {
      const { result } = renderHook(() => useWebSocket(() => {}));
      act(() => FakeWebSocket.instances[0].abrir());
      act(() => FakeWebSocket.instances[0].cerrar(CIERRE_SESION_TERMINADA));

      expect(result.current.conectado).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('cc_token')).toBeNull();
      expect(localStorage.getItem('cc_user')).toBeNull();
      expect(localStorage.getItem('cc_role')).toBeNull();
      act(() => vi.advanceTimersByTime(5000));
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('al desmontar cierra el socket y no reconecta', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useWebSocket(() => {}));
    const ws = FakeWebSocket.instances[0];
    unmount();
    expect(ws.close).toHaveBeenCalled();

    act(() => ws.cerrar());
    act(() => vi.advanceTimersByTime(5000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('usa wss cuando la página está en https', () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, protocol: 'https:', host: 'ejemplo.com' },
    });
    renderHook(() => useWebSocket(() => {}));
    expect(FakeWebSocket.instances[0].url).toBe('wss://ejemplo.com/ws?token=tok');
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it('enviar serializa el mensaje a JSON por el socket abierto', () => {
    const { result } = renderHook(() => useWebSocket(() => {}));
    const ws = FakeWebSocket.instances[0];
    act(() => ws.abrir());

    expect(result.current.enviar({ type: 'manual_stick', droneId: 'd1', pitch: 0.6 })).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'manual_stick', droneId: 'd1', pitch: 0.6 }));
  });

  it('no manda nada mientras el socket está cerrado o reconectando', () => {
    const { result } = renderHook(() => useWebSocket(() => {}));
    const ws = FakeWebSocket.instances[0];

    // Todavía conectando: el mensaje se pierde a propósito, no se encola.
    expect(result.current.enviar({ type: 'manual_stick' })).toBe(false);

    act(() => ws.abrir());
    act(() => ws.cerrar());
    expect(result.current.enviar({ type: 'manual_stick' })).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('la función de envío sobrevive a la reconexión y apunta al socket nuevo', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWebSocket(() => {}));
    const enviarOriginal = result.current.enviar;
    const primero = FakeWebSocket.instances[0];
    act(() => primero.abrir());
    act(() => primero.cerrar());
    act(() => vi.advanceTimersByTime(3000));

    const segundo = FakeWebSocket.instances[1];
    act(() => segundo.abrir());

    // La misma función de siempre: quien la tenga en las dependencias de un
    // temporizador (el mando virtual) no reinicia nada al reconectarse.
    expect(result.current.enviar).toBe(enviarOriginal);
    expect(enviarOriginal({ type: 'manual_stick' })).toBe(true);
    expect(segundo.send).toHaveBeenCalledWith(JSON.stringify({ type: 'manual_stick' }));
    expect(primero.send).not.toHaveBeenCalled();
  });
});
