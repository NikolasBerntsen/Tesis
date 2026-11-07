import { useId } from 'react';
import { IconoCerrar } from './Iconos';
import Modal from './Modal';

/**
 * Una imagen en grande, en el visor negro con sus escuadras: el video en vivo
 * de un dron o la captura de una alerta, al hacerle clic. Es el pop-up más
 * simple de la consola —la imagen y nada más—, para mirar de cerca lo que en la
 * vista queda chico. Si la imagen cambia mientras está abierto (el video en
 * vivo), se ve cambiar: lo que se amplía es lo que el dron ve ahora.
 */
export default function VisorAmpliado({
  titulo,
  subtitulo,
  src,
  alt,
  enVivo = false,
  onCerrar,
}: Readonly<{
  titulo: string;
  subtitulo?: string;
  /** La imagen (un `data:` o una URL), o `null` si justo no hay ninguna. */
  src: string | null;
  alt: string;
  /** Si lo que se mira es el video de ahora: lleva el "En vivo" del visor. */
  enVivo?: boolean;
  onCerrar: () => void;
}>) {
  const idTitulo = useId();
  return (
    <Modal etiquetadoPor={idTitulo} ancho onCerrar={onCerrar}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            {titulo}
          </h2>
          {subtitulo && <p className="modal-subtitulo">{subtitulo}</p>}
        </div>
        <button type="button" className="modal-cerrar" aria-label="Cerrar la imagen ampliada" onClick={onCerrar}>
          <IconoCerrar tamano={18} />
        </button>
      </header>
      <div className="modal-cuerpo visor-ampliado" data-testid="visor-ampliado">
        <div className="visor">
          <div className="visor-cuadro">
            {src ? (
              <img className="video ampliada" src={src} alt={alt} />
            ) : (
              <div className="video placeholder">Sin señal de video</div>
            )}
          </div>
          {enVivo && src && (
            <span className="visor-vivo">
              <span className="punto-vivo" aria-hidden="true" />
              {'En vivo'}
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}
