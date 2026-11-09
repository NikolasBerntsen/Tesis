import { useEffect, useId, useMemo, useState } from 'react';
import { useDronDeLaAlerta } from '../alertasEnVivo';
import { time } from '../format';
import type { Alert } from '../types';
import { useDecisionDeAlerta, type DecidirAlerta, type Decision } from '../useDecisionDeAlerta';
import AlertaEnCurso from './AlertaEnCurso';
import DialogoConfirmacion from './DialogoConfirmacion';
import { IconoCerrar } from './Iconos';
import Modal from './Modal';
import { BotonesDeDecision, ChipDeTipo } from './PiezasDeAlerta';
import VisorAmpliado from './VisorAmpliado';

type Vista = 'una' | 'todas';

/** Lo que se le dice antes de decidir varias de un saque. */
const CONSECUENCIA: Record<Decision, (n: number) => string> = {
  DISMISSED: (n) =>
    `Las ${n} alertas quedan descartadas como falsos positivos. Si el dron está sobre el objetivo de alguna, ` +
    'retoma la ruta hacia el próximo nodo.',
  VALIDATED: (n) =>
    `Las ${n} alertas quedan validadas como reales. El dron que esté sobre un objetivo se queda ahí hasta que lo ` +
    'mandes a patrullar.',
};

/**
 * Una alerta en la grilla: la casilla para seleccionarla, qué es y cuándo, la
 * captura (que se amplía al tocarla) y su par de Validar y Descartar. Con
 * `key` por id, como en el carrusel: al irse una, la vecina no hereda sus
 * botones ni su casilla.
 */
