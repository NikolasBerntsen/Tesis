import { useId, useState, type FormEvent } from 'react';
import { api } from '../api';
import { AYUDA_DNI, formatearDni, normalizarDni } from '../dni';
import type { AltaDeUsuario, CambiosDeUsuario, RolAsignable, RolConsola, UserView } from '../types';
import Modal from './Modal';

export const ROL: Record<RolConsola, string> = {
  field_operator: 'Operador de campo',
  operator: 'Operador',
  supervisor: 'Supervisor',
  admin: 'Administrador',
};

/** Los roles que el backend deja dar, al alta o después: un admin no se crea ni se fabrica desde acá. */
const ROLES_ASIGNABLES: readonly RolAsignable[] = ['operator', 'supervisor', 'field_operator'];

export const ICONO_CERRAR = {
  width: 15,
  height: 15,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  'aria-hidden': true,
} as const;

const NOTA_CAMPO =
  'El operador de campo no opera drones: sólo los da de alta y los empareja por QR, así que el sistema le niega el control.';

export function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** El `value` del select llega como string suelto: se valida contra la lista. */
function rolAsignable(valor: string): RolAsignable | undefined {
  return ROLES_ASIGNABLES.find((r) => r === valor);
}

function Cabecera({
  idTitulo,
  titulo,
  subtitulo,
  onCerrar,
}: {
  idTitulo: string;
  titulo: string;
  subtitulo: string;
  onCerrar: () => void;
}) {
  return (
    <header className="modal-cabecera">
      <div>
        <h2 className="modal-titulo" id={idTitulo}>
          {titulo}
        </h2>
        <p className="modal-subtitulo">{subtitulo}</p>
      </div>
      <button type="button" className="modal-cerrar" aria-label="Cerrar sin guardar" onClick={onCerrar}>
        <svg {...ICONO_CERRAR}>
          <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
        </svg>
      </button>
    </header>
  );
}

/**
 * El DNI con su error abajo. El error queda FUERA de la etiqueta a propósito:
 * adentro pasaría a formar parte del nombre accesible del campo, y el lector
 * de pantalla anunciaría "DNI, el DNI tiene que tener…" como si fuera el rótulo.
 */
