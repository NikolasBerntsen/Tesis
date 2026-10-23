import {
  posicionValida, validarEmergencyLanded, validarEmergencyLanding, validarEmergencyPhoto,
  type AterrizajeDeEmergencia, type AvisoDeEmergencia, type Crudo, type FotoDeEmergencia, type MotivoEmergencia,
  type TipoDeFoto, type Validado,
} from './contrato';
import { db } from './db';
import { metaDron, nombreDeDron } from './meta';
import { createLog } from './store';

// Protocolo de última ubicación del lado del hub (RELEVOS §5; contrato en
// PROTOCOLS §1.b, §2.b, §3 y §5). Un dron que no llega a ninguna base aterriza
// donde puede y manda dónde quedó y unas fotos del lugar: el hub guarda todo y
// lo deja a la vista hasta que alguien marca la emergencia recuperada, porque
// es la única pista que tiene el equipo de tierra para ir a buscarlo.
//
// Todo es idempotente: los mensajes salen de una cola de la app que reintenta
// hasta el acuse, así que un mismo aviso puede llegar varias veces.

/** Una emergencia abierta y sin aterrizar de hace menos de esto se reutiliza (§1.b). */
const REUSO_EMERGENCIA_ABIERTA_MS = 30 * 60 * 1000;

export interface DependenciasEmergencias {
  enviar: (droneId: string, msg: Record<string, unknown>) => boolean;
  difundir: (msg: { type: string; [clave: string]: unknown }) => void;
  ahora: () => number;
  /** El dron tocó tierra fuera de una base: el coordinador de relevos cierra lo que esperaba que aterrizara en una. */
  alAterrizar: (droneId: string) => void;
}

/** El objeto emergencia de PROTOCOLS §3, sin fotos (`fotos` es la cantidad). */
export interface EmergenciaView {
  id: number;
  droneId: string;
  displayName: string;
  motivo: MotivoEmergencia;
  lat: number | null;
  lon: number | null;
  alt: number;
  bateria: number;
  ts: number;
  creadaEn: string;
  aterrizadaEn: string | null;
  aterrizajeLat: number | null;
  aterrizajeLon: number | null;
  aterrizajeAlt: number | null;
  recuperadaEn: string | null;
  recuperadaPor: string | null;
  fotos: number;
}

export interface FotoView {
  seq: number;
  tipo: TipoDeFoto;
  rumbo: number;
  inclinacion: number;
  lat: number | null;
  lon: number | null;
  alt: number;
  ts: number;
  jpegBase64: string;
}

export type EmergenciaConFotos = Omit<EmergenciaView, 'fotos'> & { fotos: FotoView[] };

interface FilaEmergencia {
  id: number;
  drone_id: string;
  motivo: MotivoEmergencia;
  lat: number | null;
  lon: number | null;
  alt: number;
  bateria: number;
  ts: number;
  creada_en: string;
  aterrizada_en: string | null;
  aterrizaje_lat: number | null;
  aterrizaje_lon: number | null;
  aterrizaje_alt: number | null;
  recuperada_en: string | null;
  recuperada_por: string | null;
  fotos: number;
}

/** Cada emergencia con la cantidad de fotos que llegaron. */
const SELECT_EMERGENCIA = `SELECT e.*, (SELECT COUNT(*) FROM emergencia_fotos f WHERE f.emergencia_id = e.id) AS fotos
                             FROM emergencias e`;

function aVista(f: FilaEmergencia): EmergenciaView {
  return {
    id: f.id,
    droneId: f.drone_id,
    displayName: nombreDeDron(f.drone_id),
    motivo: f.motivo,
    lat: f.lat,
    lon: f.lon,
    alt: f.alt,
    bateria: f.bateria,
    ts: f.ts,
    creadaEn: f.creada_en,
    aterrizadaEn: f.aterrizada_en,
    aterrizajeLat: f.aterrizaje_lat,
    aterrizajeLon: f.aterrizaje_lon,
    aterrizajeAlt: f.aterrizaje_alt,
    recuperadaEn: f.recuperada_en,
    recuperadaPor: f.recuperada_por,
    fotos: f.fotos,
  };
}

/** La clave `emergencia` de la `meta` (PROTOCOLS §7): `ts` es `creadaEn`. */
function metaEmergencia(e: EmergenciaView) {
  return { id: e.id, motivo: e.motivo, lat: e.lat, lon: e.lon, ts: e.creadaEn };
}

function ubicacionDe(lat: number | null, lon: number | null) {
  const pos = posicionValida(lat, lon);
  return pos ? { ubicacion: { ...pos, accuracyM: null } } : {};
}

const MOTIVO_LEGIBLE: Record<MotivoEmergencia, string> = {
  autonomia: 'no le alcanza la batería para llegar a ninguna base',
  bateria_critica_dji: 'el propio DJI forzó el aterrizaje por batería crítica',
};

