import { useId, useState, type ReactNode } from 'react';
import { IconoCerrar } from './Iconos';
import Modal from './Modal';

export type TonoDeConfirmacion = 'peligro' | 'primario';

/** Lo que una vista tiene que decir para pedir una confirmación. */
export interface PedidoDeConfirmacion {
  titulo: string;
  /** Una línea chica arriba, en versalitas: "La baja se puede deshacer". */
  subtitulo?: string;
  /** La consecuencia, en una oración: qué pasa si se confirma. */
  consecuencia: ReactNode;
  /** Lo que conviene saber además (cómo deshacerlo, qué no se libera). */
  detalle?: ReactNode;
  /** El rótulo del botón que confirma: el verbo, no "Aceptar". */
  confirmar: string;
  /** El rótulo mientras el pedido viaja, si el confirmar espera al backend. */
  enCurso?: string;
  /** El rótulo de la salida, si "Cancelar" no dice lo que pasa al tocarla. */
  cancelar?: string;
  /** `peligro` (por defecto) para lo que borra o corta; `primario` para lo que no. */
  tono?: TonoDeConfirmacion;
  /**
   * Lo que hace confirmar. Si devuelve una promesa, el diálogo la espera con
   * el botón en "en curso" y se cierra solo cuando sale bien; si falla, el
   * motivo se lee adentro y el diálogo queda abierto para reintentar o
   * cancelar. Si no devuelve nada, se cierra en el acto.
   */
  accion: () => void | Promise<unknown>;
}

function esPromesa(valor: unknown): valor is Promise<unknown> {
  return typeof (valor as Promise<unknown> | undefined)?.then === 'function';
}

function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * La única confirmación de la consola. Antes había un `confirm()` del navegador
 * para borrar un dron, un pop-up propio para borrar un usuario y NADA para
 * borrar una base o una ruta: un clic de más en "Eliminar" se llevaba la base y
 * dejaba a sus drones sin punto de retorno. Ahora todo lo que borra, apaga o le
 * saca algo a alguien pasa por acá, y se lee igual en todas las vistas: el
 * título dice qué, la primera oración dice la consecuencia, y abajo van
 * "Cancelar" y el verbo de la acción, en la placa óxido de Descartar.
 *
 * El foco arranca en "Cancelar" (la recomendación de WAI-ARIA para lo
 * destructivo): Enter o Espacio sin mirar no rompen nada.
 */
export default function DialogoConfirmacion({
  pedido,
  onCerrar,
}: {
  pedido: PedidoDeConfirmacion;
  onCerrar: () => void;
}) {
  const { titulo, subtitulo, consecuencia, detalle, confirmar, enCurso, cancelar, tono = 'peligro', accion } = pedido;
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const idTitulo = useId();
  const idTexto = useId();

  /**
   * Con el pedido en viaje, salir ya no es "no hacerlo": el backend lo va a
   * procesar igual. Por eso Cancelar y la cruz se apagan, y Escape y el velo
   * no cierran, hasta que conteste (la misma regla que los formularios).
   */
  function cerrar() {
    if (!ocupado) onCerrar();
  }

  function confirmarAccion() {
    setError('');
    const resultado = accion();
    if (!esPromesa(resultado)) {
      onCerrar();
      return;
    }
    setOcupado(true);
    resultado.then(onCerrar, (e: unknown) => {
      setError(textoError(e));
      setOcupado(false);
    });
  }

  return (
    <Modal etiquetadoPor={idTitulo} descritoPor={idTexto} onCerrar={cerrar}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            {titulo}
          </h2>
          {subtitulo && <p className="modal-subtitulo">{subtitulo}</p>}
        </div>
        <button
          type="button"
          className="modal-cerrar"
          aria-label="Cerrar la confirmación"
          onClick={cerrar}
          disabled={ocupado}
        >
          <IconoCerrar tamano={18} />
        </button>
      </header>

      <div className="modal-cuerpo confirmacion-cuerpo">
        {error && (
          <p className="aviso malo" role="alert">
            {error}
          </p>
        )}
        <p id={idTexto}>{consecuencia}</p>
        {detalle && <p className="muted">{detalle}</p>}
      </div>

      <footer className="modal-pie">
        <button type="button" onClick={cerrar} disabled={ocupado} data-autofoco>
          {cancelar ?? 'Cancelar'}
        </button>
        <button
          type="button"
          className={tono === 'peligro' ? 'dismiss' : 'primario'}
          onClick={confirmarAccion}
          disabled={ocupado}
          aria-busy={ocupado || undefined}
        >
          {ocupado && enCurso ? enCurso : confirmar}
        </button>
      </footer>
    </Modal>
  );
}
