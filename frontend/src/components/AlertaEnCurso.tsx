import { useEffect, useId, useRef, type FocusEvent, type KeyboardEvent } from 'react';
import { time } from '../format';
import type { Alert, Drone } from '../types';
import { useCarruselDeAlertas } from '../useCarruselDeAlertas';
import { useDecisionDeAlerta, type DecidirAlerta } from '../useDecisionDeAlerta';

const TIPO = { PERSON: 'PERSONA', VEHICLE: 'VEHÍCULO' } as const;

/** Chevron de los pasos del carrusel: un solo trazo, espejado para el otro lado. */
function Chevron({ hacia }: { hacia: 'atras' | 'adelante' }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={hacia === 'atras' ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Las alertas pendientes, de a una y con flechas para recorrerlas.
 *
 * Decidir una alerta es comparar dos imágenes: la captura que disparó la
 * detección y lo que el dron está viendo AHORA, sobre el objetivo. En la vista
 * del dron la tarjeta va al lado de su video en vivo; en el tablero, arriba de
 * las cámaras de la flota, con el nombre del dron para ir a su vista.
 *
 * Antes se mostraba sólo la más nueva y la siguiente aparecía recién al decidir
 * esa: con dos detecciones seguidas, el operador no sabía qué le esperaba
 * detrás ni podía mirar primero la más grave. Ahora se recorren todas, y la
 * lista puede cambiar debajo (llegan alertas, otra consola decide una) sin
 * moverle la que tiene en pantalla: eso lo resuelve `useCarruselDeAlertas`.
 *
 * La campana sigue existiendo: es la que avisa desde cualquier vista. Las dos
 * deciden con el mismo hook, así que un rechazo se ve igual en las dos.
 */
export default function AlertaEnCurso({
  alertas,
  titulo = 'Alerta en curso',
  seguidas = [],
  drones,
  onVerDron,
  apaisada = false,
  onDecidir,
}: {
  /** Las pendientes a recorrer, en cualquier orden: la más nueva va primero. */
  alertas: readonly Alert[];
  titulo?: string;
  /** Ids de las alertas cuyo objetivo algún dron está orbitando o siguiendo. */
  seguidas?: readonly (number | null)[];
  /** Con `onVerDron`, cada alerta dice de qué dron es y lleva a su vista. */
  drones?: readonly Drone[];
  onVerDron?: (droneId: string) => void;
  /** Captura y botones lado a lado: para el ancho completo del tablero. */
  apaisada?: boolean;
  onDecidir: DecidirAlerta;
}) {
  const carrusel = useCarruselDeAlertas(alertas);
  const { decidir, errorDe, decidiendo } = useDecisionDeAlerta(onDecidir);
  const idTitulo = useId();
  const seccion = useRef<HTMLElement>(null);
  const focoAdentro = useRef(false);
  const alerta = carrusel.actual;
  const varias = carrusel.total > 1;
  // Tampoco se decide la que recién entró en lugar de la que se fue: queda en
  // el mismo lugar que la otra, y el segundo click de un doble click en Validar
  // la validaba sin que nadie la hubiera visto (ver ESPERA_DEL_RELEVO_MS).
  const ocupado = alerta !== null && (decidiendo(alerta.id) || carrusel.enRelevo);

  // La alerta en pantalla se dibuja con `key` por id: al irse la que se decidió,
  // los botones de Validar y Descartar se rehacen en vez de pasar a ser los de
  // la vecina. Si no, el foco seguía en "Validar" y un segundo Enter validaba
  // otra alerta sin que el operador la hubiera mirado (el mismo riesgo con el
  // puntero lo cubre el relevo, arriba). El costo es que el foco se cae: al
  // quitarse esos botones, y antes, al deshabilitarse mientras viaja la
  // decisión. Se lo devuelve al carrusel, para que las flechas del teclado
  // sigan andando y el operador no vuelva al principio de la página. Sólo si
  // estaba adentro y no quedó en ningún lado: nunca se lo roba a otra pieza.
  useEffect(() => {
    const caja = seccion.current;
    const enNingunLado = document.activeElement === null || document.activeElement === document.body;
    if (caja && focoAdentro.current && enNingunLado) caja.focus();
  }, [alerta?.id, ocupado]);

  if (!alerta) return null;

  const error = errorDe(alerta.id);
  const siguiendo = seguidas.includes(alerta.id);
  const dron = drones?.find((d) => d.droneId === alerta.drone_id) ?? null;

  function alTeclear(ev: KeyboardEvent<HTMLElement>) {
    // Con modificadores son atajos del navegador (Alt+← es "atrás"): no se tocan.
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    if (ev.key === 'ArrowLeft') carrusel.anterior();
    else if (ev.key === 'ArrowRight') carrusel.siguiente();
    else return;
    ev.preventDefault();
  }

  function alSalirElFoco(ev: FocusEvent<HTMLElement>) {
    const destino = ev.relatedTarget as Node | null;
    if (destino && ev.currentTarget.contains(destino)) return;
    // Sin destino, el foco puede haberse caído solo —el botón se deshabilitó o
    // se quitó—, y eso no es que el operador se haya ido del carrusel.
    const origen = ev.target as HTMLButtonElement;
    const caido = destino === null && (origen.disabled === true || !origen.isConnected);
    if (!caido) focoAdentro.current = false;
  }

  return (
    // El carrusel se recorre con las flechas cuando el foco está en cualquier
    // parte de la tarjeta (patrón de carrusel del APG); los botones anterior y
    // siguiente son el camino sin teclado.
    <section // NOSONAR(S6847): carrusel recorrible con flechas, ver arriba
      ref={seccion}
      className={apaisada ? 'card alerta-en-curso apaisada' : 'card alerta-en-curso'}
      aria-labelledby={idTitulo}
      aria-roledescription={varias ? 'carrusel' : undefined}
      // En el orden del tabulador sólo con algo para recorrer: así un click en
      // la tarjeta ya deja andando las flechas. Con una sola queda enfocable
      // por código (-1), que es adonde vuelve el foco al decidir la penúltima.
      tabIndex={varias ? 0 : -1} // NOSONAR(S6845): la tarjeta del carrusel recibe el foco para las flechas
      onKeyDown={varias ? alTeclear : undefined}
      onFocus={() => (focoAdentro.current = true)}
      onBlur={alSalirElFoco}
    >
      <div className="carrusel-cabecera">
        {/* El título del tablero lleva la cuenta ("3 alertas sin atender"):
            se anuncia al cambiar, como lo hacía la franja que reemplaza. */}
        <h2 id={idTitulo} aria-live="polite">
          {titulo}
        </h2>
        {/* Los pasos están siempre, vacíos con una sola alerta: adentro va la
            región que anuncia la cuenta, y una región viva que aparece ya con
            su texto no se anuncia. Si naciera con la segunda alerta, en la
            vista del dron —cuyo título no cambia— esa llegada pasaba callada. */}
        <div
          className="carrusel-pasos"
          role={varias ? 'group' : undefined}
          aria-label={varias ? 'Recorrer las alertas pendientes' : undefined}
        >
          {/* `aria-disabled` y no `disabled`: un botón deshabilitado suelta el
              foco, y el operador que llegaba a la punta con el teclado se
              quedaba sin flechas. Así sigue enfocado y el paso no hace nada. */}
          {varias && (
            <button
              type="button"
              className="icono-boton carrusel-paso"
              aria-label="Alerta anterior, más nueva"
              aria-disabled={!carrusel.hayAnterior}
              onClick={carrusel.anterior}
            >
              <Chevron hacia="atras" />
            </button>
          )}
          {/* El contenedor del aviso queda fijo y la pastilla se rehace con
              cada tanda nueva (`key`): así el pulso se repite y el lector de
              pantalla anuncia el número nuevo. Las nuevas sin ver se dicen acá
              y no en el botón de abrirlas, que aparece sin anunciarse. */}
          <span className="carrusel-indicador" role="status" aria-live="polite" aria-atomic="true">
            {varias && (
              <>
                <span className="carrusel-solo-lector">Alerta </span>
                <span
                  key={carrusel.llegadas}
                  className={carrusel.llegadas > 0 ? 'badge carrusel-cuenta llego' : 'badge carrusel-cuenta'}
                  data-testid="carrusel-cuenta"
                >
                  {carrusel.posicion} de {carrusel.total}
                </span>
              </>
            )}
            {carrusel.sinVer > 0 && (
              <span className="carrusel-solo-lector">
                {carrusel.sinVer === 1 ? ', una alerta nueva sin ver' : `, ${carrusel.sinVer} alertas nuevas sin ver`}
              </span>
            )}
          </span>
          {varias && (
            <button
              type="button"
              className="icono-boton carrusel-paso"
              aria-label="Alerta siguiente, más vieja"
              aria-disabled={!carrusel.haySiguiente}
              onClick={carrusel.siguiente}
            >
              <Chevron hacia="adelante" />
            </button>
          )}
        </div>
      </div>

      {/* El pulso de la cuenta es movimiento, y con movimiento reducido no se
          ve: este aviso queda quieto hasta que el operador abre la nueva. */}
      {carrusel.sinVer > 0 && (
        <button type="button" className="enlace carrusel-nuevas" onClick={carrusel.irALaNueva}>
          {carrusel.sinVer === 1 ? 'Ver la alerta nueva' : `Ver las ${carrusel.sinVer} alertas nuevas`}
        </button>
      )}

      <div
        key={alerta.id}
        className="carrusel-diapositiva"
        role={varias ? 'group' : undefined}
        aria-roledescription={varias ? 'alerta' : undefined}
        aria-label={varias ? `${carrusel.posicion} de ${carrusel.total}` : undefined}
      >
        <div className="alert-head">
          <span className={`badge ${alerta.type.toLowerCase()}`}>{TIPO[alerta.type] ?? alerta.type}</span>
          {/* Como en la campana: el nombre del dron es el que lleva a su vista. */}
          {onVerDron && (
            <button
              type="button"
              className="enlace carrusel-dron"
              title={dron ? `Abrir la vista de ${dron.displayName}` : undefined}
              disabled={!dron}
              onClick={dron ? () => onVerDron(dron.droneId) : undefined}
            >
              {dron?.displayName ?? 'Dron desconocido'}
            </button>
          )}
          <time className="mono muted" dateTime={alerta.created_at}>
            {time(alerta.created_at)}
          </time>
        </div>
        <div className="alerta-cuerpo">
          {alerta.snapshot ? (
            <img
              className="snapshot"
              src={`data:image/jpeg;base64,${alerta.snapshot}`}
              alt="Captura que disparó la detección"
            />
          ) : (
            // No `.video`: en el par del video y el mapa esa clase fija 420 px de
            // alto, y un aviso de una línea quedaría flotando en un hueco enorme.
            <p className="vacio">La alerta llegó sin captura</p>
          )}
          <div className="alerta-detalle">
            <p className="muted">
              {siguiendo
                ? 'El dron está sobre este objetivo: compará la captura con el video en vivo antes de decidir.'
                : 'Compará la captura con el video en vivo antes de decidir.'}
            </p>
            <div className="alert-actions">
              <button className="validate" disabled={ocupado} onClick={() => decidir(alerta.id, 'VALIDATED')}>
                Validar
              </button>
              <button className="dismiss" disabled={ocupado} onClick={() => decidir(alerta.id, 'DISMISSED')}>
                Descartar
              </button>
            </div>
            {/* Lo que hace cada botón con el dron, dicho antes de apretarlo: validar
                no lo "libera", y descartar lo saca de encima del objetivo. */}
            <p className="muted alerta-consecuencias">
              Validar: el dron se queda sobre el objetivo hasta que lo mandes a patrullar. Descartar: retoma la ruta
              hacia el próximo nodo.
            </p>
            {error && (
              <p className="aviso malo" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
