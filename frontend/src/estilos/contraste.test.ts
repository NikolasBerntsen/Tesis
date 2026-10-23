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
import { valorDe } from '../test/hojas';

/**
 * Contraste del sistema de diseño en los dos temas, medido sobre los tokens.
 *
 * El modo oscuro llegó a la consola con textos que no se leían y fondos que
 * encandilaban sin que fallara un solo test: jsdom no pinta, y cada arreglo
 * miraba el par que tenía delante. Acá están TODOS los pares texto/fondo que el
 * sistema promete, en claro y en oscuro, con el mínimo de WCAG AA: 4,5 para
 * texto chico y 3 para texto grande, bordes de controles y anillos de foco. Si
 * un token cambia y rompe un par, se entera este test y no el operador de
 * guardia. Los paneles son translúcidos: se miden sobre los extremos reales
 * de la textura de vetas que tienen detrás.
 */

function leer(rel: string): string {
  // CRLF fuera: en un clon de Windows con `core.autocrlf` las hojas llegan así.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const tokens = leerTokens(leer('./tokens.css'));
const TEMAS: Tema[] = ['claro', 'oscuro'];

/**
 * Los extremos de la piedra con vetas de cada tema: el píxel más claro y el
 * más oscuro de la textura, leídos del WebP ya comprimido. Los anota
 * scripts/generar-vetas.py cada vez que genera las texturas, así que
 * regenerarlas actualiza solo lo que se mide acá.
 */
const VETAS = JSON.parse(leer('../test/vetas.json')) as Record<Tema, { clara: string; oscura: string }>;

/** Una base opaca: un token, un color, o uno distinto por tema (las vetas). */
type Base = string | ((tema: Tema) => string);
const vetaClara: Base = (tema) => VETAS[tema].clara;
const vetaOscura: Base = (tema) => VETAS[tema].oscura;

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
function medir(tema: Tema, texto: string, sobre: string[], base: Base): number {
  const capas = sobre.flatMap((s) => capasDeFondo(valor(tema, s)));
  return peorContraste(color(tema, texto), capas, color(tema, typeof base === 'function' ? base(tema) : base));
}

interface Par {
  /** Dónde se ve el par en la consola. */
  donde: string;
  texto: string;
  sobre?: string[];
  base: Base;
  minimo: number;
}

const TEXTO = 4.5;
/** Texto grande: la marca, de 21 px en negrita para arriba. */
const TEXTO_GRANDE = 3;
/** Bordes de controles y anillos de foco. */
const CONTROL = 3;

interface Superficie {
  nombre: string;
  sobre: string[];
  base: Base;
}

// Las superficies opacas: los campos, la piedra lisa y los huecos.
const OPACAS: Superficie[] = [
  { nombre: 'mármol 0 (campos)', sobre: [], base: '--marmol-0' },
  { nombre: 'mármol 1', sobre: [], base: '--marmol-1' },
  { nombre: 'mármol 2 (hueco, campo)', sobre: [], base: '--marmol-2' },
];
// Los paneles (tarjetas, tejas, la placa de ingreso, la barra) son
// translúcidos: lo que queda debajo del texto depende de qué parte de la
// piedra pase por detrás. Se miden sobre los dos extremos de la textura: de
// día manda la veta más oscura (apaga la tinta), de noche la grieta de oro más
// brillante (aclara el panel debajo del marfil).
const PANELES: Superficie[] = [
  { nombre: 'panel sobre la veta más clara', sobre: ['--piedra-cara', '--panel'], base: vetaClara },
  { nombre: 'panel sobre la piedra más oscura', sobre: ['--piedra-cara', '--panel'], base: vetaOscura },
];
// El lienzo de cada vista: más liviano que un panel, y encima va el título.
const LIENZOS: Superficie[] = [
  { nombre: 'lienzo sobre la veta más clara', sobre: ['--lienzo'], base: vetaClara },
  { nombre: 'lienzo sobre la piedra más oscura', sobre: ['--lienzo'], base: vetaOscura },
];
// Lo que flota (diálogos, el desplegable de la campana, los avisos): atrás
// puede haber un video o un mapa, así que se mide sobre blanco y sobre negro,
// como el HUD.
const FIRMES: Superficie[] = [
  { nombre: 'panel firme sobre blanco', sobre: ['--piedra-cara', '--panel-firme'], base: '#FFFFFF' },
  { nombre: 'panel firme sobre negro', sobre: ['--piedra-cara', '--panel-firme'], base: '#000000' },
];
const SUPERFICIES: Superficie[] = [...OPACAS, ...PANELES, ...LIENZOS, ...FIRMES];

const pares: Par[] = [];
const sobreSuperficies = (donde: string, texto: string, sobre: string[] = [], minimo = TEXTO, superficies = SUPERFICIES) => {
  for (const s of superficies) {
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
sobreSuperficies('peligro (.bad, errores, "sin conexión")', '--peligro');
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
pares.push({ donde: '.badge-count (la cuenta de la campana, sobre óxido)', texto: '--marmol-0', base: '--peligro', minimo: TEXTO });

// --- Botones, en reposo y con el mouse encima ------------------------------------
// El botón es translúcido: su cara y su fondo se apoyan en la superficie que
// tenga atrás, así que se mide sobre todas.
sobreSuperficies('botón común (y .dismiss en reposo)', '--tinta', ['--cara-boton', '--boton-fondo']);
sobreSuperficies('botón común :hover', '--tinta', ['--cara-boton-hover', '--boton-fondo']);
sobreSuperficies(
  'botón dorado (.primario, submit), lo presionado (.active, aria-pressed) y el ícono abierto',
  '--oro-texto',
  ['--cara-activa', '--boton-fondo'],
);
sobreSuperficies('botón dorado :hover', '--oro-texto', ['--oro-velo', '--cara-activa', '--boton-fondo']);
sobreSuperficies('.validate / .resume ("Validar", "Devolver al patrullaje")', '--valida-texto', ['--valida-fondo']);
sobreSuperficies('.dismiss :hover y en una decisión ("Descartar", "Eliminar")', '--descarta-texto', ['--descarta-fondo']);
// La sección abierta de la barra: el velo dorado, sin el fondo del botón.
sobreSuperficies('sección abierta de la barra', '--oro-texto', ['--cara-activa'], TEXTO, PANELES);
pares.push({ donde: 'texto seleccionado (::selection)', texto: '--tinta-sobre-oro', base: '--oro-claro', minimo: TEXTO });
// Pestañas del registro: el velo de oro sube desde el pie sobre la tarjeta.
sobreSuperficies('pestaña activa del registro', '--tinta', ['--oro-velo']);

// --- Deshabilitados: apagados pero legibles ----------------------------------------
// En su hueco (mármol 2) alcanza con 3:1: WCAG exime lo deshabilitado, pero
// la consola promete poder leerlo. Donde la tinta apagada es texto que se lee
// —el placeholder sobre un campo, una fila eliminada en una tabla— va a AA.
pares.push(
  { donde: 'botón deshabilitado', texto: '--tinta-suave', base: '--marmol-2', minimo: CONTROL },
  { donde: 'placeholder de un campo', texto: '--tinta-suave', base: '--marmol-0', minimo: TEXTO },
);
// Las tablas viven en paneles, y el "Cancelar" de un diálogo ocupado, en el
// panel firme: el fantasma no tiene hueco, apoya en lo que tenga atrás.
sobreSuperficies('fila eliminada', '--tinta-suave', [], TEXTO, [...PANELES, ...FIRMES]);
sobreSuperficies('botón fantasma deshabilitado', '--tinta-suave', [], CONTROL, [...PANELES, ...FIRMES]);
// Bajo el mouse o elegida (Rutas con «Ver eliminadas»), el realce o el velo
// de la selección le aclaran el fondo a la fila eliminada, y su tinta sube a
// la media (primitivos.css): la apagada ahí quedaba en 3,7.
sobreSuperficies('fila eliminada elegida', '--tinta-media', ['--oro-velo']);
sobreSuperficies('fila eliminada bajo el mouse', '--tinta-media', ['--realce-70']);

// --- El Registro: filas que se abren con un clic ------------------------------------
// Bajo el mouse la fila toma su velo de oro, y encima quedan las pastillas de
// categoría, en texto chico sobre su propio velo. Las filas viven en la
// tarjeta del Registro (un panel) y en el historial de un dron, que es un
// pop-up (el panel firme): se miden sobre los dos.
const PASTILLAS_DEL_REGISTRO: [string, string, string][] = [
  ['.cat-drone', '--info', '--info-velo'],
  ['.cat-sistema', '--ok-texto', '--ok-velo'],
  ['.cat-usuarios', '--oro-texto', '--oro-velo'],
];
const EN_LA_TARJETA = [...PANELES, ...FIRMES];
const filaDelRegistro = (donde: string, texto: string, velo: string[]) => {
  for (const s of EN_LA_TARJETA) {
    pares.push({
      donde: `${donde} en una fila del Registro bajo el mouse, sobre ${s.nombre}`,
      texto,
      sobre: [...velo, '--oro-velo-fila', ...s.sobre],
      base: s.base,
      minimo: TEXTO,
    });
  }
};
for (const [pastilla, texto, velo] of PASTILLAS_DEL_REGISTRO) filaDelRegistro(pastilla, texto, [velo]);
filaDelRegistro('hora y tipo de evento', '--tinta-media', []);
// El historial de un dron resalta los tipos graves y los avisos, y su fila
// abierta lleva el mismo velo que la del Registro bajo el mouse.
filaDelRegistro('tipo de evento grave (.event-type.bad)', '--peligro', []);
filaDelRegistro('tipo de evento de aviso (.event-type.warn)', '--alerta-texto', []);
filaDelRegistro('mensaje del evento', '--tinta', []);

// --- La marca de la barra -------------------------------------------------------------
// Va suelta sobre la piedra, sin panel: la protege su halo (--velo-marca), que
// se mide sobre los dos extremos de la textura. El nombre es texto grande; el
// lema, chico.
const PIEDRAS: [Base, string][] = [
  [vetaClara, 'la veta más clara'],
  [vetaOscura, 'la piedra más oscura'],
];
for (const [base, piedra] of PIEDRAS) {
  const sobre = ['--velo-marca'];
  pares.push(
    { donde: `marca: "Alta" sobre ${piedra}`, texto: '--tinta', sobre, base, minimo: TEXTO_GRANDE },
    { donde: `marca: "en el" sobre ${piedra}`, texto: '--marca-azul', sobre, base, minimo: TEXTO_GRANDE },
    { donde: `marca: "Cielo" sobre ${piedra}`, texto: '--oro-texto', sobre, base, minimo: TEXTO_GRANDE },
    { donde: `marca: "Comando de drones" sobre ${piedra}`, texto: '--tinta-media', sobre, base, minimo: TEXTO },
  );
}

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
  // El título lo recorta vitest: el mensaje lleva el par entero.
  it.each(casos)('$tema · $donde', ({ tema, donde, texto, sobre, base, minimo }) => {
    const razon = medir(tema, texto, sobre ?? [], base);
    expect(razon, `${donde}: ${texto} da ${razon.toFixed(2)}:1, pide ${minimo}:1`).toBeGreaterThanOrEqual(minimo);
  });

  it.each(TEMAS)('%s · lo deshabilitado se ve apagado: contrasta menos que el texto secundario', (tema) => {
    expect(medir(tema, '--tinta-suave', [], '--marmol-2')).toBeLessThan(medir(tema, '--tinta-media', [], '--marmol-2'));
  });
});

describe('los pares medidos son los que pintan las hojas', () => {
  // Medir un par no sirve si la hoja pinta otra cosa: el velo de la fila del
  // Registro era el de lo seleccionado, y el par que lo medía no existía.
  const primitivos = leer('./primitivos.css');
  const modales = leer('./modales.css');
  const vistas = leer('./vistas.css');
  const layout = leer('./layout.css');
  const nuevos = leer('./nuevos.css');
  const pulido = leer('./pulido.css');

  it.each([
    ['fila elegida', primitivos, '.tabla tbody tr.seleccionada', 'background', 'var(--oro-velo)'],
    ['fila bajo el mouse', primitivos, '.tabla tbody tr:hover', 'background', 'var(--realce-70)'],
    ['fila de gestión bajo el mouse', modales, '.tabla-gestion tbody tr:hover', 'background', 'var(--realce-70)'],
    ['fila de gestión con el foco adentro', modales, '.tabla-gestion tbody tr:focus-within', 'background', 'var(--realce-70)'],
    ['fila eliminada en reposo', primitivos, '.tabla tbody tr.fila-eliminada td', 'color', 'var(--tinta-suave)'],
    [
      'fila eliminada bajo el mouse, con el foco o elegida',
      primitivos,
      '.tabla tbody tr.fila-eliminada:is(:hover, :focus-within, .seleccionada) td',
      'color',
      'var(--tinta-media)',
    ],
    ['fila del Registro bajo el mouse', vistas, '.log-row.cliqueable:hover', 'background', 'var(--oro-velo-fila)'],
    ['fila abierta del historial de un dron', vistas, ".log-row-boton[aria-current='true']", 'background', 'var(--oro-velo-fila)'],
    // Las superficies: lo que se mide como panel, panel firme y lienzo.
    ['tarjeta', primitivos, '.card', 'background-color', 'var(--panel)'],
    ['cara de la tarjeta', primitivos, '.card', 'background-image', 'var(--piedra-cara)'],
    ['teja de cámara', vistas, '.camera-tile', 'background-color', 'var(--panel)'],
    ['placa de ingreso', layout, '.login-card', 'background-color', 'var(--panel)'],
    ['barra de secciones', layout, '.topbar::before', 'background-color', 'var(--panel)'],
    ['lienzo de la vista', layout, '.page-main', 'background-color', 'var(--lienzo)'],
    ['diálogo', nuevos, '.modal-caja', 'background-color', 'var(--panel-firme)'],
    ['desplegable de la campana', nuevos, '.campana-panel', 'background-color', 'var(--panel-firme)'],
    ['aviso flotante', pulido, '.aviso-flotante', 'background-color', 'var(--panel-firme)'],
    ['halo de la marca', layout, '.marca', 'background-color', 'var(--velo-marca)'],
    // Los botones: la cara y la tinta que se miden arriba.
    ['botón común', primitivos, 'button', 'background-color', 'var(--boton-fondo)'],
    ['cara del botón común', primitivos, 'button', 'background-image', 'var(--cara-boton)'],
    ['botón dorado', primitivos, 'button.primario', 'background-image', 'var(--cara-activa)'],
    ['tinta del botón dorado', primitivos, 'button.primario', 'color', 'var(--oro-texto)'],
    ['botón presionado', primitivos, "button[aria-pressed='true']", 'color', 'var(--oro-texto)'],
    ['Validar', primitivos, 'button.validate', 'background-color', 'var(--valida-fondo)'],
    ['tinta de Validar', primitivos, 'button.validate', 'color', 'var(--valida-texto)'],
    ['Descartar en una decisión', primitivos, '.alert-actions button.dismiss', 'background-color', 'var(--descarta-fondo)'],
    ['tinta de Descartar', primitivos, '.alert-actions button.dismiss', 'color', 'var(--descarta-texto)'],
    ['sección abierta de la barra', layout, '.topnav button.active', 'color', 'var(--oro-texto)'],
  ])('%s', (_donde, hoja, selector, propiedad, esperado) => {
    expect(valorDe(hoja, selector, propiedad)).toBe(esperado);
  });

  it('las filas del Registro se miden sobre el panel y el pop-up, sobre los dos extremos de cada uno', () => {
    // Si una lista de superficies cambia, las filas se medirían sobre menos
    // fondos sin que nada avise.
    expect(EN_LA_TARJETA).toHaveLength(4);
  });

  it('la textura de vetas que se mide es la que pinta la página', () => {
    // Los extremos de vetas.json salen de estos dos archivos (generar-vetas.py).
    expect(tokens.claro.get('--fondo-vetas')).toContain('vetas-dia.webp');
    expect(tokens.oscuro.get('--fondo-vetas')).toContain('vetas-noche.webp');
    expect(valorDe(leer('./base.css'), 'body::before', 'background')).toContain('var(--fondo-vetas)');
    for (const tema of TEMAS) {
      expect(parsearColor(VETAS[tema].clara), tema).not.toBeNull();
      expect(parsearColor(VETAS[tema].oscura), tema).not.toBeNull();
    }
  });

  it.each(PASTILLAS_DEL_REGISTRO)('%s: la pastilla del Registro es %s sobre %s', (pastilla, texto, velo) => {
    expect(valorDe(primitivos, pastilla, 'color')).toBe(`var(${texto})`);
    expect(valorDe(primitivos, pastilla, 'background')).toBe(`var(${velo})`);
  });
});

describe('ninguna superficie grande encandila en obsidiana', () => {
  // Lo que en claro es un blanco de realce, en oscuro tiene que ser piedra: un
  // blanco escrito a mano en un degradé es el típico token "a medio cambiar".
  // Luminancia 0,05 es más o menos un gris #3F3F3F: por encima, una tecla o un
  // panel ya se lee como una mancha clara sobre la obsidiana.
  const CARAS = [
    '--cara-boton',
    '--cara-boton-hover',
    '--boton-fondo',
    '--cara-activa',
    '--valida-fondo',
    '--descarta-fondo',
    '--piedra-cara',
    '--panel',
    '--panel-firme',
    '--lienzo',
    '--hud-panel',
  ];
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
