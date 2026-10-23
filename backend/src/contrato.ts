/**
 * Validación de los mensajes de relevos, desvíos y emergencias que llegan de la
 * app (PROTOCOLS §1.b) y de los dos campos nuevos del `status` (§1). Todo lo de
 * acá son funciones puras: reciben lo que llegó por la red y devuelven el
 * mensaje ya tipado o el nombre del campo que falló, que es lo que el hub anota
 * en el log del proceso antes de descartarlo.
 *
 * La regla que atraviesa todo el archivo es la de §1.b: **nada se convierte**.
 * `Number(null)` es 0 y `Number('12')` es 12: un nodo, una altura o una batería
 * que nadie mandó. Por eso se pregunta por el tipo (`typeof`, `Number.isFinite`,
 * `Number.isSafeInteger`) y nunca se pasa un valor por `Number(...)`.
 */

/** Por debajo de esto, en grados, una coordenada se toma como cero (~11 cm). */
const CASI_CERO = 1e-6;

/** Límites de §1.b; los mismos números están en docs/contrato/relevos.json. */
export const LIMITES = {
  refMaxCaracteres: 64,
  detalleMaxCaracteres: 200,
  altMinimaM: -200,
  altMaximaM: 1000,
  velocidadObjetivoMaximaMs: 40,
  segundosDisponiblesMaximo: 3600,
  seqMaximo: 7,
  jpegBase64MaxCaracteres: 400_000,
  jpegBase64Prefijo: '/9j/',
  pctMaximo: 100,
  alcanceMaximoM: 100_000,
  segundosParaVolverMaximo: 36_000,
} as const;

export const MOTIVOS_RELAY_REQUEST = ['patrulla', 'seguimiento'] as const;
export const MOTIVOS_RELAY_REJECT = ['no_disponible', 'virtual_stick', 'cancelado_en_campo', 'ocupado', 'mensaje_invalido'] as const;
export const MOTIVOS_RELAY_ABORT = ['subida', 'virtual_stick', 'senial', 'bateria', 'dji', 'orden_de_campo', 'otro'] as const;
export const MOTIVOS_RELAY_ABANDON = ['piso', 'dji', 'orden_del_operador', 'orden_de_campo', 'senial'] as const;
export const MOTIVOS_RTH_DIVERTED = ['otra_base', 'emergencia'] as const;
export const MOTIVOS_EMERGENCIA = ['autonomia', 'bateria_critica_dji'] as const;
export const TIPOS_DE_FOTO = ['oblicua', 'cenital', 'panoramica'] as const;
export const FASES_DEL_ORIGEN = ['pedido', 'ventana', 'soltando', 'aterrizando', 'desviado'] as const;
export const FASES_DEL_RELEVO = ['cuenta_regresiva', 'esperando_despegue', 'despegando', 'en_camino', 'traspaso'] as const;

export type MotivoRelevo = (typeof MOTIVOS_RELAY_REQUEST)[number];
export type MotivoRthDiverted = (typeof MOTIVOS_RTH_DIVERTED)[number];
export type MotivoEmergencia = (typeof MOTIVOS_EMERGENCIA)[number];
export type TipoDeFoto = (typeof TIPOS_DE_FOTO)[number];

/** Lo que devuelve cada validador: el mensaje tipado, o el campo que no pasó. */
export type Validado<T> = { ok: true; valor: T } | { ok: false; campo: string };

/** Mensaje crudo que llegó del celular: cualquier campo puede ser cualquier cosa. */
export type Crudo = Record<string, unknown>;

function bien<T>(valor: T): Validado<T> {
  return { ok: true, valor };
}

function mal<T>(campo: string): Validado<T> {
  return { ok: false, campo };
}

