export interface PatrolRoute {
  id: number;
  name: string;
  description: string;
  waypoints: { lat: number; lon: number; alt: number }[];
}

export interface DroneStatus {
  type: 'status';
  droneId: string;
  state: string;
  battery: number;
  lat: number;
  lon: number;
  routeId: number | null;
  waypointIndex: number | null;
  signal: 'OK' | 'LOST';
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
}
