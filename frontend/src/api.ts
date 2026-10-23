import type {
  BaseAsset,
  PatrolRoute,
  CamposMeta,
  Drone,
  Emergencia,
  EmergenciaConFotos,
  EventRow,
  MetaAlerta,
  MetaDron,
  MetaEmergencia,
  MetaEvento,
  MetaUbicacion,
  PaginaLogs,
  Relevo,
  RolConsola,
  TamanioPagina,
  UserView,
} from './types';

const TOKEN_KEY = 'cc_token';
const USER_KEY = 'cc_user';
const ROLE_KEY = 'cc_role';

/** Los únicos tamaños de página que respeta GET /api/logs. */
export const TAMANIOS_PAGINA: readonly TamanioPagina[] = [25, 50, 75, 100];

export const TAMANIO_PAGINA_POR_DEFECTO: TamanioPagina = 25;

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUsername(): string {
  return localStorage.getItem(USER_KEY) ?? '';
}

function esRolConsola(valor: string | null): valor is RolConsola {
  return valor === 'field_operator' || valor === 'operator' || valor === 'supervisor' || valor === 'admin';
}

/**
 * Rol que informó el login, para pintar la navegación sin esperar a /api/me.
 * Es puro adorno: quién puede hacer qué lo decide el backend en cada pedido.
 */
export function getRole(): RolConsola | null {
  const guardado = localStorage.getItem(ROLE_KEY);
  return esRolConsola(guardado) ? guardado : null;
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ROLE_KEY);
}

/**
 * Avisa al backend que la sesión se cierra. Es lo que deja el
 * `FIELD_SESSION_CLOSED` cuando el que sale es un operador de campo, así que va
 * antes de borrar el token; si falla, la sesión local se cierra igual: un aviso
 * perdido no puede dejar a nadie adentro de la consola.
 */
export async function cerrarSesion(motivo = 'salida de la consola'): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ motivo }),
    });
  } catch {
    /* el backend puede estar caído: no es motivo para quedarse con la sesión abierta */
  }
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'Error de autenticación');
  localStorage.setItem(TOKEN_KEY, body.token);
  localStorage.setItem(USER_KEY, body.user.username);
  if (typeof body.user?.role === 'string') localStorage.setItem(ROLE_KEY, body.user.role);
}

/**
 * Un pedido que el backend rechazó, con su código HTTP. El texto sigue siendo
 * el que manda el backend; el código está para que quien llama distinga un
 * rechazo de otro sin comparar mensajes, que el backend puede reescribir.
 */
export class ErrorDeApi extends Error {
  readonly status: number;

  constructor(mensaje: string, status: number) {
    super(mensaje);
    this.name = 'ErrorDeApi';
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...options.headers,
    },
  });
  if (res.status === 401) {
    clearSession();
    window.location.reload();
    throw new ErrorDeApi('Sesión expirada', 401);
  }
  const body = await res.json();
  if (!res.ok) throw new ErrorDeApi(body.error ?? `Error ${res.status}`, res.status);
  return body as T;
}

/**
 * Por qué no se pudo decidir una alerta, dicho para el operador. Antes estos
 * rechazos iban a `console.error` y el operador apretaba "Validar" sin que
 * pasara nada: creía que había decidido y el dron seguía esperando.
 *
 * El 409 es el caso que más va a ver: dos operadores miran la misma alerta y
 * el segundo llega tarde. No es un error suyo, y lo que le sirve saber es que
 * la alerta ya está resuelta, no el texto genérico del backend.
 */
export function motivoDelRechazoDeDecision(e: unknown): string {
  if (e instanceof ErrorDeApi) {
    if (e.status === 409) return 'Esta alerta ya la decidió otro operador: la lista se actualiza sola.';
    if (e.status === 404) return 'La alerta ya no existe.';
    if (e.status === 401) return 'La sesión venció: volvé a iniciar sesión para decidir la alerta.';
    if (e.status === 403) return 'Tu usuario no puede decidir alertas.';
  }
  const detalle = e instanceof Error ? e.message : String(e);
  return `No se pudo registrar la decisión: ${detalle}`;
}

// ---- Query strings ----

type ValorQuery = string | number | boolean | null | undefined;

