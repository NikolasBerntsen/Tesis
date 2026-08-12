import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, traerUsuarios } from '../api';
import type { Me, RolAsignable, RolConsola, UserView } from '../types';

const ROL: Record<RolConsola, string> = {
  field_operator: 'Operador de campo',
  operator: 'Operador',
  supervisor: 'Supervisor',
  admin: 'Administrador',
};

/** Los roles que el backend acepta en el alta: un admin no se crea desde acá. */
const ROLES_ALTA: readonly RolAsignable[] = ['operator', 'supervisor', 'field_operator'];

const ICONO_CERRAR = {
  width: 15,
  height: 15,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  'aria-hidden': true,
} as const;

const FOCUSABLES =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Alta = { username: string; password: string; role: RolAsignable; canControl: boolean };

const ALTA_VACIA: Alta = { username: '', password: '', role: 'operator', canControl: true };

function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** El `value` del select llega como string suelto: se valida contra la lista. */
function rolDeAlta(valor: string): RolAsignable {
  return ROLES_ALTA.find((r) => r === valor) ?? 'operator';
}

/**
 * Confirmación de la baja. Un `confirm()` del navegador no alcanza: hay que
 * explicar que el borrado es lógico y que el nombre de usuario no se libera, y
 * eso no entra en el renglón único que da el navegador.
 */
