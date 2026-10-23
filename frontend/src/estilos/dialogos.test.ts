import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reglas, valorDe } from '../test/hojas';

/**
 * Lo de los diálogos, el detalle de un dron, el ingreso y los avisos que
 * ningún test de componentes ve, porque jsdom no carga el CSS: que la cruz y
 * los botones se toquen con el dedo, que el pie hable como el resto de la
 * consola, que las listas de datos lleven sus hilos y que nada se salga de un
 * teléfono.
 */
function leer(rel: string): string {
  // CRLF fuera: en un clon de Windows con `core.autocrlf` las hojas llegan así.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}
const sinComentarios = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const nuevos = leer('./nuevos.css');
const layout = leer('./layout.css');
const pulido = leer('./pulido.css');
const modales = leer('./modales.css');
const vistas = leer('./vistas.css');
const alertas = leer('./alertas.css');
const primitivos = leer('./primitivos.css');

/** La regla que nombra `selector` en su lista (la primera, si hay varias). */
function reglaCon(css: string, selector: string) {
  const regla = reglas(css).find((r) => r.selectores.includes(selector));
  expect(regla, `no está la regla de ${selector}`).toBeDefined();
  return regla!;
}

/** El cuerpo de la consulta `@media (max-width: N)` que contiene `selector`. */
function enConsulta(css: string, ancho: string, selector: string): string {
  const consultas = [...sinComentarios(css).matchAll(new RegExp(`@media \\(max-width: ${ancho}\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'))];
  const cuerpo = consultas.map((m) => m[1]).find((c) => c.includes(selector));
  expect(cuerpo, `ninguna consulta de ${ancho} toca ${selector}`).toBeDefined();
  return cuerpo!;
}

describe('diálogos', () => {
  it('la cruz de cerrar es una tecla cuadrada al alto táctil, como el .icono-btn del prototipo', () => {
    expect(valorDe(nuevos, '.modal-cerrar', 'width')).toBe('var(--alto-tactil)');
    expect(valorDe(nuevos, '.modal-cerrar', 'height')).toBe('var(--alto-tactil)');
    // El radio es el de cualquier botón: redonda era otra clase de control.
    expect(valorDe(nuevos, '.modal-cerrar', 'border-radius')).toBeNull();
    expect(valorDe(nuevos, '.modal-cerrar:hover:not(:disabled)', 'color')).toBe('var(--oro-texto)');
  });

  it('el título va en Cormorant y la caja lleva el hilo de oro de los paneles, sin lámina en el canto', () => {
    expect(valorDe(nuevos, '.modal-titulo', 'font-family')).toBe('var(--fuente-serif)');
    expect(valorDe(nuevos, '.modal-caja', 'border')).toBe('1px solid var(--veta-fuerte)');
    expect(reglas(nuevos).some((r) => r.selectores.includes('.modal-caja::before'))).toBe(false);
  });

  it('el pie va a la derecha y sus botones hablan como los de la cabecera de una vista', () => {
    expect(valorDe(nuevos, '.modal-pie', 'justify-content')).toBe('flex-end');
    const regla = reglaCon(pulido, '.vista-cabecera button:not(.icono-boton)');
    expect(regla.selectores).toEqual(
      expect.arrayContaining(['.modal-pie > button', '.login-card button', '.detail-head > .detalle-historial']),
    );
    expect(regla.cuerpo).toMatch(/min-height:\s*var\(--alto-tactil\)/);
    expect(regla.cuerpo).toMatch(/text-transform:\s*uppercase/);
  });

  it('lo destructivo que se confirma lleva la placa óxido de Descartar, no sólo el filo', () => {
    expect(valorDe(primitivos, '.modal-pie > button.dismiss', 'background-color')).toBe('var(--descarta-fondo)');
    expect(valorDe(primitivos, '.modal-pie > button.dismiss', 'color')).toBe('var(--descarta-texto)');
  });

  it('los campos de un formulario se tocan con el dedo; las casillas quedan afuera', () => {
    const regla = reglas(modales).find((r) => r.selectores.some((s) => s.includes('.form-usuario label')));
    expect(regla?.cuerpo).toMatch(/min-height:\s*var\(--alto-tactil\)/);
    expect(regla?.selectores.join()).toContain(":not([type='checkbox'])");
    expect(regla?.selectores.join()).toContain('.login-card label');
  });

  it('cada fila de datos va sobre un hilo de oro, salvo en la comparación del antes y el después', () => {
    expect(valorDe(nuevos, '.datos:not(.sin-filetes) > :is(dt, dd)', 'border-top')).toBe('1px solid var(--veta)');
    // La primera fila no lleva hilo: arriba ya hay un título o el canto.
    expect(valorDe(nuevos, '.datos:not(.sin-filetes) > dt:first-of-type', 'border-top')).toBe('0');
    // Los hilos van en las celdas: con hueco entre columnas la línea se cortaba.
    expect(valorDe(nuevos, '.datos', 'gap')).toBeNull();
  });

  it('la columna "después" lleva un hilo de oro y no la lámina gruesa de antes', () => {
    expect(valorDe(nuevos, '.comparacion-despues', 'border-color')).toBe('var(--oro)');
    expect(reglas(nuevos).some((r) => r.selectores.includes('.comparacion-despues::after'))).toBe(false);
  });

  it('en el pop-up de una alerta, Validar y Descartar pesan como en la tarjeta del tablero', () => {
    const selector = ':is(.alerta-en-curso, .detalle-alerta) .alert-actions button';
    expect(valorDe(alertas, selector, 'min-height')).toBe('58px');
    // Lo que se mira a la izquierda y lo que se decide a la derecha, y en una
    // caja angosta los datos bajan: un flex que se parte, no una grilla fija.
    expect(valorDe(alertas, '.detalle-alerta-cuerpo', 'flex-wrap')).toBe('wrap');
  });
});

describe('detalle de un dron', () => {
  it('la batería se lee de lejos: la cifra grande del prototipo', () => {
    expect(valorDe(vistas, '.telemetria-bateria .cifra', 'font-size')).toBe('var(--txt-cifra-grande)');
  });

  it('en un teléfono la telemetría apila sus datos, cada uno sobre su hilo', () => {
    const telefono = enConsulta(vistas, '760px', '.status-grid.telemetria-datos');
    expect(telefono).toMatch(/\.status-grid\.telemetria-datos\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(telefono).toMatch(/\.telemetria-datos > div\s*\{[^}]*border-top:\s*1px solid var\(--veta\);/);
  });

  it('apilado, el video toma el alto de su proporción y no el fijo del escritorio', () => {
    const angosta = enConsulta(layout, '900px', '.par-video-mapa .video');
    expect(angosta).toMatch(/\.par-video-mapa \.video\s*\{[^}]*height:\s*auto;/);
    // Y va después de la de las pantallas bajas, que si no le ganaba.
    expect(layout.lastIndexOf('.par-video-mapa .video { height: auto')).toBeGreaterThan(
      layout.indexOf('@media (max-height: 900px)'),
    );
  });

  it('las órdenes de la vista del dron se dan con el dedo', () => {
    const regla = reglaCon(vistas, '.control-panel > button');
    expect(regla.selectores).toEqual(expect.arrayContaining(['.ruta-controles > :is(button, select)', '.mapa-head > button']));
    expect(regla.cuerpo).toMatch(/min-height:\s*var\(--alto-tactil\)/);
  });
});

describe('ingreso', () => {
  it('la placa no se sale de un teléfono: la columna de la grilla puede achicarse', () => {
    expect(valorDe(layout, '.login-wrapper', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(valorDe(layout, '.login-card', 'max-width')).toBe('100%');
    expect(reglas(layout).some((r) => r.selectores.includes('.login-card::before'))).toBe(false);
  });
});

describe('avisos flotantes', () => {
  it('el tilde del "listo" va en el verde que se mide sobre el panel firme', () => {
    expect(valorDe(pulido, '.aviso-flotante > svg', 'color')).toBe('var(--ok-texto)');
    expect(reglas(pulido).some((r) => r.selectores.includes('.aviso-flotante::before'))).toBe(false);
  });
});
