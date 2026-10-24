import L from 'leaflet';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import { parsearMeta } from '../api';
import { MOTIVO_DE_EMERGENCIA } from '../emergencias';
import { coordenadasODato, duracion, fechaHoraLarga, hashCorto } from '../format';
import { PALETA, useFondo, vestirAtribucion } from '../mapa';
import {
  ESTADO_DEL_RELEVO,
  MOTIVO_DE_FIN,
  MOTIVO_DEL_DESVIO,
  MOTIVO_DEL_DRON_DE_RELEVO,
  MOTIVO_DEL_RELEVO,
  estadoDelRelevo,
  motivoDeFin,
  tonoDelEstado,
} from '../relevos';
import { useRelevosYEmergencias } from '../relevosYEmergencias';
import type { CamposMeta, EventRow, MetaAlerta, MetaDron, MetaUbicacion, ValorMeta } from '../types';
import ConmutadorDeFondo from './ConmutadorDeFondo';
import DetalleDeAlerta from './DetalleDeAlerta';
import DetalleDeEmergencia from './DetalleDeEmergencia';

/** Rótulos de los campos que viajan en `antes`/`despues`/`detalle`. */
const CAMPO: Record<string, string> = {
  displayName: 'Nombre',
  model: 'Modelo',
  activo: 'Activo',
  eliminado: 'Eliminado',
  base: 'Base',
  baseLat: 'Latitud',
  baseLon: 'Longitud',
  username: 'Usuario',
  role: 'Rol',
  active: 'Activa',
  canControl: 'Control de drones',
  deletedAt: 'Eliminada el',
  estado: 'Estado',
  decidedBy: 'Decidió',
  decidedAt: 'Decidido el',
  apodo: 'Apodo',
  ruta: 'Ruta',
  rutaId: 'Ruta (id)',
  nodo: 'Nodo',
  desdeNodo: 'Desde el nodo',
  por: 'Por',
  motivo: 'Motivo',
  teniaElControl: 'Tenía el control',
  forzado: 'Forzado',
  // El pedido de control y su traspaso.
  solicitante: 'Pidió el control',
  titular: 'Tenía el control',
  resultado: 'Cómo terminó',
  de: 'Lo tenía',
  a: 'Lo recibió',
  // Relevos, desvíos y emergencias (§7 del contrato).
  relevoId: 'Relevo',
  motivoFin: 'Cómo terminó',
  origen: 'Pidió el relevo',
  relevo: 'Dron de relevo',
  motivoDeB: 'Motivo del dron de relevo',
  baseId: 'Base (id)',
  alt: 'Altura',
  bateria: 'Batería',
};

/**
 * Claves que viajan en `detalle` para otra cosa que leerlas: `relevoHash` es
 * el id del dron de relevo, para filtrar el registro por él, y al lado de su
 * nombre sería un hash largo que nadie reconoce.
 */
const CLAVES_OCULTAS = new Set(['relevoHash']);

/** La unidad de los números que la tienen, para no leer "38" a secas. */
const UNIDAD: Record<string, string> = { alt: 'm', bateria: '%' };

/**
 * Valores que son enumeraciones del backend. Se traducen sólo en las claves que
 * de verdad guardan una enumeración: un `decidedBy` puede valer "admin" y ahí
 * "admin" es el nombre de una persona, no el rol.
 */
const CLAVES_ENUMERADAS = new Set(['role', 'rol', 'estado', 'status', 'decision', 'motivo', 'motivoFin', 'motivoDeB', 'resultado']);
const VALOR_ENUMERADO: Record<string, string> = {
  field_operator: 'Operador de campo',
  operator: 'Operador',
  supervisor: 'Supervisor',
  admin: 'Administrador',
  drone: 'Dron',
  PENDING: 'Pendiente',
  VALIDATED: 'Validada',
  DISMISSED: 'Descartada',
  // Cómo terminó un pedido de control, y por qué cambió de manos.
  cedido: 'Lo cedió',
  vencido: 'No contestó a tiempo',
  mantenido: 'Lo mantuvo',
  cancelado: 'Se canceló',
  liberado: 'El control quedó libre',
  // Un `motivo` libre (el de soltar el control, el de cerrar la sesión de
  // campo) no está en esta lista y pasa tal cual.
  ...ESTADO_DEL_RELEVO,
  ...MOTIVO_DE_FIN,
  ...MOTIVO_DE_EMERGENCIA,
  ...MOTIVO_DEL_RELEVO,
  ...MOTIVO_DEL_DESVIO,
  ...MOTIVO_DEL_DRON_DE_RELEVO,
};

/** `decidedAt`, `deletedAt` y compañía llegan en ISO: no son para leer así. */
const MARCA_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function etiquetaCampo(clave: string): string {
  return CAMPO[clave] ?? clave;
}

