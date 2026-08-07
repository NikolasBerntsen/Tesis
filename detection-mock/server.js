// Placeholder del software de detección que correrá en la laptop.
// Recibe el video del celular en /phone, lo muestra en un visor web y permite
// simular detecciones con botones. El software real de visión por computadora
// reemplazará este proceso implementando el mismo contrato de mensajes.
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8765;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let phone = null; // conexión activa con la app de control
const viewers = new Set(); // navegadores mirando el visor

function broadcastViewers(data) {
  for (const v of viewers) if (v.readyState === WebSocket.OPEN) v.send(data);
}

wss.on('connection', (ws, req) => {
  if (req.url && req.url.startsWith('/phone')) {
    phone = ws;
    console.log('Celular conectado');
    broadcastViewers(JSON.stringify({ type: 'phone_status', connected: true }));
    ws.on('message', (data) => broadcastViewers(data.toString()));
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
      if (phone && phone.readyState === WebSocket.OPEN) phone.send(data.toString());
    });
    ws.on('close', () => viewers.delete(ws));
  }
});

server.listen(PORT, () => {
  console.log(`Detection-mock escuchando en http://localhost:${PORT}`);
  console.log('El celular debe conectarse a ws://<ip-laptop>:' + PORT + '/phone');
});
