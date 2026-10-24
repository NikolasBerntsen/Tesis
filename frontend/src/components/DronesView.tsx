import { useEffect, useId, useRef, useState } from 'react';
import { api, traerBases, traerDrones } from '../api';
import type { BaseAsset, Drone, Me, NovedadDron } from '../types';
import { BotonEditar, BotonEliminar, BotonRestaurar } from './AccionesDeGestion';
import { useAvisar } from './AvisosFlotantes';
import DialogoConfirmacion, { type PedidoDeConfirmacion } from './DialogoConfirmacion';
import DialogoDron, { type CuerpoDron } from './DialogoDron';
import EncabezadoDeVista from './EncabezadoDeVista';
import { EsqueletoDeTabla, EstadoVacio } from './EstadosDeVista';
import { IconoDron, IconoMas, IconoQr } from './Iconos';
import QrDronModal from './QrDronModal';

/** Primeros 6 y últimos 4: alcanza para reconocer el dron sin volcar los 32 hex. */
function abreviar(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

/**
 * El dato corto de la cabecera, como el "0 en vuelo · 3 registrados" de
 * Operación: cuántos hay dados de alta y cuántos están conectados ahora.
 * Las bajas no cuentan, aunque estén a la vista con «Ver eliminados».
 */
function resumenDeFlota(drones: Drone[]): string {
  const vivos = drones.filter((d) => !d.deleted);
  const enLinea = vivos.filter((d) => d.online).length;
  return `${vivos.length} ${vivos.length === 1 ? 'registrado' : 'registrados'} · ${enLinea} en línea`;
}

/**
 * La pastilla de arriba a la derecha: si el dron está conectado ahora, que es
 * lo primero que se pregunta de un activo. Una baja dice que es una baja.
 */
function pastillaDelDron(dron: Drone): { clase: string; texto: string } {
  if (dron.deleted) return { clase: 'muted', texto: 'Eliminado' };
  return dron.online ? { clase: 'ok', texto: 'En línea' } : { clase: 'muted', texto: 'Desconectado' };
}

type PropsDeFicha = Readonly<{
  dron: Drone;
  esSupervisor: boolean;
  /** Si el identificador de este dron se acaba de copiar. */
  copiado: boolean;
  onCopiar: () => void;
  onAlternarOperativo: () => void;
  onEditar: () => void;
  onVerQr: () => void;
  onEliminar: () => void;
  onRestaurar: () => void;
}>;

/**
 * Lo que se puede hacer con un dron desde su ficha. Una baja sólo la ve el
 * supervisor (la vista la filtra para el resto), así que restaurar no
 * necesita preguntar el rol otra vez. El orden es el de todas las vistas de
 * gestión: Editar primero, Eliminar al final.
 */
function AccionesDelDron({ dron, esSupervisor, onEditar, onVerQr, onEliminar, onRestaurar }: PropsDeFicha) {
  return (
    <div className="ficha-acciones" role="group" aria-label={`Acciones de ${dron.displayName}`}>
      {dron.deleted ? (
        <BotonRestaurar onClick={onRestaurar} />
      ) : (
        <>
          {esSupervisor && <BotonEditar onClick={onEditar} />}
          <button type="button" onClick={onVerQr}>
            <IconoQr tamano={18} />
            Ver QR
          </button>
          {esSupervisor && <BotonEliminar onClick={onEliminar} />}
        </>
      )}
    </div>
  );
}

/**
 * Operativo o no: el supervisor lo cambia con el interruptor; el resto lo ve
 * escrito, con su punto. A una baja no se le muestra: la pastilla de arriba ya
 * dice "Eliminado".
 */
function EstadoOperativo({ dron, esSupervisor, onAlternarOperativo }: PropsDeFicha) {
  const texto = dron.active ? 'Operativo' : 'No operativo';
  if (!esSupervisor) return <span className={`estado ${dron.active ? 'ok' : 'muted'}`}>{texto}</span>;
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={dron.active}
        aria-label={`Dron ${dron.displayName} operativo`}
        onChange={onAlternarOperativo}
      />
      <span className="switch-pista" />
      <span className="switch-texto">{texto}</span>
    </label>
  );
}

/**
 * La ficha de un dron, como en el prototipo: el nombre en Cinzel con el modelo
 * debajo, la pastilla de si está conectado, los datos con su rótulo y las
 * acciones al pie. Es un panel translúcido con el hilo de oro, igual que las
 * cámaras de Operación.
 */
