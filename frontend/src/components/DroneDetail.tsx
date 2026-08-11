import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Alert, Drone, DroneStatus, EventRow, Me, PatrolRoute } from '../types';
import AlertsPanel from './AlertsPanel';
import DroneStatusCard from './DroneStatusCard';
import DronesMap, { type MapItem, type WaypointsLayer } from './DronesMap';
import EditableName from './EditableName';
import EventLog from './EventLog';
import LiveVideo from './LiveVideo';

// Estados en los que el patrullaje normal está interrumpido: habilitan
// "Retomar ruta" y "Continuar desde acá" en los nodos.
const INTERRUMPIDO = ['MANUAL', 'FORCED', 'PAUSED'];

export default function DroneDetail({
  me,
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
  me: Me | null;
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
  const [error, setError] = useState('');
  const [rutaElegida, setRutaElegida] = useState<number | ''>('');

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

  const rutaActiva = routes.find((r) => r.id === status?.routeId) ?? null;
  const interrumpido = !!status && INTERRUMPIDO.includes(status.state);
  const controlador = drone.controlledBy ?? status?.controlledBy ?? null;
  const soyControlador = !!me && controlador === me.username;
  const puedeControlar = !!me && me.canControl;
  const esSupervisor = me?.role === 'supervisor' || me?.role === 'admin';

  async function llamar(path: string, options: RequestInit = {}) {
    setError('');
    try {
      await api(path, options);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const decide = (id: number, decision: 'VALIDATED' | 'DISMISSED') =>
    llamar(`/alerts/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });

  // "Retomar ruta": vuelve al patrullaje desde el último nodo recorrido
  const retomar = () => llamar(`/drones/${drone.droneId}/resume`, { method: 'POST', body: '{}' });
  const continuarDesde = (index: number) =>
    llamar(`/drones/${drone.droneId}/resume`, { method: 'POST', body: JSON.stringify({ fromIndex: index }) });
  const forzarNodo = (index: number) => {
    const routeId = rutaActiva?.id ?? rutaElegida;
    if (routeId) llamar(`/drones/${drone.droneId}/goto`, { method: 'POST', body: JSON.stringify({ routeId, index }) });
  };

  const comenzarRuta = () =>
    rutaElegida &&
    llamar(`/drones/${drone.droneId}/route/start`, { method: 'POST', body: JSON.stringify({ routeId: rutaElegida }) });
  const interrumpirRuta = () => llamar(`/drones/${drone.droneId}/route/stop`, { method: 'POST' });

  const tomarControl = () => llamar(`/drones/${drone.droneId}/control`, { method: 'POST' });
  const soltarControl = () =>
    llamar(`/drones/${drone.droneId}/control`, { method: 'DELETE', body: JSON.stringify({ resume: 'last' }) });
  const quitarControl = soltarControl; // supervisor: mismo endpoint, el backend registra que fue forzado
  const mover = (bearing: number) => () =>
    llamar(`/drones/${drone.droneId}/manual_move`, { method: 'POST', body: JSON.stringify({ bearing, distanceM: 25 }) });

  // La ruta que se dibuja: la activa, o la elegida en el selector si no hay vuelo
  const rutaMapa = rutaActiva ?? routes.find((r) => r.id === rutaElegida) ?? null;
  const waypoints = useMemo<WaypointsLayer | null>(() => {
    if (!rutaMapa) return null;
    return {
      route: rutaMapa,
      visitedIndex: rutaActiva ? (status?.waypointIndex ?? -1) : -1,
      onLabel: (index, label) => onWaypointLabel(rutaMapa.id, index, label),
      canForce: puedeControlar && drone.online && (!controlador || soyControlador || esSupervisor),
      canContinue: interrumpido,
      onForce: forzarNodo,
      onContinue: continuarDesde,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rutaMapa, rutaActiva, status?.waypointIndex, puedeControlar, interrumpido, drone.online, controlador, soyControlador, esSupervisor]);

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
        {controlador && <span className="badge person">Control manual: {controlador}</span>}
        {error && <span className="bad">{error}</span>}
      </div>
      <div className="grid">
        <section className="col">
          <DroneStatusCard status={status} onResumePatrol={retomar} />

          <div className="card patrol-card">
            <h2>Patrullaje</h2>
            <p className="muted">
              Ruta actual:{' '}
              {rutaActiva ? (
                <strong className="accent">
                  {rutaActiva.name} · nodo {(status?.waypointIndex ?? 0) + 1} de {rutaActiva.waypoints.length}
                </strong>
              ) : (
                'ninguna'
              )}
            </p>
            <div className="ruta-controles">
              <select value={rutaElegida} onChange={(e) => setRutaElegida(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Elegir ruta…</option>
                {routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.waypoints.length} nodos)
                  </option>
                ))}
              </select>
              <button onClick={comenzarRuta} disabled={!rutaElegida || !drone.online}>
                Comenzar
              </button>
              <button onClick={interrumpirRuta} disabled={!drone.online || status?.state !== 'PATROLLING'}>
                Interrumpir
              </button>
            </div>
          </div>

          {puedeControlar && (
            <div className="card">
              <h2>Control del dron</h2>
              {!controlador && (
                <button onClick={tomarControl} disabled={!drone.online}>
                  Tomar control manual
                </button>
              )}
              {soyControlador && (
                <div className="control-panel">
                  <div className="pad">
                    <button title="Norte" onClick={mover(0)}>▲</button>
                    <div>
                      <button title="Oeste" onClick={mover(270)}>◀</button>
                      <button title="Este" onClick={mover(90)}>▶</button>
                    </div>
                    <button title="Sur" onClick={mover(180)}>▼</button>
                  </div>
                  <p className="muted">Cada toque desplaza el dron 25 m en esa dirección.</p>
                  <button className="resume" onClick={soltarControl}>
                    Devolver al patrullaje
                  </button>
                </div>
              )}
              {controlador && !soyControlador && (
                <p className="muted">
                  Controlado por <strong>{controlador}</strong>.{' '}
                  {esSupervisor && (
                    <button className="chico dismiss" onClick={quitarControl}>
                      Quitar control
                    </button>
                  )}
                </p>
              )}
            </div>
          )}

          <AlertsPanel alerts={droneAlerts} onDecide={decide} />
        </section>
        <section className="col">
          <div className="card">
            <div className="mapa-head">
              <h2>Ubicación</h2>
              <button
                onClick={retomar}
                disabled={!drone.online || !interrumpido}
                title="Vuelve al patrullaje desde el último nodo recorrido"
              >
                Retomar ruta
              </button>
            </div>
            <DronesMap items={items} alwaysShowLine waypoints={waypoints} />
          </div>
          <LiveVideo frame={frame} />
          <EventLog events={events} />
        </section>
      </div>
    </main>
  );
}
