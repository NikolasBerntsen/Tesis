import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { valorDe } from '../test/hojas';

/**
 * Lo del historial de eventos de un dron que ningún test de componentes ve,
 * porque jsdom no carga el CSS: que el detalle se abra AL LADO de la lista (y
 * debajo en una pantalla angosta), que cada columna scrollee por su cuenta, y
 * que el botón para abrirlo quede arriba a la derecha.
 */
function leer(rel: string): string {
  // CRLF fuera: en un clon de Windows con `core.autocrlf` las hojas llegan así.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const sinComentarios = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const modales = sinComentarios(leer('./modales.css'));
const vistas = sinComentarios(leer('./vistas.css'));
const layout = sinComentarios(leer('./layout.css'));

/** El contenido del `@media (max-width: 900px)` de modales.css. */
function angosta(): string {
  const bloque = /@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/.exec(modales);
  expect(bloque, 'falta el bloque de pantalla angosta').not.toBeNull();
  return bloque![1];
}

describe('historial de eventos de un dron', () => {
  it('con un evento abierto, la lista y el detalle van lado a lado', () => {
    // Lo de pantalla ancha: desde la primera regla del historial hasta su bloque angosto.
    const desde = modales.indexOf('.modal-caja.modal-ancho:has(> .historial)');
    const ancha = modales.slice(desde, modales.indexOf('@media (max-width: 900px)', desde));
    const columnas = valorDe(ancha, '.modal-cuerpo.historial.con-detalle', 'grid-template-columns');
    expect(columnas?.split(/\s+(?=minmax)/)).toHaveLength(2);
  });

  it('cada columna scrollea por su cuenta: leer un detalle largo no hace perder el lugar en la lista', () => {
    expect(valorDe(modales, '.historial.con-detalle > .historial-lista', 'overflow-y')).toBe('auto');
    expect(valorDe(modales, '.historial.con-detalle > .historial-detalle', 'overflow-y')).toBe('auto');
  });

  it('en una pantalla angosta el detalle baja debajo de la lista', () => {
    expect(angosta()).toMatch(/\.modal-cuerpo\.historial\.con-detalle\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  });

  it('apiladas, las columnas no se achican por debajo de su contenido: el detalle se pintaba encima de la lista', () => {
    // El `min-height: 0` que deja scrollear cada columna va sólo con el detalle
    // abierto en pantalla ancha, y la angosta lo devuelve a `auto`.
    expect(valorDe(modales, '.historial-lista', 'min-height')).toBeNull();
    expect(angosta()).toMatch(/\.historial\.con-detalle > \.historial-detalle\s*\{[^}]*min-height:\s*auto;/);
  });

  it('la caja se ensancha para las dos columnas', () => {
    expect(valorDe(modales, '.modal-caja.modal-ancho:has(> .historial)', 'width')).toMatch(/^min\(\d+px, 100%\)$/);
  });

  it('las filas son botones sin cara de tecla', () => {
    expect(valorDe(vistas, '.log-row-boton', 'border')).toBe('0');
    expect(valorDe(vistas, '.log-row-boton', 'background')).toBe('none');
    expect(valorDe(vistas, '.log-row-boton', 'text-align')).toBe('left');
    // El hover de `button` le teñía de oro el borde de abajo.
    expect(valorDe(vistas, '.log-row-boton:hover:not(:disabled)', 'border-color')).toBe('var(--veta)');
  });

  it('"Ver historial de eventos" va contra el borde derecho de la cabecera del dron', () => {
    expect(valorDe(layout, '.detail-head .detalle-historial', 'margin-left')).toBe('auto');
  });
});
