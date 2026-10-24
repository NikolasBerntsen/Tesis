import {
  batteryClass,
  duracion,
  formatDistance,
  posicionDelDron,
  signalClass,
  sobreObjetivo,
  stateLabel,
  textoSinGps,
  tonoDelEstadoDelDron,
  waypointLabel,
} from '../format';
import type { Autonomia, Base, DroneStatus } from '../types';
import { IconoDron, IconoReanudar } from './Iconos';

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
 * capta de un vistazo sin leer la cifra. Con `nivel` es la barra gruesa de la
 * batería, teñida como su cifra (la de las cámaras del tablero). Queda fuera
 * del árbol de accesibilidad porque la cifra de arriba ya dice lo mismo.
 */
function Medidor({ pct, nivel }: Readonly<{ pct: number; nivel?: string }>) {
  const ancho = Math.min(100, Math.max(0, pct));
  return (
    <div className={nivel ? 'medidor barra' : 'medidor'} aria-hidden="true">
      <span className={nivel ? `medidor-relleno ${nivel}` : 'medidor-relleno'} style={{ width: `${ancho}%` }} />
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

/** El título de la tarjeta, con el dron del prototipo. */
function Titulo() {
  return (
    <h2>
      <IconoDron />
      Estado del dron
    </h2>
  );
}

/**
 * Modo y posición: se consultan de vez en cuando, no se vigilan, así que van
 * plegados para que el video y el mapa entren en la misma pantalla.
 */
function SegundoNivel({ status, base }: Readonly<{ status: DroneStatus; base?: Base | null }>) {
  const posicion = posicionDelDron(status);
  return (
    <details className="status-segundo-nivel">
      <summary>Modo y posición</summary>
      <dl className="status-grid">
        <div>
          <dt className="rotulo">Modo</dt>
          <dd>
            <strong>{status.mode}</strong>
          </dd>
        </div>
        {/* La base decide qué rutas puede volar este dron, así que tenerla a
            mano evita ir hasta la vista de activos para saber cuál es. */}
        <div>
          <dt className="rotulo">Base</dt>
          {base ? (
            <dd>
              <strong>{base.name}</strong>
              <span className="muted mono">
                {base.lat.toFixed(5)}, {base.lon.toFixed(5)}
              </span>
            </dd>
          ) : (
            <dd>
              <strong className="muted">Sin base asignada</strong>
            </dd>
          )}
        </div>
        <div>
          <dt className="rotulo">Posición</dt>
          <dd>
            {posicion ? (
              <strong className="mono">
                {posicion[0].toFixed(5)}, {posicion[1].toFixed(5)}
              </strong>
            ) : (
              <strong className="bad">{textoSinGps(status.satellites)}</strong>
            )}
          </dd>
        </div>
        {typeof status.alt === 'number' && Number.isFinite(status.alt) && (
          <div>
            <dt className="rotulo">Altura</dt>
            <dd>
              <strong>{status.alt.toFixed(1)} m</strong>
            </dd>
          </div>
        )}
        {typeof status.satellites === 'number' && (
          <div>
            <dt className="rotulo">Satélites</dt>
            <dd>
              <strong>{status.satellites}</strong>
            </dd>
          </div>
        )}
        {/* Texto del SDK, tal cual: ATTI quiere decir que el dron no se
            sostiene solo en el lugar, y el que pilotea tiene que saberlo. */}
        {status.flightMode && (
          <div>
            <dt className="rotulo">Modo de vuelo</dt>
            <dd>
              <strong className="mono">{status.flightMode}</strong>
            </dd>
          </div>
        )}
        {datosDeAutonomia(status.autonomia).map((d) => (
          <div key={d.rotulo}>
            <dt className="rotulo">{d.rotulo}</dt>
            <dd>
              <strong>{d.valor}</strong>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * La telemetría del dron: un panel con la batería en grande (la cifra en
 * Cormorant y su barra teñida por nivel, como en el prototipo) y, al lado, la
 * señal, el estado y el nodo, separados por hilos de oro. Cruza la vista de
 * punta a punta arriba del video: es lo primero que se mira.
 */
export default function DroneStatusCard({
  status,
  base,
  controlTomado = false,
  onResumePatrol,
}: Readonly<{
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
}>) {
  if (!status) {
    return (
      <div className="card telemetria">
        <Titulo />
        <p className="vacio">Sin datos — el dron todavía no reportó estado.</p>
      </div>
    );
  }

  const sinSenal = status.signal !== 'OK';
  const enObjetivo = sobreObjetivo(status.state);
  // Relevar y bajar de emergencia también se resaltan: oro y óxido.
  const tonoDelEstado = tonoDelEstadoDelDron(status.state);
  const claseBateria = batteryClass(status.battery);
  // Al lado del estado, en la línea que se mira, va también la falta de GPS:
  // es lo que explica que el dron no aparezca en el mapa y que las flechas no
  // anden. Las coordenadas en sí quedan en el segundo nivel.
  const detalleDeVuelo = [textoDeVuelo(status), posicionDelDron(status) ? null : 'sin GPS'].filter(Boolean).join(' · ');
  const recorrido = status.waypointTotal ? ((status.waypointIndex + 1) / status.waypointTotal) * 100 : 0;

  return (
    <div className="card telemetria">
      <Titulo />

      {/* La batería manda: la cifra grande y su barra. Las otras tres se leen
          al lado, cada una sobre su hilo de oro. */}
      <dl className="status-grid telemetria-datos">
        <div className="telemetria-bateria">
          <dt className="rotulo">Batería</dt>
          <dd>
            <span className={`cifra ${claseBateria}`}>
              {status.battery.toFixed(0)}
              <span className="cifra-unidad versalita">%</span>
            </span>
            <Medidor pct={status.battery} nivel={claseBateria} />
          </dd>
        </div>
        <div>
          <dt className="rotulo">Señal RC</dt>
          <dd>
            {sinSenal ? (
              <span className="cifra-chica estado bad">PERDIDA</span>
            ) : (
              <span className={`cifra ${signalClass(status.signalPct)}`}>
                {status.signalPct}
                <span className="cifra-unidad versalita">%</span>
              </span>
            )}
            <Medidor pct={sinSenal ? 0 : status.signalPct} />
          </dd>
        </div>
        <div>
          <dt className="rotulo">Estado</dt>
          <dd>
            <strong className={`estado-actual ${tonoDelEstado === 'muted' ? '' : tonoDelEstado}`}>
              {stateLabel(status.state)}
            </strong>
            {detalleDeVuelo && (
              <span className="muted" data-testid="detalle-de-vuelo">
                {detalleDeVuelo}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="rotulo">Nodo</dt>
          {status.waypointTotal > 0 ? (
            <dd>
              <span className="cifra">{waypointLabel(status)}</span>
              <Medidor pct={recorrido} />
            </dd>
          ) : (
            /* Sin ruta cargada la raya no es un dato: en cuerpo de cifra
               parecería un separador grabado, así que va chica y apagada. */
            <dd>
              <span className="cifra-chica muted">{waypointLabel(status)}</span>
            </dd>
          )}
        </div>
      </dl>

      <SegundoNivel status={status} base={base} />

      {/* Con un objetivo cargado, "reanudar" no es neutro: el dron deja de
          vigilar lo que detectó. El rótulo lo dice para que nadie lo apriete
          creyendo que el dron va a seguir encima del objetivo. */}
      {enObjetivo && !controlTomado && (
        <button type="button" className="resume" onClick={onResumePatrol}>
          <IconoReanudar tamano={18} />
          {status.target ? 'Dejar el objetivo y reanudar patrullaje' : 'Reanudar patrullaje'}
        </button>
      )}
    </div>
  );
}
