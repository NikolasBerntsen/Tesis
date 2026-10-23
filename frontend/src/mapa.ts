import L from 'leaflet';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { initials } from './format';
import { esc } from './html';
import type { ObjetivoEnSeguimiento } from './types';

/**
 * Lo que todos los mapas de la consola tienen en común. Vive acá y no copiado
 * en cada vista porque ya pasó dos veces: se agregó el fondo satelital sólo en
 * el mapa de la flota, y el ícono de la base se dibujó distinto en el elector
 * de coordenadas —donde en modo oscuro quedaba blanco y se perdía—. Un mapa que
 * se comporta distinto que el de al lado es un mapa que hay que volver a
 * aprender.
 */

/**
 * El Obelisco, sobre la 9 de Julio. Es el centro por defecto de todo mapa que
 * todavía no tiene nada que mostrar: abrir un mapa y tener que arrastrarlo
 * hasta la ciudad antes de empezar a trabajar es tiempo perdido en cada uso.
 */
export const CENTRO_POR_DEFECTO: L.LatLngTuple = [-34.6037, -58.3816];

/** Fondo del mapa: callejero o imagen satelital. */
export type Fondo = 'mapa' | 'satelite';

export const FONDOS: readonly Fondo[] = ['mapa', 'satelite'];

export function nombreDeFondo(f: Fondo): string {
  return f === 'mapa' ? 'Mapa' : 'Satélite';
}

/* El callejero se deja con sus colores propios en mármol: lavarlo a marfil lo
   volvía lindo y difícil de leer, y un mapa es una herramienta de orientación
   antes que una superficie decorativa. En obsidiana, en cambio, una lámina
   blanca a pantalla completa en una guardia nocturna encandila, así que se
   oscurece. Eso lo hace el CSS (vistas.css, con el token --filtro-calles) a
   partir de esta clase, que va SÓLO en la capa de calles:
   - el satélite es una foto y no se toca;
   - los marcadores, los trazos y los globos viven en otros panes de Leaflet y
     no heredan el filtro;
   - y como es CSS, cambiar de tema con el mapa abierto lo oscurece en el acto.
     Antes el filtro se escribía inline al crear el mapa, sobre el pane entero
     (satélite incluido), y no se enteraba de un cambio de tema posterior. */
export const CLASE_TESELAS_CALLES = 'teselas-calles';
export const CLASE_TESELAS_SATELITE = 'teselas-satelite';

/**
 * Clases de los trazos oscuros que Leaflet dibuja encima de las teselas. El
 * color va en el JS (Leaflet lo escribe como atributo del SVG) y queda de
 * respaldo; el CSS de vistas.css le gana con un token del tema. Sin esto, en
 * obsidiana el hilo pardo del dron a su base y el filo negro de los nodos se
 * perdían sobre el callejero oscurecido.
 */
export const TRAZO = {
  /** El hilo punteado entre el dron y su base. */
  hilo: 'mapa-hilo',
  /** La línea que une los nodos de una ruta. */
  recorrido: 'mapa-recorrido',
  /** El filo de cada nodo de una ruta. */
  nodo: 'mapa-nodo',
  /** El hilo del dron a su objetivo y el rastro del objetivo, con la alerta esperando. */
  objetivoPendiente: 'mapa-objetivo-pendiente',
  /** Lo mismo, una vez validada la alerta. */
  objetivoValidado: 'mapa-objetivo-validado',
} as const;

/**
 * Con qué opacidad dibuja Leaflet cada trazo. La escribe como stroke-opacity
 * y el CSS del tema no la toca, así que lo que se ve es el token mezclado con
 * el mapa a esta opacidad: así lo mide teselas.test.ts. El hilo a la base iba
 * al 0,55 y en mármol quedaba en 2,2 contra los edificios; el rastro, al 0,6,
 * en 1,7 sobre el callejero de noche. Los trazos del editor de rutas no fijan
 * opacidad: Leaflet los dibuja opacos.
 */
export const OPACIDAD_TRAZO = {
  hilo: 0.8,
  hiloObjetivo: 0.85,
  rastroObjetivo: 0.75,
} as const;

/** Aplica estilos inline a un nodo que Leaflet crea por su cuenta. */
export function vestir(el: HTMLElement | null | undefined, estilos: Record<string, string>) {
  if (!el) return;
  for (const [prop, valor] of Object.entries(estilos)) el.style.setProperty(prop, valor);
}

