import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { formatDistance, initials, waypointLabel } from '../format';
import type { Base, DroneStatus, PatrolRoute } from '../types';

export interface MapItem {
  droneId: string;
  displayName: string;
  base: Base | null;
  /** null si el dron no está reportando posición (offline) */
  status: DroneStatus | null;
}

/**
 * Nodos de la ruta que se dibujan en la vista de detalle: en rojo óxido
 * mientras están pendientes y en verde oliva una vez que el dron pasó por
 * ellos. Al clickearlos se ve el número de nodo y se les puede poner un apodo.
 */
export interface WaypointsLayer {
  route: PatrolRoute;
  visitedIndex: number;
  /** Ruta elegida pero todavía no ordenada: sus nodos van en otro color. */
  preview?: boolean;
  onLabel: (index: number, label: string) => void;
  /** Mostrar "Forzar ruta" en el popup (requiere autorización de control). */
  canForce?: boolean;
  /** Mostrar "Continuar desde acá" (solo con el patrullaje interrumpido). */
  canContinue?: boolean;
  onForce?: (index: number) => void;
  onContinue?: (index: number) => void;
}

/* Leaflet pinta sus capas con colores pasados por JS, no con CSS: por eso la
   paleta se repite acá. Son los mismos valores que los tokens de tokens.css. */
const PALETA = {
  marfil: '#FBFAF7', // --marmol-0
  tinta: '#2B2620', // --tinta
  tintaMedia: '#5C544A', // --tinta-media
  oroClaro: '#F0E3B8',
  oroMedio: '#D9BE6B',
  oro: '#B8912F', // --oro
  oroOscuro: '#8A6A1C', // --oro-oscuro
  oliva: '#4F7A46', // --ok
  oxido: '#9C3B30', // --peligro
  info: '#3D6076', // --info
} as const;

/* El mapa se deja con sus colores propios: lavarlo a marfil lo volvía lindo y
   difícil de leer, y un mapa es una herramienta de orientación antes que una
   superficie decorativa. Los marcadores sí siguen la estética, que es lo que
   distingue a esta consola de cualquier mapa web.
   En modo oscuro se atenúa apenas: una lámina blanca a pantalla completa en
   una guardia nocturna encandila. */
const ATENUAR_OSCURO = 'brightness(.82) contrast(1.04)';

function filtroDeTeselas(): string {
  return document.documentElement.dataset.tema === 'oscuro' ? ATENUAR_OSCURO : 'none';
}

const WP_PENDIENTE = PALETA.oxido;
/* Los nodos de una ruta elegida pero todavía no ordenada: se ven, se pueden
   inspeccionar, y no se confunden con los de un patrullaje en curso. */
const WP_PREVIO = PALETA.info;
const WP_VISITADO = PALETA.oliva;
const WP_STYLE: L.CircleMarkerOptions = { radius: 7, color: PALETA.marfil, weight: 2, fillOpacity: 1 };

interface Layers {
  base?: L.Marker;
  drone?: L.Marker;
  line?: L.Polyline;
  cone?: L.Polygon;
  iconName?: string;
}

// Cono semitransparente que muestra hacia dónde mira la cámara del dron
const CONE_RADIUS_M = 90;
const CONE_APERTURE = 40; // grados
const METERS_LAT = 111_320;

function coneLatLngs(lat: number, lon: number, heading: number): L.LatLngTuple[] {
  const points: L.LatLngTuple[] = [[lat, lon]];
  for (let a = heading - CONE_APERTURE / 2; a <= heading + CONE_APERTURE / 2; a += 5) {
    const rad = (a * Math.PI) / 180;
    points.push([
      lat + (CONE_RADIUS_M * Math.cos(rad)) / METERS_LAT,
      lon + (CONE_RADIUS_M * Math.sin(rad)) / (METERS_LAT * Math.cos((lat * Math.PI) / 180)),
    ]);
  }
  return points;
}

