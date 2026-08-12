import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import L from 'leaflet';
import {
  CENTRO_POR_DEFECTO,
  FONDOS,
  aplicarFondo,
  crearFondos,
  filtroDeTeselas,
  iconoBase,
  nombreDeFondo,
  vestir,
  vestirAtribucion,
} from './mapa';

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

  it('sólo atenúa las teselas en modo oscuro', () => {
    expect(filtroDeTeselas()).toBe('none');
    document.documentElement.dataset.tema = 'oscuro';
    expect(filtroDeTeselas()).toMatch(/brightness/);
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
