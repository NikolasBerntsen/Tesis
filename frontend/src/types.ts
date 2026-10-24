import type { PedidoDelHub } from './control';

/** Coordenada con nombre. La usan la ficha del dron y los mapas. */
export interface Base {
  name: string;
  lat: number;
  lon: number;
}

/** La base como activo del inventario: es lo que devuelve /api/bases. */
export interface BaseAsset {
  id: number;
  name: string;
  lat: number;
  lon: number;
  active: boolean;
  createdAt: string;
  createdBy: string | null;
  /** Marca de baja lógica: es lo que decide si la fila está dada de baja. */
  deleted: boolean;
  /** Fecha ISO de esa baja; queda como dato de auditoría. */
  deletedAt: string | null;
  /**
   * Punto de aterrizaje para visitantes (RELEVOS §0): dónde baja un dron que se
   * desvía desde otra base. Van juntos, los dos números o los dos `null`, a
   * entre 10 y 50 m de la base. Opcionales porque un backend viejo no los manda.
   */
  aterrizajeLat?: number | null;
  aterrizajeLon?: number | null;
}

/**
 * El objetivo que el dron está orbitando o siguiendo (`status.target`, §1 del
 * contrato). Existe desde la detección que disparó la alerta hasta que el
 * seguimiento termina, y la app lo vuelve a estimar con cada detección: es lo
 * que el equipo de tierra necesita para llegar al lugar.
 */
export interface ObjetivoEnSeguimiento {
  /** Id de la alerta del objetivo. `null` hasta que el hub le contestó a la app con `alert_ack`. */
  alertId: number | null;
  type: 'PERSON' | 'VEHICLE';
  /** Posición ESTIMADA (filtrada, y extrapolada unos segundos si no se lo ve). */
  lat: number;
  lon: number;
  /**
   * Velocidad estimada, en m/s. `null` si la app no la pudo estimar: manda null
   * en vez de NaN, que org.json no acepta (ver `velocidad` en format.ts).
   */
  speedMs: number | null;
  /** Rumbo de su desplazamiento, 0..360°. `null` por lo mismo que la velocidad. */
  courseDeg: number | null;
  /** Se está desplazando: el dron lo sigue (`FOLLOWING`) en vez de orbitarlo. */
  moving: boolean;
  /** Hace más de 10 s que no se lo detecta: el dron orbita la última posición conocida. */
  lost: boolean;
  /** Hace cuánto se lo vio por última vez, en ms. */
  lastSeenMs: number;
  /** `PENDING` mientras nadie decidió la alerta; `VALIDATED` si un operador la confirmó. */
  decision: 'PENDING' | 'VALIDATED';
  /**
   * Componentes norte y este de la velocidad, en m/s. Los usa el relevo de un
   * seguimiento; una app vieja no los manda y la consola no los necesita.
   */
  vNorteMs?: number;
  vEsteMs?: number;
}

/**
 * Si el dron está en espera, disponible o participando de un relevo
 * (`status.relevo`, §1 del contrato). El hub lo valida antes de reenviarlo: si
 * no pasa, el campo no viene, igual que con una app vieja.
 */
export interface RelevoDelDron {
  /** El interruptor «En espera para relevos» del teléfono está prendido. */
  enEspera: boolean;
  /** Además de en espera, en condiciones de salir ya (batería, GPS, en su base…). */
  disponible: boolean;
  relayId: number | null;
  /** `origen` es el que pidió el relevo (A); `relevo`, el que va (B). */
  rol: 'origen' | 'relevo' | null;
  fase: string | null;
}

/** Lo que el dron calcula que le cuesta volver y aterrizar (`status.autonomia`). */
export interface Autonomia {
  pctParaVolver: number | null;
  pctParaAterrizar: number | null;
  alcanceM: number | null;
  segundosParaVolver: number | null;
}

