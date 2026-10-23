import {
  posicionValida, validarLandedAtBase, validarLandingAtBase, validarObjetivo, validarRelayAbandon, validarRelayAbort,
  validarRelayReject, validarRelayRequest, validarRelevoInformado, validarRthDiverted, validarSoloRelayId,
  type AbandonoDeRelevo, type AbortoDeRelevo, type AterrizajeEnBase, type Crudo, type DescensoEnBase, type Desvio,
  type MotivoRelevo, type MotivoRthDiverted, type Objetivo, type PedidoDeRelevo, type RechazoDeRelevo,
  type RelevoInformado, type Validado,
} from './contrato';
import { db } from './db';
import { dronNombrado, metaAlerta, metaDron, nombreDeDron } from './meta';
import {
  createLog, distanciaM, fijarSeguidaPor, getAlert, getBase, getDrone, getRoute, listBases,
  type Alert, type BaseView, type PatrolRoute,
} from './store';

// Coordinador de relevos del hub (RELEVOS §2, §3, §4 y §7; contrato en
// PROTOCOLS §1.b, §2.b y §3). Es la única fuente de verdad de quién releva a
// quién: la app propone y avisa, pero las reservas, los plazos y los estados
// salen de acá y de la tabla `relevos`, que sobrevive a un reinicio del hub.
//
// No sabe nada de sockets: recibe lo que llega de cada dron ya parseado y
// manda por las funciones que le pasa el hub (`enviar`, `difundir`), con un
// reloj inyectado. Así cada plazo se prueba moviendo el reloj, sin esperar.

/** Plazos del contrato, en milisegundos del reloj del hub (docs/contrato/relevos.json, `plazos`). */
export const PLAZOS = {
  /** Un status más viejo que esto no sirve para elegir candidato (RELEVOS §7). */
  vigenciaStatusMs: 5_000,
  respuestaDeBMs: 10_000,
  relevoDespegueMs: 120_000,
  traspasoSinConfirmarMs: 30_000,
  relevoDesconectadoMs: 20_000,
  relayStatusEnCaminoMs: 5_000,
  relayTargetSinEnlaceMs: 5_000,
  aSinStatusParaSinEnlaceMs: 5_000,
  bloqueoBaseDestinoMs: 600_000,
  /**
   * Cuánto se le sigue reenviando a B dónde está A después de un traspaso que A
   * no confirmó (ver `posteriores`). Diez minutos es más que lo que tarda
   * cualquier regreso: pasado eso, A ya aterrizó o se quedó sin batería.
   */
  seguimientoPosteriorMs: 600_000,
} as const;

/** "Estar en una base" (RELEVOS §0): a menos de esto del punto de la base. */
export const RADIO_DE_BASE_M = 50;
/** Tope administrativo de la distancia entre B y el objetivo (RELEVOS §3.2). */
export const RADIO_MAXIMO_RELEVO_M = 1500;
/** `etaS = 30 + distancia / 8` (RELEVOS §3.2): despegue y subida, más el crucero de 8 m/s. */
const ETA_FIJA_S = 30;
const VELOCIDAD_DE_CRUCERO_MS = 8;
/** A está abajo con el status a esta altura o menos después del landing_at_base (RELEVOS §2.5). */
const ALTURA_DE_A_ABAJO_M = 5;

export type EstadoRelevo =
  | 'RESERVADO' | 'ORDENADO' | 'EN_CAMINO' | 'TRASPASO' | 'SIN_RELEVO'
  | 'COMPLETADO' | 'CANCELADO' | 'FALLIDO';

export const ESTADOS_ACTIVOS: readonly EstadoRelevo[] = ['RESERVADO', 'ORDENADO', 'EN_CAMINO', 'TRASPASO', 'SIN_RELEVO'];
/** Los estados en los que B ya recibió una orden: su conexión importa. */
const ESTADOS_CON_B_AVISADO: readonly EstadoRelevo[] = ['ORDENADO', 'EN_CAMINO', 'TRASPASO'];

/** Un dron de A con estos estados ya no sigue al objetivo (`origen: "retirado"`, PROTOCOLS §2.b). */
function estadoRetirado(state: unknown): boolean {
  return typeof state === 'string' &&
    (state.startsWith('RETURNING_HOME') || ['ATERRIZAJE_EMERGENCIA', 'LANDED', 'IDLE'].includes(state));
}

export interface DependenciasRelevos {
  /** Manda un mensaje a un dron; false si no está conectado (no se encola nada). */
  enviar: (droneId: string, msg: Record<string, unknown>) => boolean;
  /** Difunde a las consolas, con el filtro por rol del hub. */
  difundir: (msg: { type: string; [clave: string]: unknown }) => void;
  ahora: () => number;
  conectado: (droneId: string) => boolean;
}

/** Un relevo como lo guarda la tabla, ya tipado. */
export interface Relevo {
  id: number;
  motivo: MotivoRelevo;
  origen: string;
  relevo: string | null;
  baseId: number | null;
  baseOrigen: number | null;
  alertId: number | null;
  routeId: number | null;
  fromIndex: number | null;
  refOrigen: string;
  estado: EstadoRelevo;
  motivoFin: string | null;
  rechazados: string[];
  venceEn: number | null;
  segundosDisponibles: number | null;
  pedidoEn: number;
  etaS: number | null;
  asignadoEn: number | null;
  ordenadoEn: number | null;
  goEnviado: boolean;
  descendiendo: boolean;
  aAbajo: boolean;
  aterrizado: boolean;
  origenRetirado: boolean;
  abandonado: boolean;
  objetivo: Objetivo | null;
  objetivoTs: number | null;
  creadoEn: string;
  actualizadoEn: string;
}

/** El objeto relevo de PROTOCOLS §3: lo que ven `relay_updated` y `GET /api/relevos`. */
export interface RelevoView {
  id: number;
  motivo: MotivoRelevo;
  estado: EstadoRelevo;
  motivoFin: string | null;
  origen: { droneId: string; displayName: string };
  relevo: { droneId: string; displayName: string } | null;
  baseId: number | null;
  alertId: number | null;
  routeId: number | null;
  fromIndex: number | null;
  etaS: number | null;
  rechazados: string[];
  venceEn: string | null;
  creadoEn: string;
  actualizadoEn: string;
}

interface FilaRelevo {
  id: number;
  motivo: MotivoRelevo;
  origen: string;
  relevo: string | null;
  base_id: number | null;
  base_origen: number | null;
  alert_id: number | null;
  route_id: number | null;
  from_index: number | null;
  ref_origen: string;
  estado: EstadoRelevo;
  motivo_fin: string | null;
  rechazados: string;
  vence_en: number | null;
  segundos_disponibles: number | null;
  pedido_en: number;
  eta_s: number | null;
  asignado_en: number | null;
  ordenado_en: number | null;
  go_enviado: number;
  descendiendo: number;
  a_abajo: number;
  aterrizado: number;
  origen_retirado: number;
  abandonado: number;
  objetivo: string | null;
  objetivo_ts: number | null;
  creado_en: string;
  actualizado_en: string;
}

function aRelevo(f: FilaRelevo): Relevo {
  return {
    id: f.id,
    motivo: f.motivo,
    origen: f.origen,
    relevo: f.relevo,
    baseId: f.base_id,
    baseOrigen: f.base_origen,
    alertId: f.alert_id,
    routeId: f.route_id,
    fromIndex: f.from_index,
    refOrigen: f.ref_origen,
    estado: f.estado,
    motivoFin: f.motivo_fin,
    rechazados: JSON.parse(f.rechazados) as string[],
    venceEn: f.vence_en,
    segundosDisponibles: f.segundos_disponibles,
    pedidoEn: f.pedido_en,
    etaS: f.eta_s,
    asignadoEn: f.asignado_en,
    ordenadoEn: f.ordenado_en,
    goEnviado: !!f.go_enviado,
    descendiendo: !!f.descendiendo,
    aAbajo: !!f.a_abajo,
    aterrizado: !!f.aterrizado,
    origenRetirado: !!f.origen_retirado,
    abandonado: !!f.abandonado,
    objetivo: f.objetivo === null ? null : (JSON.parse(f.objetivo) as Objetivo),
    objetivoTs: f.objetivo_ts,
    creadoEn: f.creado_en,
    actualizadoEn: f.actualizado_en,
  };
}

/** Lo que el hub sabe del último status de un dron, con la hora (del hub) en que llegó. */
interface StatusVisto {
  status: Record<string, unknown>;
  relevo: RelevoInformado | null;
  recibidoEn: number;
}

