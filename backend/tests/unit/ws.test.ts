import { describe, it, expect, beforeEach } from 'vitest';
import { limpiarBase } from '../helpers';
import { createDrone, softDeleteDrone } from '../../src/store';
import {
  applyRename, broadcastDroneUpdated, bytesDelFrame, droneCard, getController, getLastStatus,
  isOnline, kickDrone, listDroneCards, metaDron, releaseControl, sendToDrone, textoDelFrame,
} from '../../src/ws';

// El hub sin sockets abiertos: las consultas sobre drones que no existen (o que
// existen pero están desconectados) tienen que resolver en vez de romper.
beforeEach(limpiarBase);

describe('ws — hub sin conexiones', () => {
  it('un dron desconocido no tiene ficha, ni meta, ni estado, ni control', () => {
    expect(droneCard('inexistente')).toBeNull();
    expect(metaDron('inexistente')).toBeUndefined();
    expect(isOnline('inexistente')).toBe(false);
    expect(getLastStatus('inexistente')).toBeNull();
    expect(getController('inexistente')).toBeNull();
    expect(sendToDrone('inexistente', { type: 'ping' })).toBe(false);
    expect(kickDrone('inexistente', 'Dron eliminado')).toBe(false);
    expect(releaseControl('inexistente', 'admin', { resume: 'none' })).toBe(false);
    expect(applyRename('inexistente', 'X', true)).toBeUndefined();
    // avisar por un dron que no existe no rompe, simplemente no emite nada
    expect(() => broadcastDroneUpdated('inexistente')).not.toThrow();
  });

  it('la ficha de un dron eliminado se sigue pudiendo consultar', () => {
    const d = createDrone({ displayName: 'Fantasma', model: 'M1' }, 'supervisor');
    softDeleteDrone(d.hash, 'supervisor');

    const card = droneCard(d.hash);
    expect(card?.deletedAt).toBeTruthy();
    expect(card?.online).toBe(false);
    expect(metaDron(d.hash)).toEqual({ hash: d.hash, displayName: 'Fantasma', model: 'M1' });
    // pero renombrarlo ya no se puede
    expect(applyRename(d.hash, 'Otro', false)).toBeUndefined();
    // y no aparece en el listado salvo que se pidan los eliminados
    expect(listDroneCards()).toHaveLength(0);
    expect(listDroneCards({ includeDeleted: true }).map((c) => c.hash)).toEqual([d.hash]);
  });
});

// El tope del mensaje de consola se mide con esto ANTES de decodificar nada, así
// que tiene que dar bien para las tres formas en las que `ws` puede entregar un
// frame: un arreglo de fragmentos al que se le lea `.byteLength` da `undefined`,
// y `undefined > TOPE` es false en JS — el tope fallaría abierto justo con el
// frame más grande.
describe('ws — bytesDelFrame', () => {
  it('cuenta los bytes de un Buffer, no las letras del texto', () => {
    // 'ñ' es UNA unidad de UTF-16 y DOS bytes de UTF-8: medir el string ya
    // decodificado deja pasar el doble de lo que el tope dice permitir.
    const texto = 'ñ'.repeat(600);
    expect(texto.length).toBe(600);
    expect(bytesDelFrame(Buffer.from(texto, 'utf8'))).toBe(1200);
  });

  it('cuenta un ArrayBuffer y una lista de fragmentos', () => {
    const uno = Buffer.from('hola');
    expect(bytesDelFrame(uno.buffer.slice(uno.byteOffset, uno.byteOffset + 4))).toBe(4);
    expect(bytesDelFrame([Buffer.alloc(700), Buffer.alloc(400)])).toBe(1100);
    expect(bytesDelFrame([])).toBe(0);
  });
});

// El texto tiene que salir de la MISMA forma en que se midieron los bytes. Un
// `.toString()` pelado solo hace lo correcto con un Buffer: con las otras dos
// formas que admite `RawData` devuelve basura y el mando se perdía en silencio.
describe('ws — textoDelFrame', () => {
  const mando = '{"type":"manual_stick","droneId":"abc","pitch":1,"roll":0,"yaw":0,"throttle":0}';

  it('decodifica las tres formas en que `ws` puede entregar un frame', () => {
    const buf = Buffer.from(mando, 'utf8');
    expect(textoDelFrame(buf)).toBe(mando);
    // ArrayBuffer: `.toString()` daría la cadena literal '[object ArrayBuffer]'
    expect(textoDelFrame(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))).toBe(mando);
    // Lista de fragmentos: `Array.prototype.toString` los une con COMAS, así que
    // un JSON partido al medio salía con una coma de más y no parseaba.
    const corte = 20;
    expect(textoDelFrame([buf.subarray(0, corte), buf.subarray(corte)])).toBe(mando);
  });

  it('respeta los acentos partidos entre dos fragmentos', () => {
    // La eñe ocupa dos bytes: si el corte cae en el medio, decodificar cada
    // fragmento por separado la rompe. Por eso se concatena y recién ahí se pasa
    // a texto.
    const buf = Buffer.from('añil', 'utf8');
    expect(textoDelFrame([buf.subarray(0, 2), buf.subarray(2)])).toBe('añil');
  });
});
