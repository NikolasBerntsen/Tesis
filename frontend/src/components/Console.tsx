import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getUsername } from '../api';
import type { Alert, Drone, DroneStatus, EventRow, PatrolRoute } from '../types';
import { useWebSocket } from '../useWebSocket';
import Dashboard from './Dashboard';
import DroneDetail from './DroneDetail';

const MAX_EVENTS = 300;
const TICK_MS = 1000;

export default function Console({ onLogout }: { onLogout: () => void }) {
  const [drones, setDrones] = useState<Drone[]>([]);
  const [statuses, setStatuses] = useState<Record<string, DroneStatus>>({});
  const [frames, setFrames] = useState<Record<string, string>>({});
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [liveEvents, setLiveEvents] = useState<EventRow[]>([]);
  const [routes, setRoutes] = useState<PatrolRoute[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Los status de cada dron llegan a destiempo: se acumulan acá y se vuelcan
  // al estado en un único tick, así todos los marcadores se mueven a la vez.
  const statusBuffer = useRef<Record<string, DroneStatus>>({});

  useEffect(() => {
    const id = setInterval(() => setStatuses({ ...statusBuffer.current }), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const connected = useWebSocket((msg) => {
    switch (msg.type) {
      case 'status':
        statusBuffer.current[msg.droneId] = msg;
        break;
      case 'video_frame':
        setFrames((prev) => ({ ...prev, [msg.droneId]: msg.jpegBase64 }));
        break;
      case 'event':
        setLiveEvents((prev) => [msg.event, ...prev].slice(0, MAX_EVENTS));
        break;
      case 'alert_created':
        setAlerts((prev) => [msg.alert, ...prev]);
        break;
      case 'alert_updated':
        setAlerts((prev) => prev.map((a) => (a.id === msg.alert.id ? msg.alert : a)));
        break;
      case 'drone_online':
        upsertDrone(msg.drone);
        break;
      case 'drone_offline':
        upsertDrone(msg.drone);
        delete statusBuffer.current[msg.drone.droneId];
        setFrames((prev) => {
          const next = { ...prev };
          delete next[msg.drone.droneId];
          return next;
        });
        break;
      case 'route_updated':
        setRoutes((prev) => prev.map((r) => (r.id === msg.route.id ? msg.route : r)));
        break;
      case 'drone_renamed':
        setDrones((prev) =>
          prev.map((d) => (d.droneId === msg.droneId ? { ...d, displayName: msg.displayName } : d)),
        );
        break;
    }
  });

  // Se recarga al montar y en cada reconexión: mientras el WebSocket estuvo
  // caído pudieron conectarse o desconectarse drones y llegar alertas nuevas.
  useEffect(() => {
    api<Drone[]>('/drones')
      .then((list) => {
        setDrones(list);
        const buffer: Record<string, DroneStatus> = {};
        for (const d of list) if (d.lastStatus) buffer[d.droneId] = d.lastStatus;
        statusBuffer.current = buffer;
      })
      .catch(console.error);
    api<Alert[]>('/alerts').then(setAlerts).catch(console.error);
    api<PatrolRoute[]>('/routes').then(setRoutes).catch(console.error);
  }, [connected]);

  // Apodo de un nodo de patrullaje. El backend responde con la ruta completa y
  // además emite route_updated, así que las demás consolas también se enteran.
  async function setWaypointLabel(routeId: number, index: number, label: string) {
    try {
      const route = await api<PatrolRoute>(`/routes/${routeId}/waypoints/${index}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      });
      setRoutes((prev) => prev.map((r) => (r.id === route.id ? route : r)));
    } catch (err) {
      console.error(err);
    }
  }

  function upsertDrone(drone: Drone) {
    setDrones((prev) =>
      prev.some((d) => d.droneId === drone.droneId)
        ? prev.map((d) => (d.droneId === drone.droneId ? drone : d))
        : [...prev, drone],
    );
  }

  async function rename(droneId: string, displayName: string) {
    try {
      upsertDrone(await api<Drone>(`/drones/${droneId}`, { method: 'PATCH', body: JSON.stringify({ displayName }) }));
    } catch (err) {
      console.error(err);
    }
  }

  const pendingAlerts = useMemo(() => {
    const count: Record<string, number> = {};
    for (const a of alerts) {
      if (a.status === 'PENDING' && a.drone_id) count[a.drone_id] = (count[a.drone_id] ?? 0) + 1;
    }
    return count;
  }, [alerts]);

  const selected = drones.find((d) => d.droneId === selectedId) ?? null;

  return (
    <div className="dashboard">
      <header className="topbar">
        <h1>Comando Central</h1>
        <div className="topbar-right">
          <span className={connected ? 'conn ok' : 'conn bad'}>
            {connected ? '● conectado' : '● sin conexión'}
          </span>
          <span className="username">{getUsername()}</span>
          <button className="ghost" onClick={onLogout}>
            Salir
          </button>
        </div>
      </header>
      {selected ? (
        <DroneDetail
          drone={selected}
          status={statuses[selected.droneId] ?? null}
          frame={frames[selected.droneId] ?? null}
          alerts={alerts}
          liveEvents={liveEvents}
          routes={routes}
          onBack={() => setSelectedId(null)}
          onRename={(name) => rename(selected.droneId, name)}
          onWaypointLabel={setWaypointLabel}
        />
      ) : (
        <Dashboard
          drones={drones}
          statuses={statuses}
          frames={frames}
          alerts={alerts}
          pendingAlerts={pendingAlerts}
          onOpenDrone={setSelectedId}
          onRename={rename}
        />
      )}
    </div>
  );
}