/** Un dron que podría ir de relevo, con lo que hace falta para ordenarlos. */
interface Candidato {
  droneId: string;
  baseId: number | null;
  bateria: number;
  enEsperaDesde: number;
  etaS: number | null;
}

/** Un desvío abierto de un dron (RELEVOS §4): uno por dron. */
interface DesvioAbierto {
  baseId: number | null;
  motivo: MotivoRthDiverted;
  desde: number;
}

/** Por qué terminó un relevo (PROTOCOLS §3, `motivoFin`). */
export type MotivoFin =
  | 'origen_sin_confirmar'
  | 'orden_del_operador' | 'alerta_descartada' | 'sin_relevo' | 'origen_se_fue'
  | 'relevo_abortado' | 'relevo_desconectado' | 'sin_despegue' | 'relevo_perdio_estado';

/** Motivos de fin en texto, para el mensaje del registro. */
const MOTIVO_FIN_LEGIBLE: Record<MotivoFin, string> = {
  origen_sin_confirmar: 'el dron relevado no confirmó que se alejó',
  orden_del_operador: 'orden del operador',
  alerta_descartada: 'la alerta se descartó',
  sin_relevo: 'no apareció ningún dron disponible a tiempo',
  origen_se_fue: 'el dron relevado dejó el objetivo sin relevo en camino',
  relevo_abortado: 'el relevo abortó',
  relevo_desconectado: 'el relevo perdió la conexión',
  sin_despegue: 'el relevo no pudo despegar a tiempo',
  relevo_perdio_estado: 'el relevo se reconectó sin el relevo en curso',
};

function enIso(ms: number): string {
  return new Date(ms).toISOString();
}

export class CoordinadorDeRelevos {
  private readonly deps: DependenciasRelevos;
  private readonly vistos = new Map<string, StatusVisto>();
  /** Desde cuándo ve el hub a cada dron en espera (RELEVOS §2.2: desempata a favor del que más esperó). */
  private readonly enEsperaDesde = new Map<string, number>();
  /** Drones recién conectados cuyo primer status todavía no llegó (reconexión, PROTOCOLS §1.b). */
  private readonly primerStatus = new Set<string>();
  private readonly desconectadoDesde = new Map<string, number>();
  private readonly ultimoStatusEnviado = new Map<number, number>();
  private readonly ultimoTargetEnviado = new Map<number, number>();
  private readonly desvios = new Map<string, DesvioAbierto>();
  /**
   * Seguimientos COMPLETADOS sin que A confirmara que se alejó (`origen_sin_confirmar`,
   * RELEVOS §3.5). B no baja a la altura de seguimiento hasta que A deje de
   * reportar o pase a regreso, y la única forma que tiene de enterarse es el
   * `relay_target`: por eso se le sigue mandando, aunque el relevo ya haya
   * terminado, hasta que salga uno `retirado` o pase `seguimientoPosteriorMs`.
   */
  private readonly posteriores = new Map<number, number>();

  constructor(deps: DependenciasRelevos) {
    this.deps = deps;
  }

  private ahora(): number {
    return this.deps.ahora();
  }

  /**
   * Arranque del hub: los B de los relevos activos no están conectados todavía,
   * y su plazo de 20 s empieza a contar ahora. Sin esto, un B que no vuelve
   * después de un reinicio dejaría su relevo colgado para siempre.
   */
  iniciar(): void {
    const ahora = this.ahora();
    for (const r of this.activos()) {
      if (r.relevo && ESTADOS_CON_B_AVISADO.includes(r.estado) && !this.deps.conectado(r.relevo)) {
        this.desconectadoDesde.set(r.relevo, ahora);
      }
    }
  }

  // ---- Tabla ----

  private leer(id: number): Relevo | undefined {
    const f = db.prepare('SELECT * FROM relevos WHERE id = ?').get(id) as FilaRelevo | undefined;
    return f ? aRelevo(f) : undefined;
  }

  private activos(): Relevo[] {
    const marcas = ESTADOS_ACTIVOS.map(() => '?').join(',');
    return (db.prepare(`SELECT * FROM relevos WHERE estado IN (${marcas}) ORDER BY id`).all(...ESTADOS_ACTIVOS) as FilaRelevo[])
      .map(aRelevo);
  }

  private guardar(r: Relevo): void {
    db.prepare(
      `UPDATE relevos SET relevo = ?, base_id = ?, base_origen = ?, ref_origen = ?, estado = ?, motivo_fin = ?,
              rechazados = ?, vence_en = ?, segundos_disponibles = ?, pedido_en = ?, eta_s = ?, asignado_en = ?,
              ordenado_en = ?, go_enviado = ?, descendiendo = ?, a_abajo = ?, aterrizado = ?, origen_retirado = ?,
              abandonado = ?, objetivo = ?, objetivo_ts = ?, actualizado_en = ?
        WHERE id = ?`,
    ).run(
      r.relevo, r.baseId, r.baseOrigen, r.refOrigen, r.estado, r.motivoFin, JSON.stringify(r.rechazados), r.venceEn,
      r.segundosDisponibles, r.pedidoEn, r.etaS, r.asignadoEn, r.ordenadoEn, r.goEnviado ? 1 : 0, r.descendiendo ? 1 : 0,
      r.aAbajo ? 1 : 0, r.aterrizado ? 1 : 0, r.origenRetirado ? 1 : 0, r.abandonado ? 1 : 0,
      r.objetivo ? JSON.stringify(r.objetivo) : null, r.objetivoTs, r.actualizadoEn, r.id,
    );
  }

  private adoptarRef(origen: string, ref: string, relevoId: number): void {
    db.prepare('INSERT OR IGNORE INTO relevo_refs (origen, ref, relevo_id) VALUES (?, ?, ?)').run(origen, ref, relevoId);
  }

  private relevoDeRef(origen: string, ref: string): Relevo | undefined {
    const f = db.prepare('SELECT relevo_id AS id FROM relevo_refs WHERE origen = ? AND ref = ?').get(origen, ref) as
      | { id: number }
      | undefined;
    return f ? this.leer(f.id) : undefined;
  }

  private esActivo(r: Relevo): boolean {
    return ESTADOS_ACTIVOS.includes(r.estado);
  }

  // ---- Lo que ven la consola y A ----

  /** `etaS` de §2.b: la de la asignación menos lo transcurrido, nunca negativa; solo en seguimiento con B. */
  private eta(r: Relevo): number | null {
    if (r.motivo !== 'seguimiento' || r.etaS === null || r.asignadoEn === null) return null;
    if (!ESTADOS_CON_B_AVISADO.includes(r.estado)) return null;
    return Math.max(0, Math.round(r.etaS - (this.ahora() - r.asignadoEn) / 1000));
  }

  vista(r: Relevo): RelevoView {
    return {
      id: r.id,
      motivo: r.motivo,
      estado: r.estado,
      motivoFin: r.motivoFin,
      origen: dronNombrado(r.origen),
      relevo: r.relevo ? dronNombrado(r.relevo) : null,
      baseId: r.baseId,
      alertId: r.alertId,
      routeId: r.routeId,
      fromIndex: r.fromIndex,
      etaS: this.eta(r),
      rechazados: [...r.rechazados],
      venceEn: r.venceEn === null ? null : enIso(r.venceEn),
      creadoEn: r.creadoEn,
      actualizadoEn: r.actualizadoEn,
    };
  }

  /** `GET /api/relevos`: los activos, o los últimos 100; más recientes primero. */
  listar(soloActivos: boolean): RelevoView[] {
    const filas = soloActivos
      ? (db
          .prepare(`SELECT * FROM relevos WHERE estado IN (${ESTADOS_ACTIVOS.map(() => '?').join(',')}) ORDER BY id DESC`)
          .all(...ESTADOS_ACTIVOS) as FilaRelevo[])
      : (db.prepare('SELECT * FROM relevos ORDER BY id DESC LIMIT 100').all() as FilaRelevo[]);
    return filas.map((f) => this.vista(aRelevo(f)));
  }

  private enviarStatus(r: Relevo, ref: string = r.refOrigen): void {
    this.deps.enviar(r.origen, {
      type: 'relay_status',
      ref,
      relayId: r.id,
      estado: r.estado,
      relevo: r.relevo ? dronNombrado(r.relevo) : null,
      etaS: this.eta(r),
      motivoFin: r.motivoFin,
    });
    this.ultimoStatusEnviado.set(r.id, this.ahora());
  }

  private difundirRelevo(r: Relevo): void {
    this.deps.difundir({ type: 'relay_updated', relay: this.vista(r) });
  }

