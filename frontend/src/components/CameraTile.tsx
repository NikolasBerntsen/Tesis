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
  return (
    <div className="camera-tile" onClick={onOpen} title="Ver detalle del dron">
      <div className="tile-video">
        {frame ? (
          <img className="video" src={`data:image/jpeg;base64,${frame}`} alt={`Video de ${drone.displayName}`} />
        ) : (
          <div className="video placeholder">Sin señal de video</div>
        )}
        {overlayAlterado(status) && (
          <div className="tile-overlay">
            <span>{overlayAlterado(status)}</span>
          </div>
        )}
        <span className={`tile-esquina ${textoEsquina(status).clase}`}>{textoEsquina(status).texto}</span>
      </div>
      {pendingAlerts > 0 && <span className="tile-alerts">{pendingAlerts} alerta(s)</span>}
      <div className="tile-info">
        <div className="tile-row">
          <EditableName name={drone.displayName} onRename={onRename} />
          <span className={status?.state === 'ORBITING' ? 'accent' : 'muted'}>
            {status ? stateLabel(status.state) : 'Sin estado'}
          </span>
        </div>
        <div className="tile-row muted">
          <span>
            Batería{' '}
            <strong className={status ? batteryClass(status.battery) : ''}>
              {status ? `${status.battery.toFixed(0)}%` : '—'}
            </strong>
          </span>
          <span>
            Señal{' '}
            <strong className={status ? signalClass(status.signalPct) : ''}>
              {status ? `${status.signalPct}%` : '—'}
            </strong>
          </span>
        </div>
      </div>
    </div>
  );
}
