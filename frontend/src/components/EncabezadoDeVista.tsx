import type { ReactNode } from 'react';

/**
 * La cabecera de todas las vistas de la consola: el título a la izquierda, el
 * buscador o los filtros al medio, y a la derecha las opciones de la vista
 * ("Ver eliminados", actualizar) juntas y, al final, la acción principal
 * ("Nuevo …"). Antes cada vista la armaba a mano: Usuarios la ponía afuera de
 * la tarjeta y las demás adentro, con tres altos de botón distintos en la misma
 * fila y "Nuevo …" a veces antes y a veces después del interruptor.
 *
 * El orden del marcado es el de lectura y el del tabulador: título, filtros,
 * opciones, acción principal.
 */
export default function EncabezadoDeVista({
  titulo,
  subtitulo,
  filtros,
  opciones,
  accion,
}: {
  titulo: string;
  /** Un dato corto al lado del título ("2 en vuelo · 3 registrados"). */
  subtitulo?: ReactNode;
  /** Buscador o filtros: van al medio. */
  filtros?: ReactNode;
  /** Interruptores y acciones secundarias de la vista, agrupados. */
  opciones?: ReactNode;
  /** La acción principal ("Nuevo dron"): siempre la última, a la derecha. */
  accion?: ReactNode;
}) {
  return (
    <header className="vista-cabecera">
      <div className="vista-encabezado">
        {/* Enfocable sólo desde el código: es adonde vuelve el foco cuando lo
            que lo tenía se fue de la vista (el carrusel de alertas, al decidir
            la última desde su pop-up). No es un control: no va al tabulador. */}
        <h2 className="vista-titulo" tabIndex={-1}>
          {titulo}
        </h2>
        {subtitulo && <p className="vista-subtitulo">{subtitulo}</p>}
      </div>
      {filtros && <div className="vista-filtros">{filtros}</div>}
      {(opciones || accion) && (
        <div className="vista-acciones">
          {opciones && <div className="vista-opciones">{opciones}</div>}
          {accion}
        </div>
      )}
    </header>
  );
}
