import { useId } from 'react';
import { useAlertasEnVivo } from '../alertasEnVivo';
import { time, tipoDeObjetivo } from '../format';
import type { Alert } from '../types';
import DetalleDeAlerta from './DetalleDeAlerta';
import { IconoCerrar } from './Iconos';
import Modal from './Modal';

/**
 * El pop-up de una alerta, el que se abre al tocarla en el carrusel o en la
 * campana. La caja es la ancha: la captura y el mapa van lado a lado, y es la
 * vista en la que se decide adónde mandar a alguien.
 */
export default function ModalDeAlerta({
  alerta,
  onCerrar,
  onDevolverFoco,
}: Readonly<{
  alerta: Alert;
  onCerrar: () => void;
  /** Adónde va el foco al cerrar si lo que abrió el pop-up ya no está. */
  onDevolverFoco?: () => void;
}>) {
  const idTitulo = useId();
  const vivo = useAlertasEnVivo();
  // La cabecera también sigue a la consola: es la misma alerta, más fresca.
  const actual = vivo.alertas.find((a) => a.id === alerta.id) ?? alerta;
  const dron = vivo.drones.find((d) => d.droneId === actual.drone_id);

  return (
    <Modal etiquetadoPor={idTitulo} ancho onCerrar={onCerrar} onDevolverFoco={onDevolverFoco}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            {`Alerta de ${tipoDeObjetivo(actual.type).toLowerCase()} #${actual.id}`}
          </h2>
          <p className="modal-subtitulo">
            {`${dron?.displayName ?? 'Dron desconocido'} · ${time(actual.created_at)}`}
          </p>
        </div>
        <button type="button" className="modal-cerrar" aria-label="Cerrar la alerta" onClick={onCerrar}>
          <IconoCerrar tamano={18} />
        </button>
      </header>

      <div className="modal-cuerpo">
        <DetalleDeAlerta alertaId={alerta.id} conocida={alerta} conTitulo={false} onIrAlVideo={onCerrar} />
      </div>

      <footer className="modal-pie">
        <button type="button" onClick={onCerrar}>
          Cerrar
        </button>
      </footer>
    </Modal>
  );
}
