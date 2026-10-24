// El control manual entre personas visto desde la consola (PROTOCOLS, "Control
// manual — bloqueo exclusivo", §3 y §5): la señal de vida que mantiene el
// control, el pedido de control a quien lo tiene y lo que se le dice a cada uno
// cuando termina. Acá va lo que se decide sin pantalla: las formas que llegan
// del hub, la cuenta regresiva y los textos.

/**
 * Cada cuánto la consola le dice al hub que sigue ahí mientras tiene el control
 * de un dron (`control_heartbeat`, §3.b), mire o no mire, mande o no mande. El
 * hub suelta el control a los 30 s sin señales: seis latidos de margen, para
 * que un corte corto de la red o una pestaña que recarga no le saquen el dron
 * a nadie.
 */
export const LATIDO_MS = 5_000;

/** Lo que tiene el titular para contestar un pedido (el hub manda el mismo número en `restanteMs`). */
export const PLAZO_DE_RESPUESTA_MS = 10_000;

/** Lo que tarda el hub en soltar a un titular sin señales de vida. */
export const SIN_SENALES_S = 30;

/**
 * Lo que el titular le resta a su plazo para contestar. Su cuenta regresiva
 * arranca cuando le llega el pedido, una latencia después que la del hub, y
 * el hub toma como no contestada toda respuesta que le llega vencida: un
 * «Mantener el control» apretado con la pantalla en «1 s» podía llegar tarde y
 * pasarle el dron al otro. Con este margen las respuestas se van antes de que
 * el hub deje de aceptarlas.
 */
export const MARGEN_DEL_TITULAR_MS = 1_000;

/**
 * Cuánto después de vencer se descarta solo un pedido que en esta consola
 * nunca terminó: el barrido del hub (cada 1 s) ya lo resolvió y el
 * `control_request_result` tendría que haber llegado. Lo que lo deja vivo es
 * una recarga de /drones armada antes del final que llega después de él.
 */
export const GRACIA_DEL_PEDIDO_MS = 3_000;

/** Un pedido de control tal como llega del hub: en `control_request` y en la ficha del dron. */
export interface PedidoDelHub {
  solicitante: string;
  titular: string;
  /** Con el reloj del hub: para el registro, no para la cuenta regresiva. */
  venceEn: string;
  /** Lo que le quedaba cuando salió el mensaje: de acá sale la cuenta regresiva. */
  restanteMs: number;
}

/**
 * Un pedido pendiente en la consola. El vencimiento va con el reloj de ESTE
 * navegador (`Date.now()` al recibirlo más lo que le quedaba): el del hub no
 * tiene por qué coincidir, y una cuenta regresiva hecha con un reloj adelantado
 * diría "quedan 0 s" desde el primer momento.
 */
export interface PedidoDeControl {
  droneId: string;
  solicitante: string;
  titular: string;
  venceEnMs: number;
}

/** Cómo terminó un pedido (`control_request_result`, §3). */
export type ResultadoDelPedido = 'cedido' | 'vencido' | 'mantenido' | 'cancelado' | 'liberado';

export interface FinDelPedido {
  droneId: string;
  solicitante: string;
  titular: string;
  resultado: ResultadoDelPedido;
  motivo: string;
}

const RESULTADOS: readonly string[] = ['cedido', 'vencido', 'mantenido', 'cancelado', 'liberado'];

