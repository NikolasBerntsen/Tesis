import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { textoDeSilencio } from '../ajustesDelDron';
import type { Drone } from '../types';
import type { Decision } from '../useDecisionDeAlerta';
import { IconoCerrar, IconoEngranaje } from './Iconos';
import { AjusteDeSilencio } from './PiezasDeAjuste';
import { useAjusteDelDron, type AjusteEnEdicion } from './useAjusteDelDron';

/**
 * El globo que abre el engranaje: el mismo deslizador del silencio de la
 * tarjeta del dron, para el dron de esta alerta. No es modal (la decisión sigue
 * a mano) y va en el flujo, debajo de los botones, y no flotando: adentro de la
 * campana y de la grilla de alertas lo recortaría el scroll del panel, y en un
 * teléfono así nunca se sale de la pantalla. El foco entra a la cruz al
 * abrirse, como en los globos de la vista de pilotaje: con el teclado, un
 * panel al que no se llega es un panel que no está.
 */
function GloboDeSilencio({
  id,
  dron,
  ajuste,
  onCerrar,
}: Readonly<{ id: string; dron: Drone; ajuste: AjusteEnEdicion<'silencioAlRetomarS'>; onCerrar: () => void }>) {
  const idTitulo = useId();
  const cerrar = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cerrar.current?.focus();
  }, []);
  return (
    <div id={id} className="silencio-globo" role="dialog" aria-modal="false" aria-labelledby={idTitulo}>
      <header className="silencio-globo-cabecera">
        <h3 id={idTitulo}>
          <IconoEngranaje tamano={16} />
          {`Silencio al retomar · ${dron.displayName}`}
        </h3>
        <button ref={cerrar} type="button" className="modal-cerrar" aria-label="Cerrar el silencio al retomar" onClick={onCerrar}>
          <IconoCerrar tamano={18} />
        </button>
      </header>
      <AjusteDeSilencio ajuste={ajuste} puedeAjustar />
    </div>
  );
}

/** Lo que el par de la decisión recibe para decidir. */
export interface ParaDecidir {
  /** Decide la alerta; un descarte espera, antes, el silencio recién movido. */
  decidir: (decision: Decision) => void;
  /** Un descarte espera que se guarde el silencio: el par queda apagado. */
  esperando: boolean;
}

/**
 * Validar y Descartar con el engranaje del silencio al lado (VUELO §6): el
 * ajuste vive acá, al lado de la decisión, porque es en el momento de
 * descartar cuando se nota que el dron se frena con cada auto de la playa. El
 * hook vive mientras viva la decisión y no sólo el globo, así un cambio hecho
 * un instante antes de cerrarlo se guarda igual.
 */
function DecisionConSilencio({
  dron,
  tamanoIcono,
  onDecidir,
  children,
}: Readonly<{
  dron: Drone;
  tamanoIcono: number;
  onDecidir: (decision: Decision) => void;
  children: (para: ParaDecidir) => ReactNode;
}>) {
  const [abierto, setAbierto] = useState(false);
  const [esperando, setEsperando] = useState(false);
  const idGlobo = useId();
  const caja = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const ajuste = useAjusteDelDron(dron, 'silencioAlRetomarS');

  /**
   * Descartar es lo que arranca el silencio en la app, que lo toma de lo que
   * tiene al recibir la decisión. Con el silencio movido hace menos de la mano
   * quieta (600 ms), el descarte salía antes que el ajuste y el dron callaba
   * lo de antes. El descarte espera ese guardado —el que esperaba su turno
   * sale en el acto— y recién ahí decide; un rechazo del ajuste no lo frena
   * (queda a la vista en el globo). Validar no espera: no deja el objetivo, y
   * no hay silencio que aplicar.
   */
  async function descartarTrasGuardar(guardado: Promise<void>) {
    setEsperando(true);
    await guardado;
    setEsperando(false);
    onDecidir('DISMISSED');
  }

  function decidir(decision: Decision) {
    const guardado = decision === 'DISMISSED' ? ajuste.guardarYa() : null;
    if (guardado) void descartarTrasGuardar(guardado);
    else onDecidir(decision);
  }

  // Un clic afuera lo cierra, como el desplegable de la campana; sin mover el
  // foco, que ya está en lo que se tocó.
  useEffect(() => {
    if (!abierto) return;
    function afuera(ev: MouseEvent) {
      if (!caja.current?.contains(ev.target as Node)) setAbierto(false);
    }
    document.addEventListener('mousedown', afuera);
    return () => document.removeEventListener('mousedown', afuera);
  }, [abierto]);

  function cerrar() {
    setAbierto(false);
    boton.current?.focus();
  }

  function alTeclear(ev: KeyboardEvent<HTMLElement>) {
    if (ev.key !== 'Escape' || !abierto) return;
    // Antes que la campana, que también se cierra con Esc: de a uno por Esc.
    ev.stopPropagation();
    cerrar();
  }

  return (
    // El grupo atiende Escape para cerrar el globo con el foco en cualquiera de
    // sus piezas (el deslizador, la cruz, el engranaje, Validar o Descartar),
    // antes que la campana que lo contiene. No es un control: es el grupo de la
    // decisión, y darle un rol interactivo para callar al análisis le mentiría
    // al lector de pantalla.
    <div // NOSONAR(S6847): el grupo atiende el Escape del globo del silencio, ver arriba
      className="decision"
      ref={caja}
      role="group"
      aria-label="Decisión sobre la alerta"
      onKeyDown={alTeclear}
    >
      <div className="alert-actions">
        {children({ decidir, esperando })}
        <button
          ref={boton}
          type="button"
          className="icono-boton silencio-boton"
          aria-label="Silencio al retomar"
          aria-haspopup="dialog"
          aria-expanded={abierto}
          aria-controls={abierto ? idGlobo : undefined}
          title={`Silencio al retomar: ${textoDeSilencio(ajuste.valor)}`}
          onClick={() => (abierto ? cerrar() : setAbierto(true))}
        >
          <IconoEngranaje tamano={tamanoIcono} />
        </button>
      </div>
      {abierto && <GloboDeSilencio id={idGlobo} dron={dron} ajuste={ajuste} onCerrar={cerrar} />}
    </div>
  );
}

/**
 * Envuelve el par de la decisión y, si se conoce la ficha del dron, le suma el
 * engranaje del silencio. Sin la ficha (la alerta de un dron que ya no está en
 * la flota, o la pieza montada fuera de la consola) no hay a qué dron
 * ajustarle nada, y el par queda solo y decide en el acto.
 *
 * Con `key` por dron: si la alerta cambia de dueño (el traspaso de un relevo)
 * el engranaje es de otro dron, y lo que se movió para A —un valor esperando
 * su turno, el globo abierto— no puede quedar a nombre de B.
 */
export function ConSilencioAlRetomar({
  dron,
  tamanoIcono = 20,
  onDecidir,
  children,
}: Readonly<{
  dron: Drone | null;
  tamanoIcono?: number;
  onDecidir: (decision: Decision) => void;
  /** El par de la decisión, con el `decidir` que tiene que usar. */
  children: (para: ParaDecidir) => ReactNode;
}>) {
  if (!dron) {
    return (
      <div className="decision">
        <div className="alert-actions">{children({ decidir: onDecidir, esperando: false })}</div>
      </div>
    );
  }
  return (
    <DecisionConSilencio key={dron.droneId} dron={dron} tamanoIcono={tamanoIcono} onDecidir={onDecidir}>
      {children}
    </DecisionConSilencio>
  );
}
