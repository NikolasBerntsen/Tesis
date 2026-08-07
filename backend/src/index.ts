import http from 'node:http';
import cors from 'cors';
import express from 'express';
import { config } from './config';
import { authRouter } from './routes/auth.routes';
import { apiRouter } from './routes/api.routes';
import { setupWebSocket } from './ws';

const app = express();
app.use(cors());
// Límite alto porque las alertas pueden traer un snapshot JPEG en base64
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api', apiRouter);

const server = http.createServer(app);
setupWebSocket(server);

server.listen(config.port, () => {
  console.log(`Comando Central escuchando en http://localhost:${config.port}`);
});
