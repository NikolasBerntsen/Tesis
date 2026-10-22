import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLASE_TESELAS_CALLES, CLASE_TESELAS_SATELITE, TRAZO } from '../mapa';
import { contraste, leerTokens, parsearColor, resolver } from '../test/wcag';

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

describe('trazos sobre el mapa', () => {
  const TOKENS: Record<keyof typeof TRAZO, string> = {
    hilo: '--mapa-hilo',
    recorrido: '--mapa-recorrido',
    nodo: '--mapa-filo-nodo',
  };

  it.each(Object.entries(TRAZO) as [keyof typeof TRAZO, string][])('%s: .%s se tiñe con su token', (rol, clase) => {
    expect(declaracion(`.${clase}`, 'stroke')).toBe(`var(${TOKENS[rol]})`);
  });

  // Contra qué se miden: en mármol, el crema de la tierra de OpenStreetMap;
  // en obsidiana, la piedra hundida, que es el tono al que el filtro lleva el
  // callejero (y el fondo del mapa mientras cargan las teselas).
  const TIERRA_OSM = parsearColor('#F2EFE9')!;
  it.each(Object.values(TOKENS))('%s se distingue del mapa en los dos temas (3:1)', (token) => {
    expect(contraste(parsearColor(enTema('claro', token))!, TIERRA_OSM)).toBeGreaterThanOrEqual(3);
    const piedra = parsearColor(enTema('oscuro', '--marmol-2'))!;
    expect(contraste(parsearColor(enTema('oscuro', token))!, piedra)).toBeGreaterThanOrEqual(3);
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
