import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLES =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Lo que cuenta como "campo" para arrancar un formulario con el foco adentro. */
const CAMPOS = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])';

/**
 * Lo que dura la salida del diálogo. Es el mismo valor que `--transicion` en
 * tokens.css, que es lo que usan las animaciones de `.modal-saliendo` en
 * modales.css: si uno cambia sin el otro, el eco se corta a mitad de camino o
 * se queda flotando invisible un rato.
 */
export const SALIDA_MS = 160;

/**
 * Sólo se anima la salida cuando el sistema dice explícitamente que el
 * movimiento no molesta. Se pregunta por `no-preference` y no por la ausencia
 * de `reduce`: un navegador sin `matchMedia` (o un doble de prueba que contesta
 * `false` a todo) se queda sin animación, que es el lado seguro.
 */
function animarSalida(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches === true;
}

/**
 * El diálogo lo desmonta su dueño, así que React lo saca del DOM de un saque y
 * no queda nada que animar. Para que cerrar no sea un corte seco, se deja en
 * su lugar una copia muda (sin ids, inerte y oculta a los lectores) que se
 * desvanece y se borra sola. Se arma antes de que React quite el original
 * —después ya no hay nada que copiar— y se inserta recién cuando el commit
 * terminó, para poder distinguir un cierre real de un desmontaje de prueba.
 *
 * `contenedor` es donde vivía el diálogo (ver `elegirContenedor`), y es ahí
 * donde va el eco: en pantalla completa el navegador sólo pinta ese elemento,
 * y un eco colgado del body se desvanecía detrás, sin que nadie lo viera.
 */
function dejarEco(fondo: HTMLElement, contenedor: Element) {
  if (!animarSalida()) return;
  const eco = fondo.cloneNode(true) as HTMLElement;
  eco.classList.add('modal-saliendo');
  eco.setAttribute('aria-hidden', 'true');
  eco.setAttribute('inert', '');
  // Un id repetido haría que un diálogo que se abre enseguida tome su título
  // del eco que se está yendo.
  eco.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  // Se anotan los hijos de los dos lugares adonde puede ir el eco: hasta la
  // microtarea no se sabe si el contenedor sigue en la página.
  const yaEstaban = new Set([...contenedor.children, ...document.body.children]);
  queueMicrotask(() => {
    // StrictMode desmonta y vuelve a montar en desarrollo sin sacar el nodo:
    // si sigue en la página no hubo cierre de verdad y no hay nada que despedir.
    if (fondo.isConnected) return;
    // Si el contenedor se fue junto con el diálogo (la vista de pilotaje que se
    // cierra con una confirmación abierta), el eco no tiene dónde verse ahí.
    const destino = contenedor.isConnected ? contenedor : document.body;
    // Si en el mismo gesto se abrió otro diálogo (el alta de un dron que deja
    // paso a su sticker), el eco va debajo: el nuevo no puede quedar tapado
    // por el que se está yendo.
    const nuevo = [...destino.children].find((n) => !yaEstaban.has(n)) ?? null;
    destino.insertBefore(eco, nuevo);
    setTimeout(() => eco.remove(), SALIDA_MS);
  });
}

/**
 * Dónde se cuelga el diálogo. Con algo en pantalla completa (la vista de
 * pilotaje), el navegador sólo pinta ese elemento y lo que tiene adentro: un
 * diálogo colgado del body quedaría abierto, atrapando el teclado, pero
 * invisible. Un elemento que ya salió de la página no sirve: el navegador
 * todavía lo puede nombrar como el de pantalla completa en el instante en que
 * se lo saca, antes de avisar con `fullscreenchange`.
 */
function elegirContenedor(): Element {
  const completa = document.fullscreenElement;
  return completa?.isConnected ? completa : document.body;
}

/**
 * Pila de diálogos abiertos. Hay pantallas que abren un diálogo arriba de otro
 * (elegir las rutas de una base y, sin cerrar eso, dibujar una ruta nueva).
 * Como cada diálogo escucha el teclado en `document`, sin esta pila un Escape
 * los cerraría a todos de una y se perdería el trabajo del de abajo: sólo el
 * último abierto responde a Escape y atrapa el tabulador.
 */