function valorLegible(clave: string, valor: ValorMeta | undefined): string {
  if (valor === undefined || valor === null || valor === '') return '—';
  if (typeof valor === 'boolean') return valor ? 'Sí' : 'No';
  if (typeof valor === 'number') return UNIDAD[clave] ? `${valor} ${UNIDAD[clave]}` : String(valor);
  // Las columnas comparadas son angostas: ahí la fecha va corta.
  if (MARCA_ISO.test(valor)) return fechaHoraLarga(valor, 'short');
  return CLAVES_ENUMERADAS.has(clave) ? (VALOR_ENUMERADO[valor] ?? valor) : valor;
}

/**
 * La alerta que nombra el evento, si nombra alguna. La referencia completa está
 * en `meta.alerta`; una fila vieja puede traer sólo la columna `alert_id`, y
 * con el id alcanza para traer el resto.
 */
export function alertaDelEvento(fila: EventRow, meta = parsearMeta(fila.meta)): MetaAlerta | null {
  if (meta.alerta) return meta.alerta;
  if (fila.alert_id === null) return null;
  return { id: fila.alert_id, tipo: '', lat: null, lon: null, ts: null };
}

/* --- Mini mapa de la instantánea GPS -------------------------------------- */

/* Leaflet pinta sus capas con colores pasados por JS, no con CSS: se toman de
   PALETA (mapa.ts), la única copia de los tokens, que teselas.test.ts compara
   con tokens.css. Una copia propia acá se había quedado en el oro de antes del
   ajuste del tema, y el alfiler salía distinto del de los demás mapas. */

const PIN_UBICACION = L.divIcon({
  className: 'drone-pin-icon',
  html: `<svg width="26" height="32" viewBox="0 0 26 32" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 31 7.6 20.6h10.8z" fill="${PALETA.oro}" stroke="${PALETA.marfil}" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="13" cy="12" r="9" fill="${PALETA.oro}" stroke="${PALETA.marfil}" stroke-width="2"/>
      <circle cx="13" cy="12" r="3.2" fill="${PALETA.marfil}"/>
    </svg>`,
  iconSize: [26, 32],
  iconAnchor: [13, 30],
});

const CIRCULO_PRECISION: L.CircleMarkerOptions = {
  color: PALETA.oro,
  weight: 1,
  opacity: 0.7,
  fillColor: PALETA.oro,
  fillOpacity: 0.12,
  interactive: false,
};

/**
 * Mapa chico con el punto donde el operador de campo emparejó el dron. Existe
 * por seguridad —es la prueba de dónde se hizo el alta—, así que además del
 * marcador se dibuja el círculo de precisión del GPS.
 */
