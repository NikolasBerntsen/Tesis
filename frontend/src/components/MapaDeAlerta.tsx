import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { esc } from '../html';
import {
  CENTRO_POR_DEFECTO,
  aspectoDelObjetivo,
  droneIcon,
  iconoDeDeteccion,
  iconoObjetivo,
  useFondo,
  vestirAtribucion,
} from '../mapa';
import type { ObjetivoEnSeguimiento } from '../types';
import ConmutadorDeFondo from './ConmutadorDeFondo';

type Punto = [number, number];

/** Con un solo punto a la vista: la cuadra y las de alrededor. */
const ZOOM_DE_UN_PUNTO = 17;

/**
 * Aire alrededor de los puntos al encuadrarlos, para que ningún marcador quede
 * cortado en el borde. Arriba va más: el medallón del dron y la gota de la
 * detección se clavan en el punto por la punta y crecen hacia arriba.
 */
const MARGEN_ARRIBA_IZQUIERDA: L.PointTuple = [36, 52];
const MARGEN_ABAJO_DERECHA: L.PointTuple = [36, 20];

/**
 * El mapa del pop-up de una alerta: dónde la detección vio al objetivo y, si
 * el seguimiento sigue, dónde está el objetivo AHORA y dónde está el dron. Es
 * lo que el operador necesita para mandar gente: la detección es de hace un
 * rato, y la persona o el vehículo pudieron haberse movido.
 *
 * Los marcadores son los del mapa de la flota (mapa.ts): la mira del objetivo
 * en óxido o en oro según se haya validado, y el medallón del dron.
 */
export default function MapaDeAlerta({
  deteccion,
  objetivo,
  dron,
}: {
  deteccion: Punto | null;
  /** El objetivo en seguimiento de ESTA alerta (`status.target` con su `alertId`), o `null`. */
  objetivo: ObjetivoEnSeguimiento | null;
  /** El dron y su posición actual, o `null` si no la informa. */
  dron: { nombre: string; posicion: Punto } | null;
}) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const marcas = useRef<L.LayerGroup | null>(null);
  /** Qué puntos había la última vez que se encuadró (ver el efecto de abajo). */
  const encuadrados = useRef('');

  // El mapa se crea una sola vez: el pop-up se vuelve a pintar con cada tick
  // de status, y rehacerlo por render parpadea, pierde el arrastre y vuelve a
  // pedir todas las teselas. Arranca ya centrado: Leaflet no deja poner un
  // marcador en un mapa sin vista.
  useEffect(() => {
    let inicio: L.LatLngTuple = CENTRO_POR_DEFECTO;
    if (deteccion) inicio = deteccion;
    else if (objetivo) inicio = [objetivo.lat, objetivo.lon];
    else if (dron) inicio = dron.posicion;
    const m = L.map(contenedor.current!, {
      // El control de fábrica rotula en inglés; se lo pone aparte en castellano.
      zoomControl: false,
      // La rueda tiene que seguir scrolleando el pop-up: el zoom va por los botones.
      scrollWheelZoom: false,
    }).setView(inicio, ZOOM_DE_UN_PUNTO);
    L.control.zoom({ position: 'topleft', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(m);
    vestirAtribucion(m, '');
    marcas.current = L.layerGroup().addTo(m);
    mapa.current = m;

    // La caja del pop-up entra con una animación de escala: si Leaflet mide
    // mientras corre, calcula mal el tamaño y quedan teselas sin pedir.
    const remedir = globalThis.setTimeout(() => m.invalidateSize(), 250);
    return () => {
      globalThis.clearTimeout(remedir);
      m.remove();
      mapa.current = null;
      marcas.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Después del efecto que crea el mapa: los efectos corren en el orden en que
  // se declaran, y el fondo necesita el mapa ya hecho (ver useFondo).
  const [fondo, setFondo] = useFondo(mapa);

  // Las dependencias son números y textos, no los objetos: el status llega
  // nuevo cada segundo aunque el objetivo no se haya movido.
  const latDeteccion = deteccion?.[0];
  const lonDeteccion = deteccion?.[1];
  const latObjetivo = objetivo?.lat;
  const lonObjetivo = objetivo?.lon;
  const claveObjetivo = objetivo ? aspectoDelObjetivo(objetivo).clave : '';
  const nombreDron = dron?.nombre;
  const latDron = dron?.posicion[0];
  const lonDron = dron?.posicion[1];

  useEffect(() => {
    const m = mapa.current;
    const grupo = marcas.current;
    if (!m || !grupo) return;
    grupo.clearLayers();
    const puntos: Punto[] = [];
    if (deteccion) {
      L.marker(deteccion, { icon: iconoDeDeteccion(), keyboard: false }).bindTooltip('Detección').addTo(grupo);
      puntos.push(deteccion);
    }
    if (objetivo) {
      const punto: Punto = [objetivo.lat, objetivo.lon];
      L.marker(punto, { icon: iconoObjetivo(aspectoDelObjetivo(objetivo)), keyboard: false })
        .bindTooltip('Objetivo ahora')
        .addTo(grupo);
      puntos.push(punto);
    }
    if (dron) {
      // Leaflet pinta la etiqueta con innerHTML, y el nombre lo escribe un
      // operador (ver html.ts).
      L.marker(dron.posicion, { icon: droneIcon(dron.nombre), keyboard: false }).bindTooltip(esc(dron.nombre)).addTo(grupo);
      puntos.push(dron.posicion);
    }

    // Se encuadra cuando cambia QUÉ hay para mostrar (aparece el dron, se va el
    // objetivo), no cada vez que algo se mueve: con un status por segundo, el
    // mapa le sacaría de las manos el zoom al operador que lo está mirando.
    const presentes = [!!deteccion, !!objetivo, !!dron].join();
    if (presentes === encuadrados.current || puntos.length === 0) return;
    encuadrados.current = presentes;
    if (puntos.length === 1) m.setView(puntos[0], ZOOM_DE_UN_PUNTO);
    else {
      m.fitBounds(L.latLngBounds(puntos), {
        paddingTopLeft: MARGEN_ARRIBA_IZQUIERDA,
        paddingBottomRight: MARGEN_ABAJO_DERECHA,
        maxZoom: ZOOM_DE_UN_PUNTO + 1,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latDeteccion, lonDeteccion, latObjetivo, lonObjetivo, claveObjetivo, nombreDron, latDron, lonDron]);

  let claseObjetivo = '';
  if (objetivo) claseObjetivo = objetivo.decision === 'VALIDATED' ? 'estado accent' : 'estado bad';

  return (
    <div className="mapa-alerta">
      <div className="mapa-caja">
        <ConmutadorDeFondo fondo={fondo} onCambiar={setFondo} />
        <div className="mapa-mini mapa-alerta-lienzo" ref={contenedor} data-testid="mapa-alerta" />
      </div>
      {/* Lo mismo que dicen las etiquetas de los marcadores, para quien no
          pasa el mouse por encima. */}
      <div className="mapa-leyenda" data-testid="leyenda-mapa-alerta">
        {deteccion && <span className="estado bad">Detección</span>}
        {objetivo && <span className={claseObjetivo}>Objetivo ahora</span>}
        {dron && <span className="estado accent">Dron</span>}
      </div>
    </div>
  );
}
