import { duracion } from './format';
import type { Alert, DroneStatus, Relevo } from './types';

/**
 * Lo que la consola hace con los relevos entre drones (RELEVOS.md §6): llevar
 * la lista al día con lo que manda el hub y decir, en la tarjeta de cada dron,
 * qué papel tiene en uno.
 *
 * El hub es la única fuente de verdad de un relevo: la consola no lo valida ni
 * deduce estados, sólo se queda con la versión más nueva de cada uno.
 */

/** En curso: el relevo todavía puede mover a alguno de los dos drones. */
export const ESTADOS_ACTIVOS: readonly string[] = ['RESERVADO', 'ORDENADO', 'EN_CAMINO', 'TRASPASO', 'SIN_RELEVO'];

export function relevoActivo(relevo: Relevo): boolean {
  return ESTADOS_ACTIVOS.includes(relevo.estado);
}

/**
 * Los terminados que se guardan además de los activos. Sirven para que el
 * detalle de un evento diga cómo terminó el relevo; más que esto, en una
 * guardia larga, es memoria que nadie mira.
 */
export const TERMINADOS_QUE_SE_GUARDAN = 50;

/** Lo mínimo para tomar algo como un relevo: un id y los dos lados nombrados. */
export function esRelevo(valor: unknown): valor is Relevo {
  if (typeof valor !== 'object' || valor === null) return false;
  const r = valor as Partial<Relevo>;
  return (
    typeof r.id === 'number' &&
    typeof r.estado === 'string' &&
    typeof r.origen?.droneId === 'string' &&
    (r.relevo === null || typeof r.relevo?.droneId === 'string')
  );
}

/**
 * Si `nuevo` es más reciente que `viejo`. Por la hora del hub y no por el orden
 * de llegada: la lista que vuelve por REST al reconectar puede haber salido
 * del hub ANTES que un `relay_updated` que llegó mientras tanto.
 */
function esMasNuevo(nuevo: Relevo, viejo: Relevo): boolean {
  const n = Date.parse(nuevo.actualizadoEn);
  const v = Date.parse(viejo.actualizadoEn);
  if (Number.isNaN(n) || Number.isNaN(v)) return true;
  return n >= v;
}

/** Deja, de los terminados, sólo los más recientes: los activos no se tocan nunca. */
function recortar(lista: Relevo[]): Relevo[] {
  const terminados = lista.filter((r) => !relevoActivo(r));
  if (terminados.length <= TERMINADOS_QUE_SE_GUARDAN) return lista;
  const viejos = new Set(
    [...terminados]
      .sort((a, b) => Date.parse(b.actualizadoEn) - Date.parse(a.actualizadoEn))
      .slice(TERMINADOS_QUE_SE_GUARDAN)
      .map((r) => r.id),
  );
  return lista.filter((r) => !viejos.has(r.id));
}

/** Un `relay_updated`: reemplaza al que tenía ese `id` (si es más nuevo) o se suma. */
export function aplicarRelevo(lista: Relevo[], relevo: Relevo): Relevo[] {
  const previo = lista.find((r) => r.id === relevo.id);
  if (!previo) return recortar([relevo, ...lista]);
  // La misma lista y no una copia: así React no repinta por una versión vieja.
  if (!esMasNuevo(relevo, previo)) return lista;
  return lista.map((r) => (r.id === relevo.id ? relevo : r));
}

/**
 * La lista de `GET /api/relevos?activos=1`, que llega al montar y en cada
 * reconexión. Un activo que la consola tenía y el hub ya no nombra terminó
 * mientras el canal estuvo caído: no se sabe cómo, y seguir mostrándolo en la
 * tarjeta sería mentir. Los terminados que ya se conocían se quedan.
 */
export function reemplazarActivos(lista: Relevo[], delHub: unknown): Relevo[] {
  // Un backend viejo no tiene la ruta y contesta otra cosa: sin lista, nada que reemplazar.
  if (!Array.isArray(delHub)) return lista;
  const validos = delHub.filter(esRelevo);
  const nombrados = new Set(validos.map((r) => r.id));
  let resultado = lista.filter((r) => !relevoActivo(r) || nombrados.has(r.id));
  for (const r of validos) resultado = aplicarRelevo(resultado, r);
  return resultado;
}

// ---- Rótulos ----

