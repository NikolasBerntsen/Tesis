/**
 * Contraste WCAG 2.x calculado sobre los tokens de tokens.css.
 *
 * jsdom no pinta ni carga las hojas, así que ningún test de componentes ve si
 * un texto se lee. El modo oscuro se rompió justamente por eso: los tokens
 * oscuros existían, pero un degradé con un blanco escrito a mano o un texto en
 * `--tinta` encima del oro quedaban bien en mármol y mal en obsidiana, y no
 * fallaba nada. Esto lee los dos juegos de tokens, resuelve los `var()` y mide
 * el peor caso de cada par texto/fondo con la fórmula de luminancia relativa
 * de WCAG, sin navegador.
 *
 * El peor caso es estricto a propósito: de un degradé se toma la parada que
 * peor contrasta, aunque el texto no llegue a pisarla. Es más simple de
 * explicar y deja margen para botones de cualquier ancho.
 */

export type Tema = 'claro' | 'oscuro';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parte `texto` en `sep` sólo afuera de paréntesis y comillas. */
export function partirArriba(texto: string, sep: string): string[] {
  const partes: string[] = [];
  let profundidad = 0;
  let comilla: string | null = null;
  let actual = '';
  for (const c of texto) {
    if (comilla) {
      if (c === comilla) comilla = null;
    } else if (c === '"' || c === "'") {
      comilla = c;
    } else if (c === '(') {
      profundidad += 1;
    } else if (c === ')') {
      profundidad -= 1;
    } else if (c === sep && profundidad === 0) {
      partes.push(actual.trim());
      actual = '';
      continue;
    }
    actual += c;
  }
  if (actual.trim()) partes.push(actual.trim());
  return partes;
}

/** Índice del `)` que cierra el `(` que está en `desde`. */
function cierre(texto: string, desde: number): number {
  let profundidad = 0;
  for (let i = desde; i < texto.length; i++) {
    if (texto[i] === '(') profundidad += 1;
    else if (texto[i] === ')') {
      profundidad -= 1;
      if (profundidad === 0) return i;
    }
  }
  throw new Error(`paréntesis sin cerrar en: ${texto}`);
}

/** Lo que hay entre las llaves del bloque que abre en `desde`. */
function cuerpoDeBloque(css: string, desde: number): string {
  let profundidad = 0;
  for (let i = desde; i < css.length; i++) {
    if (css[i] === '{') profundidad += 1;
    else if (css[i] === '}') {
      profundidad -= 1;
      if (profundidad === 0) return css.slice(desde + 1, i);
    }
  }
  throw new Error('bloque sin cerrar');
}

function declaraciones(cuerpo: string): [string, string][] {
  return partirArriba(cuerpo, ';')
    .map((d) => {
      const i = d.indexOf(':');
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as [string, string];
    })
    .filter(([nombre]) => nombre.startsWith('--'));
}

/**
 * Los tokens de cada tema. El oscuro hereda del claro lo que no redefine, igual
 * que en la cascada: un token que sólo existe en `:root` vale en los dos.
 */
