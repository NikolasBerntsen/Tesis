import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, pedirControl, rutasDeBase } from '../api';
import { PLAZO_DE_RESPUESTA_MS, type PedidoDeControl } from '../control';
import { posicionDelDron, stateLabel } from '../format';
import type { RastroObjetivo } from '../rastro';
import { avisoDeOrdenesEnRelevo, avisoDeReanudarEnRelevo, duenioDeLaAlerta, participaDeUnRelevo } from '../relevos';
import type { Alert, Drone, DroneStatus, EventRow, Me, PatrolRoute, Relevo } from '../types';
import type { DecidirAlerta } from '../useDecisionDeAlerta';
import AlertaEnCurso from './AlertaEnCurso';
import { useAvisar } from './AvisosFlotantes';
import DialogoConfirmacion from './DialogoConfirmacion';
import DroneStatusCard from './DroneStatusCard';
import DronesMap, { type MapItem, type WaypointsLayer } from './DronesMap';
import EditableName from './EditableName';
import HistorialDeEventos from './HistorialDeEventos';
import {
  IconoAterrizar,
  IconoDespegar,
  IconoHistorial,
  IconoMando,
  IconoOperacion,
  IconoPausa,
  IconoReanudar,
  IconoRutas,
  IconoUbicacion,
  IconoVolver,
} from './Iconos';
import InsigniasDeRelevo from './InsigniasDeRelevo';
import LiveVideo from './LiveVideo';
import type { Ejes } from './MandoVirtual';
import PanelObjetivo from './PanelObjetivo';
import PilotajePantallaCompleta from './PilotajePantallaCompleta';

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

/**
 * La cabecera de la vista, como la de las demás (EncabezadoDeVista): el nombre
 * del dron es el título, en Cormorant con su barra de oro, y se renombra ahí
 * mismo; debajo, su modelo en versalitas. Arriba, el camino de vuelta; a la
 * derecha, si está en el aire, quién tiene el control y el historial.
 */
