import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import L from 'leaflet';
import {
  CENTRO_POR_DEFECTO,
  CLASE_TESELAS_CALLES,
  CLASE_TESELAS_SATELITE,
  FONDOS,
  PALETA,
  TRAZO,
  aplicarFondo,
  aspectoDelObjetivo,
  crearFondos,
  droneIcon,
  etiquetaDeNodo,
  iconoBase,
  iconoDeDeteccion,
  iconoObjetivo,
  nombreDeFondo,
  vestir,
  vestirAtribucion,
} from './mapa';
import type { ObjetivoEnSeguimiento } from './types';

vi.mock('leaflet', async () => (await import('./test/dobleLeaflet')).dobleLeaflet());

describe('mapa: lo que comparten todas las vistas', () => {
  afterEach(() => {
    delete document.documentElement.dataset.tema;
  });

  it('el centro por defecto es el Obelisco', () => {
    const [lat, lon] = CENTRO_POR_DEFECTO as [number, number];
    // 9 de Julio y Corrientes, con margen de un par de cuadras
    expect(lat).toBeCloseTo(-34.6037, 3);
    expect(lon).toBeCloseTo(-58.3816, 3);
  });

  it('hay exactamente dos fondos y los dos tienen nombre en castellano', () => {
    expect([...FONDOS]).toEqual(['mapa', 'satelite']);
    expect(nombreDeFondo('mapa')).toBe('Mapa');
    expect(nombreDeFondo('satelite')).toBe('Satélite');
  });

  it('el fondo satelital sale de un servidor de imágenes, no del callejero', () => {
    const capas = crearFondos();
    expect((capas.mapa as unknown as { url: string }).url).toContain('tile.openstreetmap.org');
    expect((capas.satelite as unknown as { url: string }).url).toContain('World_Imagery');
  });

  it('la capa de calles lleva la clase que el CSS oscurece de noche, y el satélite otra', () => {
    // El filtro de obsidiana engancha de esta clase (vistas.css): si el
    // satélite la llevara, la foto se daría vuelta y no se reconocería nada.
    const capas = crearFondos();
    const opciones = (c: unknown) => (c as { opciones: { className?: string } }).opciones;
    expect(opciones(capas.mapa).className).toBe(CLASE_TESELAS_CALLES);
    expect(opciones(capas.satelite).className).toBe(CLASE_TESELAS_SATELITE);
    expect(CLASE_TESELAS_CALLES).not.toBe(CLASE_TESELAS_SATELITE);
  });

  it('aplicar un fondo ya no escribe un filtro inline sobre el pane de teselas', () => {
    // Era el filtro de antes: se calculaba una sola vez con el tema de ese
    // momento, oscurecía también el satélite y no seguía un cambio de tema.
    document.documentElement.dataset.tema = 'oscuro';
    const mapa = L.map(document.createElement('div'));
    const pane = document.createElement('div');
    mapa.getPane = () => pane;
    aplicarFondo(mapa, crearFondos(), 'mapa');
    expect(pane.style.filter).toBe('');
  });

  it('los trazos que el tema aclara tienen cada uno su clase', () => {
    expect(new Set(Object.values(TRAZO)).size).toBe(Object.keys(TRAZO).length);
    for (const clase of Object.values(TRAZO)) expect(clase).toMatch(/^mapa-/);
  });

  it('aplicar un fondo pone el elegido y le saca el otro al mapa', () => {
    const mapa = L.map(document.createElement('div'));
    const capas = crearFondos();

    aplicarFondo(mapa, capas, 'satelite');
    const puesto = capas.satelite as unknown as { url: string };
    const sacado = capas.mapa as unknown as { url: string };
    expect(puesto.url).toContain('World_Imagery');
    expect(sacado.url).toContain('openstreetmap');
  });

  it('el rombo de la base va en negro y ámbar, sin tokens del tema', () => {
    // Con `var(--tinta)` el rombo se daba vuelta en modo oscuro y quedaba
    // blanco sobre el fondo claro del mapa, que es donde se perdía.
    const html = (iconoBase() as unknown as { icono: { html: string } }).icono.html;
    expect(html).toContain('#14120F');
    expect(html).toContain('#F2C230');
    expect(html).not.toContain('var(--');
  });

  it('reusa el mismo ícono en vez de fabricar uno por marcador', () => {
    expect(iconoBase()).toBe(iconoBase());
  });

  it('la etiqueta de un nodo lleva su número y su apodo, si tiene', () => {
    expect(etiquetaDeNodo(0)).toBe('1');
    expect(etiquetaDeNodo(2, '')).toBe('3');
    expect(etiquetaDeNodo(1, 'Portón')).toBe('2 · Portón');
  });

  it('un apodo con HTML sale escapado: Leaflet pinta la etiqueta con innerHTML', () => {
    const malicioso = '<img src=x onerror=alert(1)>';
    const caja = document.createElement('div');
    caja.innerHTML = etiquetaDeNodo(0, malicioso);
    expect(caja.children).toHaveLength(0);
    expect(caja.textContent).toBe(`1 · ${malicioso}`);
  });

  it('vestir no explota con un nodo que Leaflet todavía no creó', () => {
    expect(() => vestir(null, { color: 'red' })).not.toThrow();
    const el = document.createElement('div');
    vestir(el, { color: 'red' });
    expect(el.style.color).toBe('red');
  });

  it('la atribución queda con el prefijo que se le pida', () => {
    const mapa = L.map(document.createElement('div'));
    vestirAtribucion(mapa, '');
    expect(mapa.attributionControl.setPrefix).toHaveBeenCalledWith('');
  });
});

