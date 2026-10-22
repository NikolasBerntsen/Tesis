/**
 * La cruz de cerrar un diálogo. Había tres: un "×" de texto en los formularios
 * de dron, base y ruta, y dos SVG copiados con tamaños distintos en el resto.
 * El glifo de texto no sigue el trazo de 1,5 del sistema y cambia de peso según
 * la fuente de cada máquina; con una sola cruz, todas las cabeceras se ven
 * iguales. Va oculta al lector de pantalla: el nombre lo pone el `aria-label`
 * del botón que la contiene.
 */
export default function IconoCerrar() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
    </svg>
  );
}
