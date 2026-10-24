import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { valorDe } from '../test/hojas';

/**
 * El apilado de la vista de pilotaje, contra los números reales de Leaflet y
 * del velo de los diálogos (ver apilado.test.ts, que fija el resto). jsdom no
 * calcula capas, así que la regla se fija leyendo las hojas.
 */
function leer(rel: string): string {
  // CRLF fuera: en un clon de Windows con `core.autocrlf` los selectores de
  // varias líneas no aparecerían nunca.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

function zIndexDe(css: string, selector: string): number {
  const bloque = css.split(selector)[1];
  expect(bloque, `no está el selector ${selector}`).toBeDefined();
  const m = /z-index:\s*(\d+)/.exec(bloque.slice(0, bloque.indexOf('}')));
  expect(m, `${selector} no declara z-index`).not.toBeNull();
  return Number(m![1]);
}

const pilotaje = leer('./pilotaje.css');
const nuevos = leer('./nuevos.css');
const leaflet = leer('../../node_modules/leaflet/dist/leaflet.css');
const topeLeaflet = Math.max(...[...leaflet.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
const velo = zIndexDe(nuevos, '.modal,\n.modal-fondo {');

describe('apilado de la vista de pilotaje', () => {
  it('tapa el mapa del detalle que queda atrás, y los diálogos se abren encima de ella', () => {
    const vista = zIndexDe(pilotaje, '\n.pilotaje {');
    expect(vista).toBeGreaterThan(topeLeaflet);
    expect(vista).toBeLessThan(velo);
  });

  it('la flecha y el "Sin GPS" del minimapa van arriba de las capas de Leaflet', () => {
    expect(zIndexDe(pilotaje, '.minimapa-dron {')).toBeGreaterThan(topeLeaflet);
    expect(zIndexDe(pilotaje, '.minimapa-sin-gps {')).toBeGreaterThan(topeLeaflet);
    // Y quedan contenidas en el recuadro: sin un contexto propio, 1100 le
    // ganaría también al HUD de alrededor.
    const minimapa = pilotaje.split('\n.minimapa {')[1];
    expect(minimapa.slice(0, minimapa.indexOf('}'))).toMatch(/isolation:\s*isolate/);
  });

  it('la hoja se carga antes que la de impresión, que es la que tiene que ganar al imprimir', () => {
    const estilos = leer('../styles.css');
    expect(estilos.indexOf("@import './estilos/pilotaje.css';")).toBeGreaterThan(-1);
    expect(estilos.indexOf("@import './estilos/pilotaje.css';")).toBeLessThan(
      estilos.indexOf("@import './estilos/impresion.css';"),
    );
  });
});

/** Las líneas de la grilla entre las que va un selector: `1 / 3` → [1, 3], `3` → [3, 4]. */
function filas(css: string, selector: string): [number, number] {
  const valor = valorDe(css, selector, 'grid-row');
  expect(valor, `${selector} no declara grid-row`).not.toBeNull();
  const [desde, hasta] = valor!.split('/').map((linea) => Number(linea.trim()));
  return [desde, hasta ?? desde + 1];
}

describe('los globos de la derecha terminan arriba del pie', () => {
  /*
   * Colgados de los botones con un alto sacado de la ventana (100vh menos
   * 120 px), la ayuda y los ajustes tapaban Aterrizar y Modo mouse en cualquier
   * pantalla de menos de unos 1000 px de alto, y en jsdom nadie se enteraba: no
   * maqueta. Lo que se fija es la grilla que lo impide.
   */
  const [escritorio, telefono] = pilotaje.split('@media (max-width: 760px)');

  it.each([
    ['en el escritorio', escritorio],
    ['en el teléfono', telefono],
  ])('%s, la columna de la derecha baja hasta la fila del pie, sin entrar en ella', (_donde, css) => {
    const [arriba, abajo] = filas(css, '.pilotaje-derecha');
    expect(arriba).toBe(1);
    expect(abajo).toBe(filas(css, '.pilotaje-pie')[0]);
  });

  it('la columna se estira hasta ahí, y los globos miden hasta el fondo de su hueco', () => {
    expect(valorDe(pilotaje, '.pilotaje-derecha', 'align-self')).toBe('stretch');
    expect(valorDe(pilotaje, '.pilotaje-globos', 'position')).toBe('relative');
    expect(valorDe(pilotaje, '.pilotaje-globos', 'min-height')).toBe('0');
    expect(valorDe(pilotaje, '.pilotaje-globo', 'top')).toBe('0');
    expect(valorDe(pilotaje, '.pilotaje-globo', 'max-height')).toBe('100%');
    expect(valorDe(pilotaje, '.pilotaje-globo', 'overflow-y')).toBe('auto');
  });

  it('la ayuda y los ajustes son el mismo cuadro: ninguno pisa el marco común', () => {
    for (const globo of ['.pilotaje-ayuda', '.pilotaje-ajustes']) {
      for (const propiedad of ['position', 'top', 'width', 'max-height', 'padding']) {
        expect(valorDe(pilotaje, globo, propiedad), `${globo} { ${propiedad} }`).toBeNull();
      }
    }
  });

  it('en el teléfono, "Pantalla completa" baja a su renglón y no aprieta la salida', () => {
    expect(valorDe(escritorio, '.pilotaje-derecha-botones', 'flex-direction')).toBeNull();
    expect(valorDe(telefono, '.pilotaje-derecha-botones', 'flex-direction')).toBe('column');
  });
});
