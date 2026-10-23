import {
  batteryClass,
  duracion,
  formatDistance,
  posicionDelDron,
  signalClass,
  sobreObjetivo,
  stateLabel,
  textoSinGps,
  waypointLabel,
} from '../format';
import type { Autonomia, Base, DroneStatus } from '../types';

function esNumero(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Lo que el dron calcula que le cuesta volver (`status.autonomia`), en
 * renglones. Es a título informativo (el que decide volver es el dron), pero
 * explica por qué un dron con 40 % se vuelve: lejos de casa, 40 % puede ser lo
 * justo. Cada dato que no vino no ocupa renglón.
 */
function datosDeAutonomia(a: Autonomia | undefined): { rotulo: string; valor: string }[] {
  if (!a) return [];
  const datos: { rotulo: string; valor: string }[] = [];
  if (esNumero(a.pctParaVolver)) datos.push({ rotulo: 'Batería para volver', valor: `${Math.round(a.pctParaVolver)}%` });
  if (esNumero(a.pctParaAterrizar)) {
    datos.push({ rotulo: 'Batería para aterrizar', valor: `${Math.round(a.pctParaAterrizar)}%` });
  }
  if (esNumero(a.alcanceM)) datos.push({ rotulo: 'Alcance', valor: formatDistance(a.alcanceM) });
  if (esNumero(a.segundosParaVolver)) datos.push({ rotulo: 'Tiempo para volver', valor: duracion(a.segundosParaVolver) });
  return datos;
}

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

/**
 * En el aire o en el suelo, y a qué altura. Es lo primero que hay que saber
 * antes de agarrar el mando: en el suelo la app rechaza las palancas y las
 * flechas, y antes la consola decía "En vuelo" con el dron apoyado.
 */
function textoDeVuelo(status: DroneStatus): string | null {
  const altura = typeof status.alt === 'number' && Number.isFinite(status.alt) ? status.alt : null;
  if (status.flying === false) return 'En el suelo';
  if (status.flying === true) return altura !== null ? `En el aire, a ${altura.toFixed(0)} m` : 'En el aire';
  // Una app vieja no manda `flying`: sin ese dato no se afirma nada.
  return null;
}

export default function DroneStatusCard({
  status,
  base,
  controlTomado = false,
  onResumePatrol,
}: {
  status: DroneStatus | null;
  /** Base de retorno del dron: de ella salen las rutas que puede patrullar. */
  base?: Base | null;
  /**
   * Si alguien tiene el control manual. Con el control tomado, sacar al dron
   * del objetivo pasa por soltar el control, que es otra decisión (y otro
   * botón): acá no se ofrece reanudar.
   */
  controlTomado?: boolean;
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
  const enObjetivo = sobreObjetivo(status.state);
  const posicion = posicionDelDron(status);
  const vuelo = textoDeVuelo(status);
  // Al lado del estado, en la línea que se mira, va también la falta de GPS:
  // es lo que explica que el dron no aparezca en el mapa y que las flechas no
  // anden. Las coordenadas en sí quedan en el segundo nivel.
  const detalleDeVuelo = [vuelo, posicion ? null : 'sin GPS'].filter(Boolean).join(' · ');
  const autonomia = datosDeAutonomia(status.autonomia);
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
          <strong className={`estado-actual ${enObjetivo ? 'accent' : ''}`}>{stateLabel(status.state)}</strong>
          {detalleDeVuelo && (
            <span className="muted" data-testid="detalle-de-vuelo">
              {detalleDeVuelo}
            </span>
          )}
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
            {posicion ? (
              <strong className="mono">
                {posicion[0].toFixed(5)}, {posicion[1].toFixed(5)}
              </strong>
            ) : (
              <strong className="bad">{textoSinGps(status.satellites)}</strong>
            )}
          </div>
          {typeof status.alt === 'number' && Number.isFinite(status.alt) && (
            <div>
              <span>Altura</span>
              <strong>{status.alt.toFixed(1)} m</strong>
            </div>
          )}
          {typeof status.satellites === 'number' && (
            <div>
              <span>Satélites</span>
              <strong>{status.satellites}</strong>
            </div>
          )}
          {/* Texto del SDK, tal cual: ATTI quiere decir que el dron no se
              sostiene solo en el lugar, y el que pilotea tiene que saberlo. */}
          {status.flightMode && (
            <div>
              <span>Modo de vuelo</span>
              <strong className="mono">{status.flightMode}</strong>
            </div>
          )}
          {autonomia.map((d) => (
            <div key={d.rotulo}>
              <span>{d.rotulo}</span>
              <strong>{d.valor}</strong>
            </div>
          ))}
        </div>
      </details>

      {/* Con un objetivo cargado, "reanudar" no es neutro: el dron deja de
          vigilar lo que detectó. El rótulo lo dice para que nadie lo apriete
          creyendo que el dron va a seguir encima del objetivo. */}
      {enObjetivo && !controlTomado && (
        <button className="resume" onClick={onResumePatrol}>
          {status.target ? 'Dejar el objetivo y reanudar patrullaje' : 'Reanudar patrullaje'}
        </button>
      )}
    </div>
  );
}
