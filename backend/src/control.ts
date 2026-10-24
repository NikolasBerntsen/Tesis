import { metaDron } from './meta';
import { createLog } from './store';

// Control manual entre personas (PROTOCOLS, "Control manual — bloqueo
// exclusivo"): si el que pilotea sigue ahí y cómo pasa el mando de una persona
// a otra. El lock en sí —quién tiene cada dron— vive en el hub (`controlledBy`
// en ws.ts), que es el que les habla al dron y a las consolas; acá se decide
// CUÁNDO soltarlo o traspasarlo, y el hub lo hace por las funciones que pasa.
//
// No sabe nada de sockets ni de Express, y mide los plazos con un reloj
// inyectado: así los 30 s sin señales y los 10 s de la respuesta se prueban
// moviendo el reloj, sin esperar nada.

/** Plazos del control manual, en milisegundos del reloj del hub. */
export const PLAZOS_DEL_CONTROL = {
  /**
   * Sin ninguna señal de vida del titular durante esto, el hub le suelta el
   * control. La señal es el `control_heartbeat` que la consola manda cada 5 s
   * mientras lo tiene, mire o no mire, mande o no mande (§3.b), y también cada
   * mando que le acepta. Treinta segundos son seis latidos: un corte corto de
   * la red o una pestaña que recarga no le sacan el dron a nadie, y una consola
   * que se colgó, una notebook que se durmió o una pestaña cerrada no dejan al
   * dron esperando para siempre a alguien que ya no está.
   */
  sinSenalesMs: 30_000,
  /**
   * Lo que tiene el titular para contestar un pedido de control. Sin
   * respuesta, el control pasa al que lo pidió: es lo que destraba una sesión
   * fantasma que el hub todavía cree viva (la consola sigue mandando latidos,
   * pero nadie la mira).
   */
  respuestaMs: 10_000,
} as const;

/** Cómo termina un pedido de control (`control_request_result`, PROTOCOLS §3). */
export type ResultadoDelPedido = 'cedido' | 'vencido' | 'mantenido' | 'cancelado' | 'liberado';

export type RespuestaDelTitular = 'ceder' | 'mantener';

/** Un pedido de control pendiente: uno por dron como mucho. */
export interface PedidoDeControl {
  droneId: string;
  solicitante: string;
  titular: string;
  creadoEn: number;
  venceEn: number;
}

/**
 * Lo que ven las consolas de un pedido (en `control_request` y en la ficha del
 * dron). `restanteMs` va además del vencimiento porque la cuenta regresiva la
 * hace el navegador con SU reloj, que no tiene por qué coincidir con el del
 * hub: lo que le queda, contado desde que salió el mensaje, sí coincide.
 */
export interface PedidoDeControlView {
  solicitante: string;
  titular: string;
  venceEn: string;
  restanteMs: number;
}

export type AlPedir =
  | { resultado: 'otorgado' }
  | { resultado: 'pendiente'; pedido: PedidoDeControlView }
  | { resultado: 'ocupado'; solicitante: string };

export type RespuestaDelCoordinador =
  | { ok: true; resultado: ResultadoDelPedido }
  | { ok: false; status: 403 | 409; error: string };

export interface DependenciasDelControl {
  ahora: () => number;
  /** Los locks vigentes, dron → titular. */
  locks: () => Iterable<[string, string]>;
  titular: (droneId: string) => string | null;
  /** Toma el lock de un dron libre, con todo lo que eso avisa (takeControl en ws.ts). */
  tomar: (droneId: string, username: string) => void;
  /**
   * Pasa el lock de `de` a `a` SIN soltarlo: el dron no sale de MANUAL ni
   * recibe un `control_released`, que lo haría frenar, volver al objetivo o
   * esperar una reanudación (ver `transferirControl` en ws.ts).
   */
  traspasar: (droneId: string, de: string, a: string, motivo: 'cedido' | 'vencido') => void;
  /** Suelta el lock de un titular que dejó de dar señales de vida. */
  soltarPorInactividad: (droneId: string, titular: string) => void;
  /**
   * Si la cuenta puede pilotear AHORA: activa, con `canControl` y operador o
   * más. Se relee de la base al traspasar, porque en los 10 s del pedido al
   * que lo pidió le pueden haber quitado el permiso.
   */
  puedeControlar: (username: string) => boolean;
  /** Difunde a las consolas, con el filtro por rol del hub. */
  difundir: (msg: { type: string; [clave: string]: unknown }) => void;
}

/** Lo que dice el registro de cada final que no es un traspaso. */
const FINAL_DEL_PEDIDO: Record<'mantenido' | 'cancelado' | 'liberado', string> = {
  mantenido: 'el titular mantuvo el control',
  cancelado: 'se canceló',
  liberado: 'el control quedó libre',
};

