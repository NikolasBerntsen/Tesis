import { useEffect, useId, useState } from 'react';
import { api, buscarUsuarios } from '../api';
import { formatearDni } from '../dni';
import type { Me, UserView } from '../types';
import { DialogoEditarUsuario, DialogoNuevoUsuario, ICONO_CERRAR, ROL, textoError } from './DialogosDeUsuario';
import Modal from './Modal';

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
 * autoriza el control de drones; el admin además crea cuentas, edita su ficha
 * (nombre, DNI, rol), las desactiva, las elimina y las restaura. La baja es
 * lógica: la cuenta eliminada queda escondida salvo que se pida verla, y su
 * nombre no vuelve a estar libre.
 *
 * El alta y la edición van en diálogos y no en una fila de la tabla: son
 * fichas de cinco campos con validaciones y errores propios, y en un renglón
 * no había lugar para explicarlos.
 */
export default function UsersView({ me }: { me: Me }) {
  const [users, setUsers] = useState<UserView[]>([]);
  const [error, setError] = useState('');
  const [verEliminados, setVerEliminados] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [aEliminar, setAEliminar] = useState<UserView | null>(null);
  const [creando, setCreando] = useState(false);
  const [editando, setEditando] = useState<UserView | null>(null);
  const [busqueda, setBusqueda] = useState('');
  // La contraseña generada se muestra UNA vez: después no se puede recuperar.
  const [credencial, setCredencial] = useState<{ username: string; password: string; nueva: boolean } | null>(null);

  const esAdmin = me.role === 'admin';
  const esSupervisor = esAdmin || me.role === 'supervisor';

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

  function creado(usuario: UserView & { password: string }) {
    setCreando(false);
    setCredencial({ username: usuario.username, password: usuario.password, nueva: true });
    setRecarga((n) => n + 1);
  }

  function guardado() {
    setEditando(null);
    setRecarga((n) => n + 1);
  }

  // El backend sólo respeta `includeDeleted` para supervisor+; el filtro de acá
  // es el que garantiza que con el toggle apagado no se cuele ninguna baja.
  const visibles = users.filter((u) => verEliminados || !u.deleted);

  return (
    <main className="page-main">
      <div className="barra-acciones">
        <h2>Usuarios</h2>
        <input
          className="buscador"
          type="search"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por usuario, nombre, DNI o rol…"
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
        {esAdmin && (
          <button className="primario chico" onClick={() => setCreando(true)}>
            Nuevo usuario
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
                  <th>DNI</th>
                  <th>Rol</th>
                  <th>Control de drones</th>
                  <th>Estado</th>
                  {esSupervisor && <th>Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {visibles.map((u) => {
                  const esYo = u.username === me.username;
                  const eliminado = u.deleted;
                  // El operador de campo despliega drones pero no los pilotea: el
                  // backend rechaza con un 400 cualquier intento de autorizarlo, así
                  // que en su fila el permiso ni siquiera corresponde.
                  const controlAplica = u.role !== 'field_operator';
                  // A una cuenta eliminada no se le toca nada: primero se restaura.
                  // Y nadie se edita a sí mismo: el backend lo rechaza, para que
                  // nadie se quite el último acceso de administrador por error.
                  const puedeEditar = !eliminado && !esYo && (esAdmin || u.role === 'operator');
                  const puedeTocarControl = controlAplica && puedeEditar;
                  const dni = formatearDni(u.dni);
                  return (
                    <tr key={u.username} className={eliminado ? 'fila-eliminada' : undefined}>
                      <td>
                        {u.username}
                        {esYo && <span className="muted"> (vos)</span>}
                      </td>
                      <td className="inscripcion">{u.fullName || <span className="muted">—</span>}</td>
                      <td className="dni">{dni || <span className="muted">—</span>}</td>
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
                      {esSupervisor && (
                        <td className="barra-acciones">
                          {puedeEditar && (
                            <button
                              className="chico"
                              aria-label={`Editar a ${u.username}`}
                              onClick={() => setEditando(u)}
                            >
                              Editar
                            </button>
                          )}
                          {esAdmin &&
                            (eliminado ? (
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
                            ))}
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

      {creando && <DialogoNuevoUsuario onCerrar={() => setCreando(false)} onCreado={creado} />}

      {editando && (
        <DialogoEditarUsuario
          usuario={editando}
          esAdmin={esAdmin}
          onCerrar={() => setEditando(null)}
          onGuardado={guardado}
        />
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
