import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, traerBases, traerDrones } from '../api';
import type { BaseAsset, Drone, Me, NovedadDron } from '../types';
import QrDronModal from './QrDronModal';

const COLUMNAS = 6;

/** Primeros 6 y últimos 4: alcanza para reconocer el dron sin volcar los 32 hex. */
function abreviar(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Formulario = {
  displayName: string;
  model: string;
  inventoryCode: string;
  baseId: number | null;
};

const FORMULARIO_VACIO: Formulario = { displayName: '', model: '', inventoryCode: '', baseId: null };

function formularioDe(d: Drone): Formulario {
  return {
    displayName: d.displayName,
    model: d.model,
    inventoryCode: d.inventoryCode,
    baseId: d.baseId,
  };
}

function upsert(lista: Drone[], ficha: Drone): Drone[] {
  return lista.some((d) => d.hash === ficha.hash)
    ? lista.map((d) => (d.hash === ficha.hash ? ficha : d))
    : [...lista, ficha];
}

/** Los mismos campos para el alta y para la edición: cambian sólo los botones. */
function CamposDron({ valor, onCambio, bases }: { valor: Formulario; onCambio: (f: Formulario) => void; bases: BaseAsset[] }) {
  return (
    <>
      <label>
        Nombre
        <input
          value={valor.displayName}
          onChange={(e) => onCambio({ ...valor, displayName: e.target.value })}
          maxLength={40}
          required
        />
      </label>
      <label>
        Modelo
        <input value={valor.model} onChange={(e) => onCambio({ ...valor, model: e.target.value })} maxLength={40} />
      </label>
      <label>
        Número de inventario
        <input
          value={valor.inventoryCode}
          onChange={(e) => onCambio({ ...valor, inventoryCode: e.target.value })}
          maxLength={30}
          placeholder="INV-0042"
        />
      </label>
      <SelectorDeBase
        bases={bases}
        valor={valor.baseId}
        onElegir={(baseId) => onCambio({ ...valor, baseId })}
      />
    </>
  );
}

/**
 * Base del dron: se elige de las que están dadas de alta, con un buscador que
 * filtra a medida que se escribe. La coordenada no se tipea acá — es un dato de
 * la base, no del dron.
 */
function SelectorDeBase({
  bases,
  valor,
  onElegir,
}: {
  bases: BaseAsset[];
  valor: number | null;
  onElegir: (id: number | null) => void;
}) {
  const [texto, setTexto] = useState('');
  const [abierto, setAbierto] = useState(false);
  const elegida = bases.find((b) => b.id === valor) ?? null;

  const filtradas = useMemo(() => {
    const q = texto.trim().toLowerCase();
    return q ? bases.filter((b: BaseAsset) => b.name.toLowerCase().includes(q)) : bases;
  }, [bases, texto]);

  return (
    <label className="selector-base">
      Base
      {elegida && !abierto ? (
        <div className="base-elegida">
          <span className="inscripcion">{elegida.name}</span>
          <span className="muted mono">
            {elegida.lat.toFixed(5)}, {elegida.lon.toFixed(5)}
          </span>
          <button type="button" className="chico" onClick={() => { setAbierto(true); setTexto(''); }}>
            Cambiar
          </button>
          <button type="button" className="chico ghost" onClick={() => onElegir(null)}>
            Quitar
          </button>
        </div>
      ) : (
        <>
          <input
            value={texto}
            onChange={(e) => { setTexto(e.target.value); setAbierto(true); }}
            onFocus={() => setAbierto(true)}
            placeholder={bases.length ? 'Escribí para buscar una base…' : 'No hay bases dadas de alta'}
            disabled={bases.length === 0}
            aria-label="Buscar base"
          />
          {abierto && (
            <ul className="lista-bases" role="listbox">
              {filtradas.length === 0 && <li className="muted">Ninguna base coincide.</li>}
              {filtradas.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={b.id === valor}
                    onClick={() => { onElegir(b.id); setAbierto(false); setTexto(''); }}
                  >
                    <span className="inscripcion">{b.name}</span>
                    <span className="muted mono">
                      {b.lat.toFixed(4)}, {b.lon.toFixed(4)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </label>
  );
}

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
  const [nuevo, setNuevo] = useState<Formulario>(FORMULARIO_VACIO);
  const [editando, setEditando] = useState<string | null>(null);
  const [edicion, setEdicion] = useState<Formulario>(FORMULARIO_VACIO);
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

  /** Toda acción devuelve la ficha ya actualizada, así que no hay que recargar. */
  async function accion(fn: () => Promise<Drone>): Promise<Drone | null> {
    setError('');
    try {
      const ficha = await fn();
      setDrones((prev) => upsert(prev, ficha));
      return ficha;
    } catch (e) {
      setError(textoError(e));
      return null;
    }
  }

  const patch = (hash: string, body: object) =>
    accion(() => api<Drone>(`/drones/${hash}`, { method: 'PATCH', body: JSON.stringify(body) }));

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

  async function crear(e: FormEvent) {
    e.preventDefault();
    const cuerpo = {
      displayName: nuevo.displayName.trim(),
      model: nuevo.model.trim(),
      inventoryCode: nuevo.inventoryCode.trim(),
      ...(nuevo.baseId != null ? { baseId: nuevo.baseId } : {}),
    };
    const ficha = await accion(() => api<Drone>('/drones', { method: 'POST', body: JSON.stringify(cuerpo) }));
    if (!ficha) return;
    setNuevo(FORMULARIO_VACIO);
    // El sticker se abre solo: sin QR el dron recién dado de alta no se puede emparejar.
    setQr(ficha);
  }

  async function guardar(e: FormEvent, dron: Drone) {
    e.preventDefault();
    const cuerpo: { displayName?: string; model?: string; inventoryCode?: string; baseId?: number | null } = {};
    if (edicion.displayName.trim() !== dron.displayName) cuerpo.displayName = edicion.displayName.trim();
    if (edicion.model.trim() !== dron.model) cuerpo.model = edicion.model.trim();
    if (edicion.inventoryCode.trim() !== dron.inventoryCode) cuerpo.inventoryCode = edicion.inventoryCode.trim();
    if (edicion.baseId !== dron.baseId) cuerpo.baseId = edicion.baseId;

    // Un PATCH sin cambios sólo traería un 400 "Nada para modificar".
    if (Object.keys(cuerpo).length > 0 && !(await patch(dron.hash, cuerpo))) return;
    setEditando(null);
  }

  function abrirEdicion(dron: Drone) {
    setEditando(dron.hash);
    setEdicion(formularioDe(dron));
  }

  const visibles = drones.filter((d) => mostrarEliminados || !d.deletedAt);

  return (
    <main className="page-main">
      <div className="barra-acciones">
        <h2>Drones</h2>
        {esSupervisor && (
          <button
            className={`toggle-eliminados${verEliminados ? ' activo' : ''}`}
            aria-pressed={verEliminados}
            onClick={() => setVerEliminados((v) => !v)}
          >
            {verEliminados ? 'Ocultar eliminados' : 'Ver eliminados'}
          </button>
        )}
      </div>

      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        {/* Mientras el pedido viaja no se puede afirmar que no haya drones: ese
            cartel es justo el que empuja a dar de alta uno que ya existe, y el
            alta genera un hash nuevo, o sea un activo duplicado con su propio QR. */}
        {cargando && visibles.length === 0 && <p className="vacio">Trayendo los drones…</p>}
        {!cargando && !error && visibles.length === 0 && (
          <p className="vacio">Todavía no hay drones dados de alta.</p>
        )}
        {visibles.length > 0 && (
          <div className="tabla-envoltorio">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Identificador</th>
                  <th>Modelo</th>
                  <th>Estado</th>
                  <th>En línea</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((d) => {
                  const eliminado = Boolean(d.deletedAt);
                  return (
                    <Fragment key={d.hash}>
                      <tr className={eliminado ? 'fila-eliminada' : undefined}>
                        <td>
                          <div>{d.displayName}</div>
                          {d.base && <div className="muted">{d.base.name}</div>}
                        </td>
                        <td>
                          <span className="hash">
                            {abreviar(d.hash)}
                            <button
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
                                onChange={() => patch(d.hash, { active: !d.active })}
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
                        <td>
                          {eliminado ? (
                            esSupervisor && (
                              <button
                                className="chico"
                                onClick={() => accion(() => api<Drone>(`/drones/${d.hash}/restore`, { method: 'POST' }))}
                              >
                                Restaurar
                              </button>
                            )
                          ) : (
                            <>
                              <button className="chico" onClick={() => setQr(d)}>
                                Ver QR
                              </button>{' '}
                              {esSupervisor && (
                                <>
                                  <button
                                    className="chico"
                                    onClick={() => (editando === d.hash ? setEditando(null) : abrirEdicion(d))}
                                  >
                                    Editar
                                  </button>{' '}
                                  <button
                                    className="chico dismiss"
                                    onClick={() =>
                                      confirm(`¿Eliminar el dron "${d.displayName}"? Se puede restaurar después.`) &&
                                      accion(() => api<Drone>(`/drones/${d.hash}`, { method: 'DELETE' }))
                                    }
                                  >
                                    Eliminar
                                  </button>
                                </>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                      {editando === d.hash && (
                        <tr>
                          <td colSpan={COLUMNAS}>
                            <form
                              className="form-crear"
                              aria-label={`Editar ${d.displayName}`}
                              onSubmit={(e) => guardar(e, d)}
                            >
                              <CamposDron valor={edicion} onCambio={setEdicion} bases={bases} />
                              <button type="submit">Guardar</button>
                              <button type="button" className="ghost" onClick={() => setEditando(null)}>
                                Cancelar
                              </button>
                            </form>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {puedeDarDeAlta && (
        <section className="card">
          <h2>Dar de alta un dron</h2>
          <form className="form-crear" aria-label="Dar de alta un dron" onSubmit={crear}>
            <CamposDron valor={nuevo} onCambio={setNuevo} bases={bases} />
            <button type="submit">Dar de alta</button>
          </form>
          <p className="muted">La base es opcional: sin coordenadas el dron queda sin base asignada.</p>
        </section>
      )}

      {qr && <QrDronModal dron={qr} onCerrar={() => setQr(null)} />}
    </main>
  );
}
