import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { BaseAsset, Drone } from '../types';
import IconoCerrar from './IconoCerrar';
import Modal from './Modal';

/** Lo que el backend acepta en el alta y en la edición de un dron. */
export type CuerpoDron = {
  displayName?: string;
  model?: string;
  inventoryCode?: string;
  baseId?: number | null;
};

type Formulario = {
  displayName: string;
  model: string;
  inventoryCode: string;
  baseId: number | null;
};

const VACIO: Formulario = { displayName: '', model: '', inventoryCode: '', baseId: null };

function formularioDe(d: Drone | null): Formulario {
  return d ? { displayName: d.displayName, model: d.model, inventoryCode: d.inventoryCode, baseId: d.baseId } : VACIO;
}

/**
 * El alta manda todo lo que se completó; la edición, sólo lo que cambió. Un
 * PATCH sin cambios traería un 400 "Nada para modificar", y uno con todos los
 * campos pisaría lo que otra consola haya editado mientras tanto.
 */
function armarCuerpo(f: Formulario, dron: Drone | null): CuerpoDron {
  const limpio = { displayName: f.displayName.trim(), model: f.model.trim(), inventoryCode: f.inventoryCode.trim() };
  if (!dron) return { ...limpio, ...(f.baseId == null ? {} : { baseId: f.baseId }) };
  const cuerpo: CuerpoDron = {};
  if (limpio.displayName !== dron.displayName) cuerpo.displayName = limpio.displayName;
  if (limpio.model !== dron.model) cuerpo.model = limpio.model;
  if (limpio.inventoryCode !== dron.inventoryCode) cuerpo.inventoryCode = limpio.inventoryCode;
  if (f.baseId !== dron.baseId) cuerpo.baseId = f.baseId;
  return cuerpo;
}

