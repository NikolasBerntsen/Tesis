import { describe, expect, it } from 'vitest';
import {
  ESTADOS_ACTIVOS,
  TERMINADOS_QUE_SE_GUARDAN,
  aplicarRelevo,
  avisoDeOrdenesEnRelevo,
  avisoDeReanudarEnRelevo,
  duenioDeLaAlerta,
  esRelevo,
  estadoDelRelevo,
  insigniasDelDron,
  motivoDeFin,
  participaDeUnRelevo,
  reemplazarActivos,
  relevoActivo,
  tonoDelEstado,
} from './relevos';
import { makeAlert, makeRelevo as relevo, makeStatus } from './test/fixtures';
import type { DroneStatus, Relevo, RelevoDelDron } from './types';

function enEspera(over: Partial<RelevoDelDron> = {}): RelevoDelDron {
  return { enEspera: true, disponible: true, relayId: null, rol: null, fase: null, ...over };
}

describe('qué relevos están activos', () => {
  it('son los cinco del contrato y no los terminales', () => {
    expect(ESTADOS_ACTIVOS).toEqual(['RESERVADO', 'ORDENADO', 'EN_CAMINO', 'TRASPASO', 'SIN_RELEVO']);
    expect(relevoActivo(relevo({ estado: 'TRASPASO' }))).toBe(true);
    expect(relevoActivo(relevo({ estado: 'FALLIDO' }))).toBe(false);
    expect(relevoActivo(relevo({ estado: 'UN_ESTADO_NUEVO' }))).toBe(false);
  });
});

describe('esRelevo', () => {
  it('pide un id, un estado y los dos lados nombrados', () => {
    expect(esRelevo(relevo())).toBe(true);
    expect(esRelevo(relevo({ relevo: null }))).toBe(true);
    expect(esRelevo(null)).toBe(false);
    expect(esRelevo('relevo')).toBe(false);
    expect(esRelevo({ ...relevo(), id: '7' })).toBe(false);
    expect(esRelevo({ ...relevo(), estado: 3 })).toBe(false);
    expect(esRelevo({ ...relevo(), origen: null })).toBe(false);
    expect(esRelevo({ ...relevo(), relevo: { displayName: 'Bravo' } })).toBe(false);
  });
});

describe('aplicarRelevo', () => {
  it('suma uno nuevo adelante', () => {
    const lista = aplicarRelevo([relevo({ id: 1 })], relevo({ id: 2 }));
    expect(lista.map((r) => r.id)).toEqual([2, 1]);
  });

  it('reemplaza al que tenía el mismo id si es más nuevo', () => {
    const viejo = relevo({ estado: 'ORDENADO', actualizadoEn: '2026-10-23T15:04:10.000Z' });
    const lista = aplicarRelevo([viejo], relevo({ estado: 'EN_CAMINO' }));
    expect(lista).toHaveLength(1);
    expect(lista[0].estado).toBe('EN_CAMINO');
  });

  it('no deja que una versión más vieja pise a la que ya llegó, y devuelve la misma lista', () => {
    const actual = relevo({ estado: 'COMPLETADO', actualizadoEn: '2026-10-23T15:05:00.000Z' });
    const lista = [actual];
    const resultado = aplicarRelevo(lista, relevo({ estado: 'EN_CAMINO' }));
    expect(resultado).toBe(lista);
    expect(resultado[0].estado).toBe('COMPLETADO');
  });

  it('con una hora ilegible gana la que llega', () => {
    const lista = aplicarRelevo([relevo({ actualizadoEn: 'ayer' })], relevo({ estado: 'TRASPASO' }));
    expect(lista[0].estado).toBe('TRASPASO');
  });

  it('de los terminados guarda sólo los más recientes, y los activos nunca se van', () => {
    const terminados = Array.from({ length: TERMINADOS_QUE_SE_GUARDAN }, (_, i) =>
      relevo({ id: 100 + i, estado: 'COMPLETADO', actualizadoEn: new Date(Date.UTC(2026, 9, 23, 10, i)).toISOString() }),
    );
    const activo = relevo({ id: 1, estado: 'EN_CAMINO', actualizadoEn: '2026-10-01T00:00:00.000Z' });
    const otroMas = relevo({ id: 999, estado: 'FALLIDO', actualizadoEn: '2026-10-23T12:00:00.000Z' });
    const lista = aplicarRelevo([activo, ...terminados], otroMas);
    expect(lista).toHaveLength(TERMINADOS_QUE_SE_GUARDAN + 1);
    expect(lista.some((r) => r.id === 1)).toBe(true);
    expect(lista.some((r) => r.id === 999)).toBe(true);
    // El terminado más viejo es el que se fue.
    expect(lista.some((r) => r.id === 100)).toBe(false);
  });
});

