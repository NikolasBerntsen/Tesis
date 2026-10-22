import { useEffect, useRef, useState } from 'react';
import { api, traerBases, traerDrones } from '../api';
import type { BaseAsset, Drone, Me, NovedadDron } from '../types';
import DialogoDron, { type CuerpoDron } from './DialogoDron';
import QrDronModal from './QrDronModal';

/** Primeros 6 y últimos 4: alcanza para reconocer el dron sin volcar los 32 hex. */
function abreviar(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function upsert(lista: Drone[], ficha: Drone): Drone[] {
  return lista.some((d) => d.hash === ficha.hash)
    ? lista.map((d) => (d.hash === ficha.hash ? ficha : d))
    : [...lista, ficha];
}

/**
 * Qué diálogo de formulario está abierto: ninguno, el alta o la edición de un
 * dron. `undefined` y no `null` para "ninguno", porque `null` ya significa
 * "alta" (un dron que todavía no existe).
 */
type Dialogo = Drone | null | undefined;

type PropsDronesView = {
  me: Me;
  /**
   * Última novedad del canal en vivo: la ficha entera de `drone_updated`
   * (alta, edición, baja y restauración), `drone_online` y `drone_offline`, o
   * el renombre que la app inicia con `set_name`. La vista la mezcla en su
   * lista: con eso se mantiene al día sin volver a consultar cada tanto.
   */
  novedad?: NovedadDron | null;
};

/**
 * Los drones como activos: alta con su QR, edición, baja lógica y restauración.
 * Quién puede qué lo decide el backend; acá se esconde lo que no corresponde
 * para no ofrecer botones que sólo devolverían un 403.
 */
export default function DronesView({ me, novedad = null }: PropsDronesView) {
  const [drones, setDrones] = useState<Drone[]>([]);
  const [cargando, setCargando] = useState(true);
  // Las bases se traen una vez: el selector las necesita para el desplegable.
  const [bases, setBases] = useState<BaseAsset[]>([]);
  const [error, setError] = useState('');
  const [verEliminados, setVerEliminados] = useState(false);
  const [dialogo, setDialogo] = useState<Dialogo>(undefined);
  const [qr, setQr] = useState<Drone | null>(null);
  const [copiado, setCopiado] = useState('');
  const temporizador = useRef<ReturnType<typeof setTimeout>>();

  const esSupervisor = me.role === 'supervisor' || me.role === 'admin';
  const puedeDarDeAlta = esSupervisor || me.role === 'field_operator';
  const mostrarEliminados = esSupervisor && verEliminados;

  // Las bases sólo hacen falta para el selector del formulario: si el pedido
  // falla, la vista sigue andando y el selector queda vacío con su aviso.
  useEffect(() => {
    traerBases({ soloActivas: true })
      // Si el pedido falla o vuelve con algo raro, el selector queda vacío con
      // su aviso: la vista de drones no depende de las bases para funcionar.
      .then((lista) => setBases(Array.isArray(lista) ? lista : []))
      .catch(() => setBases([]));
  }, []);

  useEffect(() => {
    let vigente = true;
    setError('');
    setCargando(true);
    traerDrones({ incluirEliminados: verEliminados })
      .then((lista) => vigente && setDrones(lista))
      .catch((e) => vigente && setError(textoError(e)))
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [verEliminados]);

  useEffect(() => {
    if (!novedad) return;
    setDrones((prev) =>
      novedad.tipo === 'ficha'
        ? upsert(prev, novedad.drone)
        : prev.map((d) => (d.hash === novedad.droneId ? { ...d, displayName: novedad.displayName } : d)),
    );
  }, [novedad]);

  useEffect(() => () => clearTimeout(temporizador.current), []);

  /**
   * Las acciones de la fila (interruptor, baja, restauración) devuelven la
   * ficha ya actualizada, así que no hay que recargar. Su error va arriba de
   * la tabla: no hay ningún diálogo abierto donde mostrarlo.
   */
  async function accion(fn: () => Promise<Drone>) {
    setError('');
    try {
      const ficha = await fn();
      setDrones((prev) => upsert(prev, ficha));
    } catch (e) {
      setError(textoError(e));
    }
  }

  async function copiar(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiado(hash);
      clearTimeout(temporizador.current);
      temporizador.current = setTimeout(() => setCopiado(''), 2000);
    } catch {
      // Sin portapapeles (pasa fuera de un contexto seguro) el botón no miente.
      setError('No se pudo copiar el identificador');
    }
  }

  /**
   * Lo que guarda el diálogo. Si el backend rechaza, el error sube al diálogo
   * —que lo muestra adentro y no se cierra— en vez de quedar en la página,
   * tapado por el velo.
   *
   * Cerrar sin preguntar cuál está abierto es seguro porque el diálogo no se
   * deja cerrar mientras este pedido viaja: el que se cierra al volver es el
   * mismo que lo mandó, y no otro que se haya abierto en el medio.
   */
  async function guardarDron(cuerpo: CuerpoDron) {
    const body = JSON.stringify(cuerpo);
    if (dialogo) {
      const ficha = await api<Drone>(`/drones/${dialogo.hash}`, { method: 'PATCH', body });
      setDrones((prev) => upsert(prev, ficha));
      setDialogo(undefined);
      return;
    }
    const ficha = await api<Drone>('/drones', { method: 'POST', body });
    setDrones((prev) => upsert(prev, ficha));
    setDialogo(undefined);
    // El sticker se abre solo: sin QR el dron recién dado de alta no se puede emparejar.
    setQr(ficha);
  }

  const visibles = drones.filter((d) => mostrarEliminados || !d.deleted);

  return (
    <main className="page-main">
      <section className="card">
        <div className="log-head">
          <h2>Drones</h2>
          <div className="barra-acciones">
            {esSupervisor && (
              <button
                type="button"
                className={`toggle-eliminados${verEliminados ? ' activo' : ''}`}
                aria-pressed={verEliminados}
                onClick={() => setVerEliminados((v) => !v)}
              >
                {verEliminados ? 'Ocultar eliminados' : 'Ver eliminados'}
              </button>
            )}
            {puedeDarDeAlta && (
              <button type="button" className="primario chico" onClick={() => setDialogo(null)}>
                Nuevo dron
              </button>
            )}
          </div>
        </div>

        {error && (
          <p className="aviso malo" role="alert">
            {error}
          </p>
        )}

        {/* Mientras el pedido viaja no se puede afirmar que no haya drones: ese
            cartel es justo el que empuja a dar de alta uno que ya existe, y el
            alta genera un hash nuevo, o sea un activo duplicado con su propio QR. */}
        {cargando && visibles.length === 0 && <p className="vacio">Trayendo los drones…</p>}
        {!cargando && !error && visibles.length === 0 && (
          <div className="vacio-guia">
            <p className="vacio">Todavía no hay drones dados de alta.</p>
            <p className="muted">
              {puedeDarDeAlta
                ? 'Con «Nuevo dron» se da de alta y sale su sticker con el QR, que la app escanea para emparejarse.'
                : 'Cuando un supervisor o un operador de campo dé de alta uno, va a aparecer acá.'}
            </p>
          </div>
        )}
        {visibles.length > 0 && (
          <div className="tabla-envoltorio">
            <table className="tabla tabla-gestion">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Identificador</th>
                  <th>Modelo</th>
                  <th>Estado</th>
                  <th>En línea</th>
                  <th className="columna-acciones">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((d) => {
                  const eliminado = d.deleted;
                  return (
                    <tr key={d.hash} className={eliminado ? 'fila-eliminada' : undefined}>
                      <td>
                        <div>{d.displayName}</div>
                        {d.base && <div className="muted">{d.base.name}</div>}
                      </td>
                      <td>
                        <span className="hash">
                          {abreviar(d.hash)}
                          <button
                            type="button"
                            aria-label={`Copiar el identificador de ${d.displayName}`}
                            onClick={() => copiar(d.hash)}
                          >
                            {copiado === d.hash ? 'Copiado' : 'Copiar'}
                          </button>
                        </span>
                      </td>
                      <td>{d.model || <span className="muted">—</span>}</td>
                      <td>
                        {eliminado ? (
                          <span className="badge">Eliminado</span>
                        ) : esSupervisor ? (
                          <label className="switch">
                            <input
                              type="checkbox"
                              checked={d.active}
                              aria-label={`Dron ${d.displayName} operativo`}
                              onChange={() =>
                                accion(() =>
                                  api<Drone>(`/drones/${d.hash}`, {
                                    method: 'PATCH',
                                    body: JSON.stringify({ active: !d.active }),
                                  }),
                                )
                              }
                            />
                            <span className="switch-pista" />
                            <span className="switch-texto">{d.active ? 'Operativo' : 'No operativo'}</span>
                          </label>
                        ) : (
                          <span className={`estado ${d.active ? 'ok' : 'muted'}`}>
                            {d.active ? 'Operativo' : 'No operativo'}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={`estado ${d.online ? 'ok' : 'muted'}`}>{d.online ? 'Sí' : 'No'}</span>
                      </td>
                      <td className="barra-acciones">
                        <div className="acciones-fila" role="group" aria-label={`Acciones de ${d.displayName}`}>
                          {/* Una fila eliminada sólo la ve el supervisor (`visibles`
                              la filtra para el resto), así que restaurar no
                              necesita preguntar el rol otra vez. */}
                          {eliminado ? (
                            <button
                              type="button"
                              className="chico"
                              onClick={() => accion(() => api<Drone>(`/drones/${d.hash}/restore`, { method: 'POST' }))}
                            >
                              Restaurar
                            </button>
                          ) : (
                            <>
                              {esSupervisor && (
                                <button type="button" className="chico" onClick={() => setDialogo(d)}>
                                  Editar
                                </button>
                              )}
                              <button type="button" className="chico" onClick={() => setQr(d)}>
                                Ver QR
                              </button>
                              {esSupervisor && (
                                <button
                                  type="button"
                                  className="chico dismiss"
                                  onClick={() =>
                                    confirm(`¿Eliminar el dron "${d.displayName}"? Se puede restaurar después.`) &&
                                    accion(() => api<Drone>(`/drones/${d.hash}`, { method: 'DELETE' }))
                                  }
                                >
                                  Eliminar
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialogo !== undefined && (
        <DialogoDron dron={dialogo} bases={bases} onGuardar={guardarDron} onCerrar={() => setDialogo(undefined)} />
      )}

      {qr && <QrDronModal dron={qr} onCerrar={() => setQr(null)} />}
    </main>
  );
}