/** El HTML con que el doble de Leaflet se quedó al armar un ícono. */
function htmlDe(icono: L.DivIcon): string {
  return (icono as unknown as { icono: { html: string } }).icono.html;
}

describe('mapa: los marcadores que comparten la flota y el pop-up de una alerta', () => {
  const objetivo: ObjetivoEnSeguimiento = {
    alertId: 7,
    type: 'PERSON',
    lat: -34.6,
    lon: -58.4,
    speedMs: null,
    courseDeg: null,
    moving: false,
    lost: false,
    lastSeenMs: 0,
    decision: 'PENDING',
  };

  it('el objetivo va en óxido mientras la alerta espera, en oro validado y punteado si se lo perdió', () => {
    expect(aspectoDelObjetivo(objetivo)).toEqual({
      color: PALETA.oxido,
      trazo: TRAZO.objetivoPendiente,
      perdido: false,
      clave: 'PENDING-false',
    });
    const validado = aspectoDelObjetivo({ ...objetivo, decision: 'VALIDATED', lost: true });
    expect(validado.color).toBe(PALETA.oro);
    expect(validado.trazo).toBe(TRAZO.objetivoValidado);
    expect(htmlDe(iconoObjetivo(validado))).toContain('stroke-dasharray');
    expect(htmlDe(iconoObjetivo(aspectoDelObjetivo(objetivo)))).not.toContain('stroke-dasharray');
  });

  it('las iniciales del dron salen escapadas, y cada medallón trae su propio degradé', () => {
    const uno = htmlDe(droneIcon('<b>x'));
    const otro = htmlDe(droneIcon('Alfa'));
    const caja = document.createElement('div');
    caja.innerHTML = uno;
    expect(caja.querySelector('b')).toBeNull();
    const id = (html: string) => /linearGradient id="([^"]+)"/.exec(html)![1];
    expect(id(uno)).not.toBe(id(otro));
    expect(otro).toContain('>AL</text>');
  });

  it('la gota de la detección va en el óxido de las alertas y se arma una sola vez', () => {
    expect(iconoDeDeteccion()).toBe(iconoDeDeteccion());
    expect(htmlDe(iconoDeDeteccion())).toContain(PALETA.oxido);
  });
});