export interface DroneStatus {
  droneId: string;
  displayName: string;
  state: string;
  battery: number;
  /**
   * Posición actual, o `null` sin fix GPS (interior, arranque en frío). El SDK
   * de DJI entrega 0,0 sin fix, y eso no es una posición: la consola no dibuja
   * el dron ni le cree a 0,0. Para leerla está `posicionDelDron` (format.ts).
   */
  lat: number | null;
  lon: number | null;
  routeId: number | null;
  waypointIndex: number;
  waypointTotal: number;
  signal: 'OK' | 'LOST';
  signalPct: number;
  mode: 'TEST' | 'DEPLOY';
  /** Rumbo 0..360° hacia donde mira la cámara */
  heading?: number;
  /** Usuario que tiene el control manual, si alguien lo tomó */
  controlledBy?: string | null;
  // Los que siguen son opcionales porque una app vieja no los manda, y el hub
  // reenvía el status tal cual: la consola tiene que andar igual sin ellos.
  /** `true` si `lat`/`lon` son una posición real. El status sale igual sin GPS. */
  gpsFix?: boolean;
  /** Altura sobre el punto de despegue, en metros (0 en el suelo). */
  alt?: number;
  /** Satélites GPS en uso. */
  satellites?: number;
  /** `true` con el dron en el aire. En el suelo la app rechaza el mando y las flechas. */
  flying?: boolean;
  /** Modo de vuelo que informa la aeronave (`GPS`, `ATTI`, …); `""` si no lo informa. */
  flightMode?: string;
  /** El objetivo que está orbitando o siguiendo; `null` si no hay ninguno. */
  target?: ObjetivoEnSeguimiento | null;
  /**
   * Inclinación actual de la cámara, en grados: 0 es el horizonte y negativo
   * es mirar hacia abajo (de -90 a 30, ver `manual_gimbal`). Sin este dato la
   * vista de pilotaje supone -30°.
   */
  gimbalPitch?: number;
  /** En espera, disponible o en un relevo. Sin el campo, ninguna de las tres. */
  relevo?: RelevoDelDron;
  /** Sin el objeto, o con todo en `null`, el dron no informa su autonomía. */
  autonomia?: Autonomia;
}

/**
 * Roles del backend. `drone` existe pero es el token de máquina que la app
 * obtiene al emparejarse por QR: a la consola nunca entra un dron.
 */
export type Role = 'drone' | 'field_operator' | 'operator' | 'supervisor' | 'admin';

/** Los roles que sí inician sesión en la consola. */
export type RolConsola = Exclude<Role, 'drone'>;

/** Los roles que el admin puede elegir al crear un usuario (POST /api/users). */
export type RolAsignable = Extract<Role, 'field_operator' | 'operator' | 'supervisor'>;

/** Quién soy: rol y si estoy autorizado a controlar drones. */
export interface Me {
  username: string;
  role: RolConsola;
  canControl: boolean;
}

export interface UserView {
  username: string;
  fullName: string;
  /**
   * DNI en dígitos, sin puntos. Vacío en las cuentas anteriores al DNI, y
   * opcional porque un backend viejo directamente no lo manda.
   */
  dni?: string;
  role: RolConsola;
  active: boolean;
  canControl: boolean;
  /** Marca de baja lógica: es lo que decide si la fila está dada de baja. */
  deleted: boolean;
  /** Fecha ISO de esa baja; queda como dato de auditoría. */
  deletedAt: string | null;
}

/** Cuerpo de POST /api/users. La contraseña no va: la genera el sistema. */
export interface AltaDeUsuario {
  username: string;
  fullName: string;
  /** Ya normalizado a dígitos. */
  dni: string;
  role: RolAsignable;
  canControl: boolean;
}

/**
 * Cuerpo de PATCH /api/users/:username: sólo lo que cambió. El supervisor
 * nada más puede mandar `canControl`; el resto es del admin.
 */
export type CambiosDeUsuario = Partial<Pick<UserView, 'fullName' | 'dni' | 'active' | 'canControl'>> & {
  role?: RolAsignable;
};

