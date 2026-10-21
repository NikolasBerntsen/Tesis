import { useEffect, useId, useMemo, useState } from 'react';
import { api, rutasDeBase } from '../api';
import { posicionDelDron, stateLabel } from '../format';
import type { RastroObjetivo } from '../rastro';
import type { Alert, Drone, DroneStatus, EventRow, Me, PatrolRoute } from '../types';
import type { DecidirAlerta } from '../useDecisionDeAlerta';
import AlertaEnCurso from './AlertaEnCurso';
import DroneStatusCard from './DroneStatusCard';
import DronesMap, { type MapItem, type WaypointsLayer } from './DronesMap';
import EditableName from './EditableName';
import EventLog from './EventLog';
import LiveVideo from './LiveVideo';
import MandoVirtual, { type Ejes } from './MandoVirtual';
import Modal from './Modal';
import PanelObjetivo from './PanelObjetivo';

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

/** Despegar o aterrizar: las dos órdenes de vuelo que piden confirmación. */
type OrdenDeVuelo = 'despegar' | 'aterrizar';

/**
 * Lo que dice el diálogo antes de cada orden. Son las dos únicas órdenes de la
 * consola que mueven el dron en vertical sin que el operador lo esté guiando,
 * y las dos tienen algo que revisar en el terreno antes de darlas.
 */
const CONFIRMACION: Record<OrdenDeVuelo, { titulo: string; texto: string; aviso: string; boton: string }> = {
  despegar: {
    titulo: 'Despegar',
    texto: 'El dron despega en el lugar y queda suspendido a ~1,2 m; funciona sin GPS.',
    aviso: 'Revisá que no haya nadie ni nada encima ni alrededor del dron antes de confirmar.',
    boton: 'Despegar',
  },
  aterrizar: {
    titulo: 'Aterrizar',
    texto: 'El dron baja y aterriza donde está ahora. El control manual sigue tomado: después lo podés volver a despegar.',
    aviso: 'Revisá que abajo del dron no haya gente, agua ni obstáculos.',
    boton: 'Aterrizar',
  },
};