/**
 * Una posición que llega del celular, validada: dos números finitos, dentro de
 * rango y que no sean el 0,0. Devuelve null si no es una posición de verdad, y
 * las dos coordenadas van juntas: una latitud buena con la longitud rota no
 * ubica nada.
 *
 * El 0,0 se descarta porque es lo que entrega el SDK de DJI SIN fix de GPS (su
 * `LocationCoordinate3D` arranca en 0.0, no en NaN): no es una posición, es
 * "no sé". Creerle dibuja al dron en el golfo de Guinea ("Null Island") y deja
 * en el registro un objetivo a miles de kilómetros del equipo de tierra. Nadie
 * patrulla ahí, así que descartarlo no pierde nada real; la comparación es
 * contra un umbral y no contra `=== 0` porque lo que venga redondeado o con
 * ruido del filtro de la app sigue siendo el mismo "no sé".
 *
 * `Number.isFinite` y no `Number(...)` porque no convierte: `Number(null)` es 0
 * y `Number('')` también, así que con la conversión un campo ausente o un texto
 * se colaría como coordenada.
 */
export function posicionValida(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const la = lat as number;
  const lo = lon as number;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  if (Math.abs(la) < CASI_CERO && Math.abs(lo) < CASI_CERO) return null;
  return { lat: la, lon: lo };
}

/** Un `ref` de §1.b: texto de 1 a 64 caracteres, tal cual (no se recorta). */
export function esRef(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.length >= 1 && valor.length <= LIMITES.refMaxCaracteres;
}

/** `relayId`, `alertId`, `routeId`, `baseId`, `emergencyId`: enteros seguros ≥ 1. */
export function esId(valor: unknown): valor is number {
  return Number.isSafeInteger(valor) && (valor as number) >= 1;
}

/** `fromIndex`, `seq`: enteros seguros ≥ 0. */
function esIndice(valor: unknown): valor is number {
  return Number.isSafeInteger(valor) && (valor as number) >= 0;
}

/** Número finito dentro de [min, max]. Un texto, un null o un booleano no lo son. */
export function esNumeroEn(valor: unknown, min: number, max: number): valor is number {
  return Number.isFinite(valor) && (valor as number) >= min && (valor as number) <= max;
}

function esUnoDe<T extends string>(valor: unknown, lista: readonly T[]): valor is T {
  return typeof valor === 'string' && (lista as readonly string[]).includes(valor);
}

/** `ts` del teléfono: entero > 0. Es un dato, nunca un orden (§1.b). */
function esTs(valor: unknown): valor is number {
  return Number.isSafeInteger(valor) && (valor as number) > 0;
}

function esAlt(valor: unknown): valor is number {
  return esNumeroEn(valor, LIMITES.altMinimaM, LIMITES.altMaximaM);
}

/** Un id que la tabla admite en null: tiene que estar, y ser un id o null. */
function esIdONull(valor: unknown): valor is number | null {
  return valor === null || esId(valor);
}

/**
 * "Posición o null": los dos números válidos o los dos null (sin fix). Uno solo
 * en null es inválido, igual que un 0,0. Devuelve undefined si no pasa.
 */
function posicionONull(lat: unknown, lon: unknown): { lat: number | null; lon: number | null } | undefined {
  if (lat === null && lon === null) return { lat: null, lon: null };
  return posicionValida(lat, lon) ?? undefined;
}

/** `detalle` opcional: si viene, texto de hasta 200 caracteres. */
function detalleOpcional(valor: unknown): { ok: boolean; detalle: string | null } {
  if (valor === undefined) return { ok: true, detalle: null };
  if (typeof valor !== 'string' || valor.length > LIMITES.detalleMaxCaracteres) return { ok: false, detalle: null };
  return { ok: true, detalle: valor };
}

// ---- relay_request ----

export type PedidoDeRelevo =
  | { ref: string; motivo: 'patrulla'; routeId: number; fromIndex: number }
  | { ref: string; motivo: 'seguimiento'; alertId: number; segundosDisponibles: number | null };

