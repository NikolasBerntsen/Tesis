import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { textoDeSilencio } from '../ajustesDelDron';
import type { Drone } from '../types';
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
  children,
}: Readonly<{ dron: Drone; tamanoIcono: number; children: ReactNode }>) {
  const [abierto, setAbierto] = useState(false);
  const idGlobo = useId();
  const caja = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const ajuste = useAjusteDelDron(dron, 'silencioAlRetomarS');

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
    <div className="decision" ref={caja} onKeyDown={alTeclear}>
      <div className="alert-actions">
        {children}
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
 * ajustarle nada, y el par queda solo.
 */
export function ConSilencioAlRetomar({
  dron,
  tamanoIcono = 20,
  children,
}: Readonly<{ dron: Drone | null; tamanoIcono?: number; children: ReactNode }>) {
  if (!dron) {
    return (
      <div className="decision">
        <div className="alert-actions">{children}</div>
      </div>
    );
  }
  return (
    <DecisionConSilencio dron={dron} tamanoIcono={tamanoIcono}>
      {children}
    </DecisionConSilencio>
  );
}
