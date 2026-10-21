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
  role: RolConsola;
  active: boolean;
  canControl: boolean;
  /** Marca de baja lógica: es lo que decide si la fila está dada de baja. */
  deleted: boolean;
  /** Fecha ISO de esa baja; queda como dato de auditoría. */
  deletedAt: string | null;
}

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
}

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

/** El `meta` de un EventRow ya parseado y saneado. */
export interface MetaEvento {
  antes?: CamposMeta;
  despues?: CamposMeta;
  ubicacion?: MetaUbicacion;
  alerta?: MetaAlerta;
  drone?: MetaDron;
  detalle?: CamposMeta;
  /** Quién ejecutó la acción (emparejamiento, decisión de alerta). */
  por?: string;
  /** `VALIDATED` o `DISMISSED` en las decisiones de alerta. */
  decision?: string;
  /** Modelo del teléfono que escaneó el QR. */
  dispositivo?: string;
}