export class CoordinadorDelControl {
  /** Cuándo dio el titular de cada dron su última señal de vida. */
  private readonly vivoEn = new Map<string, number>();
  private readonly pedidos = new Map<string, PedidoDeControl>();

  constructor(private readonly deps: DependenciasDelControl) {}

  /** Alguien tomó el lock: tomarlo es la primera señal de vida. */
  alTomar(droneId: string): void {
    this.vivoEn.set(droneId, this.deps.ahora());
  }

  /**
   * Señal de vida de una consola: un `control_heartbeat` o un mando aceptado.
   * Vale solo del titular; la de cualquier otro se ignora (true si contó).
   */
  latido(droneId: string, username: string): boolean {
    if (this.deps.titular(droneId) !== username) return false;
    this.vivoEn.set(droneId, this.deps.ahora());
    return true;
  }

  /**
   * El lock se soltó, por el camino que sea: el titular, un supervisor, el
   * barrido, una cuenta suspendida, un dron dado de baja. Un pedido que
   * estaba esperando termina sin traspaso: el dron quedó libre, y quien lo
   * pidió lo toma si todavía lo quiere. Dárselo solo sería pisar lo que eligió
   * el que lo soltó (con «Devolver al patrullaje» el dron ya va a su ruta, y
   * un supervisor que quita el control no está eligiendo un piloto nuevo).
   */
  alSoltar(droneId: string, motivo: string): void {
    this.vivoEn.delete(droneId);
    const pedido = this.pedidos.get(droneId);
    if (pedido) this.terminar(pedido, 'liberado', motivo, 'backend');
  }

  /** El pedido pendiente de un dron, como lo ven las consolas; null si no hay. */
  pedidoDe(droneId: string): PedidoDeControlView | null {
    const pedido = this.pedidos.get(droneId);
    return pedido ? this.vista(pedido) : null;
  }

  /**
   * Alguien pide el control de un dron (la consola ya le avisó quién lo tiene
   * y él confirmó). Libre o ya suyo, se le da en el acto. Si lo tiene otro,
   * queda UN pedido por dron, con 10 s para que el titular conteste: el mismo
   * solicitante que vuelve a pedir (otra pestaña, un doble clic) recibe el que
   * ya estaba, y uno distinto se entera de quién se le adelantó.
   */
  pedir(droneId: string, solicitante: string): AlPedir {
    const titular = this.deps.titular(droneId);
    if (titular === null) {
      this.deps.tomar(droneId, solicitante);
      return { resultado: 'otorgado' };
    }
    if (titular === solicitante) {
      this.vivoEn.set(droneId, this.deps.ahora());
      return { resultado: 'otorgado' };
    }
    const previo = this.pedidos.get(droneId);
    if (previo) {
      return previo.solicitante === solicitante
        ? { resultado: 'pendiente', pedido: this.vista(previo) }
        : { resultado: 'ocupado', solicitante: previo.solicitante };
    }
    const ahora = this.deps.ahora();
    const pedido: PedidoDeControl = { droneId, solicitante, titular, creadoEn: ahora, venceEn: ahora + PLAZOS_DEL_CONTROL.respuestaMs };
    this.pedidos.set(droneId, pedido);
    this.deps.difundir({ type: 'control_request', droneId, ...this.vista(pedido) });
    this.registrar(
      'CONTROL_REQUESTED',
      solicitante,
      pedido,
      `${solicitante} le pidió a ${titular} el control manual del dron ${droneId}`,
      { solicitante, titular },
    );
    return { resultado: 'pendiente', pedido: this.vista(pedido) };
  }

  /**
   * La respuesta del titular. Solo él contesta. Una respuesta que llega con el
   * plazo vencido —el barrido corre cada segundo— cuenta como no contestada:
   * el control pasa igual, porque eso es lo que la consola del que lo pidió
   * le prometió.
   */
  contestar(droneId: string, quien: string, respuesta: RespuestaDelTitular): RespuestaDelCoordinador {
    const pedido = this.pedidos.get(droneId);
    if (!pedido) return { ok: false, status: 409, error: 'No hay ningún pedido de control pendiente para este dron' };
    if (pedido.titular !== quien) {
      return { ok: false, status: 403, error: `El pedido es para ${pedido.titular}, que tiene el control` };
    }
    if (this.deps.ahora() >= pedido.venceEn) return { ok: true, resultado: this.resolver(pedido, 'vencido') };
    if (respuesta === 'ceder') return { ok: true, resultado: this.resolver(pedido, 'cedido') };
    // Contestar es estar ahí: vale como señal de vida.
    this.vivoEn.set(droneId, this.deps.ahora());
    this.terminar(pedido, 'mantenido', `${quien} decidió mantener el control`, quien);
    return { ok: true, resultado: 'mantenido' };
  }