  /**
   * Guarda un cambio visible del relevo y avisa: a las consolas siempre, y a A
   * con `relay_status` si cambió el estado o el B (PROTOCOLS §2.b: "en cada
   * cambio de estado del relevo").
   */
  private actualizar(
    r: Relevo,
    cambios: Partial<Relevo>,
    antes: { estado: EstadoRelevo; relevo: string | null } = { estado: r.estado, relevo: r.relevo },
  ): void {
    Object.assign(r, cambios, { actualizadoEn: enIso(this.ahora()) });
    this.guardar(r);
    this.difundirRelevo(r);
    if (antes.estado !== r.estado || antes.relevo !== r.relevo) this.enviarStatus(r);
    if (!this.esActivo(r)) {
      this.ultimoStatusEnviado.delete(r.id);
      this.ultimoTargetEnviado.delete(r.id);
    }
  }

  /** Evento del hub (§7): `drone_id` es siempre A, y los de seguimiento quedan encadenados a su alerta. */
  private registrar(r: Relevo, tipo: string, mensaje: string, extra: { b?: string | null; motivoDeB?: string | null } = {}) {
    const b = extra.b === undefined ? r.relevo : extra.b;
    const alerta = r.alertId === null ? undefined : getAlert(r.alertId);
    const meta = {
      drone: metaDron(r.origen),
      ...(alerta ? { alerta: metaAlerta(alerta) } : {}),
      detalle: {
        relevoId: r.id,
        motivo: r.motivo,
        estado: r.estado,
        motivoFin: r.motivoFin,
        origen: nombreDeDron(r.origen),
        relevo: b ? nombreDeDron(b) : null,
        relevoHash: b ?? null,
        rutaId: r.routeId,
        desdeNodo: r.fromIndex === null ? null : r.fromIndex + 1,
        motivoDeB: extra.motivoDeB ?? null,
      },
    };
    const ev = createLog('drone', tipo, 'backend', mensaje, { droneId: r.origen, alertId: alerta?.id ?? null, meta });
    this.deps.difundir({ type: 'event', event: ev });
  }

  private textoDelRelevo(r: Relevo): string {
    return r.motivo === 'patrulla' ? 'de patrulla' : 'de seguimiento';
  }

  // ---- Bases ----

  /** La base activa más cercana a una posición, si está a menos de RADIO_DE_BASE_M (RELEVOS §0). */
  private baseEnPosicion(pos: { lat: number; lon: number } | null): BaseView | null {
    if (!pos) return null;
    let mejor: BaseView | null = null;
    let mejorDistancia = Number.POSITIVE_INFINITY;
    for (const b of listBases({ soloActivas: true })) {
      const d = distanciaM(pos, b);
      if (d < RADIO_DE_BASE_M && d < mejorDistancia) {
        mejor = b;
        mejorDistancia = d;
      }
    }
    return mejor;
  }

  private posicionDe(droneId: string): { lat: number; lon: number } | null {
    const visto = this.vistos.get(droneId);
    return visto ? posicionValida(visto.status.lat, visto.status.lon) : null;
  }

  /**
   * La base de un dron: donde está según su último status (RELEVOS §0) y, si no
   * está en ninguna —A vuelve por batería en el aire cuando pide—, la que tiene
   * asignada, que es la base a la que vuelve.
   */
  private baseDe(droneId: string): number | null {
    const enPosicion = this.baseEnPosicion(this.posicionDe(droneId));
    if (enPosicion) return enPosicion.id;
    const asignada = getDrone(droneId)?.baseId ?? null;
    const base = asignada === null ? undefined : getBase(asignada);
    return base && !base.deleted && base.active ? base.id : null;
  }

  /** Despegues de relevo bloqueados desde la base destino de un desvío (RELEVOS §4). */
  baseBloqueada(baseId: number): boolean {
    const ahora = this.ahora();
    for (const d of this.desvios.values()) {
      if (d.motivo === 'otra_base' && d.baseId === baseId && ahora - d.desde < PLAZOS.bloqueoBaseDestinoMs) return true;
    }
    return false;
  }

  // ---- Candidatos ----

  private segundosRestantes(r: Relevo): number | null {
    // A ya se fue: cualquier B llegaría tarde, así que solo sale con la alerta validada.
    if (r.abandonado) return 0;
    if (r.segundosDisponibles === null) return null;
    return r.segundosDisponibles - (this.ahora() - r.pedidoEn) / 1000;
  }

  /**
   * Los drones que pueden ir de relevo ahora: conectados, con un status de hace
   * 5 s o menos que dice `disponible`, con posición, sin relevo activo en la
   * tabla (la única fuente de verdad de las reservas) y fuera de una base
   * bloqueada por un desvío. Ni A ni los que ya rechazaron este relevo.
   */
  private disponibles(r: Relevo, excluir: readonly string[]): (Candidato & { pos: { lat: number; lon: number } })[] {
    const ahora = this.ahora();
    const activos = this.activos().filter((x) => x.id !== r.id);
    const lista: (Candidato & { pos: { lat: number; lon: number } })[] = [];
    for (const [droneId, visto] of this.vistos) {
      if (droneId === r.origen || r.rechazados.includes(droneId) || excluir.includes(droneId)) continue;
      if (!this.deps.conectado(droneId) || ahora - visto.recibidoEn > PLAZOS.vigenciaStatusMs) continue;
      if (!visto.relevo?.disponible) continue;
      const pos = posicionValida(visto.status.lat, visto.status.lon);
      if (!pos) continue;
      // Un pedido de seguimiento le puede quitar la reserva a uno de patrulla
      // que todavía está RESERVADO (B no sabe nada), nunca a uno ya ordenado.
      const ocupado = activos.some(
        (x) =>
          (x.origen === droneId || x.relevo === droneId) &&
          !(r.motivo === 'seguimiento' && x.motivo === 'patrulla' && x.estado === 'RESERVADO' && x.relevo === droneId),
      );
      if (ocupado) continue;
      const base = this.baseEnPosicion(pos);
      if (base && this.baseBloqueada(base.id)) continue;
      const bateria = Number.isFinite(visto.status.battery) ? (visto.status.battery as number) : 0;
      lista.push({
        droneId,
        pos,
        baseId: base?.id ?? getDrone(droneId)?.baseId ?? null,
        bateria,
        // Disponible implica en espera, y en espera siempre tiene su marca.
        enEsperaDesde: this.enEsperaDesde.get(droneId) as number,
        etaS: null,
      });
    }
    return lista;
  }

  /** Más batería primero; a igual batería, el que hace más que está en espera. */
  private static porBateriaYEspera(a: Candidato, b: Candidato): number {
    return b.bateria - a.bateria || a.enEsperaDesde - b.enEsperaDesde;
  }

  /**
   * Patrulla (RELEVOS §2.2): en la base de A, el de más batería. Si el
   * reservado sigue disponible se lo prefiere (§2.3): ya es el que la consola
   * muestra y no hay motivo para cambiarlo.
   */
  private elegirParaPatrulla(r: Relevo, excluir: readonly string[]): Candidato | null {
    const base = r.baseOrigen === null ? undefined : getBase(r.baseOrigen);
    if (!base) return null;
    const enLaBase = this.disponibles(r, excluir).filter((c) => distanciaM(c.pos, base) < RADIO_DE_BASE_M);
    const reservado = enLaBase.find((c) => c.droneId === r.relevo);
    if (reservado) return { ...reservado, baseId: base.id };
    const mejor = enLaBase.sort(CoordinadorDeRelevos.porBateriaYEspera)[0];
    return mejor ? { ...mejor, baseId: base.id } : null;
  }

  /**
   * Seguimiento (RELEVOS §3.2): entre todos los disponibles, el de menor
   * `etaS = 30 + distancia / 8`, a 1500 m o menos del objetivo, y solo si llega
   * antes de que A se vaya. Un relevo tardío sale únicamente con la alerta ya
   * validada; sin autonomía informada (`segundosDisponibles` null) no se puede
   * saber si llega, y se lo trata como tardío.
   */
  private elegirParaSeguimiento(r: Relevo, excluir: readonly string[]): Candidato | null {
    // Sin un objetivo válido de A no hay a qué medirle la distancia a nadie.
    if (!r.objetivo) return null;
    const objetivo = r.objetivo;
    const validada = getAlert(r.alertId as number)?.status === 'VALIDATED';
    const segundos = this.segundosRestantes(r);
    const posibles: Candidato[] = [];
    for (const c of this.disponibles(r, excluir)) {
      const distancia = distanciaM(c.pos, objetivo);
      if (distancia > RADIO_MAXIMO_RELEVO_M) continue;
      const etaS = ETA_FIJA_S + distancia / VELOCIDAD_DE_CRUCERO_MS;
      if (!validada && (segundos === null || etaS > segundos)) continue;
      posibles.push({ ...c, etaS });
    }
    posibles.sort((a, b) => (a.etaS as number) - (b.etaS as number) || CoordinadorDeRelevos.porBateriaYEspera(a, b));
    return posibles[0] ?? null;
  }