function esTexto(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Si lo que vino tiene la forma de un pedido; lo que no, se ignora (no tumba la consola). */
export function esPedidoDelHub(v: unknown): v is PedidoDelHub {
  const p = v as Partial<PedidoDelHub> | null;
  return (
    typeof p === 'object' && p !== null && esTexto(p.solicitante) && esTexto(p.titular) &&
    typeof p.restanteMs === 'number' && Number.isFinite(p.restanteMs)
  );
}

export function esFinDelPedido(v: unknown): v is FinDelPedido {
  const f = v as Partial<FinDelPedido> | null;
  return (
    typeof f === 'object' && f !== null && esTexto(f.droneId) && esTexto(f.solicitante) && esTexto(f.titular) &&
    typeof f.resultado === 'string' && RESULTADOS.includes(f.resultado)
  );
}

/** El pedido del hub con el vencimiento pasado a este reloj. */
export function pedidoLocal(droneId: string, p: PedidoDelHub, ahora: number): PedidoDeControl {
  return { droneId, solicitante: p.solicitante, titular: p.titular, venceEnMs: ahora + Math.max(0, p.restanteMs) };
}

/** Los segundos que le quedan, redondeados para arriba: "1 s" hasta el final, nunca "0 s" con tiempo. */
export function segundosRestantes(pedido: PedidoDeControl, ahora: number): number {
  return Math.max(0, Math.ceil((pedido.venceEnMs - ahora) / 1000));
}

/** Los segundos que le quedan al titular para contestar, ya con su margen restado (ver `MARGEN_DEL_TITULAR_MS`). */
export function segundosParaContestar(pedido: PedidoDeControl, ahora: number): number {
  return segundosRestantes({ ...pedido, venceEnMs: pedido.venceEnMs - MARGEN_DEL_TITULAR_MS }, ahora);
}

/**
 * Los pedidos sin los que vencieron hace más de `GRACIA_DEL_PEDIDO_MS`. Si no
 * sobra ninguno devuelve el mismo objeto, para que el estado no cambie y la
 * consola no se redibuje por nada.
 */
export function sinLosVencidos(
  pedidos: Record<string, PedidoDeControl>,
  ahora: number,
): Record<string, PedidoDeControl> {
  const vigentes = Object.entries(pedidos).filter(([, p]) => ahora < p.venceEnMs + GRACIA_DEL_PEDIDO_MS);
  return vigentes.length === Object.keys(pedidos).length ? pedidos : Object.fromEntries(vigentes);
}

/** Un aviso del control para esta consola: el fin de un pedido o un control que se soltó solo. */
export interface AvisoDelControl {
  id: number;
  droneId: string;
  texto: string;
  /** `bueno`: el control es tuyo; `malo`: no se pudo o te lo sacaron; `neutro`, lo demás. */
  tono: 'bueno' | 'malo' | 'neutro';
}

/**
 * Lo que se le dice a quien pidió el control y a quien lo tenía cuando el
 * pedido termina. A los demás, nada: un supervisor que mira no necesita saber
 * que alguien le pidió el dron a otro. `null` si a esta consola no le toca.
 */
export function avisoDelFin(fin: FinDelPedido, yo: string, nombre: string): Omit<AvisoDelControl, 'id'> | null {
  if (fin.solicitante === yo) return avisoParaElQuePidio(fin, nombre);
  if (fin.titular === yo) return avisoParaElTitular(fin, nombre);
  return null;
}

function avisoParaElQuePidio(fin: FinDelPedido, nombre: string): Omit<AvisoDelControl, 'id'> {
  const { droneId, titular, motivo } = fin;
  switch (fin.resultado) {
    case 'cedido':
      return { droneId, tono: 'bueno', texto: `${titular} te cedió el control de ${nombre}.` };
    case 'vencido':
      return { droneId, tono: 'bueno', texto: `${titular} no contestó a tiempo: ahora tenés el control de ${nombre}.` };
    case 'mantenido':
      return { droneId, tono: 'malo', texto: `${titular} decidió mantener el control de ${nombre}.` };
    case 'liberado':
      return {
        droneId,
        tono: 'neutro',
        texto: `${titular} ya no tiene el control de ${nombre} (${motivo}): el dron está libre, lo podés tomar desde su vista.`,
      };
    default:
      return { droneId, tono: 'neutro', texto: `Tu pedido del control de ${nombre} se canceló: ${motivo}.` };
  }
}

function avisoParaElTitular(fin: FinDelPedido, nombre: string): Omit<AvisoDelControl, 'id'> | null {
  const { droneId, solicitante, motivo } = fin;
  switch (fin.resultado) {
    case 'cedido':
      return { droneId, tono: 'neutro', texto: `Le cediste el control de ${nombre} a ${solicitante}.` };
    case 'vencido':
      return { droneId, tono: 'malo', texto: `No contestaste a tiempo: el control de ${nombre} pasó a ${solicitante}.` };
    case 'mantenido':
      return { droneId, tono: 'neutro', texto: `Mantuviste el control de ${nombre}.` };
    case 'cancelado':
      return { droneId, tono: 'neutro', texto: `${solicitante} ya no pide el control de ${nombre} (${motivo}).` };
    // Lo soltó él, o se lo quitaron: eso ya lo dice la vista del dron.
    default:
      return null;
  }
}

/**
 * Lo que se dice cuando el hub soltó el control solo (`control_changed` con
 * `motivo`, §3): el titular estuvo 30 s sin dar señales, o la app del dron
 * avisó que no lo tenía tomado. Se le dice a toda consola que lo reciba: el
 * dron quedó sin nadie al mando y en un estado que no es el de siempre. `null`
 * con un motivo que la consola no conoce (un hub más nuevo).
 */
export function avisoDeLaLiberacion(
  motivo: unknown,
  teniaElControl: string,
  yo: string,
  droneId: string,
  nombre: string,
): Omit<AvisoDelControl, 'id'> | null {
  // Lo que hace la app al soltarlo así (PROTOCOLS §2): solo el que estaba en
  // vuelo manual queda quieto; el que seguía un objetivo o un relevo vuelve a
  // eso, y el que aterrizaba sigue bajando.
  const quedo =
    'El dron no sale a patrullar solo: si lo estaban volando a mano, queda quieto donde está con el mando en el ' +
    'control físico; si seguía un objetivo, un relevo o un aterrizaje, sigue con eso. Lo pueden volver a tomar ' +
    'desde la consola.';
  if (motivo === 'inactividad') {
    const quien = teniaElControl === yo ? 'tu consola estuvo' : `la consola de ${teniaElControl} estuvo`;
    return {
      droneId,
      tono: 'malo',
      texto: `Se soltó el control de ${nombre}: ${quien} ${SIN_SENALES_S} s sin dar señales al Comando Central. ${quedo}`,
    };
  }
  if (motivo === 'app') {
    return {
      droneId,
      tono: 'malo',
      texto: `Se soltó el control de ${nombre} que tenía ${teniaElControl}: la app del dron avisó que ya no lo tenía tomado.`,
    };
  }
  return null;
}
