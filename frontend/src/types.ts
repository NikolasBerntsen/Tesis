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

export type Role = 'operator' | 'supervisor' | 'admin';

/** Quién soy: rol y si estoy autorizado a controlar drones. */
export interface Me {
  username: string;
  role: Role;
  canControl: boolean;
}

export interface UserView {
  username: string;
  role: Role;
  active: boolean;
  canControl: boolean;
}

/** Ficha de dron que devuelve GET /api/drones y los mensajes drone_online/offline. */
export interface Drone {
  droneId: string;
  displayName: string;
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
