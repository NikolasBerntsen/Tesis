import fs from 'node:fs';
import path from 'node:path';

// El contrato compartido de relevos y emergencias (docs/contrato/relevos.json).
// Lo leen las pruebas del backend y las de la app: si el contrato cambia,
// cambian juntos el documento, el archivo y las dos puntas.

export interface Ejemplo {
  caso: string;
  porque?: string;
  mensaje: Record<string, any>;
}

export interface Ejemplos {
  validos: Ejemplo[];
  invalidos: Ejemplo[];
}

/** Relativo a la raíz del repo, como dice PROTOCOLS §1.b. */
export const CONTRATO = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../docs/contrato/relevos.json'), 'utf8'),
) as {
  limites: Record<string, number | string>;
  plazos: Record<string, number>;
  enumerados: Record<string, any>;
  drones: Record<string, { droneId: string; displayName: string }>;
  mensajes: Record<'app_al_hub' | 'hub_a_la_app' | 'hub_a_la_consola', Record<string, Ejemplos>>;
  rest: Record<string, any>;
  eventos: Record<string, any>;
};

export function ejemplos(direccion: 'app_al_hub' | 'hub_a_la_app' | 'hub_a_la_consola', tipo: string): Ejemplos {
  const e = CONTRATO.mensajes[direccion][tipo];
  if (!e) throw new Error(`el contrato no tiene ejemplos de ${direccion}.${tipo}`);
  return { validos: e.validos ?? [], invalidos: e.invalidos ?? [] };
}

// ---- Validadores de lo que el hub le manda a la app (§2.b) ----
//
// Son de las PRUEBAS, no del hub: el hub arma sus mensajes y estas funciones
// dicen si cumplen el contrato con la misma vara que va a usar la app. Antes de
// usarlas sobre lo que sale del hub, la prueba de conformidad las pasa por los
// ejemplos válidos e inválidos del archivo compartido, así que una función
// floja acá no puede hacer pasar un mensaje roto.

const HASH = /^[0-9a-f]{32}$/;

const esId = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;
const esIdONull = (v: unknown) => v === null || esId(v);
const esIndice = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const esNum = (v: unknown, min: number, max: number) => Number.isFinite(v) && (v as number) >= min && (v as number) <= max;
const esTexto = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;
const esPosicion = (lat: unknown, lon: unknown) =>
  esNum(lat, -90, 90) && esNum(lon, -180, 180) && !(Math.abs(lat as number) < 1e-6 && Math.abs(lon as number) < 1e-6);
const esPosicionONull = (lat: unknown, lon: unknown) => (lat === null && lon === null) || esPosicion(lat, lon);
const esDron = (d: any) => typeof d === 'object' && d !== null && HASH.test(d.droneId) && typeof d.displayName === 'string';

const ESTADOS = ['RESERVADO', 'ORDENADO', 'EN_CAMINO', 'TRASPASO', 'SIN_RELEVO', 'COMPLETADO', 'CANCELADO', 'FALLIDO'];
const MOTIVOS_FIN = ['origen_sin_confirmar', 'orden_del_operador', 'alerta_descartada', 'sin_relevo', 'origen_se_fue',
  'relevo_abortado', 'relevo_desconectado', 'sin_despegue', 'relevo_perdio_estado'];

function esObjetivo(o: any, alertId: unknown, decision: unknown): boolean {
  return (
    typeof o === 'object' && o !== null &&
    o.alertId === alertId &&
    ['PERSON', 'VEHICLE'].includes(o.type) &&
    esPosicion(o.lat, o.lon) &&
    esNum(o.speedMs, 0, 40) &&
    esNum(o.courseDeg, 0, 360) &&
    typeof o.moving === 'boolean' &&
    typeof o.lost === 'boolean' &&
    esIndice(o.lastSeenMs) &&
    o.decision === decision &&
    Number.isFinite(o.vNorteMs) && Number.isFinite(o.vEsteMs) &&
    Math.hypot(o.vNorteMs, o.vEsteMs) <= 40
  );
}

