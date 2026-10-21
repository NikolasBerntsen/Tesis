// Placeholder del software de detección que correrá en la laptop.
// Recibe el video del celular en /phone, lo muestra en un visor web y permite
// simular detecciones con botones. El software real de visión por computadora
// (detection/servidor.py) reemplaza este proceso implementando el mismo
// contrato de mensajes (docs/PROTOCOLS.md §4).
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8765;

// El `ts` de un video_frame del celular, o undefined si el mensaje no es uno.
function tsDeCuadro(texto) {
  let msg;
  try {
    msg = JSON.parse(texto);
  } catch {
    return undefined;
  }
  if (!msg || msg.type !== 'video_frame') return undefined;
  return typeof msg.ts === 'number' && Number.isFinite(msg.ts) ? msg.ts : undefined;
}

// Una detección de los botones del visor, con el `frameTs` que el contrato
// pide en todo `detection`: el del último cuadro que mandó el celular, igual
// que hace detection/servidor.py. Con eso la app la procesa por el mismo
// camino que una del modelo (busca la pose del dron en ese instante). Lo que
// no es un `detection` pasa tal cual.
function completarDeteccion(texto, ultimoFrameTs) {
  let msg;
  try {
    msg = JSON.parse(texto);
  } catch {
    return texto;
  }
  if (!msg || typeof msg !== 'object' || msg.type !== 'detection') return texto;
  if (msg.frameTs === undefined || msg.frameTs === null) msg.frameTs = ultimoFrameTs ?? null;
  return JSON.stringify(msg);
}

function crearServidor() {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  let phone = null; // conexión activa con la app de control
  let ultimoFrameTs; // ts del último cuadro que mandó el celular
  const viewers = new Set(); // navegadores mirando el visor

  function broadcastViewers(data) {
    for (const v of viewers) if (v.readyState === WebSocket.OPEN) v.send(data);
  }

  wss.on('connection', (ws, req) => {
    if (req.url && req.url.startsWith('/phone')) {
      phone = ws;
      console.log('Celular conectado');
      broadcastViewers(JSON.stringify({ type: 'phone_status', connected: true }));
      ws.on('message', (data) => {
        const texto = data.toString();
        const ts = tsDeCuadro(texto);
        if (ts !== undefined) ultimoFrameTs = ts;
        broadcastViewers(texto);
      });
      ws.on('close', () => {
        if (phone === ws) phone = null;
        console.log('Celular desconectado');
        broadcastViewers(JSON.stringify({ type: 'phone_status', connected: false }));
      });
    } else {
      viewers.add(ws);
      ws.send(JSON.stringify({ type: 'phone_status', connected: phone !== null }));
      // Los botones del visor generan mensajes "detection" que se reenvían al celular
      ws.on('message', (data) => {
        if (phone && phone.readyState === WebSocket.OPEN) {
          phone.send(completarDeteccion(data.toString(), ultimoFrameTs));
        }
      });
      ws.on('close', () => viewers.delete(ws));
    }
  });

  return server;
}

module.exports = { tsDeCuadro, completarDeteccion, crearServidor };

if (require.main === module) {
  crearServidor().listen(PORT, () => {
    console.log(`Detection-mock escuchando en http://localhost:${PORT}`);
    console.log('El celular debe conectarse a ws://<ip-laptop>:' + PORT + '/phone');
  });
}
