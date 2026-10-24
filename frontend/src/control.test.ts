import { describe, expect, it } from 'vitest';
import {
  avisoDeLaLiberacion,
  avisoDelFin,
  esFinDelPedido,
  esPedidoDelHub,
  pedidoLocal,
  segundosRestantes,
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

describe('control — el control que el hub soltó solo', () => {
  it('por inactividad: se lo dice a quien lo tenía y a los demás, y que el dron no sale a patrullar', () => {
    const propio = avisoDeLaLiberacion('inactividad', 'piloto', 'piloto', 'd1', 'Alfa');
    expect(propio?.tono).toBe('malo');
    expect(propio?.texto).toMatch(/^Se soltó el control de Alfa: tu consola estuvo 30 s sin dar señales/);
    expect(propio?.texto).toContain('El dron no sale a patrullar solo');
    const ajeno = avisoDeLaLiberacion('inactividad', 'piloto', 'supervisor', 'd1', 'Alfa');
    expect(ajeno?.texto).toMatch(/^Se soltó el control de Alfa: la consola de piloto estuvo 30 s/);
  });

  it('porque la app del dron no lo tenía tomado', () => {
    expect(avisoDeLaLiberacion('app', 'piloto', 'supervisor', 'd1', 'Alfa')).toEqual({
      droneId: 'd1',
      tono: 'malo',
      texto: 'Se soltó el control de Alfa que tenía piloto: la app del dron avisó que ya no lo tenía tomado.',
    });
  });

  it('un soltar común, o un motivo que la consola no conoce, no avisa nada', () => {
    expect(avisoDeLaLiberacion(undefined, 'piloto', 'piloto', 'd1', 'Alfa')).toBeNull();
    expect(avisoDeLaLiberacion('otra_cosa', 'piloto', 'piloto', 'd1', 'Alfa')).toBeNull();
  });
});
