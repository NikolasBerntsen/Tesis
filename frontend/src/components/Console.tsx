import escudo from '../assets/escudo-128.webp';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ErrorDeApi,
  api,
  getRole,
  getUsername,
  marcarEmergenciaRecuperada,
  motivoDelRechazoDeDecision,
  motivoDelRechazoDeRecuperacion,
  traerEmergencia,
  traerEmergenciasAbiertas,
  traerRelevosActivos,
} from '../api';
import {
  aplicarEmergencia,
  esEmergencia,
  esFotoEnVivo,
  reemplazarAbiertas,
  sinFotos,
  sumarFotoEnVivo,
} from '../emergencias';
import { sumarAlRastro, type RastroObjetivo } from '../rastro';
import { crearRecarga } from '../recarga';
import { aplicarRelevo, duenioDeLaAlerta, esRelevo, reemplazarActivos } from '../relevos';
import type {
  Alert,
  Drone,
  DroneStatus,
  Emergencia,
  EventRow,
  FotoDeEmergencia,
  Me,
  NovedadDron,
  PatrolRoute,
  Relevo,
  RolConsola,
} from '../types';
import { useWebSocket } from '../useWebSocket';
import AvisoDeEmergencias from './AvisoDeEmergencias';
import { ProveedorDeAvisos } from './AvisosFlotantes';
import BasesView from './BasesView';
import BotonTema from './BotonTema';
import CampanaDeAlertas from './CampanaDeAlertas';
import { ICONO_DE_SECCION, IconoPersona, IconoSalir } from './Iconos';
import RutasView from './RutasView';
import Dashboard from './Dashboard';
import DroneDetail from './DroneDetail';
import DronesView from './DronesView';
import LogsView from './LogsView';
import ProveedorDeAlertas from './ProveedorDeAlertas';
import ProveedorDeEmergencias from './ProveedorDeEmergencias';
import UsersView from './UsersView';

const MAX_EVENTS = 300;
const TICK_MS = 1000;

type Seccion = 'operacion' | 'drones' | 'bases' | 'rutas' | 'usuarios' | 'registro';

/**
 * Qué secciones ve cada rol, en el orden en que aparecen en la barra. La
 * primera de la lista es la pantalla de trabajo con la que arranca.
 * El operador de campo no tiene tablero a propósito: el backend no le manda
 * telemetría, ni video, ni alertas, ni eventos, así que un tablero le quedaría
 * vacío y cada pedido le volvería con un 403.
 */
const SECCIONES: Record<RolConsola, readonly Seccion[]> = {
  field_operator: ['drones', 'bases', 'rutas'],
  // El operador ve el inventario y las bases para ubicarse, pero no los edita.
  operator: ['operacion', 'drones', 'bases', 'rutas'],
  supervisor: ['operacion', 'drones', 'bases', 'rutas', 'usuarios'],
  admin: ['operacion', 'drones', 'bases', 'rutas', 'usuarios', 'registro'],
};

