import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Alert, Drone, DroneStatus, EventRow, PatrolRoute } from '../types';
import AlertsPanel from './AlertsPanel';
import DroneStatusCard from './DroneStatusCard';
import DronesMap, { type MapItem, type WaypointsLayer } from './DronesMap';
import EditableName from './EditableName';
import EventLog from './EventLog';
import LiveVideo from './LiveVideo';

export default function DroneDetail({
  drone,
  status,
  frame,
  alerts,
  liveEvents,
  routes,
  onBack,
  onRename,
  onWaypointLabel,
}: {
  drone: Drone;
  status: DroneStatus | null;
  frame: string | null;
  alerts: Alert[];
  liveEvents: EventRow[];
  routes: PatrolRoute[];
  onBack: () => void;
  onRename: (displayName: string) => void;
  onWaypointLabel: (routeId: number, index: number, label: string) => void;
}) {
  const [history, setHistory] = useState<EventRow[]>([]);

  useEffect(() => {
    setHistory([]);
    api<EventRow[]>(`/events?droneId=${encodeURIComponent(drone.droneId)}`)
      .then(setHistory)
      .catch(console.error);
  }, [drone.droneId]);

  // Historial del dron más los eventos que fueron llegando por WebSocket.
  const events = useMemo(() => {
    const known = new Set(history.map((e) => e.id));
    const fresh = liveEvents.filter((e) => e.drone_id === drone.droneId && !known.has(e.id));
    return [...fresh, ...history];
  }, [history, liveEvents, drone.droneId]);

  const droneAlerts = useMemo(
    () => alerts.filter((a) => a.drone_id === drone.droneId),
    [alerts, drone.droneId],
  );

  const items = useMemo<MapItem[]>(
    () => [{ droneId: drone.droneId, displayName: drone.displayName, base: drone.base, status }],
    [drone.droneId, drone.displayName, drone.base, status],
  );

  // Nodos de la ruta que está volando: rojos los pendientes, verdes los pasados.
  const waypoints = useMemo<WaypointsLayer | null>(() => {
    const route = routes.find((r) => r.id === status?.routeId);
    if (!route) return null;
    return {
      route,
      visitedIndex: status?.waypointIndex ?? -1,
      onLabel: (index, label) => onWaypointLabel(route.id, index, label),
    };
  }, [routes, status?.routeId, status?.waypointIndex, onWaypointLabel]);

  async function decide(id: number, decision: 'VALIDATED' | 'DISMISSED') {
    try {
      await api(`/alerts/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
    } catch (err) {
      console.error(err);
    }
  }

  async function resumePatrol() {
    try {
      await api(`/drones/${drone.droneId}/resume`, { method: 'POST' });
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <main className="detail-main">
      <div className="detail-head">
        <button className="ghost" onClick={onBack}>
          ← Volver al dashboard
        </button>
        <h2>
          <EditableName name={drone.displayName} onRename={onRename} />
        </h2>
        <span className={drone.online ? 'ok' : 'muted'}>{drone.online ? 'En vuelo' : 'Desconectado'}</span>
      </div>
      <div className="grid">
        <section className="col">
          <DroneStatusCard status={status} onResumePatrol={resumePatrol} />
          <div className="card">
            <h2>Ubicación</h2>
            <DronesMap items={items} alwaysShowLine waypoints={waypoints} />
          </div>
          <AlertsPanel alerts={droneAlerts} onDecide={decide} />
        </section>
        <section className="col">
          <LiveVideo frame={frame} />
          <EventLog events={events} />
        </section>
      </div>
    </main>
  );
}