export function validarRelayRequest(m: Crudo): Validado<PedidoDeRelevo> {
  if (!esRef(m.ref)) return mal('ref');
  if (!esUnoDe(m.motivo, MOTIVOS_RELAY_REQUEST)) return mal('motivo');
  // Los campos del otro motivo se ignoran: cada rama mira solo los suyos.
  if (m.motivo === 'patrulla') {
    if (!esId(m.routeId)) return mal('routeId');
    if (!esIndice(m.fromIndex)) return mal('fromIndex');
    return bien({ ref: m.ref, motivo: 'patrulla', routeId: m.routeId, fromIndex: m.fromIndex });
  }
  if (!esId(m.alertId)) return mal('alertId');
  // El campo tiene que ESTAR aunque valga null: ausente es un mensaje viejo o
  // roto, y null es "sin autonomía informada", que el hub trata distinto.
  if (m.segundosDisponibles === undefined) return mal('segundosDisponibles');
  if (m.segundosDisponibles !== null && !esNumeroEn(m.segundosDisponibles, 0, LIMITES.segundosDisponiblesMaximo)) {
    return mal('segundosDisponibles');
  }
  return bien({
    ref: m.ref,
    motivo: 'seguimiento',
    alertId: m.alertId,
    segundosDisponibles: m.segundosDisponibles,
  });
}

// ---- relay_accept, relay_ready, relay_released ----

export function validarSoloRelayId(m: Crudo): Validado<{ relayId: number }> {
  return esId(m.relayId) ? bien({ relayId: m.relayId }) : mal('relayId');
}

// ---- relay_reject ----

export interface RechazoDeRelevo {
  relayId: number;
  motivo: (typeof MOTIVOS_RELAY_REJECT)[number];
  detalle: string | null;
}

export function validarRelayReject(m: Crudo): Validado<RechazoDeRelevo> {
  if (!esId(m.relayId)) return mal('relayId');
  if (!esUnoDe(m.motivo, MOTIVOS_RELAY_REJECT)) return mal('motivo');
  const d = detalleOpcional(m.detalle);
  if (!d.ok) return mal('detalle');
  return bien({ relayId: m.relayId, motivo: m.motivo, detalle: d.detalle });
}

// ---- relay_abort ----

export interface AbortoDeRelevo {
  relayId: number;
  motivo: (typeof MOTIVOS_RELAY_ABORT)[number];
  detalle: string | null;
}

export function validarRelayAbort(m: Crudo): Validado<AbortoDeRelevo> {
  if (!esId(m.relayId)) return mal('relayId');
  if (!esUnoDe(m.motivo, MOTIVOS_RELAY_ABORT)) return mal('motivo');
  const d = detalleOpcional(m.detalle);
  if (!d.ok) return mal('detalle');
  return bien({ relayId: m.relayId, motivo: m.motivo, detalle: d.detalle });
}

// ---- relay_abandon ----

export interface AbandonoDeRelevo {
  relayId: number;
  motivo: (typeof MOTIVOS_RELAY_ABANDON)[number] | null;
}

export function validarRelayAbandon(m: Crudo): Validado<AbandonoDeRelevo> {
  if (!esId(m.relayId)) return mal('relayId');
  if (m.motivo === undefined) return bien({ relayId: m.relayId, motivo: null });
  if (!esUnoDe(m.motivo, MOTIVOS_RELAY_ABANDON)) return mal('motivo');
  return bien({ relayId: m.relayId, motivo: m.motivo });
}

// ---- landing_at_base y landed_at_base ----

export interface DescensoEnBase {
  ref: string;
  relayId: number | null;
  baseId: number | null;
  lat: number | null;
  lon: number | null;
  routeId: number;
  fromIndex: number;
}

export function validarLandingAtBase(m: Crudo): Validado<DescensoEnBase> {
  if (!esRef(m.ref)) return mal('ref');
  if (!esIdONull(m.relayId)) return mal('relayId');
  if (!esIdONull(m.baseId)) return mal('baseId');
  const pos = posicionONull(m.lat, m.lon);
  if (!pos) return mal('lat/lon');
  if (!esId(m.routeId)) return mal('routeId');
  if (!esIndice(m.fromIndex)) return mal('fromIndex');
  return bien({ ref: m.ref, relayId: m.relayId, baseId: m.baseId, ...pos, routeId: m.routeId, fromIndex: m.fromIndex });
}

