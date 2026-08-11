import { batteryClass, signalClass, stateLabel } from '../format';
import type { Drone, DroneStatus } from '../types';
import EditableName from './EditableName';

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
      {frame ? (
        <img className="video" src={`data:image/jpeg;base64,${frame}`} alt={`Video de ${drone.displayName}`} />
      ) : (
        <div className="video placeholder">Sin señal de video</div>
      )}
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
