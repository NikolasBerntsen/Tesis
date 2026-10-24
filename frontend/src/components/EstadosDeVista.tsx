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
export function EsqueletoDeTabla({ texto, filas = 3 }: Readonly<{ texto: string; filas?: number }>) {
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
 *
 * Con `icono`, el vacío ocupa su lugar en la vista con el medallón del
 * prototipo ("No hay drones activos." con el dron adentro): es lo que se ve
 * en una guardia tranquila, y una línea suelta en una tarjeta enorme se leía
 * como algo que no terminó de cargar. El medallón es dibujo: el que habla es
 * el título.
 */
export function EstadoVacio({
  titulo,
  icono,
  children,
}: Readonly<{ titulo: string; icono?: ReactNode; children?: ReactNode }>) {
  if (!children) return <p className="vacio">{titulo}</p>;
  return (
    <div className={icono ? 'vacio-guia con-medalla' : 'vacio-guia'}>
      {icono && (
        <span className="medalla" aria-hidden="true">
          {icono}
        </span>
      )}
      <p className="vacio">{titulo}</p>
      <p className="muted">{children}</p>
    </div>
  );
}
