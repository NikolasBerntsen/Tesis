import { describe, expect, it } from 'vitest';
import {
  avisoDeLaLiberacion,
  avisoDelFin,
  esFinDelPedido,
  esPedidoDelHub,
  GRACIA_DEL_PEDIDO_MS,
  liberacionDe,
  quienTeQuitoElControl,
  MARGEN_DEL_TITULAR_MS,
  pedidoLocal,
  segundosParaContestar,
  segundosRestantes,
  sinLosVencidos,
  type FinDelPedido,
} from './control';

// Las piezas del control manual entre personas que se deciden sin pantalla:
// las formas que llegan del hub, la cuenta regresiva con el reloj de este
// navegador y lo que se le dice a cada uno cuando un pedido termina.

const PEDIDO = { solicitante: 'relevo', titular: 'piloto', venceEn: '2026-10-24T12:00:10.000Z', restanteMs: 10_000 };

function fin(resultado: FinDelPedido['resultado'], motivo = 'porque sí'): FinDelPedido {
  return { droneId: 'd1', solicitante: 'relevo', titular: 'piloto', resultado, motivo };
}

describe('control — lo que llega del hub', () => {
  it('reconoce un pedido y descarta lo que no lo es', () => {
    expect(esPedidoDelHub(PEDIDO)).toBe(true);
    expect(esPedidoDelHub(null)).toBe(false);
    expect(esPedidoDelHub('pedido')).toBe(false);
    expect(esPedidoDelHub({ ...PEDIDO, solicitante: '' })).toBe(false);
    expect(esPedidoDelHub({ ...PEDIDO, titular: 7 })).toBe(false);
    expect(esPedidoDelHub({ ...PEDIDO, restanteMs: '10000' })).toBe(false);
    expect(esPedidoDelHub({ ...PEDIDO, restanteMs: Number.NaN })).toBe(false);
  });

  it('reconoce el fin de un pedido y descarta un resultado que no conoce', () => {
    for (const resultado of ['cedido', 'vencido', 'mantenido', 'cancelado', 'liberado'] as const) {
      expect(esFinDelPedido(fin(resultado)), resultado).toBe(true);
    }
    expect(esFinDelPedido({ ...fin('cedido'), resultado: 'quizas' })).toBe(false);
    expect(esFinDelPedido({ ...fin('cedido'), droneId: '' })).toBe(false);
    expect(esFinDelPedido(undefined)).toBe(false);
  });

  it('cuenta el plazo con el reloj de este navegador, no con el del hub', () => {
    // El hub dice que vence a las 12:00:10, pero este reloj va una hora atrás:
    // lo que vale es lo que le quedaba al salir el mensaje.
    const ahora = Date.parse('2026-10-24T11:00:00.000Z');
    const pedido = pedidoLocal('d1', PEDIDO, ahora);
    expect(pedido).toEqual({ droneId: 'd1', solicitante: 'relevo', titular: 'piloto', venceEnMs: ahora + 10_000 });
    expect(segundosRestantes(pedido, ahora)).toBe(10);
    // redondea para arriba: con 200 ms queda "1 s", nunca "0 s" con tiempo
    expect(segundosRestantes(pedido, ahora + 9_800)).toBe(1);
    expect(segundosRestantes(pedido, ahora + 10_000)).toBe(0);
    expect(segundosRestantes(pedido, ahora + 60_000)).toBe(0);
    // un restante negativo (un mensaje viejo) no corre el vencimiento para atrás
    expect(pedidoLocal('d1', { ...PEDIDO, restanteMs: -5 }, ahora).venceEnMs).toBe(ahora);
  });

  it('al titular la cuenta se le termina un margen antes que al hub, para que la respuesta no llegue vencida', () => {
    const ahora = Date.parse('2026-10-24T11:00:00.000Z');
    const pedido = pedidoLocal('d1', PEDIDO, ahora);
    expect(MARGEN_DEL_TITULAR_MS).toBe(1_000);
    expect(segundosParaContestar(pedido, ahora)).toBe(9);
    // en el borde: al que pidió todavía le queda "1 s", al titular ya no
    const borde = pedido.venceEnMs - MARGEN_DEL_TITULAR_MS;
    expect(segundosParaContestar(pedido, borde - 1)).toBe(1);
    expect(segundosParaContestar(pedido, borde)).toBe(0);
    expect(segundosRestantes(pedido, borde)).toBe(1);
  });

  it('descarta los pedidos que vencieron hace más de la gracia, y si no sobra ninguno devuelve el mismo objeto', () => {
    const ahora = Date.parse('2026-10-24T11:00:00.000Z');
    const pedidos = {
      d1: pedidoLocal('d1', PEDIDO, ahora),
      d2: pedidoLocal('d2', { ...PEDIDO, restanteMs: 2_000 }, ahora),
    };
    expect(sinLosVencidos(pedidos, ahora + 2_000 + GRACIA_DEL_PEDIDO_MS - 1)).toBe(pedidos);
    expect(sinLosVencidos(pedidos, ahora + 2_000 + GRACIA_DEL_PEDIDO_MS)).toEqual({ d1: pedidos.d1 });
    expect(sinLosVencidos(pedidos, ahora + 10_000 + GRACIA_DEL_PEDIDO_MS)).toEqual({});
  });
});

