import { useId } from 'react';
import { time } from '../format';
import { useRelevosYEmergencias } from '../relevosYEmergencias';
import DetalleDeEmergencia from './DetalleDeEmergencia';
import { IconoCerrar } from './Iconos';
import Modal from './Modal';

/**
 * El pop-up de un aterrizaje de emergencia, con la misma caja ancha que el de
 * una alerta: las fotos y el mapa van lado a lado, y es la vista con la que se
 * decide adónde mandar a alguien a buscar el dron.
 */
export default function ModalDeEmergencia({
  emergenciaId,
  onCerrar,
  onDevolverFoco,
}: Readonly<{
  emergenciaId: number;
  onCerrar: () => void;
  /** Adónde va el foco al cerrar si lo que abrió el pop-up ya no está. */
  onDevolverFoco?: () => void;
}>) {
  const idTitulo = useId();
  const { emergencias } = useRelevosYEmergencias();
  // La cabecera sigue a la consola: si el dron toca tierra con el pop-up
  // abierto, se ve en el acto.
  const actual = emergencias.find((e) => e.id === emergenciaId);

  return (
    <Modal etiquetadoPor={idTitulo} ancho onCerrar={onCerrar} onDevolverFoco={onDevolverFoco}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            {`Aterrizaje de emergencia #${emergenciaId}`}
          </h2>
          {actual && <p className="modal-subtitulo">{`${actual.displayName} · ${time(actual.creadaEn)}`}</p>}
        </div>
        <button type="button" className="modal-cerrar" aria-label="Cerrar la ficha" onClick={onCerrar}>
          <IconoCerrar tamano={18} />
        </button>
      </header>

      <div className="modal-cuerpo">
        <DetalleDeEmergencia emergenciaId={emergenciaId} conTitulo={false} />
      </div>

      <footer className="modal-pie">
        <button type="button" onClick={onCerrar}>
          Cerrar
        </button>
      </footer>
    </Modal>
  );
}
