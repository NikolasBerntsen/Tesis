import { useMemo, useState } from 'react';
import { time } from '../format';
import type { RastroObjetivo } from '../rastro';
import type { Alert, Drone, DroneStatus } from '../types';
import CameraTile from './CameraTile';
import DronesMap, { type MapItem } from './DronesMap';

const TIPO_ALERTA = { PERSON: 'PERSONA', VEHICLE: 'VEHÍCULO' } as const;
// Más de cuatro chips y la franja deja de leerse de un vistazo.
const CHIPS_VISIBLES = 4;

// Fijo y no `{}` en la firma: un objeto nuevo en cada render rehacía los
// items del mapa en cada render, y el mapa los redibuja cuando cambian.
const SIN_RASTROS: Record<string, RastroObjetivo> = {};

export default function Dashboard({
  drones,
  statuses,
  frames,
  alerts,
  pendingAlerts,
  rastros = SIN_RASTROS,
  onOpenDrone,
  onRename,
}: {
  drones: Drone[];
  statuses: Record<string, DroneStatus>;
  frames: Record<string, string>;
  alerts: Alert[];
  pendingAlerts: Record<string, number>;
  /** Rastro del objetivo de cada dron que está sobre uno (ver rastro.ts). */
  rastros?: Record<string, RastroObjetivo>;
  onOpenDrone: (droneId: string) => void;
  onRename: (droneId: string, displayName: string) => void;
}) {
  const [view, setView] = useState<'cameras' | 'map'>('cameras');
  const active = drones.filter((d) => d.online);
  // "En vuelo" quiere decir en el aire: un dron conectado y apoyado en su base
  // tiene cámara para mostrar, pero contarlo como volando era lo mismo que el
  // "En vuelo" del detalle con el dron en el suelo. Sin el dato (`flying` no
  // viene de una app vieja) se lo cuenta, como antes.
  const enVuelo = active.filter((d) => statuses[d.droneId]?.flying !== false);

  const items = useMemo<MapItem[]>(
    () =>
      drones.map((d) => ({
        droneId: d.droneId,
        displayName: d.displayName,
        base: d.base,
        status: statuses[d.droneId] ?? null,
        // El mapa de la flota también muestra hacia dónde se fue cada objetivo:
        // con dos drones sobre dos objetivos, es la vista que reparte la gente.
        rastroObjetivo: rastros[d.droneId]?.puntos,
      })),
    [drones, statuses, rastros],
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
          {enVuelo.length} en vuelo · {drones.length} {drones.length === 1 ? 'registrado' : 'registrados'}
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
