import type { EventRow } from '../types';

// Tipos de evento que ameritan resaltarse en el log del operador
const HIGHLIGHT: Record<string, string> = {
  ALERT_CREATED: 'bad',
  ALERT_VALIDATED: 'warn',
  SIGNAL_LOST: 'bad',
  RTH_LOW_BATTERY: 'warn',
  RTH_SIGNAL_LOSS: 'warn',
};

export default function EventLog({ events }: { events: EventRow[] }) {
  return (
    <div className="card log-card">
      <h2>Registro de eventos</h2>
      <div className="log">
        {events.length === 0 && <p className="muted">Sin eventos registrados.</p>}
        {events.map((e) => (
          <div key={e.id} className="log-row">
            <span className="muted mono">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={`event-type mono ${HIGHLIGHT[e.type] ?? ''}`}>{e.type}</span>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