  private elegir(r: Relevo, excluir: readonly string[] = []): Candidato | null {
    return r.motivo === 'patrulla' ? this.elegirParaPatrulla(r, excluir) : this.elegirParaSeguimiento(r, excluir);
  }

  // ---- Asignar ----

  /**
   * Deja al relevo con el candidato elegido, sin avisar a nadie todavía.
   * Patrulla antes de que A empiece a bajar: solo se lo reserva (B no sabe
   * nada, §2.2). Patrulla con A bajando o abajo, y todo seguimiento: se le
   * ordena (`ORDENADO`), con 10 s para contestar.
   */
  private aplicarEleccion(r: Relevo, c: Candidato): void {
    const ahora = this.ahora();
    r.relevo = c.droneId;
    r.baseId = c.baseId;
    r.goEnviado = false;
    r.actualizadoEn = enIso(ahora);
    if (r.motivo === 'patrulla' && !r.descendiendo && !r.aAbajo) {
      r.estado = 'RESERVADO';
      r.venceEn = null;
      r.ordenadoEn = null;
      return;
    }
    r.estado = 'ORDENADO';
    r.ordenadoEn = ahora;
    r.venceEn = ahora + PLAZOS.respuestaDeBMs;
    if (r.motivo === 'seguimiento') {
      r.etaS = c.etaS;
      r.asignadoEn = ahora;
    }
  }

  private decisionDe(alerta: Alert | undefined): 'PENDING' | 'VALIDATED' {
    return alerta?.status === 'VALIDATED' ? 'VALIDATED' : 'PENDING';
  }

  /**
   * La orden a B. Solo se arma para un relevo con B y, en seguimiento, con el
   * objetivo de A: sin objetivo no hay candidato (no hay a qué medirle la
   * distancia), así que un relevo ordenado siempre lo tiene. La ruta sale de la
   * tabla aunque se haya dado de baja después del pedido: la baja es lógica y B
   * tiene que poder seguir la que A dejó.
   */
  private mensajeDeOrden(r: Relevo): Record<string, unknown> {
    if (r.motivo === 'patrulla') {
      const ruta = getRoute(r.routeId as number) as PatrolRoute;
      return {
        type: 'relay_start',
        relayId: r.id,
        motivo: 'patrulla',
        ruta: { id: ruta.id, name: ruta.name, waypoints: ruta.waypoints },
        fromIndex: r.fromIndex,
        de: dronNombrado(r.origen),
      };
    }
    const decision = this.decisionDe(getAlert(r.alertId as number));
    return {
      type: 'relay_tracking',
      relayId: r.id,
      alertId: r.alertId,
      decision,
      objetivo: { ...(r.objetivo as Objetivo), decision },
      de: dronNombrado(r.origen),
      ts: r.objetivoTs,
    };
  }

  /**
   * La orden a B: `relay_start` o `relay_tracking`. En patrulla con A ya abajo
   * (aterrizó o se desvió), `relay_go` sale junto (§2.b): la plataforma de A ya
   * está libre y no hay nada más que esperar.
   */
  private enviarOrden(r: Relevo): void {
    this.deps.enviar(r.relevo as string, this.mensajeDeOrden(r));
    if (r.motivo === 'patrulla' && r.aAbajo) this.darGo(r);
  }

  /**
   * `relay_go`: B ya puede despegar. Nunca desde una base bloqueada por un
   * desvío (RELEVOS §4): ahí el barrido lo vuelve a intentar cuando se libere,
   * y si no se libera a tiempo el relevo vence por `sin_despegue`, que es el
   * lado seguro ("ante la duda en el suelo, el dron no despega").
   */
  private darGo(r: Relevo): void {
    if (r.goEnviado || !r.relevo) return;
    if (r.baseId !== null && this.baseBloqueada(r.baseId)) return;
    this.deps.enviar(r.relevo, { type: 'relay_go', relayId: r.id });
    r.goEnviado = true;
    if (r.estado === 'EN_CAMINO') r.venceEn = null;
  }

  /** Un pedido de seguimiento se llevó al B que tenía reservado uno de patrulla: ese busca otro. */
  private quitarReservas(robado: string, ladron: Relevo): void {
    for (const { id } of this.activos()) {
      const p = this.leer(id) as Relevo;
      if (p.id === ladron.id || p.estado !== 'RESERVADO' || p.relevo !== robado) continue;
      p.relevo = null;
      if (!this.asignar(p, [robado])) this.sinCandidato(p);
    }
  }

  private registrarAsignacion(r: Relevo): void {
    this.registrar(r, 'RELAY_ASSIGNED', `Se le ordenó a ${nombreDeDron(r.relevo as string)} relevar a ${nombreDeDron(r.origen)}`);
  }

  /**
   * Busca B para un relevo existente y, si hay, lo reserva u ordena y avisa.
   * Devuelve false si no hay candidato (y no toca nada).
   */
  private asignar(r: Relevo, excluir: readonly string[] = []): boolean {
    const c = this.elegir(r, excluir);
    if (!c) return false;
    const antes = { estado: r.estado, relevo: r.relevo };
    this.aplicarEleccion(r, c);
    if (r.estado === 'ORDENADO') this.enviarOrden(r);
    this.guardar(r);
    if (r.estado === 'ORDENADO') this.registrarAsignacion(r);
    this.difundirRelevo(r);
    if (antes.estado !== r.estado || antes.relevo !== r.relevo) this.enviarStatus(r);
    if (r.motivo === 'seguimiento') this.quitarReservas(c.droneId, r);
    return true;
  }

  /**
   * No hay B. El pedido queda pendiente (`SIN_RELEVO`) salvo que ya no tenga
   * sentido esperar: en patrulla con A ya aterrizado, el pedido vence
   * (`sin_relevo`); en seguimiento con A ya ido, `origen_se_fue`.
   */
  private sinCandidato(r: Relevo): void {
    if (r.motivo === 'patrulla' && r.aterrizado) {
      this.terminar(r, 'CANCELADO', 'sin_relevo');
      return;
    }
    if (r.motivo === 'seguimiento' && r.abandonado) {
      this.terminar(r, 'CANCELADO', 'origen_se_fue');
      return;
    }
    const entra = r.estado !== 'SIN_RELEVO';
    this.actualizar(r, {
      estado: 'SIN_RELEVO', relevo: null, baseId: null, etaS: null, asignadoEn: null, ordenadoEn: null, venceEn: null,
      goEnviado: false,
    });
    // Una vez por cada vez que entra, no por cada búsqueda del barrido (§7).
    if (entra) this.registrar(r, 'RELAY_UNAVAILABLE', `No hay dron disponible para relevar a ${nombreDeDron(r.origen)}`, { b: null });
  }

  /**
   * Fin del relevo. Si se va en `TRASPASO` sin completarse, la alerta vuelve a
   * A (PROTOCOLS §1.b, `relay_abort`): ya está soltando y no vuelve al
   * objetivo, pero es el último que lo tuvo a la vista.
   */
  private terminar(
    r: Relevo,
    estado: 'COMPLETADO' | 'CANCELADO' | 'FALLIDO',
    motivoFin: MotivoFin | null,
    extra: { motivoDeB?: string | null } = {},
  ): void {
    const veniaDeTraspaso = r.estado === 'TRASPASO';
    this.actualizar(r, { estado, motivoFin, venceEn: null });
    const nombreA = nombreDeDron(r.origen);
    const porque = motivoFin ? ` (${MOTIVO_FIN_LEGIBLE[motivoFin]})` : '';
    if (estado === 'COMPLETADO') {
      // Se completa siempre con un B: lo dice su relay_ready (o el traspaso que lo siguió).
      const b = nombreDeDron(r.relevo as string);
      this.registrar(r, 'RELAY_COMPLETED', `${b} completó el relevo ${this.textoDelRelevo(r)} de ${nombreA}${porque}`);
      if (motivoFin === 'origen_sin_confirmar') this.posteriores.set(r.id, this.ahora() + PLAZOS.seguimientoPosteriorMs);
    } else if (estado === 'CANCELADO') {
      this.registrar(r, 'RELAY_CANCELLED', `Se canceló el relevo ${this.textoDelRelevo(r)} de ${nombreA}${porque}`);
    } else {
      this.registrar(r, 'RELAY_FAILED', `Falló el relevo ${this.textoDelRelevo(r)} de ${nombreA}${porque}`, {
        motivoDeB: extra.motivoDeB ?? null,
      });
      // Solo un seguimiento pasa por TRASPASO, y tiene alerta.
      if (veniaDeTraspaso) this.cambiarDueno(r.alertId as number, r.origen);
    }
  }

