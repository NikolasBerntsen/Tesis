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