export interface AterrizajeEnBase {
  relayId: number | null;
  baseId: number | null;
  lat: number | null;
  lon: number | null;
}

export function validarLandedAtBase(m: Crudo): Validado<AterrizajeEnBase> {
  if (!esIdONull(m.relayId)) return mal('relayId');
  if (!esIdONull(m.baseId)) return mal('baseId');
  const pos = posicionONull(m.lat, m.lon);
  if (!pos) return mal('lat/lon');
  return bien({ relayId: m.relayId, baseId: m.baseId, ...pos });
}

// ---- rth_diverted ----

export interface Desvio {
  relayId: number | null;
  baseId: number | null;
  lat: number | null;
  lon: number | null;
  motivo: MotivoRthDiverted;
}

export function validarRthDiverted(m: Crudo): Validado<Desvio> {
  if (!esIdONull(m.relayId)) return mal('relayId');
  if (!esUnoDe(m.motivo, MOTIVOS_RTH_DIVERTED)) return mal('motivo');
  // Entero con otra_base, null con emergencia: al revés no se sabe qué base
  // bloquear, o se bloquearía una que nadie va a usar.
  if (m.motivo === 'otra_base' ? !esId(m.baseId) : m.baseId !== null) return mal('baseId');
  const pos = posicionONull(m.lat, m.lon);
  if (!pos) return mal('lat/lon');
  return bien({ relayId: m.relayId, baseId: m.baseId as number | null, ...pos, motivo: m.motivo });
}

// ---- emergency_landing, emergency_photo, emergency_landed ----

export interface AvisoDeEmergencia {
  ref: string;
  motivo: MotivoEmergencia;
  lat: number | null;
  lon: number | null;
  alt: number;
  bateria: number;
  ts: number;
}

export function validarEmergencyLanding(m: Crudo): Validado<AvisoDeEmergencia> {
  if (!esRef(m.ref)) return mal('ref');
  if (!esUnoDe(m.motivo, MOTIVOS_EMERGENCIA)) return mal('motivo');
  const pos = posicionONull(m.lat, m.lon);
  if (!pos) return mal('lat/lon');
  if (!esAlt(m.alt)) return mal('alt');
  if (!esNumeroEn(m.bateria, 0, LIMITES.pctMaximo)) return mal('bateria');
  if (!esTs(m.ts)) return mal('ts');
  return bien({ ref: m.ref, motivo: m.motivo, ...pos, alt: m.alt, bateria: m.bateria, ts: m.ts });
}

export interface FotoDeEmergencia {
  ref: string;
  seq: number;
  tipo: TipoDeFoto;
  rumbo: number;
  inclinacion: number;
  lat: number | null;
  lon: number | null;
  alt: number;
  jpegBase64: string;
  ts: number;
}

/**
 * El alfabeto de base64. Con `+` y no `*`: una cadena vacía ya la descarta el
 * largo mínimo, y así el patrón no admite nada que no sea base64.
 */
const BASE64 = /^[A-Za-z0-9+/=]+$/;

/**
 * La foto: de 1 a 400 000 caracteres de base64 que empiezan con `/9j/` (la marca
 * de inicio de un JPEG). El largo se mira ANTES que el patrón para no recorrer
 * con la expresión regular un texto que igual se va a descartar.
 */
function esJpegBase64(valor: unknown): valor is string {
  return (
    typeof valor === 'string' &&
    valor.length >= 1 &&
    valor.length <= LIMITES.jpegBase64MaxCaracteres &&
    valor.startsWith(LIMITES.jpegBase64Prefijo) &&
    BASE64.test(valor)
  );
}

