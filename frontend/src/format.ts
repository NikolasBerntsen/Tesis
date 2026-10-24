import type { DroneStatus, ObjetivoEnSeguimiento } from './types';

/**
 * Una etiqueta por cada `state` del contrato (§1 de docs/PROTOCOLS.md). Un
 * estado que falte acá no rompe nada —`stateLabel` lo muestra crudo—, pero el
 * operador lee `FOLLOWING` en inglés y en mayúsculas justo cuando más tiene que
 * entender qué hace el dron: el test de format recorre la lista del contrato.
 */
export const STATE_LABELS: Record<string, string> = {
  IDLE: 'En base',
  PATROLLING: 'Patrullando',
  ORBITING: 'Orbitando objetivo',
  FOLLOWING: 'Siguiendo objetivo',
  RETURNING_HOME_SIGNAL: 'Volviendo a base (pérdida de señal)',
  RETURNING_HOME_BATTERY: 'Volviendo a base (batería baja)',
  RETURNING_HOME: 'Volviendo a base (orden del operador de campo)',
  LANDED: 'Aterrizado',
  PAUSED: 'Patrulla interrumpida',
  MANUAL: 'Control manual',
  FORCED: 'Desvío a nodo',
  // Los mismos rótulos que la pantalla del teléfono (strings.xml de la app):
  // el operador de campo y el de la consola tienen que estar hablando de lo
  // mismo cuando se llaman por radio.
  RELEVANDO: 'Relevando a otro dron',
  ATERRIZAJE_EMERGENCIA: 'Aterrizaje de emergencia',
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/**
 * Los dos estados en los que el dron trabaja sobre un objetivo detectado:
 * orbitándolo si está quieto o siguiéndolo si se mueve. Para la consola son el
 * mismo momento —hay algo que decidir y un lugar al que mandar gente—, así que
 * se resaltan igual; lo único que cambia es el rótulo.
 */
export const SOBRE_OBJETIVO: readonly string[] = ['ORBITING', 'FOLLOWING'];

export function sobreObjetivo(state: string | null | undefined): boolean {
  return !!state && SOBRE_OBJETIVO.includes(state);
}

/**
 * El tono del estado de un dron, en la pastilla de su cámara y en la
 * telemetría: oro mientras trabaja sobre una alerta —orbitándola, siguiéndola
 * o yendo a relevar al que la sigue—, óxido mientras baja de emergencia, y la
 * tinta de siempre para todo lo demás.
 */
export function tonoDelEstadoDelDron(state: string | null | undefined): 'accent' | 'bad' | 'muted' {
  if (state === 'ATERRIZAJE_EMERGENCIA') return 'bad';
  if (sobreObjetivo(state) || state === 'RELEVANDO') return 'accent';
  return 'muted';
}

export function batteryClass(battery: number): string {
  return battery <= 25 ? 'bad' : battery <= 40 ? 'warn' : 'ok';
}

export function signalClass(pct: number): string {
  return pct <= 20 ? 'bad' : pct <= 50 ? 'warn' : 'ok';
}

/**
 * Nodo actual del patrullaje con el formato "7 de 10". Los dos números salen
 * del status que manda el celular y el hub los reenvía sin revisarlos: si
 * alguno no es un número de verdad se muestra la raya, como sin ruta. Antes se
 * interpolaban tal cual, y un texto en `waypointIndex` terminaba adentro del
 * globo del mapa, que es HTML (y un "3" en texto daba "31 de 10").
 */
export function waypointLabel(status: DroneStatus): string {
  const { waypointIndex, waypointTotal } = status;
  if (!Number.isFinite(waypointTotal) || waypointTotal <= 0 || !Number.isFinite(waypointIndex)) return '—';
  return `${waypointIndex + 1} de ${waypointTotal}`;
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

/* El navegador puede estar en cualquier idioma; la interfaz es en castellano, y
   sin locale fijo la misma hora salía "7:47:48 AM" en un Chrome en inglés. */
export function time(ts: string): string {
  return new Date(ts).toLocaleTimeString('es-AR', { hour12: false });
}

const FECHA_Y_HORA: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

/**
 * Fecha y hora cortas. El registro general pagina el historial entero, y ahí
 * dos filas separadas por meses se verían iguales si sólo se mostrara la hora.
 */
export function fechaYHora(ts: string): string {
  const fecha = new Date(ts);
  // Una fila vieja puede traer cualquier cosa en `ts`: se muestra crudo antes
  // que un "Invalid Date".
  return Number.isNaN(fecha.getTime()) ? ts : fecha.toLocaleString('es-AR', FECHA_Y_HORA);
}

// ---- Posición y objetivo ----

/**
 * Si un par de coordenadas es una posición de verdad. Además de lo obvio
 * (números finitos y dentro de rango) descarta el 0,0 exacto: es lo que entrega
 * el SDK de DJI sin fix, y creerle pintaba el dron en el golfo de Guinea con una
 * línea de miles de kilómetros hasta su base. Nadie patrulla Null Island.
 */
export function posicionValida(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/**
 * Dónde está el dron, o `null` si no lo sabe. Es la ÚNICA puerta para leer la
 * posición de un status: el mapa, el encuadre y la tarjeta pasan por acá, y así
 * un dron sin GPS no se dibuja en ningún lado. `gpsFix` manda cuando viene; una
 * app vieja no lo manda y ahí se juzga por las coordenadas.
 */
export function posicionDelDron(status: DroneStatus | null | undefined): [number, number] | null {
  if (!status || status.gpsFix === false) return null;
  return posicionValida(status.lat, status.lon) ? [status.lat as number, status.lon as number] : null;
}

/** "Sin GPS (3 satélites)": lo que la tarjeta muestra en lugar de las coordenadas. */
export function textoSinGps(satelites: number | undefined): string {
  if (typeof satelites !== 'number' || !Number.isFinite(satelites)) return 'Sin GPS';
  const n = Math.max(0, Math.round(satelites));
  return `Sin GPS (${n} ${n === 1 ? 'satélite' : 'satélites'})`;
}

/**
 * Coordenadas para copiar y pegar. Seis decimales son ~10 cm: más de lo que
 * el filtro de la app puede estimar, pero redondear a menos movería el punto
 * que el equipo de tierra pega en su mapa. Van con punto y separadas por coma
 * porque es lo que entienden todos los buscadores de mapas.
 */
export function coordenadas(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

const PUNTOS_CARDINALES = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'] as const;

/**
 * Lo que se muestra cuando la app no pudo estimar un número. La app manda
 * `null` en lugar de NaN (org.json no acepta NaN: ver `numero()` en
 * CommandCenterClient.kt), y un `null` que llegaba acá rompía todo: el
 * `toFixed` de la velocidad tiraba un TypeError en pleno render y, sin un
 * límite de errores, la consola entera quedaba en blanco. El rumbo no rompía,
 * pero `Math.round(null)` es 0 y decía "0° N": inventaba que el objetivo iba
 * para el norte.
 */
const SIN_ESTIMAR = '—';

/** "118° SE": el número para el que navega y la letra para el que corre. */
export function rumbo(grados: number | null | undefined): string {
  if (typeof grados !== 'number' || !Number.isFinite(grados)) return SIN_ESTIMAR;
  const normal = ((Math.round(grados) % 360) + 360) % 360;
  return `${normal}° ${PUNTOS_CARDINALES[Math.round(normal / 45) % 8]}`;
}

/** La velocidad en las dos unidades: m/s es la del contrato, km/h la que se entiende. */
export function velocidad(metrosPorSegundo: number | null | undefined): string {
  if (typeof metrosPorSegundo !== 'number' || !Number.isFinite(metrosPorSegundo)) return SIN_ESTIMAR;
  return `${metrosPorSegundo.toFixed(1)} m/s (${Math.round(metrosPorSegundo * 3.6)} km/h)`;
}

/** "hace 4 s": cuánto hace que la detección vio al objetivo. */
export function haceCuanto(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return 'hace menos de 1 s';
  const s = Math.round(ms / 1000);
  return s < 60 ? `hace ${s} s` : `hace ${Math.floor(s / 60)} min ${s % 60} s`;
}

const dosCifras = (n: number) => String(n).padStart(2, '0');

/**
 * Un cronómetro: cuánto lleva esperando una alerta, "00:08:17". Pasado un día
 * se antepone la cuenta de días ("2 d 03:14:05") en vez de llegar a "51:14:05",
 * que a la pasada se lee como minutos. Lo que no es una cuenta válida
 * (negativo, NaN) es cero: el reloj del navegador puede ir atrás del servidor.
 */
export function cronometro(segundos: number): string {
  const s = Number.isFinite(segundos) && segundos > 0 ? Math.floor(segundos) : 0;
  const dias = Math.floor(s / 86_400);
  const reloj = `${dosCifras(Math.floor((s % 86_400) / 3600))}:${dosCifras(Math.floor((s % 3600) / 60))}:${dosCifras(s % 60)}`;
  return dias > 0 ? `${dias} d ${reloj}` : reloj;
}

export function tipoDeObjetivo(tipo: ObjetivoEnSeguimiento['type'] | string): string {
  return tipo === 'PERSON' ? 'Persona' : tipo === 'VEHICLE' ? 'Vehículo' : tipo;
}

/** Cómo va el seguimiento, en una palabra que se lee de lejos. */
export function situacionDelObjetivo(objetivo: ObjetivoEnSeguimiento): string {
  if (objetivo.lost) return 'Perdido';
  return objetivo.moving ? 'En movimiento' : 'Quieto';
}

export function decisionDelObjetivo(objetivo: ObjetivoEnSeguimiento): string {
  return objetivo.decision === 'VALIDATED' ? 'Validada por un operador' : 'Sin decidir';
}

// ---- Alertas y registro ----
// Los usan el detalle de un evento y el de una alerta, que viven en archivos
// distintos y se muestran uno adentro del otro: si cada uno tuviera su copia,
// la misma fecha se leería de dos formas en el mismo pop-up.

/** Rótulo de la pastilla de una alerta. Un tipo que la consola no conoce se muestra tal cual. */
export function tipoDeAlerta(tipo: string): string {
  if (tipo === 'PERSON') return 'PERSONA';
  if (tipo === 'VEHICLE') return 'VEHÍCULO';
  return tipo;
}

/**
 * Fecha y hora para leer con calma: el detalle de un evento o de una alerta.
 * Las columnas comparadas son angostas, y ahí va la corta. Una fila vieja puede
 * traer cualquier cosa en la fecha: se muestra cruda antes que un "Invalid Date".
 */
export function fechaHoraLarga(ts: string | null, estilo: 'long' | 'short' = 'long'): string {
  if (!ts) return '—';
  const fecha = new Date(ts);
  if (Number.isNaN(fecha.getTime())) return ts;
  return fecha.toLocaleString('es-AR', { dateStyle: estilo, timeStyle: estilo === 'long' ? 'medium' : 'short' });
}

/** El identificador del dron es un hash largo: nunca se muestra entero. */
export function hashCorto(hash: string | null | undefined): string {
  if (!hash) return '—';
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

/**
 * "3 min 20 s": un tiempo que el dron calcula (lo que tarda en volver, lo que
 * tarda el relevo en llegar). Con el dato que falta, la raya.
 */
export function duracion(segundos: number | null | undefined): string {
  if (typeof segundos !== 'number' || !Number.isFinite(segundos) || segundos < 0) return SIN_ESTIMAR;
  const s = Math.round(segundos);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  return s % 60 === 0 ? `${min} min` : `${min} min ${s % 60} s`;
}

/**
 * Rótulos de los eventos que deja el hub con los relevos, los desvíos y las
 * emergencias (§7 del contrato). En la lista se sigue viendo el código —es lo
 * que se busca en el Registro—; el rótulo va en el detalle y en el globo de
 * ayuda, para que nadie tenga que adivinar qué es un `RELAY_HANDOVER`.
 */
export const ETIQUETAS_DE_EVENTO: Record<string, string> = {
  RELAY_REQUESTED: 'Pidió un relevo',
  RELAY_ASSIGNED: 'Relevo asignado',
  RELAY_REJECTED: 'Relevo rechazado',
  RELAY_STARTED: 'Relevo en camino',
  RELAY_HANDOVER: 'Traspaso del objetivo',
  RELAY_COMPLETED: 'Relevo completado',
  RELAY_UNAVAILABLE: 'Sin relevo disponible',
  RELAY_CANCELLED: 'Relevo cancelado',
  RELAY_FAILED: 'Relevo fallido',
  RTH_DIVERTED: 'Regreso desviado',
  EMERGENCY_LANDING: 'Aterrizaje de emergencia',
  EMERGENCY_LANDED: 'Aterrizó fuera de base',
  EMERGENCY_RECOVERED: 'Dron recuperado',
  // El control manual entre personas (PROTOCOLS, "Control manual").
  CONTROL_REQUESTED: 'Pidió el control',
  CONTROL_TRANSFERRED: 'El control cambió de manos',
  CONTROL_REQUEST_ENDED: 'Pedido de control terminado',
};

/** El rótulo de un tipo de evento, o `null` si la consola no le conoce uno. */
export function etiquetaDeEvento(tipo: string): string | null {
  return ETIQUETAS_DE_EVENTO[tipo] ?? null;
}

/**
 * Los tipos de evento que se resaltan en una lista de eventos (el historial de
 * un dron y el Registro): en óxido lo grave, en ámbar lo que hay que mirar.
 */
const TONO_DE_EVENTO: Record<string, 'bad' | 'warn'> = {
  ALERT_CREATED: 'bad',
  ALERT_VALIDATED: 'warn',
  SIGNAL_LOST: 'bad',
  RTH_LOW_BATTERY: 'warn',
  RTH_SIGNAL_LOSS: 'warn',
  // Un dron que bajó fuera de base es lo más grave que puede pasar en vuelo;
  // un relevo que falla o que no encuentra dron deja un hueco en la guardia.
  EMERGENCY_LANDING: 'bad',
  EMERGENCY_LANDED: 'bad',
  RELAY_FAILED: 'bad',
  RELAY_UNAVAILABLE: 'warn',
  RTH_DIVERTED: 'warn',
};

/** El tono de un tipo de evento en la lista, o '' si va con la tinta de siempre. */
export function tonoDeEvento(tipo: string): 'bad' | 'warn' | '' {
  return TONO_DE_EVENTO[tipo] ?? '';
}

/** Las coordenadas de `coordenadas`, o la raya si el dato no vino. */
export function coordenadasODato(lat: number | null | undefined, lon: number | null | undefined): string {
  if (typeof lat !== 'number' || typeof lon !== 'number') return '—';
  return coordenadas(lat, lon);
}