export default function DroneDetail({
  me,
  drone,
  status,
  frame,
  conectado,
  liveEvents,
  routes,
  alertas,
  rastro = null,
  onDecidir,
  onBack,
  onRename,
  onWaypointLabel,
  onMando,
}: {
  me: Me | null;
  drone: Drone;
  status: DroneStatus | null;
  frame: string | null;
  /** Si el canal con el Comando Central está vivo: sin él el mando no sale. */
  conectado: boolean;
  liveEvents: EventRow[];
  routes: PatrolRoute[];
  /** Las alertas de la consola: de acá sale la pendiente de este dron. */
  alertas: Alert[];
  /** Rastro del objetivo que el dron está siguiendo, si hay uno (rastro.ts). */
  rastro?: RastroObjetivo | null;
  onDecidir: DecidirAlerta;
  onBack: () => void;
  onRename: (displayName: string) => void;
  onWaypointLabel: (routeId: number, index: number, label: string) => void;
  /**
   * Ejes del mando virtual, que salen por el WebSocket y no por REST. Devuelve
   * si el mensaje llegó a salir: con el socket cerrado no sale, y eso el
   * operador lo tiene que ver.
   */
  onMando: (ejes: Ejes) => boolean;
}) {
  const [history, setHistory] = useState<EventRow[]>([]);
  const [error, setError] = useState('');
  const [rutaElegida, setRutaElegida] = useState<number | ''>('');
  // Ids de las rutas que la base de este dron tiene habilitadas. `null` mientras
  // no llegaron: no es lo mismo que "la base no tiene ninguna".
  const [idsDeLaBase, setIdsDeLaBase] = useState<number[] | null>(null);
  /** La orden de vuelo que espera confirmación en el diálogo. */
  const [aConfirmar, setAConfirmar] = useState<OrdenDeVuelo | null>(null);
  /**
   * La orden que el backend ya aceptó y el dron todavía no cumplió. El backend
   * contesta en el acto, pero el dron recién informa que despegó cuando está
   * en el aire: mientras tanto el mando sigue inerte, y sin este aviso el
   * operador cree que el botón no anduvo y lo vuelve a apretar.
   */
  const [ordenEnCurso, setOrdenEnCurso] = useState<OrdenDeVuelo | null>(null);
  const idTitulo = useId();
  const idTexto = useId();

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
    () => [
      {
        droneId: drone.droneId,
        displayName: drone.displayName,
        base: drone.base,
        status,
        rastroObjetivo: rastro?.puntos,
      },
    ],
    [drone.droneId, drone.displayName, drone.base, status, rastro],
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

  /** El objetivo que el dron orbita o sigue, con lo último que estimó la app. */
  const objetivo = status?.target ?? null;
  // `flying` lo manda la app nueva siempre; una vieja no, y ahí no se afirma
  // ni lo uno ni lo otro: ni se ofrece despegar ni se bloquea el mando.
  const enElSuelo = status?.flying === false;
  const enElAire = status?.flying === true;
  const sinGps = !!status && posicionDelDron(status) === null;

  // La alerta que se decide al lado del video: la pendiente más nueva de ESTE
  // dron. Los ids crecen con cada alerta, así que la más nueva es la de id más
  // alto, llegue en el orden que llegue la lista.
  const pendientes = useMemo(
    () =>
      alertas
        .filter((a) => a.drone_id === drone.droneId && a.status === 'PENDING')
        .sort((a, b) => b.id - a.id),
    [alertas, drone.droneId],
  );
  const alertaEnCurso = pendientes[0] ?? null;

  // El aviso de "orden en curso" se va solo cuando el dron confirma: en el aire
  // para el despegue, en el suelo para el aterrizaje. También si se suelta el
  // control, porque la orden deja de ser de este operador.
  useEffect(() => {
    if (ordenEnCurso === 'despegar' && enElAire) setOrdenEnCurso(null);
    if (ordenEnCurso === 'aterrizar' && enElSuelo) setOrdenEnCurso(null);
  }, [ordenEnCurso, enElAire, enElSuelo]);
  useEffect(() => {
    if (!soyControlador) setOrdenEnCurso(null);
  }, [soyControlador]);

  /**
   * El estado que el dron reportó DESPUÉS de que se tomó el control, o `null`
   * mientras no llegó ninguno. Esa distinción es la que hace falta para decidir
   * si el mando puede comandar: el Comando Central le estampa a cada `status`
   * que reenvía el dueño del lock de ese momento (`controlledBy` en ws.ts), así
   * que un status que no trae al controlador es de ANTES del `control_changed` y
   * no dice absolutamente nada sobre si la app ya entró en vuelo manual.
   *
   * Mirar `status.state` en seco dejaba el mando inerte en el camino más normal
   * que hay: el lock se ve al instante (el backend lo broadcastea en el acto),
   * pero el estado tarda hasta un segundo de la app (`statusTicker` manda cada
   * 1 s y no empuja nada al cambiar de estado) más otro del volcado de la
   * consola. En esa ventana el operador agarraba la palanca, no salía un solo
   * `manual_stick` y encima la pantalla le decía que el dron no estaba en manual.
   */
  const estadoConfirmado = status && controlador && status.controlledBy === controlador ? status.state : null;

  /**
   * Por qué el mando de vuelo continuo no puede comandar, o `null` si puede.
   * Tener el control tomado no alcanza: si el dron se cayó del aire, si el
   * socket de la consola está reconectando o si el dron ya confirmó un estado
   * que NO es `MANUAL` —la app descarta los ejes en cualquier otro estado—, lo
   * que el operador empuja no llega o el dron lo tira. Y el backend NO suelta el
   * lock por eso: la app se puede ir sola a volver a base por batería con el
   * control tomado, así que el único que puede avisar es la consola.
   *
   * El suelo es el último motivo y no espera confirmación: `flying` es un dato
   * físico, no del estado, así que vale también en el status de antes de tomar
   * el control. En el suelo la app descarta las palancas EN SILENCIO (el
   * Virtual Stick no despega, y subir el acelerador a fondo tampoco), y antes la
   * consola dejaba mover las perillas sin que el dron hiciera nada. Para eso
   * está el botón "Despegar".
   *
   * Lo que NO es impedimento es la espera de esa confirmación: ahí el mando
   * emite (los ejes que lleguen antes de tiempo la app los descarta sola, que es
   * mucho más barato que tragarse el gesto del operador) y se avisa aparte.
   */
  const impedimentoDelMando = !drone.online
    ? 'El dron está desconectado: el mando no responde.'
    : !conectado
      ? 'Sin conexión con el Comando Central: el mando no responde.'
      : estadoConfirmado !== null && estadoConfirmado !== 'MANUAL'
        ? `El dron no está en vuelo manual (${stateLabel(estadoConfirmado)}): el mando no responde.`
        : enElSuelo
          ? 'El dron está en el suelo: despegalo para usar el mando.'
          : null;

  /** Control tomado y el dron todavía sin decir en qué estado quedó. */
  const esperandoConfirmacion = impedimentoDelMando === null && estadoConfirmado === null;

  /**
   * Por qué las flechas no pueden mover el dron, o `null` si pueden. El salto
   * de 25 m se calcula desde la posición del dron, así que sin GPS no hay
   * destino (y con el 0,0 que entrega el SDK sin fix, el destino quedaba en
   * Null Island y el dron volaba hacia allá). La app lo rechaza igual; acá se
   * dice antes, en vez de un click que no hace nada.
   */
  const impedimentoDelPad = !drone.online
    ? 'El dron está desconectado: las flechas no responden.'
    : enElSuelo
      ? 'El dron está en el suelo: despegalo para usar las flechas.'
      : sinGps
        ? 'Sin GPS: el salto de 25 m se calcula desde la posición del dron, y el dron no la sabe. El vuelo continuo sí funciona.'
        : null;

  /** Devuelve si el backend aceptó el pedido; si no, deja el motivo a la vista. */
  async function llamar(path: string, options: RequestInit = {}): Promise<boolean> {
    setError('');
    try {
      await api(path, options);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  // "Retomar ruta": vuelve al patrullaje hacia el próximo nodo de la ruta
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
  /**
   * Soltar el control. Con un objetivo cargado, `'none'` hace que el dron
   * vuelva a él (§2 `control_released`); `'last'` además lo manda a patrullar,
   * que es dejar el objetivo. Antes se mandaba siempre `'last'`, y soltar el
   * control con una alerta validada sacaba al dron de encima del objetivo.
   */
  const soltarControl = (resume: 'none' | 'last') =>
    llamar(`/drones/${drone.droneId}/control`, { method: 'DELETE', body: JSON.stringify({ resume }) });
  // Supervisor: mismo endpoint, el backend registra que fue forzado. Con
  // objetivo, el dron vuelve a él: quitarle el control a alguien no es decidir
  // que el objetivo deja de importar.
  const quitarControl = () => soltarControl(objetivo ? 'none' : 'last');
  const mover = (bearing: number) => () =>
    llamar(`/drones/${drone.droneId}/manual_move`, { method: 'POST', body: JSON.stringify({ bearing, distanceM: 25 }) });

  async function confirmarOrden(orden: OrdenDeVuelo) {
    setAConfirmar(null);
    const ruta = orden === 'despegar' ? 'takeoff' : 'land';
    if (await llamar(`/drones/${drone.droneId}/${ruta}`, { method: 'POST' })) setOrdenEnCurso(orden);
  }

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

  const confirmacion = aConfirmar ? CONFIRMACION[aConfirmar] : null;

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
        {/* Conectado no es lo mismo que volando: con el dron apoyado esto
            decía "En vuelo", y el operador agarraba un mando que no podía
            mover nada. */}
        <span className={`estado ${drone.online ? 'ok' : 'muted'}`}>
          {!drone.online ? 'Desconectado' : enElSuelo ? 'En tierra' : 'En vuelo'}
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
      <DroneStatusCard status={status} base={drone.base} controlTomado={!!controlador} onResumePatrol={retomar} />

      {/* Video y ubicación cruzan toda la pantalla: son las dos ventanas de lo
          que está pasando y se miran juntas. Con una alerta pendiente se mete
          la captura ENTRE las dos, pegada al video: decidir es comparar lo que
          vio la detección con lo que el dron está viendo ahora. */}
      <div className={alertaEnCurso ? 'par-video-mapa con-alerta' : 'par-video-mapa'}>
        <LiveVideo frame={frame} />
        {alertaEnCurso && (
          <AlertaEnCurso
            alerta={alertaEnCurso}
            otrasPendientes={pendientes.length - 1}
            siguiendo={objetivo?.alertId === alertaEnCurso.id}
            onDecidir={onDecidir}
          />
        )}
        <div className="card">
          <div className="mapa-head">
            <h2>Ubicación</h2>
            <button
              onClick={retomar}
              disabled={!drone.online || !interrumpido}
              title={
                objetivo
                  ? 'Deja el objetivo y vuelve al patrullaje, hacia el próximo nodo de la ruta'
                  : 'Vuelve al patrullaje, hacia el próximo nodo de la ruta'
              }
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
            {objetivo && (
              <span className={`estado ${objetivo.decision === 'VALIDATED' ? 'accent' : 'bad'}`}>
                Objetivo y su rastro
              </span>
            )}
          </div>
          {/* El mapa no dibuja un dron sin posición: sin esta línea, el
              operador vería la base sola y pensaría que el dron se fue. */}
          {sinGps && (
            <p className="muted" data-testid="mapa-sin-gps">
              El dron no informa posición (sin GPS): no se lo dibuja en el mapa.
            </p>
          )}
        </div>
      </div>

      <div className="grid-operacion">
        {objetivo && <PanelObjetivo objetivo={objetivo} />}

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
                {/* Despegar y aterrizar van primero: con el dron en el suelo es
                    lo único que se puede hacer, y es lo que habilita el resto. */}
                {(enElSuelo || enElAire) && (
                  <>
                    <h3>{enElSuelo ? 'En el suelo' : 'En el aire'}</h3>
                    {enElSuelo ? (
                      <button className="primario" onClick={() => setAConfirmar('despegar')} disabled={!drone.online}>
                        Despegar
                      </button>
                    ) : (
                      <button className="dismiss" onClick={() => setAConfirmar('aterrizar')} disabled={!drone.online}>
                        Aterrizar
                      </button>
                    )}
                    {ordenEnCurso && (
                      <p className="aviso" role="status" data-testid="orden-en-curso">
                        {ordenEnCurso === 'despegar'
                          ? 'Despegue ordenado: el mando se habilita apenas el dron informe que está en el aire. Si no despega, el motivo queda en el registro de eventos.'
                          : 'Aterrizaje ordenado: el dron baja donde está. El control sigue tomado.'}
                      </p>
                    )}
                    <hr className="regla" />
                  </>
                )}

                <h3>Desplazamiento puntual</h3>
                {/* Plato hundido: el pad es la pieza más táctil de la consola
                    y tiene que leerse como un instrumento grabado en la piedra */}
                <div className="pad-plato">
                  <div className="pad">
                    <button title="Norte" aria-label="Mover al norte" onClick={mover(0)} disabled={!!impedimentoDelPad}>
                      <Flecha rumbo={0} />
                    </button>
                    <div>
                      <button title="Oeste" aria-label="Mover al oeste" onClick={mover(270)} disabled={!!impedimentoDelPad}>
                        <Flecha rumbo={270} />
                      </button>
                      <button title="Este" aria-label="Mover al este" onClick={mover(90)} disabled={!!impedimentoDelPad}>
                        <Flecha rumbo={90} />
                      </button>
                    </div>
                    <button title="Sur" aria-label="Mover al sur" onClick={mover(180)} disabled={!!impedimentoDelPad}>
                      <Flecha rumbo={180} />
                    </button>
                  </div>
                </div>
                {impedimentoDelPad && (
                  <p className="aviso" role="status" data-testid="pad-impedimento">
                    {impedimentoDelPad}
                  </p>
                )}
                <p className="muted">
                  Cada toque desplaza el dron 25 m en esa dirección: es un salto puntual, el dron lo
                  recorre y se queda ahí.
                </p>

                {/* Las dos formas de comandar conviven y no hacen lo mismo: el
                    pad de arriba manda UN desplazamiento de 25 m; el mando de
                    acá abajo es vuelo continuo, el dron se mueve mientras la
                    palanca esté sostenida. Van separadas por la regla para que
                    no se lean como un solo bloque de botones. */}
                <hr className="regla" />
                <h3>Vuelo continuo</h3>
                {/* Recién tomado el control esto se ve alrededor de un segundo,
                    con el mando VIVO: explica por qué la tarjeta de estado de
                    arriba todavía dice "Patrullando" mientras el operador ya
                    está comandando. */}
                {esperandoConfirmacion && (
                  <p className="aviso" role="status" data-testid="mando-esperando">
                    El dron todavía no confirmó el vuelo manual (su telemetría llega cada ~1 s): el
                    mando ya emite, pero hasta la confirmación puede descartar los ejes.
                  </p>
                )}
                <MandoVirtual onMando={onMando} impedimento={impedimentoDelMando} />

                {/* Con un objetivo cargado hay dos formas de soltar, y la que
                    va primero es la que no pierde nada: el dron vuelve a
                    orbitarlo o a seguirlo. Mandarlo a patrullar es dejar el
                    objetivo, y eso tiene que ser una decisión explícita. */}
                {objetivo ? (
                  <>
                    <button className="resume" onClick={() => soltarControl('none')}>
                      Soltar control (el dron vuelve al objetivo)
                    </button>
                    <button className="ghost soltar-y-patrullar" onClick={() => soltarControl('last')}>
                      Soltar y reanudar patrullaje
                    </button>
                  </>
                ) : (
                  <button className="resume" onClick={() => soltarControl('last')}>
                    Devolver al patrullaje
                  </button>
                )}
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

      {/* La alerta de este dron se decide arriba, al lado del video; la
          campana del encabezado sigue avisando desde cualquier vista. */}
      <EventLog events={events} />

      {aConfirmar && confirmacion && (
        <Modal etiquetadoPor={idTitulo} descritoPor={idTexto} onCerrar={() => setAConfirmar(null)}>
          <header className="modal-cabecera">
            <h2 className="modal-titulo" id={idTitulo}>
              {confirmacion.titulo} {drone.displayName}
            </h2>
          </header>
          <div className="modal-cuerpo">
            <p id={idTexto}>{confirmacion.texto}</p>
            <p className="muted">{confirmacion.aviso}</p>
          </div>
          <footer className="modal-pie">
            <button type="button" className="ghost" onClick={() => setAConfirmar(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className={aConfirmar === 'despegar' ? 'primario' : 'dismiss'}
              onClick={() => confirmarOrden(aConfirmar)}
            >
              {confirmacion.boton}
            </button>
          </footer>
        </Modal>
      )}
    </main>
  );
}
