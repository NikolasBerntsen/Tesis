import { getDrone, type Alert } from './store';

// Piezas de la columna `meta` que se repiten en los eventos del hub (PROTOCOLS
// §7). Viven aparte de ws.ts para que el coordinador de relevos y el de
// emergencias armen sus eventos con la MISMA forma que el resto sin importar el
// hub, que a su vez los importa a ellos.

/** Lo que el pop-up del registro pinta bajo la clave `drone` de la `meta`. */
export interface MetaDron {
  hash: string;
  displayName: string;
  model: string;
}

export function metaDron(droneId: string): MetaDron | undefined {
  const d = getDrone(droneId);
  return d ? { hash: d.hash, displayName: d.displayName, model: d.model } : undefined;
}

/**
 * Lo que el pop-up pinta bajo la clave `alerta`: con el id trae la alerta
 * completa y muestra la captura. Es la misma forma en el `ALERT_CREATED`, en
 * los eventos de seguimiento que la app encadena a esa alerta y en los de un
 * relevo de seguimiento.
 */
export function metaAlerta(a: Alert) {
  return { id: a.id, tipo: a.type, lat: a.lat, lon: a.lon, ts: a.created_at };
}

/**
 * Nombre visible de un dron para los textos y el `detalle` del registro; el
 * hash si el dron no existe (nunca pasa con uno que habló con el hub, pero un
 * registro no puede romperse por eso).
 */
export function nombreDeDron(droneId: string): string {
  return getDrone(droneId)?.displayName ?? droneId;
}

/** `{droneId, displayName}`: la forma con que los mensajes de relevos nombran a un dron. */
export function dronNombrado(droneId: string): { droneId: string; displayName: string } {
  return { droneId, displayName: nombreDeDron(droneId) };
}
