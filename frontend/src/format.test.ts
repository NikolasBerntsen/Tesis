import { describe, expect, it } from 'vitest';
import type { DroneStatus, ObjetivoEnSeguimiento } from './types';
import {
  batteryClass,
  coordenadas,
  coordenadasODato,
  decisionDelObjetivo,
  duracion,
  ETIQUETAS_DE_EVENTO,
  etiquetaDeEvento,
  fechaHoraLarga,
  hashCorto,
  tipoDeAlerta,
  formatDistance,
  haceCuanto,
  initials,
  posicionDelDron,
  posicionValida,
  rumbo,
  signalClass,
  situacionDelObjetivo,
  sobreObjetivo,
  fechaYHora,
  STATE_LABELS,
  stateLabel,
  textoSinGps,
  time,
  tipoDeObjetivo,
  velocidad,
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

  it('siguiendo al objetivo tiene su propia etiqueta', () => {
    expect(stateLabel('FOLLOWING')).toBe('Siguiendo objetivo');
    expect(stateLabel('RETURNING_HOME')).toBe('Volviendo a base (orden del operador de campo)');
  });

  // La lista de `state` de §1 de docs/PROTOCOLS.md. Si el contrato suma un
  // estado, se suma acá y el test pide la etiqueta: si no, la consola lo
  // mostraría crudo, en inglés, justo cuando el operador más necesita leerlo.
  const ESTADOS_DEL_CONTRATO = [
    'IDLE',
    'PATROLLING',
    'ORBITING',
    'FOLLOWING',
    'RETURNING_HOME_SIGNAL',
    'RETURNING_HOME_BATTERY',
    'RETURNING_HOME',
    'LANDED',
    'PAUSED',
    'MANUAL',
    'FORCED',
    // RELEVOS §1: los dos que sumó el diseño de relevos y emergencias.
    'RELEVANDO',
    'ATERRIZAJE_EMERGENCIA',
  ];

  it.each(ESTADOS_DEL_CONTRATO)('%s tiene etiqueta en castellano', (estado) => {
    expect(STATE_LABELS[estado]).toBeTruthy();
    expect(stateLabel(estado)).not.toBe(estado);
  });

  it('los estados nuevos se leen igual que en la pantalla del teléfono', () => {
    expect(stateLabel('RELEVANDO')).toBe('Relevando a otro dron');
    expect(stateLabel('ATERRIZAJE_EMERGENCIA')).toBe('Aterrizaje de emergencia');
  });
});

describe('duracion', () => {
  it('segundos, minutos y minutos con segundos', () => {
    expect(duracion(0)).toBe('0 s');
    expect(duracion(42.4)).toBe('42 s');
    expect(duracion(120)).toBe('2 min');
    expect(duracion(200)).toBe('3 min 20 s');
  });

  it('lo que no es un tiempo es la raya', () => {
    expect(duracion(null)).toBe('—');
    expect(duracion(undefined)).toBe('—');
    expect(duracion(Number.NaN)).toBe('—');
    expect(duracion(-5)).toBe('—');
  });
});

describe('etiquetaDeEvento', () => {
  it('rotula los eventos de relevos, desvíos y emergencias', () => {
    expect(etiquetaDeEvento('RELAY_HANDOVER')).toBe('Traspaso del objetivo');
    expect(etiquetaDeEvento('EMERGENCY_RECOVERED')).toBe('Dron recuperado');
    expect(Object.keys(ETIQUETAS_DE_EVENTO)).toHaveLength(13);
  });

  it('un tipo que no conoce no lleva rótulo', () => {
    expect(etiquetaDeEvento('PATROL_STARTED')).toBeNull();
  });
});

describe('sobreObjetivo', () => {
  it('orbitar y seguir son el mismo momento para la consola', () => {
    expect(sobreObjetivo('ORBITING')).toBe(true);
    expect(sobreObjetivo('FOLLOWING')).toBe(true);
  });

  it('ningún otro estado, ni la falta de estado', () => {
    expect(sobreObjetivo('PATROLLING')).toBe(false);
    expect(sobreObjetivo('MANUAL')).toBe(false);
    expect(sobreObjetivo(null)).toBe(false);
    expect(sobreObjetivo(undefined)).toBe(false);
  });
});

