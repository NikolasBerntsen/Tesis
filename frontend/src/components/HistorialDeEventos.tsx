import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, parsearMeta } from '../api';
import { etiquetaDeEvento, fechaYHora } from '../format';
import type { EventRow } from '../types';
import DetalleDeEvento from './DetalleDeEvento';
import EventLog from './EventLog';
import IconoCerrar from './IconoCerrar';
import Modal from './Modal';

/** Cuántos eventos trae el historial: los últimos cien del dron. */
export const EVENTOS_DEL_HISTORIAL = 100;

/** Cuántos se ven por página: veinte filas entran sin scrollear en una pantalla de escritorio. */
export const EVENTOS_POR_PAGINA = 20;

/**
 * Si un evento es de este dron. Los de un relevo quedan anotados a nombre del
 * que lo pidió (§7 del contrato), pero también son la historia del que fue: el
 * hub deja su id en `detalle.relevoHash` justamente para encontrarlos.
 */
function esDelDron(evento: EventRow, droneId: string): boolean {
  if (evento.drone_id === droneId) return true;
  return evento.type.startsWith('RELAY_') && parsearMeta(evento.meta).detalle?.relevoHash === droneId;
}

/**
 * El historial de eventos de un dron, en un pop-up. Antes era una lista suelta
 * al pie de la vista del dron: quedaba debajo de todo, nadie llegaba a leerla
 * en pleno vuelo, y no había forma de ver qué decía cada evento más allá de su
 * renglón.
 *
 * Trae los últimos cien del backend y les suma los que van llegando por el
 * WebSocket mientras está abierto. Al abrir una fila, su detalle se despliega
 * AL LADO de la lista, en el mismo pop-up, y no en otro encima: así se pueden
 * recorrer los eventos uno por uno sin abrir y cerrar cajas. En una pantalla
 * angosta el detalle baja debajo de la lista (modales.css).
 */
