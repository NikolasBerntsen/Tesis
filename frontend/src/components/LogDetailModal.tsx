import L from 'leaflet';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, parsearMeta } from '../api';
import { useFondo, vestirAtribucion } from '../mapa';
import type { Alert, CamposMeta, EventRow, MetaAlerta, MetaDron, MetaUbicacion, ValorMeta } from '../types';
import ConmutadorDeFondo from './ConmutadorDeFondo';
import Modal from './Modal';

const CATEGORIA: Record<EventRow['category'], string> = {
  drone: 'Drones',
  usuarios: 'Usuarios',
  sistema: 'Sistema',
};

const TIPO_ALERTA: Record<string, string> = { PERSON: 'PERSONA', VEHICLE: 'VEHÍCULO' };

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
};

/**
 * Valores que son enumeraciones del backend. Se traducen sólo en las claves que
 * de verdad guardan una enumeración: un `decidedBy` puede valer "admin" y ahí
 * "admin" es el nombre de una persona, no el rol.
 */
const CLAVES_ENUMERADAS = new Set(['role', 'rol', 'estado', 'status', 'decision']);
const VALOR_ENUMERADO: Record<string, string> = {
  field_operator: 'Operador de campo',
  operator: 'Operador',
  supervisor: 'Supervisor',
  admin: 'Administrador',
  drone: 'Dron',
  PENDING: 'Pendiente',
  VALIDATED: 'Validada',
  DISMISSED: 'Descartada',
};

/** Las columnas comparadas son angostas: ahí la fecha va corta. */
function fechaHora(ts: string | null, estilo: 'long' | 'short' = 'long'): string {
  if (!ts) return '—';
  const fecha = new Date(ts);
  if (Number.isNaN(fecha.getTime())) return ts;
  return fecha.toLocaleString('es-AR', { dateStyle: estilo, timeStyle: estilo === 'long' ? 'medium' : 'short' });
}

/** `decidedAt`, `deletedAt` y compañía llegan en ISO: no son para leer así. */
const MARCA_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function etiquetaCampo(clave: string): string {
  return CAMPO[clave] ?? clave;
}

function valorLegible(clave: string, valor: ValorMeta | undefined): string {
  if (valor === undefined || valor === null || valor === '') return '—';
  if (typeof valor === 'boolean') return valor ? 'Sí' : 'No';
  if (typeof valor === 'number') return String(valor);
  if (MARCA_ISO.test(valor)) return fechaHora(valor, 'short');
  return CLAVES_ENUMERADAS.has(clave) ? (VALOR_ENUMERADO[valor] ?? valor) : valor;
}

/** El identificador del dron es un hash largo: nunca se muestra entero. */
function hashCorto(hash: string): string {
  if (!hash) return '—';
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

function coordenadas(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return '—';
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

function mensajeDeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* --- Mini mapa de la instantánea GPS -------------------------------------- */

/* Leaflet pinta sus capas desde JS, no desde CSS: los tokens se repiten acá,
   igual que en DronesMap.tsx. */
const ORO = '#B8912F';
const MARFIL = '#FBFAF7';

const PIN_UBICACION = L.divIcon({
  className: 'drone-pin-icon',
  html: `<svg width="26" height="32" viewBox="0 0 26 32" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 31 7.6 20.6h10.8z" fill="${ORO}" stroke="${MARFIL}" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="13" cy="12" r="9" fill="${ORO}" stroke="${MARFIL}" stroke-width="2"/>
      <circle cx="13" cy="12" r="3.2" fill="${MARFIL}"/>
    </svg>`,
  iconSize: [26, 32],
  iconAnchor: [13, 30],
});

const CIRCULO_PRECISION: L.CircleMarkerOptions = {
  color: ORO,
  weight: 1,
  opacity: 0.7,
  fillColor: ORO,
  fillOpacity: 0.12,
  interactive: false,
};

/**
 * Mapa chico con el punto donde el operador de campo emparejó el dron. Existe
 * por seguridad —es la prueba de dónde se hizo el alta—, así que además del
 * marcador se dibuja el círculo de precisión del GPS.
 */
function MiniMapa({ ubicacion }: { ubicacion: MetaUbicacion }) {
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
    const remedir = window.setTimeout(() => m.invalidateSize(), 250);
    return () => {
      window.clearTimeout(remedir);
      m.remove();
      mapa.current = null;
      marca.current = null;
    };
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
  }, [ubicacion.lat, ubicacion.lon, ubicacion.accuracyM]);

  return (
    <div>
      <div className="mapa-caja">
        <ConmutadorDeFondo fondo={fondo} onCambiar={setFondo} />
        <div className="mapa-mini" ref={contenedor} data-testid="mapa-ubicacion" />
      </div>
      <p className="mapa-mini-coords">
        {coordenadas(ubicacion.lat, ubicacion.lon)}
        {ubicacion.accuracyM !== null && ` · precisión ±${Math.round(ubicacion.accuracyM)} m`}
      </p>
    </div>
  );
}

/* --- Bloques del cuerpo ---------------------------------------------------- */

