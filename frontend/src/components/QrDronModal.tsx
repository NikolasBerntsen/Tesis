import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toDataURL } from 'qrcode';
import type { Drone } from '../types';

/**
 * El QR se dibuja acá, en el navegador: el hash es la credencial con la que la
 * app se empareja, así que no sale hacia ningún servicio de terceros.
 * Corrección M y 512 px para que el sticker impreso se lea con el celular.
 */
const OPCIONES_QR = { errorCorrectionLevel: 'M', margin: 2, width: 512 } as const;

const ICONO_CERRAR = {
  width: 15,
  height: 15,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  'aria-hidden': true,
} as const;

/**
 * Sticker imprimible de un dron: el QR lleva **únicamente** el hash (la app
 * escanea y lo manda tal cual a POST /api/drones/pair), y el nombre y el modelo
 * van impresos afuera para poder identificar el equipo sin escanear nada.
 */
export default function QrDronModal({ dron, onCerrar }: { dron: Drone; onCerrar: () => void }) {
  const [imagen, setImagen] = useState('');
  const [error, setError] = useState('');
  const caja = useRef<HTMLDivElement>(null);
  const idTitulo = useId();
  // El handler de Escape se registra una sola vez; el ref evita re-suscribirlo
  // cada vez que el padre vuelve a crear la función.
  const cerrar = useRef(onCerrar);
  cerrar.current = onCerrar;

  useEffect(() => {
    let vigente = true;
    toDataURL(dron.hash, OPCIONES_QR)
      .then((url) => vigente && setImagen(url))
      .catch(() => vigente && setError('No se pudo generar el código QR'));
    return () => {
      vigente = false;
    };
  }, [dron.hash]);

  useEffect(() => {
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const alTeclear = (e: KeyboardEvent) => e.key === 'Escape' && cerrar.current();
    document.addEventListener('keydown', alTeclear);
    caja.current?.focus();
    return () => {
      document.removeEventListener('keydown', alTeclear);
      // El foco vuelve a la fila desde la que se abrió el sticker.
      anterior?.focus();
    };
  }, []);

  return createPortal(
    <div className="modal-fondo" onClick={onCerrar}>
      {/* impresion.css aplana el modal pero no oculta la consola que quedó
          detrás: sin esto el sticker sale precedido por la tabla entera. */}
      <style media="print">{'.dashboard { display: none !important; }'}</style>
      <div
        className="modal-caja"
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        tabIndex={-1}
        ref={caja}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-cabecera">
          <div>
            <h2 className="modal-titulo" id={idTitulo}>
              Sticker del dron {dron.displayName}
            </h2>
            <p className="modal-subtitulo">El código lleva sólo el identificador</p>
          </div>
          <button className="modal-cerrar" aria-label="Cerrar el sticker" onClick={onCerrar}>
            <svg {...ICONO_CERRAR}>
              <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
            </svg>
          </button>
        </header>

        <div className="modal-cuerpo">
          {error && (
            <p className="aviso malo" role="alert">
              {error}
            </p>
          )}
          <div className="qr-sticker">
            <div className="qr-sticker-marco">
              {imagen ? (
                <img src={imagen} alt={`Código QR de ${dron.displayName}`} />
              ) : (
                !error && <span className="muted">Generando el código…</span>
              )}
            </div>
            <p className="qr-sticker-nombre">{dron.displayName}</p>
            {dron.model && <p className="qr-sticker-modelo">{dron.model}</p>}
            <p className="qr-sticker-hash mono">{dron.hash}</p>
          </div>
        </div>

        <footer className="modal-pie">
          <button className="ghost" onClick={onCerrar}>
            Cerrar
          </button>
          <button className="primario" onClick={() => window.print()} disabled={!imagen}>
            Imprimir sticker
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