function ModalEliminar({
  usuario,
  onCancelar,
  onConfirmar,
}: {
  usuario: string;
  onCancelar: () => void;
  onConfirmar: () => void;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const idTitulo = useId();
  const idTexto = useId();
  // En una ref para que el listener del teclado no se resuscriba en cada render
  // sólo porque el padre le pasa una función nueva.
  const cancelar = useRef(onCancelar);
  cancelar.current = onCancelar;

  useEffect(() => {
    const previo = document.activeElement;
    caja.current?.focus();
    // El foco vuelve a la fila desde la que se pidió la baja.
    return () => {
      if (previo instanceof HTMLElement) previo.focus();
    };
  }, []);

  // Va en `document` y no en el JSX porque el diálogo tiene que responder a
  // Escape y atrapar el tabulador aun si el foco se escapó de la caja.
  useEffect(() => {
    function alTeclear(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        cancelar.current();
        return;
      }
      if (ev.key !== 'Tab' || !caja.current) return;
      // Siempre están las tres formas de salir, así que la lista nunca va vacía.
      const dentro = [...caja.current.querySelectorAll<HTMLElement>(FOCUSABLES)];
      const primero = dentro[0];
      const ultimo = dentro[dentro.length - 1];
      const foco = document.activeElement;
      const afuera = !caja.current.contains(foco);
      if (ev.shiftKey && (foco === primero || foco === caja.current || afuera)) {
        ev.preventDefault();
        ultimo.focus();
      } else if (!ev.shiftKey && (foco === ultimo || afuera)) {
        ev.preventDefault();
        primero.focus();
      }
    }
    document.addEventListener('keydown', alTeclear);
    return () => document.removeEventListener('keydown', alTeclear);
  }, []);

  return createPortal(
    <div className="modal-fondo" onClick={onCancelar}>
      <div
        className="modal-caja"
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        aria-describedby={idTexto}
        tabIndex={-1}
        ref={caja}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-cabecera">
          <div>
            <h2 className="modal-titulo" id={idTitulo}>
              Eliminar a {usuario}
            </h2>
            <p className="modal-subtitulo">La baja se puede deshacer</p>
          </div>
          <button className="modal-cerrar" aria-label="Cerrar la confirmación" onClick={onCancelar}>
            <svg {...ICONO_CERRAR}>
              <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
            </svg>
          </button>
        </header>

        <div className="modal-cuerpo">
          <p id={idTexto}>
            La cuenta <strong>{usuario}</strong> deja de poder entrar a la consola y sale del listado.
          </p>
          <p className="muted">
            El borrado es lógico: un administrador puede restaurarla más adelante desde “Ver eliminados”. Hasta
            entonces el nombre de usuario sigue ocupado.
          </p>
        </div>

        <footer className="modal-pie">
          <button className="ghost" onClick={onCancelar}>
            Cancelar
          </button>
          <button className="dismiss" onClick={onConfirmar}>
            Eliminar
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Gestión de usuarios. El supervisor ve a los operadores y les suspende o
 * autoriza el control de drones; el admin además crea cuentas, las desactiva,
 * las elimina y las restaura. La baja es lógica: la cuenta eliminada queda
 * escondida salvo que se pida verla, y su nombre no vuelve a estar libre.
 */
export default function UsersView({ me }: { me: Me }) {
  const [users, setUsers] = useState<UserView[]>([]);
  const [error, setError] = useState('');
  const [verEliminados, setVerEliminados] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [aEliminar, setAEliminar] = useState<UserView | null>(null);
  const [nuevo, setNuevo] = useState<Alta>(ALTA_VACIA);
  const idNotaCampo = useId();

  const esAdmin = me.role === 'admin';
  const esSupervisor = esAdmin || me.role === 'supervisor';
  const esOperadorDeCampo = nuevo.role === 'field_operator';

  useEffect(() => {
    let vigente = true;
    traerUsuarios({ incluirEliminados: verEliminados })
      .then((lista) => vigente && setUsers(lista))
      .catch((e) => vigente && setError(textoError(e)));
    return () => {
      vigente = false;
    };
  }, [verEliminados, recarga]);

  async function accion(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      setRecarga((n) => n + 1);
    } catch (e) {
      setError(textoError(e));
    }
  }

  const patch = (username: string, body: object) => () =>
    accion(() => api(`/users/${username}`, { method: 'PATCH', body: JSON.stringify(body) }));

  function eliminar(usuario: UserView) {
    setAEliminar(null);
    accion(() => api(`/users/${usuario.username}`, { method: 'DELETE' }));
  }

  function crear(e: FormEvent) {
    e.preventDefault();
    accion(async () => {
      // El backend le fuerza `canControl:false` al operador de campo; se manda
      // ya resuelto para que el alta no prometa un permiso que no va a existir.
      const cuerpo: Alta = { ...nuevo, canControl: !esOperadorDeCampo && nuevo.canControl };
      await api('/users', { method: 'POST', body: JSON.stringify(cuerpo) });
      setNuevo(ALTA_VACIA);
    });
  }

  // El backend sólo respeta `includeDeleted` para supervisor+; el filtro de acá
  // es el que garantiza que con el toggle apagado no se cuele ninguna baja.
  const visibles = users.filter((u) => verEliminados || !u.deletedAt);

  return (
    <main className="page-main">
      <div className="barra-acciones">
        <h2>Usuarios</h2>
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
        {visibles.length === 0 ? (
          <p className="vacio">No hay usuarios para mostrar.</p>
        ) : (
          <div className="tabla-envoltorio">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Rol</th>
                  <th>Control de drones</th>
                  <th>Estado</th>
                  {esAdmin && <th>Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {visibles.map((u) => {
                  const esYo = u.username === me.username;
                  const eliminado = Boolean(u.deletedAt);
                  // A una cuenta eliminada no se le toca nada: primero se restaura.
                  const puedeTocarControl = !eliminado && !esYo && (esAdmin || u.role === 'operator');
                  return (
                    <tr key={u.username} className={eliminado ? 'fila-eliminada' : undefined}>
                      <td>
                        {u.username}
                        {esYo && <span className="muted"> (vos)</span>}
                      </td>
                      <td>{ROL[u.role]}</td>
                      <td>
                        <span className={u.canControl ? 'ok' : 'bad'}>
                          {u.canControl ? 'Autorizado' : 'Suspendido'}
                        </span>{' '}
                        {puedeTocarControl && (
                          <button className="chico" onClick={patch(u.username, { canControl: !u.canControl })}>
                            {u.canControl ? 'Suspender' : 'Autorizar'}
                          </button>
                        )}
                      </td>
                      <td>
                        {eliminado ? (
                          <span className="badge">Eliminado</span>
                        ) : (
                          <>
                            <span className={`estado ${u.active ? 'ok' : 'muted'}`}>
                              {u.active ? 'Activo' : 'Desactivado'}
                            </span>{' '}
                            {esAdmin && !esYo && (
                              <button className="chico" onClick={patch(u.username, { active: !u.active })}>
                                {u.active ? 'Desactivar' : 'Reactivar'}
                              </button>
                            )}
                          </>
                        )}
                      </td>
                      {esAdmin && (
                        <td>
                          {eliminado ? (
                            <button
                              className="chico"
                              onClick={() => accion(() => api(`/users/${u.username}/restore`, { method: 'POST' }))}
                            >
                              Restaurar
                            </button>
                          ) : (
                            !esYo && (
                              <button className="chico dismiss" onClick={() => setAEliminar(u)}>
                                Eliminar
                              </button>
                            )
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {esAdmin && (
        <section className="card">
          <h2>Crear usuario</h2>
          <form className="form-crear" aria-label="Crear usuario" onSubmit={crear}>
            <label>
              Usuario
              <input value={nuevo.username} onChange={(e) => setNuevo({ ...nuevo, username: e.target.value })} required />
            </label>
            <label>
              Contraseña
              <input
                type="password"
                value={nuevo.password}
                onChange={(e) => setNuevo({ ...nuevo, password: e.target.value })}
                minLength={6}
                required
              />
            </label>
            <label>
              Rol
              <select value={nuevo.role} onChange={(e) => setNuevo({ ...nuevo, role: rolDeAlta(e.target.value) })}>
                {ROLES_ALTA.map((r) => (
                  <option key={r} value={r}>
                    {ROL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="fila">
              <input
                type="checkbox"
                checked={!esOperadorDeCampo && nuevo.canControl}
                disabled={esOperadorDeCampo}
                aria-describedby={esOperadorDeCampo ? idNotaCampo : undefined}
                onChange={(e) => setNuevo({ ...nuevo, canControl: e.target.checked })}
              />
              Puede controlar drones
            </label>
            <button type="submit">Crear</button>
          </form>
          {esOperadorDeCampo && (
            <p className="muted" id={idNotaCampo}>
              El operador de campo no opera drones: sólo los da de alta y los empareja por QR, así que el sistema le
              niega el control.
            </p>
          )}
        </section>
      )}

      {aEliminar && (
        <ModalEliminar
          usuario={aEliminar.username}
          onCancelar={() => setAEliminar(null)}
          onConfirmar={() => eliminar(aEliminar)}
        />
      )}
    </main>
  );
}
