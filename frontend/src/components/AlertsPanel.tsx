import { time } from '../format';
import type { Alert } from '../types';

const TYPE_LABELS = { PERSON: 'PERSONA', VEHICLE: 'VEHÍCULO' } as const;

/** El identificador del dron es un hash largo: se muestra abreviado, nunca entero. */
function droneCorto(droneId: string | null): string {
  if (!droneId) return '—';
  return droneId.length > 14 ? `${droneId.slice(0, 6)}…${droneId.slice(-4)}` : droneId;
}

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
      {pending.length === 0 && <p className="vacio">Sin alertas pendientes.</p>}
      {pending.map((a) => (
        <div key={a.id} className="alert pending">
          <div className="alert-head">
            <span className={`badge ${a.type.toLowerCase()}`}>{TYPE_LABELS[a.type]}</span>
            {/* La hora es el dato que decide la urgencia: va en tinta plena */}
            <time className="mono" dateTime={a.created_at}>
              {time(a.created_at)}
            </time>
            <span className="mono muted">
              #{a.id} · {droneCorto(a.drone_id)}
            </span>
          </div>
          {/* La captura va montada en mármol como el video, pero sin filo dorado:
              dentro de una alerta el único acento tiene que ser el rojo. */}
          {a.snapshot && (
            <div className="hueco">
              <img className="snapshot" src={`data:image/jpeg;base64,${a.snapshot}`} alt="Detección" />
            </div>
          )}
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
          {/* Filigrana como bisagra entre lo que espera decisión y lo ya resuelto */}
          <hr className="regla-ornamental" />
          <h3>Historial reciente</h3>
          {decided.map((a) => (
            <div key={a.id} className="alert decided">
              <span className={`badge ${a.type.toLowerCase()}`}>{TYPE_LABELS[a.type]}</span>
              <span className="mono muted">#{a.id}</span>
              <span className={`estado etiqueta ${a.status === 'VALIDATED' ? 'ok' : 'muted'}`}>
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
