import { useEffect, useId, useMemo, useState } from 'react';
import { api, traerDrones } from '../api';
import type { BaseAsset, Drone } from '../types';
import { useAvisar } from './AvisosFlotantes';
import DialogoConfirmacion from './DialogoConfirmacion';
import { IconoCerrar, IconoDron } from './Iconos';
import Modal from './Modal';

/** Los estados en los que un dron está en el aire, para una app vieja que no manda `flying`. */
const EN_EL_AIRE = ['PATROLLING', 'ORBITING', 'FOLLOWING', 'VIGILANDO', 'RETURNING_HOME_SIGNAL', 'RETURNING_HOME_BATTERY', 'RETURNING_HOME', 'PAUSED', 'MANUAL', 'FORCED', 'RELEVANDO', 'ATERRIZAJE_EMERGENCIA'];

/**
 * Si el dron está volando ahora. A uno en el aire no se le cambia la base: es a
 * la que vuelve, y el Comando Central lo rechaza igual (409).
 */
export function estaEnVuelo(d: Drone): boolean {
  if (!d.online || !d.lastStatus) return false;
  if (typeof d.lastStatus.flying === 'boolean') return d.lastStatus.flying;
  return EN_EL_AIRE.includes(d.lastStatus.state);
}

function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Los drones ordenados para asignar: primero los que no tienen base (son los
 * que hay que asignar), después los de otras bases, y al final los que ya están
 * en esta; dentro de cada grupo, por nombre.
 */
export function ordenarParaAsignar(drones: readonly Drone[], baseId: number): Drone[] {
  const grupo = (d: Drone) => (d.baseId === null ? 0 : d.baseId === baseId ? 2 : 1);
  return [...drones]
    .filter((d) => !d.deleted)
    .sort((a, b) => grupo(a) - grupo(b) || a.displayName.localeCompare(b.displayName, 'es'));
}

/** Si el dron coincide con lo que se escribió en el buscador: nombre, modelo, inventario o su base. */
function coincide(d: Drone, q: string): boolean {
  if (!q) return true;
  return [d.displayName, d.model, d.inventoryCode, d.base?.name ?? ''].some((t) => t.toLowerCase().includes(q));
}

/**
 * El último paso del alta de una base: asignarle un dron. Lista todos los
 * drones del inventario con los que no tienen base primero —son los que hay que
 * asignar—, con un buscador, y dice de cada uno dónde está hoy. Elegir uno sin
 * base lo asigna en el acto; uno que ya es de otra base pide confirmación antes
 * de sacárselo; uno que está volando no se puede tocar hasta que aterrice.
 *
 * El cambio va por `PATCH /drones/:hash` con `baseId`, que es lo que el
 * Comando Central ya sabe hacer: avisa a las consolas (`drone_updated`) y le
 * manda al dron su lista de bases nueva, con cuál es la suya.
 */
