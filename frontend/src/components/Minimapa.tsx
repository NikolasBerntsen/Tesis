import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { rumbo as textoDeRumbo } from '../format';
import { CENTRO_POR_DEFECTO, crearFondos, vestirAtribucion } from '../mapa';

/** Zoom de calle: se ven la cuadra y las de alrededor, que es lo que sirve para no perderse. */
const ZOOM = 17;

/**
 * El mapita de la vista de pilotaje: dónde está el dron y para dónde mira,
 * nada más. Con la imagen de la cámara ocupando toda la pantalla es fácil
 * perder la orientación, y este recuadro es la brújula.
 *
 * El mapa SIGUE al dron —se recentra con cada posición— y por eso el dron no es
 * un marcador de Leaflet sino una flecha fija en el centro del recuadro, girada
 * según el rumbo. Además de ser lo que se ve en un juego, evita rehacer el ícono
 * del marcador con cada status sólo para girarlo. Por lo mismo el mapa no se
 * arrastra ni se acerca con la rueda: correrlo dejaría la flecha señalando otro
 * lugar, y la rueda en esta vista es de la cámara.
 */
export default function Minimapa({
  posicion,
  rumbo,
}: {
  /** `[lat, lon]`, o `null` sin GPS (ver `posicionDelDron`). */
  posicion: [number, number] | null;
  /** Hacia dónde mira la cámara, en grados; una app vieja puede no mandarlo. */
  rumbo?: number;
}) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);

  useEffect(() => {
    const m = L.map(contenedor.current!, {
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    }).setView(CENTRO_POR_DEFECTO, ZOOM);
    // Sólo el callejero: en un recuadro de 200 px el satelital es una mancha
    // verde y gris donde no se distingue una calle. De noche lo oscurece el
    // CSS por la clase que trae la capa (mapa.ts): sobre el video, un recuadro
    // de mapa diurno era lo que más encandilaba del HUD.
    crearFondos().mapa.addTo(m);
    // La atribución de OpenStreetMap es obligatoria; el "Leaflet" de adelante
    // no, y en un recuadro tan chico tapa la mitad del ancho.
    vestirAtribucion(m, '');
    mapa.current = m;
    return () => {
      m.remove();
      mapa.current = null;
    };
  }, []);

  const lat = posicion?.[0];
  const lon = posicion?.[1];
  useEffect(() => {
    if (lat === undefined || lon === undefined) return;
    // Sin animación: con un status por segundo, un paneo animado tardaría casi
    // lo mismo que el intervalo y el mapa viviría deslizándose.
    mapa.current?.setView([lat, lon], mapa.current.getZoom(), { animate: false });
  }, [lat, lon]);

  const conRumbo = typeof rumbo === 'number' && Number.isFinite(rumbo);

  return (
    <div className="minimapa" data-testid="minimapa">
      <div className="minimapa-mapa" ref={contenedor} />
      {posicion ? (
        <span
          className="minimapa-dron"
          data-testid="minimapa-dron"
          role="img"
          aria-label={conRumbo ? `El dron, mirando a ${textoDeRumbo(rumbo)}` : 'El dron'}
          style={{ transform: `translate(-50%, -50%) rotate(${conRumbo ? rumbo : 0}deg)` }}
        >
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
            {/* Una punta de flecha: sin rumbo informado igual apunta al
                norte, que es lo que hace cualquier mapa con la nariz del
                dron que no conoce. */}
            <path d="M13 2.5 21.5 22 13 17.6 4.5 22z" />
          </svg>
        </span>
      ) : (
        // El recuadro no desaparece: es el mismo lugar de siempre diciendo que
        // no sabe. Un mapa centrado en el Obelisco, en cambio, mentiría.
        <div className="minimapa-sin-gps" data-testid="minimapa-sin-gps">
          Sin GPS
        </div>
      )}
    </div>
  );
}
