import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  ROLE_RANK,
  login,
  ttlEnSegundos,
  signDroneToken,
  verifyToken,
  requireAuth,
  requireRoles,
  type AuthedRequest,
} from '../../src/auth';
import { config } from '../../src/config';
import { db } from '../../src/db';
import { limpiarBase } from '../helpers';
import { createDrone, listLogs, softDeleteDrone, updateDrone, type Role } from '../../src/store';

function crearUsuario(username: string, password: string, role: Role, active = 1, canControl = 1) {
  db.prepare(
    'INSERT INTO users (username, password_hash, role, active, can_control) VALUES (?, ?, ?, ?, ?)',
  ).run(username, bcrypt.hashSync(password, 4), role, active, canControl);
}

function logsDeSistema() {
  return listLogs({ category: 'sistema', page: 1, pageSize: 50 }).items;
}

// Los tests comparten la base en memoria del archivo: se limpia antes de cada uno.
beforeEach(limpiarBase);

// res falso mínimo para ejercitar el middleware sin levantar Express.
function fakeRes() {
  return {
    statusCode: 0,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: any) {
      this.body = b;
      return this;
    },
  };
}

describe('auth — ROLE_RANK', () => {
  it('ordena los roles jerárquicamente', () => {
    expect(ROLE_RANK.drone).toBeLessThan(ROLE_RANK.field_operator);
    expect(ROLE_RANK.field_operator).toBeLessThan(ROLE_RANK.operator);
    expect(ROLE_RANK.operator).toBeLessThan(ROLE_RANK.supervisor);
    expect(ROLE_RANK.supervisor).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK).toEqual({ drone: 0, field_operator: 1, operator: 2, supervisor: 3, admin: 4 });
  });
});

describe('auth — ttlEnSegundos', () => {
  it('traduce las unidades que usa la configuración', () => {
    expect(ttlEnSegundos('45s')).toBe(45);
    expect(ttlEnSegundos(config.tokenTtlField)).toBe(20 * 60);
    expect(ttlEnSegundos(config.tokenTtl)).toBe(12 * 3600);
    expect(ttlEnSegundos(config.tokenTtlDrone)).toBe(30 * 86400);
  });

  it('un TTL sin unidad se toma como segundos y uno ilegible da 0', () => {
    expect(ttlEnSegundos(' 90 ')).toBe(90);
    expect(ttlEnSegundos('un rato')).toBe(0);
  });
});

describe('auth — login', () => {
  beforeEach(() => {
    crearUsuario('operador', 'operador123', 'operator');
    crearUsuario('campo', 'campo123', 'field_operator', 1, 0);
    crearUsuario('suspendido', 'clave123', 'operator', 0);
  });

  it('login correcto devuelve token + user + expiresIn y registra LOGIN', () => {
    const r = login('operador', 'operador123');
    expect(r).not.toBeNull();
    expect(r!.user).toEqual({ username: 'operador', role: 'operator' });
    expect(r!.expiresIn).toBe(ttlEnSegundos(config.tokenTtl));
    const payload = jwt.verify(r!.token, config.jwtSecret) as jwt.JwtPayload;
    expect(payload.sub).toBe('operador');
    expect(payload.role).toBe('operator');
    expect(logsDeSistema().some((l) => l.type === 'LOGIN')).toBe(true);
  });

  it('la sesión del operador de campo es efímera: 20 minutos', () => {
    const r = login('campo', 'campo123');
    expect(r!.user.role).toBe('field_operator');
    expect(r!.expiresIn).toBe(ttlEnSegundos(config.tokenTtlField));
    // el exp del JWT coincide con el expiresIn informado
    const payload = jwt.verify(r!.token, config.jwtSecret) as jwt.JwtPayload;
    expect(payload.exp! - payload.iat!).toBe(ttlEnSegundos(config.tokenTtlField));
  });

  it('contraseña incorrecta devuelve null y registra LOGIN_FAILED', () => {
    expect(login('operador', 'mala')).toBeNull();
    expect(logsDeSistema().some((l) => l.type === 'LOGIN_FAILED')).toBe(true);
  });

  it('usuario inexistente devuelve null y registra LOGIN_FAILED', () => {
    expect(login('nadie', 'x')).toBeNull();
    expect(logsDeSistema().some((l) => l.type === 'LOGIN_FAILED' && l.message.includes('nadie'))).toBe(true);
  });

  it('cuenta desactivada devuelve null y registra LOGIN_REJECTED', () => {
    expect(login('suspendido', 'clave123')).toBeNull();
    const rechazo = logsDeSistema().find((l) => l.type === 'LOGIN_REJECTED');
    expect(rechazo?.message).toMatch(/desactivada/i);
  });

  it('cuenta eliminada devuelve null y el rechazo dice que fue eliminada', () => {
    crearUsuario('exempleado', 'clave123', 'operator');
    db.prepare("UPDATE users SET deleted_at = '2024-01-01T00:00:00.000Z' WHERE username = 'exempleado'").run();
    expect(login('exempleado', 'clave123')).toBeNull();
    const rechazo = logsDeSistema().find((l) => l.type === 'LOGIN_REJECTED');
    expect(rechazo?.message).toMatch(/eliminada/i);
  });
});

