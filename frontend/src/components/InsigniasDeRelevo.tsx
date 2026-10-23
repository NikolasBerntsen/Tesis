import { Fragment } from 'react';
import { insigniasDelDron, type TonoDeInsignia } from '../relevos';
import type { DroneStatus, Relevo } from '../types';

/** Las pastillas de siempre (primitivos.css), más `.malo` para lo que falló. */
const CLASE: Record<TonoDeInsignia, string> = {
  ok: 'badge ok',
  info: 'badge info',
  oro: 'badge oro',
  malo: 'badge malo',
  neutro: 'badge',
};

/**
 * Qué papel tiene un dron en los relevos, en pastillas: «En espera para
 * relevos», «Relevo en camino: Bravo» en el que lo pidió y «Relevando a Alfa»
 * en el que va. Van en la tarjeta del tablero y en la cabecera de la vista del
 * dron. Sin nada que decir, no ocupa lugar.
 */
export default function InsigniasDeRelevo({
  droneId,
  status,
  relevos,
}: Readonly<{ droneId: string; status: DroneStatus | null; relevos: readonly Relevo[] }>) {
  const insignias = insigniasDelDron(droneId, status, relevos);
  if (insignias.length === 0) return null;
  return (
    <span className="insignias-relevo" data-testid="insignias-relevo">
      {/* El espacio entre pastillas no se ve (la fila es flex), pero un lector
          de pantalla sin él leería dos insignias como una sola palabra. */}
      {insignias.map((i) => (
        <Fragment key={i.clave}>
          <span className={CLASE[i.tono]} title={i.titulo}>
            {i.texto}
          </span>{' '}
        </Fragment>
      ))}
    </span>
  );
}