/** Ficha de dron que devuelve GET /api/drones y los mensajes drone_online/offline/updated. */
export interface Drone {
  /**
   * `hash` y `droneId` son el mismo valor con dos nombres: `hash` cuando se
   * habla del activo y de su QR, `droneId` cuando se habla del protocolo.
   */
  hash: string;
  droneId: string;
  displayName: string;
  model: string;
  /** Número de inventario con el que la organización identifica al aparato. */
  inventoryCode: string;
  /** Un dron no operativo no puede conectarse: el backend le corta el WebSocket. */
  active: boolean;
  baseId: number | null;
  /** Marca de baja lógica: es lo que decide si la fila está dada de baja. */
  deleted: boolean;
  /** Fecha ISO de esa baja; queda como dato de auditoría. */
  deletedAt: string | null;
  base: Base | null;
  online: boolean;
  lastStatus: DroneStatus | null;
  controlledBy: string | null;
  /**
   * El pedido de control que espera la respuesta del titular (PROTOCOLS §6).
   * Falta en la ficha de un hub viejo, y ahí es lo mismo que null.
   */
  pedidoDeControl?: PedidoDelHub | null;
}

/**
 * Novedad de un activo llegada por el canal en vivo. `drone_updated`,
 * `drone_online` y `drone_offline` traen la ficha entera; el renombre iniciado
 * desde la app llega sólo con el nombre nuevo, así que se aplica encima de la
 * ficha que la vista ya tenga.
 */
export type NovedadDron =
  | { tipo: 'ficha'; drone: Drone }
  | { tipo: 'renombre'; droneId: string; displayName: string };

/** `label` es el apodo opcional que le pone el operador para identificar la zona. */
export interface Waypoint {
  lat: number;
  lon: number;
  alt: number;
  label?: string;
}

export interface PatrolRoute {
  id: number;
  name: string;
  description: string;
  waypoints: Waypoint[];
  createdBy: string | null;
  /** Marca de baja lógica: es lo que decide si la fila está dada de baja. */
  deleted: boolean;
  /** Fecha ISO de esa baja; queda como dato de auditoría. */
  deletedAt: string | null;
}

export interface Alert {
  id: number;
  created_at: string;
  type: 'PERSON' | 'VEHICLE';
  status: 'PENDING' | 'VALIDATED' | 'DISMISSED';
  drone_id: string | null;
  lat: number | null;
  lon: number | null;
  snapshot: string | null;
  decided_by: string | null;
  decided_at: string | null;
  /**
   * El dron que sigue al objetivo ahora, o `null` si es el que la creó. Cambia
   * en el traspaso de un relevo (RELEVOS §3.6); un backend viejo no lo manda.
   */
  seguidaPor?: string | null;
}

/** Un dron como lo nombra un relevo. */
export interface DronDelRelevo {
  droneId: string;
  displayName: string;
}

/**
 * Un relevo entre dos drones, como lo devuelven `relay_updated` y
 * `GET /api/relevos` (§3 del contrato). El hub es la única fuente de verdad: la
 * consola lo toma por `id` y no lo revisa.
 */
export interface Relevo {
  id: number;
  motivo: 'patrulla' | 'seguimiento' | string;
  /** `RESERVADO` … `FALLIDO`; un estado que la consola no conoce se muestra tal cual. */
  estado: string;
  motivoFin: string | null;
  /** A, el que pidió el relevo. */
  origen: DronDelRelevo;
  /** B, el que va; `null` mientras no hay candidato. */
  relevo: DronDelRelevo | null;
  baseId: number | null;
  alertId: number | null;
  routeId: number | null;
  fromIndex: number | null;
  etaS: number | null;
  rechazados: string[];
  venceEn: string | null;
  creadoEn: string;
  actualizadoEn: string;
}

/**
 * Un aterrizaje de emergencia (RELEVOS §5), como lo devuelven
 * `emergency_updated` y `GET /api/emergencias`. Queda abierto hasta que alguien
 * marca el dron como recuperado.
 */