  /** Cambia quién sigue la alerta y avisa a las consolas solo si cambió (PROTOCOLS §3). */
  private cambiarDueno(alertId: number, droneId: string): void {
    const alerta = fijarSeguidaPor(alertId, droneId);
    if (alerta) this.deps.difundir({ type: 'alert_updated', alert: alerta });
  }

  // ---- Status de los drones ----

  alConectar(droneId: string): void {
    this.primerStatus.add(droneId);
    this.desconectadoDesde.delete(droneId);
  }

  alDesconectar(droneId: string): void {
    this.primerStatus.delete(droneId);
    this.desconectadoDesde.set(droneId, this.ahora());
  }

  /**
   * Cada status de un dron, ya saneado por el hub. Lo guarda para elegir
   * candidatos, resuelve la reconexión con el primero, y si el dron es A de un
   * relevo, lo usa para el despegue de B (patrulla) o para el `relay_target`
   * (seguimiento).
   */
  alRecibirStatus(droneId: string, status: Record<string, unknown>): void {
    const ahora = this.ahora();
    const relevo = validarRelevoInformado(status.relevo);
    this.vistos.set(droneId, { status, relevo, recibidoEn: ahora });
    if (relevo?.enEspera) {
      if (!this.enEsperaDesde.has(droneId)) this.enEsperaDesde.set(droneId, ahora);
    } else {
      this.enEsperaDesde.delete(droneId);
    }
    if (this.primerStatus.delete(droneId)) this.reconciliar(droneId, relevo?.relayId ?? null);

    for (const r of this.activos()) {
      if (r.origen !== droneId) continue;
      if (r.motivo === 'patrulla') this.statusDeAEnPatrulla(r, status);
      else this.statusDeAEnSeguimiento(r, status, ahora);
    }
    for (const id of [...this.posteriores.keys()]) {
      const r = this.leer(id);
      if (r?.origen === droneId) this.reenviarObjetivo(r, status, ahora);
    }
  }

  /** Patrulla: con A bajando, una altura de 5 m o menos es "A abajo" y B puede despegar (§2.5). */
  private statusDeAEnPatrulla(r: Relevo, status: Record<string, unknown>): void {
    if (!r.descendiendo || r.aAbajo) return;
    if (!Number.isFinite(status.alt) || (status.alt as number) > ALTURA_DE_A_ABAJO_M) return;
    r.aAbajo = true;
    if (r.estado === 'EN_CAMINO') this.darGo(r);
    this.actualizar(r, {});
  }

  /** Seguimiento: el objetivo de A se guarda (si pasa) y se le reenvía a B. */
  private statusDeAEnSeguimiento(r: Relevo, status: Record<string, unknown>, ahora: number): void {
    // Un pedido pendiente vale mientras A siga sobre el objetivo (§3.2): si A
    // ya está volviendo o en el suelo, el pedido venció.
    if (r.estado === 'SIN_RELEVO' && estadoRetirado(status.state)) {
      this.terminar(r, 'CANCELADO', 'sin_relevo');
      return;
    }
    this.reenviarObjetivo(r, status, ahora);
  }

  /**
   * Guarda el objetivo del status de A si pasa la validación y le manda a B el
   * `relay_target` que corresponde (en curso o después de un traspaso sin
   * confirmar). Un objetivo que no pasa no deja `relay_target` por ese status,
   * salvo que A ya se haya retirado: ahí va la última estimación válida, que es
   * lo que B necesita, con la posición nueva de A.
   */
  private reenviarObjetivo(r: Relevo, status: Record<string, unknown>, ahora: number): void {
    // Las alertas no se borran: la de un seguimiento siempre está.
    const alerta = getAlert(r.alertId as number) as Alert;
    const objetivo = validarObjetivo(status.target, alerta, this.decisionDe(alerta));
    if (objetivo) {
      r.objetivo = objetivo;
      r.objetivoTs = ahora;
      this.guardar(r);
    }
    const enCurso = r.estado === 'EN_CAMINO' || r.estado === 'TRASPASO';
    if (!enCurso && !this.posteriores.has(r.id)) return;
    if (r.origenRetirado || estadoRetirado(status.state)) this.enviarTarget(r, 'retirado');
    else if (objetivo) this.enviarTarget(r, 'en_linea');
  }

  /**
   * `relay_target` a B. Solo se llama con B en camino o en el traspaso (o
   * después de un traspaso sin confirmar), y para llegar ahí B se eligió con el
   * objetivo de A: los dos están siempre. La posición y la altura de A pueden
   * faltar (A sin GPS, o sin ningún status desde que arrancó el hub).
   */
  private enviarTarget(r: Relevo, origen: 'en_linea' | 'sin_enlace' | 'retirado'): void {
    const visto = this.vistos.get(r.origen);
    const a = visto ? posicionValida(visto.status.lat, visto.status.lon) : null;
    const aAlt = visto && Number.isFinite(visto.status.alt) ? (visto.status.alt as number) : null;
    const decision = this.decisionDe(getAlert(r.alertId as number));
    this.deps.enviar(r.relevo as string, {
      type: 'relay_target',
      relayId: r.id,
      alertId: r.alertId,
      decision,
      objetivo: { ...(r.objetivo as Objetivo), decision },
      origen,
      aLat: a?.lat ?? null,
      aLon: a?.lon ?? null,
      aAlt,
      ts: r.objetivoTs,
    });
    this.ultimoTargetEnviado.set(r.id, this.ahora());
    if (origen === 'retirado') this.posteriores.delete(r.id);
  }

  // ---- Reconexión (PROTOCOLS §1.b, "Reconexión") ----

  /** Repite la última orden a B, idempotente por `relayId` (la app la contesta igual sin reiniciar nada). */
  private reenviarOrden(r: Relevo): void {
    const b = r.relevo as string;
    this.deps.enviar(b, this.mensajeDeOrden(r));
    if (r.goEnviado) this.deps.enviar(b, { type: 'relay_go', relayId: r.id });
  }

  private reconciliar(droneId: string, relayId: number | null): void {
    if (relayId !== null) {
      const r = this.leer(relayId);
      if (!r) {
        this.deps.enviar(droneId, { type: 'relay_cancel', relayId, motivo: 'inexistente' });
      } else if (!this.esActivo(r)) {
        this.deps.enviar(droneId, { type: 'relay_cancel', relayId, motivo: 'terminado' });
      } else if (r.relevo === droneId && ESTADOS_CON_B_AVISADO.includes(r.estado)) {
        this.reenviarOrden(r);
      } else if (r.origen === droneId) {
        this.enviarStatus(r);
        if (r.estado === 'TRASPASO') this.enviarDone(r);
      } else {
        // El relevo sigue, pero ya no es de este dron: se le reasignó a otro
        // mientras estaba caído (no contestó a tiempo).
        this.deps.enviar(droneId, { type: 'relay_cancel', relayId, motivo: 'vencido' });
      }
      return;
    }
    for (const r of this.activos()) {
      if (r.relevo !== droneId) continue;
      if (r.estado === 'ORDENADO') this.reenviarOrden(r);
      // Una app que perdió el relevo en el aire ya no está volando hacia él.
      else if (r.estado === 'EN_CAMINO' || r.estado === 'TRASPASO') this.terminar(r, 'FALLIDO', 'relevo_perdio_estado');
    }
  }

  /** `relay_done` a A: solo en el traspaso de un seguimiento, que siempre tiene alerta y B. */
  private enviarDone(r: Relevo): void {
    this.deps.enviar(r.origen, {
      type: 'relay_done',
      relayId: r.id,
      alertId: r.alertId,
      relevadoPor: dronNombrado(r.relevo as string),
    });
  }

  // ---- Mensajes de la app ----