function CabeceraDelDron({
  drone,
  status,
  relevos,
  enElSuelo,
  controlador,
  onBack,
  onRename,
  onHistorial,
}: Readonly<{
  drone: Drone;
  status: DroneStatus | null;
  /** Los relevos que conoce la consola: de acá salen las insignias del dron. */
  relevos: readonly Relevo[];
  enElSuelo: boolean;
  controlador: string | null;
  onBack: () => void;
  onRename: (displayName: string) => void;
  onHistorial: () => void;
}>) {
  // Conectado no es lo mismo que volando: con el dron apoyado esto decía "En
  // vuelo", y el operador agarraba un mando que no podía mover nada.
  let estado = 'En vuelo';
  if (!drone.online) estado = 'Desconectado';
  else if (enElSuelo) estado = 'En tierra';

  return (
    <header className="detail-head">
      <div className="detail-titulos">
        <button type="button" className="enlace versal detalle-volver" onClick={onBack}>
          <IconoVolver tamano={16} />
          Volver a Operación
        </button>
        {/* Enfocable sólo desde el código, como el título de las otras vistas
            (EncabezadoDeVista): adonde vuelve el foco si el carrusel de
            alertas se fue mientras su pop-up estaba abierto. */}
        <h2 className="vista-titulo" tabIndex={-1}>
          <EditableName name={drone.displayName} onRename={onRename} />
        </h2>
        {drone.model && <p className="vista-subtitulo">{drone.model}</p>}
      </div>
      <span className={`estado pastilla ${drone.online ? 'ok' : 'muted'}`}>{estado}</span>
      {controlador && <span className="badge oro">Control manual: {controlador}</span>}
      <InsigniasDeRelevo droneId={drone.droneId} status={status} relevos={relevos} />
      {/* Arriba a la derecha, sobre la telemetría: el historial es consulta,
          no algo que se mira todo el tiempo, y al pie de la vista quedaba
          debajo de todo, donde en pleno vuelo nadie llegaba. */}
      <button type="button" className="detalle-historial" onClick={onHistorial}>
        <IconoHistorial tamano={18} />
        Ver historial de eventos
      </button>
    </header>
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

/**
 * Lo que se avisa mientras el dron no cumplió la orden que el backend ya
 * aceptó. Se lee igual en la tarjeta y en el HUD de la vista de pilotaje.
 */
const ORDEN_EN_CURSO: Record<OrdenDeVuelo, string> = {
  despegar:
    'Despegue ordenado: el mando se habilita apenas el dron informe que está en el aire. Si no despega, el motivo queda en el registro de eventos.',
  aterrizar: 'Aterrizaje ordenado: el dron baja donde está. El control sigue tomado.',
};

const SIN_RELEVOS: readonly Relevo[] = [];

/**
 * Lo que hace el dron cuando se lo suelta sin darle una orden (`'none'`): con
 * objetivo vuelve a él, y en un relevo sigue con el relevo (RELEVOS §3.9).
 * Sin ninguna de las dos se suelta con `'last'` y vuelve a su ruta.
 */
function queHaceAlSoltarSinOrden(conObjetivo: boolean, enRelevo: boolean): string {
  if (enRelevo) {
    return conObjetivo ? 'vuelve al objetivo que estaba siguiendo, y el relevo sigue en marcha' : 'sigue con el relevo';
  }
  return conObjetivo ? 'vuelve al objetivo que estaba siguiendo' : 'vuelve a patrullar su ruta';
}

/** El botón de soltar que no pierde nada: dice a qué vuelve el dron. */
function etiquetaDeSoltarSinOrden(conObjetivo: boolean, enRelevo: boolean): string {
  if (!enRelevo) return 'Soltar control (el dron vuelve al objetivo)';
  return conObjetivo ? 'Soltar control (vuelve al objetivo, sigue el relevo)' : 'Soltar control (sigue el relevo)';
}

export default function DroneDetail({
  me,
  drone,
  status,
  frame,
  conectado,
  liveEvents,
  routes,
  alertas,
  relevos = SIN_RELEVOS,
  rastro = null,
  pedidoDeControl = null,
  onDecidir,
  onBack,
  onRename,
  onWaypointLabel,
  onMando,
  onCamara,
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
  /** Los relevos que conoce la consola: las insignias de la cabecera salen de acá. */
  relevos?: readonly Relevo[];
  /** Rastro del objetivo que el dron está siguiendo, si hay uno (rastro.ts). */
  rastro?: RastroObjetivo | null;
  /** El pedido de control de este dron que espera la respuesta del titular, si hay uno. */
  pedidoDeControl?: PedidoDeControl | null;
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
  /**
   * Inclinación de la cámara pedida desde la vista de pilotaje, en grados
   * absolutos (`manual_gimbal`). Sale por el mismo WebSocket que los ejes y
   * devuelve lo mismo: si el mensaje llegó a salir.
   */
  onCamara: (pitch: number) => boolean;
}) {
  /** El pop-up del historial de eventos está abierto. */
  const [viendoHistorial, setViendoHistorial] = useState(false);
  /** El supervisor pidió quitarle el control a otro y falta confirmarlo. */
  const [quitando, setQuitando] = useState(false);
  /** Este operador quiere pedirle el control a quien lo tiene y falta confirmarlo. */
  const [pidiendo, setPidiendo] = useState(false);
  /**
   * Este operador pidió el control y el titular todavía no contestó. Es una
   * ref y no un estado porque no se pinta: lo que se ve de la espera lo
   * muestran los avisos del control. Sirve para abrir la vista de pilotaje
   * cuando el control llega, que es para lo que se pidió.
   */
  const pidioElControl = useRef(false);
  const avisar = useAvisar();
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
  /** La vista de pilotaje a pantalla completa está abierta. */
  const [pilotando, setPilotando] = useState(false);
  /** Por qué se cerró sola la vista de pilotaje (el control se perdió desde otro lado). */
  const [avisoDePilotaje, setAvisoDePilotaje] = useState('');
  /**
   * Si la vista ya vio el control a nombre de este operador. Recién tomado, la
   * vista se abre con la respuesta del POST y el `control_changed` llega un
   * instante después: hasta entonces "no soy el controlador" es una espera, no
   * una pérdida, y cerrar la vista ahí la cerraría apenas abierta.
   */
  const controlVistoAlPilotear = useRef(false);
  /**
   * La ficha del dron que había cuando se cortó el canal con el Comando Central
   * en pleno pilotaje, o `null` si no se cortó. El backend suelta el control
   * si pasan 30 s sin señales de vida de ninguna consola de la cuenta (un corte
   * largo), pero la consola se entera recién al reconectar, con la lista de
   * drones que vuelve a pedir: para
   * entonces el canal ya está arriba otra vez, y sin recordar el corte la vista
   * se cerraba diciendo que el control se soltó "desde otra sesión".
   */
  const fichaAlCortarseElEnlace = useRef<Drone | null>(null);
  /**
   * El botón de la tarjeta del control que esté en pantalla: "Tomar control
   * manual" sin nadie a cargo, o "Volver a la vista de pilotaje" con el control
   * tomado (nunca los dos a la vez). Es adonde vuelve el foco al cerrarse la
   * vista de pilotaje, si lo que lo tenía antes de abrirla ya no está.
   */
  const botonDelControl = useRef<HTMLButtonElement | null>(null);
  /** El aviso de por qué se cerró sola la vista: el foco va ahí si no hay botón que lo reciba. */
  const avisoDePilotajeRef = useRef<HTMLParagraphElement>(null);
  /**
   * El botón del control que se fue tenía el foco: lo hereda el que entra en su
   * lugar en el mismo cambio. Es el camino de salir de la vista: el foco vuelve
   * a "Volver a la vista de pilotaje", y cuando llega la confirmación de que se
   * soltó el control ese botón deja paso a "Tomar control manual". Sin esto el
   * foco se iba al body un instante después de haberlo devuelto.
   */
  const focoAHeredar = useRef(false);
  // Estable a propósito: con una función nueva en cada render, React soltaría y
  // volvería a poner la ref en cada status que llega.
  const refDelBotonDelControl = useCallback((boton: HTMLButtonElement | null) => {
    if (boton === null) {
      // React suelta la ref antes de sacar el nodo de la página: todavía se
      // puede preguntar si tenía el foco.
      focoAHeredar.current = document.activeElement === botonDelControl.current;
      botonDelControl.current = null;
      return;
    }
    botonDelControl.current = boton;
    if (focoAHeredar.current) boton.focus();
    focoAHeredar.current = false;
  }, []);
  // Si en el mismo cambio no entró ningún botón (otro operador tomó el
  // control), la herencia no puede quedar esperando al que aparezca mucho
  // después y robarle el foco a lo que el operador esté haciendo. Las refs de
  // los hijos se ponen antes que los efectos de layout del padre.
  useLayoutEffect(() => {
    focoAHeredar.current = false;
  });

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

  // Las alertas que se deciden al lado del video: las pendientes que sigue
  // ESTE dron, sea porque las creó o porque se las pasó un relevo (el video
  // que hay que comparar con la captura es el del que está sobre el objetivo).
  // El carrusel las ordena (la más nueva primero) y recuerda cuál se mira.
  const pendientes = useMemo(
    () => alertas.filter((a) => duenioDeLaAlerta(a) === drone.droneId && a.status === 'PENDING'),
    [alertas, drone.droneId],
  );
  const hayAlerta = pendientes.length > 0;
  /** Qué le hace al relevo en marcha una orden de patrullaje (RELEVOS §3.9). */
  const avisoDeRelevo = avisoDeOrdenesEnRelevo(drone.droneId, relevos);
  /**
   * El dron está en un relevo activo, de cualquiera de los dos lados. Soltarle
   * el control no le da ninguna orden (RELEVOS §3.9): un `resume_patrol` a B
   * lo sacaría del relevo, y A se quedaría sin relevo. Y B en camino no tiene
   * objetivo todavía (su rastreador arranca en el traspaso, §3.5), así que
   * mirar sólo el objetivo lo soltaba con `'last'`, que un hub que respeta lo
   * que se le pide tomaba como orden del operador y cancelaba el relevo.
   */
  const enRelevo = participaDeUnRelevo(drone.droneId, status, relevos);
  /** Qué le pasa al relevo si igual se suelta con «Soltar y reanudar patrullaje». */
  const avisoAlReanudar = avisoDeReanudarEnRelevo(drone.droneId, status, relevos);
  const idAvisoAlReanudar = useId();
  /**
   * Con qué se suelta el control cuando no lo elige el operador (la salida de
   * la vista de pilotaje y el supervisor que lo quita): la regla del hub,
   * `reanudacionAlSoltar` en ws.ts. Con objetivo o en un relevo, `'none'`: el
   * dron vuelve a lo que estaba haciendo. Si no, `'last'`: a su ruta.
   */
  const reanudacionAlSoltar = objetivo || enRelevo ? 'none' : 'last';

  // El aviso de "orden en curso" se va solo cuando el dron confirma: en el aire
  // para el despegue, en el suelo para el aterrizaje. También si se suelta el
  // control, porque la orden deja de ser de este operador.
  useEffect(() => {
    if (ordenEnCurso === 'despegar' && enElAire) setOrdenEnCurso(null);
    if (ordenEnCurso === 'aterrizar' && enElSuelo) setOrdenEnCurso(null);
  }, [ordenEnCurso, enElAire, enElSuelo]);
  // Lo mismo con la orden que espera confirmación: sin el control ya no es de
  // este operador (el backend la rechazaría), y confirmarla después, si el
  // control vuelve, sería despegar con una pregunta vieja. Cubre también la
  // vista de pilotaje que se cierra por la pérdida: el diálogo pedido desde
  // ahí vive adentro de la vista en pantalla completa, y la vista se va en
  // este mismo cambio (ver `contenedor` en Modal.tsx).
  useEffect(() => {
    if (soyControlador) return;
    setOrdenEnCurso(null);
    setAConfirmar(null);
  }, [soyControlador]);
  // Si el control cambia de manos (o se suelta) mientras el supervisor lee la
  // pregunta, la pregunta ya no es la misma: se descarta en vez de quedar
  // pendiente y reaparecer con el próximo que lo tome.
  useEffect(() => {
    setQuitando(false);
    setPidiendo(false);
  }, [controlador]);

  // El control que se pidió llegó (el titular lo cedió o no contestó a
  // tiempo): se abre la vista de pilotaje, como al tomarlo. Sin el gesto del
  // operador el navegador no la pone en pantalla completa, y la vista ofrece su
  // botón. Si el pedido terminó sin dárselo, no hay nada más que esperar.
  useEffect(() => {
    if (!pidioElControl.current) return;
    if (soyControlador) {
      pidioElControl.current = false;
      setAvisoDePilotaje('');
      setPilotando(true);
    } else if (!pedidoDeControl) {
      pidioElControl.current = false;
    }
  }, [soyControlador, pedidoDeControl]);

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
  const impedimentoDeEnlace = !drone.online
    ? 'El dron está desconectado: el mando no responde.'
    : !conectado
      ? 'Sin conexión con el Comando Central: el mando no responde.'
      : estadoConfirmado !== null && estadoConfirmado !== 'MANUAL'
        ? `El dron no está en vuelo manual (${stateLabel(estadoConfirmado)}): el mando no responde.`
        : null;
  // El enlace sin el suelo es lo que necesita la cámara: con el dron apoyado
  // las palancas no hacen nada, pero inclinar la cámara sí (sirve para mirar
  // alrededor antes de despegar).
  const impedimentoDelMando =
    impedimentoDeEnlace ?? (enElSuelo ? 'El dron está en el suelo: despegalo para usar el mando.' : null);

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
    // `void` y no un catch: `llamar` nunca rechaza, el error lo deja a la vista
    // ella misma. Y si el backend aceptó acá no cambia nada: el avance por los
    // nodos lo pinta el status del dron, no esta respuesta.
    if (routeId) void llamar(`/drones/${drone.droneId}/goto`, { method: 'POST', body: JSON.stringify({ routeId, index }) });
  };

  const comenzarRuta = () =>
    rutaElegida &&
    llamar(`/drones/${drone.droneId}/route/start`, { method: 'POST', body: JSON.stringify({ routeId: rutaElegida }) });
  const interrumpirRuta = () => llamar(`/drones/${drone.droneId}/route/stop`, { method: 'POST' });

  /**
   * Tomar el control abre la vista de pilotaje: es para lo que se toma. Va en
   * el mismo clic, y eso no es un detalle: el navegador sólo deja poner algo en
   * pantalla completa como respuesta a un gesto del operador. Ese permiso dura
   * unos segundos después del clic, que alcanzan para la respuesta del POST; si
   * no alcanzaran, la vista ofrece su botón de pantalla completa.
   */
  async function tomarControl() {
    setAvisoDePilotaje('');
    if (await llamar(`/drones/${drone.droneId}/control`, { method: 'POST' })) setPilotando(true);
  }
  /**
   * Pedir el control que tiene otro, ya confirmado en el diálogo. Si en el
   * medio quedó libre, el hub lo da en el acto y se abre la vista como al
   * tomarlo; si no, queda el pedido y la vista se abre cuando llegue (ver el
   * efecto de `pidioElControl`). Un rechazo (otro ya lo pidió) sube al
   * diálogo, que lo muestra adentro.
   */
  async function pedirElControl() {
    setAvisoDePilotaje('');
    const r = await pedirControl(drone.droneId);
    if (r.resultado === 'otorgado') setPilotando(true);
    else pidioElControl.current = true;
  }
  /**
   * Soltar el control. Con un objetivo cargado, `'none'` hace que el dron
   * vuelva a él (§2 `control_released`); `'last'` además lo manda a patrullar,
   * que es dejar el objetivo. Antes se mandaba siempre `'last'`, y soltar el
   * control con una alerta validada sacaba al dron de encima del objetivo.
   */
  const soltarControl = (resume: 'none' | 'last') =>
    llamar(`/drones/${drone.droneId}/control`, { method: 'DELETE', body: JSON.stringify({ resume }) });
  /**
   * Supervisor: mismo endpoint, el backend registra que fue forzado. Con
   * objetivo, el dron vuelve a él: quitarle el control a alguien no es decidir
   * que el objetivo deja de importar. En un relevo, el relevo sigue: tampoco es
   * decidir cancelarlo. Va por la confirmación (le corta el vuelo a otra
   * persona), así que el error sube al diálogo en vez de quedar acá.
   */
  async function quitarControl() {
    const otro = controlador;
    await api(`/drones/${drone.droneId}/control`, {
      method: 'DELETE',
      body: JSON.stringify({ resume: reanudacionAlSoltar }),
    });
    avisar(`Se le quitó el control de ${drone.displayName} a ${otro}.`);
  }
  /**
   * La salida de la vista de pilotaje suelta el control con la misma regla que
   * el supervisor: con objetivo o en un relevo, el dron vuelve a lo suyo. La
   * vista se cierra antes de soltar, así la pérdida del control que viene
   * después no se lee como que se lo sacó otro.
   */
  const salirDelPilotaje = () => {
    setPilotando(false);
    // llamar() ya atrapa el rechazo y lo deja a la vista: no hay nada que esperar acá.
    void soltarControl(reanudacionAlSoltar);
  };
  /**
   * «Soltar y reanudar patrullaje». Fuera de un relevo alcanza con soltar con
   * `'last'`. En un relevo no: soltar el control nunca es una orden para el
   * relevo (§3.9), y el hub suelta sin orden a un dron que participa de uno,
   * pida lo que pida la consola; con `'last'` el botón no haría nada de lo que
   * dice. Reanudar ahí es decidir sobre el relevo (lo que dice el aviso de
   * arriba del botón), y esa orden es POST /resume: el hub la cuenta para el
   * relevo y además suelta el control de quien lo tiene.
   */
  const soltarYReanudar = () => (enRelevo ? retomar() : soltarControl('last'));

  // Otro dron en pantalla es otro vuelo: la vista no se queda abierta pilotando
  // al que se dejó de mirar.
  useEffect(() => {
    setPilotando(false);
  }, [drone.droneId]);

  /**
   * Volver a la vista con el control ya tomado. El error de una acción
   * anterior (un salto del pad, una ruta) se borra: adentro de la vista se lee
   * como el resultado de lo que se ordene ahí, y uno viejo confundiría.
   */
  function volverAPilotar() {
    setError('');
    setPilotando(true);
  }

  /**
   * Adónde va el foco al cerrarse la vista si lo que lo tenía antes de abrirla
   * ya no está: al botón del control que haya ahora. Si no hay ninguno que lo
   * pueda recibir —otro operador se llevó el control, o el dron se desconectó y
   * "Tomar control manual" está apagado—, al aviso que explica por qué se cerró.
   */
  function devolverFocoTrasElPilotaje() {
    botonDelControl.current?.focus();
    if (document.activeElement !== botonDelControl.current) avisoDePilotajeRef.current?.focus();
  }

  // El control se puede perder sin que este operador haga nada: un supervisor
  // que se lo saca, la misma cuenta que lo suelta desde otra pestaña, quien lo
  // pidió y se lo cedieron (o no contestó a tiempo), o el canal de esta consola
  // que se corta (el hub lo suelta a los 30 s sin señales). Seguir
  // mostrando la vista sería dejarlo apretando teclas que el backend ya no
  // acepta; se cierra y se dice por qué, con el motivo más probable.
  useEffect(() => {
    if (!pilotando) {
      controlVistoAlPilotear.current = false;
      fichaAlCortarseElEnlace.current = null;
      return;
    }
    if (!conectado) {
      // Con el canal caído no llega ninguna ficha nueva: la que hay ahora es la
      // última de antes del corte, y cualquier otra que llegue será posterior.
      fichaAlCortarseElEnlace.current = drone;
    } else if (
      fichaAlCortarseElEnlace.current !== null &&
      fichaAlCortarseElEnlace.current !== drone &&
      soyControlador &&
      drone.controlledBy === controlador
    ) {
      // Con el canal arriba llegó una ficha nueva del dron, y es ELLA la que
      // dice que el control sigue siendo de este operador (no el status, que
      // puede ser de antes del corte): había otra consola de la cuenta abierta
      // y el corte no costó nada. Una pérdida posterior ya no es por el corte.
      fichaAlCortarseElEnlace.current = null;
    }
    if (soyControlador) {
      controlVistoAlPilotear.current = true;
      return;
    }
    if (!controlVistoAlPilotear.current) return;
    setPilotando(false);
    setAvisoDePilotaje(
      controlador
        ? `${controlador} tomó el control del dron: se cerró la vista de pilotaje.`
        : !drone.online
          ? 'El dron se desconectó del Comando Central y el control manual se soltó: se cerró la vista de pilotaje.'
          : fichaAlCortarseElEnlace.current !== null
            ? 'Se cortó la conexión con el Comando Central y el control manual se soltó solo: se cerró la vista de pilotaje.'
            : 'El control manual se soltó desde otra sesión: se cerró la vista de pilotaje.',
    );
  }, [pilotando, soyControlador, controlador, conectado, drone]);
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
      <CabeceraDelDron
        drone={drone}
        status={status}
        relevos={relevos}
        enElSuelo={enElSuelo}
        controlador={controlador}
        onBack={onBack}
        onRename={onRename}
        onHistorial={() => setViendoHistorial(true)}
      />
      {/* El error va en su propia línea: dentro del encabezado empujaba el nombre */}
      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}
      {avisoDePilotaje && (
        // Enfocable sólo desde el código (ver `devolverFocoTrasElPilotaje`):
        // no es un control y no tiene que estar en el orden del tabulador.
        <p className="aviso" role="status" data-testid="aviso-pilotaje" tabIndex={-1} ref={avisoDePilotajeRef}>
          {avisoDePilotaje}
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
      <div className={hayAlerta ? 'par-video-mapa con-alerta' : 'par-video-mapa'}>
        <LiveVideo frame={frame} senalPerdida={status?.signal === 'LOST'} />
        {/* Con `key` por dron: al saltar de un dron a otro desde la campana, las
            alertas del nuevo no son "nuevas" para el carrusel del anterior. */}
        {hayAlerta && (
          <AlertaEnCurso
            key={drone.droneId}
            alertas={pendientes}
            seguidas={objetivo ? [objetivo.alertId] : []}
            onDecidir={onDecidir}
          />
        )}
        <div className="card">
          <div className="mapa-head">
            <h2>
              <IconoUbicacion />
              Ubicación
            </h2>
            <button
              type="button"
              onClick={retomar}
              disabled={!drone.online || !interrumpido}
              title={
                objetivo
                  ? 'Deja el objetivo y vuelve al patrullaje, hacia el próximo nodo de la ruta'
                  : 'Vuelve al patrullaje, hacia el próximo nodo de la ruta'
              }
            >
              <IconoReanudar tamano={18} />
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
          <h2>
            <IconoRutas />
            Patrullaje
          </h2>
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
          {/* Antes de los botones: lo que dice es qué pasa si se los aprieta. */}
          {avisoDeRelevo && (
            <p className="aviso" role="note" data-testid="aviso-relevo">
              {avisoDeRelevo}
            </p>
          )}
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
            <button type="button" className="primario" onClick={comenzarRuta} disabled={!rutaElegida || !drone.online}>
              <IconoReanudar tamano={18} />
              Comenzar
            </button>
            <button
              type="button"
              onClick={interrumpirRuta}
              disabled={!drone.online || status?.state !== 'PATROLLING'}
            >
              <IconoPausa tamano={18} />
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
            <h2>
              <IconoMando />
              Control del dron
            </h2>
            {!controlador && (
              <>
                <button
                  ref={refDelBotonDelControl}
                  type="button"
                  className="primario"
                  onClick={tomarControl}
                  disabled={!drone.online}
                >
                  <IconoMando tamano={18} />
                  Tomar control manual
                </button>
                <p className="muted">
                  Se abre la vista de pilotaje: la cámara a pantalla completa, para volar con el teclado, el
                  mouse o los sticks virtuales.
                </p>
              </>
            )}
            {soyControlador && (
              <div className="control-panel">
                {/* Despegar y aterrizar van primero: con el dron en el suelo es
                    lo único que se puede hacer, y es lo que habilita el resto. */}
                {(enElSuelo || enElAire) && (
                  <>
                    <h3>{enElSuelo ? 'En el suelo' : 'En el aire'}</h3>
                    {enElSuelo ? (
                      <button
                        type="button"
                        className="primario"
                        onClick={() => setAConfirmar('despegar')}
                        disabled={!drone.online}
                      >
                        <IconoDespegar tamano={18} />
                        Despegar
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="dismiss"
                        onClick={() => setAConfirmar('aterrizar')}
                        disabled={!drone.online}
                      >
                        <IconoAterrizar tamano={18} />
                        Aterrizar
                      </button>
                    )}
                    {ordenEnCurso && (
                      <p className="aviso" role="status" data-testid="orden-en-curso">
                        {ORDEN_EN_CURSO[ordenEnCurso]}
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
                    pad de arriba manda UN desplazamiento de 25 m; el vuelo
                    continuo —el dron se mueve mientras se sostiene la tecla o
                    la palanca— vive en la vista de pilotaje, sobre el video a
                    pantalla completa, porque volar mirando una imagen chica al
                    costado de la tarjeta es volar a ciegas. */}
                <hr className="regla" />
                <h3>Vuelo continuo</h3>
                <p className="muted">Teclado, mouse y sticks virtuales, con la cámara a pantalla completa.</p>
                <button ref={refDelBotonDelControl} type="button" className="primario" onClick={volverAPilotar}>
                  <IconoMando tamano={18} />
                  Volver a la vista de pilotaje
                </button>

                {/* Con un objetivo cargado o en un relevo hay dos formas de
                    soltar, y la que va primero es la que no pierde nada: el
                    dron vuelve a orbitar o seguir el objetivo, o sigue con el
                    relevo. Mandarlo a patrullar es dejar eso, y tiene que ser
                    una decisión explícita; en un relevo, con lo que le hace
                    dicho antes del botón (RELEVOS §3.9). */}
                {objetivo || enRelevo ? (
                  <>
                    <button type="button" className="resume" onClick={() => soltarControl('none')}>
                      <IconoOperacion tamano={18} />
                      {etiquetaDeSoltarSinOrden(!!objetivo, enRelevo)}
                    </button>
                    {avisoAlReanudar && (
                      <p className="aviso" role="note" id={idAvisoAlReanudar} data-testid="aviso-reanudar-en-relevo">
                        {avisoAlReanudar}
                      </p>
                    )}
                    <button
                      type="button"
                      className="ghost soltar-y-patrullar"
                      aria-describedby={avisoAlReanudar ? idAvisoAlReanudar : undefined}
                      onClick={soltarYReanudar}
                    >
                      <IconoReanudar tamano={18} />
                      Soltar y reanudar patrullaje
                    </button>
                  </>
                ) : (
                  <button type="button" className="resume" onClick={() => soltarControl('last')}>
                    <IconoReanudar tamano={18} />
                    Devolver al patrullaje
                  </button>
                )}
              </div>
            )}
            {controlador && !soyControlador && (
              <>
                <p className="muted">
                  Controlado por <strong>{controlador}</strong>.{' '}
                  {esSupervisor && (
                    <button type="button" className="chico dismiss" onClick={() => setQuitando(true)}>
                      Quitar control
                    </button>
                  )}
                </p>
                {/* Un pedido por dron: con uno en curso el botón espera. */}
                <button
                  type="button"
                  className="primario"
                  onClick={() => setPidiendo(true)}
                  disabled={pedidoDeControl !== null}
                >
                  <IconoMando tamano={18} />
                  Pedir el control
                </button>
                {pedidoDeControl && (
                  <p className="muted" role="status" data-testid="pedido-de-control">
                    {pedidoDeControl.solicitante === me?.username
                      ? `Le pediste el control a ${pedidoDeControl.titular}: esperando su respuesta.`
                      : `${pedidoDeControl.solicitante} ya le pidió el control a ${pedidoDeControl.titular}: esperá a que le conteste.`}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Por dron: el de otro dron es otro historial, que arranca de cero. */}
      {viendoHistorial && (
        <HistorialDeEventos
          key={drone.droneId}
          droneId={drone.droneId}
          nombre={drone.displayName}
          liveEvents={liveEvents}
          onCerrar={() => setViendoHistorial(false)}
        />
      )}

      {pilotando && (
        <PilotajePantallaCompleta
          nombre={drone.displayName}
          droneId={drone.droneId}
          enLinea={drone.online}
          status={status}
          frame={frame}
          alertas={alertas}
          controlTomado={soyControlador}
          impedimento={impedimentoDelMando}
          camaraDisponible={impedimentoDeEnlace === null}
          esperandoConfirmacion={esperandoConfirmacion}
          enElSuelo={enElSuelo}
          enElAire={enElAire}
          avisoDeOrden={ordenEnCurso && ORDEN_EN_CURSO[ordenEnCurso]}
          error={error}
          hayObjetivo={!!objetivo}
          enRelevo={enRelevo}
          suspendido={aConfirmar !== null}
          onMando={onMando}
          onCamara={onCamara}
          onOrden={setAConfirmar}
          onCerrar={() => setPilotando(false)}
          onSalir={salirDelPilotaje}
          onDevolverFoco={devolverFocoTrasElPilotaje}
        />
      )}

      {/* La misma confirmación que el resto de la consola. La orden sale sin
          esperar al backend (el diálogo se cierra en el acto) porque su
          resultado se lee donde se está mirando: en la tarjeta o en el HUD. */}
      {aConfirmar && confirmacion && (
        <DialogoConfirmacion
          pedido={{
            titulo: `${confirmacion.titulo} ${drone.displayName}`,
            consecuencia: confirmacion.texto,
            detalle: confirmacion.aviso,
            confirmar: confirmacion.boton,
            tono: aConfirmar === 'despegar' ? 'primario' : 'peligro',
            accion: () => {
              void confirmarOrden(aConfirmar);
            },
          }}
          onCerrar={() => setAConfirmar(null)}
        />
      )}

      {pidiendo && controlador && (
        <DialogoConfirmacion
          pedido={{
            titulo: `Pedir el control de ${drone.displayName}`,
            consecuencia: `${controlador} está piloteando este dron. ¿Querés pedirle el control?`,
            detalle:
              `${controlador} tiene ${PLAZO_DE_RESPUESTA_MS / 1000} segundos para cedértelo o mantenerlo. Si no ` +
              'contesta, el control pasa a vos y el dron queda quieto donde está, a la espera de tus órdenes.',
            confirmar: 'Pedir el control',
            enCurso: 'Pidiendo…',
            tono: 'primario',
            accion: pedirElControl,
          }}
          onCerrar={() => setPidiendo(false)}
        />
      )}

      {quitando && controlador && (
        <DialogoConfirmacion
          pedido={{
            titulo: `Quitarle el control a ${controlador}`,
            consecuencia: `${controlador} deja de pilotear ${drone.displayName} en el acto y el dron ${queHaceAlSoltarSinOrden(!!objetivo, enRelevo)}.`,
            detalle: 'Queda en el registro que el control se soltó a la fuerza, y quién lo hizo.',
            confirmar: 'Quitar control',
            enCurso: 'Quitando…',
            accion: quitarControl,
          }}
          onCerrar={() => setQuitando(false)}
        />
      )}
    </main>
  );
}
