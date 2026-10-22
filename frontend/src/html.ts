/**
 * Escapa un texto para meterlo en el HTML que arma la consola a mano: los
 * globos, las etiquetas y los íconos de Leaflet. React escapa solo lo que
 * pinta; Leaflet no, y escribe con innerHTML todo lo que le llega como texto
 * (`bindTooltip`, `bindPopup`, `setContent`, el `html` de `divIcon`).
 *
 * Vive en un módulo propio, y no adentro de DronesMap, porque hay mapas en
 * varias vistas: mientras estuvo sólo ahí, el catálogo de rutas y el editor le
 * pasaban a la etiqueta el apodo de cada nodo crudo. El apodo lo escribe un
 * operador y lo ven todos, admins incluidos con su sesión abierta, y un
 * `<img src=x onerror=…>` entra de sobra en sus 40 caracteres.
 *
 * Se escapan también las dos comillas para que el resultado sirva igual en un
 * atributo (`value="…"`, `data-label="…"`) que entre etiquetas. Las entidades
 * son numéricas (`<` → `&#60;`) porque no dependen de que el navegador conozca
 * su nombre. El `String()` es por los datos que llegan sin tipo por el
 * WebSocket: un número donde se esperaba texto se escapa en vez de romper.
 */
export function esc(texto: string): string {
  return String(texto).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
