import { useEffect, useRef, useState } from 'react';
import { traerEmergencia } from '../api';
import {
  dondeBuscar,
  fusionarEmergencia,
  juntarFotos,
  motivoDeEmergencia,
  pieDeFoto,
  sinFotos,
  tipoDeFoto,
} from '../emergencias';
import { fechaHoraLarga, hashCorto, posicionValida } from '../format';
import { useRelevosYEmergencias } from '../relevosYEmergencias';
import type { Emergencia, EmergenciaConFotos, FotoDeEmergencia, MetaEmergencia } from '../types';
import DialogoConfirmacion from './DialogoConfirmacion';
import MapaDeEmergencia from './MapaDeEmergencia';
import { CoordenadasCopiables } from './PanelObjetivo';

type Punto = [number, number];

function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** En qué anda la emergencia, en dos palabras y con el color de lo que falta hacer. */
function situacion(e: Emergencia | null): { texto: string; tono: string } | null {
  if (!e) return null;
  if (e.recuperadaEn !== null) return { texto: 'Recuperado', tono: 'ok' };
  if (e.aterrizadaEn !== null) return { texto: 'En tierra, sin recuperar', tono: 'bad' };
  return { texto: 'Aterrizando', tono: 'bad' };
}

/** "9 % · a 38 m de altura": cómo estaba al disparar el protocolo. */
function alDisparar(e: Emergencia): string {
  const bateria = Number.isFinite(e.bateria) ? `batería ${Math.round(e.bateria)} %` : 'batería —';
  const altura = Number.isFinite(e.alt) ? `a ${Math.round(e.alt)} m de altura` : 'altura —';
  return `${bateria} · ${altura}`;
}

/* --- Galería ---------------------------------------------------------------- */

/**
 * Las fotos del protocolo, una grande y las demás en miniatura. Cada una dice
 * qué toma es, hacia dónde mira y cuánto baja la cámara: con eso el equipo de
 * tierra reconoce el lugar (un techo, una calle, un árbol) antes de llegar.
 */
