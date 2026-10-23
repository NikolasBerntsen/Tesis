import { useEffect, useState } from 'react';
import { api, buscarUsuarios } from '../api';
import { formatearDni } from '../dni';
import type { Me, UserView } from '../types';
import { BotonEditar, BotonEliminar, BotonRestaurar } from './AccionesDeGestion';
import { useAvisar } from './AvisosFlotantes';
import DialogoConfirmacion, { type PedidoDeConfirmacion } from './DialogoConfirmacion';
import { CONSECUENCIA, DialogoEditarUsuario, DialogoNuevoUsuario, ROL, textoError } from './DialogosDeUsuario';
import EncabezadoDeVista from './EncabezadoDeVista';
import { EsqueletoDeTabla, EstadoVacio } from './EstadosDeVista';
import { IconoMas } from './Iconos';
import Modal from './Modal';

/**
 * El dato corto de la cabecera. Con una búsqueda escrita, la lista es la de
 * los que coinciden, y contarlos como "cuentas" haría pensar que son todas.
 */
function resumenDeCuentas(visibles: UserView[], hayBusqueda: boolean): string {
  const vivas = visibles.filter((u) => !u.deleted);
  if (hayBusqueda) return `${vivas.length} ${vivas.length === 1 ? 'coincide' : 'coinciden'} con la búsqueda`;
  const activas = vivas.filter((u) => u.active).length;
  return `${vivas.length} ${vivas.length === 1 ? 'cuenta' : 'cuentas'} · ${activas} ${activas === 1 ? 'activa' : 'activas'}`;
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
 * no había lugar para explicarlos. Lo que le corta algo a una cuenta (eliminar,
 * desactivar, suspender el control, regenerar la contraseña) pregunta antes,
 * con la consecuencia dicha: todo eso le cae encima a otra persona, a veces en
 * pleno vuelo.
 */
export default function UsersView({ me }: Readonly<{ me: Me }>) {
  const [users, setUsers] = useState<UserView[]>([]);
  // Hasta la primera respuesta no se puede afirmar que "no hay usuarios": antes
  // el cartel salía en el primer cuadro, antes de preguntarle nada al backend.
  const [cargando, setCargando] = useState(true);
  // La búsqueda con que llegó la lista que se está viendo; null hasta la
  // primera respuesta. El esqueleto es sólo para ese primer viaje: la búsqueda
  // recarga con cada tecla, y con la lista vacía cada tecla cambiaba el cartel
  // de "ningún usuario coincide" por el esqueleto y de vuelta. Y el cartel
  // habla de la lista que se ve, no de lo que se está tipeando.
  const [consultaMostrada, setConsultaMostrada] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [verEliminados, setVerEliminados] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [pedido, setPedido] = useState<PedidoDeConfirmacion | null>(null);
  const [creando, setCreando] = useState(false);
  const [editando, setEditando] = useState<UserView | null>(null);
  const [busqueda, setBusqueda] = useState('');
  // La contraseña generada se muestra UNA vez: después no se puede recuperar.
  const [credencial, setCredencial] = useState<{ username: string; password: string; nueva: boolean } | null>(null);
  const [errorCopia, setErrorCopia] = useState('');
  const avisar = useAvisar();

  const esAdmin = me.role === 'admin';
  const esSupervisor = esAdmin || me.role === 'supervisor';

  useEffect(() => {
    let vigente = true;
    setCargando(true);
    buscarUsuarios({ incluirEliminados: verEliminados, q: busqueda })
      .then((lista) => {
        if (!vigente) return;
        setUsers(lista);
        setConsultaMostrada(busqueda);
        // Como en Bases y Rutas: una lista que llegó bien se lleva el error de
        // la carga que había fallado antes.
        setError('');
      })
      .catch((e) => vigente && setError(textoError(e)))
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [verEliminados, recarga, busqueda]);

  /** Lo que no pregunta (restaurar, autorizar, reactivar): su error va arriba de la tabla. */
  async function accion(fn: () => Promise<unknown>, aviso: string) {
    setError('');
    try {
      await fn();
      avisar(aviso);
      setRecarga((n) => n + 1);
    } catch (e) {
      setError(textoError(e));
    }
  }

  /**
   * Lo que pasa por la confirmación: el error sube al diálogo, que queda
   * abierto. Si sale bien se lleva el error de una acción anterior: si no,
   * quedaba en rojo arriba de la tabla al lado del aviso de que salió bien.
   */
  function confirmada(fn: () => Promise<unknown>, aviso: string) {
    return async () => {
      await fn();
      setError('');
      avisar(aviso);
      setRecarga((n) => n + 1);
    };
  }

  const patch = (username: string, body: object) => () =>
    api(`/users/${username}`, { method: 'PATCH', body: JSON.stringify(body) });

  function alternarControl(u: UserView) {
    if (!u.canControl) {
      void accion(patch(u.username, { canControl: true }), `${u.username} puede volver a controlar drones.`);
      return;
    }
    setPedido({
      titulo: `Suspender el control de ${u.username}`,
      consecuencia: CONSECUENCIA.suspender(u.username),
      detalle: 'Se vuelve a autorizar desde esta misma fila.',
      confirmar: 'Suspender',
      enCurso: 'Suspendiendo…',
      accion: confirmada(patch(u.username, { canControl: false }), `Control de ${u.username} suspendido.`),
    });
  }

  function alternarActiva(u: UserView) {
    if (!u.active) {
      void accion(patch(u.username, { active: true }), `Cuenta de ${u.username} reactivada.`);
      return;
    }
    setPedido({
      titulo: `Desactivar a ${u.username}`,
      consecuencia: CONSECUENCIA.desactivar(u.username),
      detalle: 'La cuenta se conserva tal cual y se reactiva desde esta misma fila.',
      confirmar: 'Desactivar',
      enCurso: 'Desactivando…',
      accion: confirmada(patch(u.username, { active: false }), `Cuenta de ${u.username} desactivada.`),
    });
  }

  /**
   * Regenerar es la única forma de recuperar el acceso a una cuenta: la
   * anterior se pisa en el acto y la nueva se muestra una sola vez, acá mismo.
   * Por eso pregunta: un clic de más dejaba a alguien afuera sin saberlo.
   */
  function regenerar(u: UserView) {
    setPedido({
      titulo: `Regenerar la contraseña de ${u.username}`,
      consecuencia: `La contraseña actual de ${u.username} deja de servir en el acto.`,
      detalle: 'La nueva se muestra una sola vez, en la pantalla que sigue: tenela a mano para anotarla o dictarla.',
      confirmar: 'Regenerar',
      enCurso: 'Regenerando…',
      tono: 'primario',
      accion: async () => {
        const r = await api<UserView & { password: string }>(`/users/${u.username}/regenerate-password`, {
          method: 'POST',
        });
        setErrorCopia('');
        setCredencial({ username: r.username, password: r.password, nueva: false });
      },
    });
  }

  function pedirBaja(u: UserView) {
    setPedido({
      titulo: `Eliminar a ${u.username}`,
      subtitulo: 'La baja se puede deshacer',
      consecuencia: (
        <>
          La cuenta <strong>{u.username}</strong> deja de poder entrar a la consola y sale del listado.
        </>
      ),
      detalle:
        'El borrado es lógico: un administrador puede restaurarla más adelante desde «Ver eliminados». Hasta entonces el nombre de usuario sigue ocupado.',
      confirmar: 'Eliminar',
      enCurso: 'Eliminando…',
      accion: confirmada(() => api(`/users/${u.username}`, { method: 'DELETE' }), `Cuenta de ${u.username} eliminada.`),
    });
  }

  function creado(usuario: UserView & { password: string }) {
    setCreando(false);
    setErrorCopia('');
    setCredencial({ username: usuario.username, password: usuario.password, nueva: true });
    setRecarga((n) => n + 1);
  }

  function guardado() {
    if (editando) avisar(`Cambios de ${editando.username} guardados.`);
    setEditando(null);
    setRecarga((n) => n + 1);
  }

  /**
   * Copiar la contraseña decía nada, saliera bien o mal: fuera de un contexto
   * seguro el navegador no da portapapeles y el botón quedaba igual. Ahora lo
   * confirma el aviso, y si no se pudo, lo dice al lado de la contraseña.
   */
  async function copiarCredencial(password: string) {
    setErrorCopia('');
    try {
      if (!navigator.clipboard) throw new Error('sin portapapeles');
      await navigator.clipboard.writeText(password);
      avisar('Contraseña copiada.');
    } catch {
      setErrorCopia('No se pudo copiar: seleccioná la contraseña y copiala a mano.');
    }
  }

  // El backend sólo respeta `includeDeleted` para supervisor+; el filtro de acá
  // es el que garantiza que con el toggle apagado no se cuele ninguna baja.
  const visibles = users.filter((u) => verEliminados || !u.deleted);
  const hayBusqueda = (consultaMostrada ?? '').trim() !== '';

  return (
    <main className="page-main">
      <EncabezadoDeVista
        titulo="Usuarios"
        subtitulo={visibles.length > 0 ? resumenDeCuentas(visibles, hayBusqueda) : undefined}
        filtros={
          <input
            className="buscador"
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por usuario, nombre, DNI o rol…"
            aria-label="Buscar usuarios"
          />
        }
        opciones={
          esSupervisor && (
            <button
              type="button"
              className={`toggle-eliminados${verEliminados ? ' activo' : ''}`}
              aria-pressed={verEliminados}
              onClick={() => setVerEliminados((v) => !v)}
            >
              Ver eliminados
            </button>
          )
        }
        accion={
          esAdmin && (
            <button type="button" className="primario" onClick={() => setCreando(true)}>
              <IconoMas tamano={18} />
              Nuevo usuario
            </button>
          )
        }
      />

      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        {cargando && consultaMostrada === null && <EsqueletoDeTabla texto="Trayendo los usuarios…" />}
        {/* Sin el error afuera, con la carga caída el cartel decía que no
            había usuarios, o que la búsqueda no coincidía, sin haberla hecho.
            Mientras viaja la búsqueda siguiente el cartel queda, ocupado. */}
        {consultaMostrada !== null && !error && visibles.length === 0 && (
          <div aria-busy={cargando || undefined}>
            {hayBusqueda ? (
              <EstadoVacio titulo="Ningún usuario coincide con la búsqueda.">
                Probá con otra parte del nombre, el DNI sin puntos o el rol.
              </EstadoVacio>
            ) : (
              <EstadoVacio titulo="No hay usuarios para mostrar." />
            )}
          </div>
        )}
        {visibles.length > 0 && (
          <div className="tabla-envoltorio" aria-busy={cargando || undefined}>
            <table className="tabla tabla-gestion">
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Nombre</th>
                  <th>DNI</th>
                  <th>Rol</th>
                  <th>Control de drones</th>
                  <th>Estado</th>
                  {esSupervisor && <th className="columna-acciones">Acciones</th>}
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
                      {/* El nombre de la persona es lo que se busca con la vista:
                          va en negrita, como en el prototipo. */}
                      <td className="celda-nombre">{u.fullName || <span className="muted">—</span>}</td>
                      <td className="dni">{dni || <span className="muted">—</span>}</td>
                      <td>
                        {/* El rol en un sello con filo; el del administrador, en oro. */}
                        <span className={u.role === 'admin' ? 'rol admin' : 'rol'}>{ROL[u.role]}</span>
                      </td>
                      <td>
                        {controlAplica ? (
                          <span className="celda-con-accion">
                            <span className={`estado ${u.canControl ? 'ok' : 'bad'}`}>
                              {u.canControl ? 'Autorizado' : 'Suspendido'}
                            </span>
                            {puedeTocarControl && (
                              <button type="button" className="chico" onClick={() => alternarControl(u)}>
                                {u.canControl ? 'Suspender' : 'Autorizar'}
                              </button>
                            )}
                          </span>
                        ) : (
                          <span className="muted">No aplica</span>
                        )}
                      </td>
                      <td>
                        {eliminado ? (
                          // La misma pastilla de la ficha de un dron eliminado.
                          <span className="estado pastilla muted">Eliminado</span>
                        ) : (
                          <span className="celda-con-accion">
                            <span className={`estado ${u.active ? 'ok' : 'muted'}`}>
                              {u.active ? 'Activo' : 'Desactivado'}
                            </span>
                            {esAdmin && !esYo && (
                              <button type="button" className="chico" onClick={() => alternarActiva(u)}>
                                {u.active ? 'Desactivar' : 'Reactivar'}
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                      {esSupervisor && (
                        <td className="barra-acciones">
                          {/* El mismo grupo y el mismo orden que en Drones, Bases
                              y Rutas: Editar primero, Eliminar al final. */}
                          <div className="acciones-fila" role="group" aria-label={`Acciones de ${u.username}`}>
                            {puedeEditar && (
                              <BotonEditar etiqueta={`Editar a ${u.username}`} onClick={() => setEditando(u)} />
                            )}
                            {esAdmin &&
                              (eliminado ? (
                                <BotonRestaurar
                                  chico
                                  onClick={() =>
                                    void accion(
                                      () => api(`/users/${u.username}/restore`, { method: 'POST' }),
                                      `Cuenta de ${u.username} restaurada.`,
                                    )
                                  }
                                />
                              ) : (
                                <>
                                  <button type="button" className="chico" onClick={() => regenerar(u)}>
                                    Regenerar contraseña
                                  </button>
                                  {!esYo && <BotonEliminar onClick={() => pedirBaja(u)} />}
                                </>
                              ))}
                          </div>
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
            <button type="button" className="chico copiar-credencial" onClick={() => copiarCredencial(credencial.password)}>
              Copiar
            </button>
            {errorCopia && (
              <p className="aviso malo" role="alert">
                {errorCopia}
              </p>
            )}
          </div>
          <footer className="modal-pie">
            <button type="button" className="primario" onClick={() => setCredencial(null)}>
              Ya la anoté
            </button>
          </footer>
        </Modal>
      )}

      {pedido && <DialogoConfirmacion pedido={pedido} onCerrar={() => setPedido(null)} />}
    </main>
  );
}
