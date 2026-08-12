import { FONDOS, nombreDeFondo, type Fondo } from '../mapa';

/**
 * Mapa o satélite, flotando arriba a la derecha del mapa. Va en todos los
 * mapas de la consola: el callejero para ubicarse por calles y el satelital
 * para ver el terreno real antes de poner un nodo o una base.
 */
export default function ConmutadorDeFondo({
  fondo,
  onCambiar,
}: {
  fondo: Fondo;
  onCambiar: (f: Fondo) => void;
}) {
  return (
    <div className="mapa-fondos" role="group" aria-label="Fondo del mapa">
      {FONDOS.map((f) => (
        <button
          key={f}
          type="button"
          className={fondo === f ? 'chico active' : 'chico'}
          aria-pressed={fondo === f}
          onClick={() => onCambiar(f)}
        >
          {nombreDeFondo(f)}
        </button>
      ))}
    </div>
  );
}
