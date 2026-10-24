/**
 * El nombre con que el lector de pantalla anuncia cada botón de un grupo, en
 * el orden del marcado. Editar y Eliminar son íconos (el lápiz y el tacho)
 * con su nombre en `aria-label`, así que su texto visible está vacío: comparar
 * `textContent` decía que el grupo era ['', 'Ver QR', ''] aunque el orden
 * fuera el correcto. Alcanza con el `aria-label` o, si no hay, el texto: así
 * se nombran todos los botones de las vistas de gestión.
 */
export function nombresDeBotones(botones: HTMLElement[]): string[] {
  return botones.map((b) => b.getAttribute('aria-label') ?? (b.textContent ?? '').trim());
}
