import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { authRouter } from './routes/auth.routes';
import { apiRouter } from './routes/api.routes';
import { setupWebSocket } from './ws';

/** Arma la app y el servidor HTTP+WS sin ponerlo a escuchar. */
export function createServer() {
  const app = express();
  app.use(cors());
  // Límite alto porque las alertas pueden traer un snapshot JPEG en base64
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api', apiRouter);

  // En producción el contenedor copia el build del frontend a ./public y el
  // backend lo sirve; en desarrollo la carpeta no existe y Vite hace de proxy.
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  }

  const server = http.createServer(app);
  setupWebSocket(server);
  return server;
}