export const ESTADO_DEL_RELEVO: Record<string, string> = {
  RESERVADO: 'Reservado',
  ORDENADO: 'Ordenado',
  EN_CAMINO: 'En camino',
  TRASPASO: 'Traspaso',
  SIN_RELEVO: 'Sin relevo',
  COMPLETADO: 'Completado',
  CANCELADO: 'Cancelado',
  FALLIDO: 'Fallido',
};

/** Por qué terminó un relevo (`motivoFin`), dicho para el operador. */
export const MOTIVO_DE_FIN: Record<string, string> = {
  origen_sin_confirmar: 'El dron relevado no confirmó que se alejó',
  orden_del_operador: 'Orden de un operador',
  alerta_descartada: 'La alerta se descartó',
  sin_relevo: 'No hubo un dron disponible',
  origen_se_fue: 'El dron relevado se fue antes',
  relevo_abortado: 'El dron de relevo abortó',
  relevo_desconectado: 'El dron de relevo se desconectó',
  sin_despegue: 'El dron de relevo no pudo despegar a tiempo',
  relevo_perdio_estado: 'El dron de relevo se reconectó sin el relevo',
};

export const MOTIVO_DEL_RELEVO: Record<string, string> = {
  patrulla: 'Patrulla',
  seguimiento: 'Seguimiento',
};

/**
 * Por qué el dron de relevo rechazó la orden o abortó en el camino (el
 * `motivoDeB` de los eventos): los motivos de `relay_reject` y `relay_abort`,
 * más el que pone el hub cuando no contestó.
 */
export const MOTIVO_DEL_DRON_DE_RELEVO: Record<string, string> = {
  sin_respuesta: 'No contestó a tiempo',
  no_disponible: 'Ya no estaba disponible',
  virtual_stick: 'No se pudo habilitar el mando',
  cancelado_en_campo: 'Lo canceló el operador de campo',
  ocupado: 'Estaba en otro relevo',
  mensaje_invalido: 'La orden llegó mal',
  subida: 'Falló la subida',
  senial: 'Perdió la señal',
  bateria: 'Batería',
  dji: 'El propio DJI tomó el control',
  orden_de_campo: 'Orden del operador de campo',
  otro: 'Otro',
};

/** Adónde se desvió un regreso (`RTH_DIVERTED`). */
export const MOTIVO_DEL_DESVIO: Record<string, string> = {
  otra_base: 'A otra base',
  emergencia: 'Aterrizaje de emergencia',
};

/**
 * Un estado o un motivo que la consola no conoce (un hub más nuevo) se
 * muestra tal cual: es mejor un código que un hueco (§3 del contrato).
 */
export function estadoDelRelevo(estado: string): string {
  return ESTADO_DEL_RELEVO[estado] ?? estado;
}

export function motivoDeFin(motivo: string | null): string | null {
  if (!motivo) return null;
  return MOTIVO_DE_FIN[motivo] ?? motivo;
}

/** El tono del punto de estado: oro lo que avanza, óxido lo que falló, apagado lo que terminó. */
export function tonoDelEstado(estado: string): 'accent' | 'bad' | 'ok' | 'muted' | 'warn' {
  if (estado === 'FALLIDO') return 'bad';
  if (estado === 'SIN_RELEVO') return 'warn';
  if (estado === 'COMPLETADO') return 'ok';
  if (estado === 'CANCELADO') return 'muted';
  return 'accent';
}

// ---- Insignias de la tarjeta del dron ----

export type TonoDeInsignia = 'ok' | 'info' | 'oro' | 'malo' | 'neutro';

export interface Insignia {
  /** Estable entre renders: la `key` de React. */
  clave: string;
  texto: string;
  tono: TonoDeInsignia;
  /** Lo que se lee al pasar el mouse: el detalle que no entra en la pastilla. */
  titulo?: string;
}

