import { IconoCamara } from './Iconos';

/**
 * El video en vivo del dron, en el visor negro de las cámaras del tablero: la
 * imagen a sangre, las escuadras en las esquinas y "● En vivo" arriba. Es la
 * misma pantalla que la captura de una alerta, que va al lado, y así las dos
 * se comparan de un vistazo.
 */
export default function LiveVideo({
  frame,
  senalPerdida = false,
}: Readonly<{
  frame: string | null;
  /**
   * El dron avisó que perdió el enlace: lo que queda en pantalla es el último
   * cuadro, viejo, y decir "En vivo" encima sería mentir (como en CameraTile).
   */
  senalPerdida?: boolean;
}>) {
  return (
    <div className="card video-en-vivo">
      <h2>
        <IconoCamara />
        Video en vivo
      </h2>
      <div className="visor">
        <div className="visor-cuadro">
          {frame ? (
            <img className="video" src={`data:image/jpeg;base64,${frame}`} alt="Transmisión del dron" />
          ) : (
            <div className="video placeholder">Sin señal de video</div>
          )}
        </div>
        {frame && !senalPerdida && (
          <span className="visor-vivo">
            <span className="punto-vivo" aria-hidden="true" />
            {'En vivo'}
          </span>
        )}
      </div>
    </div>
  );
}
