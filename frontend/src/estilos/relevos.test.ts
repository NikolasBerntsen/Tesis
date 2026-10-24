import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { valorDe } from '../test/hojas';

/**
 * Lo de relevos.css que ningún test de componentes ve: jsdom no carga el CSS.
 * Las pastillas de estado no se parten (primitivos.css), y las de un relevo
 * llevan el nombre de otro dron, que puede tener 40 letras: en nowrap se
 * salían de la ficha de la cámara y el tablero quedaba con scroll de costado
 * en un teléfono. Lo mismo la situación de una emergencia en la columna de
 * los datos del pop-up.
 */
function leer(rel: string): string {
  // CRLF fuera: en un clon de Windows con `core.autocrlf` las hojas llegan así.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const relevos = leer('./relevos.css');
const primitivos = leer('./primitivos.css');

function px(valor: string | null): number {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(valor ?? '');
  expect(m, `${valor} no es una medida en px`).not.toBeNull();
  return Number(m![1]);
}

/** Las pastillas que llevan un texto de largo libre: un nombre o una situación. */
const PASTILLAS_LARGAS = ['.insignias-relevo > .estado.pastilla', '.detalle-emergencia .datos .estado.pastilla'];

describe('relevos.css', () => {
  it('entra por styles.css después de las pastillas de primitivos.css, que es lo que corrige', () => {
    const indice = leer('../styles.css');
    expect(indice).toContain("@import './estilos/relevos.css';");
    expect(indice.indexOf('relevos.css')).toBeGreaterThan(indice.indexOf('primitivos.css'));
  });

  it.each(PASTILLAS_LARGAS)('%s se parte dentro de su fila en vez de salirse', (selector) => {
    expect(valorDe(relevos, selector, 'white-space')).toBe('normal');
    expect(valorDe(relevos, selector, 'max-width')).toBe('100%');
    // Un nombre sin espacios también tiene que poder partirse.
    expect(valorDe(relevos, selector, 'overflow-wrap')).toBe('anywhere');
    // Con el interlineado de 1 de la pastilla, los dos renglones se pisaban.
    expect(Number(valorDe(relevos, selector, 'line-height'))).toBeGreaterThanOrEqual(1.2);
  });

  it.each(PASTILLAS_LARGAS)('%s: el punto no se achica cuando el texto aprieta', (selector) => {
    expect(valorDe(relevos, `${selector}::before`, 'flex')).toBe('none');
  });

  it('partida sigue siendo una placa redonda: el canto no pasa la mitad del alto de un renglón', () => {
    const alto = px(valorDe(primitivos, '.estado.pastilla', 'min-height'));
    for (const selector of PASTILLAS_LARGAS) {
      expect(px(valorDe(relevos, selector, 'border-radius')) * 2, selector).toBeLessThanOrEqual(alto);
    }
    const cabecera = '.detail-head > .insignias-relevo > .estado.pastilla';
    expect(px(valorDe(relevos, cabecera, 'border-radius')) * 2).toBeLessThanOrEqual(
      px(valorDe(relevos, cabecera, 'min-height')),
    );
  });

  it('el detalle de una insignia queda para el lector de pantalla: fuera de la vista, no fuera del árbol', () => {
    expect(valorDe(relevos, '.insignia-solo-lector', 'display')).toBeNull();
    expect(valorDe(relevos, '.insignia-solo-lector', 'visibility')).toBeNull();
    expect(valorDe(relevos, '.insignia-solo-lector', 'position')).toBe('absolute');
    expect(valorDe(relevos, '.insignia-solo-lector', 'clip-path')).toBe('inset(50%)');
  });
});
