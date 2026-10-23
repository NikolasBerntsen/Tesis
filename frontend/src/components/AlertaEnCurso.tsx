import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useAlertasEnVivo } from '../alertasEnVivo';
import { cronometro, time } from '../format';
import type { Alert, Drone } from '../types';
import { useCarruselDeAlertas } from '../useCarruselDeAlertas';
import { useDecisionDeAlerta, type DecidirAlerta, type Decision } from '../useDecisionDeAlerta';
import { IconoChevronDerecha, IconoChevronIzquierda, IconoReloj } from './Iconos';
import { BotonesDeDecision, ChipDeTipo, ConsecuenciasDeDecidir, VisorDeCaptura } from './PiezasDeAlerta';

type Carrusel = ReturnType<typeof useCarruselDeAlertas>;

/**
 * El título de la vista que se está mirando: el primer encabezado de su
 * <main>. Las vistas que llevan el carrusel lo dejan enfocar desde el código
 * (`tabIndex={-1}`, fuera del tabulador) para esto.
 */
function enfocarElTituloDeLaVista() {
  document.querySelector<HTMLElement>('main h2')?.focus();
}

/** Si el foco no quedó en ningún lado: se cayó con el botón que lo tenía. */
function focoEnNingunLado(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** Hacia dónde mueve el carrusel una tecla: sólo las flechas de costado, solas. */
function pasoDeLaTecla(ev: KeyboardEvent<HTMLElement>): 'anterior' | 'siguiente' | null {
  // Con modificadores son atajos del navegador (Alt+← es "atrás"): no se tocan.
  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return null;
  if (ev.key === 'ArrowLeft') return 'anterior';
  if (ev.key === 'ArrowRight') return 'siguiente';
  return null;
}

/**
 * Si el foco se fue de verdad del carrusel. Sin destino, el foco puede
 * haberse caído solo —el botón se deshabilitó o se quitó—, y eso no es que el
 * operador se haya ido del carrusel.
 */
function seFueDelCarrusel(ev: FocusEvent<HTMLElement>): boolean {
  const destino = ev.relatedTarget as Node | null;
  if (destino && ev.currentTarget.contains(destino)) return false;
  const origen = ev.target as HTMLButtonElement;
  const caido = destino === null && (origen.disabled === true || !origen.isConnected);
  return !caido;
}

/** La hora del reloj, renovada cada `cadaMs`: lo que necesita un cronómetro en pantalla. */
function useAhora(cadaMs: number): number {
  const [ahora, setAhora] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), cadaMs);
    return () => clearInterval(id);
  }, [cadaMs]);
  return ahora;
}

/**
 * Cuánto hace que la alerta espera una decisión, al segundo ("00:08:17"): con
 * varias en fila, lo primero que el operador quiere saber es cuál lleva más
 * tiempo sin que nadie la mire. Es un componente aparte para que el segundero
 * vuelva a dibujar este renglón y no la tarjeta entera con su captura. Queda
 * fuera de las regiones vivas: un lector de pantalla no tiene que anunciar
 * cada segundo.
 */
function EsperaDeLaAlerta({ desde }: Readonly<{ desde: string }>) {
  const ahora = useAhora(1000);
  const llegada = Date.parse(desde);
  if (Number.isNaN(llegada)) return null;
  const segundos = Math.floor((ahora - llegada) / 1000);
  return (
    <span className="alerta-espera" title={`Llegó a las ${time(desde)}`}>
      <IconoReloj tamano={18} />
      <span className="carrusel-solo-lector">Sin atender hace </span>
      <time dateTime={`PT${Math.max(0, segundos)}S`}>{cronometro(segundos)}</time>
    </span>
  );
}

/**
 * Los pasos del carrusel, a la derecha del título: flecha, cuenta, flecha.
 *
 * Están siempre, vacíos con una sola alerta: adentro va la región que anuncia
 * la cuenta, y una región viva que aparece ya con su texto no se anuncia. Si
 * naciera con la segunda alerta, en la vista del dron —cuyo título no cambia—
 * esa llegada pasaba callada.
 */
