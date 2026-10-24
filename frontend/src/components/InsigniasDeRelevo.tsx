import { Fragment } from 'react';
import { insigniasDelDron, type TonoDeInsignia } from '../relevos';
import type { DroneStatus, Relevo } from '../types';

/**
 * Las pastillas de estado de la consola (`.estado.pastilla`, primitivos.css):
 * el punto y las versalitas dentro de un filo redondo, como el «● Patrullando»
 * de la cámara o el «● En vuelo» de la cabecera del dron. El oro del relevo es
 * el de lo que está sobre un objetivo (`.accent`), y lo que falló, el óxido.
 */
const CLASE: Record<TonoDeInsignia, string> = {
  ok: 'estado pastilla ok',
  info: 'estado pastilla info',
  oro: 'estado pastilla accent',
  malo: 'estado pastilla bad',
  neutro: 'estado pastilla muted',
};

/**
 * Qué papel tiene un dron en los relevos, en pastillas: «En espera para
 * relevos» (o «En espera: no puede salir»), «Relevo en camino: Bravo» en el
 * que lo pidió y «Relevando a Alfa» en el que va. Van en la cámara del tablero
 * y en la cabecera de la vista del dron, al lado de su estado. Sin nada que
 * decir, no ocupa lugar.
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
            {/* El `title` sólo lo ve el mouse, y en la cámara ni eso (lo tapa
                el botón que abre el dron): el detalle va también como texto,
                fuera de la vista, para el lector de pantalla. */}
            {i.titulo !== undefined && <span className="insignia-solo-lector">{`. ${i.titulo}`}</span>}
          </span>{' '}
        </Fragment>
      ))}
    </span>
  );
}