const CONE_STYLE: L.PolylineOptions = {
  color: PALETA.oro,
  weight: 1,
  opacity: 0.5,
  fillColor: PALETA.oro,
  fillOpacity: 0.13,
  interactive: false,
};

// En tierra no hay cámara que mostrar
const EN_TIERRA = ['IDLE', 'LANDED'];

const CENTER: L.LatLngTuple = [-34.8575, -56.2045];
// Hilo grabado entre el dron y su base: es una referencia, no un dato de vuelo,
// así que va en tinta apagada y no compite con los nodos ni con el medallón.
const LINE_STYLE: L.PolylineOptions = {
  color: PALETA.tintaMedia,
  weight: 1.5,
  opacity: 0.55,
  dashArray: '2 7',
  interactive: false,
};

function esc(text: string): string {
  return text.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/* --- Marcadores: SVG inline, sin depender de hojas de estilo ------------- */

// Cada medallón trae su propio degradé, así que necesita un id único
let secuenciaLamina = 0;

/**
 * El dron es lo único de oro macizo del mapa: un medallón de lámina dorada con
 * las iniciales grabadas y una punta que marca la posición exacta.
 */
function droneIcon(name: string): L.DivIcon {
  const id = `lamina-${++secuenciaLamina}`;
  return L.divIcon({
    className: 'drone-pin-icon',
    html: `<svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${PALETA.oroClaro}"/>
          <stop offset=".28" stop-color="${PALETA.oroMedio}"/>
          <stop offset=".55" stop-color="${PALETA.oro}"/>
          <stop offset="1" stop-color="${PALETA.oroOscuro}"/>
        </linearGradient>
      </defs>
      <path d="M17 40.6 11.7 28.4h10.6z" fill="url(#${id})" stroke="${PALETA.marfil}" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="17" cy="16.6" r="13" fill="url(#${id})" stroke="${PALETA.marfil}" stroke-width="2"/>
      <text x="17" y="21" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="${PALETA.tinta}">${esc(initials(name))}</text>
    </svg>`,
    iconSize: [34, 42],
    iconAnchor: [17, 40],
    popupAnchor: [0, -36],
  });
}

// La base es piedra tallada: un rombo de tinta con el reborde marfil
const BASE_ICON = L.divIcon({
  className: 'base-icon',
  html: `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
      <path d="M11 1.4 20.6 11 11 20.6 1.4 11z" fill="${PALETA.marfil}" stroke="${PALETA.tinta}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M11 6.6 15.4 11 11 15.4 6.6 11z" fill="${PALETA.tinta}"/>
    </svg>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  popupAnchor: [0, -12],
});

/* --- Globos y etiquetas --------------------------------------------------- */

function ficha(filas: [string, string][]): string {
  const cuerpo = filas.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  return `<hr class="regla" style="margin:var(--e-3) 0"><dl class="datos">${cuerpo}</dl>`;
}

function titulo(etiqueta: string, nombre: string): string {
  return `<span class="etiqueta">${etiqueta}</span>
    <h4 style="font-size:var(--txt-md)">${esc(nombre)}</h4>`;
}

function dronePopup(item: MapItem): string {
  const s = item.status!;
  return (
    titulo('Dron', item.displayName) +
    ficha([
      ['Batería', `${s.battery.toFixed(0)}&#8239;%`],
      ['Señal', `${s.signalPct}&#8239;%`],
      ['Nodo', waypointLabel(s)],
    ])
  );
}

function basePopup(item: MapItem): string {
  const s = item.status;
  const sinDatos = '<span class="muted">sin datos</span>';
  return (
    titulo('Base', item.base!.name) +
    ficha([
      ['Dron', esc(item.displayName)],
      ['Batería', s ? `${s.battery.toFixed(0)}&#8239;%` : sinDatos],
      ['Señal', s ? `${s.signalPct}&#8239;%` : sinDatos],
      ['Nodo', s ? waypointLabel(s) : sinDatos],
    ])
  );
}

