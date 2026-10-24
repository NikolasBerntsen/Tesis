import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DURACION_AVISO_MS } from '../components/AvisosFlotantes';
import { SALIDA_MS } from '../components/Modal';
import { valorDe } from '../test/hojas';
import { leerTokens } from '../test/wcag';

/**
 * Lo del pulido que ningún test de componentes ve: jsdom no carga el CSS. Son
 * reglas que se rompen sin que falle nada —una animación sin su
 * `prefers-reduced-motion`, un reloj de JS que se desfasa del token que mide
 * la animación, un aviso que tapa un botón— y que el operador sí nota.
 */
function leer(rel: string): string {
  // CRLF fuera: en un clon de Windows con `core.autocrlf` las hojas llegan así.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}
const sinComentarios = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const pulido = sinComentarios(leer('./pulido.css'));
const tokens = leerTokens(leer('./tokens.css'));

/** El cuerpo del primer bloque cuyo selector termina exactamente así. */
function bloque(css: string, selector: string): string {
  const desde = css.indexOf(`${selector} {`);
  expect(desde, `no está el bloque ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(desde, css.indexOf('}', desde));
}

function ms(valor: string | undefined): number {
  const m = /^(\d+)ms$/.exec(valor ?? '');
  expect(m, `${valor} no es una duración en ms`).not.toBeNull();
  return Number(m![1]);
}

describe('pulido.css', () => {
  it('entra por styles.css después de las vistas y antes de la hoja de impresión', () => {
    const indice = leer('../styles.css');
    expect(indice).toContain("@import './estilos/pulido.css';");
    expect(indice.indexOf('pulido.css')).toBeGreaterThan(indice.indexOf('pilotaje.css'));
    expect(indice.indexOf('pulido.css')).toBeLessThan(indice.indexOf('impresion.css'));
  });

  it('no escribe colores literales: todo sale de los tokens, para los dos temas', () => {
    expect(pulido).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(pulido).not.toMatch(/\b(rgba?|hsla?)\(/i);
  });

  it('todo lo que se mueve usa las duraciones de los tokens, no números sueltos', () => {
    for (const [, valor] of pulido.matchAll(/(?:animation|transition)\s*:\s*([^;]+);/g)) {
      if (valor.trim() === 'none') continue;
      expect(valor, valor).toMatch(/var\(--(duracion|transicion)/);
      expect(valor, valor).not.toMatch(/\d+m?s\b/);
    }
  });

  it('con movimiento reducido no se anima nada de lo que agrega', () => {
    const reducido = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/.exec(pulido);
    expect(reducido, 'falta el bloque de movimiento reducido').not.toBeNull();
    const cuerpo = reducido![1];
    // Cada selector que declara una animación tiene que aparecer apagado ahí.
    const animados = ['.page-main', '.dashboard-main', '.detail-main', '.campana-panel', '.aviso-flotante', '.esqueleto-fila::before'];
    for (const selector of animados) expect(cuerpo, selector).toContain(selector);
    expect(cuerpo).toMatch(/animation:\s*none;/);
    expect(cuerpo).toMatch(/transition:\s*none;/);
  });

  it('el aviso flota por encima del velo de los diálogos pero nunca recibe el mouse', () => {
    const avisos = bloque(pulido, '.avisos-flotantes');
    const velo = Number(/z-index:\s*(\d+)/.exec(bloque(sinComentarios(leer('./nuevos.css')), '.modal-fondo'))![1]);
    expect(Number(/z-index:\s*(\d+)/.exec(avisos)![1])).toBeGreaterThan(velo);
    expect(avisos).toMatch(/pointer-events:\s*none/);
  });

  it('los controles de la cabecera miden lo mismo que el ícono redondo que tienen al lado', () => {
    // Todos al alto táctil, como los botones del prototipo: el buscador, los
    // filtros, "Nuevo …" y el ícono de actualizar se tocan con el dedo.
    expect(bloque(pulido, '.vista-cabecera button:not(.icono-boton)')).toMatch(/min-height:\s*var\(--alto-tactil\)/);
    const icono = bloque(pulido, '.vista-cabecera .icono-boton');
    expect(icono).toMatch(/width:\s*var\(--alto-tactil\)/);
    expect(icono).toMatch(/height:\s*var\(--alto-tactil\)/);
    expect(valorDe(pulido, '.vista-cabecera input', 'height')).toBe('var(--alto-tactil)');
    expect(tokens.claro.get('--alto-tactil')).toBe('44px');
  });

  it('la acción del pie de un diálogo no cambia de ancho mientras el pedido viaja', () => {
    expect(pulido).toMatch(/\.modal-pie > :is\([^)]*button\.dismiss[^)]*\)\s*\{\s*min-width:\s*var\(--ancho-accion\)/);
  });
});

describe('los relojes de JS siguen a los tokens que miden la animación', () => {
  it('el aviso se va cuando termina de desvanecerse: DURACION_AVISO_MS es --duracion-aviso', () => {
    expect(ms(tokens.claro.get('--duracion-aviso'))).toBe(DURACION_AVISO_MS);
  });

  it('el eco del diálogo dura lo que su animación: SALIDA_MS es --duracion', () => {
    expect(ms(tokens.claro.get('--duracion'))).toBe(SALIDA_MS);
    expect(tokens.claro.get('--transicion')).toContain('var(--duracion)');
  });
});

describe('arreglos del sistema que el pulido fija', () => {
  it('el anillo de foco no le cambia la forma a lo enfocado (los botones redondos quedaban cuadrados)', () => {
    const base = sinComentarios(leer('./base.css'));
    const foco = bloque(base, ':focus-visible');
    expect(foco).toMatch(/outline:/);
    expect(foco).not.toMatch(/border-radius/);
  });

  it('la barra superior baja las secciones a su propia fila por debajo de 1280 px', () => {
    const layout = sinComentarios(leer('./layout.css'));
    expect(bloque(layout, '.topbar')).toMatch(/grid-template-areas:\s*'marca secciones sesion'/);
    const mediana = /@media \(max-width: 1279px\)\s*\{([\s\S]*?)\n\}/.exec(layout);
    expect(mediana, 'falta la consulta de pantallas medianas').not.toBeNull();
    expect(mediana![1]).toMatch(/'marca sesion'\s*'secciones secciones'/);
  });

  // Las variantes (Validar, Devolver al patrullaje, Eliminar, Cancelar) tienen
  // la misma especificidad que `button:disabled` y vienen después: sin su
  // propio :disabled le pisaban la cara apagada y se veían tocables.
  it.each(['validate', 'resume', 'dismiss'])('button.%s deshabilitado vuelve al hueco apagado', (variante) => {
    const primitivos = leer('./primitivos.css');
    const selector = `button.${variante}:disabled`;
    expect(valorDe(primitivos, selector, 'color')).toBe('var(--tinta-suave)');
    expect(valorDe(primitivos, selector, 'border-color')).toBe('var(--veta)');
    expect(valorDe(primitivos, selector, 'background-image')).toBe('none');
    expect(valorDe(primitivos, selector, 'background-color')).toBe('var(--marmol-2)');
  });

  it('el botón fantasma deshabilitado apaga la tinta', () => {
    expect(valorDe(leer('./primitivos.css'), 'button.ghost:disabled', 'color')).toBe('var(--tinta-suave)');
  });

  it('en un teléfono la barra apila marca, sesión y secciones: el título no queda en una columna de 0 px', () => {
    const layout = sinComentarios(leer('./layout.css'));
    const telefono = /@media \(max-width: 640px\)\s*\{([\s\S]*?)\n\}/.exec(layout);
    expect(telefono, 'falta la consulta de teléfonos').not.toBeNull();
    expect(telefono![1]).toMatch(/grid-template-areas:\s*'marca'\s*'sesion'\s*'secciones'/);
    // Y entre el teléfono y el escritorio el título conserva su ancho: la
    // columna que se encoge (y parte en renglones) es la de la sesión.
    const mediana = /@media \(max-width: 1279px\)\s*\{([\s\S]*?)\n\}/.exec(layout)![1];
    expect(mediana).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\)/);
  });

  it('el nombre de usuario largo se recorta en vez de empujar la barra', () => {
    const usuario = bloque(sinComentarios(leer('./layout.css')), '.username');
    expect(usuario).toMatch(/text-overflow:\s*ellipsis/);
    expect(usuario).toMatch(/max-width:/);
  });
});
