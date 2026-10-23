import { vi } from 'vitest';

/**
 * Doble de Leaflet para jsdom, compartido por todas las vistas con mapa.
 *
 * Leaflet mide el contenedor y pinta lienzos, así que en jsdom no corre. Antes
 * cada test tenía su propio mock a medida y cualquier cosa que se agregara al
 * mapa —el fondo satelital, la atribución vestida, el control de zoom— rompía
 * cuatro archivos a la vez. Acá está todo lo que la consola le pide a Leaflet,
 * y `estadoMapa` deja mirar lo único que importa: dónde clickeó el usuario y
 * qué capas terminaron puestas.
 *
 * Uso, arriba de todo en el archivo de test:
 *
 *     vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
 *     import { estadoMapa } from '../test/dobleLeaflet';
 */

interface Capa {
  clase: string;
  url?: string;
  latlng?: unknown;
  opciones?: Record<string, unknown>;
  /** Lo que se le pasó a `bindTooltip`: texto (que Leaflet pinta como HTML) o un nodo. */
  etiqueta?: unknown;
}

/**
 * Pinta el contenido de una etiqueta o un globo como lo hace Leaflet
 * (`Tooltip._updateContent`): un texto va con innerHTML y un nodo, tal cual.
 * Es para probar que lo que escribió una persona —un apodo, un nombre— quede
 * como texto y no se convierta en elementos con sus manejadores.
 */
export function pintarComoLeaflet(contenido: unknown): HTMLElement {
  const caja = document.createElement('div');
  if (typeof contenido === 'string') caja.innerHTML = contenido;
  else if (contenido instanceof Node) caja.appendChild(contenido);
  return caja;
}

export const estadoMapa = {
  /** Manejador del clic sobre el mapa, el que agrega nodos o elige coordenadas. */
  clic: null as null | ((e: { latlng: { lat: number; lng: number } }) => void),
  /** Capas que se agregaron al mapa (o a un grupo), en orden. */
  puestas: [] as Capa[],
  /** Capas que se le sacaron al mapa. */
  sacadas: [] as Capa[],
  /** Cuántos mapas se crearon: sirve para probar que no se rehacen por render. */
  mapasCreados: 0,
  /** Cuántos se destruyeron. */
  mapasDestruidos: 0,
  vistas: [] as { centro: unknown; zoom: unknown }[],
  /** Los puntos de cada `fitBounds`, en orden: el encuadre de varios puntos a la vez. */
  encuadres: [] as unknown[][],
};

export function limpiarEstadoMapa() {
  estadoMapa.clic = null;
  estadoMapa.puestas = [];
  estadoMapa.sacadas = [];
  estadoMapa.mapasCreados = 0;
  estadoMapa.mapasDestruidos = 0;
  estadoMapa.vistas = [];
  estadoMapa.encuadres = [];
}

/** URLs de las teselas que se pusieron, para distinguir callejero de satelital. */
export function fondosPuestos(): string[] {
  return estadoMapa.puestas.filter((c) => c.clase === 'tileLayer' && c.url).map((c) => c.url!);
}

export function dobleLeaflet() {
  function capa(clase: string, url?: string, latlng?: unknown, opciones?: Record<string, unknown>) {
    const propia: Capa = { clase, url, latlng, opciones };
    const objeto = {
      ...propia,
      addTo: (_destino: unknown) => {
        estadoMapa.puestas.push(propia);
        return objeto;
      },
      remove: () => {
        estadoMapa.sacadas.push(propia);
      },
      bindTooltip: (contenido: unknown) => {
        propia.etiqueta = contenido;
        return objeto;
      },
      bindPopup: () => objeto,
      setLatLng: (v: unknown) => {
        propia.latlng = v;
        return objeto;
      },
      setStyle: () => objeto,
      setRadius: () => objeto,
      openPopup: () => objeto,
      closePopup: () => objeto,
      setLatLngs: () => objeto,
      getElement: () => null,
      on: () => objeto,
    };
    return objeto;
  }

  function crearMapa() {
    const mapa = {
      setView: (centro: unknown, zoom: unknown) => {
        estadoMapa.vistas.push({ centro, zoom });
        return mapa;
      },
      on: (evento: string, fn: (e: { latlng: { lat: number; lng: number } }) => void) => {
        if (evento === 'click') estadoMapa.clic = fn;
        return mapa;
      },
      off: () => mapa,
      remove: () => {
        estadoMapa.mapasDestruidos += 1;
      },
      removeLayer: (c: { clase?: string; url?: string } = {}) => {
        estadoMapa.sacadas.push(c as Capa);
        return mapa;
      },
      addLayer: () => mapa,
      panTo: vi.fn(),
      flyTo: vi.fn(),
      invalidateSize: vi.fn(),
      fitBounds: (limites: { puntos?: unknown[] }) => {
        estadoMapa.encuadres.push(limites.puntos ?? []);
        return mapa;
      },
      getZoom: () => 16,
      getPane: () => document.createElement('div'),
      attributionControl: {
        setPrefix: vi.fn(),
        getContainer: () => document.createElement('div'),
      },
    };
    estadoMapa.mapasCreados += 1;
    return mapa;
  }

  function grupo() {
    const g = {
      clearLayers: vi.fn(),
      addLayer: () => g,
      addTo: () => g,
      remove: vi.fn(),
    };
    return g;
  }

  const control = { addTo: vi.fn(), onAdd: () => document.createElement('div') };

  const L = {
    map: () => crearMapa(),
    tileLayer: (url: string, opciones?: Record<string, unknown>) => capa('tileLayer', url, undefined, opciones),
    layerGroup: () => grupo(),
    marker: (latlng: unknown, opciones?: Record<string, unknown>) => capa('marker', undefined, latlng, opciones),
    circle: (latlng: unknown, opciones?: Record<string, unknown>) => capa('circle', undefined, latlng, opciones),
    circleMarker: (latlng: unknown, opciones?: Record<string, unknown>) =>
      capa('circleMarker', undefined, latlng, opciones),
    polyline: (puntos: unknown, opciones?: Record<string, unknown>) => capa('polyline', undefined, puntos, opciones),
    polygon: (puntos: unknown, opciones?: Record<string, unknown>) => capa('polygon', undefined, puntos, opciones),
    divIcon: (o: unknown) => ({ icono: o }),
    latLngBounds: (puntos?: unknown[]) => ({ puntos, pad: () => ({}) }),
    control: { zoom: () => control },
    Control: class {
      onAdd: (() => HTMLElement) | undefined;
      addTo() {
        return this;
      }
    },
    DomUtil: { create: (tag: string, clase?: string) => {
      const el = document.createElement(tag === 'div' ? 'div' : tag);
      if (clase) el.className = clase;
      return el;
    } },
    DomEvent: { disableClickPropagation: vi.fn(), disableScrollPropagation: vi.fn(), on: vi.fn() },
  };

  return { default: L };
}