describe('reemplazarActivos (la lista del hub al reconectar)', () => {
  it('saca los activos que el hub ya no nombra, deja los terminados y suma los nuevos', () => {
    const terminado = relevo({ id: 1, estado: 'CANCELADO' });
    const perdido = relevo({ id: 2, estado: 'EN_CAMINO' });
    const sigue = relevo({ id: 3, estado: 'ORDENADO', actualizadoEn: '2026-10-23T15:00:00.000Z' });
    const resultado = reemplazarActivos(
      [terminado, perdido, sigue],
      [relevo({ id: 3, estado: 'EN_CAMINO' }), relevo({ id: 4, estado: 'SIN_RELEVO', relevo: null }), { basura: true }],
    );
    expect(resultado.map((r) => [r.id, r.estado]).sort()).toEqual([
      [1, 'CANCELADO'],
      [3, 'EN_CAMINO'],
      [4, 'SIN_RELEVO'],
    ]);
  });

  it('sin una lista (un backend viejo) no toca nada', () => {
    const lista = [relevo()];
    expect(reemplazarActivos(lista, { error: 'no existe' })).toBe(lista);
  });

  it('no saca el que llegó en vivo mientras el pedido iba y volvía: la lista pudo salir antes', () => {
    const enVivo = relevo({ id: 5, estado: 'SIN_RELEVO', relevo: null });
    const perdido = relevo({ id: 2, estado: 'EN_CAMINO' });
    const resultado = reemplazarActivos([enVivo, perdido], [relevo({ id: 3 })], new Set([5]));
    expect(resultado.map((r) => r.id).sort()).toEqual([3, 5]);
    expect(resultado.find((r) => r.id === 5)).toBe(enVivo);
  });
});

describe('rótulos', () => {
  it('traduce los estados y los motivos de fin del contrato, y lo desconocido pasa tal cual', () => {
    expect(estadoDelRelevo('EN_CAMINO')).toBe('En camino');
    expect(estadoDelRelevo('OTRO_ESTADO')).toBe('OTRO_ESTADO');
    expect(motivoDeFin('sin_despegue')).toBe('El dron de relevo no pudo despegar a tiempo');
    expect(motivoDeFin('algo_nuevo')).toBe('algo_nuevo');
    expect(motivoDeFin(null)).toBeNull();
  });

  it('el tono dice cómo va', () => {
    expect(tonoDelEstado('FALLIDO')).toBe('bad');
    expect(tonoDelEstado('SIN_RELEVO')).toBe('warn');
    expect(tonoDelEstado('COMPLETADO')).toBe('ok');
    expect(tonoDelEstado('CANCELADO')).toBe('muted');
    expect(tonoDelEstado('EN_CAMINO')).toBe('accent');
  });
});

