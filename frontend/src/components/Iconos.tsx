import type { ReactNode } from 'react';

/**
 * Los íconos de la consola: trazos SVG de 24×24, en `currentColor`, con las
 * puntas y las uniones redondeadas. Son los del prototipo aprobado, juntos en
 * un solo lugar para que todas las vistas dibujen el mismo dron, la misma
 * campana y la misma flecha. Van siempre ocultos al lector de pantalla: el
 * nombre lo pone el texto del botón o su `aria-label`, nunca el dibujo.
 *
 * Uso: `<IconoDron />` a 22 px, o `<IconoDron tamano={18} />` en un botón
 * chico. Para elegir uno por nombre (la barra de secciones), ICONO_DE_SECCION.
 */
export type PropsDeIcono = Readonly<{
  /** Lado en píxeles. Por defecto 22, el de la barra y los títulos. */
  tamano?: number;
  className?: string;
}>;

function Trazo({ tamano = 22, className, children }: Readonly<PropsDeIcono & { children: ReactNode }>) {
  return (
    <svg
      className={className}
      width={tamano}
      height={tamano}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* --- Secciones ------------------------------------------------------------- */

/** Un cuadricóptero visto desde arriba: "Drones", "Drones activos". */
export function IconoDron(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <circle cx="5.5" cy="6" r="2.5" />
      <circle cx="18.5" cy="6" r="2.5" />
      <circle cx="5.5" cy="18" r="2.5" />
      <circle cx="18.5" cy="18" r="2.5" />
      <path d="M7.5 7.8 10 10.5h4l2.5-2.7M7.5 16.2 10 13.5h4l2.5 2.7" />
    </Trazo>
  );
}

/** Una mira: "Operación", la flota en vivo. */
export function IconoOperacion(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Trazo>
  );
}

/** Una torre: "Bases". */
export function IconoBase(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M7 21h10M9 21l1-13h4l1 13M10 8V5h4v3M12 3v2M9.6 13h4.8M9.3 17h5.4" />
    </Trazo>
  );
}

/** Nodos unidos por tramos: "Rutas". */
export function IconoRutas(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <circle cx="5" cy="18" r="2" />
      <circle cx="11" cy="9" r="2" />
      <circle cx="15" cy="15" r="2" />
      <circle cx="20" cy="5" r="2" />
      <path d="M6.2 16.4 9.8 10.6M12.2 10.8l1.6 2.6M15.9 13.2l3.3-6.4" />
    </Trazo>
  );
}

/** Dos personas: "Usuarios". */
export function IconoUsuarios(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.7-3.6 3.3-5.5 6.5-5.5s5.8 1.9 6.5 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.1 2.4 3.5 5.2" />
    </Trazo>
  );
}

/** Una hoja con renglones: "Registro". */
export function IconoRegistro(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4M9 11h7M9 15h7M9 19h4" />
    </Trazo>
  );
}

/* --- Barra y sesión ---------------------------------------------------------- */

export function IconoCampana(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 21h4" />
    </Trazo>
  );
}

export function IconoEngranaje(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </Trazo>
  );
}

/** Una puerta con la flecha hacia afuera: "Salir". */
export function IconoSalir(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
      <path d="M15 8l4 4-4 4M19 12H9" />
    </Trazo>
  );
}

export function IconoSol(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Trazo>
  );
}

export function IconoLuna(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </Trazo>
  );
}

/* --- Vistas y acciones --------------------------------------------------------- */

export function IconoCamara(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10.5 21 7.5v9l-5-3" />
    </Trazo>
  );
}

export function IconoMapa(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" />
      <path d="M9 4v14M15 6v14" />
    </Trazo>
  );
}

/** El tilde de "Validar" y de lo que salió bien. */
export function IconoCheck(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M5 12.5 10 17.5 19 7" />
    </Trazo>
  );
}

/** El tacho de "Descartar" y "Eliminar". */
export function IconoTacho(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </Trazo>
  );
}

export function IconoInfo(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Trazo>
  );
}

/** El tiempo que lleva esperando una alerta. */
export function IconoReloj(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Trazo>
  );
}

/** La clase de una detección: persona. */
export function IconoPersona(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1-4.4 4.2-6.5 8-6.5s7 2.1 8 6.5" />
    </Trazo>
  );
}

/** La clase de una detección: vehículo. */
export function IconoVehiculo(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M5 16v-5l2-5h10l2 5v5M3 16h18v2H3zM5 11h14" />
      <circle cx="7.5" cy="19.5" r="1.5" />
      <circle cx="16.5" cy="19.5" r="1.5" />
    </Trazo>
  );
}

export function IconoChevronIzquierda(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Trazo>
  );
}

export function IconoChevronDerecha(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M9 5l7 7-7 7" />
    </Trazo>
  );
}

export function IconoChevronArriba(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M5 15l7-7 7 7" />
    </Trazo>
  );
}

export function IconoChevronAbajo(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M5 9l7 7 7-7" />
    </Trazo>
  );
}

/** La flecha de volver ("← Drones" en el detalle). */
export function IconoVolver(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Trazo>
  );
}

/** La cruz de cerrar un diálogo o un aviso. */
export function IconoCerrar(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Trazo>
  );
}

/** Un reloj que vuelve atrás: el historial de eventos de un dron. */
export function IconoHistorial(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </Trazo>
  );
}

/** El mando: pilotaje manual. */
export function IconoMando(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M6 9h12a4 4 0 0 1 3.9 4.9l-.7 3A2.6 2.6 0 0 1 16.7 18l-2.2-2.5h-5L7.3 18a2.6 2.6 0 0 1-4.5-1.1l-.7-3A4 4 0 0 1 6 9z" />
      <path d="M8 11.5v3M6.5 13h3" />
    </Trazo>
  );
}

/** La casa: volver a la base. */
export function IconoCasa(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M4 11 12 4l8 7M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </Trazo>
  );
}

export function IconoPausa(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M9 5v14M15 5v14" />
    </Trazo>
  );
}

/** El "+" de "Nuevo dron", "Nueva ruta", "Nuevo usuario". */
export function IconoMas(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M12 5v14M5 12h14" />
    </Trazo>
  );
}

export function IconoLapiz(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </Trazo>
  );
}

/** El alfiler del mapa: la ubicación de una base o de un objetivo. */
export function IconoUbicacion(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </Trazo>
  );
}

/** Un código QR: los tres cuadros de las esquinas y unos módulos sueltos ("Ver QR"). */
export function IconoQr(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1" />
      <path d="M14 14h3M20.5 14v3M14 17.5v3M17.5 20.5h3M17.5 17.5h.01" />
    </Trazo>
  );
}

/** La flecha que vuelve sobre sus pasos: "Restaurar" lo que se dio de baja. */
export function IconoRestaurar(props: PropsDeIcono) {
  return (
    <Trazo {...props}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Trazo>
  );
}

/** Las secciones de la barra, cada una con su ícono. */
export const ICONO_DE_SECCION = {
  operacion: IconoOperacion,
  drones: IconoDron,
  bases: IconoBase,
  rutas: IconoRutas,
  usuarios: IconoUsuarios,
  registro: IconoRegistro,
} as const;
