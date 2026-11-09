/**
 * Los ajustes del dron (PROTOCOLS §2 `ajustes`, §5 `PATCH /api/drones/:droneId/ajustes`
 * y §6; diseño en VUELO §5, §6 y §10): tres datos del APARATO y no de un
 * vuelo, que la consola fija, el hub guarda con el activo y la app aplica. Se
 * le mandan a la app en el acto y en cada conexión, y la ficha los trae.
 *
 * `null` es «el de fábrica de la app», y el hub nunca lo rellena con el valor
 * de fábrica: si la app cambia el suyo, el dron que nunca se tocó lo sigue sin
 * que nadie migre nada acá.
 *
 * Los rangos y los valores de fábrica son los de docs/contrato/ajustes.json:
 * el backend valida con estos números, la consola arma sus controles con ellos
 * y la app recorta a ellos. Si cambia uno, cambian juntos el documento, el
 * archivo y las tres puntas (la prueba unitaria los compara).
 *
 * La regla de validación es la de §1.b: **nada se convierte**. Un `"3"` no es
 * 3, un `true` no es 1 y un `10.5` no es un entero: un cliente que manda otra
 * cosa está roto, y adivinar qué quiso es peor que decirle que no.
 */

/** Qué hace el dron con un objetivo confirmado y mientras lo tenga (VUELO §5). */
export const REACCIONES_A_DETECCION = ['seguir_y_orbitar', 'orbitar', 'seguir', 'detenerse'] as const;
export type ReaccionADeteccion = (typeof REACCIONES_A_DETECCION)[number];

/** Cómo nombra la consola a cada reacción; el registro usa el mismo rótulo. */
export const ROTULOS_DE_REACCION: Readonly<Record<ReaccionADeteccion, string>> = {
  seguir_y_orbitar: 'Seguimiento y órbita',
  orbitar: 'Órbita en el lugar',
  seguir: 'Seguimiento',
  detenerse: 'Detenerse y vigilar',
};

export const AJUSTES_DEL_DRON = {
  /**
   * La velocidad tangencial de la órbita, en m/s. Menos de 1 m/s es quedarse
   * quieto sobre el círculo y más de 8 es el crucero. Se redondea a un decimal.
   */
  velocidadOrbitaMs: { tipo: 'numero', minimo: 1, maximo: 8, paso: 0.5, decimales: 1, porDefecto: 4 },
  reaccionADeteccion: { tipo: 'enum', valores: REACCIONES_A_DETECCION, porDefecto: 'seguir_y_orbitar' },
  /** Cuántos segundos no se detiene por una detección después de dejar un objetivo (VUELO §6). De a 5. */
  silencioAlRetomarS: { tipo: 'entero', minimo: 0, maximo: 30, paso: 5, porDefecto: 15 },
} as const;

/** Los tres ajustes como los guarda el hub y los lleva la ficha: `null` es el de fábrica. */
export interface AjustesDelDron {
  velocidadOrbitaMs: number | null;
  reaccionADeteccion: ReaccionADeteccion | null;
  silencioAlRetomarS: number | null;
}

export type ClaveDeAjuste = keyof AjustesDelDron;

export const CLAVES_DE_AJUSTE = Object.keys(AJUSTES_DEL_DRON) as readonly ClaveDeAjuste[];

/**
 * Lo que pide un PATCH, ya validado: SOLO las claves que vinieron, cada una con
 * su valor o con `null` (de fábrica). Las que no vinieron no están, para que
 * quien lo aplique no toque lo que nadie pidió tocar.
 */
export type AjustesPedidos = Partial<AjustesDelDron>;

export type LecturaDeAjustes = { ok: true; ajustes: AjustesPedidos } | { ok: false; error: string };

export function esReaccionADeteccion(valor: unknown): valor is ReaccionADeteccion {
  return typeof valor === 'string' && (REACCIONES_A_DETECCION as readonly string[]).includes(valor);
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

const ERROR_SIN_AJUSTES = 'Nada para ajustar: mandá velocidadOrbitaMs, reaccionADeteccion o silencioAlRetomarS';

const { velocidadOrbitaMs: VELOCIDAD, silencioAlRetomarS: SILENCIO } = AJUSTES_DEL_DRON;

type LecturaDeUnAjuste<T> = { ok: true; valor: T | null } | { ok: false; error: string };

/**
 * Un número finito dentro del rango, redondeado a un decimal (3.456 → 3.5); o
 * `null`. Un texto no es una velocidad, y un `0` que nadie escribió sería una
 * órbita que no gira.
 */
function leerVelocidadDeOrbita(valor: unknown): LecturaDeUnAjuste<number> {
  if (valor === null) return { ok: true, valor: null };
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    return { ok: false, error: 'velocidadOrbitaMs tiene que ser un número o null' };
  }
  if (valor < VELOCIDAD.minimo || valor > VELOCIDAD.maximo) {
    return { ok: false, error: `velocidadOrbitaMs tiene que estar entre ${VELOCIDAD.minimo} y ${VELOCIDAD.maximo} m/s` };
  }
  return { ok: true, valor: Math.round(valor * 10) / 10 };
}

