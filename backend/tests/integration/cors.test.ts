import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type TestServer } from '../helpers';
import { config } from '../../src/config';

/*
 * Antes esto era `app.use(cors())`, que contesta `Access-Control-Allow-Origin: *`:
 * cualquier página abierta en el navegador del operador podía llamar a la API
 * del sistema de patrullaje con la sesión de esa persona. En producción la
 * consola se sirve desde el mismo origen que el backend, y en desarrollo Vite
 * hace de proxy, así que no hacía falta abrirlo para nadie.
 */
describe('CORS', () => {
  let srv: TestServer;

  beforeAll(async () => {
    srv = await startServer();
  });

  afterAll(async () => {
    await srv.close();
  });

  const origenPermitido = config.corsOrigins[0];

  it('la lista por defecto es la consola en desarrollo, no cualquiera', () => {
    expect(config.corsOrigins).toContain('http://localhost:5173');
    expect(config.corsOrigins).not.toContain('*');
  });

  it('a un origen de la lista le responde con ese origen', async () => {
    const r = await fetch(`${srv.base}/api/health`, { headers: { Origin: origenPermitido } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(origenPermitido);
  });

  it('a un origen ajeno NO le habilita la lectura de la respuesta', async () => {
    const r = await fetch(`${srv.base}/api/health`, { headers: { Origin: 'https://sitio-cualquiera.example' } });
    // El servidor responde igual (CORS no es un control de acceso del servidor),
    // pero sin la cabecera el navegador no deja que esa página lea el cuerpo.
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('el preflight de un origen ajeno tampoco lo autoriza', async () => {
    const r = await fetch(`${srv.base}/api/drones`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://sitio-cualquiera.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('un cliente sin Origin (la app Android, curl) sigue funcionando', async () => {
    const r = await fetch(`${srv.base}/api/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
});
