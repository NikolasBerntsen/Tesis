import { useEffect, useMemo, useState } from 'react';
import { api, rutasDeBase } from '../api';
import type { Drone, DroneStatus, EventRow, Me, PatrolRoute } from '../types';
import DroneStatusCard from './DroneStatusCard';
import DronesMap, { type MapItem, type WaypointsLayer } from './DronesMap';
import EditableName from './EditableName';
import EventLog from './EventLog';
import LiveVideo from './LiveVideo';

// Estados en los que el patrullaje normal está interrumpido: habilitan
// "Retomar ruta" y "Continuar desde acá" en los nodos.
const INTERRUMPIDO = ['MANUAL', 'FORCED', 'PAUSED'];

const TRAZO = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/**
 * Flecha del pad de control. Se dibuja una sola vez y se rota por rumbo con un
 * `transform` del SVG: así los cuatro botones comparten el mismo trazo grabado.
 */
function Flecha({ rumbo }: { rumbo: number }) {
  return (
    <svg width="22" height="22" viewBox="0 0 18 18" {...TRAZO}>
      <path d="M9 14.6V4.2M4.4 8.8 9 4.2l4.6 4.6" transform={`rotate(${rumbo} 9 9)`} />
    </svg>
  );
}

export default function DroneDetail({
  me,
  drone,
  status,
  frame,
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
  liveEvents: EventRow[];
  routes: PatrolRoute[];
  onBack: () => void;
  onRename: (displayName: string) => void;
  onWaypointLabel: (routeId: number, index: number, label: string) => void;
}) {
  const [history, setHistory] = useState<EventRow[]>([]);
  const [error, setError] = useState('');
  const [rutaElegida, setRutaElegida] = useState<number | ''>('');
  // Ids de las rutas que la base de este dron tiene habilitadas. `null` mientras
  // no llegaron: no es lo mismo que "la base no tiene ninguna".
  const [idsDeLaBase, setIdsDeLaBase] = useState<number[] | null>(null);

  // Un dron sólo puede patrullar las rutas de la base de la que sale. Ofrecerle
  // todas las del sistema era mandarlo a volar a la otra punta de la ciudad.
  useEffect(() => {
    setIdsDeLaBase(null);
    setRutaElegida('');
    if (drone.baseId == null) {
      setIdsDeLaBase([]);
      return;
    }
    let vigente = true;
    rutasDeBase(drone.baseId)
      .then((rs) => vigente && setIdsDeLaBase(rs.map((r) => r.id)))
      .catch(() => vigente && setIdsDeLaBase([]));
    return () => {
      vigente = false;
    };
  }, [drone.droneId, drone.baseId]);

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


  const items = useMemo<MapItem[]>(
    () => [{ droneId: drone.droneId, displayName: drone.displayName, base: drone.base, status }],
    [drone.droneId, drone.displayName, drone.base, status],
  );

  // La ruta en curso sale de la lista completa: si se la desasignó de la base
  // mientras el dron la volaba, igual hay que poder verla y retomarla.
  const rutaActiva = routes.find((r) => r.id === status?.routeId) ?? null;
  const habilitadas = useMemo(
    () => (idsDeLaBase === null ? [] : routes.filter((r) => idsDeLaBase.includes(r.id))),
    [routes, idsDeLaBase],
  );
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

  // La ruta que se dibuja: la activa, o la elegida en el selector si no hay
  // vuelo. En ese segundo caso es una PREVISUALIZACIÓN: todavía no se ordenó
  // nada, así que sus nodos se pintan distinto para no confundirlos con los de
  // un patrullaje en curso.
  const rutaMapa = rutaActiva ?? habilitadas.find((r) => r.id === rutaElegida) ?? null;
  const previsualizando = !rutaActiva && rutaMapa !== null;
  const waypoints = useMemo<WaypointsLayer | null>(() => {
    if (!rutaMapa) return null;
    return {
      route: rutaMapa,
      visitedIndex: rutaActiva ? (status?.waypointIndex ?? -1) : -1,
      preview: previsualizando,
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
          <svg width="15" height="15" viewBox="0 0 16 16" {...TRAZO} style={{ verticalAlign: '-2px' }}>
            <path d="M13 8H3.4M7.4 3.4 3 8l4.4 4.6" />
          </svg>{' '}
          Volver a Drones
        </button>
        <h2>
          <EditableName name={drone.displayName} onRename={onRename} />
        </h2>
        <span className={`estado ${drone.online ? 'ok' : 'muted'}`}>
          {drone.online ? 'En vuelo' : 'Desconectado'}
        </span>
        {controlador && <span className="badge oro">Control manual: {controlador}</span>}
      </div>
      {/* El error va en su propia línea: dentro del encabezado empujaba el nombre */}
      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}
      {/* El estado es lo primero que se mira y no compite con nada: cruza todo
          el ancho arriba. Debajo, el video manda sobre el mapa —es donde pasa
          lo que hay que decidir— y el resto queda en la columna angosta. */}
      <DroneStatusCard status={status} base={drone.base} onResumePatrol={retomar} />

      {/* Video y ubicación cruzan toda la pantalla: son las dos ventanas de lo
          que está pasando y se miran juntas. Los controles quedan debajo. */}
      <div className="par-video-mapa">
        <LiveVideo frame={frame} />
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
          <div className="mapa-leyenda" data-testid="leyenda-mapa">
            <span className="estado accent">Dron</span>
            <span className="estado">Base</span>
            <span className="estado bad">Nodo pendiente</span>
            <span className="estado ok">Nodo recorrido</span>
            {previsualizando && <span className="estado info">Ruta a comenzar</span>}
          </div>
        </div>
      </div>

      <div className="grid-operacion">
        <div className="card">
          <h2>Patrullaje</h2>
          <div className="hueco">
            <div className="etiqueta">Ruta actual</div>
            {rutaActiva ? (
              <div className="cifra-chica accent">
                {rutaActiva.name} · nodo {(status?.waypointIndex ?? 0) + 1} de {rutaActiva.waypoints.length}
              </div>
            ) : (
              <div className="muted">Ninguna</div>
            )}
          </div>
          <hr className="regla" />
          <div className="ruta-controles">
            <select
              aria-label="Ruta de patrullaje"
              value={rutaElegida}
              disabled={habilitadas.length === 0}
              onChange={(e) => setRutaElegida(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">Elegir ruta…</option>
              {habilitadas.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.waypoints.length} nodos)
                </option>
              ))}
            </select>
            <button className="primario" onClick={comenzarRuta} disabled={!rutaElegida || !drone.online}>
              Comenzar
            </button>
            <button onClick={interrumpirRuta} disabled={!drone.online || status?.state !== 'PATROLLING'}>
              Interrumpir
            </button>
          </div>
          {idsDeLaBase !== null && habilitadas.length === 0 && (
            <p className="muted">
              {drone.base
                ? `${drone.base.name} todavía no tiene rutas asignadas: asignáselas desde Bases.`
                : 'El dron no tiene base asignada, así que no hay rutas habilitadas.'}
            </p>
          )}
        </div>

        {puedeControlar && (
          <div className="card con-esquina">
            <h2>Control del dron</h2>
            {!controlador && (
              <button className="primario" onClick={tomarControl} disabled={!drone.online}>
                Tomar control manual
              </button>
            )}
            {soyControlador && (
              <div className="control-panel">
                {/* Plato hundido: el pad es la pieza más táctil de la consola
                    y tiene que leerse como un instrumento grabado en la piedra */}
                <div className="pad-plato">
                  <div className="pad">
                    <button title="Norte" aria-label="Mover al norte" onClick={mover(0)}>
                      <Flecha rumbo={0} />
                    </button>
                    <div>
                      <button title="Oeste" aria-label="Mover al oeste" onClick={mover(270)}>
                        <Flecha rumbo={270} />
                      </button>
                      <button title="Este" aria-label="Mover al este" onClick={mover(90)}>
                        <Flecha rumbo={90} />
                      </button>
                    </div>
                    <button title="Sur" aria-label="Mover al sur" onClick={mover(180)}>
                      <Flecha rumbo={180} />
                    </button>
                  </div>
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
      </div>

      {/* Las alertas de este dron se atienden desde la campana del encabezado,
          que las muestra apenas llegan sin importar en qué vista esté uno. */}
      <EventLog events={events} />
    </main>
  );
}