export default function HistorialDeEventos({
  droneId,
  nombre,
  liveEvents,
  onCerrar,
}: Readonly<{
  droneId: string;
  nombre: string;
  /** Los eventos que la consola recibió en vivo, de todos los drones. */
  liveEvents: readonly EventRow[];
  onCerrar: () => void;
}>) {
  const idTitulo = useId();
  const idDetalle = useId();
  const [historia, setHistoria] = useState<EventRow[]>([]);
  // Hasta que llega el historial la lista no puede decir "sin eventos": es lo
  // primero que se lee al abrirla, y era mentira por medio segundo.
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState('');
  const [pagina, setPagina] = useState(1);
  const [abierto, setAbierto] = useState<EventRow | null>(null);
  const lista = useRef<HTMLElement>(null);
  const panel = useRef<HTMLElement>(null);

  // La respuesta que llega tarde es de un historial que ya nadie está mirando.
  useEffect(() => {
    let vigente = true;
    api<EventRow[]>(`/events?droneId=${encodeURIComponent(droneId)}&limit=${EVENTOS_DEL_HISTORIAL}`)
      .then((h) => {
        if (vigente) setHistoria(h);
      })
      .catch((e) => {
        if (vigente) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (vigente) setCargado(true);
      });
    return () => {
      vigente = false;
    };
  }, [droneId]);

  // El historial más lo que fue llegando en vivo, sin repetir: un evento que
  // llegó por el WebSocket mientras viajaba el pedido viene también en la
  // respuesta. Se ordena por id (el orden en que se registraron) y se corta en
  // cien, que es lo que promete el título.
  const eventos = useMemo(() => {
    const conocidos = new Set(historia.map((e) => e.id));
    const frescos = liveEvents.filter((e) => esDelDron(e, droneId) && !conocidos.has(e.id));
    const todos = [...frescos, ...historia];
    todos.sort((a, b) => b.id - a.id);
    return todos.slice(0, EVENTOS_DEL_HISTORIAL);
  }, [historia, liveEvents, droneId]);

  const paginas = Math.max(1, Math.ceil(eventos.length / EVENTOS_POR_PAGINA));
  // Con la lista cortada en cien no puede achicarse, pero la página pedida
  // nunca puede quedar más allá de la última.
  const actual = Math.min(pagina, paginas);
  const visibles = eventos.slice((actual - 1) * EVENTOS_POR_PAGINA, actual * EVENTOS_POR_PAGINA);

  // Cambiar de página es empezar a leer otra tanda: desde arriba.
  useEffect(() => {
    if (lista.current) lista.current.scrollTop = 0;
  }, [actual]);

  // En una pantalla angosta el detalle queda debajo de la lista, fuera de la
  // vista: se lo trae. En una ancha ya está a la vista y esto no mueve nada.
  const idAbierto = abierto?.id;
  const rotulo = abierto ? etiquetaDeEvento(abierto.type) : null;
  useEffect(() => {
    if (idAbierto !== undefined) panel.current?.scrollIntoView?.({ block: 'nearest' });
  }, [idAbierto]);

  /** Cerrar el detalle devuelve el foco a la fila que lo abrió: si no, se caía al principio de la página. */
  function cerrarDetalle() {
    lista.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
    setAbierto(null);
  }

  return (
    // Con un evento abierto, Escape cierra sólo su detalle y el foco vuelve a
    // la fila: el operador que recorre el historial uno por uno no pierde la
    // página en la que estaba. El segundo Escape ya cierra el pop-up.
    <Modal etiquetadoPor={idTitulo} ancho onCerrar={onCerrar} onEscape={abierto ? cerrarDetalle : undefined}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            Historial de eventos
          </h2>
          <p className="modal-subtitulo">{`${nombre} · los últimos ${EVENTOS_DEL_HISTORIAL}`}</p>
        </div>
        <button type="button" className="modal-cerrar" aria-label="Cerrar el historial" onClick={onCerrar}>
          <IconoCerrar />
        </button>
      </header>

      <div className={abierto ? 'modal-cuerpo historial con-detalle' : 'modal-cuerpo historial'}>
        <section ref={lista} className="historial-lista" aria-label="Eventos del dron">
          {error && (
            <p className="aviso malo" role="alert">
              No se pudo traer el historial: {error}
            </p>
          )}
          {/* Con el pedido caído y nada en vivo, "Sin eventos" contradiría el error. */}
          {(!error || eventos.length > 0) && (
            <EventLog events={visibles} cargando={!cargado} seleccionado={idAbierto ?? null} onAbrir={setAbierto} />
          )}
          {eventos.length > 0 && (
            <nav className="paginador" aria-label="Páginas del historial">
              <div className="paginador-botones">
                <button type="button" className="chico" disabled={actual <= 1} onClick={() => setPagina(actual - 1)}>
                  Anterior
                </button>
              </div>
              <span className="paginador-info" aria-live="polite">
                Página <strong>{actual}</strong> de <strong>{paginas}</strong> · <strong>{eventos.length}</strong>{' '}
                {eventos.length === 1 ? 'evento' : 'eventos'}
              </span>
              <div className="paginador-botones">
                <button
                  type="button"
                  className="chico"
                  disabled={actual >= paginas}
                  onClick={() => setPagina(actual + 1)}
                >
                  Siguiente
                </button>
              </div>
            </nav>
          )}
        </section>

        {abierto && (
          <section ref={panel} className="historial-detalle" aria-labelledby={idDetalle}>
            <header className="historial-detalle-cabecera">
              <div>
                <h3 className="historial-detalle-titulo" id={idDetalle}>
                  {abierto.message}
                </h3>
                <p className="modal-subtitulo">
                  {rotulo && <span>{`${rotulo} · `}</span>}
                  <span className="mono">{abierto.type}</span>
                  {` · ${fechaYHora(abierto.ts)}`}
                </p>
              </div>
              <button
                type="button"
                className="modal-cerrar"
                aria-label="Cerrar el detalle del evento"
                onClick={cerrarDetalle}
              >
                <IconoCerrar />
              </button>
            </header>
            {/* Por id: cada evento arranca su detalle de cero (su alerta, su mapa). */}
            <DetalleDeEvento key={abierto.id} fila={abierto} onIrAlVideo={onCerrar} />
          </section>
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