export default function AsignarDronALaBase({
  base,
  onCerrar,
  onAsignado,
}: Readonly<{
  base: BaseAsset;
  onCerrar: () => void;
  /** El dron recién asignado, con su ficha ya actualizada. */
  onAsignado?: (dron: Drone) => void;
}>) {
  const [drones, setDrones] = useState<Drone[] | null>(null);
  const [error, setError] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [reasignando, setReasignando] = useState<Drone | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null);
  const avisar = useAvisar();
  const idTitulo = useId();
  const idTexto = useId();

  useEffect(() => {
    let vigente = true;
    traerDrones()
      .then((lista) => vigente && setDrones(Array.isArray(lista) ? lista : []))
      .catch((e) => vigente && setError(textoError(e)));
    return () => {
      vigente = false;
    };
  }, []);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return ordenarParaAsignar(drones ?? [], base.id).filter((d) => coincide(d, q));
  }, [drones, busqueda, base.id]);

  /** Manda la asignación; el error sube para que lo lea quien lo mostró (el diálogo o la lista). */
  async function asignar(d: Drone): Promise<void> {
    setError('');
    setGuardando(d.hash);
    try {
      const ficha = await api<Drone>(`/drones/${d.hash}`, { method: 'PATCH', body: JSON.stringify({ baseId: base.id }) });
      avisar(`${ficha.displayName} asignado a ${base.name}.`);
      onAsignado?.(ficha);
      onCerrar();
    } finally {
      setGuardando(null);
    }
  }

  function elegir(d: Drone) {
    if (d.baseId === null) {
      asignar(d).catch((e) => setError(textoError(e)));
      return;
    }
    setReasignando(d);
  }

  /** Por qué no se puede elegir este dron, o null si se puede. */
  function impedimento(d: Drone): string | null {
    if (d.baseId === base.id) return 'Ya está en esta base';
    if (estaEnVuelo(d)) return 'En vuelo: se le cambia la base cuando aterrice';
    return null;
  }

  return (
    <Modal etiquetadoPor={idTitulo} descritoPor={idTexto} onCerrar={onCerrar}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            ¿Asignar un dron a {base.name}?
          </h2>
          <p className="modal-subtitulo">Los que no tienen base van primero</p>
        </div>
        <button type="button" className="modal-cerrar" aria-label="Cerrar" onClick={onCerrar}>
          <IconoCerrar tamano={18} />
        </button>
      </header>
      <div className="modal-cuerpo form-base">
        <p className="muted" id={idTexto}>
          El dron que elijas pasa a volver a <strong>{base.name}</strong> y a patrullar sus rutas. Uno que ya es de otra
          base se te pregunta antes; uno que está volando no se puede reasignar hasta que aterrice.
        </p>
        {error && (
          <p className="aviso malo" role="alert">
            {error}
          </p>
        )}
        <input
          className="buscador"
          type="search"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar un dron por nombre, modelo, inventario o base…"
          aria-label="Buscar drones"
        />
        {drones === null && !error && <p className="muted">Trayendo los drones…</p>}
        {drones !== null && visibles.length === 0 && <p className="vacio">No hay drones que coincidan.</p>}
        <ul className="lista-bases lista-drones-para-asignar" role="listbox" aria-label="Drones">
          {visibles.map((d) => {
            const porque = impedimento(d);
            return (
              <li key={d.hash}>
                <button
                  type="button"
                  role="option"
                  aria-selected={d.baseId === base.id}
                  aria-disabled={porque !== null || undefined}
                  disabled={porque !== null || guardando !== null}
                  className={d.baseId === null ? 'sin-base' : ''}
                  onClick={() => elegir(d)}
                >
                  <span className="inscripcion">
                    <IconoDron tamano={16} />
                    {d.displayName}
                    {d.model && <span className="muted"> · {d.model}</span>}
                  </span>
                  <span className={`estado ${d.baseId === null ? 'ok' : porque ? 'muted' : 'info'}`}>
                    {porque ?? (d.baseId === null ? 'Sin base' : `Hoy vuelve a ${d.base?.name ?? 'otra base'}`)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <footer className="modal-pie">
        <button type="button" onClick={onCerrar}>
          Ahora no
        </button>
      </footer>

      {reasignando && (
        <DialogoConfirmacion
          pedido={{
            titulo: `Reasignar ${reasignando.displayName} a ${base.name}`,
            consecuencia: `${reasignando.displayName} hoy es de la base ${reasignando.base?.name ?? 'otra'}: si lo reasignás, deja de volver ahí y pasa a volver a ${base.name}.`,
            detalle: 'La app del dron se entera en el acto si está conectada, y sus rutas pasan a ser las de la base nueva.',
            confirmar: 'Reasignar',
            enCurso: 'Reasignando…',
            tono: 'primario',
            accion: () => asignar(reasignando),
          }}
          onCerrar={() => setReasignando(null)}
        />
      )}
    </Modal>
  );
}