function insigniaDelOrigen(r: Relevo): Insignia {
  const clave = `relevo-${r.id}`;
  const nombre = r.relevo?.displayName;
  if (r.estado === 'SIN_RELEVO' || !nombre) {
    return {
      clave,
      texto: 'Sin relevo disponible',
      tono: 'malo',
      titulo: 'Pidió un relevo y no hay ningún dron en espera que pueda salir.',
    };
  }
  if (r.estado === 'EN_CAMINO') {
    return {
      clave,
      texto: `Relevo en camino: ${nombre}`,
      tono: 'oro',
      titulo: r.etaS === null ? undefined : `Llega en ${duracion(r.etaS)}, según el hub.`,
    };
  }
  if (r.estado === 'TRASPASO') {
    return { clave, texto: `Traspaso a ${nombre}`, tono: 'oro', titulo: `${nombre} llegó y toma el objetivo.` };
  }
  return { clave, texto: `Relevo asignado: ${nombre}`, tono: 'info', titulo: `${nombre} todavía no salió.` };
}

function insigniaDelRelevo(r: Relevo): Insignia {
  const clave = `relevo-${r.id}`;
  const nombre = r.origen.displayName;
  // La reserva es tentativa: el dron de relevo todavía no sabe nada.
  if (r.estado === 'RESERVADO') {
    return { clave, texto: `Reservado para relevar a ${nombre}`, tono: 'info' };
  }
  return { clave, texto: `Relevando a ${nombre}`, tono: 'oro' };
}

/**
 * Las insignias de la tarjeta de un dron: «En espera para relevos» (del
 * `status.relevo` que manda el teléfono), «Relevo en camino: Bravo» en el que
 * lo pidió y «Relevando a Alfa» en el que va (de los relevos activos).
 */
export function insigniasDelDron(
  droneId: string,
  status: DroneStatus | null | undefined,
  relevos: readonly Relevo[],
): Insignia[] {
  const insignias: Insignia[] = [];
  const espera = status?.relevo;
  if (espera?.enEspera) {
    insignias.push({
      clave: 'espera',
      texto: 'En espera para relevos',
      tono: espera.disponible ? 'ok' : 'neutro',
      titulo: espera.disponible
        ? 'Listo para salir si otro dron lo necesita.'
        : 'En espera, pero ahora no puede salir: revisá la batería, el GPS y que esté en su base.',
    });
  }
  for (const r of relevos) {
    if (!relevoActivo(r)) continue;
    if (r.origen.droneId === droneId) insignias.push(insigniaDelOrigen(r));
    else if (r.relevo?.droneId === droneId) insignias.push(insigniaDelRelevo(r));
  }
  return insignias;
}

/** Desde que el dron de relevo recibió la orden hasta que el relevo termina. */
const RELEVO_EN_MARCHA: readonly string[] = ['ORDENADO', 'EN_CAMINO', 'TRASPASO'];

/**
 * Qué le hace al relevo una orden del operador a este dron (RELEVOS §3.9), o
 * `null` si no participa de uno en marcha. Comenzar o interrumpir una ruta,
 * forzar un nodo o retomar la ruta, dados al que va, cancelan el relevo; dados
 * al que pidió uno de seguimiento, lo hacen soltar el objetivo antes de que el
 * otro llegue. El hub lo hace igual: la consola lo dice antes del clic.
 */
export function avisoDeOrdenesEnRelevo(droneId: string, relevos: readonly Relevo[]): string | null {
  const relevo = relevos.find(
    (r) =>
      RELEVO_EN_MARCHA.includes(r.estado) && (r.relevo?.droneId === droneId || r.origen.droneId === droneId),
  );
  if (!relevo) return null;
  if (relevo.relevo?.droneId === droneId) {
    return `Está yendo a relevar a ${relevo.origen.displayName}: una orden de ruta, de nodo o de retomar cancela el relevo.`;
  }
  if (relevo.motivo !== 'seguimiento') return null;
  const quien = relevo.relevo?.displayName ?? 'Otro dron';
  return `${quien} viene a relevarlo sobre el objetivo: una orden de ruta, de nodo o de retomar lo hace soltarlo antes del traspaso.`;
}

// ---- La alerta cambia de dueño ----

/**
 * El dron que sigue al objetivo de una alerta AHORA: el que la creó, salvo que
 * un relevo se la haya pasado a otro (`seguidaPor`, RELEVOS §3.6). Es el que
 * cuenta para «Ver feed en vivo», para las pendientes de cada dron y para
 * dónde se decide.
 */
export function duenioDeLaAlerta(alerta: Pick<Alert, 'drone_id' | 'seguidaPor'>): string | null {
  return alerta.seguidaPor ?? alerta.drone_id;
}