export function leerTokens(css: string): Record<Tema, Map<string, string>> {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const claro = new Map<string, string>();
  const propiosOscuro = new Map<string, string>();
  const bloque = /(^|\n)\s*:root(\[data-tema='oscuro'\])?\s*\{/g;
  for (let m = bloque.exec(limpio); m; m = bloque.exec(limpio)) {
    const destino = m[2] ? propiosOscuro : claro;
    const llave = limpio.indexOf('{', m.index + m[1].length);
    for (const [nombre, valor] of declaraciones(cuerpoDeBloque(limpio, llave))) destino.set(nombre, valor);
  }
  return { claro, oscuro: new Map([...claro, ...propiosOscuro]) };
}

/** Reemplaza cada `var(--x)` (con su respaldo, si lo trae) hasta que no quede ninguno. */
export function resolver(tokens: Map<string, string>, valor: string, vueltas = 0): string {
  if (vueltas > 20) throw new Error(`referencia circular resolviendo: ${valor}`);
  const i = valor.indexOf('var(');
  if (i === -1) return valor;
  const fin = cierre(valor, i + 3);
  const [nombre, respaldo] = partirArriba(valor.slice(i + 4, fin), ',');
  const propio = tokens.get(nombre.trim()) ?? respaldo;
  if (propio === undefined) throw new Error(`token sin definir: ${nombre}`);
  return resolver(tokens, valor.slice(0, i) + propio + valor.slice(fin + 1), vueltas + 1);
}

const NOMBRADOS: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

function hexa(h: string): Rgba {
  const d = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
  const n = (k: number) => Number.parseInt(d.slice(k, k + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: d.length === 8 ? n(6) / 255 : 1 };
}

function porcentaje(texto: string | undefined): number | undefined {
  return texto === undefined ? undefined : Number.parseFloat(texto) / 100;
}

/**
 * `color-mix(in srgb, A p%, B q%)` con alfa premultiplicado, que es como lo
 * mezcla el navegador: con `transparent` del otro lado queda A con alfa p.
 */
function mezclaDeColores(argumentos: string): Rgba {
  const [espacio, ...colores] = partirArriba(argumentos, ',');
  if (espacio.trim() !== 'in srgb') throw new Error(`color-mix sólo se entiende en srgb: ${argumentos}`);
  const lados = colores.map((c) => {
    const m = /^(.*?)(?:\s+([\d.]+%))?$/.exec(c.trim())!;
    return { color: parsearColor(m[1])!, p: porcentaje(m[2]) };
  });
  const [a, b] = lados;
  const pa = a.p ?? 1 - (b.p ?? 0.5);
  const pb = b.p ?? 1 - pa;
  const alfa = a.color.a * pa + b.color.a * pb;
  if (alfa === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const canal = (k: 'r' | 'g' | 'b') => (a.color[k] * a.color.a * pa + b.color[k] * b.color.a * pb) / alfa;
  return { r: canal('r'), g: canal('g'), b: canal('b'), a: alfa };
}

/** Un color CSS ya resuelto (sin `var()`), o null si no es un color. */
export function parsearColor(texto: string): Rgba | null {
  const t = texto.trim();
  if (t in NOMBRADOS) return NOMBRADOS[t];
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return hexa(t.slice(1));
  const funcion = /^(rgba?|color-mix)\((.*)\)$/i.exec(t);
  if (!funcion) return null;
  if (funcion[1].toLowerCase() === 'color-mix') return mezclaDeColores(funcion[2]);
  const p = funcion[2].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

/** El color con que arranca una parada de degradé (`#F0E3B8 28%`, `rgba(…) 0%`). */
function colorDeParada(parada: string): Rgba | null {
  const t = parada.trim();
  const abre = t.indexOf('(');
  const primera = abre > 0 && /^[a-z-]+$/i.test(t.slice(0, abre)) ? t.slice(0, cierre(t, abre) + 1) : t.split(/\s+/)[0];
  return parsearColor(primera);
}

/**
 * Las capas de un `background` ya resuelto, de arriba hacia abajo. Cada capa
 * es la lista de colores que puede tener debajo del texto: uno para un color
 * liso, una por parada para un degradé. Las texturas (`url(…)`) se ignoran:
 * son grano y veta con alfa de 0,03, no cambian una cifra de contraste.
 */
export function capasDeFondo(valor: string): Rgba[][] {
  return partirArriba(valor, ',').flatMap((capa) => {
    if (capa.startsWith('url(')) return [];
    const degrade = /^(?:repeating-)?(?:linear|radial)-gradient\(/i.exec(capa);
    if (!degrade) {
      const liso = parsearColor(capa);
      if (!liso) throw new Error(`capa de fondo que no se entiende: ${capa}`);
      return [[liso]];
    }
    const adentro = capa.slice(degrade[0].length, cierre(capa, degrade[0].length - 1));
    const paradas = partirArriba(adentro, ',')
      .map(colorDeParada)
      .filter((c): c is Rgba => c !== null);
    return [paradas];
  });
}

/** `arriba` pintado sobre `abajo` (source-over). */
export function mezclar(arriba: Rgba, abajo: Rgba): Rgba {
  const a = arriba.a + abajo.a * (1 - arriba.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const canal = (k: 'r' | 'g' | 'b') => (arriba[k] * arriba.a + abajo[k] * abajo.a * (1 - arriba.a)) / a;
  return { r: canal('r'), g: canal('g'), b: canal('b'), a };
}

type Matriz = [number, number, number][];

const acotar = (v: number) => Math.min(1, Math.max(0, v));

function porMatriz(c: number[], m: Matriz): number[] {
  return m.map(([a, b, d]) => acotar(a * c[0] + b * c[1] + d * c[2]));
}

/**
 * Las funciones de `filter` que usa el callejero de noche, con las matrices
 * de la especificación (Filter Effects 1, en sRGB como las aplica el
 * navegador). Hace falta para medir un trazo contra el mapa de noche: las
 * teselas son fotos de un mapa claro, y el color sobre el que se apoya el
 * trazo es el que sale del filtro, no el de la tesela.
 */
const FILTROS: Record<string, (c: number[], n: number) => number[]> = {
  invert: (c, n) => c.map((v) => acotar(n * (1 - v) + (1 - n) * v)),
  'hue-rotate': (c, grados) => {
    const t = (grados * Math.PI) / 180;
    const [cos, sen] = [Math.cos(t), Math.sin(t)];
    return porMatriz(c, [
      [0.213 + cos * 0.787 - sen * 0.213, 0.715 - cos * 0.715 - sen * 0.715, 0.072 - cos * 0.072 + sen * 0.928],
      [0.213 - cos * 0.213 + sen * 0.143, 0.715 + cos * 0.285 + sen * 0.14, 0.072 - cos * 0.072 - sen * 0.283],
      [0.213 - cos * 0.213 - sen * 0.787, 0.715 - cos * 0.715 + sen * 0.715, 0.072 + cos * 0.928 + sen * 0.072],
    ]);
  },
  sepia: (c, n) => {
    const r = 1 - n;
    return porMatriz(c, [
      [0.393 + 0.607 * r, 0.769 - 0.769 * r, 0.189 - 0.189 * r],
      [0.349 - 0.349 * r, 0.686 + 0.314 * r, 0.168 - 0.168 * r],
      [0.272 - 0.272 * r, 0.534 - 0.534 * r, 0.131 + 0.869 * r],
    ]);
  },
  saturate: (c, s) =>
    porMatriz(c, [
      [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
      [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
      [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
    ]),
  brightness: (c, n) => c.map((v) => acotar(v * n)),
  contrast: (c, n) => c.map((v) => acotar(v * n + 0.5 - 0.5 * n)),
};

/** Un color opaco pasado por un `filter` de CSS ya resuelto (`none` lo deja igual). */
export function aplicarFiltro(color: Rgba, filtro: string): Rgba {
  if (filtro.trim() === 'none') return color;
  let c = [color.r / 255, color.g / 255, color.b / 255];
  for (const [, nombre, argumento] of filtro.matchAll(/([a-z-]+)\(([^)]*)\)/g)) {
    const funcion = FILTROS[nombre];
    // Una función nueva en el token tiene que entrar acá antes que en el mapa:
    // si no, el test mediría el callejero sin ella.
    if (!funcion) throw new Error(`función de filtro que no se sabe aplicar: ${nombre}`);
    const n = Number.parseFloat(argumento);
    c = funcion(c, argumento.trim().endsWith('%') ? n / 100 : n);
  }
  return { r: c[0] * 255, g: c[1] * 255, b: c[2] * 255, a: color.a };
}

/** Luminancia relativa de WCAG 2.x (sRGB linealizado, pesos de Rec. 709). */
export function luminancia({ r, g, b }: Rgba): number {
  const lineal = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lineal(r) + 0.7152 * lineal(g) + 0.0722 * lineal(b);
}

/** Razón de contraste WCAG entre dos colores opacos: de 1 a 21. */
export function contraste(a: Rgba, b: Rgba): number {
  const [claro, oscuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (claro + 0.05) / (oscuro + 0.05);
}

/** Todas las combinaciones de colores que pueden quedar debajo del texto. */
export function fondosPosibles(capas: Rgba[][], base: Rgba): Rgba[] {
  // Se apila de abajo hacia arriba: la última capa de la lista es la de abajo.
  return [...capas].reverse().reduce<Rgba[]>(
    (debajo, capa) => debajo.flatMap((d) => capa.map((c) => mezclar(c, d))),
    [base],
  );
}

/**
 * El peor contraste de un texto contra un fondo de capas apoyado en una base
 * opaca. Un texto translúcido se mezcla con cada fondo antes de medirlo.
 */
export function peorContraste(texto: Rgba, capas: Rgba[][], base: Rgba): number {
  return Math.min(...fondosPosibles(capas, base).map((f) => contraste(mezclar(texto, f), f)));
}