function ListaDatos({ campos }: { campos: CamposMeta }) {
  return (
    <dl className="datos">
      {Object.entries(campos).map(([clave, valor]) => (
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
}: {
  titulo: string;
  campos: CamposMeta;
  claves: string[];
  cambiadas: Set<string>;
  despues?: boolean;
}) {
  return (
    <div className={despues ? 'comparacion-col comparacion-despues' : 'comparacion-col'}>
      <span className="comparacion-titulo">{titulo}</span>
      <dl className="datos">
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
function Comparacion({ antes, despues }: { antes?: CamposMeta; despues?: CamposMeta }) {
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

function FichaDron({ drone }: { drone: MetaDron }) {
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

/**
 * La alerta que disparó el evento. El `meta` sólo guarda una referencia, así
 * que la captura del video se trae con GET /api/alerts/:id; si ese pedido
 * falla igual se muestra lo poco que quedó registrado en el evento.
 */
function BloqueAlerta({ referencia, conFicha }: { referencia: MetaAlerta; conFicha: boolean }) {
  const [alerta, setAlerta] = useState<Alert | null>(null);
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let vigente = true;
    setCargando(true);
    api<Alert>(`/alerts/${referencia.id}`)
      .then((a) => {
        if (vigente) setAlerta(a);
      })
      .catch((e) => {
        if (vigente) setError(mensajeDeError(e));
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [referencia.id]);

  const tipo = alerta?.type ?? referencia.tipo;
  const lat = alerta?.lat ?? referencia.lat;
  const lon = alerta?.lon ?? referencia.lon;
  const momento = alerta?.created_at ?? referencia.ts;

  let resolucion = 'Sin resolver';
  if (alerta && alerta.status !== 'PENDING') {
    resolucion = `${valorLegible('estado', alerta.status)} por ${alerta.decided_by ?? '—'} · ${fechaHora(alerta.decided_at)}`;
  }

  return (
    <>
      <h3 className="etiqueta">Alerta #{referencia.id}</h3>
      {error && <p className="aviso malo">No se pudo traer la alerta: {error}</p>}
      {cargando && <p className="muted">Trayendo la alerta…</p>}
      {alerta?.snapshot && (
        <div className="hueco">
          <img className="snapshot" src={`data:image/jpeg;base64,${alerta.snapshot}`} alt="Captura de la detección" />
        </div>
      )}
      {alerta && !alerta.snapshot && <p className="vacio">La detección no dejó captura.</p>}
      <dl className="datos">
        <dt>Tipo</dt>
        <dd>
          <span className={`badge ${tipo.toLowerCase()}`}>{TIPO_ALERTA[tipo] ?? tipo}</span>
        </dd>
        {/* Si el evento trae `drone`, abajo va la ficha completa: no se repite */}
        {!conFicha && (
          <>
            <dt>Dron</dt>
            <dd>{alerta?.drone_id ? hashCorto(alerta.drone_id) : '—'}</dd>
          </>
        )}
        <dt>Coordenadas</dt>
        <dd className="mono">{coordenadas(lat, lon)}</dd>
        <dt>Detectada</dt>
        <dd>{fechaHora(momento)}</dd>
        <dt>Resolución</dt>
        <dd>{resolucion}</dd>
      </dl>
    </>
  );
}

/* --- Pop-up ---------------------------------------------------------------- */

const CRUZ = (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
  </svg>
);

/**
 * Detalle de una fila del registro. Todo lo que se pinta sale de `meta`, que
 * es JSON viejo de la base: se lee con parsearMeta(), que descarta lo que no
 * tenga la forma esperada, y cada bloque aparece sólo si sobrevivió su clave.
 */
export default function LogDetailModal({ fila, onCerrar }: { fila: EventRow; onCerrar: () => void }) {
  const idTitulo = useId();
  // Memoizado porque parsearMeta arma objetos nuevos en cada llamada y
  // `meta.ubicacion` es la dependencia del efecto que dibuja el mini mapa: sin
  // esto, cada render del padre reconstruía el mapa entero.
  const meta = useMemo(() => parsearMeta(fila.meta), [fila.meta]);

  // El origen de los eventos de dron es el hash: se muestra el nombre, que es
  // lo único que un humano puede reconocer.
  const origen = meta.drone && meta.drone.hash === fila.source ? meta.drone.displayName : fila.source;

  return (
    <Modal etiquetadoPor={idTitulo} onCerrar={onCerrar}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            {fila.message}
          </h2>
          <p className="modal-subtitulo">
            <span className={`cat-badge cat-${fila.category}`}>{CATEGORIA[fila.category]}</span>{' '}
            <span className="mono">{fila.type}</span>
          </p>
        </div>
        <button type="button" className="modal-cerrar" aria-label="Cerrar el detalle" onClick={onCerrar}>
          {CRUZ}
        </button>
      </header>

      <div className="modal-cuerpo">
        <dl className="datos">
          <dt>Fecha y hora</dt>
          <dd>
            <time dateTime={fila.ts}>{fechaHora(fila.ts)}</time>
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

        {meta.ubicacion && (
          <>
            <h3 className="etiqueta">Ubicación registrada</h3>
            <MiniMapa ubicacion={meta.ubicacion} />
          </>
        )}

        {meta.alerta && <BloqueAlerta referencia={meta.alerta} conFicha={meta.drone !== undefined} />}

        {meta.drone && <FichaDron drone={meta.drone} />}

        {meta.detalle && (
          <>
            <h3 className="etiqueta">Detalle</h3>
            <ListaDatos campos={meta.detalle} />
          </>
        )}
      </div>

      <footer className="modal-pie">
        <button type="button" onClick={onCerrar}>
          Cerrar
        </button>
      </footer>
    </Modal>
  );
}
