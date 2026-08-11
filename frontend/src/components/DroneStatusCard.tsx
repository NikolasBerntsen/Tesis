import { batteryClass, signalClass, stateLabel, waypointLabel } from '../format';
import type { DroneStatus } from '../types';

export default function DroneStatusCard({
  status,
  onResumePatrol,
}: {
  status: DroneStatus | null;
  onResumePatrol: () => void;
}) {
  if (!status) {
    return (
      <div className="card">
        <h2>Estado del dron</h2>
        <p className="muted">Sin datos — el dron todavía no reportó estado.</p>
      </div>
    );
  }
  return (
    <div className="card">
      <h2>Estado del dron</h2>
      <div className="status-grid">
        <div>
          <span className="muted">Estado</span>
          <strong className={status.state === 'ORBITING' ? 'accent' : ''}>{stateLabel(status.state)}</strong>
        </div>
        <div>
          <span className="muted">Batería</span>
          <strong className={batteryClass(status.battery)}>{status.battery.toFixed(0)}%</strong>
        </div>
        <div>
          <span className="muted">Señal RC</span>
          <strong className={status.signal === 'OK' ? signalClass(status.signalPct) : 'bad'}>
            {status.signal === 'OK' ? `${status.signalPct}%` : 'PERDIDA'}
          </strong>
        </div>
        <div>
          <span className="muted">Nodo del patrullaje</span>
          <strong>{waypointLabel(status)}</strong>
        </div>
        <div>
          <span className="muted">Posición</span>
          <strong>
            {status.lat.toFixed(5)}, {status.lon.toFixed(5)}
          </strong>
        </div>
        <div>
          <span className="muted">Modo</span>
          <strong>{status.mode}</strong>
        </div>
      </div>
      {status.state === 'ORBITING' && (
        <button className="resume" onClick={onResumePatrol}>
          Reanudar patrullaje
        </button>
      )}
    </div>
  );
}