const ERROR_REACCION = `reaccionADeteccion tiene que ser ${REACCIONES_A_DETECCION.slice(0, -1).join(', ')} o ${
  REACCIONES_A_DETECCION[REACCIONES_A_DETECCION.length - 1]
}, o null`;

/** Uno de los valores exactos de la lista (en minúsculas, como están), o `null`. */
function leerReaccion(valor: unknown): LecturaDeUnAjuste<ReaccionADeteccion> {
  if (valor === null || esReaccionADeteccion(valor)) return { ok: true, valor };
  return { ok: false, error: ERROR_REACCION };
}

/**
 * Un entero de 0 a 30 que vaya de a 5, o `null`. `Number.isSafeInteger` deja
 * afuera el 10.5, el `true` y el `"10"` de una sola vez.
 */
function leerSilencio(valor: unknown): LecturaDeUnAjuste<number> {
  if (valor === null) return { ok: true, valor: null };
  const vale =
    Number.isSafeInteger(valor) &&
    (valor as number) >= SILENCIO.minimo &&
    (valor as number) <= SILENCIO.maximo &&
    (valor as number) % SILENCIO.paso === 0;
  if (!vale) {
    return {
      ok: false,
      error: `silencioAlRetomarS tiene que ser un entero entre ${SILENCIO.minimo} y ${SILENCIO.maximo}, de a ${SILENCIO.paso}, o null`,
    };
  }
  return { ok: true, valor: valor as number };
}

/**
 * Valida el cuerpo de `PATCH /api/drones/:droneId/ajustes` y devuelve SOLO lo
 * que hay que cambiar. Tiene que venir al menos un ajuste conocido; las claves
 * que no son un ajuste se ignoran (es un PATCH: lo que no se nombra no se
 * toca), pero sin ninguna conocida no hay nada para ajustar y es un 400.
 *
 * Se valida todo ANTES de devolver nada: un valor inválido en cualquier clave
 * rechaza el cuerpo entero, aunque las otras estuvieran bien. Aplicar a medias
 * dejaría a la consola creyendo que fijó dos cosas cuando fijó una.
 *
 * Se leen solo las tres claves conocidas, nunca se recorren las del cuerpo: un
 * `"__proto__"` o un `"constructor"` que venga de más no llega a ningún lado.
 */
export function leerAjustes(cuerpo: unknown): LecturaDeAjustes {
  if (!esObjeto(cuerpo)) return { ok: false, error: 'El cuerpo tiene que ser un objeto con los ajustes' };
  const ajustes: AjustesPedidos = {};
  // Un JSON no puede traer `undefined`: es una clave que no vino.
  if (cuerpo.velocidadOrbitaMs !== undefined) {
    const lectura = leerVelocidadDeOrbita(cuerpo.velocidadOrbitaMs);
    if (!lectura.ok) return lectura;
    ajustes.velocidadOrbitaMs = lectura.valor;
  }
  if (cuerpo.reaccionADeteccion !== undefined) {
    const lectura = leerReaccion(cuerpo.reaccionADeteccion);
    if (!lectura.ok) return lectura;
    ajustes.reaccionADeteccion = lectura.valor;
  }
  if (cuerpo.silencioAlRetomarS !== undefined) {
    const lectura = leerSilencio(cuerpo.silencioAlRetomarS);
    if (!lectura.ok) return lectura;
    ajustes.silencioAlRetomarS = lectura.valor;
  }
  if (Object.keys(ajustes).length === 0) return { ok: false, error: ERROR_SIN_AJUSTES };
  return { ok: true, ajustes };
}

/**
 * Cómo se lee cada ajuste en el registro: «la de fábrica» / «2.5 m/s»,
 * «Órbita en el lugar», «15 s». El género es el del sustantivo (la velocidad,
 * la reacción, el silencio).
 */
export function textoDelAjuste(clave: ClaveDeAjuste, valor: number | ReaccionADeteccion | null): string {
  switch (clave) {
    case 'velocidadOrbitaMs':
      return valor === null ? 'la de fábrica' : `${valor} m/s`;
    case 'reaccionADeteccion':
      return valor === null ? 'la de fábrica' : `«${ROTULOS_DE_REACCION[valor as ReaccionADeteccion]}»`;
    default:
      return valor === null ? 'el de fábrica' : `${valor} s`;
  }
}
