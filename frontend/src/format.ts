import type { DroneStatus } from './types';

export const STATE_LABELS: Record<string, string> = {
  IDLE: 'En base',
  PATROLLING: 'Patrullando',
  ORBITING: 'Orbitando objetivo',
  RETURNING_HOME_SIGNAL: 'Volviendo a base (pérdida de señal)',
  RETURNING_HOME_BATTERY: 'Volviendo a base (batería baja)',
  LANDED: 'Aterrizado',
  PAUSED: 'Patrulla interrumpida',
  MANUAL: 'Control manual',
  FORCED: 'Desvío a nodo',
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

export function batteryClass(battery: number): string {
  return battery <= 25 ? 'bad' : battery <= 40 ? 'warn' : 'ok';
}

export function signalClass(pct: number): string {
  return pct <= 20 ? 'bad' : pct <= 50 ? 'warn' : 'ok';
}

/** Nodo actual del patrullaje con el formato "7 de 10". */
export function waypointLabel(status: DroneStatus): string {
  if (!status.waypointTotal) return '—';
  return `${status.waypointIndex + 1} de ${status.waypointTotal}`;
}

/** Iniciales para el marcador del mapa: "Base Norte" → "BN", "Alfa" → "AL". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
}

export function time(ts: string): string {
  return new Date(ts).toLocaleTimeString();
}
