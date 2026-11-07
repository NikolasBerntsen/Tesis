import { useState } from 'react';
import { IconoCamara } from './Iconos';
import VisorAmpliado from './VisorAmpliado';

/**
 * El video en vivo del dron, en el visor negro de las cámaras del tablero: la
 * imagen a sangre, las escuadras en las esquinas y "● En vivo" arriba. Es la
 * misma pantalla que la captura de una alerta, que va al lado, y así las dos
 * se comparan de un vistazo.
 *
 * Con imagen, el visor entero es un botón que la abre en grande
 * (VisorAmpliado): en la vista del dron el video comparte el ancho con el mapa
 * y a veces hay que ver de cerca qué es lo que el detector marcó.
 */
export default function LiveVideo({
  frame,
  senalPerdida = false,
  nombre,
}: Readonly<{
  frame: string | null;
  /**
   * El dron avisó que perdió el enlace: lo que queda en pantalla es el último
   * cuadro, viejo, y decir "En vivo" encima sería mentir (como en CameraTile).
   */
  senalPerdida?: boolean;
  /** El nombre del dron, para el título de la imagen ampliada. */
  nombre?: string;
}>) {
  const [ampliado, setAmpliado] = useState(false);
  const enVivo = frame !== null && !senalPerdida;
  const cuadro = (
    <div className="visor-cuadro">
      {frame ? (
        <img className="video" src={`data:image/jpeg;base64,${frame}`} alt="Transmisión del dron" />
      ) : (
        <div className="video placeholder">Sin señal de video</div>
      )}
    </div>
  );
  const vivo = enVivo && (
    <span className="visor-vivo">
      <span className="punto-vivo" aria-hidden="true" />
      {'En vivo'}
    </span>
  );

  return (
    <div className="card video-en-vivo">
      <h2>
        <IconoCamara />
        Video en vivo
      </h2>
      {frame ? (
        <button type="button" className="visor" aria-label="Ampliar el video en vivo" onClick={() => setAmpliado(true)}>
          {cuadro}
          {vivo}
        </button>
      ) : (
        <div className="visor">{cuadro}</div>
      )}
      {ampliado && (
        <VisorAmpliado
          titulo="Video en vivo"
          subtitulo={nombre}
          src={frame ? `data:image/jpeg;base64,${frame}` : null}
          alt="Transmisión del dron ampliada"
          enVivo={enVivo}
          onCerrar={() => setAmpliado(false)}
        />
      )}
    </div>
  );
}