export type ResultadoRecuperada = { ok: true; emergencia: EmergenciaView } | { ok: false; status: 404 | 409 };

export class Emergencias {
  private readonly deps: DependenciasEmergencias;

  constructor(deps: DependenciasEmergencias) {
    this.deps = deps;
  }

  private obtener(id: number): EmergenciaView | undefined {
    const f = db.prepare(`${SELECT_EMERGENCIA} WHERE e.id = ?`).get(id) as FilaEmergencia | undefined;
    return f ? aVista(f) : undefined;
  }

  private deRef(droneId: string, ref: string): EmergenciaView | undefined {
    const f = db.prepare('SELECT emergencia_id AS id FROM emergencia_refs WHERE drone_id = ? AND ref = ?').get(droneId, ref) as
      | { id: number }
      | undefined;
    return f ? this.obtener(f.id) : undefined;
  }

  private difundir(e: EmergenciaView): void {
    this.deps.difundir({ type: 'emergency_updated', emergencia: e });
  }

  private registrar(e: EmergenciaView, tipo: string, mensaje: string, meta: Record<string, unknown>): void {
    const ev = createLog('drone', tipo, 'backend', mensaje, {
      droneId: e.droneId,
      meta: { drone: metaDron(e.droneId), emergencia: metaEmergencia(e), ...meta },
    });
    this.deps.difundir({ type: 'event', event: ev });
  }

  /** Los tres mensajes de la emergencia (§1.b). Devuelve false si el `type` no es de acá. */
  alRecibirMensaje(droneId: string, msg: Crudo): boolean {
    switch (msg.type) {
      case 'emergency_landing':
        return procesar(droneId, msg, validarEmergencyLanding, (v) => this.abrir(droneId, v));
      case 'emergency_photo':
        return procesar(droneId, msg, validarEmergencyPhoto, (v) => this.guardarFoto(droneId, v));
      case 'emergency_landed':
        return procesar(droneId, msg, validarEmergencyLanded, (v) => this.aterrizada(droneId, v));
      default:
        return false;
    }
  }

