import { batteryClass, signalClass, stateLabel, waypointLabel } from '../format';
import type { Base, DroneStatus } from '../types';

/**
 * Hairline con relleno dorado en lugar de una barra de progreso: el nivel se
 * capta de un vistazo sin leer la cifra. Queda fuera del árbol de
 * accesibilidad porque la cifra de arriba ya dice exactamente lo mismo.
 */
function Medidor({ pct }: { pct: number }) {
  const nivel = Math.min(100, Math.max(0, pct));
  return (
    <div className="medidor" aria-hidden="true">
      <span className="medidor-relleno" style={{ width: `${nivel}%` }} />
    </div>
  );
}

export default function DroneStatusCard({
  status,
  base,
  onResumePatrol,
}: {
  status: DroneStatus | null;
  /** Base de retorno del dron: de ella salen las rutas que puede patrullar. */
  base?: Base | null;
  onResumePatrol: () => void;
}) {
  if (!status) {
    return (
      <div className="card con-esquina">
        <h2>Estado del dron</h2>
        <p className="vacio">Sin datos — el dron todavía no reportó estado.</p>
      </div>
    );
  }

  const sinSenal = status.signal !== 'OK';
  const recorrido = status.waypointTotal
    ? ((status.waypointIndex + 1) / status.waypointTotal) * 100
    : 0;

  return (
    <div className="card">
      <h2>Estado del dron</h2>

      {/* Las tres cifras que el operador mira primero: van grabadas en grande
          y con la unidad chica, para que se lean antes que nada. */}
      <div className="status-grid">
        <div>
          <span>Batería</span>
          <span className={`cifra ${batteryClass(status.battery)}`}>
            {status.battery.toFixed(0)}
            <span className="cifra-unidad versalita">%</span>
          </span>
          <Medidor pct={status.battery} />
        </div>
        <div>
          <span>Señal RC</span>
          {sinSenal ? (
            <span className="cifra-chica estado bad">PERDIDA</span>
          ) : (
            <span className={`cifra ${signalClass(status.signalPct)}`}>
              {status.signalPct}
              <span className="cifra-unidad versalita">%</span>
            </span>
          )}
          <Medidor pct={sinSenal ? 0 : status.signalPct} />
        </div>
        <div>
          <span>Estado</span>
          <strong className={`estado-actual ${status.state === 'ORBITING' ? 'accent' : ''}`}>
            {stateLabel(status.state)}
          </strong>
        </div>
        <div>
          <span>Nodo</span>
          {status.waypointTotal > 0 ? (
            <>
              <span className="cifra">{waypointLabel(status)}</span>
              <Medidor pct={recorrido} />
            </>
          ) : (
            /* Sin ruta cargada la raya no es un dato: en cuerpo de cifra
               parecería un separador grabado, así que va chica y apagada. */
            <span className="cifra-chica muted">{waypointLabel(status)}</span>
          )}
        </div>
      </div>

      {/* Modo y posición se consultan de vez en cuando, no se vigilan: van
          plegados para que el video y el mapa entren en la misma pantalla. */}
      <details className="status-segundo-nivel">
        <summary>Modo y posición</summary>
        <div className="status-grid">
          <div>
            <span>Modo</span>
            <strong>{status.mode}</strong>
          </div>
          {/* La base decide qué rutas puede volar este dron, así que tenerla a
              mano evita ir hasta la vista de activos para saber cuál es. */}
          <div>
            <span>Base</span>
            {base ? (
              <>
                <strong>{base.name}</strong>
                <span className="muted mono">
                  {base.lat.toFixed(5)}, {base.lon.toFixed(5)}
                </span>
              </>
            ) : (
              <strong className="muted">Sin base asignada</strong>
            )}
          </div>
          <div>
            <span>Posición</span>
            <strong className="mono">
              {status.lat.toFixed(5)}, {status.lon.toFixed(5)}
            </strong>
          </div>
        </div>
      </details>

      {status.state === 'ORBITING' && (
        <button className="resume" onClick={onResumePatrol}>
          Reanudar patrullaje
        </button>
      )}
    </div>
  );
}