function PasosDelCarrusel({ carrusel }: Readonly<{ carrusel: Carrusel }>) {
  const varias = carrusel.total > 1;
  return (
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
          <IconoChevronIzquierda />
        </button>
      )}
      {/* El contenedor del aviso queda fijo y la pastilla se rehace con cada
          tanda nueva (`key`): así el pulso se repite y el lector de pantalla
          anuncia el número nuevo. Las nuevas sin ver se dicen acá y no en el
          botón de abrirlas, que aparece sin anunciarse. */}
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
          <IconoChevronDerecha />
        </button>
      )}
    </div>
  );
}

/**
 * El pulso de la cuenta es movimiento, y con movimiento reducido no se ve:
 * este aviso queda quieto hasta que el operador abre la nueva.
 */
function AvisoDeNuevas({ sinVer, onVer }: Readonly<{ sinVer: number; onVer: () => void }>) {
  if (sinVer === 0) return null;
  return (
    <button type="button" className="enlace carrusel-nuevas" onClick={onVer}>
      {sinVer === 1 ? 'Ver la alerta nueva' : `Ver las ${sinVer} alertas nuevas`}
    </button>
  );
}

/**
 * De qué dron es la alerta, en la pastilla de oro: como en la campana, el
 * nombre es el que lleva a la vista del dron, con su video en vivo. Un dron
 * que ya no está queda escrito pero apagado, sin llevar a ningún lado.
 */
function ChipDelDron({ dron, onVerDron }: Readonly<{ dron: Drone | null; onVerDron: (droneId: string) => void }>) {
  if (!dron) {
    return (
      <button type="button" className="chip oro" disabled>
        Dron desconocido
      </button>
    );
  }
  return (
    <button
      type="button"
      className="chip oro"
      title={`Abrir la vista de ${dron.displayName}`}
      onClick={() => onVerDron(dron.droneId)}
    >
      {dron.displayName}
      <IconoChevronDerecha tamano={16} />
    </button>
  );
}

/**
 * La alerta en pantalla. Se dibuja con `key` por id (ver AlertaEnCurso): al
 * irse una, todo lo de adentro se rehace en vez de pasar a ser de la vecina.
 * Con varias es una diapositiva del carrusel y dice cuál es de cuántas.
 */