describe('insigniasDelDron', () => {
  const textos = (droneId: string, status: DroneStatus | null, relevos: Relevo[]) =>
    insigniasDelDron(droneId, status, relevos).map((i) => i.texto);

  it('sin status ni relevos no hay nada que decir', () => {
    expect(insigniasDelDron('a1', null, [])).toEqual([]);
    expect(insigniasDelDron('a1', makeStatus({ relevo: enEspera({ enEspera: false, disponible: false }) }), [])).toEqual(
      [],
    );
  });

  it('«En espera para relevos» sale del status, en verde si además puede salir', () => {
    const [disponible] = insigniasDelDron('b2', makeStatus({ relevo: enEspera() }), []);
    expect(disponible).toMatchObject({ texto: 'En espera para relevos', tono: 'ok' });
    expect(disponible.titulo).toMatch(/listo para salir/i);

    // Que no puede salir lo dice el texto, no sólo el gris (WCAG 1.4.1).
    const [noPuede] = insigniasDelDron('b2', makeStatus({ relevo: enEspera({ disponible: false }) }), []);
    expect(noPuede).toMatchObject({ texto: 'En espera: no puede salir', tono: 'neutro' });
    expect(noPuede.titulo).toMatch(/revisá la batería, el GPS/i);
  });

  it('en el que lo pidió: «Relevo en camino: Bravo», con lo que tarda en llegar', () => {
    const [insignia] = insigniasDelDron('a1', null, [relevo()]);
    expect(insignia).toMatchObject({ texto: 'Relevo en camino: Bravo', tono: 'oro' });
    expect(insignia.titulo).toBe('Llega en 1 min 14 s, según el hub.');
    expect(insigniasDelDron('a1', null, [relevo({ etaS: null })])[0].titulo).toBeUndefined();
  });

  it('en el que va: «Relevando a Alfa»', () => {
    expect(textos('b2', null, [relevo()])).toEqual(['Relevando a Alfa']);
    expect(textos('b2', null, [relevo({ estado: 'ORDENADO' })])).toEqual(['Relevando a Alfa']);
    expect(textos('b2', null, [relevo({ estado: 'TRASPASO' })])).toEqual(['Relevando a Alfa']);
  });

  it('una reserva todavía no es un relevo en camino, de ninguno de los dos lados', () => {
    const reservado = relevo({ estado: 'RESERVADO', motivo: 'patrulla' });
    expect(insigniasDelDron('a1', null, [reservado])[0]).toMatchObject({ texto: 'Relevo asignado: Bravo', tono: 'info' });
    expect(insigniasDelDron('b2', null, [reservado])[0]).toMatchObject({
      texto: 'Reservado para relevar a Alfa',
      tono: 'info',
    });
    expect(textos('a1', null, [relevo({ estado: 'ORDENADO' })])).toEqual(['Relevo asignado: Bravo']);
  });

  it('el traspaso y el pedido sin candidato también se dicen', () => {
    expect(textos('a1', null, [relevo({ estado: 'TRASPASO' })])).toEqual(['Traspaso a Bravo']);
    const [sinRelevo] = insigniasDelDron('a1', null, [relevo({ estado: 'SIN_RELEVO', relevo: null })]);
    expect(sinRelevo).toMatchObject({ texto: 'Sin relevo disponible', tono: 'malo' });
  });

  it('un relevo terminado, o de otros drones, no deja insignia', () => {
    expect(insigniasDelDron('a1', null, [relevo({ estado: 'COMPLETADO' })])).toEqual([]);
    expect(insigniasDelDron('c3', null, [relevo()])).toEqual([]);
  });

  it('un dron puede estar en espera y en un relevo a la vez: van las dos, la espera primero', () => {
    expect(textos('b2', makeStatus({ relevo: enEspera() }), [relevo({ estado: 'RESERVADO' })])).toEqual([
      'En espera para relevos',
      'Reservado para relevar a Alfa',
    ]);
  });
});

describe('avisoDeOrdenesEnRelevo (RELEVOS §3.9)', () => {
  it('al que va: cualquier orden de patrullaje cancela el relevo', () => {
    expect(avisoDeOrdenesEnRelevo('b2', [relevo()])).toBe(
      'Está yendo a relevar a Alfa: una orden de ruta, de nodo o de retomar cancela el relevo.',
    );
    expect(avisoDeOrdenesEnRelevo('b2', [relevo({ estado: 'ORDENADO' })])).not.toBeNull();
  });

  it('al que pidió un seguimiento: lo hace soltar el objetivo antes del traspaso', () => {
    expect(avisoDeOrdenesEnRelevo('a1', [relevo({ estado: 'TRASPASO' })])).toBe(
      'Bravo viene a relevarlo sobre el objetivo: una orden de ruta, de nodo o de retomar lo hace soltarlo antes del traspaso.',
    );
    expect(avisoDeOrdenesEnRelevo('a1', [relevo({ relevo: null })])).toMatch(/^Otro dron viene a relevarlo/);
  });

  it('nada que avisar: un relevo de patrulla para el que lo pidió, uno reservado, uno terminado o ajeno', () => {
    expect(avisoDeOrdenesEnRelevo('a1', [relevo({ motivo: 'patrulla' })])).toBeNull();
    expect(avisoDeOrdenesEnRelevo('b2', [relevo({ estado: 'RESERVADO' })])).toBeNull();
    expect(avisoDeOrdenesEnRelevo('b2', [relevo({ estado: 'COMPLETADO' })])).toBeNull();
    expect(avisoDeOrdenesEnRelevo('c3', [relevo()])).toBeNull();
  });
});

