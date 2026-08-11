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
 * Nodos de la ruta que se dibujan en la vista de detalle: rojos mientras están
 * pendientes y verdes una vez que el dron pasó por ellos. Al clickearlos se ve
 * el número de nodo y se les puede poner un apodo.
 */
export interface WaypointsLayer {
  route: PatrolRoute;
  visitedIndex: number;
  onLabel: (index: number, label: string) => void;
  /** Mostrar "Forzar ruta" en el popup (requiere autorización de control). */
  canForce?: boolean;
  /** Mostrar "Continuar desde acá" (solo con el patrullaje interrumpido). */
  canContinue?: boolean;
  onForce?: (index: number) => void;
  onContinue?: (index: number) => void;
}

const WP_PENDIENTE = '#e03131';
const WP_VISITADO = '#2f9e44';
const WP_STYLE: L.CircleMarkerOptions = { radius: 7, color: '#ffffff', weight: 2, fillOpacity: 1 };

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

// En tierra no hay cámara que mostrar
const EN_TIERRA = ['IDLE', 'LANDED'];

const CENTER: L.LatLngTuple = [-34.8575, -56.2045];
const LINE_STYLE: L.PolylineOptions = {
  color: '#e03131',
  weight: 2,
  dashArray: '6 6',
  interactive: false,
};

function esc(text: string): string {
  return text.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function droneIcon(name: string): L.DivIcon {
  return L.divIcon({
    className: 'drone-pin-icon',
    html: `<div class="drone-pin"><span>${esc(initials(name))}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 34],
    popupAnchor: [0, -34],
  });
}

const BASE_ICON = L.divIcon({
  className: 'base-icon',
  html: '<div class="base-square"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
  popupAnchor: [0, -10],
});

function dronePopup(item: MapItem): string {
  const s = item.status!;
  return `<strong>${esc(item.displayName)}</strong>
    <div>Batería: ${s.battery.toFixed(0)}%</div>
    <div>Señal: ${s.signalPct}%</div>
    <div>Nodo: ${waypointLabel(s)}</div>`;
}

function basePopup(item: MapItem): string {
  const s = item.status;
  return `<strong>${esc(item.base!.name)}</strong>
    <div>Dron: ${esc(item.displayName)}</div>
    <div>Batería: ${s ? `${s.battery.toFixed(0)}%` : 'sin datos'}</div>
    <div>Señal: ${s ? `${s.signalPct}%` : 'sin datos'}</div>
    <div>Nodo: ${s ? waypointLabel(s) : 'sin datos'}</div>`;
}

/** Lo que se ve al pasar el mouse por encima del nodo. */
function waypointTooltip(index: number, label?: string): string {
  return esc(label || `Nodo ${index + 1}`);
}

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
      <strong>Nodo ${index + 1} de ${total}</strong>
      <div class="wp-nombre">${label ? esc(label) : '<span class="muted">Sin apodo</span>'}</div>
      <div class="wp-form">
        <input class="wp-alias" maxlength="40" placeholder="Apodo del nodo" value="${esc(label ?? '')}">
        <button class="wp-save" type="button">Guardar</button>
      </div>
      ${acciones ? `<div class="wp-acciones">${acciones}</div>` : ''}
      <button class="wp-edit" type="button" title="Editar apodo" aria-label="Editar apodo">✎</button>
    </div>`;
}

function setPopup(marker: L.Marker, html: string) {
  if (marker.getPopup()) marker.setPopupContent(html);
  else marker.bindPopup(html, { autoPan: false });
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
    const map = L.map(containerRef.current!).setView(CENTER, 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
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
        if (!l.cone) {
          l.cone = L.polygon(pts, {
            color: '#4da3ff',
            weight: 1,
            opacity: 0.4,
            fillColor: '#4da3ff',
            fillOpacity: 0.15,
            interactive: false,
          }).addTo(map);
        } else {
          l.cone.setLatLngs(pts);
        }
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
      marker.setStyle({ fillColor: i <= (waypoints?.visitedIndex ?? -1) ? WP_VISITADO : WP_PENDIENTE });
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
