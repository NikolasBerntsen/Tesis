import { db } from './db';

/**
 * Las preferencias de cada persona: por ahora, cómo le gusta manejar el dron en
 * la vista de pilotaje (sensibilidad del mouse, velocidades del teclado, el paso
 * de la rueda). Son de la PERSONA y no del dron: el operador vuela drones
 * distintos en cada guardia y desde computadoras distintas, y la mano es la
 * misma. Por eso viven acá, en el Comando Central, y no sólo en el navegador
 * (la consola guarda una copia local para arrancar sin esperar la red).
 *
 * Los rangos y los valores por defecto son los de docs/contrato/preferencias.json:
 * el backend valida con estos números y la consola arma sus deslizadores con
 * los mismos. Si uno cambia, cambian juntos el archivo y las dos puntas.
 */

/** Techo del cuerpo del PUT: el juego completo de ajustes ocupa unos 250 bytes. */
export const CUERPO_MAXIMO_BYTES = 2048;

/**
 * Si el cuerpo ya parseado pasa el techo. El parser general acepta hasta 8 MB
 * (las alertas traen una captura): lo que pase de 2 KB acá no es un juego de
 * ajustes, y se corta antes de recorrerlo. Sin cuerpo no hay nada que medir.
 */
export function excedeElTamanio(cuerpo: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(cuerpo) ?? '') > CUERPO_MAXIMO_BYTES;
}

interface RangoNumerico {
  tipo: 'numero';
  minimo: number;
  maximo: number;
  porDefecto: number;
}
interface Interruptor {
  tipo: 'booleano';
  porDefecto: boolean;
}

export interface PreferenciasDeControl {
  /** Multiplicador del giro (yaw) que pide el movimiento horizontal del mouse en el modo mouse. */
  sensibilidadHorizontal: number;
  /** Multiplicador de la inclinación de la cámara que pide el movimiento vertical. */
  sensibilidadVertical: number;
  /** Mouse hacia arriba mira más abajo, como en un simulador de vuelo. */
  invertirVertical: boolean;
  /** W, A, S y D sin Shift, en fracción del recorrido de la palanca. */
  velocidadNormal: number;
  /** Cuánto multiplica Shift sostenida las tres velocidades (con tope en 1). */
  multiplicadorShift: number;
  /** Espacio y C (o Ctrl) sin Shift. */
  velocidadSubida: number;
  /** Q y E sin Shift. */
  velocidadGiro: number;
  /** Grados que inclina la cámara cada muesca de la rueda. */
  pasoDeRueda: number;
}

type ClaveDeControl = keyof PreferenciasDeControl;

export const AJUSTES_DE_CONTROL: { readonly [K in ClaveDeControl]: PreferenciasDeControl[K] extends boolean ? Interruptor : RangoNumerico } = {
  sensibilidadHorizontal: { tipo: 'numero', minimo: 0.2, maximo: 3, porDefecto: 1 },
  sensibilidadVertical: { tipo: 'numero', minimo: 0.2, maximo: 3, porDefecto: 1 },
  invertirVertical: { tipo: 'booleano', porDefecto: false },
  velocidadNormal: { tipo: 'numero', minimo: 0.1, maximo: 1, porDefecto: 0.5 },
  multiplicadorShift: { tipo: 'numero', minimo: 1, maximo: 4, porDefecto: 2 },
  velocidadSubida: { tipo: 'numero', minimo: 0.1, maximo: 1, porDefecto: 0.5 },
  velocidadGiro: { tipo: 'numero', minimo: 0.1, maximo: 1, porDefecto: 0.5 },
  pasoDeRueda: { tipo: 'numero', minimo: 1, maximo: 15, porDefecto: 5 },
};

const CLAVES = Object.keys(AJUSTES_DE_CONTROL) as ClaveDeControl[];
// Un Set y no `clave in AJUSTES_DE_CONTROL`: el objeto hereda Object.prototype,
// y "toString" o "constructor" pasarían por ajustes conocidos (ver ROLE_RANK en
// auth.ts, que se comió el mismo error).
const CONOCIDAS: ReadonlySet<string> = new Set(CLAVES);

export const CONTROLES_POR_DEFECTO: Readonly<PreferenciasDeControl> = Object.freeze(
  Object.fromEntries(CLAVES.map((clave) => [clave, AJUSTES_DE_CONTROL[clave].porDefecto])) as unknown as PreferenciasDeControl,
);

export interface Preferencias {
  controles: PreferenciasDeControl;
  /** Cuándo las guardó por última vez; `null` si nunca guardó nada (son las de fábrica). */
  actualizadoEn: string | null;
}

export type LecturaDePreferencias = { ok: true; controles: PreferenciasDeControl } | { ok: false; error: string };

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** "0,2": los rangos en el mensaje de error se escriben como se escriben acá. */
function conComa(n: number): string {
  return String(n).replace('.', ',');
}

/**
 * Si un valor sirve para un ajuste. Nada se convierte (PROTOCOLS §1.b): un "1.5"
 * en texto o un `null` no son el 1,5 ni el valor por defecto, son un cliente que
 * manda otra cosa, y adivinar qué quiso es peor que decirle que no.
 */