const VALIDADORES_HUB_A_LA_APP: Record<string, (m: any) => boolean> = {
  bases: (m) => {
    if (!Array.isArray(m.bases) || m.bases.length > 200 || !esIdONull(m.propiaId)) return false;
    const buenas = m.bases.every(
      (b: any) =>
        esId(b.id) && esTexto(b.nombre, 1, 60) && esPosicion(b.lat, b.lon) &&
        ((b.aterrizajeLat === null && b.aterrizajeLon === null) ||
          (Number.isFinite(b.aterrizajeLat) && Number.isFinite(b.aterrizajeLon))),
    );
    return buenas && (m.propiaId === null || m.bases.some((b: any) => b.id === m.propiaId));
  },
  relay_status: (m) =>
    esTexto(m.ref, 1, 64) && esId(m.relayId) && ESTADOS.includes(m.estado) &&
    (m.relevo === null || esDron(m.relevo)) &&
    (m.etaS === null || esNum(m.etaS, 0, Number.MAX_SAFE_INTEGER)) &&
    (m.motivoFin === null || MOTIVOS_FIN.includes(m.motivoFin)),
  relay_start: (m) =>
    esId(m.relayId) && m.motivo === 'patrulla' && typeof m.ruta === 'object' && m.ruta !== null &&
    esId(m.ruta.id) && typeof m.ruta.name === 'string' &&
    Array.isArray(m.ruta.waypoints) && m.ruta.waypoints.length >= 2 && m.ruta.waypoints.length <= 60 &&
    m.ruta.waypoints.every(
      (w: any) => esPosicion(w.lat, w.lon) && esNum(w.alt, 0, 500) && (w.label === undefined || esTexto(w.label, 0, 40)),
    ) &&
    esIndice(m.fromIndex) && m.fromIndex < m.ruta.waypoints.length && esDron(m.de),
  relay_tracking: (m) =>
    esId(m.relayId) && esId(m.alertId) && ['PENDING', 'VALIDATED'].includes(m.decision) &&
    esObjetivo(m.objetivo, m.alertId, m.decision) && esDron(m.de) && Number.isSafeInteger(m.ts) && m.ts > 0,
  relay_target: (m) =>
    esId(m.relayId) && esId(m.alertId) && ['PENDING', 'VALIDATED'].includes(m.decision) &&
    esObjetivo(m.objetivo, m.alertId, m.decision) && ['en_linea', 'sin_enlace', 'retirado'].includes(m.origen) &&
    esPosicionONull(m.aLat, m.aLon) && (m.aAlt === null || Number.isFinite(m.aAlt)) &&
    Number.isSafeInteger(m.ts) && m.ts > 0,
  relay_go: (m) => esId(m.relayId),
  relay_done: (m) => esId(m.relayId) && esId(m.alertId) && esDron(m.relevadoPor),
  relay_cancel: (m) => esId(m.relayId) && ['alerta_descartada', 'vencido', 'terminado', 'inexistente'].includes(m.motivo),
  emergency_ack: (m) => esTexto(m.ref, 1, 64) && esId(m.emergencyId) && typeof m.aterrizada === 'boolean',
  emergency_photo_ack: (m) => esTexto(m.ref, 1, 64) && Number.isSafeInteger(m.seq) && m.seq >= 0 && m.seq <= 7,
};

/** Tipos de §2.b que tiene que validar `cumpleContrato`. */
export const TIPOS_HUB_A_LA_APP = Object.keys(VALIDADORES_HUB_A_LA_APP);

/** Si un mensaje del hub a la app cumple su tabla de §2.b. Un tipo que no es de §2.b no cuenta. */
export function cumpleContrato(m: any): boolean {
  const v = VALIDADORES_HUB_A_LA_APP[m?.type];
  return v ? v(m) : true;
}

/** Las claves de un objeto, ordenadas: para comparar formas contra los ejemplos del contrato. */
export function claves(o: object): string[] {
  return Object.keys(o).sort();
}
