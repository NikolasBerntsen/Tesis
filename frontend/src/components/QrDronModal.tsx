import { useEffect, useId, useState } from 'react';
import { toDataURL } from 'qrcode';
import type { Drone } from '../types';
import IconoCerrar from './IconoCerrar';
import Modal from './Modal';

/**
 * El QR se dibuja acá, en el navegador: el hash es la credencial con la que la
 * app se empareja, así que no sale hacia ningún servicio de terceros.
 * Corrección M y 512 px para que el sticker impreso se lea con el celular.
 */
const OPCIONES_QR = { errorCorrectionLevel: 'M', margin: 2, width: 512 } as const;

/**
 * Sticker imprimible de un dron: el QR lleva **únicamente** el hash (la app
 * escanea y lo manda tal cual a POST /api/drones/pair), y el nombre y el modelo
 * van impresos afuera para poder identificar el equipo sin escanear nada.
 */
export default function QrDronModal({ dron, onCerrar }: { dron: Drone; onCerrar: () => void }) {
  const [imagen, setImagen] = useState('');
  const [error, setError] = useState('');
  const idTitulo = useId();

  useEffect(() => {
    let vigente = true;
    toDataURL(dron.hash, OPCIONES_QR)
      .then((url) => vigente && setImagen(url))
      .catch(() => vigente && setError('No se pudo generar el código QR'));
    return () => {
      vigente = false;
    };
  }, [dron.hash]);

  return (
    <Modal etiquetadoPor={idTitulo} onCerrar={onCerrar}>
      {/* impresion.css aplana el modal pero no oculta la consola que quedó
          detrás: sin esto el sticker sale precedido por la tabla entera. */}
      <style media="print">{'.dashboard { display: none !important; }'}</style>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            Sticker del dron {dron.displayName}
          </h2>
          <p className="modal-subtitulo">El código lleva sólo el identificador</p>
        </div>
        <button className="modal-cerrar" aria-label="Cerrar el sticker" onClick={onCerrar}>
          <IconoCerrar />
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
          {/* El número de inventario va impreso al lado del código, no adentro:
              en el QR viaja solo el hash, para que la foto de un sticker no
              revele nada del sistema. */}
          {dron.inventoryCode && <p className="qr-sticker-inventario">Inventario {dron.inventoryCode}</p>}
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
    </Modal>
  );
}
