import { posicionValida } from './format';
import type { ObjetivoEnSeguimiento } from './types';

/**
 * Rastro del objetivo: por dónde anduvo en el último minuto.
 *
 * El status trae una sola posición del objetivo, la estimación de ESE segundo.
 * Para el equipo de tierra eso no alcanza: un vehículo que dobló en una esquina
 * hace medio minuto está en otra calle, y lo que dice para dónde ir es la
 * trayectoria, no el punto. La app no la manda (no tiene por qué: es historia),
 * así que la arma la consola juntando la posición de cada status.
 */

/** Unas 60 posiciones: con un status por segundo, el último minuto. */
export const MAX_RASTRO = 60;

export interface RastroObjetivo {
  /** De qué alerta es el rastro: con un objetivo nuevo se empieza de cero. */
  alertId: number | null;
  /** Posiciones `[lat, lon]`, de la más vieja a la más nueva. */
  puntos: [number, number][];
}

/**
 * Suma al rastro la posición que trae un status. Devuelve el rastro nuevo, el
 * MISMO si no cambió nada (así el mapa no se redibuja por un objetivo quieto) o
 * `undefined` cuando ya no hay objetivo: el rastro se borra con el seguimiento.
 */
export function sumarAlRastro(
  rastro: RastroObjetivo | undefined,
  objetivo: ObjetivoEnSeguimiento | null | undefined,
): RastroObjetivo | undefined {
  if (!objetivo) return undefined;

  // `alertId` pasa de null a un número cuando llega el `alert_ack`: es el mismo
  // objetivo con el id puesto, y su rastro sigue. Dos ids distintos, en cambio,
  // son dos objetivos, y unir sus trayectorias dibujaría un recorrido que nadie
  // hizo.
  const otroObjetivo =
    rastro !== undefined && rastro.alertId !== null && objetivo.alertId !== null && rastro.alertId !== objetivo.alertId;
  const base: RastroObjetivo = otroObjetivo || !rastro ? { alertId: objetivo.alertId, puntos: [] } : rastro;
  const alertId = objetivo.alertId ?? base.alertId;

  // Una posición rota no suma, y una repetida tampoco: un objetivo quieto
  // llenaría el rastro de sesenta copias del mismo punto y se comería el minuto.
  const ultimo = base.puntos[base.puntos.length - 1];
  const repetida = !!ultimo && ultimo[0] === objetivo.lat && ultimo[1] === objetivo.lon;
  if (!posicionValida(objetivo.lat, objetivo.lon) || repetida) {
    return base === rastro && alertId === rastro.alertId ? rastro : { alertId, puntos: base.puntos };
  }
  return { alertId, puntos: [...base.puntos, [objetivo.lat, objetivo.lon] as [number, number]].slice(-MAX_RASTRO) };
}
