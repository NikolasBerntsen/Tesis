import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