function FichaDeDron(props: PropsDeFicha) {
  const { dron, copiado, onCopiar } = props;
  const idNombre = useId();
  const pastilla = pastillaDelDron(dron);
  return (
    <li>
      <article className={dron.deleted ? 'ficha eliminada' : 'ficha'} aria-labelledby={idNombre}>
        <header className="ficha-cabecera">
          <div className="ficha-titulos">
            <h3 className="ficha-nombre" id={idNombre}>
              {dron.displayName}
            </h3>
            {/* Sin modelo, una raya: el renglón no desaparece y la ficha no salta. */}
            <p className="ficha-sub">{dron.model || '—'}</p>
          </div>
          <span className={`estado pastilla ${pastilla.clase}`}>{pastilla.texto}</span>
        </header>
        <dl className="ficha-datos">
          <div>
            <dt className="rotulo">Base</dt>
            <dd>{dron.base ? dron.base.name : <span className="muted">Sin base</span>}</dd>
          </div>
          {!dron.deleted && (
            <div>
              <dt className="rotulo">Estado</dt>
              <dd>
                <EstadoOperativo {...props} />
              </dd>
            </div>
          )}
          <div className="ficha-dato-ancho">
            <dt className="rotulo">Identificador</dt>
            <dd>
              <span className="hash">
                {abreviar(dron.hash)}
                <button type="button" aria-label={`Copiar el identificador de ${dron.displayName}`} onClick={onCopiar}>
                  {copiado ? 'Copiado' : 'Copiar'}
                </button>
              </span>
            </dd>
          </div>
        </dl>
        <AccionesDelDron {...props} />
      </article>
    </li>
  );
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

type PropsDronesView = Readonly<{
  me: Me;
  /**
   * Última novedad del canal en vivo: la ficha entera de `drone_updated`
   * (alta, edición, baja y restauración), `drone_online` y `drone_offline`, o
   * el renombre que la app inicia con `set_name`. La vista la mezcla en su
   * lista: con eso se mantiene al día sin volver a consultar cada tanto.
   */
  novedad?: NovedadDron | null;
}>;

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
  const [aConfirmar, setAConfirmar] = useState<PedidoDeConfirmacion | null>(null);
  const [copiado, setCopiado] = useState('');
  const temporizador = useRef<ReturnType<typeof setTimeout>>();
  const avisar = useAvisar();

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
   * Las acciones de cada ficha (interruptor, baja, restauración) devuelven la
   * ficha ya actualizada, así que no hay que recargar. Las que no preguntan
   * (restaurar, volver a poner operativo) dejan su error arriba de las fichas:
   * no hay ningún diálogo abierto donde mostrarlo.
   */
  async function accion(fn: () => Promise<Drone>, aviso: (ficha: Drone) => string) {
    setError('');
    try {
      const ficha = await fn();
      setDrones((prev) => upsert(prev, ficha));
      avisar(aviso(ficha));
    } catch (e) {
      setError(textoError(e));
    }
  }

  /**
   * Lo mismo para las que pasan por la confirmación: el error SUBE, para que
   * el diálogo lo muestre adentro y siga abierto. Tragárselo acá cerraría el
   * diálogo como si hubiera salido bien. Si sale bien, se lleva el error de
   * una acción anterior, como hace `accion`: si no, quedaba en rojo arriba de
   * las fichas al lado del aviso de "Dron eliminado".
   */
  function confirmada(fn: () => Promise<Drone>, aviso: (ficha: Drone) => string) {
    return async () => {
      const ficha = await fn();
      setError('');
      setDrones((prev) => upsert(prev, ficha));
      avisar(aviso(ficha));
    };
  }

  /**
   * Apagar un dron no es un dato más de la ficha: el Comando Central lo
   * desconecta en el acto y le suelta el control a quien lo tenga, aunque esté
   * en el aire. Por eso apagar pregunta y encender no.
   */
  function alternarOperativo(d: Drone) {
    const cambiar = () =>
      api<Drone>(`/drones/${d.hash}`, { method: 'PATCH', body: JSON.stringify({ active: !d.active }) });
    if (!d.active) {
      void accion(cambiar, (f) => `${f.displayName} quedó operativo.`);
      return;
    }
    setAConfirmar({
      titulo: `Marcar a ${d.displayName} como no operativo`,
      consecuencia:
        'El dron se desconecta del Comando Central en el acto y, si alguien lo está piloteando, pierde el control.',
      detalle: 'No va a poder volver a conectarse hasta que lo marques operativo otra vez.',
      confirmar: 'Marcar no operativo',
      enCurso: 'Guardando…',
      accion: confirmada(cambiar, (f) => `${f.displayName} quedó no operativo.`),
    });
  }

  function pedirBaja(d: Drone) {
    setAConfirmar({
      titulo: `Eliminar el dron ${d.displayName}`,
      subtitulo: 'La baja se puede deshacer',
      consecuencia: 'El dron se desconecta en el acto y sale de la operación; si alguien lo está piloteando, pierde el control.',
      detalle: 'Un supervisor lo puede restaurar después desde «Ver eliminados», con el mismo QR.',
      confirmar: 'Eliminar',
      enCurso: 'Eliminando…',
      accion: confirmada(
        () => api<Drone>(`/drones/${d.hash}`, { method: 'DELETE' }),
        (f) => `Dron ${f.displayName} eliminado.`,
      ),
    });
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
      avisar(`Cambios de ${ficha.displayName} guardados.`);
      return;
    }
    const ficha = await api<Drone>('/drones', { method: 'POST', body });
    setDrones((prev) => upsert(prev, ficha));
    setDialogo(undefined);
    avisar(`Dron ${ficha.displayName} dado de alta.`);
    // El sticker se abre solo: sin QR el dron recién dado de alta no se puede emparejar.
    setQr(ficha);
  }

  const visibles = drones.filter((d) => mostrarEliminados || !d.deleted);

  return (
    <main className="page-main">
      <EncabezadoDeVista
        titulo="Drones"
        subtitulo={visibles.length > 0 ? resumenDeFlota(drones) : undefined}
        opciones={
          esSupervisor && (
            // El rótulo no cambia al apretarlo: el estado lo dice aria-pressed
            // (y el filo dorado). Antes pasaba a "Ocultar eliminados", el botón
            // cambiaba de ancho bajo el mouse y el lector leía otro control.
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
          puedeDarDeAlta && (
            <button type="button" className="primario" onClick={() => setDialogo(null)}>
              <IconoMas tamano={18} />
              Nuevo dron
            </button>
          )
        }
      />

      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}

      {/* Mientras el pedido viaja no se puede afirmar que no haya drones: ese
          cartel es justo el que empuja a dar de alta uno que ya existe, y el
          alta genera un hash nuevo, o sea un activo duplicado con su propio QR.
          El panel sólo aparece si tiene algo que mostrar: con la carga caída,
          el aviso de arriba ya lo dice todo. */}
      {visibles.length === 0 && (cargando || !error) && (
        <section className="card">
          {cargando ? (
            <EsqueletoDeTabla texto="Trayendo los drones…" />
          ) : (
            <EstadoVacio titulo="Todavía no hay drones dados de alta." icono={<IconoDron tamano={46} />}>
              {puedeDarDeAlta
                ? 'Con «Nuevo dron» se da de alta y sale su sticker con el QR, que la app escanea para emparejarse.'
                : 'Cuando un supervisor o un operador de campo dé de alta uno, va a aparecer acá.'}
            </EstadoVacio>
          )}
        </section>
      )}
      {visibles.length > 0 && (
        // Con las fichas a la vista, una recarga (el interruptor de
        // eliminados) no las saca: las apaga un poco mientras llega la lista
        // nueva, y así la vista no salta a un cartel y de vuelta.
        <ul className="fichas" aria-label="Drones dados de alta" aria-busy={cargando || undefined}>
          {visibles.map((d) => (
            <FichaDeDron
              key={d.hash}
              dron={d}
              esSupervisor={esSupervisor}
              copiado={copiado === d.hash}
              onCopiar={() => void copiar(d.hash)}
              onAlternarOperativo={() => alternarOperativo(d)}
              onEditar={() => setDialogo(d)}
              onVerQr={() => setQr(d)}
              onEliminar={() => pedirBaja(d)}
              onRestaurar={() =>
                void accion(
                  () => api<Drone>(`/drones/${d.hash}/restore`, { method: 'POST' }),
                  (f) => `Dron ${f.displayName} restaurado.`,
                )
              }
            />
          ))}
        </ul>
      )}

      {dialogo !== undefined && (
        <DialogoDron dron={dialogo} bases={bases} onGuardar={guardarDron} onCerrar={() => setDialogo(undefined)} />
      )}

      {qr && <QrDronModal dron={qr} onCerrar={() => setQr(null)} />}

      {aConfirmar && <DialogoConfirmacion pedido={aConfirmar} onCerrar={() => setAConfirmar(null)} />}
    </main>
  );
}
