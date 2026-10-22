import { readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  capasDeFondo,
  contraste,
  fondosPosibles,
  leerTokens,
  luminancia,
  parsearColor,
  peorContraste,
  resolver,
  type Rgba,
  type Tema,
} from '../test/wcag';

/**
 * Contraste del sistema de diseño en los dos temas, medido sobre los tokens.
 *
 * El modo oscuro llegó a la consola con textos que no se leían y fondos que
 * encandilaban sin que fallara un solo test: jsdom no pinta, y cada arreglo
 * miraba el par que tenía delante. Acá están TODOS los pares texto/fondo que el
 * sistema promete, en claro y en oscuro, con el mínimo de WCAG AA: 4,5 para
 * texto chico y 3 para bordes de controles y anillos de foco. Si un token
 * cambia y rompe un par, se entera este test y no el operador de guardia.
 */

function leer(rel: string): string {
  // CRLF fuera: en un clon de Windows con `core.autocrlf` las hojas llegan así.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const tokens = leerTokens(leer('./tokens.css'));
const TEMAS: Tema[] = ['claro', 'oscuro'];

/** Un token (`--x`) o un valor CSS cualquiera, resuelto en el tema. */
function valor(tema: Tema, token: string): string {
  return resolver(tokens[tema], token.startsWith('--') ? `var(${token})` : token);
}

function color(tema: Tema, token: string): Rgba {
  const c = parsearColor(valor(tema, token));
  if (!c) throw new Error(`${token} no es un color en ${tema}: ${valor(tema, token)}`);
  return c;
}

/** Peor contraste del texto sobre las capas `sobre` (de arriba hacia abajo) y la base. */
function medir(tema: Tema, texto: string, sobre: string[], base: string): number {
  const capas = sobre.flatMap((s) => capasDeFondo(valor(tema, s)));
  return peorContraste(color(tema, texto), capas, color(tema, base));
}

interface Par {
  /** Dónde se ve el par en la consola. */
  donde: string;
  texto: string;
  sobre?: string[];
  base: string;
  minimo: number;
}

const TEXTO = 4.5;
const CONTROL = 3;

// Las superficies donde se apoya texto: la página, las tarjetas (la cara de la
// piedra termina en mármol 1), los campos y los huecos.
const SUPERFICIES: { nombre: string; sobre: string[]; base: string }[] = [
  { nombre: 'mármol 0', sobre: [], base: '--marmol-0' },
  { nombre: 'mármol 1', sobre: [], base: '--marmol-1' },
  { nombre: 'mármol 2 (hueco, campo)', sobre: [], base: '--marmol-2' },
  { nombre: 'cara de la tarjeta', sobre: ['--piedra-cara'], base: '--marmol-0' },
];

const pares: Par[] = [];
const sobreSuperficies = (donde: string, texto: string, sobre: string[] = [], minimo = TEXTO) => {
  for (const s of SUPERFICIES) {
    pares.push({ donde: `${donde} sobre ${s.nombre}`, texto, sobre: [...sobre, ...s.sobre], base: s.base, minimo });
  }
};

// --- Texto de lectura --------------------------------------------------------
sobreSuperficies('texto principal', '--tinta');
sobreSuperficies('texto secundario (.muted, rótulos)', '--tinta-media');
// La franja de piedra pulida (el pie de la página, el video sin señal).
pares.push({ donde: 'texto secundario sobre mármol 3', texto: '--tinta-media', base: '--marmol-3', minimo: TEXTO });

// --- Estados y oro como texto: .ok, .bad, .warn, .accent, enlaces -----------
sobreSuperficies('estado ok (.ok, "conectado", "En vuelo")', '--ok-texto');
sobreSuperficies('peligro (.bad, errores)', '--peligro');
sobreSuperficies('alerta (.warn)', '--alerta-texto');
sobreSuperficies('información (.info)', '--info');
sobreSuperficies('oro como texto (.accent, .enlace, a)', '--oro-texto');

// --- Pastillas: el velo de su color sobre la superficie ------------------------
sobreSuperficies('.badge.ok y .cat-sistema', '--ok-texto', ['--ok-velo']);
sobreSuperficies('.badge.person y .aviso.malo', '--peligro', ['--peligro-velo']);
sobreSuperficies('.badge.vehicle', '--alerta-texto', ['--alerta-velo']);
sobreSuperficies('.badge.info y .cat-drone', '--info', ['--info-velo']);
sobreSuperficies('.badge.oro ("Control manual") y .cat-usuarios', '--oro-texto', ['--oro-velo']);
pares.push({ donde: '.badge común', texto: '--tinta-media', base: '--marmol-2', minimo: TEXTO });
pares.push({ donde: '.badge-count (cifra sobre óxido)', texto: '--marmol-0', base: '--peligro', minimo: TEXTO });

// --- Botones, en reposo y con el mouse encima ------------------------------------
// Todos los botones apoyan su cara sobre mármol 1 (su background-color).
pares.push(
  { donde: 'botón común', texto: '--tinta', sobre: ['--cara-boton'], base: '--marmol-1', minimo: TEXTO },
  { donde: 'botón común :hover', texto: '--tinta', sobre: ['--cara-boton-hover'], base: '--marmol-1', minimo: TEXTO },
  {
    donde: 'botón dorado (.primario, submit)',
    texto: '--tinta-sobre-oro',
    sobre: ['--oro-lamina-relleno'],
    base: '--oro',
    minimo: TEXTO,
  },
  {
    donde: 'botón dorado :hover',
    texto: '--tinta-sobre-oro',
    sobre: ['--realce-55', '--oro-lamina-relleno'],
    base: '--oro',
    minimo: TEXTO,
  },
  {
    donde: '.validate / .resume ("Validar", "Devolver al patrullaje")',
    texto: '--ok-texto',
    sobre: ['--cara-afirmativa'],
    base: '--marmol-1',
    minimo: TEXTO,
  },
  {
    donde: '.validate / .resume :hover',
    texto: '--ok-texto',
    sobre: ['--ok-velo', '--cara-boton-hover'],
    base: '--marmol-1',
    minimo: TEXTO,
  },
  {
    // El óxido tiñe la cara de reposo, no la de hover (ver primitivos.css).
    donde: '.dismiss :hover ("Eliminar")',
    texto: '--peligro',
    sobre: ['--peligro-velo', '--cara-boton'],
    base: '--marmol-1',
    minimo: TEXTO,
  },
  {
    donde: 'activo: pestaña del menú, chip, aria-pressed',
    texto: '--tinta',
    sobre: ['--cara-activa'],
    base: '--marmol-0',
    minimo: TEXTO,
  },
  {
    donde: 'ícono abierto (el "?" de la ayuda de pilotaje)',
    texto: '--oro-texto',
    sobre: ['--cara-activa'],
    base: '--marmol-1',
    minimo: TEXTO,
  },
  {
    donde: 'texto seleccionado (::selection)',
    texto: '--tinta-sobre-oro',
    base: '--oro-claro',
    minimo: TEXTO,
  },
);
// Pestañas del registro: el velo de oro sube desde el pie sobre la tarjeta.
sobreSuperficies('pestaña activa del registro', '--tinta', ['--oro-velo']);

// --- Deshabilitados: apagados pero legibles ----------------------------------------
// En su hueco (mármol 2) alcanza con 3:1: WCAG exime lo deshabilitado, pero
// la consola promete poder leerlo. Donde la tinta apagada es texto que se lee
// —el placeholder sobre un campo, una fila eliminada en una tabla— va a AA.
pares.push(
  { donde: 'botón deshabilitado', texto: '--tinta-suave', base: '--marmol-2', minimo: CONTROL },
  { donde: 'placeholder de un campo', texto: '--tinta-suave', base: '--marmol-0', minimo: TEXTO },
  { donde: 'fila eliminada sobre la tarjeta', texto: '--tinta-suave', sobre: ['--piedra-cara'], base: '--marmol-0', minimo: TEXTO },
);

// --- Bordes de los controles y foco ----------------------------------------------
for (const s of SUPERFICIES) {
  pares.push({ donde: `anillo de foco sobre ${s.nombre}`, texto: '--anillo-foco', sobre: s.sobre, base: s.base, minimo: CONTROL });
}
pares.push({ donde: 'borde de un campo', texto: '--filo-campo', base: '--marmol-0', minimo: CONTROL });

// --- HUD de pilotaje: piedra translúcida sobre una imagen cualquiera ---------------
// El video puede ser cielo blanco o noche cerrada: se mide contra los dos.
for (const imagen of ['#FFFFFF', '#000000']) {
  const cuadro = imagen === '#FFFFFF' ? 'cuadro blanco' : 'cuadro negro';
  pares.push(
    { donde: `HUD: lectura sobre ${cuadro}`, texto: '--tinta', sobre: ['--hud-panel'], base: imagen, minimo: TEXTO },
    { donde: `HUD: rótulo sobre ${cuadro}`, texto: '--tinta-media', sobre: ['--hud-panel'], base: imagen, minimo: TEXTO },
    {
      donde: `HUD: aviso grave sobre ${cuadro}`,
      texto: '--peligro',
      sobre: ['--peligro-velo', '--hud-panel'],
      base: imagen,
      minimo: TEXTO,
    },
  );
}

const casos = TEMAS.flatMap((tema) => pares.map((p) => ({ tema, ...p })));

describe('la fórmula de WCAG que usa este test', () => {
  it('da 21 entre blanco y negro y 1 entre un color y sí mismo', () => {
    const blanco = parsearColor('#FFFFFF')!;
    const negro = parsearColor('#000')!;
    expect(contraste(blanco, negro)).toBeCloseTo(21, 5);
    expect(contraste(negro, blanco)).toBeCloseTo(21, 5);
    expect(contraste(blanco, blanco)).toBe(1);
  });

  it('coincide con valores publicados', () => {
    // #767676 sobre blanco es el gris más claro que llega a 4,5:1.
    expect(contraste(parsearColor('#767676')!, parsearColor('white')!)).toBeCloseTo(4.54, 2);
    expect(luminancia(parsearColor('rgb(255, 0, 0)')!)).toBeCloseTo(0.2126, 4);
  });

  it('mezcla las capas translúcidas antes de medir', () => {
    // Medio negro sobre blanco es el gris del medio.
    const capas = capasDeFondo('linear-gradient(rgba(0, 0, 0, .5), rgba(0, 0, 0, .5))');
    const gris = peorContraste(parsearColor('#000')!, capas, parsearColor('#FFF')!);
    expect(gris).toBeCloseTo(contraste(parsearColor('#000')!, parsearColor('rgb(127.5, 127.5, 127.5)')!), 5);
    // Y de un degradé manda la parada que peor contrasta.
    const degrade = capasDeFondo('linear-gradient(180deg, #FFFFFF 0%, #000000 100%)');
    expect(peorContraste(parsearColor('#FFF')!, degrade, parsearColor('#000')!)).toBe(1);
  });

  it('entiende color-mix con transparente como un alfa', () => {
    expect(parsearColor('color-mix(in srgb, #FF0000 40%, transparent)')).toEqual({ r: 255, g: 0, b: 0, a: 0.4 });
  });

  it('lee los dos temas y el oscuro hereda lo que no redefine', () => {
    expect(tokens.claro.get('--tinta')).not.toBe(tokens.oscuro.get('--tinta'));
    expect(tokens.oscuro.get('--radio')).toBe(tokens.claro.get('--radio'));
  });
});

describe('contraste WCAG AA de los pares del tema', () => {
  it.each(casos)('$tema · $donde', ({ tema, texto, sobre, base, minimo }) => {
    const razon = medir(tema, texto, sobre ?? [], base);
    expect(razon, `${texto} da ${razon.toFixed(2)}:1, pide ${minimo}:1`).toBeGreaterThanOrEqual(minimo);
  });

  it.each(TEMAS)('%s · lo deshabilitado se ve apagado: contrasta menos que el texto secundario', (tema) => {
    expect(medir(tema, '--tinta-suave', [], '--marmol-2')).toBeLessThan(medir(tema, '--tinta-media', [], '--marmol-2'));
  });
});

describe('ninguna superficie grande encandila en obsidiana', () => {
  // Lo que en claro es un blanco de realce, en oscuro tiene que ser piedra: un
  // blanco escrito a mano en un degradé es el típico token "a medio cambiar".
  // Luminancia 0,05 es más o menos un gris #3F3F3F: por encima, una tecla o un
  // panel ya se lee como una mancha clara sobre la obsidiana.
  const CARAS = ['--cara-boton', '--cara-boton-hover', '--cara-afirmativa', '--cara-activa', '--piedra-cara', '--hud-panel'];
  it.each(CARAS)('%s queda oscura en el tema oscuro', (cara) => {
    const capas = capasDeFondo(valor('oscuro', cara));
    for (const fondo of fondosPosibles(capas, color('oscuro', '--marmol-1'))) {
      expect(luminancia(fondo), `${cara} tiene una parada clara`).toBeLessThan(0.05);
    }
  });
});

describe('los colores salen de tokens.css', () => {
  // Las máscaras de los filos dorados también van por token: un `#000` suelto
  // en una hoja es indistinguible de un negro escrito a mano.
  // `dirname` y no `new URL('.', import.meta.url)`: Vite reescribe ese patrón
  // con un literal como si fuera un asset, y la ruta deja de ser un archivo.
  const hojas = readdirSync(dirname(fileURLToPath(import.meta.url))).filter(
    (f) => f.endsWith('.css') && f !== 'tokens.css',
  );

  it('hay hojas que revisar', () => {
    expect(hojas.length).toBeGreaterThanOrEqual(10);
  });

  it.each(hojas)('%s no escribe colores literales', (hoja) => {
    const reglas = leer(`./${hoja}`).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(reglas).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(reglas).not.toMatch(/\b(rgba?|hsla?)\(/i);
    expect(reglas).not.toMatch(/(?<![-\w])(white|black)(?![-\w])/i);
  });
});
