import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  armarQuery,
  cerrarSesion,
  clearSession,
  ErrorDeApi,
  getRole,
  getToken,
  getUsername,
  login,
  motivoDelRechazoDeDecision,
  parsearMeta,
  traerDrones,
  traerLogs,
  traerUsuarios,
} from './api';

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

    it('clearSession borra token, usuario y rol', () => {
      localStorage.setItem('cc_token', 'abc123');
      localStorage.setItem('cc_user', 'nikolas');
      localStorage.setItem('cc_role', 'admin');
      clearSession();
      expect(getToken()).toBeNull();
      expect(getUsername()).toBe('');
      expect(getRole()).toBeNull();
    });

    it('getRole devuelve null cuando no hay rol guardado', () => {
      expect(getRole()).toBeNull();
    });

    it('getRole devuelve el rol guardado', () => {
      localStorage.setItem('cc_role', 'field_operator');
      expect(getRole()).toBe('field_operator');
    });

    it('getRole ignora un valor que no sea un rol de la consola', () => {
      localStorage.setItem('cc_role', 'drone');
      expect(getRole()).toBeNull();
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

    it('guarda el rol que informa el backend', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse({ token: 'tok', user: { username: 'campo', role: 'field_operator' } })),
      );
      await login('campo', 'campo123');
      expect(getRole()).toBe('field_operator');
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

  describe('cerrarSesion', () => {
    it('avisa al backend con el token y el motivo', async () => {
      localStorage.setItem('cc_token', 'tok');
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);

      await cerrarSesion('emparejamiento completado');

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/logout',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
          body: JSON.stringify({ motivo: 'emparejamiento completado' }),
        }),
      );
    });

    it('no molesta al backend si no hay sesión que cerrar', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await cerrarSesion();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no tira aunque el backend esté caído', async () => {
      localStorage.setItem('cc_token', 'tok');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sin red')));
      await expect(cerrarSesion()).resolves.toBeUndefined();
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

    // El código viaja con el error: quien llama distingue un 409 de un 403 sin
    // comparar textos, que el backend puede reescribir cuando quiera.
    it('el error lleva el código HTTP además del texto del backend', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse({ error: 'Alerta inexistente o ya decidida' }, { ok: false, status: 409 })),
      );
      const error = await api('/cosa').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ErrorDeApi);
      expect(error).toBeInstanceOf(Error);
      expect((error as ErrorDeApi).status).toBe(409);
      expect((error as ErrorDeApi).message).toBe('Alerta inexistente o ya decidida');
    });

    it('el 401 también sale con su código', async () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload: vi.fn() },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({}, { ok: false, status: 401 })));
      const error = await api('/cosa').catch((e: unknown) => e);
      expect((error as ErrorDeApi).status).toBe(401);
    });
  });

  describe('motivoDelRechazoDeDecision', () => {
    it('el 409 dice que otro operador ya la decidió, no el texto genérico', () => {
      expect(motivoDelRechazoDeDecision(new ErrorDeApi('Alerta inexistente o ya decidida', 409))).toBe(
        'Esta alerta ya la decidió otro operador: la lista se actualiza sola.',
      );
    });

    it.each([
      [404, 'La alerta ya no existe.'],
      [401, 'La sesión venció: volvé a iniciar sesión para decidir la alerta.'],
      [403, 'Tu usuario no puede decidir alertas.'],
    ])('el %i tiene su propio motivo', (status, motivo) => {
      expect(motivoDelRechazoDeDecision(new ErrorDeApi('x', status))).toBe(motivo);
    });

    it('cualquier otro rechazo conserva el detalle', () => {
      expect(motivoDelRechazoDeDecision(new ErrorDeApi('Error 500', 500))).toBe(
        'No se pudo registrar la decisión: Error 500',
      );
      expect(motivoDelRechazoDeDecision(new Error('Failed to fetch'))).toBe(
        'No se pudo registrar la decisión: Failed to fetch',
      );
      expect(motivoDelRechazoDeDecision('raro')).toBe('No se pudo registrar la decisión: raro');
    });
  });

  describe('armarQuery', () => {
    it('devuelve cadena vacía cuando no hay nada que mandar', () => {
      expect(armarQuery({ page: undefined, q: '', droneId: null })).toBe('');
    });

    it('arma la query encodeando los valores', () => {
      expect(armarQuery({ category: 'usuarios', page: 2, pageSize: 50, q: 'a b' })).toBe(
        '?category=usuarios&page=2&pageSize=50&q=a+b',
      );
    });
  });

  describe('atajos de las vistas', () => {
    function stubFetch(body: unknown) {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(body));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('traerLogs pide la página con los filtros', async () => {
      const fetchMock = stubFetch({ items: [], total: 0, page: 1, pageSize: 25 });
      const pagina = await traerLogs({ category: 'drone', page: 3, pageSize: 100 });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/logs?category=drone&page=3&pageSize=100');
      expect(pagina.pageSize).toBe(25);
    });

    it('traerLogs sin filtros pide el registro entero', async () => {
      const fetchMock = stubFetch({ items: [], total: 0, page: 1, pageSize: 25 });
      await traerLogs();
      expect(fetchMock.mock.calls[0][0]).toBe('/api/logs');
    });

    it('traerDrones agrega includeDeleted solo si se pide', async () => {
      let fetchMock = stubFetch([]);
      await traerDrones();
      expect(fetchMock.mock.calls[0][0]).toBe('/api/drones');
      fetchMock = stubFetch([]);
      await traerDrones({ incluirEliminados: true });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/drones?includeDeleted=1');
    });

    it('traerUsuarios agrega includeDeleted solo si se pide', async () => {
      let fetchMock = stubFetch([]);
      await traerUsuarios();
      expect(fetchMock.mock.calls[0][0]).toBe('/api/users');
      fetchMock = stubFetch([]);
      await traerUsuarios({ incluirEliminados: true });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/users?includeDeleted=1');
    });
  });

  describe('parsearMeta', () => {
    it('devuelve un objeto vacío si no hay meta', () => {
      expect(parsearMeta(null)).toEqual({});
    });

    it('no explota con JSON roto ni con formas inesperadas', () => {
      expect(parsearMeta('{no es json')).toEqual({});
      expect(parsearMeta('[1,2,3]')).toEqual({});
      expect(parsearMeta('"un texto suelto"')).toEqual({});
    });

    it('lee el meta de un DRONE_UPDATED', () => {
      const meta = parsearMeta(
        JSON.stringify({
          drone: { hash: 'abc', displayName: 'Alfa', model: 'DJI Mini 3' },
          antes: { displayName: 'Alfa', activo: true, base: null },
          despues: { displayName: 'Alfa II', activo: false, base: 'Base Sur' },
        }),
      );
      expect(meta.drone).toEqual({ hash: 'abc', displayName: 'Alfa', model: 'DJI Mini 3' });
      expect(meta.antes).toEqual({ displayName: 'Alfa', activo: true, base: null });
      expect(meta.despues?.base).toBe('Base Sur');
    });

    it('lee el meta de un DRONE_PAIRED con la ubicación del operador', () => {
      const meta = parsearMeta(
        JSON.stringify({
          por: 'campo',
          ubicacion: { lat: -34.9, lon: -56.2, accuracyM: 12 },
          dispositivo: 'Pixel 7',
          drone: { hash: 'abc', displayName: 'Alfa', model: '' },
        }),
      );
      expect(meta.por).toBe('campo');
      expect(meta.dispositivo).toBe('Pixel 7');
      expect(meta.ubicacion).toEqual({ lat: -34.9, lon: -56.2, accuracyM: 12 });
    });

    it('descarta la ubicación sin coordenadas y deja accuracyM en null', () => {
      expect(parsearMeta(JSON.stringify({ ubicacion: null })).ubicacion).toBeUndefined();
      expect(parsearMeta(JSON.stringify({ ubicacion: { lat: -34.9 } })).ubicacion).toBeUndefined();
      expect(parsearMeta(JSON.stringify({ ubicacion: { lat: 1, lon: 2 } })).ubicacion).toEqual({
        lat: 1,
        lon: 2,
        accuracyM: null,
      });
    });

    it('lee la alerta y descarta la que no trae id', () => {
      const meta = parsearMeta(
        JSON.stringify({ alerta: { id: 7, tipo: 'PERSON', lat: -34.9, lon: -56.2, ts: '2024-01-01T00:00:00.000Z' }, decision: 'VALIDATED' }),
      );
      expect(meta.alerta).toEqual({ id: 7, tipo: 'PERSON', lat: -34.9, lon: -56.2, ts: '2024-01-01T00:00:00.000Z' });
      expect(meta.decision).toBe('VALIDATED');
      expect(parsearMeta(JSON.stringify({ alerta: { tipo: 'PERSON' } })).alerta).toBeUndefined();
    });

    it('descarta la ficha de dron vacía', () => {
      expect(parsearMeta(JSON.stringify({ drone: { model: 'DJI' } })).drone).toBeUndefined();
      expect(parsearMeta(JSON.stringify({ drone: 'abc' })).drone).toBeUndefined();
    });

    it('deja afuera los campos que no se pueden pintar en una fila', () => {
      const meta = parsearMeta(
        JSON.stringify({ detalle: { ruta: 'Perimetral', nodo: 3, extra: { anidado: true }, lista: [1] } }),
      );
      expect(meta.detalle).toEqual({ ruta: 'Perimetral', nodo: 3 });
      expect(parsearMeta(JSON.stringify({ antes: { anidado: {} } })).antes).toBeUndefined();
    });
  });
});
