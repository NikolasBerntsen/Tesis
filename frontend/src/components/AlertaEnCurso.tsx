import { time } from '../format';
import type { Alert } from '../types';
import { useDecisionDeAlerta, type DecidirAlerta } from '../useDecisionDeAlerta';

const TIPO = { PERSON: 'PERSONA', VEHICLE: 'VEHÍCULO' } as const;

/**
 * La alerta pendiente del dron, al lado de su video en vivo.
 *
 * Decidir una alerta es comparar dos imágenes: la captura que disparó la
 * detección y lo que el dron está viendo AHORA, sobre el objetivo. Con la
 * captura sólo en la campana del encabezado, el operador iba y venía entre la
 * campana y la vista del dron (y clickear el dron cerraba la campana). Acá las
 * dos imágenes quedan una al lado de la otra, con los botones debajo.
 *
 * La campana sigue existiendo: es la que avisa desde cualquier vista. Las dos
 * deciden con el mismo hook, así que un rechazo se ve igual en las dos.
 */
export default function AlertaEnCurso({
  alerta,
  otrasPendientes,
  siguiendo,
  onDecidir,
}: {
  alerta: Alert;
  /** Cuántas pendientes MÁS tiene este dron, además de la que se muestra. */
  otrasPendientes: number;
  /** Si el objetivo que el dron está orbitando o siguiendo es el de esta alerta. */
  siguiendo: boolean;
  onDecidir: DecidirAlerta;
}) {
  const { decidir, errorDe, decidiendo } = useDecisionDeAlerta(onDecidir);
  const error = errorDe(alerta.id);
  const ocupado = decidiendo(alerta.id);

  return (
    <section className="card alerta-en-curso" aria-labelledby={`alerta-en-curso-${alerta.id}`}>
      <div className="alert-head">
        <h2 id={`alerta-en-curso-${alerta.id}`}>Alerta en curso</h2>
        <span className={`badge ${alerta.type.toLowerCase()}`}>{TIPO[alerta.type] ?? alerta.type}</span>
        <time className="mono muted" dateTime={alerta.created_at}>
          {time(alerta.created_at)}
        </time>
      </div>
      {alerta.snapshot ? (
        <img
          className="snapshot"
          src={`data:image/jpeg;base64,${alerta.snapshot}`}
          alt="Captura que disparó la detección"
        />
      ) : (
        // No `.video`: en el par del video y el mapa esa clase fija 420 px de
        // alto, y un aviso de una línea quedaría flotando en un hueco enorme.
        <p className="vacio">La alerta llegó sin captura</p>
      )}
      <p className="muted">
        {siguiendo
          ? 'El dron está sobre este objetivo: compará la captura con el video en vivo antes de decidir.'
          : 'Compará la captura con el video en vivo antes de decidir.'}
      </p>
      <div className="alert-actions">
        <button className="validate" disabled={ocupado} onClick={() => decidir(alerta.id, 'VALIDATED')}>
          Validar
        </button>
        <button className="dismiss" disabled={ocupado} onClick={() => decidir(alerta.id, 'DISMISSED')}>
          Descartar
        </button>
      </div>
      {/* Lo que hace cada botón con el dron, dicho antes de apretarlo: validar
          no lo "libera", y descartar lo saca de encima del objetivo. */}
      <p className="muted alerta-consecuencias">
        Validar: el dron se queda sobre el objetivo hasta que lo mandes a patrullar. Descartar: retoma la ruta
        hacia el próximo nodo.
      </p>
      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}
      {otrasPendientes > 0 && (
        <p className="muted">
          {otrasPendientes === 1
            ? 'Este dron tiene otra alerta sin decidir: está en la campana.'
            : `Este dron tiene otras ${otrasPendientes} alertas sin decidir: están en la campana.`}
        </p>
      )}
    </section>
  );
}