  /**
   * Los mensajes de relevos y desvíos (§1.b). Devuelve false si el `type` no es
   * de este coordinador. Un mensaje que no pasa la validación, o que no
   * corresponde, se descarta entero: sin contestar, sin fila en `events`, con
   * un aviso en el log del proceso (un dron con un defecto que reintenta cada
   * 5 s inundaría el registro).
   */
  alRecibirMensaje(droneId: string, msg: Crudo): boolean {
    switch (msg.type) {
      case 'relay_request':
        return this.procesar(droneId, msg, validarRelayRequest, (v) => this.pedir(droneId, v));
      case 'relay_accept':
        return this.procesar(droneId, msg, validarSoloRelayId, (v) => this.aceptar(droneId, v.relayId));
      case 'relay_reject':
        return this.procesar(droneId, msg, validarRelayReject, (v) => this.rechazar(droneId, v));
      case 'relay_ready':
        return this.procesar(droneId, msg, validarSoloRelayId, (v) => this.listo(droneId, v.relayId));
      case 'relay_abort':
        return this.procesar(droneId, msg, validarRelayAbort, (v) => this.abortar(droneId, v));
      case 'relay_abandon':
        return this.procesar(droneId, msg, validarRelayAbandon, (v) => this.abandonar(droneId, v));
      case 'relay_released':
        return this.procesar(droneId, msg, validarSoloRelayId, (v) => this.soltado(droneId, v.relayId));
      case 'landing_at_base':
        return this.procesar(droneId, msg, validarLandingAtBase, (v) => this.descendiendoEnBase(droneId, v));
      case 'landed_at_base':
        return this.procesar(droneId, msg, validarLandedAtBase, (v) => this.aterrizoEnBase(droneId, v));
      case 'rth_diverted':
        return this.procesar(droneId, msg, validarRthDiverted, (v) => this.desviado(droneId, v));
      default:
        return false;
    }
  }

  private procesar<T>(droneId: string, msg: Crudo, validar: (m: Crudo) => Validado<T>, hacer: (v: T) => void): true {
    const v = validar(msg);
    if (v.ok) hacer(v.valor);
    else descartar(droneId, msg.type, `el campo ${v.campo} no cumple el contrato`);
    return true;
  }

  /** El relevo con ese id del que este dron es A, o undefined (y lo anota). */
  private comoOrigen(droneId: string, tipo: string, relayId: number, motivo?: MotivoRelevo): Relevo | undefined {
    const r = this.leer(relayId);
    if (r?.origen === droneId && (motivo === undefined || r.motivo === motivo)) return r;
    descartar(droneId, tipo, `el relevo ${relayId} no existe o no es suyo`);
    return undefined;
  }

  /** El relevo con ese id del que este dron es B, en uno de los estados pedidos. */
  private comoRelevo(droneId: string, tipo: string, relayId: number, estados: readonly EstadoRelevo[]): Relevo | undefined {
    const r = this.leer(relayId);
    if (r?.relevo === droneId && estados.includes(r.estado)) return r;
    descartar(droneId, tipo, `el relevo ${relayId} no existe, no es suyo o está en otro estado`);
    return undefined;
  }

  private pedir(a: string, p: PedidoDeRelevo): void {
    // Idempotencia por (origen, ref): un reintento no crea nada y se contesta
    // con el relevo de ese ref, aunque ya haya terminado.
    const visto = this.relevoDeRef(a, p.ref);
    if (visto) {
      this.enviarStatus(visto, p.ref);
      return;
    }
    if (p.motivo === 'patrulla') {
      const ruta = getRoute(p.routeId);
      if (!ruta || ruta.deleted) return descartar(a, 'relay_request', `la ruta ${p.routeId} no existe`);
      if (p.fromIndex >= ruta.waypoints.length) return descartar(a, 'relay_request', 'fromIndex fuera de la ruta');
    } else {
      const alerta = getAlert(p.alertId);
      if (!alerta || alerta.status === 'DISMISSED' || (alerta.seguidaPor ?? alerta.drone_id) !== a) {
        return descartar(a, 'relay_request', `la alerta ${p.alertId} no existe, está descartada o no la sigue este dron`);
      }
      const deOtro = this.activos().find((x) => x.motivo === 'seguimiento' && x.alertId === p.alertId && x.origen !== a);
      if (deOtro) return descartar(a, 'relay_request', `la alerta ${p.alertId} ya tiene un relevo de otro dron`);
    }

    // Uno activo por (origen, motivo): la app se pudo reiniciar y perder el ref
    // viejo, así que se adopta el nuevo y se contesta con ese relevo.
    const activo = this.activos().find((x) => x.origen === a && x.motivo === p.motivo);
    if (activo) {
      this.adoptarRef(a, p.ref, activo.id);
      activo.refOrigen = p.ref;
      if (p.motivo === 'seguimiento') {
        activo.segundosDisponibles = p.segundosDisponibles;
        activo.pedidoEn = this.ahora();
      }
      this.guardar(activo);
      this.enviarStatus(activo, p.ref);
      return;
    }
    const r = this.crear(a, p.ref, p.motivo === 'patrulla'
      ? { motivo: 'patrulla', routeId: p.routeId, fromIndex: p.fromIndex, descendiendo: false }
      : { motivo: 'seguimiento', alertId: p.alertId, segundosDisponibles: p.segundosDisponibles });
    this.enviarStatus(r, p.ref);
  }

  /**
   * Crea el relevo y le busca B en el acto. El registro queda en el orden en
   * que pasó: el pedido y después la asignación o la falta de candidato.
   */
  private crear(
    a: string,
    ref: string,
    datos:
      | { motivo: 'patrulla'; routeId: number; fromIndex: number; descendiendo: boolean }
      | { motivo: 'seguimiento'; alertId: number; segundosDisponibles: number | null },
  ): Relevo {
    const ahora = this.ahora();
    const iso = enIso(ahora);
    const info = db
      .prepare(
        `INSERT INTO relevos (motivo, origen, base_origen, alert_id, route_id, from_index, ref_origen, estado,
                              segundos_disponibles, pedido_en, descendiendo, creado_en, actualizado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'SIN_RELEVO', ?, ?, ?, ?, ?)`,
      )
      .run(
        datos.motivo, a,
        datos.motivo === 'patrulla' ? this.baseDe(a) : null,
        datos.motivo === 'seguimiento' ? datos.alertId : null,
        datos.motivo === 'patrulla' ? datos.routeId : null,
        datos.motivo === 'patrulla' ? datos.fromIndex : null,
        ref,
        datos.motivo === 'seguimiento' ? datos.segundosDisponibles : null,
        ahora,
        datos.motivo === 'patrulla' && datos.descendiendo ? 1 : 0,
        iso, iso,
      );
    const r = this.leer(Number(info.lastInsertRowid)) as Relevo;
    this.adoptarRef(a, ref, r.id);

    // El objetivo sale del status de A, no del pedido (§3.2), con la hora en
    // que llegó ese status: es la que B usa para ordenar los relay_target.
    const visto = this.vistos.get(a);
    if (r.motivo === 'seguimiento' && visto) {
      const alerta = getAlert(r.alertId as number) as Alert;
      r.objetivo = validarObjetivo(visto.status.target, alerta, this.decisionDe(alerta));
      r.objetivoTs = r.objetivo ? visto.recibidoEn : null;
    }

    const c = this.elegir(r);
    if (c) this.aplicarEleccion(r, c);
    if (r.estado === 'ORDENADO') this.enviarOrden(r);
    this.guardar(r);
    this.registrar(r, 'RELAY_REQUESTED', `${nombreDeDron(a)} pidió un relevo ${this.textoDelRelevo(r)}`, { b: r.relevo });
    if (r.estado === 'ORDENADO') this.registrarAsignacion(r);
    if (!c) this.registrar(r, 'RELAY_UNAVAILABLE', `No hay dron disponible para relevar a ${nombreDeDron(a)}`, { b: null });
    this.difundirRelevo(r);
    if (c && r.motivo === 'seguimiento') this.quitarReservas(c.droneId, r);
    return r;
  }

  private aceptar(b: string, relayId: number): void {
    const r = this.leer(relayId);
    if (r?.estado === 'EN_CAMINO' && r.relevo === b) return; // repetido: no hace nada
    if (r?.estado !== 'ORDENADO' || r.relevo !== b) {
      // El único que no se descarta en silencio: B puede estar a segundos de
      // despegar y tiene que enterarse de que este relevo ya no es suyo.
      descartar(b, 'relay_accept', `el relevo ${relayId} no espera su respuesta`);
      this.deps.enviar(b, { type: 'relay_cancel', relayId, motivo: 'vencido' });
      return;
    }
    const antes = { estado: r.estado, relevo: r.relevo };
    r.estado = 'EN_CAMINO';
    // Patrulla: B despega con relay_go; si no llega en 120 s desde la orden, falla.
    r.venceEn = r.motivo === 'patrulla' && !r.goEnviado ? (r.ordenadoEn as number) + PLAZOS.relevoDespegueMs : null;
    if (r.motivo === 'patrulla' && r.aAbajo) this.darGo(r);
    this.actualizar(r, {}, antes);
    this.registrar(r, 'RELAY_STARTED', `${nombreDeDron(b)} aceptó relevar a ${nombreDeDron(r.origen)}`);
    if (r.motivo === 'seguimiento' && r.abandonado) {
      // A ya se fue: la alerta pasa a B ahora que acepta (§1.b, relay_abandon).
      r.origenRetirado = true;
      this.guardar(r);
      this.cambiarDueno(r.alertId as number, b);
      this.enviarTarget(r, 'retirado');
    }
  }

