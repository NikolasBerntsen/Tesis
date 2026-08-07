import { Router } from 'express';
import { login } from '../auth';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username y password son requeridos' });
  }
  const result = login(username, password);
  if (!result) return res.status(401).json({ error: 'Credenciales inválidas' });
  res.json(result);
});
