import { time } from '../format';
import type { EventRow } from '../types';
import { EsqueletoDeTabla, EstadoVacio } from './EstadosDeVista';

// Tipos de evento que ameritan resaltarse en el log del operador
const HIGHLIGHT: Record<string, string> = {
  ALERT_CREATED: 'bad',
  ALERT_VALIDATED: 'warn',
  SIGNAL_LOST: 'bad',
  RTH_LOW_BATTERY: 'warn',
  RTH_SIGNAL_LOSS: 'warn',
};

export default function EventLog({ events, cargando = false }: { events: EventRow[]; cargando?: boolean }) {
  // Lo que llega en vivo se muestra aunque el historial todavía viaje: el
  // esqueleto es sólo para la tarjeta vacía, no tapa eventos que ya están.
  const esperando = cargando && events.length === 0;
  return (
    <div className="card log-card">
      <h2>Registro de eventos</h2>
      {/* El encabezado queda afuera del contenedor que scrollea. Las tres
          columnas son de texto alineado a la izquierda, así que la barra de
          scroll no lo desalinea. */}
      {events.length > 0 && (
        <div className="log-row">
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
        {events.map((e) => (
          <div key={e.id} className="log-row">
            <time className="muted mono" dateTime={e.ts}>
              {time(e.ts)}
            </time>
            <span className={`event-type mono ${HIGHLIGHT[e.type] ?? ''}`}>{e.type}</span>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