/**
 * Arma el `?a=1&b=2` salteando lo vacío, para que ninguna vista tenga que
 * acordarse de encodear ni de cuándo va `?` y cuándo `&`.
 */
export function armarQuery(params: Record<string, ValorQuery>): string {
  const q = new URLSearchParams();
  for (const [clave, valor] of Object.entries(params)) {
    if (valor === undefined || valor === null || valor === '') continue;
    q.set(clave, String(valor));
  }
  const cadena = q.toString();
  return cadena ? `?${cadena}` : '';
}

export type ParametrosLogs = {
  /** Vacío o ausente = todas las categorías. */
  category?: EventRow['category'] | '';
  /** 1-based. */
  page?: number;
  pageSize?: TamanioPagina;
  droneId?: string;
  /** Busca en mensaje, tipo y origen. */
  q?: string;
};

export function traerLogs(params: ParametrosLogs = {}): Promise<PaginaLogs> {
  return api<PaginaLogs>(`/logs${armarQuery(params)}`);
}

/** `incluirEliminados` solo lo respeta el backend para supervisor+. */
export function traerDrones(opts: { incluirEliminados?: boolean } = {}): Promise<Drone[]> {
  return api<Drone[]>(`/drones${armarQuery({ includeDeleted: opts.incluirEliminados ? 1 : undefined })}`);
}

export function traerUsuarios(opts: { incluirEliminados?: boolean } = {}): Promise<UserView[]> {
  return api<UserView[]>(`/users${armarQuery({ includeDeleted: opts.incluirEliminados ? 1 : undefined })}`);
}

export function traerBases(opts: { incluirEliminadas?: boolean; soloActivas?: boolean } = {}): Promise<BaseAsset[]> {
  return api<BaseAsset[]>(
    `/bases${armarQuery({
      includeDeleted: opts.incluirEliminadas ? 1 : undefined,
      soloActivas: opts.soloActivas ? 1 : undefined,
    })}`,
  );
}

export function buscarUsuarios(opts: { incluirEliminados?: boolean; q?: string } = {}): Promise<UserView[]> {
  return api<UserView[]>(
    `/users${armarQuery({ includeDeleted: opts.incluirEliminados ? 1 : undefined, q: opts.q || undefined })}`,
  );
}

export function traerRutas(opts: { incluirEliminadas?: boolean; baseId?: number } = {}): Promise<PatrolRoute[]> {
  return api<PatrolRoute[]>(
    `/routes${armarQuery({ includeDeleted: opts.incluirEliminadas ? 1 : undefined, baseId: opts.baseId })}`,
  );
}

export function rutasDeBase(baseId: number): Promise<PatrolRoute[]> {
  return api<PatrolRoute[]>(`/bases/${baseId}/routes`);
}

// ---- Relevos y emergencias ----
// La consola los pide al montar y en cada reconexión del socket (§3 del
// contrato: no llegan solos al conectarse), y de ahí en más los mantiene con
// `relay_updated` y `emergency_updated`.

/** Los relevos activos (RESERVADO … SIN_RELEVO). Operador o más. */
export function traerRelevosActivos(): Promise<Relevo[]> {
  return api<Relevo[]>(`/relevos${armarQuery({ activos: 1 })}`);
}

/** Las emergencias que nadie marcó recuperadas. Operador de campo o más. */
export function traerEmergenciasAbiertas(): Promise<Emergencia[]> {
  return api<Emergencia[]>(`/emergencias${armarQuery({ abiertas: 1 })}`);
}

/** Una emergencia con sus fotos, ordenadas por `seq`. */
export function traerEmergencia(id: number): Promise<EmergenciaConFotos> {
  return api<EmergenciaConFotos>(`/emergencias/${id}`);
}

/** Cierra la emergencia: el dron ya está en manos del equipo. Devuelve la emergencia sin fotos. */
export function marcarEmergenciaRecuperada(id: number): Promise<Emergencia> {
  return api<Emergencia>(`/emergencias/${id}/recuperada`, { method: 'POST' });
}

/**
 * Por qué no se pudo marcar recuperada, dicho para el operador. El 409 es el
 * caso esperable: dos personas del equipo la marcan a la vez, y al segundo le
 * sirve saber que ya está hecho, no el texto del backend.
 */
