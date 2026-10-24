import { GRADOS_POR_MUESCA } from './pilotaje';
import {
  MULTIPLICADOR_RAPIDO,
  VELOCIDAD_NORMAL,
  type VelocidadesDeTeclado,
} from './components/useTecladoDeVuelo';

/**
 * Los ajustes del control manual de cada persona: cuánto gira el dron y cuánto
 * se inclina la cámara con el mouse, a qué velocidad vuela el teclado y cuánto
 * mueve la cámara cada muesca de la rueda. Son de la PERSONA y no del dron, y
 * viven en el Comando Central (GET/PUT /api/me/preferencias, PROTOCOLS §5) para
 * que la sigan de una computadora a otra; acá hay además una copia por usuario
 * en el navegador, que es con lo que la vista arranca sin esperar a la red.
 *
 * Los rangos y los valores por defecto son los de docs/contrato/preferencias.json,
 * los mismos con que valida el backend (backend/src/preferencias.ts): si uno
 * cambia, cambian juntos el archivo y las dos puntas.
 */

export interface ControlesDeVuelo {
  /** Multiplica el giro (yaw) que pide el movimiento horizontal en el modo mouse. */
  sensibilidadHorizontal: number;
  /** Multiplica la inclinación de la cámara que pide el movimiento vertical. */
  sensibilidadVertical: number;
  /** Mouse hacia arriba mira más abajo, como la palanca de un avión. */
  invertirVertical: boolean;
  /** W, A, S y D sin Shift, en fracción del recorrido de la palanca. */
  velocidadNormal: number;
  /** Lo que multiplica Shift sostenida (con tope en el fondo de la palanca). */
  multiplicadorShift: number;
  /** Espacio, C y Ctrl sin Shift. */
  velocidadSubida: number;
  /** Q y E sin Shift. */
  velocidadGiro: number;
  /** Grados por muesca de la rueda. */
  pasoDeRueda: number;
}

export type ClaveNumerica = Exclude<keyof ControlesDeVuelo, 'invertirVertical'>;

export type RangoDeAjuste = Readonly<{ minimo: number; maximo: number; paso: number; porDefecto: number }>;

/** Los deslizadores: rango, paso y valor por defecto de cada número. */
export const RANGOS: Readonly<Record<ClaveNumerica, RangoDeAjuste>> = {
  sensibilidadHorizontal: { minimo: 0.2, maximo: 3, paso: 0.1, porDefecto: 1 },
  sensibilidadVertical: { minimo: 0.2, maximo: 3, paso: 0.1, porDefecto: 1 },
  velocidadNormal: { minimo: 0.1, maximo: 1, paso: 0.05, porDefecto: VELOCIDAD_NORMAL },
  multiplicadorShift: { minimo: 1, maximo: 4, paso: 0.25, porDefecto: MULTIPLICADOR_RAPIDO },
  velocidadSubida: { minimo: 0.1, maximo: 1, paso: 0.05, porDefecto: VELOCIDAD_NORMAL },
  velocidadGiro: { minimo: 0.1, maximo: 1, paso: 0.05, porDefecto: VELOCIDAD_NORMAL },
  pasoDeRueda: { minimo: 1, maximo: 15, paso: 1, porDefecto: GRADOS_POR_MUESCA },
};

const CLAVES_NUMERICAS = Object.keys(RANGOS) as ClaveNumerica[];

export const CONTROLES_POR_DEFECTO: Readonly<ControlesDeVuelo> = Object.freeze({
  ...(Object.fromEntries(CLAVES_NUMERICAS.map((clave) => [clave, RANGOS[clave].porDefecto])) as Record<ClaveNumerica, number>),
  invertirVertical: false,
});

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * Lo que llegó del Comando Central o de la copia local, llevado a un juego
 * válido clave por clave: lo que falta o no sirve (un número fuera de rango, un
 * texto, una copia de una versión vieja) cae a su valor por defecto. Nada de eso
 * puede dejar la vista de pilotaje con un giro de NaN.
 */