function CampoDni({
  valor,
  error,
  deshabilitado,
  onCambiar,
}: {
  valor: string;
  error: string;
  deshabilitado?: boolean;
  onCambiar: (valor: string) => void;
}) {
  const idError = useId();
  return (
    <div className="form-usuario-campo">
      <label>
        DNI
        <input
          value={valor}
          onChange={(e) => onCambiar(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="30.123.456"
          maxLength={12}
          disabled={deshabilitado}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? idError : undefined}
        />
      </label>
      {error && (
        <p className="form-usuario-error" id={idError}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * El permiso de control con su explicación. Para el operador de campo la
 * casilla se apaga y se deshabilita: el backend se lo niega igual, y mostrarla
 * prendida sería prometer un permiso que no va a existir.
 */
function CasillaControl({
  marcada,
  esOperadorDeCampo,
  onCambiar,
}: {
  marcada: boolean;
  esOperadorDeCampo: boolean;
  onCambiar: (marcada: boolean) => void;
}) {
  const idNota = useId();
  return (
    <>
      <label className="form-usuario-casilla">
        <input
          type="checkbox"
          checked={!esOperadorDeCampo && marcada}
          disabled={esOperadorDeCampo}
          aria-describedby={esOperadorDeCampo ? idNota : undefined}
          onChange={(e) => onCambiar(e.target.checked)}
        />
        Puede controlar drones
      </label>
      {esOperadorDeCampo && (
        <p className="form-usuario-nota" id={idNota}>
          {NOTA_CAMPO}
        </p>
      )}
    </>
  );
}

/** Mientras se tipea, `dni` es el texto tal cual: se normaliza recién al crear. */
const ALTA_VACIA: AltaDeUsuario = { username: '', fullName: '', dni: '', role: 'operator', canControl: true };

/**
 * Alta de una cuenta. La contraseña no se elige: la genera el backend y quien
 * abrió este diálogo la recibe en `onCreado`, para mostrarla una sola vez.
 */
export function DialogoNuevoUsuario({
  onCerrar,
  onCreado,
}: {
  onCerrar: () => void;
  onCreado: (creado: UserView & { password: string }) => void;
}) {
  const idTitulo = useId();
  const [ficha, setFicha] = useState<AltaDeUsuario>(ALTA_VACIA);
  const [errorDni, setErrorDni] = useState('');
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const esOperadorDeCampo = ficha.role === 'field_operator';

  async function crear(e: FormEvent) {
    e.preventDefault();
    const dni = normalizarDni(ficha.dni);
    if (!dni) {
      setErrorDni(AYUDA_DNI);
      return;
    }
    setError('');
    setGuardando(true);
    // El backend le fuerza `canControl:false` al operador de campo; se manda
    // ya resuelto para que el alta no prometa un permiso que no va a existir.
    const cuerpo: AltaDeUsuario = { ...ficha, dni, canControl: !esOperadorDeCampo && ficha.canControl };
    try {
      onCreado(await api<UserView & { password: string }>('/users', { method: 'POST', body: JSON.stringify(cuerpo) }));
    } catch (err) {
      // El diálogo queda abierto con lo tipeado: el nombre o el DNI rechazados
      // siguen ahí para corregirlos.
      setError(textoError(err));
      setGuardando(false);
    }
  }

  return (
    <Modal etiquetadoPor={idTitulo} onCerrar={onCerrar}>
      <Cabecera idTitulo={idTitulo} titulo="Nuevo usuario" subtitulo="La contraseña la genera el sistema" onCerrar={onCerrar} />
      <form className="dialogo-usuario" aria-label="Nuevo usuario" onSubmit={crear}>
        <div className="modal-cuerpo">
          {error && (
            <p className="aviso malo" role="alert">
              {error}
            </p>
          )}
          <div className="form-usuario">
            <label>
              Usuario
              <input
                value={ficha.username}
                onChange={(e) => setFicha({ ...ficha, username: e.target.value })}
                autoComplete="off"
                maxLength={30}
                required
              />
            </label>
            <label>
              Nombre y apellido
              <input
                value={ficha.fullName}
                onChange={(e) => setFicha({ ...ficha, fullName: e.target.value })}
                minLength={3}
                maxLength={60}
                required
              />
            </label>
            <CampoDni
              valor={ficha.dni}
              error={errorDni}
              onCambiar={(dni) => {
                setFicha({ ...ficha, dni });
                setErrorDni('');
              }}
            />
            <label>
              Rol
              <select
                value={ficha.role}
                onChange={(e) => setFicha({ ...ficha, role: rolAsignable(e.target.value) ?? 'operator' })}
              >
                {ROLES_ASIGNABLES.map((r) => (
                  <option key={r} value={r}>
                    {ROL[r]}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-usuario-casillas">
              <CasillaControl
                marcada={ficha.canControl}
                esOperadorDeCampo={esOperadorDeCampo}
                onCambiar={(canControl) => setFicha({ ...ficha, canControl })}
              />
            </div>
          </div>
        </div>
        <footer className="modal-pie">
          <button type="button" className="ghost" onClick={onCerrar}>
            Cancelar
          </button>
          <button type="submit" className="primario" disabled={guardando}>
            {guardando ? 'Creando…' : 'Crear'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

type Ficha = { fullName: string; dni: string; canControl: boolean; active: boolean };

/**
 * Edición de una cuenta. El admin cambia todo lo que el backend le deja:
 * nombre, DNI, rol, control y si la cuenta está activa. El supervisor sólo
 * autoriza o suspende el control de los operadores, así que ve la ficha entera
 * pero con todo lo demás bloqueado: le sirve para saber a quién está tocando.
 *
 * Se manda sólo lo que cambió. No es cosmético: pedir el rol que la cuenta ya
 * tiene no la saca de la consola, pero el registro tiene que decir qué cambió
 * de verdad y no la ficha entera.
 */
export function DialogoEditarUsuario({
  usuario,
  esAdmin,
  onCerrar,
  onGuardado,
}: {
  usuario: UserView;
  esAdmin: boolean;
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const idTitulo = useId();
  const [ficha, setFicha] = useState<Ficha>({
    fullName: usuario.fullName,
    dni: formatearDni(usuario.dni),
    canControl: usuario.canControl,
    active: usuario.active,
  });
  // El rol va aparte porque el de un admin no es asignable: `null` es "el que
  // ya tiene", y así el rol nuevo, cuando lo hay, es siempre uno que se puede dar.
  const [rolNuevo, setRolNuevo] = useState<RolAsignable | null>(null);
  const [errorDni, setErrorDni] = useState('');
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);

  const esAdminElEditado = usuario.role === 'admin';
  const rol: RolConsola = rolNuevo ?? usuario.role;
  const esOperadorDeCampo = rol === 'field_operator';
  const opcionesDeRol: readonly RolConsola[] = esAdminElEditado ? ['admin'] : ROLES_ASIGNABLES;

  function elegirRol(valor: string) {
    const elegido = rolAsignable(valor);
    setRolNuevo(elegido && elegido !== usuario.role ? elegido : null);
  }

  /** Lo que cambió respecto de la cuenta, o null si el DNI tipeado no es válido. */
  function cambios(): CambiosDeUsuario | null {
    const resultado: CambiosDeUsuario = {};
    const control = !esOperadorDeCampo && ficha.canControl;
    if (control !== usuario.canControl) resultado.canControl = control;
    if (!esAdmin) return resultado;

    const fullName = ficha.fullName.trim();
    if (fullName !== usuario.fullName) resultado.fullName = fullName;
    // Una cuenta vieja sin DNI puede seguir sin él; una que lo tiene no puede
    // quedarse vacía, y eso lo dice la validación como cualquier otro error.
    const textoDni = ficha.dni.trim();
    if (textoDni !== '' || usuario.dni) {
      const dni = normalizarDni(textoDni);
      if (!dni) return null;
      if (dni !== usuario.dni) resultado.dni = dni;
    }
    if (rolNuevo) resultado.role = rolNuevo;
    if (ficha.active !== usuario.active) resultado.active = ficha.active;
    return resultado;
  }

  async function guardar(e: FormEvent) {
    e.preventDefault();
    const cuerpo = cambios();
    if (!cuerpo) {
      setErrorDni(AYUDA_DNI);
      return;
    }
    // Sin cambios no hay nada que pedirle al backend, que además contestaría
    // "Nada para modificar": guardar una ficha intacta es simplemente cerrarla.
    if (Object.keys(cuerpo).length === 0) {
      onCerrar();
      return;
    }
    setError('');
    setGuardando(true);
    try {
      await api(`/users/${usuario.username}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
      onGuardado();
    } catch (err) {
      setError(textoError(err));
      setGuardando(false);
    }
  }

  return (
    <Modal etiquetadoPor={idTitulo} onCerrar={onCerrar}>
      <Cabecera idTitulo={idTitulo} titulo={`Editar a ${usuario.username}`} subtitulo={ROL[usuario.role]} onCerrar={onCerrar} />
      <form className="dialogo-usuario" aria-label={`Editar a ${usuario.username}`} onSubmit={guardar}>
        <div className="modal-cuerpo">
          {error && (
            <p className="aviso malo" role="alert">
              {error}
            </p>
          )}
          {!esAdmin && (
            <p className="aviso">
              Como supervisor podés autorizar o suspender el control de drones. El resto de la ficha lo cambia un
              administrador.
            </p>
          )}
          <div className="form-usuario">
            <label>
              Nombre y apellido
              <input
                value={ficha.fullName}
                onChange={(e) => setFicha({ ...ficha, fullName: e.target.value })}
                minLength={3}
                maxLength={60}
                required
                disabled={!esAdmin}
              />
            </label>
            <CampoDni
              valor={ficha.dni}
              error={errorDni}
              deshabilitado={!esAdmin}
              onCambiar={(dni) => {
                setFicha({ ...ficha, dni });
                setErrorDni('');
              }}
            />
            <div className="form-usuario-campo">
              <label>
                Rol
                <select value={rol} disabled={!esAdmin || esAdminElEditado} onChange={(e) => elegirRol(e.target.value)}>
                  {opcionesDeRol.map((r) => (
                    <option key={r} value={r}>
                      {ROL[r]}
                    </option>
                  ))}
                </select>
              </label>
              {esAdmin && esAdminElEditado && (
                <p className="form-usuario-nota">El rol de un administrador no se cambia desde la consola.</p>
              )}
            </div>
            <div className="form-usuario-casillas">
              <CasillaControl
                marcada={ficha.canControl}
                esOperadorDeCampo={esOperadorDeCampo}
                onCambiar={(canControl) => setFicha({ ...ficha, canControl })}
              />
              <label className="form-usuario-casilla">
                <input
                  type="checkbox"
                  checked={ficha.active}
                  disabled={!esAdmin}
                  onChange={(e) => setFicha({ ...ficha, active: e.target.checked })}
                />
                Cuenta activa
              </label>
            </div>
          </div>
          {rolNuevo && (
            <p className="aviso" role="status">
              Al guardar, {usuario.username} va a tener que volver a iniciar sesión para entrar con el rol nuevo.
            </p>
          )}
        </div>
        <footer className="modal-pie">
          <button type="button" className="ghost" onClick={onCerrar}>
            Cancelar
          </button>
          <button type="submit" className="primario" disabled={guardando}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
