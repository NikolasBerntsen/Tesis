export interface Base {
  name: string;
  lat: number;
  lon: number;
}

export interface DroneStatus {
  droneId: string;
  displayName: string;
  state: string;
  battery: number;
  lat: number;
  lon: number;
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
  role: RolConsola;
  active: boolean;
  canControl: boolean;
  /** Fecha ISO del borrado lógico; `null` mientras la cuenta esté vigente. */
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
  /** Un dron desactivado no puede conectarse: el backend le corta el WebSocket. */
  active: boolean;
  /** Fecha ISO del borrado lógico; `null` mientras el activo esté vigente. */
  deletedAt: string | null;
  base: Base | null;
  online: boolean;
  lastStatus: DroneStatus | null;
  controlledBy: string | null;
}

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