export function normalizarControles(crudo: unknown): ControlesDeVuelo {
  const controles: ControlesDeVuelo = { ...CONTROLES_POR_DEFECTO };
  if (!esObjeto(crudo)) return controles;
  for (const clave of CLAVES_NUMERICAS) {
    const valor = crudo[clave];
    const { minimo, maximo } = RANGOS[clave];
    if (typeof valor === 'number' && Number.isFinite(valor) && valor >= minimo && valor <= maximo) controles[clave] = valor;
  }
  if (typeof crudo.invertirVertical === 'boolean') controles.invertirVertical = crudo.invertirVertical;
  return controles;
}

/** Las velocidades que usa el teclado de vuelo (useTecladoDeVuelo). */
export function velocidadesDeTeclado(controles: ControlesDeVuelo): VelocidadesDeTeclado {
  return {
    avance: controles.velocidadNormal,
    subida: controles.velocidadSubida,
    giro: controles.velocidadGiro,
    rapido: controles.multiplicadorShift,
  };
}

// ---- La copia local, por usuario ----

/**
 * Una entrada por usuario, para que dos personas que comparten la computadora
 * de la guardia no arranquen con la mano de la otra. No se borra al cerrar la
 * sesión: es justamente lo que la próxima sesión de esa persona necesita si el
 * Comando Central no contesta.
 */
export function claveDeCache(usuario: string): string {
  return `cc_controles:${usuario}`;
}

/**
 * La copia local de esta persona, o `null` si no hay. El navegador puede negar
 * el almacenamiento (una ventana privada, el sitio bloqueado) y eso no puede
 * impedir volar: se arranca con los valores por defecto.
 */
export function leerCacheDeControles(usuario: string): ControlesDeVuelo | null {
  if (!usuario) return null;
  try {
    const guardado = localStorage.getItem(claveDeCache(usuario));
    return guardado === null ? null : normalizarControles(JSON.parse(guardado));
  } catch {
    return null;
  }
}

/**
 * Guarda la copia local. `sinGuardar` la marca como adelantada al Comando
 * Central: un cambio que todavía no se guardó allá, o cuyo guardado falló. La
 * marca va en la misma entrada (y `normalizarControles` la ignora al leer) para
 * que no pueda quedar una sin la otra.
 */
export function guardarCacheDeControles(usuario: string, controles: ControlesDeVuelo, sinGuardar = false): void {
  if (!usuario) return;
  try {
    localStorage.setItem(claveDeCache(usuario), JSON.stringify(sinGuardar ? { ...controles, sinGuardar } : controles));
  } catch {
    /* sin almacenamiento local queda sólo la copia del Comando Central */
  }
}

/**
 * ¿La copia local quedó adelantada al Comando Central? Es lo que la persona
 * eligió último en esta computadora (el aviso prometió que seguía valiendo), así
 * que la próxima vista la manda en vez de aceptar lo que conteste el GET.
 */
export function quedoSinGuardar(usuario: string): boolean {
  if (!usuario) return false;
  try {
    const guardado = localStorage.getItem(claveDeCache(usuario));
    return guardado !== null && (JSON.parse(guardado) as { sinGuardar?: unknown } | null)?.sinGuardar === true;
  } catch {
    return false;
  }
}

// ---- Cómo se lee cada valor ----

/** "1,25": hasta dos decimales y con coma, como se escribe acá. */
function conComa(n: number): string {
  return String(Math.round(n * 100) / 100).replace('.', ',');
}

/** Lo que muestra el deslizador al lado del rótulo, y lo que dice el lector de pantalla. */
export function textoDeAjuste(clave: ClaveNumerica, valor: number): { visible: string; leido: string } {
  if (clave === 'pasoDeRueda') return { visible: `${conComa(valor)}°`, leido: `${conComa(valor)} grados por muesca` };
  if (clave === 'velocidadNormal' || clave === 'velocidadSubida' || clave === 'velocidadGiro') {
    const pct = Math.round(valor * 100);
    return { visible: `${pct} %`, leido: `${pct} por ciento de la palanca` };
  }
  return { visible: `${conComa(valor)}×`, leido: `${conComa(valor)} ${valor === 1 ? 'vez' : 'veces'}` };
}