/**
 * Los dos fondos: el callejero para ubicarse por calles y el satelital para
 * reconocer el terreno real —techos, arboledas, tinglados— que es lo que hace
 * falta al decidir dónde poner un nodo de patrullaje.
 */
export function crearFondos(): Record<Fondo, L.TileLayer> {
  return {
    mapa: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
      className: CLASE_TESELAS_CALLES,
    }),
    satelite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Imágenes &copy; Esri', className: CLASE_TESELAS_SATELITE },
    ),
  };
}

/** Deja en el mapa el fondo elegido y saca el otro. */
export function aplicarFondo(mapa: L.Map, capas: Record<Fondo, L.TileLayer>, fondo: Fondo) {
  for (const nombre of FONDOS) {
    if (nombre === fondo) capas[nombre].addTo(mapa);
    else mapa.removeLayer(capas[nombre]);
  }
}

/** La banderita de fábrica es lo único de color frío que quedaría en la piedra. */
export function vestirAtribucion(mapa: L.Map, prefijo = 'Leaflet') {
  mapa.attributionControl.setPrefix(prefijo);
  vestir(mapa.attributionControl.getContainer(), {
    background: 'var(--marmol-0)',
    color: 'var(--tinta-media)',
    'font-size': 'var(--txt-xxs)',
    padding: '2px 8px',
    'border-top': '1px solid var(--veta)',
    'border-left': '1px solid var(--veta)',
    'border-top-left-radius': 'var(--radio-chico)',
  });
}

/* El par negro/ámbar es el de mayor contraste que existe y se distingue sobre
   cualquier fondo —callejero, satelital, claro u oscuro—, que es lo único que
   se le pide a un punto de retorno. Van los valores crudos y no los tokens del
   tema a propósito: con `var(--tinta)` el rombo se daba vuelta en modo oscuro
   y quedaba blanco sobre el fondo claro del mapa. */
const NEGRO = '#14120F';
const AMBAR = '#F2C230';

const ROMBO = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 1.2 22.8 12 12 22.8 1.2 12z" fill="${NEGRO}" stroke="${AMBAR}" stroke-width="2" stroke-linejoin="round"/>
      <path d="M12 6.6 17.4 12 12 17.4 6.6 12z" fill="${AMBAR}"/>
    </svg>`;

/**
 * La etiqueta fija de un nodo de ruta: su número y, si tiene, su apodo
 * ("2 · Portón"). Sale ya escapada, lista para `bindTooltip`: Leaflet pinta el
 * texto de una etiqueta con innerHTML, y el apodo lo escribe un operador y lo
 * mira cualquiera que abra la ruta (ver html.ts). La comparten el catálogo de
 * rutas y el editor, que es donde se veían los apodos crudos.
 */
export function etiquetaDeNodo(indice: number, apodo?: string): string {
  return esc(`${indice + 1}${apodo ? ` · ${apodo}` : ''}`);
}

let rombo: L.DivIcon | null = null;

/** El rombo negro y ámbar de una base. Se arma una sola vez y se comparte. */
export function iconoBase(): L.DivIcon {
  if (!rombo) {
    rombo = L.divIcon({
      className: 'base-icon',
      html: ROMBO,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -13],
    });
  }
  return rombo;
}

/* --- Marcadores del dron, del objetivo y de la detección -------------------
   Los dibujan el mapa de la flota (DronesMap) y el del pop-up de una alerta
   (MapaDeAlerta). Vivían en DronesMap, y el pop-up habría tenido que copiarlos
   o pintar otro dron: un marcador que cambia de cara de un mapa a otro es un
   marcador que hay que volver a aprender. */

/* Leaflet pinta sus capas con colores pasados por JS, no con CSS: por eso la
   paleta se repite acá. Los que llevan un token al lado son los valores de
   mármol de ese token, y teselas.test.ts los compara con tokens.css: el óxido
   y el azul se habían quedado en los de antes de que el tema los ajustara.
   Los trazos que van sobre las teselas, además, llevan una clase de TRAZO
   para que el CSS les ponga el color del tema; el de acá queda de respaldo. */
export const PALETA = {
  // El halo de los marcadores: un marfil casi blanco, más claro que la piedra
  // de la página, para que el marcador se despegue de cualquier tesela.
  marfil: '#FBFAF7',
  tinta: '#1C1914', // --tinta
  tintaMedia: '#463F33', // --tinta-media
  oroClaro: '#F3E6BE',
  oroMedio: '#DCC27A',
  oro: '#C39A45', // --oro
  oroOscuro: '#8A6A1C', // --oro-oscuro
  oliva: '#1F8A4C', // --ok
  oxido: '#A82D26', // --peligro
  info: '#1D5AA6', // --info
  negro: '#14120F',
  ambar: '#F2C230', // el par negro/ámbar es el de mayor contraste posible
} as const;

/* El color del objetivo dice qué se decidió y el trazo si se lo está viendo:
   rojo óxido mientras la alerta espera, oro una vez validada (el mismo oro del
   dron: "esto es nuestro"), y apagado y punteado si la detección lo perdió,
   porque lo que se ve es la última posición conocida y no una presencia. */
export interface AspectoObjetivo {
  color: string;
  /** La clase de TRAZO con que el CSS tiñe el hilo y el rastro según el tema. */
  trazo: string;
  perdido: boolean;
  /** Identifica el ícono: sólo se rehace cuando cambia. */
  clave: string;
}

export function aspectoDelObjetivo(o: ObjetivoEnSeguimiento): AspectoObjetivo {
  const validado = o.decision === 'VALIDATED';
  return {
    color: validado ? PALETA.oro : PALETA.oxido,
    trazo: validado ? TRAZO.objetivoValidado : TRAZO.objetivoPendiente,
    perdido: o.lost,
    clave: `${o.decision}-${o.lost}`,
  };
}

/** Una mira: se distingue del medallón del dron y del rombo de la base. */
export function iconoObjetivo(a: AspectoObjetivo): L.DivIcon {
  const trazo = a.perdido ? 'stroke-dasharray="3 3"' : '';
  return L.divIcon({
    className: 'objetivo-icon',
    html: `<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" opacity="${a.perdido ? 0.55 : 1}">
      <circle cx="14" cy="14" r="10" fill="${PALETA.marfil}" fill-opacity=".85" stroke="${a.color}" stroke-width="2.6" ${trazo}/>
      <path d="M14 1.5v6M14 20.5v6M1.5 14h6M20.5 14h6" stroke="${a.color}" stroke-width="2.2" stroke-linecap="round"/>
      <circle cx="14" cy="14" r="3.2" fill="${a.color}"/>
    </svg>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

