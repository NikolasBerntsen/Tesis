import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearSession, getToken, getUsername, login } from './api';

function mockResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

describe('api.ts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sesión en localStorage', () => {
    it('getToken devuelve null cuando no hay token', () => {
      expect(getToken()).toBeNull();
    });

    it('getToken devuelve el token guardado', () => {
      localStorage.setItem('cc_token', 'abc123');
      expect(getToken()).toBe('abc123');
    });

    it('getUsername devuelve cadena vacía cuando no hay usuario', () => {
      expect(getUsername()).toBe('');
    });

    it('getUsername devuelve el usuario guardado', () => {
      localStorage.setItem('cc_user', 'nikolas');
      expect(getUsername()).toBe('nikolas');
    });

    it('clearSession borra token y usuario', () => {
      localStorage.setItem('cc_token', 'abc123');
      localStorage.setItem('cc_user', 'nikolas');
      clearSession();
      expect(getToken()).toBeNull();
      expect(getUsername()).toBe('');
    });
  });

  describe('login', () => {
    it('guarda token y usuario cuando el backend responde ok', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse({ token: 'tok', user: { username: 'oper' } }));
      vi.stubGlobal('fetch', fetchMock);

      await login('oper', 'secreta');

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ username: 'oper', password: 'secreta' }),
        }),
      );
      expect(getToken()).toBe('tok');
      expect(getUsername()).toBe('oper');
    });

    it('lanza el error del backend y no guarda sesión', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse({ error: 'Credenciales inválidas' }, { ok: false, status: 401 })),
      );

      await expect(login('oper', 'mala')).rejects.toThrow('Credenciales inválidas');
      expect(getToken()).toBeNull();
    });

    it('usa un mensaje por defecto si el backend no manda error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({}, { ok: false, status: 500 })));
      await expect(login('oper', 'mala')).rejects.toThrow('Error de autenticación');
    });
  });

  describe('api()', () => {
    it('prefija /api, manda el token y devuelve el cuerpo parseado', async () => {
      localStorage.setItem('cc_token', 'tok');
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ hola: 'mundo' }));
      vi.stubGlobal('fetch', fetchMock);

      const data = await api<{ hola: string }>('/cosa');

      expect(data).toEqual({ hola: 'mundo' });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/cosa');
      expect((opts as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer tok',
        'Content-Type': 'application/json',
      });
    });

    it('permite agregar headers propios', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({}));
      vi.stubGlobal('fetch', fetchMock);
      await api('/cosa', { headers: { 'X-Extra': '1' } });
      expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'X-Extra': '1' });
    });

    it('lanza el error del backend en respuestas no-ok', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse({ error: 'Sin permiso' }, { ok: false, status: 403 })),
      );
      await expect(api('/cosa')).rejects.toThrow('Sin permiso');
    });

    it('usa "Error <status>" si no viene mensaje', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({}, { ok: false, status: 500 })));
      await expect(api('/cosa')).rejects.toThrow('Error 500');
    });

    it('ante un 401 limpia la sesión, recarga y lanza "Sesión expirada"', async () => {
      localStorage.setItem('cc_token', 'tok');
      localStorage.setItem('cc_user', 'oper');
      const reload = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({}, { ok: false, status: 401 })));

      await expect(api('/cosa')).rejects.toThrow('Sesión expirada');
      expect(getToken()).toBeNull();
      expect(reload).toHaveBeenCalled();
    });
  });
});
