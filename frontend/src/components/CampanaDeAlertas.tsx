import { useEffect, useRef, useState } from 'react';
import { time } from '../format';
import type { Alert, Drone } from '../types';

const TIPO = { PERSON: 'PERSONA', VEHICLE: 'VEHÍCULO' } as const;

/**
 * Las alertas de detección son lo único de la consola que no se puede esperar a
 * mirar: llegan solas y hay que decidirlas. Por eso viven en una campana del
 * encabezado y no en una tarjeta al pie de una vista —ahí sólo las veía quien
 * ya estaba mirando ese dron—, y desde el desplegable se validan o se descartan
 * sin salir de donde uno esté.
 */
export default function CampanaDeAlertas({
  alerts,
  drones,
  onDecidir,
  onVerDron,
}: {
  alerts: Alert[];
  drones: Drone[];
  onDecidir: (id: number, decision: 'VALIDATED' | 'DISMISSED') => void;
  onVerDron: (droneId: string) => void;
}) {
  const [abierta, setAbierta] = useState(false);
  const caja = useRef<HTMLDivElement>(null);

  const pendientes = alerts.filter((a) => a.status === 'PENDING');
  const decididas = alerts.filter((a) => a.status !== 'PENDING').slice(0, 5);

  // Un desplegable del encabezado tiene que cerrarse solo: si queda abierto
  // tapa la vista de abajo y se lo confunde con parte de la barra.
  useEffect(() => {
    if (!abierta) return;
    function afuera(ev: MouseEvent) {
      if (!caja.current?.contains(ev.target as Node)) setAbierta(false);
    }
    function escape(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setAbierta(false);
    }
    document.addEventListener('mousedown', afuera);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', afuera);
      document.removeEventListener('keydown', escape);
    };
  }, [abierta]);

  function nombre(droneId: string | null): string {
    if (!droneId) return 'Dron desconocido';
    return drones.find((d) => d.droneId === droneId)?.displayName ?? 'Dron desconocido';
  }

  return (
    <div className="campana" ref={caja}>
      <button
        type="button"
        className={pendientes.length > 0 ? 'campana-boton con-pendientes' : 'campana-boton'}
        aria-expanded={abierta}
        aria-label={
          pendientes.length === 0
            ? 'Alertas: ninguna pendiente'
            : `Alertas: ${pendientes.length} ${pendientes.length === 1 ? 'pendiente' : 'pendientes'}`
        }
        onClick={() => setAbierta((v) => !v)}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M10 2.5a5 5 0 0 0-5 5v3l-1.4 2.6h12.8L15 10.5v-3a5 5 0 0 0-5-5z" strokeLinejoin="round" />
          <path d="M8 15.2a2 2 0 0 0 4 0" strokeLinecap="round" />
        </svg>
        {pendientes.length > 0 && <span className="badge-count">{pendientes.length}</span>}
      </button>

      {abierta && (
        <div className="campana-panel" role="region" aria-label="Alertas de detección">
          <div className="campana-cabecera">
            <span className="etiqueta">Alertas de detección</span>
          </div>

          {pendientes.length === 0 && <p className="vacio">Sin alertas pendientes.</p>}

          {pendientes.map((a) => (
            <div key={a.id} className="campana-alerta">
              <div className="campana-alerta-head">
                <span className={`badge ${a.type.toLowerCase()}`}>{TIPO[a.type as keyof typeof TIPO] ?? a.type}</span>
                <button type="button" className="enlace" onClick={() => { onVerDron(a.drone_id!); setAbierta(false); }} disabled={!a.drone_id}>
                  {nombre(a.drone_id)}
                </button>
                <time className="mono muted" dateTime={a.created_at}>
                  {time(a.created_at)}
                </time>
              </div>
              {a.snapshot && <img className="snapshot" src={`data:image/jpeg;base64,${a.snapshot}`} alt="Detección" />}
              <div className="alert-actions">
                <button className="validate" onClick={() => onDecidir(a.id, 'VALIDATED')}>
                  Validar
                </button>
                <button className="dismiss" onClick={() => onDecidir(a.id, 'DISMISSED')}>
                  Descartar
                </button>
              </div>
            </div>
          ))}

          {decididas.length > 0 && (
            <>
              <hr className="regla" />
              <span className="etiqueta">Últimas decididas</span>
              {decididas.map((a) => (
                <div key={a.id} className="campana-decidida">
                  <span className={`estado etiqueta ${a.status === 'VALIDATED' ? 'ok' : 'muted'}`}>
                    {a.status === 'VALIDATED' ? 'Validada' : 'Descartada'}
                  </span>
                  <span className="muted">
                    {TIPO[a.type as keyof typeof TIPO] ?? a.type} · {nombre(a.drone_id)}
                  </span>
                  <time className="mono muted" dateTime={a.created_at}>
                    {time(a.created_at)}
                  </time>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