describe('control — lo que se le dice a cada uno cuando el pedido termina', () => {
  it('al que pidió', () => {
    const texto = (r: FinDelPedido['resultado']) => avisoDelFin(fin(r, 'piloto soltó el control'), 'relevo', 'Alfa');
    expect(texto('cedido')).toEqual({ droneId: 'd1', tono: 'bueno', texto: 'piloto te cedió el control de Alfa.' });
    expect(texto('vencido')).toEqual({
      droneId: 'd1', tono: 'bueno', texto: 'piloto no contestó a tiempo: ahora tenés el control de Alfa.',
    });
    expect(texto('mantenido')).toEqual({ droneId: 'd1', tono: 'malo', texto: 'piloto decidió mantener el control de Alfa.' });
    expect(texto('liberado')?.texto).toBe(
      'piloto ya no tiene el control de Alfa (piloto soltó el control): el dron está libre, lo podés tomar desde su vista.',
    );
    expect(texto('cancelado')).toEqual({
      droneId: 'd1', tono: 'neutro', texto: 'Tu pedido del control de Alfa se canceló: piloto soltó el control.',
    });
  });

  it('al que tenía el control', () => {
    const texto = (r: FinDelPedido['resultado']) => avisoDelFin(fin(r, 'relevo canceló el pedido'), 'piloto', 'Alfa');
    expect(texto('cedido')?.texto).toBe('Le cediste el control de Alfa a relevo.');
    expect(texto('vencido')).toEqual({
      droneId: 'd1', tono: 'malo', texto: 'No contestaste a tiempo: el control de Alfa pasó a relevo.',
    });
    expect(texto('mantenido')?.texto).toBe('Mantuviste el control de Alfa.');
    expect(texto('cancelado')?.texto).toBe('relevo ya no pide el control de Alfa (relevo canceló el pedido).');
    // lo soltó él o se lo quitaron: eso ya lo dice la vista del dron
    expect(texto('liberado')).toBeNull();
  });

  it('a los demás, nada', () => {
    expect(avisoDelFin(fin('cedido'), 'supervisor', 'Alfa')).toBeNull();
  });
});

/** La liberación de un `control_changed` del hub (§3), con lo que cada prueba cambie. */
function soltado(campos: Record<string, unknown> = {}) {
  const liberacion = liberacionDe({ controlledBy: null, teniaElControl: 'piloto', ...campos });
  if (!liberacion) throw new Error('no es una liberación');
  return liberacion;
}

describe('control — el control que el hub soltó solo', () => {
  it('por inactividad: se lo dice a quien lo tenía y a los demás, y que el dron no sale a patrullar', () => {
    const inactividad = soltado({ motivo: 'inactividad', por: 'Comando Central', forzado: true });
    const propio = avisoDeLaLiberacion(inactividad, 'piloto', 'd1', 'Alfa');
    expect(propio?.tono).toBe('malo');
    expect(propio?.texto).toMatch(/^Se soltó el control de Alfa: tu consola estuvo 30 s sin dar señales/);
    expect(propio?.texto).toContain('El dron no sale a patrullar solo');
    // y no promete que queda quieto: eso es solo el que estaba en vuelo manual (PROTOCOLS §2)
    expect(propio?.texto).toContain('si lo estaban volando a mano, queda quieto donde está con el mando en el control físico');
    expect(propio?.texto).toContain('si seguía un objetivo, un relevo o un aterrizaje, sigue con eso');
    const ajeno = avisoDeLaLiberacion(inactividad, 'supervisor', 'd1', 'Alfa');
    expect(ajeno?.texto).toMatch(/^Se soltó el control de Alfa: la consola de piloto estuvo 30 s/);
  });

  it('porque la app del dron no lo tenía tomado', () => {
    expect(avisoDeLaLiberacion(soltado({ motivo: 'app' }), 'supervisor', 'd1', 'Alfa')).toEqual({
      droneId: 'd1',
      tono: 'malo',
      texto: 'Se soltó el control de Alfa que tenía piloto: la app del dron avisó que ya no lo tenía tomado.',
    });
  });

  it('con el texto de la app dice por qué no se tomó, en vez de que "la app lo soltó"', () => {
    const detalle = 'no se tomó el control: alguien pidió el regreso a base desde el control físico, y el que está al lado del dron manda.';
    expect(avisoDeLaLiberacion(soltado({ motivo: 'app', detalle }), 'piloto', 'd1', 'Alfa')).toEqual({
      droneId: 'd1',
      tono: 'malo',
      texto:
        'Se soltó el control de Alfa que tenía piloto: la app del dron avisó: no se tomó el control: alguien pidió el ' +
        'regreso a base desde el control físico, y el que está al lado del dron manda.',
    });
    // Un detalle que no es texto (un hub raro) no rompe el aviso.
    expect(avisoDeLaLiberacion(soltado({ motivo: 'app', detalle: 7 }), 'piloto', 'd1', 'Alfa')?.texto).toContain(
      'ya no lo tenía tomado',
    );
    expect(avisoDeLaLiberacion(soltado({ motivo: 'app', detalle: '   ' }), 'piloto', 'd1', 'Alfa')?.texto).toContain(
      'ya no lo tenía tomado',
    );
  });

  it('un soltar común, o un motivo que la consola no conoce, no avisa nada', () => {
    expect(avisoDeLaLiberacion(soltado({ por: 'piloto' }), 'piloto', 'd1', 'Alfa')).toBeNull();
    expect(avisoDeLaLiberacion(soltado({ motivo: 'otra_cosa', por: 'x', forzado: true }), 'piloto', 'd1', 'Alfa')).toBeNull();
  });
});

