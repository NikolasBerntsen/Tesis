import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * El orden de apilado no se ve en ningún test de componentes: jsdom no calcula
 * capas. Igual es una regla dura del producto —un diálogo abierto tiene que
 * tapar lo que hay atrás— y ya se rompió una vez: el mapa de perímetro de la
 * vista de Rutas se pintaba encima del editor y dejaba la pantalla ilegible.
 * Estas aserciones fijan la regla contra el z-index real de Leaflet.
 */
function leer(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

function zIndexDe(css: string, selector: string): number {
  const bloque = css.split(selector)[1];
  expect(bloque, `no está el selector ${selector}`).toBeDefined();
  const m = /z-index:\s*(\d+)/.exec(bloque.slice(0, bloque.indexOf('}')));
  expect(m, `${selector} no declara z-index`).not.toBeNull();
  return Number(m![1]);
}

const nuevos = leer('./nuevos.css');
const vistas = leer('./vistas.css');
const leaflet = leer('../../node_modules/leaflet/dist/leaflet.css');

const topeLeaflet = Math.max(...[...leaflet.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
const velo = zIndexDe(nuevos, '.modal,\n.modal-fondo {');
const fondos = zIndexDe(vistas, '.mapa-fondos {');

describe('orden de apilado', () => {
  it('Leaflet declara capas altas: la referencia no es cero', () => {
    expect(topeLeaflet).toBeGreaterThanOrEqual(800);
  });

  it('el velo del diálogo tapa cualquier capa de Leaflet', () => {
    expect(velo).toBeGreaterThan(topeLeaflet);
  });

  it('el conmutador de fondo flota sobre el mapa pero se queda abajo del diálogo', () => {
    expect(fondos).toBeGreaterThan(800);
    expect(fondos).toBeLessThan(velo);
  });
});

/**
 * La celda de acciones de una tabla tiene que seguir siendo una celda. Un `td`
 * en `display:flex` deja de serlo —el navegador le arma una celda anónima
 * alrededor— y su borde inferior termina a distinta altura que el de las
 * celdas vecinas: la línea que separa las filas se ve cortada en pedazos, que
 * es exactamente como se veía la tabla de rutas.
 */
describe('celda de acciones de las tablas', () => {
  const layout = leer('./layout.css');

  it('la celda no queda en flex: la fila se cortaba en pedazos', () => {
    const bloque = layout.slice(layout.indexOf('td.barra-acciones {'));
    const cuerpo = bloque.slice(0, bloque.indexOf('}'));
    expect(cuerpo).toMatch(/display:\s*table-cell/);
    expect(cuerpo).not.toMatch(/display:\s*flex/);
  });

  it('los botones no se parten en dos renglones', () => {
    const bloque = layout.slice(layout.indexOf('td.barra-acciones {'));
    expect(bloque.slice(0, bloque.indexOf('}'))).toMatch(/white-space:\s*nowrap/);
  });
});