function MiniMapa({ ubicacion }: Readonly<{ ubicacion: MetaUbicacion }>) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const marca = useRef<L.LayerGroup | null>(null);

  // El mapa se crea una sola vez. El pop-up se re-renderiza a cada tick de
  // status de la consola, y rehacerlo por render parpadea, pierde el arrastre
  // y vuelve a pedir todas las teselas.
  useEffect(() => {
    const m = L.map(contenedor.current!, {
      // El control de fábrica rotula en inglés; se lo pone aparte en castellano.
      zoomControl: false,
      // La rueda del mouse tiene que seguir scrolleando el cuerpo del pop-up:
      // el zoom va por los botones, que es lo que faltaba acá.
      scrollWheelZoom: false,
    }).setView([ubicacion.lat, ubicacion.lon], 16);
    L.control.zoom({ position: 'topleft', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(m);
    vestirAtribucion(m, '');
    marca.current = L.layerGroup().addTo(m);
    mapa.current = m;

    // La caja del pop-up entra con una animación de escala: si Leaflet mide
    // mientras corre, calcula mal el tamaño y quedan teselas sin pedir.
    const remedir = globalThis.setTimeout(() => m.invalidateSize(), 250);
    return () => {
      globalThis.clearTimeout(remedir);
      m.remove();
      mapa.current = null;
      marca.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [fondo, setFondo] = useFondo(mapa);

  useEffect(() => {
    const m = mapa.current;
    const grupo = marca.current;
    if (!m || !grupo) return;
    const punto: L.LatLngTuple = [ubicacion.lat, ubicacion.lon];
    grupo.clearLayers();
    if (ubicacion.accuracyM !== null) {
      L.circle(punto, { ...CIRCULO_PRECISION, radius: ubicacion.accuracyM }).addTo(grupo);
    }
    L.marker(punto, { icon: PIN_UBICACION, keyboard: false }).addTo(grupo);
    m.setView(punto, m.getZoom());
    // Las dependencias son los números y no el objeto `ubicacion`, que se
    // rearma en cada parseo de la meta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ubicacion.lat, ubicacion.lon, ubicacion.accuracyM]);

  return (
    <div>
      <div className="mapa-caja">
        <ConmutadorDeFondo fondo={fondo} onCambiar={setFondo} />
        <div className="mapa-mini" ref={contenedor} data-testid="mapa-ubicacion" />
      </div>
      <p className="mapa-mini-coords">
        {coordenadasODato(ubicacion.lat, ubicacion.lon)}
        {ubicacion.accuracyM !== null && ` · precisión ±${Math.round(ubicacion.accuracyM)} m`}
      </p>
    </div>
  );
}

/* --- Bloques del cuerpo ---------------------------------------------------- */

function ListaDatos({ campos }: Readonly<{ campos: CamposMeta }>) {
  return (
    <dl className="datos">
      {Object.entries(campos)
        .filter(([clave]) => !CLAVES_OCULTAS.has(clave))
        .map(([clave, valor]) => (
          <Fragment key={clave}>
            <dt>{etiquetaCampo(clave)}</dt>
            <dd>{valorLegible(clave, valor)}</dd>
          </Fragment>
        ))}
    </dl>
  );
}

function ColumnaComparada({
  titulo,
  campos,
  claves,
  cambiadas,
  despues = false,
}: Readonly<{
  titulo: string;
  campos: CamposMeta;
  claves: string[];
  cambiadas: Set<string>;
  despues?: boolean;
}>) {
  return (
    <div className={despues ? 'comparacion-col comparacion-despues' : 'comparacion-col'}>
      <span className="comparacion-titulo">{titulo}</span>
      {/* Sin los hilos de las demás listas: acá lo que se marca es el campo
          que cambió, y su resaltado abraza al texto, no a la fila. */}
      <dl className="datos sin-filetes">
        {claves.map((clave) => (
          <Fragment key={clave}>
            <dt>{etiquetaCampo(clave)}</dt>
            <dd className={cambiadas.has(clave) ? 'cambiado' : 'sin-cambio'}>{valorLegible(clave, campos[clave])}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** Antes → después, resaltando únicamente los campos que cambiaron. */
function Comparacion({ antes, despues }: Readonly<{ antes?: CamposMeta; despues?: CamposMeta }>) {
  const claves = [...new Set([...Object.keys(antes ?? {}), ...Object.keys(despues ?? {})])];

  // Con una sola punta no hay nada que comparar: es el estado con el que quedó
  // (un alta) o el que tenía (una baja), y se lista tal cual.
  if (!antes || !despues) {
    return (
      <>
        <h3 className="etiqueta">{antes ? 'Estado previo' : 'Estado resultante'}</h3>
        <ListaDatos campos={antes ?? despues ?? {}} />
      </>
    );
  }

  const cambiadas = new Set(claves.filter((c) => antes[c] !== despues[c]));
  return (
    <>
      <h3 className="etiqueta">Cambios</h3>
      <div className="comparacion">
        <ColumnaComparada titulo="Antes" campos={antes} claves={claves} cambiadas={cambiadas} />
        <div className="comparacion-flecha" aria-hidden="true">
          →
        </div>
        <ColumnaComparada titulo="Después" campos={despues} claves={claves} cambiadas={cambiadas} despues />
      </div>
      {cambiadas.size === 0 && <p className="muted">No cambió ningún campo.</p>}
    </>
  );
}

/**
 * Cómo está AHORA el relevo que nombra un evento, si la consola lo sigue: el
 * evento dice en qué estado quedó en ese momento, y el que lo abre casi
 * siempre quiere saber en qué terminó. Si la consola no lo conoce (un relevo
 * de otra guardia), no hay nada que agregar a lo que guardó el evento.
 */
function RelevoAhora({ relevoId }: Readonly<{ relevoId: number }>) {
  const { relevos } = useRelevosYEmergencias();
  const relevo = relevos.find((r) => r.id === relevoId);
  if (!relevo) return null;
  const fin = motivoDeFin(relevo.motivoFin);
  return (
    <>
      <h3 className="etiqueta">{`Relevo #${relevo.id} ahora`}</h3>
      <dl className="datos" data-testid="relevo-ahora">
        <dt>Estado</dt>
        <dd aria-live="polite">
          <span className={`estado pastilla ${tonoDelEstado(relevo.estado)}`}>{estadoDelRelevo(relevo.estado)}</span>
          {fin && ` · ${fin}`}
        </dd>
        <dt>Pidió el relevo</dt>
        <dd>{relevo.origen.displayName}</dd>
        <dt>Dron de relevo</dt>
        <dd>{relevo.relevo?.displayName ?? 'Sin candidato'}</dd>
        {relevo.etaS !== null && relevo.estado === 'EN_CAMINO' && (
          <>
            <dt>Llega en</dt>
            <dd>{duracion(relevo.etaS)}</dd>
          </>
        )}
      </dl>
    </>
  );
}

function FichaDron({ drone }: Readonly<{ drone: MetaDron }>) {
  return (
    <>
      <h3 className="etiqueta">Dron</h3>
      <dl className="datos">
        <dt>Nombre</dt>
        <dd>{drone.displayName || '—'}</dd>
        <dt>Modelo</dt>
        <dd>{drone.model || '—'}</dd>
        <dt>Identificador</dt>
        <dd>
          <span className="hash mono">{hashCorto(drone.hash)}</span>
        </dd>
      </dl>
    </>
  );
}

/* --- Cuerpo ---------------------------------------------------------------- */

/**
 * El detalle de una fila del registro: lo que se ve al abrirla en el Registro
 * (LogDetailModal) y en el panel lateral del historial de un dron. Antes vivía
 * sólo adentro del pop-up del Registro; el historial lo necesitaba igual, y una
 * copia era la forma segura de que los dos terminaran leyendo distinto el mismo
 * evento.
 *
 * Todo lo que se pinta sale de `meta`, que es JSON viejo de la base: se lee con
 * parsearMeta(), que descarta lo que no tenga la forma esperada, y cada bloque
 * aparece sólo si sobrevivió su clave. Si el evento nombra una alerta, el
 * bloque es el de la alerta completa —captura, mapa y decisión—, el mismo del
 * pop-up que se abre desde el carrusel o la campana.
 */
export default function DetalleDeEvento({ fila, onIrAlVideo }: Readonly<{ fila: EventRow; onIrAlVideo: () => void }>) {
  // Memoizado porque parsearMeta arma objetos nuevos en cada llamada y
  // `meta.ubicacion` es la dependencia del efecto que dibuja el mini mapa: sin
  // esto, cada render del padre reconstruía el mapa entero.
  const meta = useMemo(() => parsearMeta(fila.meta), [fila.meta]);
  const alerta = alertaDelEvento(fila, meta);
  const relevoId = meta.detalle?.relevoId;

  // El origen de los eventos de dron es el hash: se muestra el nombre, que es
  // lo único que un humano puede reconocer.
  const origen = meta.drone?.hash === fila.source ? meta.drone.displayName : fila.source;

  return (
    <>
      <dl className="datos">
        <dt>Fecha y hora</dt>
        <dd>
          <time dateTime={fila.ts}>{fechaHoraLarga(fila.ts)}</time>
        </dd>
        <dt>Origen</dt>
        <dd>{origen || '—'}</dd>
        {meta.por !== undefined && (
          <>
            <dt>Ejecutado por</dt>
            <dd>{meta.por}</dd>
          </>
        )}
        {meta.decision !== undefined && (
          <>
            <dt>Decisión</dt>
            <dd>{valorLegible('decision', meta.decision)}</dd>
          </>
        )}
        {meta.dispositivo !== undefined && (
          <>
            <dt>Dispositivo</dt>
            <dd>{meta.dispositivo}</dd>
          </>
        )}
      </dl>

      {(meta.antes || meta.despues) && <Comparacion antes={meta.antes} despues={meta.despues} />}

      {/* La ficha de una emergencia trae su propio mapa, con la misma
          posición: dos mapas del mismo punto, uno arriba del otro, confunden. */}
      {meta.ubicacion && !meta.emergencia && (
        <>
          <h3 className="etiqueta">Ubicación registrada</h3>
          <MiniMapa ubicacion={meta.ubicacion} />
        </>
      )}

      {/* El bloque de la alerta trae su propia ficha del dron, con lo que está
          pasando ahora: la del evento queda de respaldo, no se repite. */}
      {alerta && (
        <DetalleDeAlerta
          key={alerta.id}
          alertaId={alerta.id}
          referencia={alerta}
          dronDeRespaldo={meta.drone}
          onIrAlVideo={onIrAlVideo}
        />
      )}

      {/* La emergencia entera, como en su propio pop-up: fotos, mapa,
          coordenadas y «Marcar como recuperado». */}
      {meta.emergencia && (
        <DetalleDeEmergencia key={meta.emergencia.id} emergenciaId={meta.emergencia.id} referencia={meta.emergencia} />
      )}

      {meta.drone && !alerta && !meta.emergencia && <FichaDron drone={meta.drone} />}

      {meta.detalle && (
        <>
          <h3 className="etiqueta">Detalle</h3>
          <ListaDatos campos={meta.detalle} />
        </>
      )}

      {/* Después del detalle: primero lo que guardó el evento, después cómo sigue. */}
      {typeof relevoId === 'number' && <RelevoAhora relevoId={relevoId} />}
    </>
  );
}
