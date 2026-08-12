import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { createLog, getDrone, getUser, type Role } from './store';

export const ROLE_RANK: Record<Role, number> = {
  drone: 0,
  field_operator: 1,
  operator: 2,
  supervisor: 3,
  admin: 4,
};

export interface TokenPayload {
  sub: string;
  role: Role;
  /** Epoch en segundos que pone jsonwebtoken; el hub lo usa para revalidar sockets. */
  exp?: number;
}

/** Identidad efectiva de la request: rol y flags leídos EN VIVO de la base. */
export interface AuthedUser {
  sub: string;
  role: Role;
  canControl: boolean;
}

export interface Sesion {
  token: string;
  /** Segundos de vida del token: la app de campo muestra la cuenta regresiva. */
  expiresIn: number;
  user: { username: string; role: Role };
}

/**
 * Por qué se rechazó un inicio de sesión. El motivo viaja hasta la respuesta
 * porque no es lo mismo equivocarse de contraseña que tener la cuenta dada de
 * baja: al usuario de campo hay que poder explicarle por qué no entra.
 */
export type MotivoRechazo = 'credenciales' | 'eliminada' | 'desactivada';

export type LoginResult = ({ ok: true } & Sesion) | { ok: false; motivo: MotivoRechazo };

const SEGUNDOS_POR_UNIDAD: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Traduce un TTL de jsonwebtoken ('20m', '12h', '30d') a segundos. */
export function ttlEnSegundos(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return Number(ttl) || 0;
  return Number(m[1]) * SEGUNDOS_POR_UNIDAD[m[2]];
}

/** Cada rol vive lo que necesita: el de campo poco, el dron todo un despliegue. */
function ttlDelRol(role: Role): string {
  if (role === 'drone') return config.tokenTtlDrone;
  if (role === 'field_operator') return config.tokenTtlField;
  return config.tokenTtl;
}

function firmar(sub: string, role: Role): { token: string; expiresIn: number } {
  const payload: TokenPayload = { sub, role };
  const expiresIn = ttlEnSegundos(ttlDelRol(role));
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn } as jwt.SignOptions);
  return { token, expiresIn };
}

/** Token de máquina del dron: el `sub` es su hash, el mismo que trae el QR. */
export function signDroneToken(hash: string): string {
  return firmar(hash, 'drone').token;
}

export function login(username: string, password: string): LoginResult {
  const user = getUser(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    createLog('sistema', 'LOGIN_FAILED', username, `Intento de inicio de sesión fallido para "${username}"`);
    return { ok: false, motivo: 'credenciales' };
  }
  if (user.deleted_at) {
    createLog('sistema', 'LOGIN_REJECTED', username, `Inicio de sesión rechazado: la cuenta "${username}" fue eliminada`);
    return { ok: false, motivo: 'eliminada' };
  }
  if (!user.active) {
    createLog('sistema', 'LOGIN_REJECTED', username, `Inicio de sesión rechazado: la cuenta "${username}" está desactivada`);
    return { ok: false, motivo: 'desactivada' };
  }
  const { token, expiresIn } = firmar(user.username, user.role);
  createLog('sistema', 'LOGIN', username, `${username} inició sesión (${user.role})`);
  return { ok: true, token, expiresIn, user: { username: user.username, role: user.role } };
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
  } catch {
    return null;
  }
}

export interface AuthedRequest extends Request {
  user?: AuthedUser;
}

type Resolucion = { ok: true; user: AuthedUser } | { ok: false; status: number; error: string };

/**
 * Resuelve quién hace la request contra el estado ACTUAL de la base: el token
 * solo dice a qué tabla mirar (los drones viven en `drones`, las personas en
 * `users`). Así una desactivación o un borrado surten efecto al instante.
 */
function resolverIdentidad(req: AuthedRequest): Resolucion {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload) return { ok: false, status: 401, error: 'Token inválido o ausente' };

  if (payload.role === 'drone') {
    const drone = getDrone(payload.sub);
    if (!drone) return { ok: false, status: 401, error: 'Dron inexistente' };
    if (drone.deletedAt) return { ok: false, status: 403, error: 'Dron eliminado' };
    if (!drone.active) return { ok: false, status: 403, error: 'Dron desactivado' };
    return { ok: true, user: { sub: drone.hash, role: 'drone', canControl: false } };
  }

  const user = getUser(payload.sub);
  if (!user) return { ok: false, status: 401, error: 'Usuario inexistente' };
  if (user.deleted_at) return { ok: false, status: 403, error: 'Cuenta eliminada' };
  if (!user.active) return { ok: false, status: 403, error: 'Cuenta desactivada' };
  return { ok: true, user: { sub: user.username, role: user.role, canControl: !!user.can_control } };
}

/** Exige un JWT válido y, si se indica, un rol MÍNIMO (los roles son jerárquicos). */
export function requireAuth(minRole?: Role) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const r = resolverIdentidad(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    if (minRole && ROLE_RANK[r.user.role] < ROLE_RANK[minRole]) {
      return res.status(403).json({ error: 'Rol sin permiso para esta operación' });
    }
    req.user = r.user;
    next();
  };
}

/**
 * Para los permisos que NO son jerárquicos: el operador de campo puede dar de
 * alta drones y emparejarlos, pero no está "por debajo" del operador de consola
 * ni por encima, así que el rango no alcanza para expresarlo.
 */
export function requireRoles(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const r = resolverIdentidad(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    if (!roles.includes(r.user.role)) {
      return res.status(403).json({ error: 'Rol sin permiso para esta operación' });
    }
    req.user = r.user;
    next();
  };
}