function FichaDeAlerta({
  alerta,
  seleccionada,
  ocupado,
  error,
  onSeleccionar,
  onAmpliar,
  onDecidir,
}: Readonly<{
  alerta: Alert;
  seleccionada: boolean;
  ocupado: boolean;
  error: string | null;
  onSeleccionar: (si: boolean) => void;
  onAmpliar: () => void;
  onDecidir: (decision: Decision) => void;
}>) {
  // El dron de la alerta, para el engranaje del silencio: el que la sigue ahora.
  const dron = useDronDeLaAlerta(alerta);
  return (
    <li className={seleccionada ? 'alerta-ficha seleccionada' : 'alerta-ficha'}>
      <div className="alerta-ficha-cabecera">
        <label className="alerta-ficha-marca">
          <input
            type="checkbox"
            checked={seleccionada}
            aria-label={`Seleccionar la alerta #${alerta.id}`}
            onChange={(e) => onSeleccionar(e.target.checked)}
          />
        </label>
        <ChipDeTipo tipo={alerta.type} tamanoIcono={18} />
        <span className="mono muted">
          #{alerta.id} · <time dateTime={alerta.created_at}>{time(alerta.created_at)}</time>
        </span>
      </div>
      {alerta.snapshot ? (
        <button
          type="button"
          className="snapshot-boton"
          aria-label={`Ampliar la captura de la alerta #${alerta.id}`}
          onClick={onAmpliar}
        >
          <img className="snapshot" src={`data:image/jpeg;base64,${alerta.snapshot}`} alt="Detección" />
        </button>
      ) : (
        <p className="vacio">La detección no dejó captura.</p>
      )}
      <BotonesDeDecision ocupado={ocupado} tamanoIcono={18} dron={dron} onDecidir={onDecidir} />
      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * El pop-up de las alertas pendientes de un dron, que abre el botón de alertas
 * de su vista. Tiene dos formas de mirarlas:
 *
 *  - **una por vez**: el carrusel de siempre (AlertaEnCurso), con la captura
 *    grande y las flechas, para decidir mirando bien cada una;
 *  - **todas**: una grilla con la captura chica de cada una y una casilla por
 *    alerta, para elegir varias y validarlas o descartarlas juntas. Hace falta
 *    porque un objeto quieto delante de la cámara dispara la misma alerta
 *    varias veces seguidas, y decidirlas de a una era apretar el mismo botón
 *    cinco veces.
 *
 * Decidir varias pide confirmación: son varias decisiones de una, y la
 * descartada que estaba mal elegida no vuelve. Las capturas se amplían al
 * tocarlas, en la grilla y en el carrusel (que además abre el pop-up entero
 * de la alerta, con el mapa).
 */
export default function AlertasDelDron({
  nombre,
  alertas,
  seguidas = [],
  onDecidir,
  onCerrar,
}: Readonly<{
  nombre: string;
  /** Las pendientes del dron, en cualquier orden. */
  alertas: readonly Alert[];
  /** Ids de las alertas cuyo objetivo el dron tiene encima: lo orbita, lo sigue o lo vigila. */
  seguidas?: readonly (number | null)[];
  onDecidir: DecidirAlerta;
  onCerrar: () => void;
}>) {
  const [vista, setVista] = useState<Vista>('una');
  const [seleccion, setSeleccion] = useState<ReadonlySet<number>>(() => new Set());
  const [ampliada, setAmpliada] = useState<Alert | null>(null);
  const [confirmando, setConfirmando] = useState<{ decision: Decision; ids: number[] } | null>(null);
  const { decidir, errorDe, decidiendo } = useDecisionDeAlerta(onDecidir);
  const idTitulo = useId();
  const idSubtitulo = useId();

  // La más nueva primero, como en el carrusel.
  const ordenadas = useMemo(() => [...alertas].sort((a, b) => b.id - a.id), [alertas]);

  // Una alerta que se fue (la decidió otro, o se decidió acá) sale de la
  // selección sola: una decisión en lote no puede llevarse una que ya no está.
  useEffect(() => {
    const vivas = new Set(alertas.map((a) => a.id));
    setSeleccion((prev) => {
      const quedan = [...prev].filter((id) => vivas.has(id));
      return quedan.length === prev.size ? prev : new Set(quedan);
    });
  }, [alertas]);

  // La captura ampliada de una alerta que se decidió se cierra con ella.
  useEffect(() => {
    if (ampliada && !alertas.some((a) => a.id === ampliada.id)) setAmpliada(null);
  }, [alertas, ampliada]);

  function seleccionar(id: number, si: boolean) {
    setSeleccion((prev) => {
      const siguiente = new Set(prev);
      if (si) siguiente.add(id);
      else siguiente.delete(id);
      return siguiente;
    });
  }

  const ids = ordenadas.map((a) => a.id);
  const todasSeleccionadas = ids.length > 0 && ids.every((id) => seleccion.has(id));
  const n = seleccion.size;

  /** Decide las seleccionadas, todas a la vez; cada rechazo queda al lado de su alerta. */
  async function decidirSeleccionadas(decision: Decision) {
    const elegidas = [...seleccion];
    await Promise.all(elegidas.map((id) => decidir(id, decision)));
    setSeleccion(new Set());
  }

  const pendientes = ordenadas.length;
  const subtitulo = pendientes === 0 ? 'Sin alertas pendientes' : `${pendientes} ${pendientes === 1 ? 'pendiente' : 'pendientes'}`;

  return (
    <Modal etiquetadoPor={idTitulo} descritoPor={idSubtitulo} ancho onCerrar={onCerrar}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            Alertas de {nombre}
          </h2>
          <p className="modal-subtitulo" id={idSubtitulo} aria-live="polite">
            {subtitulo}
          </p>
        </div>
        <div className="view-switch" role="group" aria-label="Cómo ver las alertas">
          <button
            type="button"
            className={vista === 'una' ? 'active' : ''}
            aria-pressed={vista === 'una'}
            onClick={() => setVista('una')}
          >
            Una por vez
          </button>
          <button
            type="button"
            className={vista === 'todas' ? 'active' : ''}
            aria-pressed={vista === 'todas'}
            onClick={() => setVista('todas')}
          >
            Todas
          </button>
        </div>
        <button type="button" className="modal-cerrar" aria-label="Cerrar las alertas" onClick={onCerrar}>
          <IconoCerrar tamano={18} />
        </button>
      </header>

      <div className="modal-cuerpo alertas-del-dron">
        {pendientes === 0 && <p className="vacio">No quedan alertas pendientes de {nombre}.</p>}

        {pendientes > 0 && vista === 'una' && (
          <AlertaEnCurso alertas={ordenadas} titulo="Alerta en curso" seguidas={seguidas} onDecidir={onDecidir} />
        )}

        {pendientes > 0 && vista === 'todas' && (
          <>
            {/* La barra de la selección: elegir todas o ninguna, cuántas hay
                elegidas, y los dos verbos para todas las elegidas. */}
            <div className="alertas-seleccion" role="toolbar" aria-label="Decidir varias alertas">
              <button
                type="button"
                className="chico"
                onClick={() => setSeleccion(todasSeleccionadas ? new Set() : new Set(ids))}
              >
                {todasSeleccionadas ? 'Ninguna' : 'Seleccionar todas'}
              </button>
              <span className="muted" role="status" data-testid="cuenta-seleccion">
                {n === 0 ? 'Ninguna seleccionada' : n === 1 ? '1 seleccionada' : `${n} seleccionadas`}
              </span>
              <div className="alert-actions">
                <button
                  type="button"
                  className="validate"
                  disabled={n === 0}
                  onClick={() => setConfirmando({ decision: 'VALIDATED', ids: [...seleccion] })}
                >
                  Validar las seleccionadas
                </button>
                <button
                  type="button"
                  className="dismiss"
                  disabled={n === 0}
                  onClick={() => setConfirmando({ decision: 'DISMISSED', ids: [...seleccion] })}
                >
                  Descartar las seleccionadas
                </button>
              </div>
            </div>
            <ul className="alertas-grilla" aria-label={`Alertas pendientes de ${nombre}`}>
              {ordenadas.map((a) => (
                <FichaDeAlerta
                  key={a.id}
                  alerta={a}
                  seleccionada={seleccion.has(a.id)}
                  ocupado={decidiendo(a.id)}
                  error={errorDe(a.id)}
                  onSeleccionar={(si) => seleccionar(a.id, si)}
                  onAmpliar={() => setAmpliada(a)}
                  onDecidir={(decision) => void decidir(a.id, decision)}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <footer className="modal-pie">
        <button type="button" onClick={onCerrar}>
          Cerrar
        </button>
      </footer>

      {ampliada?.snapshot && (
        <VisorAmpliado
          titulo={`Captura de la alerta #${ampliada.id}`}
          subtitulo={`${nombre} · ${time(ampliada.created_at)}`}
          src={`data:image/jpeg;base64,${ampliada.snapshot}`}
          alt={`Captura de la alerta #${ampliada.id}`}
          onCerrar={() => setAmpliada(null)}
        />
      )}

      {confirmando && (
        <DialogoConfirmacion
          pedido={{
            titulo: `${confirmando.decision === 'DISMISSED' ? 'Descartar' : 'Validar'} ${confirmando.ids.length} alertas`,
            consecuencia: CONSECUENCIA[confirmando.decision](confirmando.ids.length),
            detalle: 'Cada decisión queda en el registro con tu usuario, como si la hubieras tomado de a una.',
            confirmar: confirmando.decision === 'DISMISSED' ? 'Descartar todas' : 'Validar todas',
            enCurso: 'Decidiendo…',
            tono: confirmando.decision === 'DISMISSED' ? 'peligro' : 'primario',
            accion: () => decidirSeleccionadas(confirmando.decision),
          }}
          onCerrar={() => setConfirmando(null)}
        />
      )}
    </Modal>
  );
}
