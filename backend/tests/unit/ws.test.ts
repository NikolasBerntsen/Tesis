import { describe, it, expect, beforeEach } from 'vitest';
import { limpiarBase } from '../helpers';
import { createDrone, softDeleteDrone } from '../../src/store';
import {
  applyRename, broadcastDroneUpdated, droneCard, getController, getLastStatus, isOnline,
  kickDrone, listDroneCards, metaDron, releaseControl, sendToDrone,
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
