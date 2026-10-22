import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Lo del carrusel de alertas que ningún test de componentes ve: jsdom no carga
 * el CSS. Son dos reglas del sistema que se rompen sin que nada falle —un
 * color escrito a mano queda bien en mármol y mal en obsidiana, y un latido sin
 * su `prefers-reduced-motion` mueve la pantalla a quien pidió que no se mueva—.
 */
function leer(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const alertas = leer('./alertas.css');
// Sin comentarios: ahí se puede nombrar un color sin usarlo.
const reglas = alertas.replace(/\/\*[\s\S]*?\*\//g, '');

describe('alertas.css', () => {
  it('entra por styles.css, antes de la hoja de impresión', () => {
    const indice = leer('../styles.css');
    expect(indice).toContain("@import './estilos/alertas.css';");
    expect(indice.indexOf('alertas.css')).toBeLessThan(indice.indexOf('impresion.css'));
  });

  it('no escribe colores literales: todo sale de los tokens, para los dos temas', () => {
    expect(reglas).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(reglas).not.toMatch(/\b(rgba?|hsla?)\(/i);
  });

  it('el latido de una alerta nueva se apaga con movimiento reducido', () => {
    expect(reglas).toMatch(/\.carrusel-cuenta\.llego\s*\{[^}]*animation:[^}]*\b1;/);
    const reducido = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(reglas);
    expect(reducido, 'falta el bloque de movimiento reducido').not.toBeNull();
    expect(reducido![1]).toMatch(/\.carrusel-cuenta\.llego\s*\{\s*animation:\s*none;/);
  });
});