  private rechazar(b: string, v: RechazoDeRelevo): void {
    const r = this.comoRelevo(b, 'relay_reject', v.relayId, ['ORDENADO', 'EN_CAMINO']);
    if (!r) return;
    this.descartarB(r, b, v.motivo, `${nombreDeDron(b)} rechazó el relevo de ${nombreDeDron(r.origen)} (${v.motivo})`);
  }

  /**
   * B queda afuera de este relevo (rechazó o no contestó) y se prueba con el
   * siguiente. Si A ya se había ido y la alerta había pasado a B, vuelve a A
   * hasta que otro B acepte.
   */
  private descartarB(r: Relevo, b: string, motivoDeB: string, mensaje: string): void {
    r.rechazados = [...r.rechazados, b];
    if (r.motivo === 'seguimiento' && r.abandonado && r.estado === 'EN_CAMINO') {
      this.cambiarDueno(r.alertId as number, r.origen);
      r.origenRetirado = false;
    }
    this.registrar(r, 'RELAY_REJECTED', mensaje, { b, motivoDeB });
    r.relevo = null;
    if (!this.asignar(r)) this.sinCandidato(r);
  }

  private listo(b: string, relayId: number): void {
    const r = this.comoRelevo(b, 'relay_ready', relayId, ['EN_CAMINO']);
    if (!r) return;
    if (r.motivo === 'patrulla') {
      this.terminar(r, 'COMPLETADO', null);
      return;
    }
    // Traspaso (§3.5): la alerta pasa a B, A recibe relay_done y tiene 30 s
    // para confirmar que se alejó.
    this.actualizar(r, { estado: 'TRASPASO', venceEn: this.ahora() + PLAZOS.traspasoSinConfirmarMs });
    this.registrar(r, 'RELAY_HANDOVER', `${nombreDeDron(b)} llegó al objetivo: ${nombreDeDron(r.origen)} lo suelta`);
    this.cambiarDueno(r.alertId as number, b);
    this.enviarDone(r);
  }

  private abortar(b: string, v: AbortoDeRelevo): void {
    const r = this.comoRelevo(b, 'relay_abort', v.relayId, ['EN_CAMINO', 'TRASPASO']);
    if (r) this.terminar(r, 'FALLIDO', 'relevo_abortado', { motivoDeB: v.motivo });
  }

  private abandonar(a: string, v: AbandonoDeRelevo): void {
    const r = this.comoOrigen(a, 'relay_abandon', v.relayId, 'seguimiento');
    if (!r) return;
    if (!['ORDENADO', 'EN_CAMINO', 'SIN_RELEVO'].includes(r.estado)) {
      return descartar(a, 'relay_abandon', `el relevo ${r.id} ya no está antes del traspaso`);
    }
    this.origenSeVa(r);
  }

  /**
   * A deja el objetivo antes del traspaso (§3.8): con B en camino la alerta
   * pasa a B y B se entera con un `relay_target` "retirado"; con B todavía sin
   * contestar, pasa cuando acepte; sin B, el relevo se cancela. Repetido, no
   * hace nada.
   */
  private origenSeVa(r: Relevo): void {
    if (r.abandonado) return;
    r.abandonado = true;
    if (r.estado === 'SIN_RELEVO') {
      this.terminar(r, 'CANCELADO', 'origen_se_fue');
      return;
    }
    if (r.estado === 'EN_CAMINO') {
      r.origenRetirado = true;
      this.guardar(r);
      this.cambiarDueno(r.alertId as number, r.relevo as string);
      this.enviarTarget(r, 'retirado');
      return;
    }
    this.guardar(r);
  }

  private soltado(a: string, relayId: number): void {
    const r = this.comoOrigen(a, 'relay_released', relayId, 'seguimiento');
    if (!r) return;
    if (r.estado !== 'TRASPASO') {
      // Tardío: el relevo ya se completó sin confirmación. No cambia nada,
      // pero B se entera ya de que A se alejó.
      if (this.posteriores.has(r.id)) this.enviarTarget(r, 'retirado');
      return;
    }
    // Con relay_released A ya está a 100 m y volviendo: el último relay_target
    // lo dice "retirado" y B baja a la altura de seguimiento (§1.b).
    r.origenRetirado = true;
    this.enviarTarget(r, 'retirado');
    this.terminar(r, 'COMPLETADO', null);
  }

  /** El relevo de patrulla de A al que se refiere un aviso de base, o undefined si no corresponde. */
  private patrullaDe(a: string, tipo: string, relayId: number | null): Relevo | undefined | null {
    if (relayId !== null) return this.comoOrigen(a, tipo, relayId, 'patrulla') ?? null;
    return this.activos().find((x) => x.origen === a && x.motivo === 'patrulla');
  }

  private descendiendoEnBase(a: string, m: DescensoEnBase): void {
    const ruta = getRoute(m.routeId);
    if (!ruta || ruta.deleted || m.fromIndex >= ruta.waypoints.length) {
      return descartar(a, 'landing_at_base', 'la ruta o el nodo no existen');
    }
    let r = this.patrullaDe(a, 'landing_at_base', m.relayId);
    if (r === null) return;
    // Autosuficiente: si el pedido se perdió, el ref lo encuentra; si tampoco,
    // se crea con estos datos.
    r ??= this.relevoDeRef(a, m.ref);
    if (!r) {
      const creado = this.crear(a, m.ref, { motivo: 'patrulla', routeId: m.routeId, fromIndex: m.fromIndex, descendiendo: true });
      this.enviarStatus(creado);
      return;
    }
    if (!this.esActivo(r)) return descartar(a, 'landing_at_base', `el relevo ${r.id} ya terminó`);
    this.adoptarRef(a, m.ref, r.id);
    r.descendiendo = true;
    if (r.estado === 'RESERVADO' || r.estado === 'SIN_RELEVO') {
      if (!this.asignar(r)) this.sinCandidato(r);
      return;
    }
    this.guardar(r);
  }

  private aterrizoEnBase(a: string, m: AterrizajeEnBase): void {
    const r = this.patrullaDe(a, 'landed_at_base', m.relayId);
    if (r === null) return;
    this.levantarBloqueo(a, m);
    if (!r || !this.esActivo(r)) return;
    r.aterrizado = true;
    r.aAbajo = true;
    this.despacharSiPuede(r);
  }

  /**
   * A dejó libre la plataforma (aterrizó o se desvió): en `RESERVADO` o
   * `SIN_RELEVO` se elige y se despacha en el acto (`relay_start` + `relay_go`),
   * y con B ya en camino sale el `relay_go` (§1.b).
   */
  private despacharSiPuede(r: Relevo): void {
    if (r.estado === 'RESERVADO' || r.estado === 'SIN_RELEVO') {
      if (!this.asignar(r)) this.sinCandidato(r);
      return;
    }
    if (r.estado === 'EN_CAMINO') this.darGo(r);
    this.actualizar(r, {});
  }

  /** Si A venía desviado a la base donde aterrizó, se levanta el bloqueo de sus despegues (§1.b). */
  private levantarBloqueo(a: string, m: AterrizajeEnBase): void {
    const desvio = this.desvios.get(a);
    if (!desvio) return;
    const donde = m.baseId ?? this.baseEnPosicion(posicionValida(m.lat, m.lon) ?? this.posicionDe(a))?.id ?? null;
    if (desvio.motivo === 'emergencia' || (donde !== null && donde === desvio.baseId)) this.desvios.delete(a);
  }

  private desviado(a: string, m: Desvio): void {
    const r = this.patrullaDe(a, 'rth_diverted', m.relayId);
    if (r === null) return;
    const anterior = this.desvios.get(a);
    // Idempotente: se repite en cada reconexión; un evento por destino nuevo.
    if (anterior?.baseId !== m.baseId || anterior?.motivo !== m.motivo) {
      this.desvios.set(a, { baseId: m.baseId, motivo: m.motivo, desde: this.ahora() });
      this.registrarDesvio(a, m, r?.id ?? null);
    }
    if (!r || !this.esActivo(r) || r.aAbajo) return;
    r.aAbajo = true;
    this.despacharSiPuede(r);
  }

