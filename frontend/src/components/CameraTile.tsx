import { batteryClass, signalClass, stateLabel } from '../format';
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

/** Texto chico de la esquina: en qué modo está el dron. */
function textoEsquina(status: DroneStatus | null): { texto: string; clase: string } {
  if (status?.state === 'MANUAL') return { texto: 'CONTROL MANUAL', clase: 'esquina-verde' };
  if (!status || EN_TIERRA.includes(status.state)) return { texto: 'EN TIERRA', clase: 'esquina-gris' };
  return { texto: 'PATRULLANDO', clase: 'esquina-gris' };
}

export default function CameraTile({
  drone,
  status,
  frame,
  pendingAlerts,
  onOpen,
  onRename,
}: {
  drone: Drone;
  status: DroneStatus | null;
  frame: string | null;
  pendingAlerts: number;
  onOpen: () => void;
  onRename: (displayName: string) => void;
}) {
  const aviso = overlayAlterado(status);
  const esquina = textoEsquina(status);
  const claseBateria = status ? batteryClass(status.battery) : '';
  const claseSenal = status ? signalClass(status.signalPct) : '';

  return (
    <div className="camera-tile" onClick={onOpen} title="Ver detalle del dron">
      {/* Marco de mármol con filo dorado: la cámara es la abertura en la piedra */}
      <div className="hueco filo-oro">
        <div className="tile-video">
          {frame ? (
            <img className="video" src={`data:image/jpeg;base64,${frame}`} alt={`Video de ${drone.displayName}`} />
          ) : (
            <div className="video placeholder">Sin señal de video</div>
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
      </div>
      <div className="tile-info">
        <div className="tile-row">
          <EditableName name={drone.displayName} onRename={onRename} />
          <span className={`estado ${status?.state === 'ORBITING' ? 'accent' : 'muted'}`}>
            {status ? stateLabel(status.state) : 'Sin estado'}
          </span>
        </div>
        <div className="tile-row muted">
          <span>
            <span className="etiqueta">Batería</span>{' '}
            <strong className={`cifra-chica ${claseBateria}`}>
              {status ? `${status.battery.toFixed(0)}%` : '—'}
            </strong>
          </span>
          <span>
            <span className="etiqueta">Señal</span>{' '}
            <strong className={`cifra-chica ${claseSenal}`}>
              {status ? `${status.signalPct}%` : '—'}
            </strong>
          </span>
        </div>
        {/* El contador va en la ficha y no flotando sobre el video: ahí pisaba
            el rótulo de la esquina. */}
        {pendingAlerts > 0 && (
          <div className="tile-row">
            <span className="etiqueta">Alertas pendientes</span>
            <span className="badge-count">{pendingAlerts}</span>
          </div>
        )}
      </div>
    </div>
  );
}