// Cada medallón trae su propio degradé, así que necesita un id único
let secuenciaLamina = 0;

/**
 * El dron es lo único de oro macizo del mapa: un medallón de lámina dorada con
 * las iniciales grabadas y una punta que marca la posición exacta. Las
 * iniciales salen del nombre, que lo escribe un operador: van escapadas.
 */
export function droneIcon(name: string): L.DivIcon {
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

let gota: L.DivIcon | null = null;

/**
 * Dónde la detección vio al objetivo: una gota de óxido, el color de la alerta
 * que espera. Es un lugar fijo y no una presencia, por eso no es la mira del
 * objetivo (que se mueve con él) ni lleva el oro del dron.
 */
export function iconoDeDeteccion(): L.DivIcon {
  if (!gota) {
    gota = L.divIcon({
      className: 'deteccion-icon',
      html: `<svg width="26" height="32" viewBox="0 0 26 32" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 31 7.6 20.6h10.8z" fill="${PALETA.oxido}" stroke="${PALETA.marfil}" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="13" cy="12" r="9" fill="${PALETA.oxido}" stroke="${PALETA.marfil}" stroke-width="2"/>
      <circle cx="13" cy="12" r="3.2" fill="${PALETA.marfil}"/>
    </svg>`,
      iconSize: [26, 32],
      iconAnchor: [13, 30],
    });
  }
  return gota;
}

/**
 * Estado del conmutador atado a un mapa que ya existe.
 *
 * El mapa se crea en un efecto del componente y se guarda en una ref, así que
 * este hook tiene que declararse DESPUÉS de ese efecto: React corre los efectos
 * en el orden en que se declararon los hooks, y de esa forma la ref ya tiene el
 * mapa cuando este efecto pide las capas.
 */
export function useFondo(mapa: MutableRefObject<L.Map | null>) {
  const [fondo, setFondo] = useState<Fondo>('mapa');
  // Las capas quedan atadas al mapa que las recibió: si el componente rehace el
  // mapa, agregarle las viejas no dibujaría nada.
  const capas = useRef<{ de: L.Map; capas: Record<Fondo, L.TileLayer> } | null>(null);

  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (capas.current?.de !== m) capas.current = { de: m, capas: crearFondos() };
    aplicarFondo(m, capas.current.capas, fondo);
  }, [fondo]);

  return [fondo, setFondo] as const;
}
