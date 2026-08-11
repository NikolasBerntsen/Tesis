import { useMemo, useState } from 'react';
import { time } from '../format';
import type { Alert, Drone, DroneStatus } from '../types';
import CameraTile from './CameraTile';
import DronesMap, { type MapItem } from './DronesMap';

const TIPO_ALERTA = { PERSON: 'PERSONA', VEHICLE: 'VEHÍCULO' } as const;

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
  const nombre = (droneId: string | null) =>
    drones.find((d) => d.droneId === droneId)?.displayName ?? droneId ?? '—';

  return (
    <main className="dashboard-main">
      {pendientes.length > 0 && (
        <div className="alert-strip">
          <strong>{pendientes.length} alerta(s) sin atender</strong>
          {pendientes.slice(0, 4).map((a) => (
            <button key={a.id} className="alert-chip" onClick={() => a.drone_id && onOpenDrone(a.drone_id)}>
              {TIPO_ALERTA[a.type]} · {nombre(a.drone_id)} · {time(a.created_at)}
            </button>
          ))}
        </div>
      )}
      <div className="view-switch">
        <button className={view === 'cameras' ? 'active' : ''} onClick={() => setView('cameras')}>
          Cámaras
        </button>
        <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>
          Mapa
        </button>
      </div>

      {view === 'cameras' ? (
        active.length === 0 ? (
          <p className="muted">No hay drones activos.</p>
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
          <DronesMap items={items} />
        </div>
      )}
    </main>
  );
}
