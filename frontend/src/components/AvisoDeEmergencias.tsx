import { useId, useRef } from 'react';
import { emergenciaAbierta, motivoDeEmergencia } from '../emergencias';
import { time } from '../format';
import { useRelevosYEmergencias } from '../relevosYEmergencias';
import { IconoAterrizar, IconoChevronDerecha } from './Iconos';

/**
 * El aviso de los aterrizajes de emergencia sin recuperar: un panel con el
 * filo y el velo de óxido de una alerta, debajo de la barra y arriba del
 * lienzo de la vista, en todas las secciones y para todos los roles. Se queda
 * hasta que alguien marca el dron como recuperado: un dron en el piso, fuera
 * de base, no deja de ser urgente porque el operador cambió de pantalla.
 *
 * La región está siempre en el DOM, vacía o no, y es asertiva: los lectores de
 * pantalla sólo anuncian los cambios de una región que ya existía, y un dron
 * que bajó solo en un campo no espera a que el lector termine lo que dice.
 */
export default function AvisoDeEmergencias() {
  const { emergencias, abrirEmergencia } = useRelevosYEmergencias();
  const idTitulo = useId();
  const region = useRef<HTMLDivElement>(null);
  // La más nueva arriba: es la que el operador todavía no vio.
  const abiertas = emergencias
    .filter(emergenciaAbierta)
    .sort((a, b) => Date.parse(b.creadaEn) - Date.parse(a.creadaEn));

  /**
   * Marcar el dron como recuperado desde la ficha se lleva su renglón, y con
   * él el botón que la abrió: el foco va a la ficha de la que quede o, si no
   * queda ninguna, al título de la vista.
   */
  function devolverFoco() {
    const otra = region.current?.querySelector<HTMLElement>('button');
    if (otra) otra.focus();
    else document.querySelector<HTMLElement>('main h2')?.focus();
  }

  return (
    <div ref={region} className="aviso-emergencias-region" aria-live="assertive">
      {abiertas.length > 0 && (
        <section className="aviso-emergencias" aria-labelledby={idTitulo}>
          <h2 id={idTitulo} className="aviso-emergencias-titulo">
            <IconoAterrizar tamano={20} />
            {abiertas.length === 1
              ? 'Aterrizaje de emergencia sin recuperar'
              : `${abiertas.length} aterrizajes de emergencia sin recuperar`}
          </h2>
          <ul className="aviso-emergencias-lista">
            {abiertas.map((e) => (
              // Los espacios entre las piezas no se ven (el renglón es flex, con su
              // separación), pero sin ellos un lector de pantalla leería
              // "AlfaBajando desde las…" de corrido.
              <li key={e.id} className="aviso-emergencia">
                {/* La luz roja de lo que todavía nadie atendió, como la de una
                    alerta pendiente: el dron sigue en el piso, fuera de base. */}
                <span className="punto-vivo" aria-hidden="true" />
                <strong className="aviso-emergencia-dron">{e.displayName}</strong>{' '}
                <span>
                  {e.aterrizadaEn
                    ? `En tierra desde las ${time(e.aterrizadaEn)}`
                    : `Bajando desde las ${time(e.creadaEn)}`}
                </span>{' '}
                <span className="aviso-emergencia-motivo">{motivoDeEmergencia(e.motivo)}</span>{' '}
                {abrirEmergencia && (
                  <button
                    type="button"
                    className="enlace versal aviso-emergencia-ficha"
                    aria-label={`Ver la ficha del aterrizaje de emergencia de ${e.displayName}`}
                    onClick={() => abrirEmergencia(e.id, devolverFoco)}
                  >
                    Ver la ficha
                    <IconoChevronDerecha tamano={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