describe('posición del dron', () => {
  it('una posición normal es válida', () => {
    expect(posicionValida(-34.6, -58.4)).toBe(true);
  });

  it.each([
    ['null', null, null],
    ['0,0 exacto (el SDK de DJI sin fix)', 0, 0],
    ['NaN', Number.NaN, -58.4],
    ['infinito', -34.6, Number.POSITIVE_INFINITY],
    ['latitud fuera de rango', 91, -58.4],
    ['longitud fuera de rango', -34.6, 181],
    ['texto', '-34.6', '-58.4'],
  ])('descarta %s', (_caso, lat, lon) => {
    expect(posicionValida(lat, lon)).toBe(false);
  });

  it('un meridiano o un paralelo sueltos en cero sí son posiciones', () => {
    // Sólo el par 0,0 es la marca de "sin dato": el ecuador existe.
    expect(posicionValida(0, -58.4)).toBe(true);
    expect(posicionValida(-34.6, 0)).toBe(true);
  });

  it('posicionDelDron devuelve el par cuando hay fix', () => {
    expect(posicionDelDron(fakeStatus({ lat: -34.6, lon: -58.4, gpsFix: true }))).toEqual([-34.6, -58.4]);
  });

  it('una app vieja no manda gpsFix: se juzga por las coordenadas', () => {
    expect(posicionDelDron(fakeStatus({ lat: -34.6, lon: -58.4 }))).toEqual([-34.6, -58.4]);
  });

  it('sin status, con lat/lon null, con 0,0 o con gpsFix false no hay posición', () => {
    expect(posicionDelDron(null)).toBeNull();
    expect(posicionDelDron(fakeStatus({ lat: null, lon: null }))).toBeNull();
    expect(posicionDelDron(fakeStatus({ lat: 0, lon: 0 }))).toBeNull();
    // gpsFix manda aunque las coordenadas parezcan buenas: son las últimas
    // que el SDK tenía, no dónde está el dron.
    expect(posicionDelDron(fakeStatus({ lat: -34.6, lon: -58.4, gpsFix: false }))).toBeNull();
  });

  it('textoSinGps cuenta los satélites, en singular y plural', () => {
    expect(textoSinGps(3)).toBe('Sin GPS (3 satélites)');
    expect(textoSinGps(1)).toBe('Sin GPS (1 satélite)');
    expect(textoSinGps(0)).toBe('Sin GPS (0 satélites)');
    expect(textoSinGps(undefined)).toBe('Sin GPS');
  });
});