  /**
   * Abre la emergencia, o devuelve la que ya tiene: por el mismo ref (un
   * reintento), o una abierta, sin aterrizar y de menos de 30 minutos del mismo
   * dron (la app se reinició en el medio y perdió el ref). Contesta siempre.
   */
  private abrir(droneId: string, v: AvisoDeEmergencia): void {
    let e = this.deRef(droneId, v.ref);
    if (!e) {
      const ahora = this.deps.ahora();
      const abierta = db
        .prepare(
          `${SELECT_EMERGENCIA} WHERE e.drone_id = ? AND e.recuperada_en IS NULL AND e.aterrizada_en IS NULL
            ORDER BY e.id DESC LIMIT 1`,
        )
        .get(droneId) as FilaEmergencia | undefined;
      if (abierta && ahora - Date.parse(abierta.creada_en) < REUSO_EMERGENCIA_ABIERTA_MS) {
        e = aVista(abierta);
      } else {
        const info = db
          .prepare(
            `INSERT INTO emergencias (drone_id, motivo, lat, lon, alt, bateria, ts, creada_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(droneId, v.motivo, v.lat, v.lon, v.alt, v.bateria, v.ts, new Date(ahora).toISOString());
        e = this.obtener(Number(info.lastInsertRowid)) as EmergenciaView;
        this.registrar(e, 'EMERGENCY_LANDING', `${e.displayName} inició un aterrizaje de emergencia: ${MOTIVO_LEGIBLE[v.motivo]}`, {
          ...ubicacionDe(v.lat, v.lon),
          detalle: { alt: v.alt, bateria: v.bateria },
        });
        this.difundir(e);
      }
      db.prepare('INSERT INTO emergencia_refs (drone_id, ref, emergencia_id) VALUES (?, ?, ?)').run(droneId, v.ref, e.id);
    }
    this.deps.enviar(droneId, { type: 'emergency_ack', ref: v.ref, emergencyId: e.id, aterrizada: e.aterrizadaEn !== null });
  }

  /**
   * Guarda la foto una sola vez por (emergencia, seq): la repetida no pisa la
   * guardada ni se vuelve a difundir, pero se acusa igual (la app la saca de la
   * cola con el acuse). Con un ref desconocido no hay acuse: la app reintenta
   * hasta que llegue su emergency_landing.
   */
  private guardarFoto(droneId: string, v: FotoDeEmergencia): void {
    const e = this.deRef(droneId, v.ref);
    if (!e) return descartar(droneId, 'emergency_photo', `ref ${v.ref} desconocido`);
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO emergencia_fotos
           (emergencia_id, seq, tipo, rumbo, inclinacion, lat, lon, alt, ts, jpeg_base64, recibida_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, v.seq, v.tipo, v.rumbo, v.inclinacion, v.lat, v.lon, v.alt, v.ts, v.jpegBase64,
           new Date(this.deps.ahora()).toISOString());
    if (info.changes === 1) {
      this.deps.difundir({
        type: 'emergency_photo',
        emergenciaId: e.id,
        seq: v.seq,
        tipo: v.tipo,
        rumbo: v.rumbo,
        inclinacion: v.inclinacion,
        lat: v.lat,
        lon: v.lon,
        alt: v.alt,
        ts: v.ts,
        jpegBase64: v.jpegBase64,
      });
      this.difundir(this.obtener(e.id) as EmergenciaView);
    }
    this.deps.enviar(droneId, { type: 'emergency_photo_ack', ref: v.ref, seq: v.seq });
  }

  /** Registra el aterrizaje una sola vez (la hora del hub y la última posición) y lo acusa siempre. */
  private aterrizada(droneId: string, v: AterrizajeDeEmergencia): void {
    const antes = this.deRef(droneId, v.ref);
    if (!antes) return descartar(droneId, 'emergency_landed', `ref ${v.ref} desconocido`);
    if (antes.aterrizadaEn === null) {
      db.prepare(
        'UPDATE emergencias SET aterrizada_en = ?, aterrizaje_lat = ?, aterrizaje_lon = ?, aterrizaje_alt = ? WHERE id = ?',
      ).run(new Date(this.deps.ahora()).toISOString(), v.lat, v.lon, v.alt, antes.id);
      const e = this.obtener(antes.id) as EmergenciaView;
      this.registrar(e, 'EMERGENCY_LANDED', `${e.displayName} tocó tierra en un aterrizaje de emergencia`, {
        ...ubicacionDe(v.lat, v.lon),
        detalle: { alt: v.alt },
      });
      this.difundir(e);
      this.deps.alAterrizar(droneId);
    }
    this.deps.enviar(droneId, { type: 'emergency_ack', ref: v.ref, emergencyId: antes.id, aterrizada: true });
  }

  // ---- REST (PROTOCOLS §5) ----

  /** Las abiertas (sin recuperar), o las últimas 100; más recientes primero. */
  listar(soloAbiertas: boolean): EmergenciaView[] {
    const filas = soloAbiertas
      ? db.prepare(`${SELECT_EMERGENCIA} WHERE e.recuperada_en IS NULL ORDER BY e.id DESC`).all()
      : db.prepare(`${SELECT_EMERGENCIA} ORDER BY e.id DESC LIMIT 100`).all();
    return (filas as FilaEmergencia[]).map(aVista);
  }

  /** La emergencia con sus fotos ordenadas por `seq`. */
  detalle(id: number): EmergenciaConFotos | undefined {
    const e = this.obtener(id);
    if (!e) return undefined;
    const fotos = db
      .prepare(
        `SELECT seq, tipo, rumbo, inclinacion, lat, lon, alt, ts, jpeg_base64 AS jpegBase64
           FROM emergencia_fotos WHERE emergencia_id = ? ORDER BY seq`,
      )
      .all(id) as FotoView[];
    return { ...e, fotos };
  }

  /**
   * Marca la emergencia como recuperada. Vale también sin `emergency_landed`: el
   * aviso se pudo perder y el dron igual apareció.
   */
  marcarRecuperada(id: number, por: string): ResultadoRecuperada {
    const antes = this.obtener(id);
    if (!antes) return { ok: false, status: 404 };
    if (antes.recuperadaEn !== null) return { ok: false, status: 409 };
    db.prepare('UPDATE emergencias SET recuperada_en = ?, recuperada_por = ? WHERE id = ?')
      .run(new Date(this.deps.ahora()).toISOString(), por, id);
    const e = this.obtener(id) as EmergenciaView;
    this.registrar(e, 'EMERGENCY_RECOVERED', `${por} marcó como recuperado a ${e.displayName}`, { detalle: { por } });
    this.difundir(e);
    return { ok: true, emergencia: e };
  }
}

function procesar<T>(droneId: string, msg: Crudo, validar: (m: Crudo) => Validado<T>, hacer: (v: T) => void): true {
  const v = validar(msg);
  if (v.ok) hacer(v.valor);
  else descartar(droneId, msg.type, `el campo ${v.campo} no cumple el contrato`);
  return true;
}

/** Anota un mensaje descartado en el log del proceso (§1.b): sin fila en `events` y sin contestar. */
function descartar(droneId: string, tipo: unknown, motivo: string): void {
  console.warn(`[emergencias] se descartó un ${String(tipo)} de ${droneId}: ${motivo}`);
}