function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  // "Cambiar" reemplaza la base elegida por el buscador, que recién existe en
  // el render siguiente: el pedido de foco queda anotado hasta que aparezca.
  const pedirFoco = useRef(false);
  // Y al revés: elegir una base saca el buscador (o la opción clickeada) del
  // DOM, y sin esto el foco caía en <body>, fuera del diálogo, donde el
  // siguiente Enter o Tab ya no hacía nada. Va a "Cambiar", que es lo que
  // ocupa su lugar.
  const enfocarCambiar = useRef(false);
  const idRotulo = useId();
  const idAyuda = useId();
  const elegida = bases.find((b) => b.id === valor) ?? null;
  const hayBusqueda = texto.trim() !== '';

  const filtradas = useMemo(() => {
    const q = texto.trim().toLowerCase();
    return q ? bases.filter((b) => b.name.toLowerCase().includes(q)) : bases;
  }, [bases, texto]);

  function elegir(id: number) {
    onElegir(id);
    setAbierto(false);
    setTexto('');
    enfocarCambiar.current = true;
  }

  /**
   * Adentro del buscador, Enter elige la primera base que coincide en vez de
   * mandar el formulario a medio hacer, y Escape cierra la lista en vez del
   * diálogo entero: con la lista abierta, eso es lo que la persona quiso decir.
   *
   * Pero sólo si escribió algo. La lista se abre con sólo enfocar el buscador,
   * que es el último campo: quien llega tabulando y aprieta Enter quiere mandar
   * el formulario, no que se le asigne en silencio la primera base de la lista.
   */
  function alTeclear(e: KeyboardEvent<HTMLInputElement>) {
    if (!abierto) return;
    if (e.key === 'Enter') {
      if (!hayBusqueda) return;
      e.preventDefault();
      if (filtradas.length > 0) elegir(filtradas[0].id);
    } else if (e.key === 'Escape') {
      // El diálogo escucha Escape en `document`: sin frenar el evento acá, la
      // tecla que cierra la lista también cerraría el formulario.
      e.nativeEvent.stopPropagation();
      setAbierto(false);
    }
  }

  return (
    <div className="campo campo-ancho" role="group" aria-labelledby={idRotulo} aria-describedby={idAyuda}>
      <span className="campo-rotulo" id={idRotulo}>
        Base
      </span>
      {elegida && !abierto ? (
        <div className="base-elegida">
          <span className="inscripcion">{elegida.name}</span>
          <span className="muted mono">
            {elegida.lat.toFixed(5)}, {elegida.lon.toFixed(5)}
          </span>
          <span className="base-elegida-acciones">
            <button
              type="button"
              className="chico"
              ref={(nodo) => {
                if (nodo && enfocarCambiar.current) {
                  enfocarCambiar.current = false;
                  nodo.focus();
                }
              }}
              onClick={() => {
                pedirFoco.current = true;
                setAbierto(true);
              }}
            >
              Cambiar
            </button>
            <button type="button" className="chico ghost" onClick={() => onElegir(null)}>
              Quitar
            </button>
          </span>
        </div>
      ) : (
        <>
          <input
            ref={(nodo) => {
              if (nodo && pedirFoco.current) {
                pedirFoco.current = false;
                nodo.focus();
              }
            }}
            value={texto}
            onChange={(e) => {
              setTexto(e.target.value);
              setAbierto(true);
            }}
            onFocus={() => setAbierto(true)}
            onKeyDown={alTeclear}
            placeholder={bases.length ? 'Escribí para buscar una base…' : 'No hay bases dadas de alta'}
            disabled={bases.length === 0}
            aria-label="Buscar base"
            autoComplete="off"
          />
          {abierto && (
            <ul className="lista-bases" role="listbox" aria-label="Bases">
              {filtradas.length === 0 && <li className="muted">Ninguna base coincide.</li>}
              {filtradas.map((b) => (
                <li key={b.id}>
                  <button type="button" role="option" aria-selected={b.id === valor} onClick={() => elegir(b.id)}>
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
      <p className="campo-ayuda" id={idAyuda}>
        Es opcional: sin base, el dron queda sin punto de retorno asignado.
      </p>
    </div>
  );
}

/**
 * Alta y edición de un dron en un diálogo. Antes eran formularios que se
 * desplegaban como una fila más de la tabla: la edición empujaba a las demás
 * filas y el alta vivía abajo de todo, lejos del botón que la pedía.
 *
 * El diálogo no habla con el backend: le pasa el cuerpo a `onGuardar`, que lo
 * manda y cierra. Si `onGuardar` falla, el mensaje del backend se lee acá
 * adentro y lo escrito queda como estaba, para corregir y volver a intentar.
 */
export default function DialogoDron({
  dron,
  bases,
  onGuardar,
  onCerrar,
}: {
  /** `null` es un alta; un dron es la edición de ese dron. */
  dron: Drone | null;
  bases: BaseAsset[];
  onGuardar: (cuerpo: CuerpoDron) => Promise<void>;
  onCerrar: () => void;
}) {
  const [form, setForm] = useState<Formulario>(() => formularioDe(dron));
  const [nombreTocado, setNombreTocado] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const idTitulo = useId();
  const idNombre = useId();
  const idErrorNombre = useId();

  const nombreValido = form.displayName.trim().length > 0;
  const mostrarErrorNombre = nombreTocado && !nombreValido;

  /**
   * Con el pedido en viaje, cerrar ya no es "salir sin guardar": el backend lo
   * va a procesar igual, y cuando conteste el padre cerraría lo que esté
   * abierto en ese momento (otro alta a medio escribir, por ejemplo) y abriría
   * el sticker de un dron que se creyó cancelado. Por eso Cancelar y la cruz
   * se apagan, y Escape y el clic en el velo no hacen nada hasta que conteste.
   */
  function cerrar() {
    if (!guardando) onCerrar();
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    // Con el nombre vacío el botón está apagado; esto cubre el Enter de un
    // navegador que igual intente mandar el formulario.
    if (!nombreValido) {
      setNombreTocado(true);
      return;
    }
    const cuerpo = armarCuerpo(form, dron);
    if (Object.keys(cuerpo).length === 0) {
      onCerrar();
      return;
    }
    setError('');
    setGuardando(true);
    try {
      await onGuardar(cuerpo);
    } catch (err) {
      setError(textoError(err));
      setGuardando(false);
    }
  }

  return (
    <Modal etiquetadoPor={idTitulo} enfocarPrimerCampo onCerrar={cerrar}>
      <header className="modal-cabecera">
        <div>
          <h2 className="modal-titulo" id={idTitulo}>
            {dron ? 'Editar dron' : 'Nuevo dron'}
          </h2>
          <p className="modal-subtitulo">{dron ? dron.displayName : 'Después del alta se abre su sticker con el QR'}</p>
        </div>
        <button type="button" className="modal-cerrar" aria-label="Cerrar" onClick={cerrar} disabled={guardando}>
          <IconoCerrar />
        </button>
      </header>

      <form className="modal-formulario" onSubmit={enviar} noValidate>
        <div className="modal-cuerpo">
          {error && (
            <p className="aviso malo" role="alert">
              {error}
            </p>
          )}
          <div className="campos">
            <div className="campo campo-ancho">
              <label className="campo-rotulo" htmlFor={idNombre}>
                Nombre
              </label>
              <input
                id={idNombre}
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                onBlur={() => setNombreTocado(true)}
                maxLength={40}
                aria-required="true"
                aria-invalid={mostrarErrorNombre}
                aria-describedby={mostrarErrorNombre ? idErrorNombre : undefined}
                autoComplete="off"
              />
              {mostrarErrorNombre && (
                <p className="campo-error" id={idErrorNombre}>
                  Poné un nombre: es el que se ve en la consola y en el sticker.
                </p>
              )}
            </div>
            <label className="campo">
              <span className="campo-rotulo">Modelo</span>
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                maxLength={40}
                placeholder="DJI Mini 4 Pro"
                autoComplete="off"
              />
            </label>
            <label className="campo">
              <span className="campo-rotulo">Número de inventario</span>
              <input
                value={form.inventoryCode}
                onChange={(e) => setForm({ ...form, inventoryCode: e.target.value })}
                maxLength={30}
                placeholder="INV-0042"
                autoComplete="off"
              />
            </label>
            <SelectorDeBase bases={bases} valor={form.baseId} onElegir={(baseId) => setForm({ ...form, baseId })} />
          </div>
        </div>

        <footer className="modal-pie">
          {!nombreValido && <p className="pie-nota">Falta el nombre del dron.</p>}
          <button type="button" className="ghost" onClick={cerrar} disabled={guardando}>
            Cancelar
          </button>
          <button type="submit" className="primario" disabled={!nombreValido || guardando}>
            {guardando ? 'Guardando…' : dron ? 'Guardar cambios' : 'Dar de alta'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