describe('datos del objetivo', () => {
  function objetivo(over: Partial<ObjetivoEnSeguimiento> = {}): ObjetivoEnSeguimiento {
    return {
      alertId: 12,
      type: 'VEHICLE',
      lat: -34.60412,
      lon: -58.3817,
      speedMs: 4.2,
      courseDeg: 118,
      moving: true,
      lost: false,
      lastSeenMs: 600,
      decision: 'PENDING',
      ...over,
    };
  }

  it('coordenadas con seis decimales, listas para pegar en un mapa', () => {
    expect(coordenadas(-34.60412, -58.3817)).toBe('-34.604120, -58.381700');
  });

  it('rumbo en grados y punto cardinal', () => {
    expect(rumbo(118)).toBe('118° SE');
    expect(rumbo(0)).toBe('0° N');
    expect(rumbo(359.6)).toBe('0° N');
    expect(rumbo(270)).toBe('270° O');
    expect(rumbo(-45)).toBe('315° NO');
  });

  it('velocidad en m/s y km/h', () => {
    expect(velocidad(4.2)).toBe('4.2 m/s (15 km/h)');
    expect(velocidad(0)).toBe('0.0 m/s (0 km/h)');
  });

  // La app manda null en vez de NaN (org.json no acepta NaN). Con null la
  // velocidad tiraba un TypeError en pleno render, y el rumbo decía "0° N".
  it('sin estimación de la app (null o no finito) no se inventa un número ni se rompe', () => {
    expect(velocidad(null)).toBe('—');
    expect(velocidad(undefined)).toBe('—');
    expect(velocidad(Number.NaN)).toBe('—');
    expect(rumbo(null)).toBe('—');
    expect(rumbo(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('hace cuánto se lo vio', () => {
    expect(haceCuanto(600)).toBe('hace menos de 1 s');
    expect(haceCuanto(4200)).toBe('hace 4 s');
    expect(haceCuanto(75_000)).toBe('hace 1 min 15 s');
    expect(haceCuanto(Number.NaN)).toBe('hace menos de 1 s');
  });

  it('tipo en castellano, y crudo si viene uno desconocido', () => {
    expect(tipoDeObjetivo('PERSON')).toBe('Persona');
    expect(tipoDeObjetivo('VEHICLE')).toBe('Vehículo');
    expect(tipoDeObjetivo('OTRO')).toBe('OTRO');
  });

  it('situación: perdido manda sobre el movimiento', () => {
    expect(situacionDelObjetivo(objetivo())).toBe('En movimiento');
    expect(situacionDelObjetivo(objetivo({ moving: false }))).toBe('Quieto');
    expect(situacionDelObjetivo(objetivo({ lost: true }))).toBe('Perdido');
  });

  it('decisión', () => {
    expect(decisionDelObjetivo(objetivo())).toBe('Sin decidir');
    expect(decisionDelObjetivo(objetivo({ decision: 'VALIDATED' }))).toBe('Validada por un operador');
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

  // Los dos números llegan del celular sin revisar, y la etiqueta termina
  // adentro del HTML del globo del mapa.
  it('si alguno de los dos no es un número de verdad, muestra la raya', () => {
    const texto = '<img src=x onerror=alert(1)>' as unknown as number;
    expect(waypointLabel(fakeStatus({ waypointIndex: texto, waypointTotal: 10 }))).toBe('—');
    expect(waypointLabel(fakeStatus({ waypointIndex: 2, waypointTotal: texto }))).toBe('—');
    expect(waypointLabel(fakeStatus({ waypointIndex: '3' as unknown as number, waypointTotal: 10 }))).toBe('—');
    expect(waypointLabel(fakeStatus({ waypointIndex: Number.NaN, waypointTotal: 10 }))).toBe('—');
    expect(waypointLabel(fakeStatus({ waypointIndex: 0, waypointTotal: -3 }))).toBe('—');
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

describe('alertas y registro', () => {
  it('tipoDeAlerta: la pastilla en castellano, y un tipo desconocido tal cual', () => {
    expect(tipoDeAlerta('PERSON')).toBe('PERSONA');
    expect(tipoDeAlerta('VEHICLE')).toBe('VEHÍCULO');
    expect(tipoDeAlerta('ANIMAL')).toBe('ANIMAL');
  });

  it('fechaHoraLarga: larga para leer, corta para las columnas, cruda si está rota y raya si falta', () => {
    const iso = '2024-03-04T15:30:00.000Z';
    expect(fechaHoraLarga(iso)).toBe(
      new Date(iso).toLocaleString('es-AR', { dateStyle: 'long', timeStyle: 'medium' }),
    );
    expect(fechaHoraLarga(iso, 'short')).toBe(
      new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }),
    );
    expect(fechaHoraLarga('una fecha rota')).toBe('una fecha rota');
    expect(fechaHoraLarga(null)).toBe('—');
  });

  it('hashCorto: el hash largo se abrevia, el corto queda y sin hash va la raya', () => {
    expect(hashCorto('c54ae4a0aad98bdc6ae5ab810751335c')).toBe('c54ae4…335c');
    expect(hashCorto('corto')).toBe('corto');
    expect(hashCorto(null)).toBe('—');
    expect(hashCorto('')).toBe('—');
  });

  it('coordenadasODato: las coordenadas de siempre, o la raya si falta alguna', () => {
    expect(coordenadasODato(-34.6, -58.4)).toBe('-34.600000, -58.400000');
    expect(coordenadasODato(null, -58.4)).toBe('—');
    expect(coordenadasODato(-34.6, undefined)).toBe('—');
  });
});