const pila: object[] = [];

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
  ancho,
  enfocarPrimerCampo,
  onCerrar,
  children,
}: {
  /** `id` del título, para el `aria-labelledby` de la caja. */
  etiquetadoPor: string;
  descritoPor?: string;
  /** Caja ancha, para los diálogos que llevan un mapa al lado de una lista. */
  ancho?: boolean;
  /**
   * En los formularios el foco arranca en el primer campo y no en la caja:
   * quien abre "Nuevo dron" viene a escribir, y obligarlo a tabular hasta el
   * nombre es un paso de más. Sin campos, cae en la caja como siempre.
   */
  enfocarPrimerCampo?: boolean;
  onCerrar: () => void;
  children: ReactNode;
}) {
  const fondo = useRef<HTMLDivElement>(null);
  const caja = useRef<HTMLDivElement>(null);
  // Se lee una sola vez, al montar: es una decisión de cómo se abre el diálogo.
  const primerCampo = useRef(enfocarPrimerCampo);
  // En una ref para que el listener del teclado no se resuscriba en cada render
  // sólo porque el padre le pasa una función nueva.
  const cerrar = useRef(onCerrar);
  cerrar.current = onCerrar;
  // Un arrastre para seleccionar texto que arranca adentro de la caja dispara su
  // `click` en el ancestro común, que es el velo: sin recordar dónde empezó,
  // soltar el botón un poco afuera cerraba el diálogo y se perdía la lectura.
  const arrancoEnElVelo = useRef(false);
  // Se elige UNA vez, al montar. Antes se miraba en cada render, y cambiar de
  // contenedor con el diálogo abierto es, para React, otro portal: lo vuelve a
  // montar entero en el lugar nuevo. Al cerrarse la vista de pilotaje con una
  // confirmación abierta adentro, la caja se iba con la vista pero el diálogo
  // seguía montado (invisible, en la pila, comiéndose el tabulador) y en el
  // render siguiente reaparecía en el body, viejo. Si la pantalla completa
  // cambia con el diálogo abierto, el diálogo se queda donde nació.
  const [contenedor] = useState(elegirContenedor);

  useEffect(() => {
    const previo = document.activeElement;
    // Un diálogo puede marcar dónde arranca el foco con `data-autofoco`. Lo usa
    // la confirmación de lo destructivo, que arranca en "Cancelar": un Enter
    // apurado o un Espacio de más tienen que caer en el gesto que no rompe
    // nada. No alcanza con enfocarlo desde el hijo: los efectos del hijo corren
    // antes que este, y acá el foco se iría a la caja.
    const pedido = caja.current?.querySelector<HTMLElement>('[data-autofoco]');
    const campo = primerCampo.current ? caja.current?.querySelector<HTMLElement>(CAMPOS) : null;
    (pedido ?? campo ?? caja.current)?.focus();
    // El foco vuelve a lo que abrió el diálogo: con el teclado, cerrar no puede
    // dejarte de nuevo arriba de todo.
    return () => {
      if (previo instanceof HTMLElement) previo.focus();
    };
  }, []);

  // De layout y no pasivo: la limpieza de un efecto pasivo corre cuando React
  // ya sacó el nodo, y entonces no queda nada que copiar. El nodo se toma al
  // montar, que es cuando se sabe que la ref está puesta.
  useLayoutEffect(() => {
    const nodo = fondo.current!;
    return () => dejarEco(nodo, contenedor);
  }, [contenedor]);

  // Entrada y salida de la pila. La ref de la caja hace de identidad: es
  // estable entre renders y única por diálogo.
  useEffect(() => {
    pila.push(caja);
    return () => {
      const i = pila.lastIndexOf(caja);
      if (i >= 0) pila.splice(i, 1);
    };
  }, []);

  // Va en `document` y no en el JSX porque el diálogo tiene que responder a
  // Escape y atrapar el tabulador aun si el foco se escapó de la caja.
  useEffect(() => {
    function alTeclear(ev: KeyboardEvent) {
      // Los de abajo se quedan quietos: el teclado es del diálogo de arriba.
      if (pila[pila.length - 1] !== caja) return;
      if (ev.key === 'Escape') {
        cerrar.current();
        return;
      }
      if (ev.key !== 'Tab' || !caja.current) return;
      const dentro = [...caja.current.querySelectorAll<HTMLElement>(FOCUSABLES)];
      // Casi siempre hay al menos una forma de cerrar. La excepción es una
      // confirmación esperando al backend, con sus tres botones apagados: ahí
      // el tabulador no tiene adónde ir, y el foco se queda en la caja en vez
      // de escaparse a la página de atrás.
      if (dentro.length === 0) {
        ev.preventDefault();
        caja.current.focus();
        return;
      }
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
      // El velo es decorativo: cerrar haciéndole click es una comodidad del
      // mouse, y el equivalente de teclado (Escape) lo maneja el listener de
      // arriba. `presentation` lo saca del árbol de accesibilidad, que es lo
      // que corresponde para un fondo que no es un control.
      //
      // Sonar marca esto (S6819, "usá un elemento nativo en vez del rol"). Se
      // deja igual a propósito: para un fondo de diálogo no existe elemento
      // nativo, y la alternativa —un <button> invisible a pantalla completa—
      // agregaría un segundo control "Cerrar" al árbol de accesibilidad, al
      // lado del que ya tiene la cabecera. El rol es la respuesta correcta acá.
      role="presentation"
      ref={fondo}
      onMouseDown={(ev) => {
        arrancoEnElVelo.current = ev.target === ev.currentTarget;
      }}
      onClick={(ev) => {
        if (arrancoEnElVelo.current && ev.target === ev.currentTarget) onCerrar();
      }}
    >
      <div
        className={ancho ? 'modal-caja modal-ancho' : 'modal-caja'}
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
    contenedor,
  );
}
