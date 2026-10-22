import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLASE_TESELAS_CALLES, CLASE_TESELAS_SATELITE, OPACIDAD_TRAZO, TRAZO } from '../mapa';
import {
  aplicarFiltro,
  contraste,
  leerTokens,
  luminancia,
  mezclar,
  parsearColor,
  resolver,
  type Rgba,
} from '../test/wcag';

/**
 * El mapa de noche. jsdom no aplica filtros ni pinta SVG, así que lo que se
 * fija acá es el contrato entre las dos mitades: las clases que mapa.ts les
 * pone a las capas y a los trazos, y las reglas de vistas.css que las tiñen
 * con tokens del tema. Si alguien renombra una clase de un lado, el mapa
 * vuelve a encandilar en obsidiana sin que nada más falle.
 */
function leer(rel: string): string {
  // CRLF fuera: en un clon de Windows con `core.autocrlf` las hojas llegan así.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const vistas = leer('./vistas.css').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = leerTokens(leer('./tokens.css'));
const enTema = (tema: 'claro' | 'oscuro', token: string) => resolver(tokens[tema], `var(${token})`);

/**
 * El valor de `propiedad` en la última regla de `selector` que la declara
 * (la que gana en la cascada a igual especificidad).
 */
function declaracion(selector: string, propiedad: string): string | null {
  const escapado = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reglas = vistas.matchAll(new RegExp(`(?:^|[\\s,}])${escapado}\\s*\\{([^}]*)\\}`, 'g'));
  let valor: string | null = null;
  for (const regla of reglas) {
    const m = new RegExp(`(?:^|;)\\s*${propiedad}:\\s*([^;]+)`).exec(regla[1]);
    if (m) valor = m[1].trim();
  }
  return valor;
}

describe('teselas de noche', () => {
  it('la capa de calles se filtra con el token del tema', () => {
    expect(declaracion(`.leaflet-layer.${CLASE_TESELAS_CALLES}`, 'filter')).toBe('var(--filtro-calles)');
  });

  it('en mármol el callejero va con sus colores; en obsidiana se da vuelta y se oscurece', () => {
    expect(enTema('claro', '--filtro-calles')).toBe('none');
    const noche = enTema('oscuro', '--filtro-calles');
    expect(noche).toMatch(/invert\(1\)/);
    // El giro devuelve cada tono a su familia: sin él el agua sale naranja.
    expect(noche).toMatch(/hue-rotate\(180deg\)/);
    expect(noche).toMatch(/brightness\(0?\.\d+\)/);
  });

  it('el satélite no lleva filtro: es una foto', () => {
    expect(vistas).not.toContain(CLASE_TESELAS_SATELITE);
    // Ni el pane entero, que se lo arrastraría junto con las calles.
    expect(vistas).not.toMatch(/\.leaflet-tile-pane\s*\{[^}]*filter/);
  });

  it('los marcadores y los globos no heredan el filtro: va en la capa, no en el contenedor', () => {
    expect(vistas).not.toMatch(/\.leaflet-container\s*\{[^}]*filter/);
    expect(vistas).not.toMatch(/\.map\s*\{[^}]*filter/);
  });
});

describe('la cuenta del filtro que se usa para medir', () => {
  const blanco = parsearColor('#FFFFFF')!;
  it('none deja el color como está', () => {
    expect(aplicarFiltro(blanco, 'none')).toEqual(blanco);
  });

  it('cada función hace lo que dice la especificación', () => {
    expect(aplicarFiltro(blanco, 'invert(1)')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(aplicarFiltro(blanco, 'brightness(.5)').r).toBeCloseTo(127.5, 5);
    expect(aplicarFiltro(blanco, 'brightness(50%)').r).toBeCloseTo(127.5, 5);
    // El contraste acerca al gris del medio; el giro y la saturación no le
    // cambian nada a un gris.
    expect(aplicarFiltro(blanco, 'contrast(.5)').g).toBeCloseTo(191.25, 5);
    const gris = parsearColor('#808080')!;
    for (const f of ['hue-rotate(180deg)', 'saturate(.3)']) {
      const g = aplicarFiltro(gris, f);
      expect(g.r, f).toBeCloseTo(128, 0);
      expect(g.b, f).toBeCloseTo(128, 0);
    }
    // El sepia entero lleva el blanco al papel viejo: el rojo arriba, el azul abajo.
    const sepia = aplicarFiltro(blanco, 'sepia(1)');
    expect(sepia.r).toBeGreaterThan(sepia.b);
  });

  it('una función que no sabe aplicar no se saltea en silencio', () => {
    expect(() => aplicarFiltro(blanco, 'blur(2px)')).toThrow(/blur/);
  });

  it('de noche la tierra del callejero queda oscura como la piedra: no encandila', () => {
    const tierra = aplicarFiltro(parsearColor('#F2EFE9')!, enTema('oscuro', '--filtro-calles'));
    expect(luminancia(tierra)).toBeLessThan(0.05);
  });
});

describe('trazos sobre el mapa', () => {
  // Cada trazo: el token que lo tiñe y las opacidades con que Leaflet lo
  // dibuja. Lo que se ve es la mezcla de los dos sobre el mapa, así que eso es
  // lo que se mide. El objetivo usa su clase en el hilo y en el rastro. Lo
  // que se dibuja apagado a propósito (el objetivo perdido) queda afuera: que
  // se lea menos es justamente lo que dice.
  const DIBUJO: Record<keyof typeof TRAZO, { token: string; opacidades: number[] }> = {
    hilo: { token: '--mapa-hilo', opacidades: [OPACIDAD_TRAZO.hilo] },
    recorrido: { token: '--mapa-recorrido', opacidades: [1] },
    nodo: { token: '--mapa-filo-nodo', opacidades: [1] },
    objetivoPendiente: {
      token: '--mapa-objetivo-pendiente',
      opacidades: [OPACIDAD_TRAZO.hiloObjetivo, OPACIDAD_TRAZO.rastroObjetivo],
    },
    objetivoValidado: {
      token: '--mapa-objetivo-validado',
      opacidades: [OPACIDAD_TRAZO.hiloObjetivo, OPACIDAD_TRAZO.rastroObjetivo],
    },
  };

  it.each(Object.entries(TRAZO) as [keyof typeof TRAZO, string][])('%s: .%s se tiñe con su token', (rol, clase) => {
    expect(declaracion(`.${clase}`, 'stroke')).toBe(`var(${DIBUJO[rol].token})`);
  });

  // Contra qué se miden: la tierra y los edificios de OpenStreetMap tal como
  // quedan después del filtro del tema (en mármol no hay filtro), y la piedra
  // hundida, que es el fondo del mapa mientras cargan las teselas. Los
  // edificios son el peor caso de día; de noche, al darse vuelta, también.
  const OSM = { tierra: '#F2EFE9', edificios: '#D9D0C9' };
  function fondosDelMapa(tema: 'claro' | 'oscuro'): [string, Rgba][] {
    const filtro = enTema(tema, '--filtro-calles');
    return [
      ...Object.entries(OSM).map(([nombre, hex]) => [nombre, aplicarFiltro(parsearColor(hex)!, filtro)] as [string, Rgba]),
      ['piedra hundida', parsearColor(enTema(tema, '--marmol-2'))!],
    ];
  }

  const casos = (Object.keys(DIBUJO) as (keyof typeof TRAZO)[]).flatMap((rol) =>
    (['claro', 'oscuro'] as const).map((tema) => ({ rol, tema })),
  );
  it.each(casos)('$rol se distingue del mapa en $tema, con la opacidad con que se dibuja (3:1)', ({ rol, tema }) => {
    const { token, opacidades } = DIBUJO[rol];
    const trazo = parsearColor(enTema(tema, token))!;
    for (const opacidad of opacidades) {
      for (const [nombre, fondo] of fondosDelMapa(tema)) {
        const razon = contraste(mezclar({ ...trazo, a: trazo.a * opacidad }, fondo), fondo);
        expect(razon, `${token} al ${opacidad} sobre ${nombre} da ${razon.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('la paleta que DronesMap le pasa a Leaflet', () => {
  // Leaflet recibe los colores por JS, así que DronesMap los repite. Cada uno
  // que dice copiar un token tiene que valer lo que ese token vale en mármol:
  // el óxido y el azul se habían quedado en los de antes del ajuste del tema.
  const fuente = leer('../components/DronesMap.tsx');
  const paleta = /const PALETA = \{([\s\S]*?)\n\} as const;/.exec(fuente)?.[1] ?? '';
  const copias = [...paleta.matchAll(/'(#[0-9a-f]{6})',\s*\/\/\s*(--[\w-]+)/gi)].map(([, hex, token]) => ({ hex, token }));

  it('hay copias que revisar', () => {
    expect(copias.length).toBeGreaterThanOrEqual(5);
  });

  it.each(copias)('$token: $hex', ({ hex, token }) => {
    expect(hex.toUpperCase()).toBe(enTema('claro', token).toUpperCase());
  });
});

describe('el mobiliario de Leaflet sigue al tema', () => {
  it.each([
    ['.leaflet-container', 'background', 'var(--marmol-2)'],
    ['.leaflet-container a', 'color', 'var(--oro-texto)'],
    ['.leaflet-tooltip', 'background-color', 'var(--marmol-0)'],
    ['.leaflet-tooltip', 'color', 'var(--tinta)'],
    // El +/− de fábrica: sin esto eran dos teclas blancas, y con el oro de los
    // enlaces encima, oro sobre blanco.
    ['.leaflet-bar a', 'background-color', 'var(--marmol-0)'],
    ['.leaflet-bar a', 'color', 'var(--tinta)'],
  ])('%s → %s: %s', (selector, propiedad, esperado) => {
    expect(declaracion(selector, propiedad)).toBe(esperado);
  });
});
