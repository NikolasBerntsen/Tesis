import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ROLE_RANK, login, verifyToken, requireAuth, type AuthedRequest } from '../../src/auth';
import { config } from '../../src/config';
import { db } from '../../src/db';
import { listLogs, type Role } from '../../src/store';

function crearUsuario(username: string, password: string, role: Role, active = 1, canControl = 1) {
  db.prepare(
    'INSERT INTO users (username, password_hash, role, active, can_control) VALUES (?, ?, ?, ?, ?)',
  ).run(username, bcrypt.hashSync(password, 4), role, active, canControl);
}

// Los tests comparten la base en memoria del archivo: se limpia antes de cada uno.
beforeEach(() => {
  db.exec('DELETE FROM events; DELETE FROM alerts; DELETE FROM patrol_routes; DELETE FROM users; DELETE FROM sqlite_sequence;');
});

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
    expect(ROLE_RANK.drone).toBeLessThan(ROLE_RANK.operator);
    expect(ROLE_RANK.operator).toBeLessThan(ROLE_RANK.supervisor);
    expect(ROLE_RANK.supervisor).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK).toEqual({ drone: 0, operator: 1, supervisor: 2, admin: 3 });
  });
});

describe('auth — login', () => {
  beforeEach(() => {
    crearUsuario('operador', 'operador123', 'operator');
    crearUsuario('suspendido', 'clave123', 'operator', 0);
  });

  it('login correcto devuelve token + user y registra LOGIN', () => {
    const r = login('operador', 'operador123');
    expect(r).not.toBeNull();
    expect(r!.user).toEqual({ username: 'operador', role: 'operator' });
    const payload = jwt.verify(r!.token, config.jwtSecret) as any;
    expect(payload.sub).toBe('operador');
    expect(payload.role).toBe('operator');
    expect(listLogs(50, 'sistema').some((l) => l.type === 'LOGIN')).toBe(true);
  });

  it('contraseña incorrecta devuelve null y registra LOGIN_FAILED', () => {
    expect(login('operador', 'mala')).toBeNull();
    expect(listLogs(50, 'sistema').some((l) => l.type === 'LOGIN_FAILED')).toBe(true);
  });

  it('usuario inexistente devuelve null y registra LOGIN_FAILED', () => {
    expect(login('nadie', 'x')).toBeNull();
    const logs = listLogs(50, 'sistema');
    expect(logs.some((l) => l.type === 'LOGIN_FAILED' && l.message.includes('nadie'))).toBe(true);
  });

  it('cuenta desactivada devuelve null y registra LOGIN_REJECTED', () => {
    expect(login('suspendido', 'clave123')).toBeNull();
    expect(listLogs(50, 'sistema').some((l) => l.type === 'LOGIN_REJECTED')).toBe(true);
  });
});

describe('auth — verifyToken', () => {
  it('acepta un token firmado con el secreto y rechaza uno inválido', () => {
    const token = jwt.sign({ sub: 'x', role: 'operator' }, config.jwtSecret);
    expect(verifyToken(token)?.sub).toBe('x');
    expect(verifyToken('basura')).toBeNull();
    expect(verifyToken(jwt.sign({ sub: 'x' }, 'otro-secreto'))).toBeNull();
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
});
