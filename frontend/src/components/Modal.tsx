import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLES =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Velo y caja de un diálogo modal. Vive acá y no copiado en cada pop-up porque
 * las tres reglas que lo hacen usable —Escape, el tabulador que no se escapa y
 * el clic en el velo— son fáciles de implementar a medias, y con una sola copia
 * se arreglan de una vez para todos.
 *
 * El contenido va tal cual adentro de `.modal-caja`: cada pop-up arma su propia
 * cabecera, cuerpo y pie.
 */
export default function Modal({
  etiquetadoPor,
  descritoPor,
  onCerrar,
  children,
}: {
  /** `id` del título, para el `aria-labelledby` de la caja. */
  etiquetadoPor: string;
  descritoPor?: string;
  onCerrar: () => void;
  children: ReactNode;
}) {
  const caja = useRef<HTMLDivElement>(null);
  // En una ref para que el listener del teclado no se resuscriba en cada render
  // sólo porque el padre le pasa una función nueva.
  const cerrar = useRef(onCerrar);
  cerrar.current = onCerrar;
  // Un arrastre para seleccionar texto que arranca adentro de la caja dispara su
  // `click` en el ancestro común, que es el velo: sin recordar dónde empezó,
  // soltar el botón un poco afuera cerraba el diálogo y se perdía la lectura.
  const arrancoEnElVelo = useRef(false);

  useEffect(() => {
    const previo = document.activeElement;
    caja.current?.focus();
    // El foco vuelve a lo que abrió el diálogo: con el teclado, cerrar no puede
    // dejarte de nuevo arriba de todo.
    return () => {
      if (previo instanceof HTMLElement) previo.focus();
    };
  }, []);

  // Va en `document` y no en el JSX porque el diálogo tiene que responder a
  // Escape y atrapar el tabulador aun si el foco se escapó de la caja.
  useEffect(() => {
    function alTeclear(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        cerrar.current();
        return;
      }
      if (ev.key !== 'Tab' || !caja.current) return;
      // Siempre hay al menos una forma de cerrar, así que la lista no va vacía.
      const dentro = [...caja.current.querySelectorAll<HTMLElement>(FOCUSABLES)];
      const primero = dentro[0];
      const ultimo = dentro[dentro.length - 1];
      const foco = document.activeElement;
      const afuera = !caja.current.contains(foco);
      if (ev.shiftKey && (foco === primero || foco === caja.current || afuera)) {
        ev.preventDefault();
        ultimo.focus();
      } else if (!ev.shiftKey && (foco === ultimo || afuera)) {
        ev.preventDefault();
        primero.focus();
      }
    }
    document.addEventListener('keydown', alTeclear);
    return () => document.removeEventListener('keydown', alTeclear);
  }, []);

  return createPortal(
    <div
      className="modal-fondo"
      onMouseDown={(ev) => {
        arrancoEnElVelo.current = ev.target === ev.currentTarget;
      }}
      onClick={(ev) => {
        if (arrancoEnElVelo.current && ev.target === ev.currentTarget) onCerrar();
      }}
    >
      <div
        className="modal-caja"
        role="dialog"
        aria-modal="true"
        aria-labelledby={etiquetadoPor}
        aria-describedby={descritoPor}
        tabIndex={-1}
        ref={caja}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
