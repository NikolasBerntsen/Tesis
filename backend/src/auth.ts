import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { createLog, getUser, type Role } from './store';

export const ROLE_RANK: Record<Role, number> = { drone: 0, operator: 1, supervisor: 2, admin: 3 };

export interface TokenPayload {
  sub: string;
  role: Role;
}

/** Identidad efectiva de la request: rol y flags leídos EN VIVO de la base. */
export interface AuthedUser {
  sub: string;
  role: Role;
  canControl: boolean;
}

export function login(username: string, password: string): { token: string; user: { username: string; role: Role } } | null {
  const user = getUser(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    createLog('sistema', 'LOGIN_FAILED', username, `Intento de inicio de sesión fallido para "${username}"`);
    return null;
  }
  if (!user.active) {
    createLog('sistema', 'LOGIN_REJECTED', username, `Inicio de sesión rechazado: la cuenta "${username}" está desactivada`);
    return null;
  }
  const payload: TokenPayload = { sub: user.username, role: user.role };
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: config.tokenTtl } as jwt.SignOptions);
  createLog('sistema', 'LOGIN', username, `${username} inició sesión (${user.role})`);
  return { token, user: { username: user.username, role: user.role } };
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

/**
 * Exige un JWT válido y, si se indica, un rol MÍNIMO (los roles son
 * jerárquicos). El rol y los flags no se toman del token sino de la base, así
 * una suspensión o desactivación surte efecto inmediato.
 */
export function requireAuth(minRole?: Role) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Token inválido o ausente' });

    const user = getUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'Usuario inexistente' });
    if (!user.active) return res.status(403).json({ error: 'Cuenta desactivada' });
    if (minRole && ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
      return res.status(403).json({ error: 'Rol sin permiso para esta operación' });
    }
    req.user = { sub: user.username, role: user.role, canControl: !!user.can_control };
    next();
  };
}
