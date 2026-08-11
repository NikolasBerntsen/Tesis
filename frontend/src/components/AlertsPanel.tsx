import { time } from '../format';
import type { Alert } from '../types';

const TYPE_LABELS = { PERSON: 'PERSONA', VEHICLE: 'VEHÍCULO' } as const;

export default function AlertsPanel({
  alerts,
  onDecide,
}: {
  alerts: Alert[];
  onDecide: (id: number, decision: 'VALIDATED' | 'DISMISSED') => void;
}) {
  const pending = alerts.filter((a) => a.status === 'PENDING');
  const decided = alerts.filter((a) => a.status !== 'PENDING').slice(0, 10);

  return (
    <div className="card">
      <h2>
        Alertas {pending.length > 0 && <span className="badge-count">{pending.length}</span>}
      </h2>
      {pending.length === 0 && <p className="muted">Sin alertas pendientes.</p>}
      {pending.map((a) => (
        <div key={a.id} className="alert pending">
          <div className="alert-head">
            <span className={`badge ${a.type.toLowerCase()}`}>{TYPE_LABELS[a.type]}</span>
            <span className="muted">
              #{a.id} · {time(a.created_at)} · {a.drone_id}
            </span>
          </div>
          {a.snapshot && <img className="snapshot" src={`data:image/jpeg;base64,${a.snapshot}`} alt="Detección" />}
          <div className="alert-actions">
            <button className="validate" onClick={() => onDecide(a.id, 'VALIDATED')}>
              Validar alerta
            </button>
            <button className="dismiss" onClick={() => onDecide(a.id, 'DISMISSED')}>
              Falso positivo
            </button>
          </div>
        </div>
      ))}
      {decided.length > 0 && (
        <>
          <h3>Historial reciente</h3>
          {decided.map((a) => (
            <div key={a.id} className="alert decided">
              <span className={`badge ${a.type.toLowerCase()}`}>{TYPE_LABELS[a.type]}</span>
              <span>#{a.id}</span>
              <span className={a.status === 'VALIDATED' ? 'ok' : 'muted'}>
                {a.status === 'VALIDATED' ? 'VALIDADA' : 'DESCARTADA'}
              </span>
              <span className="muted">
                por {a.decided_by} · {a.decided_at ? time(a.decided_at) : ''}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
