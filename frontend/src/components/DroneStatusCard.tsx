import type { DroneStatus } from '../types';

const STATE_LABELS: Record<string, string> = {
  IDLE: 'En base',
  PATROLLING: 'Patrullando',
  ORBITING: 'Orbitando objetivo',
  RETURNING_HOME_SIGNAL: 'Volviendo a base (pérdida de señal)',
  RETURNING_HOME_BATTERY: 'Volviendo a base (batería baja)',
  LANDED: 'Aterrizado',
};

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
  const stateLabel = STATE_LABELS[status.state] ?? status.state;
  const batteryClass = status.battery <= 25 ? 'bad' : status.battery <= 40 ? 'warn' : 'ok';
  return (
    <div className="card">
      <h2>Estado del dron — {status.droneId}</h2>
      <div className="status-grid">
        <div>
          <span className="muted">Estado</span>
          <strong className={status.state === 'ORBITING' ? 'accent' : ''}>{stateLabel}</strong>
        </div>
        <div>
          <span className="muted">Batería</span>
          <strong className={batteryClass}>{status.battery.toFixed(0)}%</strong>
        </div>
        <div>
          <span className="muted">Señal RC</span>
          <strong className={status.signal === 'OK' ? 'ok' : 'bad'}>{status.signal === 'OK' ? 'OK' : 'PERDIDA'}</strong>
        </div>
        <div>
          <span className="muted">Posición</span>
          <strong>
            {status.lat.toFixed(5)}, {status.lon.toFixed(5)}
          </strong>
        </div>
        <div>
          <span className="muted">Ruta / waypoint</span>
          <strong>
            {status.routeId ?? '—'} / {status.waypointIndex ?? '—'}
          </strong>
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
