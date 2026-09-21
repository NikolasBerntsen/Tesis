import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { db } from '../../src/db';
import { sembrar, claveDe, usuariosSinClavePropia } from '../../src/seed';
import { limpiarBase } from '../helpers';

/*
 * El seed es el único código del backend que decide con qué usuarios y con qué
 * contraseñas arranca una instalación, así que no tenerlo probado era
 * justamente el agujero que peor se ve: si el día de la demostración `admin` no
 * queda con permiso de control, o una ruta no queda enganchada a su base, no se
 * puede volar nada y no hay ningún test que lo hubiera avisado.
 *
 * Este archivo NO usa el seed de los helpers: llama al de verdad, el de
 * src/seed.ts, contra la base en memoria de este archivo de test.
 */

/** El seed habla por consola; acá no aporta nada. */
function callar() {
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

const CLAVES_DEL_ENTORNO = ['SEED_PASSWORD', 'SEED_PASSWORD_ADMIN', 'SEED_PASSWORD_CAMPO'];

describe('seed de demostración', () => {
  let anotados: ReturnType<typeof callar>;

  beforeEach(() => {
    limpiarBase();
    for (const clave of CLAVES_DEL_ENTORNO) delete process.env[clave];
    anotados = callar();
  });

  afterEach(() => {
    anotados.mockRestore();
    for (const clave of CLAVES_DEL_ENTORNO) delete process.env[clave];
    process.env.NODE_ENV = 'test';
  });

  it('deja los cuatro usuarios con su rol, y solo el de campo sin control', () => {
    sembrar();

    const usuarios = db.prepare('SELECT username, role, can_control, full_name FROM users ORDER BY username').all() as {
      username: string;
      role: string;
      can_control: number;
      full_name: string;
    }[];

    expect(usuarios.map((u) => [u.username, u.role])).toEqual([
      ['admin', 'admin'],
      ['campo', 'field_operator'],
      ['operador', 'operator'],
      ['supervisor', 'supervisor'],
    ]);
    // El operador de campo despliega drones, no los pilotea.
    const porNombre = Object.fromEntries(usuarios.map((u) => [u.username, u]));
    expect(porNombre.campo.can_control).toBe(0);
    expect(porNombre.operador.can_control).toBe(1);
    expect(porNombre.supervisor.can_control).toBe(1);
    expect(porNombre.admin.can_control).toBe(1);
    // El nombre completo se usa en la consola y en el registro de eventos.
    expect(porNombre.admin.full_name).toBe('Diego Antúnez');
  });

  it('las contraseñas sembradas son las que entran por la puerta', () => {
    sembrar();
    for (const usuario of ['campo', 'operador', 'supervisor', 'admin'] as const) {
      const fila = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(usuario) as {
        password_hash: string;
      };
      expect(bcrypt.compareSync(claveDe(usuario), fila.password_hash), usuario).toBe(true);
      // Y no cualquier otra.
      expect(bcrypt.compareSync('no-es-esta', fila.password_hash), usuario).toBe(false);
    }
  });

  it('siembra bases, drones y rutas, y cada ruta queda enganchada a su base', () => {
    sembrar();

    const bases = db.prepare('SELECT id, name FROM bases ORDER BY name').all() as { id: number; name: string }[];
    expect(bases.map((b) => b.name)).toEqual(['Base Obelisco', 'Base Palermo', 'Base Retiro']);

    const drones = db.prepare('SELECT display_name, base_id, inventory_code FROM drones ORDER BY display_name').all() as {
      display_name: string;
      base_id: number;
      inventory_code: string;
    }[];
    expect(drones.map((d) => d.display_name)).toEqual(['Alfa', 'Bravo', 'Charlie']);
    // Un dron sin base no puede patrullar ninguna ruta.
    expect(drones.every((d) => bases.some((b) => b.id === d.base_id))).toBe(true);
    expect(drones.map((d) => d.inventory_code)).toEqual(['INV-ALFA', 'INV-BRAVO', 'INV-CHARLIE']);

    const rutas = db.prepare('SELECT id, name, waypoints FROM patrol_routes ORDER BY name').all() as {
      id: number;
      name: string;
      waypoints: string;
    }[];
    expect(rutas).toHaveLength(4);
    for (const r of rutas) {
      expect(JSON.parse(r.waypoints).length, r.name).toBeGreaterThanOrEqual(4);
      const enganches = db.prepare('SELECT COUNT(*) AS n FROM base_routes WHERE route_id = ?').get(r.id) as { n: number };
      // Ésta es la que importa: una ruta sin base no la puede volar nadie.
      expect(enganches.n, r.name).toBeGreaterThan(0);
    }
  });

  it('el hash del dron es determinista: los QR impresos siguen sirviendo', () => {
    sembrar();
    const primeros = (db.prepare('SELECT hash FROM drones ORDER BY display_name').all() as { hash: string }[]).map(
      (d) => d.hash,
    );

    limpiarBase();
    sembrar();
    const segundos = (db.prepare('SELECT hash FROM drones ORDER BY display_name').all() as { hash: string }[]).map(
      (d) => d.hash,
    );

    expect(segundos).toEqual(primeros);
    expect(primeros.every((h) => /^[0-9a-f]{32}$/.test(h))).toBe(true);
  });

  it('correrlo dos veces no duplica nada', () => {
    sembrar();
    sembrar();

    const cuenta = (tabla: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get() as { n: number }).n;
    expect(cuenta('users')).toBe(4);
    expect(cuenta('bases')).toBe(3);
    expect(cuenta('drones')).toBe(3);
    expect(cuenta('patrol_routes')).toBe(4);
    // El enganche ruta↔base tampoco se duplica (INSERT OR IGNORE).
    expect(cuenta('base_routes')).toBe(4);
  });

  describe('contraseñas', () => {
    it('SEED_PASSWORD_<USUARIO> pisa la de demostración de ese usuario', () => {
      process.env.SEED_PASSWORD_ADMIN = 'clave-propia-del-admin';
      expect(claveDe('admin')).toBe('clave-propia-del-admin');
      expect(claveDe('operador')).toBe('operador123');

      sembrar();
      const fila = db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get() as {
        password_hash: string;
      };
      expect(bcrypt.compareSync('clave-propia-del-admin', fila.password_hash)).toBe(true);
      expect(bcrypt.compareSync('admin123', fila.password_hash)).toBe(false);
    });

    it('SEED_PASSWORD las pisa todas, y la específica gana sobre la general', () => {
      process.env.SEED_PASSWORD = 'para-todos';
      expect(claveDe('operador')).toBe('para-todos');
      expect(claveDe('admin')).toBe('para-todos');

      process.env.SEED_PASSWORD_ADMIN = 'solo-admin';
      expect(claveDe('admin')).toBe('solo-admin');
      expect(claveDe('operador')).toBe('para-todos');
    });

    it('sabe cuáles quedaron con la contraseña de fábrica', () => {
      expect(usuariosSinClavePropia()).toEqual(['campo', 'operador', 'supervisor', 'admin']);

      process.env.SEED_PASSWORD_ADMIN = 'otra';
      expect(usuariosSinClavePropia()).toEqual(['campo', 'operador', 'supervisor']);

      process.env.SEED_PASSWORD = 'todas-otras';
      expect(usuariosSinClavePropia()).toEqual([]);
    });

    it('en producción se niega a sembrar con las contraseñas del informe', () => {
      process.env.NODE_ENV = 'production';

      expect(() => sembrar()).toThrow(/producción/i);
      // Y no dejó nada a medio sembrar.
      expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0);

      // Con contraseñas propias sí siembra.
      process.env.SEED_PASSWORD = 'una-clave-de-verdad';
      expect(() => sembrar()).not.toThrow();
      expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(4);
    });

    it('el mensaje de error dice qué usuarios hay que arreglar', () => {
      process.env.NODE_ENV = 'production';
      process.env.SEED_PASSWORD_ADMIN = 'propia';

      expect(() => sembrar()).toThrow(/campo, operador, supervisor/);
      expect(() => sembrar()).not.toThrow(/admin,/);
    });
  });
});
