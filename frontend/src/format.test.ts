import { describe, expect, it } from 'vitest';
import type { DroneStatus } from './types';
import {
  batteryClass,
  formatDistance,
  initials,
  signalClass,
  fechaYHora,
  STATE_LABELS,
  stateLabel,
  time,
  waypointLabel,
} from './format';

function fakeStatus(over: Partial<DroneStatus> = {}): DroneStatus {
  return {
    droneId: 'd1',
    displayName: 'Alfa',
    state: 'PATROLLING',
    battery: 80,
    lat: -34.6,
    lon: -58.4,
    routeId: 1,
    waypointIndex: 0,
    waypointTotal: 0,
    signal: 'OK',
    signalPct: 90,
    mode: 'TEST',
    ...over,
  };
}

describe('stateLabel', () => {
  it('traduce los estados conocidos', () => {
    expect(stateLabel('IDLE')).toBe('En base');
    expect(stateLabel('PATROLLING')).toBe('Patrullando');
    expect(stateLabel('ORBITING')).toBe('Orbitando objetivo');
    expect(stateLabel('RETURNING_HOME_SIGNAL')).toBe('Volviendo a base (pérdida de señal)');
    expect(stateLabel('RETURNING_HOME_BATTERY')).toBe('Volviendo a base (batería baja)');
    expect(stateLabel('MANUAL')).toBe('Control manual');
    expect(stateLabel('FORCED')).toBe('Desvío a nodo');
  });

  it('devuelve el estado tal cual si es desconocido', () => {
    expect(stateLabel('LO_QUE_SEA')).toBe('LO_QUE_SEA');
  });

  it('el diccionario expone todas las etiquetas', () => {
    expect(Object.keys(STATE_LABELS)).toContain('PAUSED');
  });
});

describe('batteryClass', () => {
  it('bad hasta 25%, warn hasta 40%, ok por encima', () => {
    expect(batteryClass(10)).toBe('bad');
    expect(batteryClass(25)).toBe('bad');
    expect(batteryClass(26)).toBe('warn');
    expect(batteryClass(40)).toBe('warn');
    expect(batteryClass(41)).toBe('ok');
    expect(batteryClass(100)).toBe('ok');
  });
});

describe('signalClass', () => {
  it('bad hasta 20%, warn hasta 50%, ok por encima', () => {
    expect(signalClass(0)).toBe('bad');
    expect(signalClass(20)).toBe('bad');
    expect(signalClass(21)).toBe('warn');
    expect(signalClass(50)).toBe('warn');
    expect(signalClass(51)).toBe('ok');
    expect(signalClass(99)).toBe('ok');
  });
});

describe('waypointLabel', () => {
  it('devuelve guión largo si no hay total de nodos', () => {
    expect(waypointLabel(fakeStatus({ waypointTotal: 0 }))).toBe('—');
  });

  it('muestra "índice+1 de total"', () => {
    expect(waypointLabel(fakeStatus({ waypointIndex: 6, waypointTotal: 10 }))).toBe('7 de 10');
  });
});

describe('initials', () => {
  it('dos palabras: primera letra de cada una', () => {
    expect(initials('Base Norte')).toBe('BN');
  });

  it('una palabra: primeras dos letras en mayúscula', () => {
    expect(initials('Alfa')).toBe('AL');
  });

  it('nombre vacío o sólo espacios: ??', () => {
    expect(initials('   ')).toBe('??');
    expect(initials('')).toBe('??');
  });

  it('colapsa espacios múltiples', () => {
    expect(initials('  Base    Sur  ')).toBe('BS');
  });
});

describe('formatDistance', () => {
  it('metros redondeados por debajo de 1000', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(523.7)).toBe('524 m');
    expect(formatDistance(999)).toBe('999 m');
  });

  it('kilómetros con dos decimales desde 1000', () => {
    expect(formatDistance(1000)).toBe('1.00 km');
    expect(formatDistance(2540)).toBe('2.54 km');
  });
});

describe('time', () => {
  it('formatea un timestamp ISO a la hora local en 24 h', () => {
    const iso = '2024-01-01T12:34:56.000Z';
    expect(time(iso)).toBe(new Date(iso).toLocaleTimeString('es-AR', { hour12: false }));
    // Con el navegador en inglés salía "12:34:56 PM" en una interfaz castellana
    expect(time(iso)).toMatch(/^\d{1,2}:\d{2}:\d{2}$/);
  });
});

describe('fechaYHora', () => {
  it('muestra la fecha además de la hora, para el registro que pagina años', () => {
    expect(fechaYHora('2024-01-04T15:30:00.000Z')).toMatch(/^\d{2}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2}$/);
    // Dos eventos a siete meses de distancia ya no se leen iguales
    expect(fechaYHora('2024-08-04T15:30:00.000Z')).not.toBe(fechaYHora('2024-01-04T15:30:00.000Z'));
  });

  it('devuelve el timestamp crudo si la fila trae una fecha rota', () => {
    expect(fechaYHora('una fecha rota')).toBe('una fecha rota');
  });
});