export function validarEmergencyPhoto(m: Crudo): Validado<FotoDeEmergencia> {
  if (!esRef(m.ref)) return mal('ref');
  if (!Number.isSafeInteger(m.seq) || (m.seq as number) < 0 || (m.seq as number) > LIMITES.seqMaximo) return mal('seq');
  if (!esUnoDe(m.tipo, TIPOS_DE_FOTO)) return mal('tipo');
  if (!esNumeroEn(m.rumbo, 0, 360)) return mal('rumbo');
  if (!esNumeroEn(m.inclinacion, -90, 30)) return mal('inclinacion');
  const pos = posicionONull(m.lat, m.lon);
  if (!pos) return mal('lat/lon');
  if (!esAlt(m.alt)) return mal('alt');
  if (!esJpegBase64(m.jpegBase64)) return mal('jpegBase64');
  if (!esTs(m.ts)) return mal('ts');
  return bien({
    ref: m.ref,
    seq: m.seq as number,
    tipo: m.tipo,
    rumbo: m.rumbo,
    inclinacion: m.inclinacion,
    ...pos,
    alt: m.alt,
    jpegBase64: m.jpegBase64,
    ts: m.ts,
  });
}

export interface AterrizajeDeEmergencia {
  ref: string;
  lat: number | null;
  lon: number | null;
  alt: number;
  ts: number;
}

export function validarEmergencyLanded(m: Crudo): Validado<AterrizajeDeEmergencia> {
  if (!esRef(m.ref)) return mal('ref');
  const pos = posicionONull(m.lat, m.lon);
  if (!pos) return mal('lat/lon');
  if (!esAlt(m.alt)) return mal('alt');
  if (!esTs(m.ts)) return mal('ts');
  return bien({ ref: m.ref, ...pos, alt: m.alt, ts: m.ts });
}

// ---- status.relevo y status.autonomia (§1) ----

export interface RelevoInformado {
  enEspera: boolean;
  disponible: boolean;
  relayId: number | null;
  rol: 'origen' | 'relevo' | null;
  fase: string | null;
}

/**
 * `status.relevo` validado, o null si no pasa. Un dron con un `relevo` que no
 * pasa no es candidato a nada: el hub lo saca del status y lo trata como una
 * app vieja (§1).
 */
export function validarRelevoInformado(v: unknown): RelevoInformado | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Crudo;
  if (typeof r.enEspera !== 'boolean' || typeof r.disponible !== 'boolean') return null;
  // Disponible sin el interruptor prendido es una app que se contradice: lo
  // único seguro es no creerle que puede despegar sola.
  if (r.disponible && !r.enEspera) return null;
  if (r.relayId === null) {
    return r.rol === null && r.fase === null
      ? { enEspera: r.enEspera, disponible: r.disponible, relayId: null, rol: null, fase: null }
      : null;
  }
  if (!esId(r.relayId)) return null;
  if (r.rol === 'origen' && esUnoDe(r.fase, FASES_DEL_ORIGEN)) {
    return { enEspera: r.enEspera, disponible: r.disponible, relayId: r.relayId, rol: 'origen', fase: r.fase };
  }
  if (r.rol === 'relevo' && esUnoDe(r.fase, FASES_DEL_RELEVO)) {
    return { enEspera: r.enEspera, disponible: r.disponible, relayId: r.relayId, rol: 'relevo', fase: r.fase };
  }
  return null;
}

export interface AutonomiaInformada {
  pctParaVolver: number | null;
  pctParaAterrizar: number | null;
  alcanceM: number | null;
  segundosParaVolver: number | null;
}

/** Cada campo de `autonomia`: número en rango o null. Ausente tampoco vale. */
function campoDeAutonomia(valor: unknown, max: number): boolean {
  return valor === null || esNumeroEn(valor, 0, max);
}