/** "Operación" es la flota en vivo; "Drones" es el registro de activos. */
const ETIQUETA: Record<Seccion, string> = {
  operacion: 'Operación',
  drones: 'Drones',
  bases: 'Bases',
  rutas: 'Rutas',
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
  // El rastro del objetivo de cada dron se arma acá, con la posición que trae
  // cada status: la app manda sólo la estimación del momento (ver rastro.ts).
  // Se acumula al ritmo de los mensajes y se vuelca en el mismo tick que los
  // status, para que la línea y el marcador del objetivo avancen juntos.
  const rastrosBuffer = useRef<Record<string, RastroObjetivo>>({});
  const [rastros, setRastros] = useState<Record<string, RastroObjetivo>>({});
  // Los relevos y las emergencias no llegan solos al conectarse: se piden por
  // REST al montar y en cada reconexión, y de ahí en más los mantiene el
  // WebSocket (§3 del contrato).
  const [relevos, setRelevos] = useState<Relevo[]>([]);
  const [emergencias, setEmergencias] = useState<Emergencia[]>([]);
  // Las fotos de cada emergencia que llegan en vivo. Las anteriores las trae
  // la ficha al abrirse: guardarlas todas acá sería cargar imágenes que nadie
  // pidió.
  const [fotosDeEmergencias, setFotosDeEmergencias] = useState<Record<number, FotoDeEmergencia[]>>({});
  // Lo que trae el WebSocket mientras vuelve cada uno de esos pedidos, y cuál
  // es el último: la respuesta no puede borrar lo que llegó en vivo después de
  // que el hub la armó, ni pisarla la de un pedido anterior (ver recarga.ts).
  const [recargaDeRelevos] = useState(crearRecarga);
  const [recargaDeEmergencias] = useState(crearRecarga);

  // El rol de la sesión sirve para pintar la barra sin esperar a /me; el que
  // manda es el que informa el backend, y si difieren la sección se corrige sola.
  const rol = me?.role ?? getRole() ?? 'operator';
  const secciones = SECCIONES[rol];
  const abierta = secciones.includes(seccion) ? seccion : secciones[0];
  const deCampo = rol === 'field_operator';

  useEffect(() => {
    if (deCampo) return;
    const id = setInterval(() => {
      setStatuses({ ...statusBuffer.current });
      setRastros({ ...rastrosBuffer.current });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [deCampo]);

  const { conectado, enviar } = useWebSocket((msg) => {
    switch (msg.type) {
      case 'status':
        statusBuffer.current[msg.droneId] = msg;
        acumularRastro(msg.droneId, msg.target);
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
        if (msg.drone.deleted) {
          setDrones((prev) => prev.filter((d) => d.droneId !== msg.drone.droneId));
          olvidarTelemetria(msg.drone.droneId);
        } else {
          upsertDrone(msg.drone);
        }
        setNovedadDron({ tipo: 'ficha', drone: msg.drone });
        break;
      case 'base_updated':
        // Mover o renombrar una base cambia la ficha de todos los drones que la
        // tienen asignada. Sin esto la tarjeta y el marcador del mapa seguían
        // mostrando la base vieja hasta recargar la consola entera.
        setDrones((prev) =>
          prev.map((d) =>
            d.baseId === msg.base.id
              ? { ...d, base: { name: msg.base.name, lat: msg.base.lat, lon: msg.base.lon } }
              : d,
          ),
        );
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
      // Las filas ya las validó el hub (§3 del contrato): la consola las toma por
      // id. Lo único que se mira es que tengan forma, para que un mensaje roto
      // no tumbe la consola entera.
      case 'relay_updated':
        if (esRelevo(msg.relay)) {
          recargaDeRelevos.anotar(msg.relay.id);
          setRelevos((prev) => aplicarRelevo(prev, msg.relay));
        }
        break;
      case 'emergency_updated':
        if (esEmergencia(msg.emergencia)) {
          recargaDeEmergencias.anotar(msg.emergencia.id);
          setEmergencias((prev) => aplicarEmergencia(prev, msg.emergencia));
        }
        break;
      case 'emergency_photo':
        if (esFotoEnVivo(msg)) setFotosDeEmergencias((prev) => sumarFotoEnVivo(prev, msg));
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
        // El rastro que se haya juntado no se tira al reconectar: el objetivo
        // es el mismo y la trayectoria sigue siendo la que el operador miraba.
        for (const d of list) acumularRastro(d.droneId, d.lastStatus?.target);
      })
      .catch(console.error);
    api<Alert[]>('/alerts').then(setAlerts).catch(console.error);
    api<PatrolRoute[]>('/routes').then(setRoutes).catch(console.error);
  }, [conectado, me]);

  // Como los drones: al montar y en cada reconexión, porque mientras el canal
  // estuvo caído un relevo pudo terminar o un dron pudo bajar de emergencia.
  // Las emergencias le llegan también al operador de campo: es quien sale a
  // buscar el dron. Los relevos no: el backend no se los muestra.
  useEffect(() => {
    if (!me) return;
    void recargaDeEmergencias
      .recargar(traerEmergenciasAbiertas, (lista, vistas) =>
        setEmergencias((prev) => reemplazarAbiertas(prev, lista, vistas)),
      )
      .catch(console.error);
    if (me.role === 'field_operator') return;
    void recargaDeRelevos
      .recargar(traerRelevosActivos, (lista, vistos) => setRelevos((prev) => reemplazarActivos(prev, lista, vistos)))
      .catch(console.error);
  }, [conectado, me, recargaDeEmergencias, recargaDeRelevos]);

  /**
   * Cierra una emergencia. La respuesta se aplica en el acto (el
   * `emergency_updated` llega igual, pero no hay por qué esperarlo). Si otra
   * persona ya la había cerrado, la ficha se trae de nuevo para que deje de
   * ofrecer el botón, y el motivo sube a quien lo mostró.
   */
  const marcarRecuperada = useCallback(async (id: number): Promise<Emergencia> => {
    try {
      const recuperada = await marcarEmergenciaRecuperada(id);
      setEmergencias((prev) => aplicarEmergencia(prev, recuperada));
      return recuperada;
    } catch (err) {
      if (err instanceof ErrorDeApi && err.status === 409) {
        void traerEmergencia(id)
          .then((e) => setEmergencias((prev) => aplicarEmergencia(prev, sinFotos(e))))
          .catch(console.error);
      }
      throw new Error(motivoDelRechazoDeRecuperacion(err));
    }
  }, []);

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

  function acumularRastro(droneId: string, objetivo: DroneStatus['target']) {
    const rastro = sumarAlRastro(rastrosBuffer.current[droneId], objetivo);
    if (rastro) rastrosBuffer.current[droneId] = rastro;
    else delete rastrosBuffer.current[droneId];
  }

  /** Un dron que se fue no tiene nada que seguir dibujando en el tablero. */
  function olvidarTelemetria(droneId: string) {
    delete statusBuffer.current[droneId];
    delete rastrosBuffer.current[droneId];
    setFrames((prev) => {
      const next = { ...prev };
      delete next[droneId];
      return next;
    });
  }

  /**
   * Decide una alerta. Si el backend la rechaza, el error SUBE con el motivo ya
   * dicho para el operador: lo muestra el que tiene el botón (la campana, la
   * tarjeta de la vista del dron o el pop-up de la alerta), que es donde el
   * operador está mirando. Tragárselo acá era dejar al operador creyendo que
   * había decidido. Estable (useCallback) porque viaja en el contexto de las
   * alertas, y una función nueva por render despertaría a todos sus lectores.
   */
  const decidirAlerta = useCallback(async (id: number, decision: 'VALIDATED' | 'DISMISSED'): Promise<void> => {
    try {
      await api(`/alerts/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
    } catch (err) {
      throw new Error(motivoDelRechazoDeDecision(err));
    }
  }, []);

  /** Lleva a la vista de un dron, donde está su video en vivo, desde cualquier sección. */
  const verDron = useCallback((droneId: string) => {
    setSeccion('operacion');
    setSelectedId(droneId);
  }, []);

  async function rename(droneId: string, displayName: string) {
    try {
      upsertDrone(await api<Drone>(`/drones/${droneId}`, { method: 'PATCH', body: JSON.stringify({ displayName }) }));
    } catch (err) {
      console.error(err);
    }
  }

  // Cada pendiente cuenta para el dron que sigue al objetivo AHORA: después de
  // un relevo es en ese dron donde se mira el video y se decide.
  const pendingAlerts = useMemo(() => {
    const count: Record<string, number> = {};
    for (const a of alerts) {
      const duenio = duenioDeLaAlerta(a);
      if (a.status === 'PENDING' && duenio) count[duenio] = (count[duenio] ?? 0) + 1;
    }
    return count;
  }, [alerts]);

  const selected = abierta === 'operacion' ? (drones.find((d) => d.droneId === selectedId) ?? null) : null;
  const usuario = getUsername();

  return (
    // Los avisos de "guardado" viven acá, una sola región para toda la consola:
    // cambiar de sección no los corta ni los duplica.
    <ProveedorDeAvisos>
      {/* Lo que el pop-up de una alerta lee en vivo, abierto desde donde sea.
          El operador de campo no recibe alertas ni puede decidirlas. */}
      <ProveedorDeAlertas
        alertas={alerts}
        drones={drones}
        statuses={statuses}
        decidir={deCampo ? null : decidirAlerta}
        verDron={deCampo ? null : verDron}
      >
        {/* Las emergencias sí son del operador de campo: es quien sale a
            buscar el dron, y quien lo marca recuperado. */}
        <ProveedorDeEmergencias
          relevos={relevos}
          emergencias={emergencias}
          fotos={fotosDeEmergencias}
          marcarRecuperada={marcarRecuperada}
        >
          <div className="dashboard">
            <header className="topbar">
              <div className="marca">
                {/* El escudo es decorativo: el nombre del proyecto ya lo dice el texto. */}
                <img className="marca-escudo" src={escudo} alt="" />
                <div className="marca-textos">
                  {/* Escrito como se dice, que es lo que anuncia el lector de
                      pantalla: las mayúsculas y los colores los pone la hoja. */}
                  <h1 className="marca-nombre">
                    Alta <span className="marca-en">en el</span> <span className="marca-cielo">Cielo</span>
                  </h1>
                  <p className="marca-lema">Comando de drones</p>
                </div>
              </div>
              <nav className="topnav" aria-label="Secciones de la consola">
                {secciones.map((s) => {
                  const Icono = ICONO_DE_SECCION[s];
                  return (
                    <button
                      key={s}
                      type="button"
                      className={abierta === s ? 'active' : ''}
                      aria-current={abierta === s ? 'page' : undefined}
                      onClick={() => setSeccion(s)}
                    >
                      <Icono />
                      <span>{ETIQUETA[s]}</span>
                    </button>
                  );
                })}
              </nav>
              <div className="topbar-right">
                {/* El operador de campo entra a una consola recortada: conviene que lo
                    lea, y no que lo deduzca de que no hay más botones. */}
                {deCampo && <span className="badge oro">Sesión de campo</span>}
                {/* El operador de campo no recibe alertas: el backend no se las manda. */}
                {!deCampo && (
                  <CampanaDeAlertas
                    alerts={alerts}
                    drones={drones}
                    onDecidir={decidirAlerta}
                    onVerDron={verDron}
                  />
                )}
                {/* El punto lo dibuja .estado con currentColor: en la interfaz no hay
                    caracteres decorativos, y así el punto toma el verde o el rojo. */}
                <span className={`conn estado versalita ${conectado ? 'ok' : 'bad'}`} aria-live="polite">
                  {conectado ? 'conectado' : 'sin conexión'}
                </span>
                <BotonTema />
                {/* En una tableta el nombre se recorta con puntos suspensivos: el
                    title lo deja leer entero. La sesión no lleva menú: una silueta
                    y no un engranaje, que se lee como "configuración" y el
                    operador lo tocaría esperando algo. */}
                <span className="sesion-usuario">
                  <IconoPersona tamano={20} />
                  <span className="username" title={usuario}>
                    {usuario}
                  </span>
                </span>
                <button type="button" className="ghost salir" onClick={onLogout}>
                  <IconoSalir tamano={20} />
                  Salir
                </button>
              </div>
            </header>
            <AvisoDeEmergencias />
            {!me ? (
              <main className="page-main">
                <p className="vacio" role="status">
                  Cargando la consola…
                </p>
              </main>
            ) : abierta === 'drones' ? (
              <DronesView me={me} novedad={novedadDron} />
            ) : abierta === 'bases' ? (
              <BasesView me={me} />
            ) : abierta === 'rutas' ? (
              <RutasView me={me} />
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
                conectado={conectado}
                liveEvents={liveEvents}
                routes={routes}
                alertas={alerts}
                relevos={relevos}
                rastro={rastros[selected.droneId] ?? null}
                onDecidir={decidirAlerta}
                onBack={() => setSelectedId(null)}
                onRename={(name) => rename(selected.droneId, name)}
                onWaypointLabel={setWaypointLabel}
                onMando={(ejes) => enviar({ type: 'manual_stick', droneId: selected.droneId, ...ejes })}
                onCamara={(pitch) => enviar({ type: 'manual_gimbal', droneId: selected.droneId, pitch })}
              />
            ) : (
              <Dashboard
                drones={drones}
                statuses={statuses}
                frames={frames}
                alerts={alerts}
                pendingAlerts={pendingAlerts}
                relevos={relevos}
                rastros={rastros}
                onDecidir={decidirAlerta}
                onOpenDrone={setSelectedId}
                onRename={rename}
              />
            )}
          </div>
        </ProveedorDeEmergencias>
      </ProveedorDeAlertas>
    </ProveedorDeAvisos>
  );
}