/** Lo que se ve al pasar el mouse por encima del nodo. */
function waypointTooltip(index: number, label?: string): string {
  return esc(label || `Nodo ${index + 1}`);
}

// Lápiz de trazo: el tema no admite glifos sueltos, no siguen el peso del dibujo
const LAPIZ = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block" aria-hidden="true">
    <path d="M11.9 2.6 13.4 4.1 5 12.5 2.9 13.1 3.5 11z"/><path d="M10.4 4.1 11.9 5.6"/></svg>`;

/**
 * El popup arranca mostrando el apodo; el lápiz de la esquina alterna al modo
 * edición. `data-label` guarda el valor original para poder descartar cambios.
 */
function waypointPopup(
  index: number,
  total: number,
  label: string | undefined,
  canForce: boolean,
  canContinue: boolean,
): string {
  const acciones =
    (canForce ? '<button class="wp-force" type="button">Forzar ruta</button>' : '') +
    (canContinue ? '<button class="wp-continue" type="button">Continuar desde acá</button>' : '');
  return `<div class="wp-popup" data-label="${esc(label ?? '')}">
      <span class="etiqueta">Nodo ${index + 1} de ${total}</span>
      <div class="wp-nombre">${
        label ? `<h4 style="font-size:var(--txt-md)">${esc(label)}</h4>` : '<span class="muted">Sin apodo</span>'
      }</div>
      <div class="wp-form">
        <input class="wp-alias" maxlength="40" placeholder="Apodo del nodo" value="${esc(label ?? '')}">
        <button class="wp-save" type="button">Guardar</button>
      </div>
      ${acciones ? `<div class="wp-acciones">${acciones}</div>` : ''}
      <button class="wp-edit" type="button" title="Editar apodo" aria-label="Editar apodo">${LAPIZ}</button>
    </div>`;
}

function setPopup(marker: L.Marker, html: string) {
  if (marker.getPopup()) marker.setPopupContent(html);
  else marker.bindPopup(html, { autoPan: false });
}

/* --- Vestir el mobiliario de Leaflet -------------------------------------- */
/* Leaflet inyecta sus controles, globos y etiquetas fuera del alcance de las
   hojas de la consola (son nodos suyos, con sus clases y sus grises de
   fábrica). Se los viste acá, con los mismos tokens, para que el mapa no
   desentone con la piedra. */

function vestir(el: HTMLElement | null | undefined, estilos: Record<string, string>) {
  if (!el) return;
  for (const [prop, valor] of Object.entries(estilos)) el.style.setProperty(prop, valor);
}

const SVG_CRUZ = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" style="display:block" aria-hidden="true">
    <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8"/></svg>`;

function vestirGlobo(popup: L.Popup) {
  const el = popup.getElement();
  if (!el) return;
  vestir(el.querySelector<HTMLElement>('.leaflet-popup-content-wrapper'), {
    background: 'var(--marmol-0)',
    color: 'var(--tinta)',
    border: '1px solid var(--veta)',
    'border-radius': 'var(--radio)',
    'box-shadow': 'var(--sombra-flotante)',
  });
  vestir(el.querySelector<HTMLElement>('.leaflet-popup-content'), {
    margin: 'var(--e-4)',
    'line-height': 'var(--interlinea)',
  });
  vestir(el.querySelector<HTMLElement>('.leaflet-popup-tip'), {
    background: 'var(--marmol-0)',
    'box-shadow': 'none',
  });
  const cerrar = el.querySelector<HTMLElement>('.leaflet-popup-close-button');
  vestir(cerrar, { color: 'var(--tinta-suave)', display: 'grid', 'place-items': 'center' });
  // Leaflet cierra con un "×" de texto y un rótulo en inglés: los dos se cambian
  if (cerrar && !cerrar.querySelector('svg')) {
    cerrar.setAttribute('aria-label', 'Cerrar');
    cerrar.innerHTML = SVG_CRUZ;
  }
}

