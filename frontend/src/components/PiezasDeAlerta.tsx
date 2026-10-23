import { time, tipoDeAlerta } from '../format';
import type { Alert } from '../types';
import type { Decision } from '../useDecisionDeAlerta';
import { IconoCamara, IconoCheck, IconoInfo, IconoPersona, IconoTacho, IconoVehiculo } from './Iconos';

/**
 * Las piezas con que se dice una alerta, en todos lados igual: la tarjeta del
 * tablero y de la vista del dron (AlertaEnCurso), su pop-up y el detalle de un
 * evento que la nombra (DetalleDeAlerta), y la campana. Vivían copiadas en
 * cada uno, y el mismo tilde de "Validar" llegó a tener tres tamaños; juntas,
 * una alerta se reconoce de un vistazo venga de donde venga.
 */

const ICONO_DE_TIPO: Partial<Record<string, typeof IconoPersona>> = { PERSON: IconoPersona, VEHICLE: IconoVehiculo };

/**
 * La captura en un visor negro con las escuadras de una cámara, y al pie qué
 * es y a qué hora se tomó. Dice "Captura" y no "En vivo": es la foto que
 * disparó la detección, y lo que está en vivo es justamente el video con el
 * que hay que compararla. Con `onAmpliar`, el visor entero es el botón que la
 * abre en grande (el pop-up de la alerta, con el mapa y el dron al lado).
 */
export function VisorDeCaptura({
  alerta,
  alt = 'Captura que disparó la detección',
  onAmpliar,
}: Readonly<{
  alerta: Alert;
  /** El texto de la imagen: en el pop-up es "Captura de la detección". */
  alt?: string;
  onAmpliar?: () => void;
}>) {
  const pie = (
    <span className="visor-pie">
      <span className="visor-rotulo">
        <IconoCamara tamano={16} />
        {alerta.snapshot ? 'Captura' : 'Detección'}
      </span>
      <time dateTime={alerta.created_at}>{time(alerta.created_at)}</time>
    </span>
  );

  if (!alerta.snapshot) {
    // Sin escuadras: no hay imagen que encuadrar, y el aviso va en el mismo
    // alto que tendría la captura para que la tarjeta no salte al recorrerla.
    return (
      <div className="visor">
        <div className="visor-sin-imagen">
          <p className="vacio">La detección no dejó captura.</p>
        </div>
        {pie}
      </div>
    );
  }

  const cuadro = (
    <span className="visor-cuadro">
      <img className="snapshot" src={`data:image/jpeg;base64,${alerta.snapshot}`} alt={alt} />
    </span>
  );
  if (!onAmpliar) {
    return (
      <div className="visor">
        {cuadro}
        {pie}
      </div>
    );
  }
  // La captura es lo que se mira primero: tocarla la abre en grande. "Ver
  // detalle" es el mismo camino para la alerta que llegó sin captura.
  return (
    <button
      type="button"
      className="visor"
      aria-label={`Ampliar la captura de la alerta #${alerta.id}`}
      onClick={onAmpliar}
    >
      {cuadro}
      {pie}
    </button>
  );
}

/**
 * Qué vio la detección, con su ícono, en la placa óxido de la alerta. Un tipo
 * que la consola no conoce va crudo y sin dibujo, pero se lee.
 */
export function ChipDeTipo({
  tipo,
  tamanoIcono = 20,
}: Readonly<{
  tipo: string;
  /** En la campana va un escalón más chico, como sus botones. */
  tamanoIcono?: number;
}>) {
  const Icono = ICONO_DE_TIPO[tipo];
  return (
    <span className="chip rojo">
      {Icono && <Icono tamano={tamanoIcono} />}
      {tipoDeAlerta(tipo)}
    </span>
  );
}

/**
 * Validar y Descartar, el par de la decisión, con el tilde y el tacho. Pesan
 * lo mismo a propósito: ninguno de los dos es "la" respuesta. Mientras la
 * decisión viaja se apagan los dos, para que un segundo clic no decida dos
 * veces (o la alerta que vino a ocupar el lugar de la decidida).
 */
export function BotonesDeDecision({
  ocupado,
  tamanoIcono,
  onDecidir,
}: Readonly<{
  ocupado: boolean;
  /** Los íconos de la campana van un escalón más chicos, como sus botones. */
  tamanoIcono?: number;
  onDecidir: (decision: Decision) => void;
}>) {
  return (
    <div className="alert-actions">
      <button type="button" className="validate" disabled={ocupado} onClick={() => onDecidir('VALIDATED')}>
        <IconoCheck tamano={tamanoIcono} />
        Validar
      </button>
      <button type="button" className="dismiss" disabled={ocupado} onClick={() => onDecidir('DISMISSED')}>
        <IconoTacho tamano={tamanoIcono} />
        Descartar
      </button>
    </div>
  );
}

/**
 * Lo que hace cada botón con el dron, dicho antes de apretarlo: validar no lo
 * "libera", y descartar lo saca de encima del objetivo.
 */
export function ConsecuenciasDeDecidir() {
  return (
    <div className="alerta-consecuencias">
      <IconoInfo tamano={18} />
      <p>
        Validar: el dron se queda sobre el objetivo hasta que lo mandes a patrullar.
        <br />
        Descartar: retoma la ruta hacia el próximo nodo.
      </p>
    </div>
  );
}
