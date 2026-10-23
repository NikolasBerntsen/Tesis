import { useId } from 'react';
import type { EventRow } from '../types';
import DetalleDeEvento from './DetalleDeEvento';
import { IconoCerrar } from './Iconos';
import Modal from './Modal';

const CATEGORIA: Record<EventRow['category'], string> = {
  drone: 'Drones',
  usuarios: 'Usuarios',
  sistema: 'Sistema',
};

/**
 * Detalle de una fila del registro. El cuerpo es DetalleDeEvento, el mismo que
 * muestra el panel lateral del historial de un dron; acá se le pone la caja del
 * pop-up, con el mensaje de título y la categoría.
 */
export default function LogDetailModal({ fila, onCerrar }: { fila: EventRow; onCerrar: () => void }) {
  const idTitulo = useId();

  return (
    <Modal etiquetadoPor={idTitulo} onCerrar={onCerrar}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            {fila.message}
          </h2>
          <p className="modal-subtitulo">
            <span className={`cat-badge cat-${fila.category}`}>{CATEGORIA[fila.category]}</span>{' '}
            <span className="mono">{fila.type}</span>
          </p>
        </div>
        <button type="button" className="modal-cerrar" aria-label="Cerrar el detalle" onClick={onCerrar}>
          <IconoCerrar tamano={18} />
        </button>
      </header>

      <div className="modal-cuerpo">
        {/* Ir al video de una alerta cambia de sección: el Registro se va y el
            pop-up con él, pero se cierra igual por si la vista quedara. */}
        <DetalleDeEvento fila={fila} onIrAlVideo={onCerrar} />
      </div>

      <footer className="modal-pie">
        <button type="button" onClick={onCerrar}>
          Cerrar
        </button>
      </footer>
    </Modal>
  );
}