  /** El que pidió el control se arrepiente. Solo él lo cancela. */
  cancelar(droneId: string, quien: string): RespuestaDelCoordinador {
    const pedido = this.pedidos.get(droneId);
    if (!pedido) return { ok: false, status: 409, error: 'No hay ningún pedido de control pendiente para este dron' };
    if (pedido.solicitante !== quien) {
      return { ok: false, status: 403, error: `El pedido es de ${pedido.solicitante}: solo quien lo pidió lo puede cancelar` };
    }
    this.terminar(pedido, 'cancelado', `${quien} canceló el pedido`, quien);
    return { ok: true, resultado: 'cancelado' };
  }

  /**
   * Los pedidos de una cuenta que ya no puede recibir el control: cerró su
   * última consola (no se le traspasa un dron a quien no está mirando, que
   * sería fabricar justo la sesión fantasma que esto vino a evitar), o le
   * suspendieron el permiso o la cuenta.
   */
  cancelarPedidosDe(username: string, motivo: string): void {
    for (const pedido of [...this.pedidos.values()]) {
      if (pedido.solicitante === username) this.terminar(pedido, 'cancelado', motivo, 'backend');
    }
  }

  /**
   * Lo que vence, una vez por segundo. Primero los pedidos: un titular
   * fantasma con un pedido encima le pasa el dron al que lo pidió a los 10 s,
   * sin esperar a los 30 del barrido de señales. Después los titulares sin
   * señales, que se sueltan.
   */
  barrer(): void {
    const ahora = this.deps.ahora();
    for (const pedido of [...this.pedidos.values()]) {
      if (ahora >= pedido.venceEn) this.resolver(pedido, 'vencido');
    }
    for (const [droneId, titular] of [...this.deps.locks()]) {
      // Un lock sin señal anotada no debería existir (tomarlo la anota): por
      // las dudas, empieza a contar desde ahora en vez de soltarse en el acto.
      const vivo = this.vivoEn.get(droneId);
      if (vivo === undefined) this.vivoEn.set(droneId, ahora);
      else if (ahora - vivo >= PLAZOS_DEL_CONTROL.sinSenalesMs) this.deps.soltarPorInactividad(droneId, titular);
    }
  }

  /**
   * El control pasa al que lo pidió (cedido o vencido), si todavía puede
   * pilotear; si no, el pedido termina cancelado y el titular sigue.
   */
  private resolver(pedido: PedidoDeControl, motivo: 'cedido' | 'vencido'): ResultadoDelPedido {
    if (!this.deps.puedeControlar(pedido.solicitante)) {
      this.terminar(pedido, 'cancelado', `${pedido.solicitante} ya no puede controlar drones`, 'backend');
      return 'cancelado';
    }
    this.pedidos.delete(pedido.droneId);
    this.deps.traspasar(pedido.droneId, pedido.titular, pedido.solicitante, motivo);
    // El que recibe el control recién lo pidió: está ahí.
    this.vivoEn.set(pedido.droneId, this.deps.ahora());
    const texto = motivo === 'cedido' ? `${pedido.titular} cedió el control` : `${pedido.titular} no contestó a tiempo`;
    this.anunciar(pedido, motivo, texto);
    return motivo;
  }

  /** Un pedido que termina sin traspaso: se avisa y queda en el registro. */
  private terminar(
    pedido: PedidoDeControl,
    resultado: 'mantenido' | 'cancelado' | 'liberado',
    motivo: string,
    fuente: string,
  ): void {
    this.pedidos.delete(pedido.droneId);
    this.anunciar(pedido, resultado, motivo);
    this.registrar(
      'CONTROL_REQUEST_ENDED',
      fuente,
      pedido,
      `El pedido de ${pedido.solicitante} por el control manual del dron ${pedido.droneId} terminó: ` +
        `${FINAL_DEL_PEDIDO[resultado]} (${motivo})`,
      { solicitante: pedido.solicitante, titular: pedido.titular, resultado, motivo },
    );
  }

  private anunciar(pedido: PedidoDeControl, resultado: ResultadoDelPedido, motivo: string): void {
    this.deps.difundir({
      type: 'control_request_result',
      droneId: pedido.droneId,
      solicitante: pedido.solicitante,
      titular: pedido.titular,
      resultado,
      motivo,
    });
  }

  private registrar(
    tipo: string,
    fuente: string,
    pedido: PedidoDeControl,
    mensaje: string,
    detalle: Record<string, string>,
  ): void {
    const ev = createLog('drone', tipo, fuente, mensaje, {
      droneId: pedido.droneId,
      meta: { drone: metaDron(pedido.droneId), detalle },
    });
    this.deps.difundir({ type: 'event', event: ev });
  }

  private vista(pedido: PedidoDeControl): PedidoDeControlView {
    return {
      solicitante: pedido.solicitante,
      titular: pedido.titular,
      venceEn: new Date(pedido.venceEn).toISOString(),
      restanteMs: Math.max(0, pedido.venceEn - this.deps.ahora()),
    };
  }
}