function vestirEtiqueta(tooltip: L.Tooltip) {
  vestir(tooltip.getElement(), {
    background: 'var(--marmol-0)',
    border: '1px solid var(--veta)',
    'border-radius': 'var(--radio-chico)',
    color: 'var(--tinta)',
    'box-shadow': 'var(--sombra-suave)',
    padding: '3px 9px',
    'font-size': 'var(--txt-xs)',
    'font-weight': '600',
    'letter-spacing': 'var(--versalita)',
    'text-transform': 'uppercase',
  });
}

const SVG_MAS =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.6v10.8M4.6 10h10.8" stroke-linecap="round"/></svg>';
const SVG_MENOS = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.6 10h10.8" stroke-linecap="round"/></svg>';

function botonMapa(etiqueta: string, svg: string, alClickear: () => void): HTMLButtonElement {
  const b = L.DomUtil.create('button', 'icono-boton') as HTMLButtonElement;
  b.type = 'button';
  b.title = etiqueta;
  b.setAttribute('aria-label', etiqueta);
  b.innerHTML = svg;
  L.DomEvent.on(b, 'click', (ev) => {
    L.DomEvent.stop(ev);
    alClickear();
  });
  return b;
}

/** Reemplazo del control de zoom de fábrica por dos botones de mármol. */
function controlZoom(map: L.Map): L.Control {
  const control = new L.Control({ position: 'topleft' });
  control.onAdd = () => {
    const caja = L.DomUtil.create('div', 'leaflet-control');
    vestir(caja, { display: 'flex', 'flex-direction': 'column', gap: 'var(--e-2)' });
    caja.appendChild(botonMapa('Acercar', SVG_MAS, () => map.zoomIn()));
    caja.appendChild(botonMapa('Alejar', SVG_MENOS, () => map.zoomOut()));
    L.DomEvent.disableClickPropagation(caja);
    L.DomEvent.disableScrollPropagation(caja);
    return caja;
  };
  return control;
}

/**
 * Mapa de drones y bases. Con `alwaysShowLine` la línea punteada dron↔base
 * está siempre visible (vista de detalle); si no, solo aparece mientras esté
 * abierto el popup de ese dron o de su base.
 */
