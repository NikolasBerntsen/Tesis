import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { valorDe } from '../test/hojas';

/**
 * Las vistas de gestión (Drones, Bases, Rutas, Usuarios, Registro) con el
 * aspecto del prototipo. jsdom no calcula el armado, así que lo que se fija
 * acá es el contrato de las hojas: que nada se salga de la pantalla de un
 * teléfono, que lo que se toca tenga el alto táctil y que los filtros y las
 * fichas se lean igual en todas las vistas.
 */
function leer(rel: string): string {
  // CRLF fuera: en un clon de Windows con `core.autocrlf` las hojas llegan así.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}
const sinComentarios = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const modales = leer('./modales.css');
const nuevos = leer('./nuevos.css');
const primitivos = leer('./primitivos.css');
const vistas = leer('./vistas.css');
const pulido = sinComentarios(leer('./pulido.css'));

describe('fichas de Drones y Bases', () => {
  it('la grilla no se sale de un teléfono: la columna toma el ancho que haya', () => {
    expect(valorDe(modales, '.fichas', 'grid-template-columns')).toMatch(/minmax\(min\(\d+px, 100%\), 1fr\)/);
  });

  it('las acciones de una ficha se tocan con el dedo: alto táctil, y el lápiz y el tacho cuadrados', () => {
    expect(valorDe(modales, '.ficha-acciones > button', 'min-height')).toBe('var(--alto-tactil)');
    expect(valorDe(modales, '.ficha-acciones > .icono-boton', 'width')).toBe('var(--alto-tactil)');
    expect(valorDe(modales, '.ficha-acciones > .icono-boton', 'height')).toBe('var(--alto-tactil)');
    expect(valorDe(nuevos, '.icono-boton.cuadrado', 'border-radius')).toBe('var(--radio-chico)');
  });

  it('el nombre va grabado en Cinzel, como la marca y los rótulos de sección', () => {
    expect(valorDe(modales, '.ficha-nombre', 'font-family')).toBe('var(--fuente-marca)');
    expect(valorDe(nuevos, '.ruta-item .ruta-item-nombre', 'font-family')).toBe('var(--fuente-marca)');
  });

  it('la pastilla de estado es una sola: la de la cámara del tablero no la vuelve a dibujar', () => {
    expect(valorDe(primitivos, '.estado.pastilla', 'border-radius')).toBe('999px');
    const teja = '.tile-info > .tile-row:first-child > .estado';
    expect(valorDe(vistas, teja, 'border')).toBeNull();
    expect(valorDe(vistas, teja, 'border-radius')).toBeNull();
  });
});

describe('tabla de Usuarios', () => {
  it('en un teléfono no se aprieta: conserva su ancho y scrollea de costado adentro de su caja', () => {
    expect(valorDe(modales, '.tabla-gestion', 'min-width')).toMatch(/^\d+px$/);
    expect(valorDe(primitivos, '.tabla-envoltorio', 'overflow-x')).toBe('auto');
  });

  it('los botones escritos de una fila miden lo mismo que el lápiz y el tacho', () => {
    expect(valorDe(modales, '.acciones-fila > button', 'min-height')).toBe('var(--alto-control)');
  });
});

describe('filtros', () => {
  it('«Ver eliminados» y las categorías del Registro son la misma ficha redonda', () => {
    expect(valorDe(nuevos, '.toggle-eliminados', 'border-radius')).toBe('999px');
    expect(valorDe(nuevos, '.tabs button', 'border-radius')).toBe('999px');
  });

  it('el filtro encendido no pierde el oro bajo el mouse', () => {
    // El hover del apagado excluye al encendido: si no, le sacaba el velo.
    expect(sinComentarios(nuevos)).toMatch(/\.toggle-eliminados:not\(\.activo\):hover/);
    expect(sinComentarios(nuevos)).toMatch(/\.tabs button:not\(\[aria-selected='true'\]\):hover/);
  });
});

describe('el Registro en un teléfono', () => {
  it('el lienzo crece con la lista y scrollea la página, en vez de dejar el cuerpo en cero', () => {
    const consulta = /@media \(max-width: 640px\), \(max-height: 600px\)\s*\{([\s\S]*?)\n\}/.exec(sinComentarios(nuevos));
    expect(consulta, 'falta la consulta de pantallas chicas').not.toBeNull();
    expect(consulta![1]).toMatch(/\.page-main:has\(> \.vista-alta\)\s*\{\s*min-height:\s*auto;/);
  });

  it('las filas apilan hora y sello arriba, y el mensaje a todo el ancho', () => {
    const consulta = /@media \(max-width: 640px\)\s*\{\s*\.log-row-general([\s\S]*?)\n\}/.exec(sinComentarios(vistas));
    expect(consulta, 'falta la fila del Registro en un teléfono').not.toBeNull();
    expect(consulta![1]).toMatch(/grid-column:\s*1 \/ -1/);
  });
});

describe('movimiento', () => {
  it('las listas nuevas se apagan al recargar y, con movimiento reducido, no se animan', () => {
    for (const lista of ['.fichas', '.lista-rutas']) {
      expect(valorDe(pulido, `${lista}[aria-busy='true']`, 'opacity')).toBe('.6');
    }
    const reducido = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/.exec(pulido);
    expect(reducido).not.toBeNull();
    for (const selector of ['.fichas', '.lista-rutas', '.ruta-item']) expect(reducido![1]).toContain(selector);
  });
});
