import { useMemo, useState } from 'react';
import { time } from '../format';
import type { Alert, Drone, DroneStatus } from '../types';
import CameraTile from './CameraTile';
import DronesMap, { type MapItem } from './DronesMap';

const TIPO_ALERTA = { PERSON: 'PERSONA', VEHICLE: 'VEHÍCULO' } as const;
// Más de cuatro chips y la franja deja de leerse de un vistazo.
const CHIPS_VISIBLES = 4;

export default function Dashboard({
  drones,
  statuses,
  frames,
  alerts,
  pendingAlerts,
  onOpenDrone,
  onRename,
}: {
  drones: Drone[];
  statuses: Record<string, DroneStatus>;
  frames: Record<string, string>;
  alerts: Alert[];
  pendingAlerts: Record<string, number>;
  onOpenDrone: (droneId: string) => void;
  onRename: (droneId: string, displayName: string) => void;
}) {
  const [view, setView] = useState<'cameras' | 'map'>('cameras');
  const active = drones.filter((d) => d.online);

  const items = useMemo<MapItem[]>(
    () =>
      drones.map((d) => ({
        droneId: d.droneId,
        displayName: d.displayName,
        base: d.base,
        status: statuses[d.droneId] ?? null,
      })),
    [drones, statuses],
  );

  // Las alertas se atienden en la vista de detalle, pero el operador tiene que
  // enterarse sin importar en qué vista del dashboard esté parado.
  const pendientes = alerts.filter((a) => a.status === 'PENDING');
  const sinMostrar = pendientes.length - CHIPS_VISIBLES;
  const nombre = (droneId: string | null) =>
    drones.find((d) => d.droneId === droneId)?.displayName ?? droneId ?? '—';

  return (
    <main className="dashboard-main">
      {pendientes.length > 0 && (
        <div className="alert-strip" role="status">
          <strong>
            {pendientes.length} {pendientes.length === 1 ? 'alerta sin atender' : 'alertas sin atender'}
          </strong>
          {pendientes.slice(0, CHIPS_VISIBLES).map((a) => (
            <button key={a.id} className="alert-chip" onClick={() => a.drone_id && onOpenDrone(a.drone_id)}>
              {TIPO_ALERTA[a.type]} · {nombre(a.drone_id)} · {time(a.created_at)}
            </button>
          ))}
          {sinMostrar > 0 && <span className="badge">+{sinMostrar} más</span>}
        </div>
      )}

      <div className="barra-acciones">
        <span className="etiqueta">
          {active.length} en vuelo · {drones.length} {drones.length === 1 ? 'registrado' : 'registrados'}
        </span>
        <div className="view-switch">
          <button
            className={view === 'cameras' ? 'active' : ''}
            aria-pressed={view === 'cameras'}
            onClick={() => setView('cameras')}
          >
            Cámaras
          </button>
          <button
            className={view === 'map' ? 'active' : ''}
            aria-pressed={view === 'map'}
            onClick={() => setView('map')}
          >
            Mapa
          </button>
        </div>
      </div>

      {view === 'cameras' ? (
        active.length === 0 ? (
          <div className="card con-esquina">
            <p className="vacio">No hay drones activos.</p>
          </div>
        ) : (
          <div className="camera-grid">
            {active.map((d) => (
              <CameraTile
                key={d.droneId}
                drone={d}
                status={statuses[d.droneId] ?? null}
                frame={frames[d.droneId] ?? null}
                pendingAlerts={pendingAlerts[d.droneId] ?? 0}
                onOpen={() => onOpenDrone(d.droneId)}
                onRename={(name) => onRename(d.droneId, name)}
              />
            ))}
          </div>
        )
      ) : (
        <div className="card">
          <h2>Posición de la flota</h2>
          <DronesMap items={items} />
        </div>
      )}
    </main>
  );
}
