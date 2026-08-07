import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { getUser } from './store';

export interface TokenPayload {
  sub: string;
  role: 'operator' | 'drone';
}

export function login(username: string, password: string): { token: string; user: { username: string; role: string } } | null {
  const user = getUser(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return null;
  const payload: TokenPayload = { sub: user.username, role: user.role };
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: config.tokenTtl } as jwt.SignOptions);
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
  user?: TokenPayload;
}

/** Middleware: exige JWT válido y, si se indican roles, que el rol esté entre ellos. */
export function requireAuth(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Token inválido o ausente' });
    if (roles.length > 0 && !roles.includes(payload.role)) {
      return res.status(403).json({ error: 'Rol sin permiso para esta operación' });
    }
    req.user = payload;
    next();
  };
}