describe('soltar el control de un dron en un relevo (RELEVOS §3.9)', () => {
  const sinStatus = null;

  it('participa el que lo pidió y el que va, mientras el relevo esté activo', () => {
    expect(participaDeUnRelevo('a1', sinStatus, [relevo()])).toBe(true);
    expect(participaDeUnRelevo('b2', sinStatus, [relevo({ estado: 'RESERVADO' })])).toBe(true);
    expect(participaDeUnRelevo('a1', sinStatus, [relevo({ estado: 'SIN_RELEVO', relevo: null })])).toBe(true);
    expect(participaDeUnRelevo('b2', sinStatus, [relevo({ estado: 'COMPLETADO' })])).toBe(false);
    expect(participaDeUnRelevo('c3', sinStatus, [relevo()])).toBe(false);
    expect(participaDeUnRelevo('c3', undefined, [])).toBe(false);
  });

  it('también cuenta el relevo que informa el teléfono, aunque la consola no lo conozca', () => {
    const enUnRelevo = makeStatus({ relevo: enEspera({ enEspera: false, disponible: false, relayId: 9, rol: 'relevo', fase: 'en_camino' }) });
    expect(participaDeUnRelevo('c3', enUnRelevo, [])).toBe(true);
    // En espera sin relevo asignado no es estar en uno.
    expect(participaDeUnRelevo('c3', makeStatus({ relevo: enEspera() }), [])).toBe(false);
    expect(avisoDeReanudarEnRelevo('c3', enUnRelevo, [])).toBe('Está en un relevo: reanudar el patrullaje lo saca del relevo.');
  });

  it('si el teléfono dice que lo pidió él, el aviso habla de la batería y no de sacarlo del relevo', () => {
    const loPidio = makeStatus({ relevo: enEspera({ enEspera: false, disponible: false, relayId: 9, rol: 'origen', fase: 'pedido' }) });
    expect(participaDeUnRelevo('c3', loPidio, [])).toBe(true);
    expect(avisoDeReanudarEnRelevo('c3', loPidio, [])).toBe(
      'Pidió un relevo: reanudar el patrullaje lo manda a patrullar con la batería que lo hizo pedirlo.',
    );
  });

  it('al que va: reanudar cancela el relevo, o le quita la reserva si todavía no sabía nada', () => {
    expect(avisoDeReanudarEnRelevo('b2', sinStatus, [relevo()])).toBe(
      'Está yendo a relevar a Alfa: reanudar el patrullaje cancela el relevo y Alfa se queda sin relevo.',
    );
    expect(avisoDeReanudarEnRelevo('b2', sinStatus, [relevo({ estado: 'RESERVADO' })])).toBe(
      'Está reservado para relevar a Alfa: reanudar el patrullaje le quita la reserva.',
    );
  });

  it('al que pidió un seguimiento: suelta el objetivo antes de que llegue el otro', () => {
    expect(avisoDeReanudarEnRelevo('a1', sinStatus, [relevo()])).toBe(
      'Pidió un relevo: reanudar el patrullaje le hace soltar el objetivo antes de que llegue Bravo, y patrullar con la batería que lo hizo pedirlo.',
    );
    expect(avisoDeReanudarEnRelevo('a1', sinStatus, [relevo({ estado: 'SIN_RELEVO', relevo: null })])).toMatch(
      /antes de que llegue el relevo,/,
    );
  });

  it('al que pidió uno de patrulla, o ya está en el traspaso: lo manda a patrullar con poca batería', () => {
    const texto = 'Pidió un relevo: reanudar el patrullaje lo manda a patrullar con la batería que lo hizo pedirlo.';
    expect(avisoDeReanudarEnRelevo('a1', sinStatus, [relevo({ motivo: 'patrulla', estado: 'SIN_RELEVO', relevo: null })])).toBe(texto);
    expect(avisoDeReanudarEnRelevo('a1', sinStatus, [relevo({ estado: 'TRASPASO' })])).toBe(texto);
  });

  it('sin relevo activo no hay nada que avisar', () => {
    expect(avisoDeReanudarEnRelevo('a1', sinStatus, [relevo({ estado: 'FALLIDO' })])).toBeNull();
    expect(avisoDeReanudarEnRelevo('a1', makeStatus(), [])).toBeNull();
  });
});

describe('duenioDeLaAlerta', () => {
  it('es el que la sigue ahora, o el que la creó si nadie la heredó', () => {
    expect(duenioDeLaAlerta(makeAlert({ drone_id: 'a1', seguidaPor: 'b2' }))).toBe('b2');
    expect(duenioDeLaAlerta(makeAlert({ drone_id: 'a1', seguidaPor: null }))).toBe('a1');
    // Un backend viejo no manda el campo.
    expect(duenioDeLaAlerta(makeAlert({ drone_id: 'a1' }))).toBe('a1');
    expect(duenioDeLaAlerta(makeAlert({ drone_id: null }))).toBeNull();
  });
});
