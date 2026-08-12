import { Router } from 'express';
import { login, requireAuth, type AuthedRequest, type MotivoRechazo } from '../auth';
import { createLog } from '../store';

export const authRouter = Router();

// El motivo del rechazo se le dice al usuario: la app de campo y la consola
// tienen que poder explicar por qué no entra, no mandarlo a probar la
// contraseña de nuevo cuando el problema es que la cuenta ya no está.
const MENSAJE_DE_RECHAZO: Record<MotivoRechazo, string> = {
  credenciales: 'Credenciales inválidas',
  eliminada: 'La cuenta fue eliminada',
  desactivada: 'La cuenta está desactivada',
};

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username y password son requeridos' });
  }
  const result = login(username, password);
  if (!result.ok) return res.status(401).json({ error: MENSAJE_DE_RECHAZO[result.motivo] });
  res.json({ token: result.token, expiresIn: result.expiresIn, user: result.user });
});

/**
 * Cierre explícito de sesión. El JWT vive en el cliente y no hay nada que
 * invalidar del lado del servidor: lo que interesa es dejar registrada la
 * sesión efímera del operador de campo, que se cierra sola apenas termina el
 * emparejamiento. Las demás sesiones no dejan rastro al cerrarse.
 */
authRouter.post('/logout', requireAuth(), (req: AuthedRequest, res) => {
  const { sub, role } = req.user!;
  if (role === 'field_operator') {
    const motivo = String(req.body?.motivo ?? '').trim() || 'cierre de sesión';
    const ev = createLog('sistema', 'FIELD_SESSION_CLOSED', sub, `Se cerró la sesión de campo de ${sub} (${motivo})`, {
      meta: { detalle: { por: sub, motivo } },
    });
    return res.json({ ok: true, event: ev });
  }
  res.json({ ok: true });
});
