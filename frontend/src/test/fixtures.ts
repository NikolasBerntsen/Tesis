import type { Alert, Drone, DroneStatus, EventRow, Me, PatrolRoute, UserView } from '../types';

export function makeStatus(over: Partial<DroneStatus> = {}): DroneStatus {
  return {
    droneId: 'd1',
    displayName: 'Alfa',
    state: 'PATROLLING',
    battery: 80,
    lat: -34.60123,
    lon: -58.40456,
    routeId: 1,
    waypointIndex: 2,
    waypointTotal: 5,
    signal: 'OK',
    signalPct: 90,
    mode: 'TEST',
    controlledBy: null,
    ...over,
  };
}

export function makeDrone(over: Partial<Drone> = {}): Drone {
  return {
    hash: 'd1',
    droneId: 'd1',
    displayName: 'Alfa',
    model: 'DJI Mini 3',
    inventoryCode: 'INV-0001',
    baseId: 1,
    active: true,
    deletedAt: null,
    base: { name: 'Base Norte', lat: -34.6, lon: -58.4 },
    online: true,
    lastStatus: null,
    controlledBy: null,
    ...over,
  };
}

export function makeAlert(over: Partial<Alert> = {}): Alert {
  return {
    id: 1,
    created_at: '2024-01-01T12:00:00.000Z',
    type: 'PERSON',
    status: 'PENDING',
    drone_id: 'd1',
    lat: -34.6,
    lon: -58.4,
    snapshot: null,
    decided_by: null,
    decided_at: null,
    ...over,
  };
}

export function makeEvent(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    ts: '2024-01-01T12:00:00.000Z',
    type: 'STATUS',
    source: 'drone',
    message: 'un evento',
    drone_id: 'd1',
    alert_id: null,
    category: 'drone',
    meta: null,
    ...over,
  };
}

export function makeRoute(over: Partial<PatrolRoute> = {}): PatrolRoute {
  return {
    id: 1,
    name: 'Ruta Perimetral',
    description: 'vuelta al predio',
    waypoints: [
      { lat: -34.6, lon: -58.4, alt: 30 },
      { lat: -34.61, lon: -58.41, alt: 30 },
    ],
    ...over,
  };
}

export function makeUser(over: Partial<UserView> = {}): UserView {
  return {
    username: 'oper1',
    role: 'operator',
    active: true,
    canControl: true,
    deletedAt: null,
    ...over,
  };
}

export function makeMe(over: Partial<Me> = {}): Me {
  return {
    username: 'admin1',
    role: 'admin',
    canControl: true,
    ...over,
  };
}
