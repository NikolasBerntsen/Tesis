import { IconoLapiz, IconoRestaurar, IconoTacho } from './Iconos';

/**
 * Los botones que se repiten en cada ficha y en cada fila de las vistas de
 * gestión (Drones, Bases, Rutas, Usuarios). Editar y Eliminar van como ícono
 * —el lápiz y el tacho, que se reconocen sin leer—, cuadrados y con el filo
 * de oro del prototipo; las demás acciones van escritas, porque un ícono de
 * "Desactivar" o de "Regenerar contraseña" habría que adivinarlo.
 *
 * El nombre del botón sigue siendo el de siempre ("Editar", "Eliminar"): va
 * en `aria-label` para el lector de pantalla y en `title` para el que pasa el
 * mouse. El grupo que los contiene dice de quién son ("Acciones de Halcón 1"),
 * así que "Editar" a secas no queda huérfano.
 */
type PropsDeAccion = Readonly<{
  onClick: () => void;
  /** El nombre accesible. Por defecto, el verbo solo. */
  etiqueta?: string;
}>;

export function BotonEditar({ onClick, etiqueta = 'Editar' }: PropsDeAccion) {
  return (
    <button type="button" className="icono-boton cuadrado" aria-label={etiqueta} title={etiqueta} onClick={onClick}>
      <IconoLapiz />
    </button>
  );
}

/** El tacho, con el filo óxido de Eliminar (primitivos.css): pregunta antes, lo decide quien lo llama. */
export function BotonEliminar({ onClick, etiqueta = 'Eliminar' }: PropsDeAccion) {
  return (
    <button
      type="button"
      className="icono-boton cuadrado dismiss"
      aria-label={etiqueta}
      title={etiqueta}
      onClick={onClick}
    >
      <IconoTacho />
    </button>
  );
}

/**
 * Restaurar va escrito: es la única acción que le queda a lo eliminado, y
 * sola en su fila un ícono suelto no se entiende. La flecha que vuelve dice
 * de un vistazo que deshace la baja.
 */
export function BotonRestaurar({ onClick, chico = false }: Readonly<{ onClick: () => void; chico?: boolean }>) {
  return (
    <button type="button" className={chico ? 'chico' : undefined} onClick={onClick}>
      <IconoRestaurar tamano={chico ? 15 : 18} />
      Restaurar
    </button>
  );
}
