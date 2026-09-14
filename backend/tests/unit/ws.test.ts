import { describe, it, expect, beforeEach } from 'vitest';
import { limpiarBase } from '../helpers';
import { createDrone, softDeleteDrone } from '../../src/store';
import {
  applyRename, broadcastDroneUpdated, bytesDelFrame, droneCard, getController, getLastStatus,
  isOnline, kickDrone, listDroneCards, metaDron, releaseControl, sendToDrone,
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
