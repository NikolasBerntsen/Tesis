import type { ReactNode } from 'react';

/**
 * Lo que se ve mientras llega una tabla. Antes era un cartel en serif grande
 * ("Trayendo los drones…") que al llegar los datos desaparecía y dejaba entrar
 * la tabla de golpe, empujando todo lo de abajo. El esqueleto ocupa el lugar de
 * la tabla con el alto de sus filas y el rótulo donde va el encabezado: lo que
 * llega se apoya encima en vez de correr la página.
 *
 * El texto se lee (y se anuncia: es una región de estado); las franjas son
 * dibujo y quedan fuera del árbol de accesibilidad.
 */
export function EsqueletoDeTabla({ texto, filas = 3 }: { texto: string; filas?: number }) {
  return (
    <div className="esqueleto" role="status">
      <span className="esqueleto-rotulo">{texto}</span>
      <div className="esqueleto-filas" aria-hidden="true">
        {Array.from({ length: filas }, (_, i) => (
          <span key={i} className="esqueleto-fila" />
        ))}
      </div>
    </div>
  );
}

/**
 * Lo que se ve cuando no hay nada para listar: qué falta, en una línea, y
 * debajo qué hacer para que haya algo. El mismo marcado en todas las vistas,
 * así el vacío de Bases se lee igual que el de Drones o el del Registro.
 */
export function EstadoVacio({ titulo, children }: { titulo: string; children?: ReactNode }) {
  if (!children) return <p className="vacio">{titulo}</p>;
  return (
    <div className="vacio-guia">
      <p className="vacio">{titulo}</p>
      <p className="muted">{children}</p>
    </div>
  );
}
