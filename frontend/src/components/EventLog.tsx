import { etiquetaDeEvento, time } from '../format';
import type { EventRow } from '../types';
import { EsqueletoDeTabla, EstadoVacio } from './EstadosDeVista';

// Tipos de evento que ameritan resaltarse en el log del operador
const HIGHLIGHT: Record<string, string> = {
  ALERT_CREATED: 'bad',
  ALERT_VALIDATED: 'warn',
  SIGNAL_LOST: 'bad',
  RTH_LOW_BATTERY: 'warn',
  RTH_SIGNAL_LOSS: 'warn',
  // Un dron que bajó fuera de base es lo más grave que puede pasar en vuelo;
  // un relevo que falla o que no encuentra dron deja un hueco en la guardia.
  EMERGENCY_LANDING: 'bad',
  EMERGENCY_LANDED: 'bad',
  RELAY_FAILED: 'bad',
  RELAY_UNAVAILABLE: 'warn',
  RTH_DIVERTED: 'warn',
};

/**
 * La lista del historial de eventos de un dron. Cada fila se abre: el detalle
 * va al lado, en el mismo pop-up (HistorialDeEventos), y la fila abierta queda
 * marcada para no perder de vista de cuál se está leyendo.
 *
 * Las filas son botones de verdad y no `div` con un manejador: así se llega a
 * ellas con el tabulador y se abren con Enter o Espacio sin código aparte.
 */
export default function EventLog({
  events,
  cargando = false,
  seleccionado = null,
  onAbrir,
}: Readonly<{
  events: readonly EventRow[];
  cargando?: boolean;
  /** Id del evento cuyo detalle está abierto. */
  seleccionado?: number | null;
  onAbrir: (evento: EventRow) => void;
}>) {
  // Lo que llega en vivo se muestra aunque el historial todavía viaje: el
  // esqueleto es sólo para la lista vacía, no tapa eventos que ya están.
  const esperando = cargando && events.length === 0;
  return (
    <div className="log-lista">
      {/* El encabezado queda afuera del contenedor que scrollea. Las tres
          columnas son de texto alineado a la izquierda, así que la barra de
          scroll no lo desalinea. */}
      {events.length > 0 && (
        <div className="log-row log-encabezado">
          <span className="etiqueta">Hora</span>
          <span className="etiqueta">Evento</span>
          <span className="etiqueta">Detalle</span>
        </div>
      )}
      <div className="log">
        {esperando && <EsqueletoDeTabla texto="Trayendo los eventos del dron…" filas={2} />}
        {!cargando && events.length === 0 && (
          <EstadoVacio titulo="Sin eventos registrados.">
            Las alertas, las órdenes y los cambios de estado de este dron van a quedar anotados acá.
          </EstadoVacio>
        )}
        {events.map((e) => {
          const abierto = e.id === seleccionado;
          return (
            <button
              key={e.id}
              type="button"
              className={abierto ? 'log-row log-row-boton cliqueable abierto' : 'log-row log-row-boton cliqueable'}
              aria-current={abierto ? 'true' : undefined}
              aria-label={`Ver el detalle de ${e.type}: ${e.message}`}
              onClick={() => onAbrir(e)}
            >
              <time className="muted mono" dateTime={e.ts}>
                {time(e.ts)}
              </time>
              {/* El código se queda (es lo que se busca en el Registro); el
                  rótulo, para los que la consola conoce, va en el globo. */}
              <span className={`event-type mono ${HIGHLIGHT[e.type] ?? ''}`} title={etiquetaDeEvento(e.type) ?? undefined}>
                {e.type}
              </span>
              <span>{e.message}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