export function motivoDelRechazoDeRecuperacion(e: unknown): string {
  if (e instanceof ErrorDeApi) {
    if (e.status === 409) return 'Otra persona ya la marcó como recuperada: la ficha se actualiza sola.';
    if (e.status === 404) return 'La emergencia ya no existe.';
    if (e.status === 403) return 'Tu usuario no puede marcar emergencias como recuperadas.';
  }
  const detalle = e instanceof Error ? e.message : String(e);
  return `No se pudo marcar como recuperada: ${detalle}`;
}

/**
 * Distancia en metros entre dos coordenadas (haversine). La consola la necesita
 * para ordenar las rutas por cercanía y para avisar cuando el primer nodo de
 * una ruta queda lejos de la base a la que se la está asignando.
 */
export function distanciaM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Umbral a partir del cual asignar una ruta a una base pide confirmación. */
export const LEJOS_M = 1_000;

// ---- `meta` de los eventos ----

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor !== '' ? valor : undefined;
}

function numero(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/**
 * Se queda solo con los escalares: la comparación antes/después va campo a
 * campo en una fila, y un objeto anidado no tiene cómo pintarse ahí.
 */
function camposPlanos(valor: unknown): CamposMeta | undefined {
  if (!esObjeto(valor)) return undefined;
  const campos: CamposMeta = {};
  for (const [clave, v] of Object.entries(valor)) {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') campos[clave] = v;
  }
  return Object.keys(campos).length > 0 ? campos : undefined;
}

function leerUbicacion(valor: unknown): MetaUbicacion | undefined {
  if (!esObjeto(valor)) return undefined;
  const lat = numero(valor.lat);
  const lon = numero(valor.lon);
  // Sin par de coordenadas no hay mapa que dibujar.
  if (lat === null || lon === null) return undefined;
  return { lat, lon, accuracyM: numero(valor.accuracyM) };
}

function leerAlerta(valor: unknown): MetaAlerta | undefined {
  if (!esObjeto(valor)) return undefined;
  const id = numero(valor.id);
  // Sin id no se puede traer la alerta completa, así que no vale la pena.
  if (id === null) return undefined;
  return {
    id,
    tipo: texto(valor.tipo) ?? '',
    lat: numero(valor.lat),
    lon: numero(valor.lon),
    ts: texto(valor.ts) ?? null,
  };
}

function leerEmergencia(valor: unknown): MetaEmergencia | undefined {
  if (!esObjeto(valor)) return undefined;
  const id = numero(valor.id);
  // Como la alerta: sin id no hay ficha que traer.
  if (id === null) return undefined;
  return {
    id,
    motivo: texto(valor.motivo) ?? '',
    lat: numero(valor.lat),
    lon: numero(valor.lon),
    ts: texto(valor.ts) ?? null,
  };
}

function leerDron(valor: unknown): MetaDron | undefined {
  if (!esObjeto(valor)) return undefined;
  const hash = texto(valor.hash);
  const displayName = texto(valor.displayName);
  if (!hash && !displayName) return undefined;
  return { hash: hash ?? '', displayName: displayName ?? '', model: texto(valor.model) ?? '' };
}

/**
 * Lee el `meta` de un evento. Es JSON guardado en la base: puede venir nulo,
 * roto o con la forma de una versión vieja del sistema, y nada de eso puede
 * tumbar la consola, así que lo que no se entiende simplemente no viaja.
 */
export function parsearMeta(meta: EventRow['meta']): MetaEvento {
  if (!meta) return {};
  let crudo: unknown;
  try {
    crudo = JSON.parse(meta);
  } catch {
    return {};
  }
  if (!esObjeto(crudo)) return {};
  return {
    antes: camposPlanos(crudo.antes),
    despues: camposPlanos(crudo.despues),
    ubicacion: leerUbicacion(crudo.ubicacion),
    alerta: leerAlerta(crudo.alerta),
    emergencia: leerEmergencia(crudo.emergencia),
    drone: leerDron(crudo.drone),
    detalle: camposPlanos(crudo.detalle),
    por: texto(crudo.por),
    decision: texto(crudo.decision),
    dispositivo: texto(crudo.dispositivo),
  };
}
