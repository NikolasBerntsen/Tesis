import L from 'leaflet';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';

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
