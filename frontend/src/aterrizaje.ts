import type { EventRow } from './types';

/**
 * Cómo dice la app que un aterrizaje ordenado no va a terminar en el suelo
 * (PROTOCOLS §1): no lo aceptó, lo aceptó y no baja o lo subieron con las
 * palancas («No se pudo aterrizar: …»), o no lo da en ese estado —un failsafe
 * del DJI, la señal perdida, el descenso final de una emergencia— («No se
 * aterriza (…): …»). Los dos salen siempre, sin el techo de los avisos.
 */
const NO_ATERRIZA = ['No se pudo aterrizar', 'No se aterriza'];

/**
 * El id del evento más nuevo de la lista, o 0 si está vacía: la marca de lo
 * que ya estaba al dar una orden. Los ids los pone el Comando Central y
 * crecen con cada evento, así que lo que llegue después de la orden tiene uno
 * mayor, aunque llegue antes que la respuesta del POST.
 */
export function marcaDeEventos(eventos: readonly EventRow[]): number {
  return eventos.reduce((max, e) => Math.max(max, e.id), 0);
}

/**
 * Si, después de la marca, la app dijo que el aterrizaje de este dron no
 * sigue: una palanca deliberada lo cortó (`LANDING_CANCELLED`) o no se pudo o
 * no se da (`DRONE_PROBLEM`, ver arriba). Es lo que termina el aviso de
 * «Aterrizaje ordenado»: sin esto quedaba prendido para siempre con el dron
 * suspendido o en manos de quien lo vuela.
 */
export function seCortoElAterrizaje(eventos: readonly EventRow[], droneId: string, desde: number): boolean {
  return eventos.some((e) => e.id > desde && e.drone_id === droneId && diceQueNoAterriza(e));
}

/** Si el evento es uno de los que dicen que el aterrizaje ordenado no sigue. */
function diceQueNoAterriza(e: EventRow): boolean {
  if (e.type === 'LANDING_CANCELLED') return true;
  return e.type === 'DRONE_PROBLEM' && NO_ATERRIZA.some((p) => e.message.startsWith(p));
}