function valeParaElAjuste(clave: ClaveDeControl, valor: unknown): boolean {
  const ajuste = AJUSTES_DE_CONTROL[clave];
  if (ajuste.tipo === 'booleano') return typeof valor === 'boolean';
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= ajuste.minimo && valor <= ajuste.maximo;
}

function errorDelAjuste(clave: ClaveDeControl): string {
  const ajuste = AJUSTES_DE_CONTROL[clave];
  return ajuste.tipo === 'booleano'
    ? `controles.${clave} tiene que ser true o false`
    : `controles.${clave} tiene que ser un número entre ${conComa(ajuste.minimo)} y ${conComa(ajuste.maximo)}`;
}

/** El primer campo de `objeto` que no está en `permitidos`, o `undefined`. */
function primerDesconocido(objeto: Record<string, unknown>, permitidos: ReadonlySet<string>): string | undefined {
  return Object.keys(objeto).find((clave) => !permitidos.has(clave));
}

const CAMPOS_DEL_CUERPO: ReadonlySet<string> = new Set(['controles']);

/**
 * Valida el cuerpo de `PUT /api/me/preferencias` y devuelve el juego COMPLETO de
 * ajustes que hay que guardar. El PUT reemplaza: lo que no viene vuelve a su
 * valor por defecto, así `{"controles": {}}` es "restablecer" y un juego que se
 * guardó antes de que existiera un ajuste nuevo sigue siendo válido.
 *
 * Sólo se aceptan las claves conocidas, arriba y adentro de `controles`: un
 * `username` en el cuerpo no cambia de quién son las preferencias (eso lo dice
 * el token) y no se ignora en silencio, para que nadie crea que sirvió.
 */
export function leerPreferencias(cuerpo: unknown): LecturaDePreferencias {
  if (!esObjeto(cuerpo)) return { ok: false, error: 'El cuerpo tiene que ser un objeto con controles' };
  const extra = primerDesconocido(cuerpo, CAMPOS_DEL_CUERPO);
  if (extra !== undefined) return { ok: false, error: `Campo desconocido: ${extra}` };
  const crudos = cuerpo.controles;
  if (!esObjeto(crudos)) return { ok: false, error: 'controles es requerido y tiene que ser un objeto' };
  const desconocida = primerDesconocido(crudos, CONOCIDAS);
  if (desconocida !== undefined) return { ok: false, error: `Ajuste desconocido: controles.${desconocida}` };

  const controles = { ...CONTROLES_POR_DEFECTO };
  for (const clave of CLAVES) {
    const valor = crudos[clave];
    // Un JSON no puede traer `undefined`: es una clave que no vino.
    if (valor === undefined) continue;
    if (!valeParaElAjuste(clave, valor)) return { ok: false, error: errorDelAjuste(clave) };
    (controles as Record<ClaveDeControl, unknown>)[clave] = valor;
  }
  return { ok: true, controles };
}

/**
 * Lo guardado, llevado a un juego válido clave por clave: lo que no sirve
 * —un JSON roto, un ajuste que ya no existe, un valor de cuando el rango era
 * otro— cae a su valor por defecto en vez de tumbar la vista de pilotaje. Lo que
 * entró por el PUT ya pasó por `leerPreferencias`; esto cubre lo que el tiempo
 * le hace a una fila.
 */
export function normalizarGuardadas(texto: string): PreferenciasDeControl {
  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    return { ...CONTROLES_POR_DEFECTO };
  }
  const controles = { ...CONTROLES_POR_DEFECTO };
  if (!esObjeto(crudo)) return controles;
  for (const clave of CLAVES) {
    if (valeParaElAjuste(clave, crudo[clave])) (controles as Record<ClaveDeControl, unknown>)[clave] = crudo[clave];
  }
  return controles;
}

type FilaDePreferencias = { controles: string; actualizado_en: string };

/** Las preferencias de la persona, o las de fábrica si nunca guardó nada. */
export function preferenciasDe(username: string): Preferencias {
  const fila = db
    .prepare('SELECT controles, actualizado_en FROM preferencias_de_usuario WHERE username = ?')
    .get(username) as FilaDePreferencias | undefined;
  if (!fila) return { controles: { ...CONTROLES_POR_DEFECTO }, actualizadoEn: null };
  return { controles: normalizarGuardadas(fila.controles), actualizadoEn: fila.actualizado_en };
}

/** Reemplaza las preferencias de la persona por este juego (ya validado). */
export function guardarPreferencias(username: string, controles: PreferenciasDeControl): Preferencias {
  const actualizadoEn = new Date().toISOString();
  db.prepare(
    `INSERT INTO preferencias_de_usuario (username, controles, actualizado_en) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET controles = excluded.controles, actualizado_en = excluded.actualizado_en`,
  ).run(username, JSON.stringify(controles), actualizadoEn);
  return { controles: { ...controles }, actualizadoEn };
}