describe('control — el control que otra persona te quitó', () => {
  const llegada = { por: 'supervisor', forzado: true, detalle: 'supervisor ordenó volver a la base' };

  it('liberacionDe lee el control_changed de un soltar; una toma, un traspaso o un hub viejo sin titular no lo son', () => {
    expect(soltado(llegada)).toEqual({
      teniaElControl: 'piloto', por: 'supervisor', forzado: true, motivo: null, detalle: 'supervisor ordenó volver a la base',
    });
    expect(liberacionDe({ controlledBy: 'piloto' })).toBeNull();
    expect(liberacionDe({ controlledBy: 'oper2', teniaElControl: 'piloto' })).toBeNull();
    expect(liberacionDe({ controlledBy: null })).toBeNull();
    // Lo que no es del tipo esperado se toma como que no vino.
    expect(soltado({ por: 3, forzado: 'si', detalle: '  ' })).toMatchObject({ por: null, forzado: false, detalle: null });
  });

  it('al que lo tenía: quién, de qué dron y por qué, con el porqué del registro sin repetir el nombre', () => {
    expect(avisoDeLaLiberacion(soltado(llegada), 'piloto', 'd1', 'Alfa')).toEqual({
      droneId: 'd1', tono: 'malo', texto: 'supervisor te quitó el control de Alfa: ordenó volver a la base.',
    });
    const aterrizar = soltado({ ...llegada, detalle: 'supervisor ordenó aterrizar' });
    expect(quienTeQuitoElControl(aterrizar, 'piloto')).toBe('supervisor te quitó el control: ordenó aterrizar');
    // Un porqué que no nombra a quien lo dio pasa entero.
    const baja = soltado({ por: 'admin', forzado: true, detalle: 'el dron fue desactivado.' });
    expect(quienTeQuitoElControl(baja, 'piloto', 'Alfa')).toBe('admin te quitó el control de Alfa: el dron fue desactivado');
    // «Quitar control» no tiene porqué: la frase termina en el control.
    expect(quienTeQuitoElControl(soltado({ por: 'supervisor', forzado: true }), 'piloto', 'Alfa')).toBe(
      'supervisor te quitó el control de Alfa',
    );
  });

  it('con la vista de pilotaje de ese dron abierta no hay aviso flotante: lo dice la vista que se cierra', () => {
    expect(avisoDeLaLiberacion(soltado(llegada), 'piloto', 'd1', 'Alfa', true)).toBeNull();
  });

  it('a los demás, lo que soltó él mismo, lo que soltó el hub solo o lo que no fue a la fuerza, nada', () => {
    expect(avisoDeLaLiberacion(soltado(llegada), 'oper2', 'd1', 'Alfa')).toBeNull();
    expect(quienTeQuitoElControl(soltado({ ...llegada, por: 'piloto' }), 'piloto')).toBeNull();
    expect(quienTeQuitoElControl(soltado({ ...llegada, forzado: false }), 'piloto')).toBeNull();
    expect(quienTeQuitoElControl(soltado({ por: 'Comando Central', forzado: true }), 'piloto')).toBeNull();
    expect(quienTeQuitoElControl(soltado({ forzado: true }), 'piloto')).toBeNull();
  });
});