function DiapositivaDeAlerta({ carrusel, children }: Readonly<{ carrusel: Carrusel; children: ReactNode }>) {
  const varias = carrusel.total > 1;
  return (
    <div
      className="carrusel-diapositiva"
      role={varias ? 'group' : undefined}
      aria-roledescription={varias ? 'alerta' : undefined}
      aria-label={varias ? `${carrusel.posicion} de ${carrusel.total}` : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Lo que se decide, a la derecha de la captura (o debajo, en la vista del
 * dron): qué es y de qué dron, la consigna, los dos botones y qué le hace cada
 * uno al dron.
 */
function DecisionDeLaAlerta({
  alerta,
  drones,
  onVerDron,
  siguiendo,
  ocupado,
  error,
  onDecidir,
  onAbrir,
}: Readonly<{
  alerta: Alert;
  drones?: readonly Drone[];
  onVerDron?: (droneId: string) => void;
  siguiendo: boolean;
  ocupado: boolean;
  error: string | null;
  onDecidir: (decision: Decision) => void;
  onAbrir?: () => void;
}>) {
  return (
    <div className="alerta-detalle">
      <div className="alert-head">
        <ChipDeTipo tipo={alerta.type} />
        {onVerDron && (
          <ChipDelDron dron={drones?.find((d) => d.droneId === alerta.drone_id) ?? null} onVerDron={onVerDron} />
        )}
      </div>
      <p className="alerta-consigna">
        {siguiendo
          ? 'El dron está sobre este objetivo: compará la captura con el video en vivo antes de decidir.'
          : 'Compará la captura con el video en vivo antes de decidir.'}
      </p>
      <BotonesDeDecision ocupado={ocupado} onDecidir={onDecidir} />
      <ConsecuenciasDeDecidir />
      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}
      {onAbrir && (
        <button type="button" className="enlace versal alerta-ver-detalle" onClick={onAbrir}>
          Ver detalle
          <IconoChevronDerecha tamano={16} />
        </button>
      )}
    </div>
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
}: Readonly<{
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
}>) {
  const carrusel = useCarruselDeAlertas(alertas);
  const { decidir, errorDe, decidiendo } = useDecisionDeAlerta(onDecidir);
  // El pop-up con todo lo de la alerta (mapa, dron, video) lo abre la consola:
  // ver ProveedorDeAlertas.
  const { abrirAlerta } = useAlertasEnVivo();
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
    if (caja && focoAdentro.current && focoEnNingunLado()) caja.focus();
  }, [alerta?.id, ocupado]);

  if (!alerta) return null;

  const abrir = abrirAlerta ? () => abrirAlerta(alerta, devolverFoco) : undefined;

  function alTeclear(ev: KeyboardEvent<HTMLElement>) {
    const paso = pasoDeLaTecla(ev);
    if (!paso) return;
    carrusel[paso]();
    ev.preventDefault();
  }

  /**
   * Al cerrar el pop-up de la alerta el foco vuelve a lo que lo abrió
   * (Modal.tsx). Pero decidirla desde el pop-up se lleva su diapositiva, y con
   * ella el botón que lo abrió: el foco caía en <body> y el teclado arrancaba
   * otra vez desde arriba de la página. Va al carrusel, que ya muestra la que
   * le seguía, como al decidir desde la tarjeta; y si era la última y el
   * carrusel también se fue, al título de la vista.
   */
  function devolverFoco() {
    const carrusel = seccion.current;
    if (carrusel?.isConnected) carrusel.focus();
    else enfocarElTituloDeLaVista();
  }

  function alSalirElFoco(ev: FocusEvent<HTMLElement>) {
    if (seFueDelCarrusel(ev)) focoAdentro.current = false;
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
      {/* La cabecera: el punto rojo y la cuenta a la izquierda; los pasos del
          carrusel y cuánto hace que espera, a la derecha. */}
      <div className="carrusel-cabecera">
        {/* El título del tablero lleva la cuenta ("3 alertas sin atender"):
            se anuncia al cambiar, como lo hacía la franja que reemplaza. El
            punto es dibujo: no suma nada al nombre de la región. */}
        <h2 id={idTitulo} aria-live="polite">
          <span className="punto-vivo" aria-hidden="true" />
          {titulo}
        </h2>
        {/* Juntos y a la derecha: en una columna angosta bajan los dos al
            renglón de abajo, sin que el reloj quede suelto a la izquierda. */}
        <div className="carrusel-lado">
          <PasosDelCarrusel carrusel={carrusel} />
          <EsperaDeLaAlerta key={alerta.id} desde={alerta.created_at} />
        </div>
      </div>

      <AvisoDeNuevas sinVer={carrusel.sinVer} onVer={carrusel.irALaNueva} />

      <DiapositivaDeAlerta key={alerta.id} carrusel={carrusel}>
        <VisorDeCaptura alerta={alerta} onAmpliar={abrir} />
        <DecisionDeLaAlerta
          alerta={alerta}
          drones={drones}
          onVerDron={onVerDron}
          siguiendo={seguidas.includes(alerta.id)}
          ocupado={ocupado}
          error={errorDe(alerta.id)}
          onDecidir={(decision) => decidir(alerta.id, decision)}
          onAbrir={abrir}
        />
      </DiapositivaDeAlerta>
    </section>
  );
}
