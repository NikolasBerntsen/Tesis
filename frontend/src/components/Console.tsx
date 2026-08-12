import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getRole, getUsername } from '../api';
import type { Alert, Drone, DroneStatus, EventRow, Me, NovedadDron, PatrolRoute, RolConsola } from '../types';
import { useWebSocket } from '../useWebSocket';
import BasesView from './BasesView';
import BotonTema from './BotonTema';
import Dashboard from './Dashboard';
import DroneDetail from './DroneDetail';
import DronesView from './DronesView';
import LogsView from './LogsView';
import UsersView from './UsersView';

const MAX_EVENTS = 300;
const TICK_MS = 1000;

type Seccion = 'operacion' | 'drones' | 'bases' | 'usuarios' | 'registro';

/**
 * Qué secciones ve cada rol, en el orden en que aparecen en la barra. La
 * primera de la lista es la pantalla de trabajo con la que arranca.
 * El operador de campo no tiene tablero a propósito: el backend no le manda
 * telemetría, ni video, ni alertas, ni eventos, así que un tablero le quedaría
 * vacío y cada pedido le volvería con un 403.
 */
const SECCIONES: Record<RolConsola, readonly Seccion[]> = {
  field_operator: ['drones', 'bases'],
  // El operador ve el inventario y las bases para ubicarse, pero no los edita.
  operator: ['operacion', 'drones', 'bases'],
  supervisor: ['operacion', 'drones', 'bases', 'usuarios'],
  admin: ['operacion', 'drones', 'bases', 'usuarios', 'registro'],
};

/** "Operación" es la flota en vivo; "Drones" es el registro de activos. */
const ETIQUETA: Record<Seccion, string> = {
  operacion: 'Operación',
  drones: 'Drones',
  bases: 'Bases',
  usuarios: 'Usuarios',
  registro: 'Registro',
};

export default function Console({ onLogout }: { onLogout: () => void }) {
  const [drones, setDrones] = useState<Drone[]>([]);
  const [statuses, setStatuses] = useState<Record<string, DroneStatus>>({});
  const [frames, setFrames] = useState<Record<string, string>>({});
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [liveEvents, setLiveEvents] = useState<EventRow[]>([]);
  const [routes, setRoutes] = useState<PatrolRoute[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [seccion, setSeccion] = useState<Seccion>('operacion');
  // Última novedad de un activo llegada por el canal en vivo: DronesView la
  // mezcla en su tabla y así se entera de las altas, bajas, conexiones y
  // renombres hechos desde otra consola o desde la app.
  const [novedadDron, setNovedadDron] = useState<NovedadDron | null>(null);
  // Los status de cada dron llegan a destiempo: se acumulan acá y se vuelcan
  // al estado en un único tick, así todos los marcadores se mueven a la vez.
  const statusBuffer = useRef<Record<string, DroneStatus>>({});

  // El rol de la sesión sirve para pintar la barra sin esperar a /me; el que
  // manda es el que informa el backend, y si difieren la sección se corrige sola.
  const rol = me?.role ?? getRole() ?? 'operator';
  const secciones = SECCIONES[rol];
  const abierta = secciones.includes(seccion) ? seccion : secciones[0];
  const deCampo = rol === 'field_operator';

  useEffect(() => {
    if (deCampo) return;
    const id = setInterval(() => setStatuses({ ...statusBuffer.current }), TICK_MS);
    return () => clearInterval(id);
  }, [deCampo]);

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
        setNovedadDron({ tipo: 'ficha', drone: msg.drone });
        break;
      case 'drone_offline':
        upsertDrone(msg.drone);
        olvidarTelemetria(msg.drone.droneId);
        setNovedadDron({ tipo: 'ficha', drone: msg.drone });
        break;
      case 'drone_updated':
        // El mismo mensaje trae altas, ediciones, bajas y restauraciones. Un
        // activo eliminado sale de la operación, pero igual viaja a la vista de
        // activos, que es la única que sabe si hay que seguir mostrándolo.
        if (msg.drone.deletedAt) {
          setDrones((prev) => prev.filter((d) => d.droneId !== msg.drone.droneId));
          olvidarTelemetria(msg.drone.droneId);
        } else {
          upsertDrone(msg.drone);
        }
        setNovedadDron({ tipo: 'ficha', drone: msg.drone });
        break;
      case 'route_updated':
        setRoutes((prev) => prev.map((r) => (r.id === msg.route.id ? msg.route : r)));
        break;
      case 'control_changed':
        setDrones((prev) =>
          prev.map((d) => (d.droneId === msg.droneId ? { ...d, controlledBy: msg.controlledBy } : d)),
        );
        break;
      case 'drone_renamed':
        setDrones((prev) =>
          prev.map((d) => (d.droneId === msg.droneId ? { ...d, displayName: msg.displayName } : d)),
        );
        // El renombre iniciado desde la app no viene acompañado de `drone_updated`
        setNovedadDron({ tipo: 'renombre', droneId: msg.droneId, displayName: msg.displayName });
        break;
    }
  });

  useEffect(() => {
    api<Me>('/me').then(setMe).catch(console.error);
  }, []);

  // Se recarga al montar y en cada reconexión: mientras el WebSocket estuvo
  // caído pudieron conectarse o desconectarse drones y llegar alertas nuevas.
  // Se espera a saber quién soy porque al operador de campo no hay que pedirle
  // nada de esto: DronesView se trae su propia lista de activos.
  useEffect(() => {
    if (!me || me.role === 'field_operator') return;
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
  }, [connected, me]);

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

  /** Un dron que se fue no tiene nada que seguir dibujando en el tablero. */
  function olvidarTelemetria(droneId: string) {
    delete statusBuffer.current[droneId];
    setFrames((prev) => {
      const next = { ...prev };
      delete next[droneId];
      return next;
    });
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

  const selected = abierta === 'operacion' ? (drones.find((d) => d.droneId === selectedId) ?? null) : null;

  return (
    <div className="dashboard">
      <header className="topbar">
        <h1>Comando Central</h1>
        <nav className="topnav">
          {secciones.map((s) => (
            <button
              key={s}
              className={abierta === s ? 'active' : ''}
              aria-current={abierta === s ? 'page' : undefined}
              onClick={() => setSeccion(s)}
            >
              {ETIQUETA[s]}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {/* El operador de campo entra a una consola recortada: conviene que lo
              lea, y no que lo deduzca de que no hay más botones. */}
          {deCampo && <span className="badge oro">Sesión de campo</span>}
          {/* El punto lo dibuja .estado con currentColor: en la interfaz no hay
              caracteres decorativos, y así el punto toma el verde o el rojo. */}
          <span className={`conn estado versalita ${connected ? 'ok' : 'bad'}`} aria-live="polite">
            {connected ? 'conectado' : 'sin conexión'}
          </span>
          <BotonTema />
          <span className="username">{getUsername()}</span>
          <button className="ghost versalita" onClick={onLogout}>
            Salir
          </button>
        </div>
      </header>
      {!me ? (
        <main className="page-main">
          <p className="vacio">Cargando la consola…</p>
        </main>
      ) : abierta === 'drones' ? (
        <DronesView me={me} novedad={novedadDron} />
      ) : abierta === 'bases' ? (
        me && <BasesView me={me} />
      ) : abierta === 'usuarios' ? (
        <UsersView me={me} />
      ) : abierta === 'registro' ? (
        <LogsView />
      ) : selected ? (
        <DroneDetail
          me={me}
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