function Galeria({
  fotos,
  esperadas,
  cargando,
}: Readonly<{ fotos: readonly FotoDeEmergencia[]; esperadas: number; cargando: boolean }>) {
  const [elegida, setElegida] = useState<number | null>(null);
  if (fotos.length === 0) {
    if (cargando) return null;
    return (
      <p className="vacio">
        {esperadas > 0 ? 'Las fotos todavía están llegando.' : 'Todavía no llegó ninguna foto del dron.'}
      </p>
    );
  }
  // La elegida por número: si llega una foto anterior, la que se mira no cambia.
  const actual = fotos.find((f) => f.seq === elegida) ?? fotos[0];
  const indice = fotos.indexOf(actual);
  const total = Math.max(esperadas, fotos.length);
  return (
    <div className="galeria" data-testid="galeria-emergencia">
      <figure className="galeria-principal">
        <img
          className="snapshot"
          src={`data:image/jpeg;base64,${actual.jpegBase64}`}
          alt={`Foto ${indice + 1} del lugar: ${pieDeFoto(actual)}`}
        />
        <figcaption>
          <span className="etiqueta">{`Foto ${indice + 1} de ${total}`}</span> {pieDeFoto(actual)}
          {Number.isFinite(actual.alt) && ` · a ${Math.round(actual.alt)} m de altura`}
        </figcaption>
      </figure>
      {fotos.length > 1 && (
        <ul className="galeria-miniaturas" aria-label="Fotos del aterrizaje">
          {fotos.map((f, i) => (
            <li key={f.seq}>
              <button
                type="button"
                className="galeria-miniatura"
                aria-pressed={f === actual}
                aria-label={`Ver la foto ${i + 1}: ${pieDeFoto(f)}`}
                onClick={() => setElegida(f.seq)}
              >
                <img src={`data:image/jpeg;base64,${f.jpegBase64}`} alt="" />
                <span>{tipoDeFoto(f.tipo)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --- Cuerpo ------------------------------------------------------------------ */

/**
 * La ficha de un aterrizaje de emergencia (RELEVOS §5): cuándo fue, qué dron,
 * las fotos que sacó antes de bajar, un mapa con la última posición, las
 * coordenadas para copiar y «Marcar como recuperado». Es lo que necesita quien
 * sale a buscar el dron, y por eso la ve también el operador de campo.
 *
 * Es el cuerpo del pop-up que se abre desde el aviso de arriba de la consola, y
 * el mismo bloque aparece en el detalle de un evento que la nombra (en el
 * Registro y en el historial del dron), como pasa con las alertas.
 *
 * Lo que está en vivo (la emergencia y las fotos que llegan) sale de la consola;
 * la ficha completa, con todas las fotos, se pide al backend al abrirla.
 */
export default function DetalleDeEmergencia({
  emergenciaId,
  referencia,
  conTitulo = true,
}: Readonly<{
  emergenciaId: number;
  /** Lo que el evento guardó de la emergencia: se muestra si no se la puede traer. */
  referencia?: MetaEmergencia;
  /** "Aterrizaje de emergencia #N" arriba. El pop-up propio lo lleva en su cabecera. */
  conTitulo?: boolean;
}>) {
  const vivo = useRelevosYEmergencias();
  const viva = vivo.emergencias.find((e) => e.id === emergenciaId) ?? null;
  const [traida, setTraida] = useState<EmergenciaConFotos | null>(null);
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(true);
  const [recarga, setRecarga] = useState(0);
  const [confirmando, setConfirmando] = useState(false);
  /** La cantidad de fotos para la que ya se volvió a pedir la ficha (ver abajo). */
  const pedidaPara = useRef(0);

  // La respuesta que llega tarde es de una ficha que ya nadie está mirando.
  useEffect(() => {
    let vigente = true;
    void traerEmergencia(emergenciaId)
      .then((e) => {
        if (!vigente) return;
        setTraida(e);
        setError('');
      })
      .catch((e: unknown) => {
        if (vigente) setError(textoError(e));
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [emergenciaId, recarga]);

  // Lo más fresco de cada lado: la de la consola llega por el WebSocket; la
  // traída tiene las fotos. Una emergencia sólo avanza, así que se junta.
  const base = traida ? sinFotos(traida) : null;
  let emergencia: Emergencia | null = viva ?? base;
  if (viva && base) emergencia = fusionarEmergencia(base, viva);
  const fotos = juntarFotos(traida?.fotos ?? [], vivo.fotos[emergenciaId] ?? []);
  const esperadas = emergencia?.fotos ?? 0;

  // Si la consola sabe de más fotos que las que hay a la vista, se perdieron
  // por el camino (el canal estuvo caído mientras llegaban): se vuelve a pedir
  // la ficha, una vez por cada cantidad para no quedar en un lazo si el
  // backend contesta con menos.
  useEffect(() => {
    if (cargando || esperadas <= fotos.length || pedidaPara.current >= esperadas) return;
    pedidaPara.current = esperadas;
    setRecarga((n) => n + 1);
  }, [cargando, esperadas, fotos.length]);

  const estado = situacion(emergencia);
  const nombre = emergencia?.displayName ?? '';
  const motivo = emergencia?.motivo ?? referencia?.motivo ?? '';
  const creada = emergencia?.creadaEn ?? referencia?.ts ?? null;
  let buscar = emergencia ? dondeBuscar(emergencia) : null;
  if (!emergencia && referencia && posicionValida(referencia.lat, referencia.lon)) {
    buscar = { lat: referencia.lat as number, lon: referencia.lon as number, aterrizo: false };
  }
  // El punto del disparo va aparte sólo si es otro que el de buscarlo.
  const disparo: Punto | null =
    emergencia && buscar?.aterrizo && posicionValida(emergencia.lat, emergencia.lon)
      ? [emergencia.lat as number, emergencia.lon as number]
      : null;
  const marcarRecuperada = vivo.marcarRecuperada;
  const puedeMarcar = marcarRecuperada !== null && emergencia !== null && emergencia.recuperadaEn === null;

  async function marcar(marcarla: (id: number) => Promise<Emergencia>) {
    const recuperada = await marcarla(emergenciaId);
    // La consola ya la tiene; la traída se pone al día por si esta ficha es la
    // de una emergencia vieja que la consola no seguía.
    setTraida((t) => (t ? { ...t, ...recuperada, fotos: t.fotos } : t));
  }

  return (
    <div className="detalle-alerta detalle-emergencia" data-testid="detalle-emergencia">
      {conTitulo && (
        <h3 className="etiqueta detalle-alerta-titulo">
          Aterrizaje de emergencia #{emergenciaId}
          {estado && <span className={`estado ${estado.tono}`}>{estado.texto}</span>}
        </h3>
      )}
      {error && <p className="aviso malo">No se pudo traer la ficha completa: {error}</p>}
      {cargando && <p className="muted">Trayendo la ficha…</p>}

      {/* Las fotos y el mapa, lado a lado si entran: son las dos cosas que el
          equipo mira para reconocer el lugar antes de salir. */}
      <div className="detalle-alerta-vistas">
        <Galeria fotos={fotos} esperadas={esperadas} cargando={cargando} />
        {buscar ? (
          <MapaDeEmergencia ultima={buscar} disparo={disparo} />
        ) : (
          !cargando && <p className="vacio">El dron no informó su posición: no hay un punto que mostrar.</p>
        )}
      </div>

      <dl className="datos">
        {!conTitulo && estado && (
          <>
            <dt>Situación</dt>
            <dd aria-live="polite">
              <span className={`estado ${estado.tono}`}>{estado.texto}</span>
            </dd>
          </>
        )}
        <dt>Dron</dt>
        <dd>
          {nombre || '—'}
          {/* El espacio va afuera: adentro de .hash (una fila flex) se perdía. */}
          {emergencia && (
            <>
              {' '}
              <span className="hash mono">{hashCorto(emergencia.droneId)}</span>
            </>
          )}
        </dd>
        <dt>Motivo</dt>
        <dd>{motivo ? motivoDeEmergencia(motivo) : '—'}</dd>
        <dt>Comenzó</dt>
        <dd>{creada ? <time dateTime={creada}>{fechaHoraLarga(creada)}</time> : '—'}</dd>
        {emergencia && (
          <>
            <dt>Al comenzar</dt>
            <dd>{alDisparar(emergencia)}</dd>
            <dt>Tocó tierra</dt>
            <dd>
              {emergencia.aterrizadaEn ? (
                <time dateTime={emergencia.aterrizadaEn}>{fechaHoraLarga(emergencia.aterrizadaEn)}</time>
              ) : (
                <span className="muted">Todavía no confirmó el aterrizaje</span>
              )}
            </dd>
          </>
        )}
        <dt>{buscar?.aterrizo ? 'Dónde quedó' : 'Última posición'}</dt>
        <dd>
          {buscar ? (
            <>
              <CoordenadasCopiables
                lat={buscar.lat}
                lon={buscar.lon}
                etiqueta="Copiar las coordenadas del dron"
                testId="coordenadas-emergencia"
              />
              {!buscar.aterrizo && (
                <span className="muted"> Es donde arrancó el protocolo: todavía no informó dónde tocó tierra.</span>
              )}
            </>
          ) : (
            <span className="muted">Sin posición</span>
          )}
        </dd>
        {emergencia && (
          <>
            <dt>Recuperado</dt>
            {/* Se anuncia al cambiar: otra persona del equipo la puede marcar con la ficha abierta. */}
            <dd aria-live="polite">
              {emergencia.recuperadaEn
                ? `Por ${emergencia.recuperadaPor ?? '—'} · ${fechaHoraLarga(emergencia.recuperadaEn)}`
                : 'Todavía no'}
            </dd>
          </>
        )}
      </dl>

      {puedeMarcar && (
        <div className="detalle-alerta-acciones">
          <button type="button" className="primario detalle-alerta-video" onClick={() => setConfirmando(true)}>
            Marcar como recuperado
          </button>
        </div>
      )}

      {confirmando && marcarRecuperada && (
        <DialogoConfirmacion
          pedido={{
            titulo: nombre ? `Marcar ${nombre} como recuperado` : 'Marcar el dron como recuperado',
            consecuencia: 'La emergencia se cierra y el aviso deja de verse en todas las consolas.',
            detalle: 'Queda en el registro quién la cerró y cuándo. No se puede deshacer.',
            confirmar: 'Marcar como recuperado',
            enCurso: 'Marcando…',
            tono: 'primario',
            accion: () => marcar(marcarRecuperada),
          }}
          onCerrar={() => setConfirmando(false)}
        />
      )}
    </div>
  );
}
