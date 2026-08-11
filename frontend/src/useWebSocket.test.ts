import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from './useWebSocket';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
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
    expect(result.current).toBe(false);

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain('/ws?token=tok');
    act(() => ws.onopen?.());
    await waitFor(() => expect(result.current).toBe(true));
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
    act(() => ws.onopen?.());
    expect(result.current).toBe(true);

    act(() => ws.onclose?.());
    expect(result.current).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(3000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('al desmontar cierra el socket y no reconecta', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useWebSocket(() => {}));
    const ws = FakeWebSocket.instances[0];
    unmount();
    expect(ws.close).toHaveBeenCalled();

    act(() => ws.onclose?.());
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
});
