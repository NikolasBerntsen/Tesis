import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { PALETA, iconoDeEmergencia, useFondo, vestirAtribucion } from '../mapa';
import ConmutadorDeFondo from './ConmutadorDeFondo';

type Punto = [number, number];

/** La cuadra y las de alrededor: lo que hace falta para llegar caminando. */
const ZOOM_DE_UN_PUNTO = 17;

/** Aire alrededor de los dos puntos, más arriba porque la gota crece hacia arriba. */
const MARGEN_ARRIBA_IZQUIERDA: L.PointTuple = [36, 52];
const MARGEN_ABAJO_DERECHA: L.PointTuple = [36, 20];

/** El punto donde arrancó el protocolo: un aro, no una presencia. */
const ARO_DEL_DISPARO: L.CircleMarkerOptions = {
  radius: 6,
  color: PALETA.oxido,
  weight: 2,
  fillColor: PALETA.marfil,
  fillOpacity: 0.9,
};

/**
 * El mapa de la ficha de una emergencia: dónde hay que ir a buscar el dron (la
 * última posición que mandó al tocar tierra o, si todavía no la mandó, la de
 * cuando arrancó el protocolo) y, si son distintos, dónde arrancó. Es el mismo
 * mapa chico del pop-up de una alerta: misma caja, mismo conmutador de fondo,
 * mismo zoom con botones para que la rueda siga scrolleando el pop-up.
 */
export default function MapaDeEmergencia({
  ultima,
  disparo,
}: Readonly<{
  /** Dónde buscarlo, con posición ya revisada por quien la pasa. */
  ultima: { lat: number; lon: number; aterrizo: boolean };
  /** Dónde estaba al disparar el protocolo, si es otro punto que el de buscarlo. */
  disparo: Punto | null;
}>) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const marcas = useRef<L.LayerGroup | null>(null);
  const encuadrados = useRef('');

  // Una sola vez: la ficha se repinta con cada novedad de la emergencia (una
  // foto que llega), y rehacer el mapa parpadea y vuelve a pedir las teselas.
  useEffect(() => {
    const m = L.map(contenedor.current!, { zoomControl: false, scrollWheelZoom: false }).setView(
      [ultima.lat, ultima.lon],
      ZOOM_DE_UN_PUNTO,
    );
    L.control.zoom({ position: 'topleft', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(m);
    vestirAtribucion(m, '');
    marcas.current = L.layerGroup().addTo(m);
    mapa.current = m;
    // La caja del pop-up entra con una animación de escala (ver MapaDeAlerta).
    const remedir = globalThis.setTimeout(() => m.invalidateSize(), 250);
    return () => {
      globalThis.clearTimeout(remedir);
      m.remove();
      mapa.current = null;
      marcas.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [fondo, setFondo] = useFondo(mapa);

  const etiqueta = ultima.aterrizo ? 'Donde tocó tierra' : 'Última posición';
  const latDisparo = disparo?.[0];
  const lonDisparo = disparo?.[1];

  useEffect(() => {
    const m = mapa.current;
    const grupo = marcas.current;
    if (!m || !grupo) return;
    grupo.clearLayers();
    const punto: Punto = [ultima.lat, ultima.lon];
    if (disparo) L.circleMarker(disparo, ARO_DEL_DISPARO).bindTooltip('Donde arrancó el protocolo').addTo(grupo);
    L.marker(punto, { icon: iconoDeEmergencia(), keyboard: false }).bindTooltip(etiqueta).addTo(grupo);
    // Se encuadra cuando cambia QUÉ hay (llega el aterrizaje), no en cada
    // repintado: el operador puede estar acercándose a mirar la cuadra.
    const presentes = `${etiqueta}-${!!disparo}`;
    if (presentes === encuadrados.current) return;
    encuadrados.current = presentes;
    if (disparo) {
      m.fitBounds(L.latLngBounds([disparo, punto]), {
        paddingTopLeft: MARGEN_ARRIBA_IZQUIERDA,
        paddingBottomRight: MARGEN_ABAJO_DERECHA,
        maxZoom: ZOOM_DE_UN_PUNTO + 1,
      });
    } else {
      m.setView(punto, ZOOM_DE_UN_PUNTO);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ultima.lat, ultima.lon, etiqueta, latDisparo, lonDisparo]);

  return (
    <div className="mapa-alerta">
      <div className="mapa-caja">
        <ConmutadorDeFondo fondo={fondo} onCambiar={setFondo} />
        <div className="mapa-mini mapa-alerta-lienzo" ref={contenedor} data-testid="mapa-emergencia" />
      </div>
      <div className="mapa-leyenda" data-testid="leyenda-mapa-emergencia">
        <span className="estado bad">{etiqueta}</span>
        {disparo && <span className="estado muted">Donde arrancó el protocolo</span>}
      </div>
    </div>
  );
}
