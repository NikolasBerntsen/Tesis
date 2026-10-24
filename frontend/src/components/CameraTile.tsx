import { batteryClass, signalClass, sobreObjetivo, stateLabel } from '../format';
import type { Drone, DroneStatus } from '../types';
import EditableName from './EditableName';

const EN_TIERRA = ['IDLE', 'LANDED'];

/**
 * Aviso a pantalla completa sobre la cámara cuando el dron está en un estado
 * alterado; el que corresponda primero gana.
 */
function overlayAlterado(status: DroneStatus | null): string | null {
  if (!status) return null;
  if (status.signal === 'LOST') return 'SEÑAL PERDIDA';
  if (status.battery <= 25 || status.state === 'RETURNING_HOME_BATTERY') return 'BATERÍA BAJA';
  return null;
}

/**
 * Texto chico de la esquina: en qué modo está el dron. Orbitar y seguir van en
 * oro, como el estado de la ficha: antes caían en "PATRULLANDO" y el mosaico de
 * un dron encima de un objetivo se veía igual que el de uno haciendo la ronda.
 * Cada uno con su rótulo, eso sí: "SIGUIENDO" avisa que el objetivo se mueve.
 */
function textoEsquina(status: DroneStatus | null): { texto: string; clase: string } {
  if (status?.state === 'MANUAL') return { texto: 'CONTROL MANUAL', clase: 'esquina-verde' };
  if (status?.state === 'ORBITING') return { texto: 'ORBITANDO', clase: 'esquina-oro' };
  if (status?.state === 'FOLLOWING') return { texto: 'SIGUIENDO', clase: 'esquina-oro' };
  // `flying` manda sobre el estado: un IDLE en el aire no existe, pero un
  // PAUSED apoyado sí (la patrulla se cortó con el dron en el suelo).
  if (!status || EN_TIERRA.includes(status.state) || status.flying === false) {
    return { texto: 'EN TIERRA', clase: 'esquina-gris' };
  }
  return { texto: 'PATRULLANDO', clase: 'esquina-gris' };
}

/**
 * La batería también como barra: el nivel se capta de un vistazo, sin leer la
 * cifra, en una grilla de varias cámaras. Es el medidor de la ficha del dron
 * (vistas.css), más grueso y teñido por nivel. Queda fuera del árbol de
 * accesibilidad: la cifra de al lado ya dice exactamente lo mismo.
 */
function BarraDeBateria({ nivel, clase }: Readonly<{ nivel: number; clase: string }>) {
  const ancho = Math.min(100, Math.max(0, nivel));
  return (
    <span className="medidor barra" aria-hidden="true">
      <span className={`medidor-relleno ${clase}`} style={{ width: `${ancho}%` }} />
    </span>
  );
}

export default function CameraTile({
  drone,
  status,
  frame,
  pendingAlerts,
  onOpen,
  onRename,
}: Readonly<{
  drone: Drone;
  status: DroneStatus | null;
  frame: string | null;
  pendingAlerts: number;
  onOpen: () => void;
  onRename: (displayName: string) => void;
}>) {
  const aviso = overlayAlterado(status);
  const esquina = textoEsquina(status);
  const claseBateria = status ? batteryClass(status.battery) : '';
  const claseSenal = status ? signalClass(status.signalPct) : '';
  // "En vivo" sólo si hay imagen y el dron no avisó que perdió la señal: con
  // la señal perdida lo que queda en pantalla es el último cuadro, viejo.
  const enVivo = frame !== null && status?.signal !== 'LOST';

  return (
    // El mosaico abre el detalle del dron, y hasta hace poco lo hacía con un
    // onClick colgado del div: con teclado no había forma de abrirlo.
    //
    // El arreglo no puede ser envolver todo en un <button>, porque adentro está
    // el <input> de renombrar y un botón no puede contener controles. Se usa el
    // patrón de "botón estirado": un <button> de verdad, vacío, que cubre el
    // mosaico entero por CSS (.tile-abrir). Nativo, así que Enter, Espacio,
    // foco, lector de pantalla y táctil vienen de arriba; y va ÚLTIMO en el
    // marcado para quedar por encima de lo que no es interactivo, mientras que
    // .editable-name se levanta con z-index para seguir clickeable.
    <div className="camera-tile">
      {/* El visor negro con las escuadras de una cámara, a sangre arriba de
          la ficha: el mismo de la captura de una alerta. */}
      <div className="visor tile-video">
        <div className="visor-cuadro">
          {frame ? (
            <img className="video" src={`data:image/jpeg;base64,${frame}`} alt={`Video de ${drone.displayName}`} />
          ) : (
            <div className="video placeholder">Sin señal de video</div>
          )}
        </div>
        {enVivo && (
          <span className="visor-vivo">
            <span className="punto-vivo" aria-hidden="true" />
            {'En vivo'}
          </span>
        )}
        {aviso && (
          <div className="tile-overlay">
            {/* El <strong> engrosa el rojo del aviso sin tocar el color ni la
                serif que le da el tema: una falla no puede leerse tenue. */}
            <span>
              <strong>{aviso}</strong>
            </span>
          </div>
        )}
        <span className={`tile-esquina ${esquina.clase}`}>{esquina.texto}</span>
      </div>
      <div className="tile-info">
        <div className="tile-row">
          <EditableName name={drone.displayName} onRename={onRename} />
          <span className={`estado pastilla ${sobreObjetivo(status?.state) ? 'accent' : 'muted'}`}>
            {status ? stateLabel(status.state) : 'Sin estado'}
          </span>
        </div>
        <dl className="tile-datos">
          <div>
            <dt className="rotulo">Batería</dt>
            <dd>
              <strong className={`cifra-chica ${claseBateria}`}>{status ? `${status.battery.toFixed(0)}%` : '—'}</strong>
              {status && <BarraDeBateria nivel={status.battery} clase={claseBateria} />}
            </dd>
          </div>
          <div>
            <dt className="rotulo">Señal</dt>
            <dd>
              <strong className={`cifra-chica ${claseSenal}`}>{status ? `${status.signalPct}%` : '—'}</strong>
            </dd>
          </div>
          {/* El contador va en la ficha y no flotando sobre el video: ahí
              pisaba el rótulo de la esquina. Rótulo de una palabra y la cuenta
              como cifra, igual que batería y señal: «Alertas pendientes» se
              partía en dos renglones y bajaba su número uno más que los otros. */}
          {pendingAlerts > 0 && (
            <div>
              <dt className="rotulo">Alertas</dt>
              <dd>
                <strong className="cifra-chica bad">{pendingAlerts}</strong>
              </dd>
            </div>
          )}
        </dl>
      </div>
      {/* Último hijo a propósito: así cubre lo de arriba sin necesitar z-index. */}
      <button
        type="button"
        className="tile-abrir"
        title="Ver detalle del dron"
        onClick={onOpen}
        aria-label={`Ver detalle de ${drone.displayName}`}
      />
    </div>
  );
}
