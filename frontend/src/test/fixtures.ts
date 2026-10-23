import type {
  Alert,
  Drone,
  DroneStatus,
  Emergencia,
  EventRow,
  FotoDeEmergencia,
  Me,
  PatrolRoute,
  Relevo,
  UserView,
} from '../types';

/** Un relevo de seguimiento de Alfa (a1) a Bravo (b2), en camino. */
export function makeRelevo(over: Partial<Relevo> = {}): Relevo {
  return {
    id: 7,
    motivo: 'seguimiento',
    estado: 'EN_CAMINO',
    motivoFin: null,
    origen: { droneId: 'a1', displayName: 'Alfa' },
    relevo: { droneId: 'b2', displayName: 'Bravo' },
    baseId: 1,
    alertId: 12,
    routeId: null,
    fromIndex: null,
    etaS: 74,
    rechazados: [],
    venceEn: null,
    creadoEn: '2026-10-23T15:04:05.000Z',
    actualizadoEn: '2026-10-23T15:04:20.000Z',
    ...over,
  };
}

/** Un aterrizaje de emergencia de Alfa (a1), abierto y todavía bajando. */
export function makeEmergencia(over: Partial<Emergencia> = {}): Emergencia {
  return {
    id: 3,
    droneId: 'a1',
    displayName: 'Alfa',
    motivo: 'autonomia',
    lat: -34.8702,
    lon: -56.1902,
    alt: 38,
    bateria: 9,
    ts: 1792767845000,
    creadaEn: '2026-10-23T15:04:05.300Z',
    aterrizadaEn: null,
    aterrizajeLat: null,
    aterrizajeLon: null,
    aterrizajeAlt: null,
    recuperadaEn: null,
    recuperadaPor: null,
    fotos: 0,
    ...over,
  };
}

export function makeFoto(over: Partial<FotoDeEmergencia> = {}): FotoDeEmergencia {
  return {
    seq: 0,
    tipo: 'oblicua',
    rumbo: 270,
    inclinacion: -70,
    lat: -34.8702,
    lon: -56.1902,
    alt: 38,
    ts: 1792767847000,
    jpegBase64: '/9j/AAAA',
    ...over,
  };
}

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
    deleted: false,
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
    createdBy: null,
    deleted: false,
    deletedAt: null,
    ...over,
  };
}

export function makeUser(over: Partial<UserView> = {}): UserView {
  return {
    username: 'oper1',
    role: 'operator',
    active: true,
    canControl: true,
    deleted: false,
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