/** `status.autonomia` validada, o null si algún campo no pasa (§1: invalida el objeto entero). */
export function validarAutonomia(v: unknown): AutonomiaInformada | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const a = v as Crudo;
  const ok =
    campoDeAutonomia(a.pctParaVolver, LIMITES.pctMaximo) &&
    campoDeAutonomia(a.pctParaAterrizar, LIMITES.pctMaximo) &&
    campoDeAutonomia(a.alcanceM, LIMITES.alcanceMaximoM) &&
    campoDeAutonomia(a.segundosParaVolver, LIMITES.segundosParaVolverMaximo);
  if (!ok) return null;
  return {
    pctParaVolver: a.pctParaVolver as number | null,
    pctParaAterrizar: a.pctParaAterrizar as number | null,
    alcanceM: a.alcanceM as number | null,
    segundosParaVolver: a.segundosParaVolver as number | null,
  };
}

// ---- Objetivo de un relevo (§2.b) ----

export interface Objetivo {
  alertId: number;
  type: 'PERSON' | 'VEHICLE';
  lat: number;
  lon: number;
  speedMs: number;
  courseDeg: number;
  moving: boolean;
  lost: boolean;
  lastSeenMs: number;
  decision: 'PENDING' | 'VALIDATED';
  vNorteMs: number;
  vEsteMs: number;
}

const VELOCIDAD_MAXIMA = LIMITES.velocidadObjetivoMaximaMs;

/**
 * Componentes de la velocidad del objetivo: los que mandó la app, o calculados
 * de `speedMs`/`courseDeg` si es una app vieja que no los manda (§1, `target`).
 * Mandar uno solo, o alguno que no sea un número, no es "una app vieja": es un
 * objetivo roto, y devuelve null.
 */
function velocidadDelObjetivo(t: Crudo, speedMs: number, courseDeg: number, moving: boolean) {
  if (t.vNorteMs === undefined && t.vEsteMs === undefined) {
    if (!moving) return { vNorteMs: 0, vEsteMs: 0 };
    const rumbo = (courseDeg * Math.PI) / 180;
    return { vNorteMs: speedMs * Math.cos(rumbo), vEsteMs: speedMs * Math.sin(rumbo) };
  }
  if (!Number.isFinite(t.vNorteMs) || !Number.isFinite(t.vEsteMs)) return null;
  const vNorteMs = t.vNorteMs as number;
  const vEsteMs = t.vEsteMs as number;
  if (Math.hypot(vNorteMs, vEsteMs) > VELOCIDAD_MAXIMA) return null;
  return { vNorteMs, vEsteMs };
}

/**
 * El objetivo del `status.target` de A, listo para reenviárselo a B, o null si
 * no pasa (y entonces no sale `relay_target` por ese status: B se queda con el
 * anterior). Solo copia los campos del contrato, para que lo que A agregue de
 * más no viaje a B sin que nadie lo haya validado.
 *
 * `decision` la pisa el hub con la de la alerta en la base, que es la que
 * manda, y `type` tiene que ser el de la alerta: un objetivo de otra clase no
 * es el que B tiene que ir a buscar.
 */
export function validarObjetivo(
  v: unknown,
  alerta: { id: number; type: 'PERSON' | 'VEHICLE' },
  decision: 'PENDING' | 'VALIDATED',
): Objetivo | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const t = v as Crudo;
  if (t.alertId !== alerta.id || t.type !== alerta.type) return null;
  const pos = posicionValida(t.lat, t.lon);
  if (!pos) return null;
  if (!esNumeroEn(t.speedMs, 0, VELOCIDAD_MAXIMA) || !esNumeroEn(t.courseDeg, 0, 360)) return null;
  if (typeof t.moving !== 'boolean' || typeof t.lost !== 'boolean') return null;
  if (!esIndice(t.lastSeenMs)) return null;
  const velocidad = velocidadDelObjetivo(t, t.speedMs, t.courseDeg, t.moving);
  if (!velocidad) return null;
  return {
    alertId: alerta.id,
    type: alerta.type,
    ...pos,
    speedMs: t.speedMs,
    courseDeg: t.courseDeg,
    moving: t.moving,
    lost: t.lost,
    lastSeenMs: t.lastSeenMs,
    decision,
    ...velocidad,
  };
}
