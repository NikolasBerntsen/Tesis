// Pruebas del mock: que las detecciones simuladas lleguen al celular con el
// `frameTs` del último cuadro, como pide el contrato (docs/PROTOCOLS.md §4).
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { tsDeCuadro, completarDeteccion, crearServidor } = require('./server');

test('tsDeCuadro lee el ts de un video_frame y nada más', () => {
  assert.equal(tsDeCuadro(JSON.stringify({ type: 'video_frame', jpegBase64: 'x', ts: 1700000000123 })), 1700000000123);
  assert.equal(tsDeCuadro(JSON.stringify({ type: 'video_frame', ts: '123' })), undefined);
  assert.equal(tsDeCuadro(JSON.stringify({ type: 'detection', ts: 5 })), undefined);
  assert.equal(tsDeCuadro('no es json'), undefined);
  assert.equal(tsDeCuadro('null'), undefined);
});

test('completarDeteccion agrega el frameTs del último cuadro', () => {
  const salida = JSON.parse(completarDeteccion(JSON.stringify({ type: 'detection', detected: true, classes: ['PERSON'] }), 42));
  assert.equal(salida.frameTs, 42);
  assert.deepEqual(salida.classes, ['PERSON']);
});

test('completarDeteccion: sin cuadros todavía va null, y respeta uno propio', () => {
  assert.equal(JSON.parse(completarDeteccion(JSON.stringify({ type: 'detection' }), undefined)).frameTs, null);
  assert.equal(JSON.parse(completarDeteccion(JSON.stringify({ type: 'detection', frameTs: 7 }), 42)).frameTs, 7);
});

test('completarDeteccion deja pasar tal cual lo que no es un detection', () => {
  assert.equal(completarDeteccion('no es json', 1), 'no es json');
  const otro = JSON.stringify({ type: 'otra_cosa' });
  assert.equal(completarDeteccion(otro, 1), otro);
});

function abrir(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function siguiente(ws, tipo) {
  return new Promise((resolve) => {
    ws.on('message', function alLlegar(data) {
      const msg = JSON.parse(data.toString());
      if (msg.type === tipo) {
        ws.off('message', alLlegar);
        resolve(msg);
      }
    });
  });
}

test('de punta a punta: el botón del visor llega al celular atado al último cuadro', async () => {
  const server = crearServidor();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const celular = await abrir(`ws://127.0.0.1:${port}/phone`);
  const visor = await abrir(`ws://127.0.0.1:${port}/viewer`);
  try {
    const cuadroEnElVisor = siguiente(visor, 'video_frame');
    celular.send(JSON.stringify({ type: 'video_frame', jpegBase64: 'AAAA', ts: 1700000000999 }));
    await cuadroEnElVisor; // el servidor ya vio el cuadro
    const deteccion = siguiente(celular, 'detection');
    visor.send(JSON.stringify({ type: 'detection', detected: true, classes: ['VEHICLE'], confidence: 0.9, ts: 1 }));
    const msg = await deteccion;
    assert.equal(msg.frameTs, 1700000000999);
    assert.deepEqual(msg.classes, ['VEHICLE']);
  } finally {
    celular.close();
    visor.close();
    await new Promise((r) => server.close(r));
  }
});