describe('auth — tokens', () => {
  it('verifyToken acepta un token firmado con el secreto y rechaza uno inválido', () => {
    const token = jwt.sign({ sub: 'x', role: 'operator' }, config.jwtSecret);
    expect(verifyToken(token)?.sub).toBe('x');
    expect(verifyToken('basura')).toBeNull();
    expect(verifyToken(jwt.sign({ sub: 'x' }, 'otro-secreto'))).toBeNull();
  });

  it('signDroneToken firma el hash como sub, con rol drone y 30 días', () => {
    const token = signDroneToken('a'.repeat(32));
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    expect(payload.sub).toBe('a'.repeat(32));
    expect(payload.role).toBe('drone');
    expect(payload.exp! - payload.iat!).toBe(ttlEnSegundos(config.tokenTtlDrone));
  });
});

describe('auth — requireAuth (middleware)', () => {
  function reqCon(token?: string): AuthedRequest {
    return { headers: token ? { authorization: `Bearer ${token}` } : {} } as AuthedRequest;
  }
  const tokenDe = (sub: string, role: Role) => jwt.sign({ sub, role }, config.jwtSecret);

  it('401 si falta el token o el header no es Bearer', () => {
    let next = false;
    const res1 = fakeRes();
    requireAuth()(reqCon(), res1 as any, () => (next = true));
    expect(res1.statusCode).toBe(401);
    expect(next).toBe(false);

    const res2 = fakeRes();
    requireAuth()({ headers: { authorization: 'Basic abc' } } as AuthedRequest, res2 as any, () => {});
    expect(res2.statusCode).toBe(401);
  });

  it('401 si el token es inválido', () => {
    const res = fakeRes();
    requireAuth()(reqCon('token-roto'), res as any, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('401 si el usuario del token ya no existe', () => {
    const res = fakeRes();
    requireAuth()(reqCon(tokenDe('fantasma', 'admin')), res as any, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/inexistente/i);
  });

  it('403 si la cuenta está desactivada', () => {
    crearUsuario('desac', 'x', 'operator', 0);
    const res = fakeRes();
    requireAuth()(reqCon(tokenDe('desac', 'operator')), res as any, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/desactivada/i);
  });

  it('403 si la cuenta fue eliminada, aunque el token siga siendo válido', () => {
    crearUsuario('exop', 'x', 'operator');
    db.prepare("UPDATE users SET deleted_at = '2024-01-01T00:00:00.000Z' WHERE username = 'exop'").run();
    const res = fakeRes();
    requireAuth()(reqCon(tokenDe('exop', 'operator')), res as any, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/eliminada/i);
  });

  it('403 si el rol es menor al mínimo exigido', () => {
    crearUsuario('op', 'x', 'operator');
    const res = fakeRes();
    requireAuth('admin')(reqCon(tokenDe('op', 'operator')), res as any, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/permiso/i);
  });

  it('llama a next y setea req.user (rol y flags EN VIVO desde la base)', () => {
    crearUsuario('sup', 'x', 'supervisor', 1, 0);
    // el token dice operator, pero la base manda: role supervisor, canControl false
    const req = reqCon(tokenDe('sup', 'operator'));
    let llamado = false;
    const res = fakeRes();
    requireAuth('operator')(req, res as any, () => (llamado = true));
    expect(llamado).toBe(true);
    expect(req.user).toEqual({ sub: 'sup', role: 'supervisor', canControl: false });
  });

  it('el token del dron se resuelve contra la tabla drones, no contra users', () => {
    const dron = createDrone({ displayName: 'Alfa' }, 'campo');
    const req = reqCon(signDroneToken(dron.hash));
    let llamado = false;
    const res = fakeRes();
    requireAuth()(req, res as any, () => (llamado = true));
    expect(llamado).toBe(true);
    expect(req.user).toEqual({ sub: dron.hash, role: 'drone', canControl: false });
  });

  it('401 dron inexistente, 403 dron eliminado, 403 dron desactivado', () => {
    const res401 = fakeRes();
    requireAuth()(reqCon(signDroneToken('b'.repeat(32))), res401 as any, () => {});
    expect(res401.statusCode).toBe(401);
    expect(res401.body.error).toMatch(/Dron inexistente/i);

    const borrado = createDrone({ displayName: 'Borrado' }, 'campo');
    softDeleteDrone(borrado.hash, 'supervisor');
    const res403b = fakeRes();
    requireAuth()(reqCon(signDroneToken(borrado.hash)), res403b as any, () => {});
    expect(res403b.statusCode).toBe(403);
    expect(res403b.body.error).toMatch(/eliminado/i);

    const apagado = createDrone({ displayName: 'Apagado' }, 'campo');
    updateDrone(apagado.hash, { active: false });
    const res403d = fakeRes();
    requireAuth()(reqCon(signDroneToken(apagado.hash)), res403d as any, () => {});
    expect(res403d.statusCode).toBe(403);
    expect(res403d.body.error).toMatch(/desactivado/i);
  });

  it('el dron nunca alcanza un rango mínimo de operador', () => {
    const dron = createDrone({ displayName: 'Alfa' }, 'campo');
    const res = fakeRes();
    requireAuth('operator')(reqCon(signDroneToken(dron.hash)), res as any, () => {});
    expect(res.statusCode).toBe(403);
  });
});

describe('auth — requireRoles (permiso lateral, no jerárquico)', () => {
  function reqCon(token?: string): AuthedRequest {
    return { headers: token ? { authorization: `Bearer ${token}` } : {} } as AuthedRequest;
  }
  const tokenDe = (sub: string, role: Role) => jwt.sign({ sub, role }, config.jwtSecret);

  it('deja pasar solo a los roles listados, sin importar el rango', () => {
    crearUsuario('campo', 'x', 'field_operator', 1, 0);
    crearUsuario('op', 'x', 'operator');

    const reqCampo = reqCon(tokenDe('campo', 'field_operator'));
    let pasoCampo = false;
    requireRoles('field_operator', 'supervisor', 'admin')(reqCampo, fakeRes() as any, () => (pasoCampo = true));
    expect(pasoCampo).toBe(true);
    expect(reqCampo.user?.role).toBe('field_operator');

    // el operador tiene MÁS rango que el de campo y aun así queda afuera
    const res = fakeRes();
    requireRoles('field_operator', 'supervisor', 'admin')(reqCon(tokenDe('op', 'operator')), res as any, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/permiso/i);
  });

  it('propaga el rechazo de identidad igual que requireAuth', () => {
    const res = fakeRes();
    requireRoles('admin')(reqCon(), res as any, () => {});
    expect(res.statusCode).toBe(401);
  });
});