  private registrarDesvio(a: string, m: Desvio, relevoId: number | null): void {
    const base = m.baseId === null ? undefined : getBase(m.baseId);
    const ubicacion = posicionValida(m.lat, m.lon);
    const mensaje = m.motivo === 'otra_base'
      ? `${nombreDeDron(a)} no llega a su base: se desvía a "${base?.name ?? `la base ${m.baseId}`}"`
      : `${nombreDeDron(a)} no llega a ninguna base: protocolo de última ubicación`;
    const ev = createLog('drone', 'RTH_DIVERTED', 'backend', mensaje, {
      droneId: a,
      meta: {
        drone: metaDron(a),
        ...(ubicacion ? { ubicacion: { ...ubicacion, accuracyM: null } } : {}),
        detalle: { motivo: m.motivo, baseId: m.baseId, base: base?.name ?? null, relevoId },
      },
    });
    this.deps.difundir({ type: 'event', event: ev });
  }

  // ---- Órdenes del operador y decisiones (§3.9 y §3.10) ----

  /**
   * `start_route`, `stop_patrol`, `force_goto` o `resume_patrol` de un operador
   * hacia un dron. Hacia B, cancelan el relevo sin `relay_cancel` (la orden que
   * sigue ya le dice a la app qué hacer); a un B solo reservado, que no sabe
   * nada, se le quita la reserva. Hacia A en un seguimiento, cuentan como
   * `relay_abandon`. Se llama ANTES de reenviar la orden.
   */
  ordenDelOperador(droneId: string): void {
    for (const { id } of this.activos()) {
      // Se relee: atender uno puede haber tocado a otro (una reserva que se mueve).
      const r = this.leer(id) as Relevo;
      if (r.relevo === droneId && r.estado === 'RESERVADO') {
        r.relevo = null;
        if (!this.asignar(r, [droneId])) this.sinCandidato(r);
      } else if (r.relevo === droneId && ESTADOS_CON_B_AVISADO.includes(r.estado)) {
        this.terminar(r, 'CANCELADO', 'orden_del_operador');
      } else if (r.origen === droneId && r.motivo === 'seguimiento' && r.estado !== 'TRASPASO') {
        this.origenSeVa(r);
      }
    }
  }

  /** Una alerta descartada cancela su relevo de seguimiento: B vuelve (§3.10). */
  alDescartarAlerta(alertId: number): void {
    for (const r of this.activos()) {
      if (r.motivo !== 'seguimiento' || r.alertId !== alertId) continue;
      if (r.relevo && ESTADOS_CON_B_AVISADO.includes(r.estado)) {
        this.deps.enviar(r.relevo, { type: 'relay_cancel', relayId: r.id, motivo: 'alerta_descartada' });
      }
      this.terminar(r, 'CANCELADO', 'alerta_descartada');
    }
    for (const id of [...this.posteriores.keys()]) {
      if (this.leer(id)?.alertId === alertId) this.posteriores.delete(id);
    }
  }

  /**
   * A tocó tierra fuera de una base (protocolo de última ubicación): un pedido
   * de patrulla sin candidato ya no tiene a quién esperar (`sin_relevo`: "A
   * aterrizó o se fue").
   */
  alAterrizarFueraDeBase(droneId: string): void {
    for (const r of this.activos()) {
      if (r.origen === droneId && r.motivo === 'patrulla' && r.estado === 'SIN_RELEVO') {
        this.terminar(r, 'CANCELADO', 'sin_relevo');
      }
    }
  }

  /**
   * Si el dron participa de un relevo activo, en cualquiera de los dos roles.
   * El hub lo usa para soltar el control sin `resume_patrol` (§3.9): un
   * `resume_patrol` a B lo sacaría del relevo, y a A lo mandaría a patrullar
   * con la batería que lo hizo pedir uno.
   */
  participaDeUnRelevoActivo(droneId: string): boolean {
    return this.activos().some((r) => r.origen === droneId || r.relevo === droneId);
  }

  // ---- Barrido (cada 1 s) ----

  /**
   * Revisa todo lo que vence con el reloj: la respuesta de B (10 s), el
   * despegue (120 s), el traspaso (30 s), B desconectado (20 s), los pedidos
   * pendientes, y lo que se repite cada 5 s (`relay_status` en camino y
   * `relay_target` sin enlace). Es idempotente para un mismo instante: correrlo
   * dos veces seguidas no manda nada dos veces.
   */
  barrer(): void {
    const ahora = this.ahora();
    for (const { id } of this.activos()) {
      // Se relee: atender uno puede haber movido la reserva de otro. Ninguno
      // termina a otro, así que sigue activo.
      const r = this.leer(id) as Relevo;
      if (r.venceEn !== null && r.venceEn <= ahora) this.vencer(r);
      else if (this.bDesconectado(r, ahora)) this.terminar(r, 'FALLIDO', 'relevo_desconectado');
      else if (r.estado === 'SIN_RELEVO') this.asignar(r);
      else this.repetir(r, ahora);
    }
    for (const [id, hasta] of [...this.posteriores]) {
      const r = this.leer(id);
      if (!r || hasta <= ahora) this.posteriores.delete(id);
      else this.targetSinEnlace(r, ahora);
    }
  }

  private bDesconectado(r: Relevo, ahora: number): boolean {
    if (!r.relevo || !ESTADOS_CON_B_AVISADO.includes(r.estado) || this.deps.conectado(r.relevo)) return false;
    const desde = this.desconectadoDesde.get(r.relevo);
    return desde !== undefined && ahora - desde > PLAZOS.relevoDesconectadoMs;
  }

  /**
   * Un vencimiento cumplido. Hay uno por estado con B avisado (`venceEn` no se
   * pone en ningún otro): la respuesta de B, el despegue y el traspaso.
   */
  private vencer(r: Relevo): void {
    const b = r.relevo as string;
    if (r.estado === 'ORDENADO') {
      // Sin respuesta en 10 s cuenta como rechazo; B se entera por si su
      // respuesta todavía está en camino.
      this.deps.enviar(b, { type: 'relay_cancel', relayId: r.id, motivo: 'vencido' });
      this.descartarB(r, b, 'sin_respuesta', `${nombreDeDron(b)} no contestó a tiempo el relevo de ${nombreDeDron(r.origen)}`);
    } else if (r.estado === 'EN_CAMINO') {
      this.deps.enviar(b, { type: 'relay_cancel', relayId: r.id, motivo: 'vencido' });
      this.terminar(r, 'FALLIDO', 'sin_despegue');
    } else {
      this.terminar(r, 'COMPLETADO', 'origen_sin_confirmar');
    }
  }

  private repetir(r: Relevo, ahora: number): void {
    if (r.estado === 'EN_CAMINO' && ahora - (this.ultimoStatusEnviado.get(r.id) ?? 0) >= PLAZOS.relayStatusEnCaminoMs) {
      this.enviarStatus(r);
    }
    // Un relay_go que esperaba que se libere la base (desvío) o que A baje.
    if (r.motivo === 'patrulla' && r.estado === 'EN_CAMINO' && r.aAbajo && !r.goEnviado) {
      this.darGo(r);
      if (r.goEnviado) this.actualizar(r, {});
    }
    if (r.motivo === 'seguimiento' && (r.estado === 'EN_CAMINO' || r.estado === 'TRASPASO')) this.targetSinEnlace(r, ahora);
  }

  /** `relay_target` cada 5 s mientras A está desconectado o callado (§2.b). */
  private targetSinEnlace(r: Relevo, ahora: number): void {
    const visto = this.vistos.get(r.origen);
    const callado = !this.deps.conectado(r.origen) || !visto || ahora - visto.recibidoEn > PLAZOS.aSinStatusParaSinEnlaceMs;
    if (!callado || ahora - (this.ultimoTargetEnviado.get(r.id) ?? 0) < PLAZOS.relayTargetSinEnlaceMs) return;
    const retirado = r.origenRetirado || (visto !== undefined && estadoRetirado(visto.status.state));
    this.enviarTarget(r, retirado ? 'retirado' : 'sin_enlace');
  }
}

/** Anota un mensaje descartado en el log del proceso (§1.b): con el dron, el tipo y el motivo. */
function descartar(droneId: string, tipo: unknown, motivo: string): void {
  console.warn(`[relevos] se descartó un ${String(tipo)} de ${droneId}: ${motivo}`);
}
