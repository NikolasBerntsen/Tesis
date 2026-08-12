import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, buscarUsuarios } from '../api';
import type { Me, RolAsignable, RolConsola, UserView } from '../types';
import Modal from './Modal';

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

type Alta = { username: string; fullName: string; role: RolAsignable; canControl: boolean };

const ALTA_VACIA: Alta = { username: '', fullName: '', role: 'operator', canControl: true };

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
  const idTitulo = useId();
  const idTexto = useId();

  return (
    <Modal etiquetadoPor={idTitulo} descritoPor={idTexto} onCerrar={onCancelar}>
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
    </Modal>
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
  const [busqueda, setBusqueda] = useState('');
  // La contraseña generada se muestra UNA vez: después no se puede recuperar.
  const [credencial, setCredencial] = useState<{ username: string; password: string; nueva: boolean } | null>(null);
  const idNotaCampo = useId();

  const esAdmin = me.role === 'admin';
  const esSupervisor = esAdmin || me.role === 'supervisor';
  const esOperadorDeCampo = nuevo.role === 'field_operator';

  useEffect(() => {
    let vigente = true;
    buscarUsuarios({ incluirEliminados: verEliminados, q: busqueda })
      .then((lista) => vigente && setUsers(lista))
      .catch((e) => vigente && setError(textoError(e)));
    return () => {
      vigente = false;
    };
  }, [verEliminados, recarga, busqueda]);

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

  /**
   * Regenerar es la única forma de recuperar el acceso a una cuenta: la
   * anterior se pisa y la nueva se muestra una sola vez, acá mismo.
   */
  function regenerar(usuario: UserView) {
    accion(async () => {
      const r = await api<UserView & { password: string }>(`/users/${usuario.username}/regenerate-password`, {
        method: 'POST',
      });
      setCredencial({ username: r.username, password: r.password, nueva: false });
    });
  }

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
      const creado = await api<UserView & { password: string }>('/users', { method: 'POST', body: JSON.stringify(cuerpo) });
      setNuevo(ALTA_VACIA);
      setCredencial({ username: creado.username, password: creado.password, nueva: true });
    });
  }

  // El backend sólo respeta `includeDeleted` para supervisor+; el filtro de acá
  // es el que garantiza que con el toggle apagado no se cuele ninguna baja.
  const visibles = users.filter((u) => verEliminados || !u.deletedAt);

  return (
    <main className="page-main">
      <div className="barra-acciones">
        <h2>Usuarios</h2>
        <input
          className="buscador"
          type="search"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por usuario, nombre o rol…"
          aria-label="Buscar usuarios"
        />
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
                  <th>Nombre</th>
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
                  // El operador de campo despliega drones pero no los pilotea: el
                  // backend rechaza con un 400 cualquier intento de autorizarlo, así
                  // que en su fila el permiso ni siquiera corresponde.
                  const controlAplica = u.role !== 'field_operator';
                  // A una cuenta eliminada no se le toca nada: primero se restaura.
                  const puedeTocarControl = controlAplica && !eliminado && !esYo && (esAdmin || u.role === 'operator');
                  return (
                    <tr key={u.username} className={eliminado ? 'fila-eliminada' : undefined}>
                      <td>
                        {u.username}
                        {esYo && <span className="muted"> (vos)</span>}
                      </td>
                      <td className="inscripcion">{u.fullName || <span className="muted">—</span>}</td>
                      <td>{ROL[u.role]}</td>
                      <td>
                        {controlAplica ? (
                          <>
                            <span className={u.canControl ? 'ok' : 'bad'}>
                              {u.canControl ? 'Autorizado' : 'Suspendido'}
                            </span>{' '}
                            {puedeTocarControl && (
                              <button className="chico" onClick={patch(u.username, { canControl: !u.canControl })}>
                                {u.canControl ? 'Suspender' : 'Autorizar'}
                              </button>
                            )}
                          </>
                        ) : (
                          <span className="muted">No aplica</span>
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
                            <>
                              <button className="chico" onClick={() => regenerar(u)}>
                                Regenerar contraseña
                              </button>
                              {!esYo && (
                                <button className="chico dismiss" onClick={() => setAEliminar(u)}>
                                  Eliminar
                                </button>
                              )}
                            </>
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
              Nombre y apellido
              <input
                value={nuevo.fullName}
                onChange={(e) => setNuevo({ ...nuevo, fullName: e.target.value })}
                minLength={3}
                maxLength={60}
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

      {credencial && (
        <Modal etiquetadoPor="titulo-credencial" onCerrar={() => setCredencial(null)}>
          <header className="modal-cabecera">
            <h2 className="modal-titulo" id="titulo-credencial">
              {credencial.nueva ? 'Usuario creado' : 'Contraseña regenerada'}
            </h2>
          </header>
          <div className="modal-cuerpo">
            <p>
              Contraseña de <strong>{credencial.username}</strong>. Anotala ahora:{' '}
              <strong>no se puede volver a ver</strong>. Si se pierde, la única salida es regenerarla,
              y eso invalida la anterior.
            </p>
            <p className="credencial mono">{credencial.password}</p>
            <button
              type="button"
              className="chico"
              onClick={() => navigator.clipboard?.writeText(credencial.password)}
            >
              Copiar
            </button>
          </div>
          <footer className="modal-pie">
            <button className="primario" onClick={() => setCredencial(null)}>
              Ya la anoté
            </button>
          </footer>
        </Modal>
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