export interface Emergencia {
  id: number;
  droneId: string;
  displayName: string;
  motivo: 'autonomia' | 'bateria_critica_dji' | string;
  /** Dónde estaba al disparar el protocolo; `null` sin GPS. */
  lat: number | null;
  lon: number | null;
  alt: number;
  bateria: number;
  /** El reloj del teléfono al disparar: es un dato, no ordena nada. */
  ts: number;
  /** Hora del hub al abrirla: la que se muestra. */
  creadaEn: string;
  aterrizadaEn: string | null;
  /** La última posición al tocar tierra: la que hay que ir a buscar. */
  aterrizajeLat: number | null;
  aterrizajeLon: number | null;
  aterrizajeAlt: number | null;
  recuperadaEn: string | null;
  recuperadaPor: string | null;
  /** Cuántas fotos llegaron. */
  fotos: number;
}

/** Una foto del protocolo de última ubicación. */
export interface FotoDeEmergencia {
  seq: number;
  tipo: 'oblicua' | 'cenital' | 'panoramica' | string;
  /** Hacia dónde miraba la cámara, 0..360°. */
  rumbo: number;
  /** Inclinación de la cámara: 0 es el horizonte, -90 derecho al suelo. */
  inclinacion: number;
  lat: number | null;
  lon: number | null;
  alt: number;
  ts: number;
  jpegBase64: string;
}

/** `GET /api/emergencias/:id`: la emergencia con sus fotos, ordenadas por `seq`. */
export type EmergenciaConFotos = Omit<Emergencia, 'fotos'> & { fotos: FotoDeEmergencia[] };

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  source: string;
  message: string;
  drone_id: string | null;
  alert_id: number | null;
  category: 'drone' | 'usuarios' | 'sistema';
  meta: string | null;
}

/** Página del registro: GET /api/logs filtra y cuenta en SQL, no en el navegador. */
export interface PaginaLogs {
  items: EventRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Tamaños de página que respeta el backend; cualquier otro cae a 25. */
export type TamanioPagina = 25 | 50 | 75 | 100;

// ---- `meta` de los eventos ----
// Es JSON guardado en la base, así que una fila vieja puede traer cualquier
// forma. Todo es opcional y se lee con parsearMeta() (api.ts), que descarta lo
// que no se entienda en vez de dejar que el pop-up explote.

/** Lo único que el pop-up sabe pintar en una fila de clave/valor. */
export type ValorMeta = string | number | boolean | null;

/** Objeto plano: `antes`, `despues` y `detalle` se comparan campo a campo. */
export type CamposMeta = Record<string, ValorMeta>;

/** Ficha compacta del dron (`meta.drone`). */
export interface MetaDron {
  hash: string;
  displayName: string;
  model: string;
}

/** Instantánea GPS del operador de campo al emparejar (`meta.ubicacion`). */
export interface MetaUbicacion {
  lat: number;
  lon: number;
  accuracyM: number | null;
}

/** Alerta referenciada (`meta.alerta`); el resto se trae con GET /api/alerts/:id. */
export interface MetaAlerta {
  id: number;
  /** `PERSON` | `VEHICLE`, pero queda abierto porque sale de la base. */
  tipo: string;
  lat: number | null;
  lon: number | null;
  ts: string | null;
}

/** Emergencia referenciada (`meta.emergencia`); el resto se trae con GET /api/emergencias/:id. */
export interface MetaEmergencia {
  id: number;
  motivo: string;
  lat: number | null;
  lon: number | null;
  /** `creadaEn` de la emergencia. */
  ts: string | null;
}

/** El `meta` de un EventRow ya parseado y saneado. */
export interface MetaEvento {
  antes?: CamposMeta;
  despues?: CamposMeta;
  ubicacion?: MetaUbicacion;
  alerta?: MetaAlerta;
  emergencia?: MetaEmergencia;
  drone?: MetaDron;
  detalle?: CamposMeta;
  /** Quién ejecutó la acción (emparejamiento, decisión de alerta). */
  por?: string;
  /** `VALIDATED` o `DISMISSED` en las decisiones de alerta. */
  decision?: string;
  /** Modelo del teléfono que escaneó el QR. */
  dispositivo?: string;
}