export default function DronesMap({
  items,
  alwaysShowLine = false,
  waypoints = null,
}: {
  items: MapItem[];
  alwaysShowLine?: boolean;
  waypoints?: WaypointsLayer | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef(new Map<string, Layers>());
  const openIdRef = useRef<string | null>(null);
  const alwaysRef = useRef(alwaysShowLine);
  alwaysRef.current = alwaysShowLine;
  const fittedRef = useRef(false);
  const wpMarkersRef = useRef<L.CircleMarker[]>([]);
  const wpRouteIdRef = useRef<number | null>(null);
  // En una ref para que los handlers de leaflet no queden con una versión vieja
  const onLabelRef = useRef(waypoints?.onLabel);
  onLabelRef.current = waypoints?.onLabel;
  const wpActionsRef = useRef({ onForce: waypoints?.onForce, onContinue: waypoints?.onContinue });
  wpActionsRef.current = { onForce: waypoints?.onForce, onContinue: waypoints?.onContinue };

  // Solo lee refs, así los handlers de leaflet pueden llamarla sin recrearse.
  const applyLines = () => {
    const map = mapRef.current;
    if (!map) return;
    for (const [id, l] of layersRef.current) {
      if (!l.line) continue;
      if (alwaysRef.current || openIdRef.current === id) l.line.addTo(map);
      else l.line.remove();
    }
  };

  const trackPopup = (marker: L.Marker, droneId: string) => {
    marker.on('popupopen', () => {
      openIdRef.current = droneId;
      applyLines();
    });
    marker.on('popupclose', () => {
      if (openIdRef.current !== droneId) return;
      openIdRef.current = null;
      applyLines();
    });
  };

  useEffect(() => {
    const map = L.map(containerRef.current!, { zoomControl: false }).setView(CENTER, 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    vestir(map.getPane('tilePane'), { filter: filtroDeTeselas() });
    // Sin la banderita de fábrica: es lo único de color frío que quedaba
    map.attributionControl.setPrefix('Leaflet');
    vestir(map.attributionControl.getContainer(), {
      background: 'var(--marmol-0)',
      color: 'var(--tinta-media)',
      'font-size': 'var(--txt-xxs)',
      padding: '2px 8px',
      'border-top': '1px solid var(--veta)',
      'border-left': '1px solid var(--veta)',
      'border-top-left-radius': 'var(--radio-chico)',
    });
    controlZoom(map).addTo(map);
    // Un solo par de handlers alcanza: valen para cualquier globo o etiqueta
    map.on('popupopen', (e) => vestirGlobo(e.popup));
    map.on('tooltipopen', (e) => vestirEtiqueta(e.tooltip));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current.clear();
      // Los marcadores quedaron atados al mapa que se acaba de destruir: si no
      // se olvidan acá, al volver a montar se creen vigentes y no se redibujan.
      wpMarkersRef.current = [];
      wpRouteIdRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layers = layersRef.current;

    for (const item of items) {
      let l = layers.get(item.droneId);
      if (!l) {
        l = {};
        layers.set(item.droneId, l);
      }

      if (item.base) {
        const basePos: L.LatLngTuple = [item.base.lat, item.base.lon];
        if (!l.base) {
          l.base = L.marker(basePos, { icon: BASE_ICON }).addTo(map);
          trackPopup(l.base, item.droneId);
        } else {
          l.base.setLatLng(basePos);
        }
        setPopup(l.base, basePopup(item));
      }

      if (!item.status) {
        l.drone?.remove();
        l.line?.remove();
        l.cone?.remove();
        l.drone = undefined;
        l.line = undefined;
        l.cone = undefined;
        continue;
      }

      const dronePos: L.LatLngTuple = [item.status.lat, item.status.lon];

      // Cono de visión de la cámara
      const heading = item.status.heading;
      if (typeof heading === 'number' && !EN_TIERRA.includes(item.status.state)) {
        const pts = coneLatLngs(item.status.lat, item.status.lon, heading);
        if (!l.cone) l.cone = L.polygon(pts, CONE_STYLE).addTo(map);
        else l.cone.setLatLngs(pts);
      } else if (l.cone) {
        l.cone.remove();
        l.cone = undefined;
      }
      if (!l.drone) {
        l.drone = L.marker(dronePos, { icon: droneIcon(item.displayName) }).addTo(map);
        l.iconName = item.displayName;
        trackPopup(l.drone, item.droneId);
      } else {
        l.drone.setLatLng(dronePos);
        if (l.iconName !== item.displayName) {
          l.drone.setIcon(droneIcon(item.displayName));
          l.iconName = item.displayName;
        }
      }
      setPopup(l.drone, dronePopup(item));

      if (!item.base) continue;
      const points: L.LatLngTuple[] = [dronePos, [item.base.lat, item.base.lon]];
      if (!l.line) l.line = L.polyline(points, LINE_STYLE);
      else l.line.setLatLngs(points);

      if (alwaysShowLine) {
        const text = formatDistance(map.distance(points[0], points[1]));
        const tooltip = l.line.getTooltip();
        if (!tooltip) {
          l.line.bindTooltip(text, { permanent: true, direction: 'center', className: 'distance-tooltip' });
        } else {
          // La etiqueta no sigue sola a la línea: hay que recolocarla en el medio.
          tooltip.setContent(text);
          tooltip.setLatLng([(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2]);
        }
      }
    }

    for (const [id, l] of layers) {
      if (items.some((i) => i.droneId === id)) continue;
      l.base?.remove();
      l.drone?.remove();
      l.line?.remove();
      l.cone?.remove();
      layers.delete(id);
    }

    applyLines();

    // Encuadre inicial una sola vez, para no pelear con el zoom del operador.
    if (!fittedRef.current) {
      const points: L.LatLngTuple[] = [];
      for (const item of items) {
        if (item.base) points.push([item.base.lat, item.base.lon]);
        if (item.status) points.push([item.status.lat, item.status.lon]);
      }
      if (points.length > 0) {
        map.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 16 });
        fittedRef.current = true;
      }
    }
  }, [items, alwaysShowLine]);

  // Nodos de la ruta (solo la vista de detalle los pasa)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const wps = waypoints?.route.waypoints ?? [];
    const routeId = waypoints?.route.id ?? null;

    // Los marcadores se recrean solo al cambiar de ruta; después se actualizan
    // en el lugar, para no cerrar un popup que el operador esté usando.
    if (wpRouteIdRef.current !== routeId || wpMarkersRef.current.length !== wps.length) {
      for (const m of wpMarkersRef.current) m.remove();
      wpMarkersRef.current = wps.map((wp, i) => {
        const marker = L.circleMarker([wp.lat, wp.lon], WP_STYLE).addTo(map);
        marker.bindPopup('', { autoPan: false });
        marker.bindTooltip('', { direction: 'top', offset: [0, -8] });
        marker.on('popupopen', () => wireWaypointForm(marker, i));
        return marker;
      });
      wpRouteIdRef.current = routeId;
    }

    wps.forEach((wp, i) => {
      const marker = wpMarkersRef.current[i];
      if (!marker) return;
      marker.setLatLng([wp.lat, wp.lon]);
      const color = waypoints?.preview
        ? WP_PREVIO
        : i <= (waypoints?.visitedIndex ?? -1)
          ? WP_VISITADO
          : WP_PENDIENTE;
      marker.setStyle({ fillColor: color });
      marker.setTooltipContent(waypointTooltip(i, wp.label));
      // Si está abierto no se toca: reemplazar el HTML borraría lo que se esté tipeando
      if (!marker.isPopupOpen()) {
        marker.setPopupContent(waypointPopup(i, wps.length, wp.label, !!waypoints?.canForce, !!waypoints?.canContinue));
      }
    });
  }, [waypoints]);

  function wireWaypointForm(marker: L.CircleMarker, index: number) {
    const el = marker.getPopup()?.getElement();
    const root = el?.querySelector<HTMLElement>('.wp-popup');
    const input = el?.querySelector<HTMLInputElement>('.wp-alias');
    const guardarBtn = el?.querySelector<HTMLButtonElement>('.wp-save');
    const lapiz = el?.querySelector<HTMLButtonElement>('.wp-edit');
    if (!root || !input || !guardarBtn || !lapiz) return;

    // El popup siempre se abre en modo lectura, aunque quede reutilizado.
    // (Ojo: no llamar a popup.update() acá; re-renderiza el HTML y se pierden
    // estos handlers. El ancho lo fija .wp-popup por CSS para los dos modos.)
    const descartar = () => {
      root.classList.remove('editando');
      input.value = root.dataset.label ?? '';
    };
    descartar();

    // El lápiz abre la edición y, apretado de nuevo, la cancela
    lapiz.onclick = () => {
      if (root.classList.contains('editando')) {
        descartar();
        return;
      }
      root.classList.add('editando');
      input.focus();
      input.select();
    };

    const guardar = () => {
      onLabelRef.current?.(index, input.value.trim());
      marker.closePopup();
    };
    guardarBtn.onclick = guardar;
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') guardar();
      if (ev.key === 'Escape') descartar();
    };

    // Acciones de vuelo sobre el nodo
    const force = el?.querySelector<HTMLButtonElement>('.wp-force');
    if (force) force.onclick = () => { wpActionsRef.current.onForce?.(index); marker.closePopup(); };
    const cont = el?.querySelector<HTMLButtonElement>('.wp-continue');
    if (cont) cont.onclick = () => { wpActionsRef.current.onContinue?.(index); marker.closePopup(); };
  }

  return <div className="map" ref={containerRef} />;
}
