import { useId, type CSSProperties } from 'react';
import { RANGO_DE_SILENCIO, textoDeSilencio, type ClaveDeAjuste, type RangoDeAjuste } from '../ajustesDelDron';
import type { AjusteEnEdicion } from './useAjusteDelDron';

/**
 * Las piezas con que se muestra un ajuste del dron, iguales en la tarjeta
 * «Ajustes del dron» de su vista y en el globo del engranaje de una alerta: un
 * ajuste que se lee distinto en dos lugares es un ajuste que alguien va a creer
 * que es otro.
 */

/**
 * Un deslizador con su rótulo y el valor a la vista, con las mismas piezas que
 * los ajustes del control de la vista de pilotaje (`.ajuste`, pilotaje.css).
 */
export function DeslizadorDeAjuste({
  etiqueta,
  rango,
  valor,
  texto,
  deFabrica,
  puedeAjustar,
  idAyuda,
  testId,
  onCambiar,
}: Readonly<{
  etiqueta: string;
  rango: RangoDeAjuste;
  valor: number;
  /** El valor escrito: "4,0 m/s", "15 s", "Sin silencio". */
  texto: string;
  /** Lo que vale es lo de fábrica (`null` en la ficha): se dice al lado del valor. */
  deFabrica: boolean;
  /** Operador o más: el operador de campo ve el valor pero no lo cambia. */
  puedeAjustar: boolean;
  idAyuda: string;
  testId: string;
  onCambiar: (valor: number) => void;
}>) {
  const id = useId();
  // Cuánto de la pista va en oro: Chromium no tiene un pseudo-elemento para la
  // parte recorrida, así que la hoja la pinta con este porcentaje.
  const relleno = ((valor - rango.minimo) / (rango.maximo - rango.minimo)) * 100;
  return (
    <div className="ajuste">
      <div className="ajuste-rotulo">
        <label htmlFor={id}>{etiqueta}</label>
        {/* El valor ya lo dice el deslizador (aria-valuetext): leído dos veces
            con cada flecha, el lector de pantalla no terminaría nunca. */}
        <span className="ajuste-valor" aria-hidden="true" data-testid={testId}>
          {texto}
          {deFabrica && <span className="muted"> · de fábrica</span>}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={rango.minimo}
        max={rango.maximo}
        step={rango.paso}
        value={valor}
        aria-valuetext={deFabrica ? `${texto}, de fábrica` : texto}
        aria-describedby={idAyuda}
        disabled={!puedeAjustar}
        style={{ '--relleno': `${relleno}%` } as CSSProperties}
        onChange={(ev) => onCambiar(Number(ev.target.value))}
      />
    </div>
  );
}

/** Lo que el pie de cada ajuste necesita saber de él. */
export type EstadoDelAjuste = Pick<AjusteEnEdicion<ClaveDeAjuste>, 'esDeFabrica' | 'guardando' | 'error' | 'restablecer'>;

/**
 * El pie de un ajuste: volver a lo de fábrica (con lo de fábrica escrito, para
 * saber a qué se vuelve), el «Guardando…» mientras el pedido viaja y el motivo
 * si el Comando Central lo rechazó.
 */
export function PieDeAjuste({
  ajuste,
  puedeAjustar,
  deFabrica,
}: Readonly<{
  ajuste: EstadoDelAjuste;
  puedeAjustar: boolean;
  /** Lo de fábrica, escrito: "4,0 m/s", "Seguimiento y órbita". */
  deFabrica: string;
}>) {
  return (
    <>
      <div className="ajuste-pie">
        {puedeAjustar && (
          <button type="button" className="chico" onClick={ajuste.restablecer} disabled={ajuste.esDeFabrica || ajuste.guardando}>
            Volver a lo de fábrica ({deFabrica})
          </button>
        )}
        {ajuste.guardando && (
          <span className="muted" role="status">
            Guardando…
          </span>
        )}
      </div>
      {ajuste.error && (
        <p className="aviso malo" role="alert">
          {ajuste.error}
        </p>
      )}
    </>
  );
}

/**
 * El silencio al retomar (VUELO §6), entero: el deslizador de 0 a 30 s, qué es
 * y su pie. Es lo que la tarjeta del dron muestra en «Al retomar la ruta» y lo
 * que abre el engranaje al lado de «Descartar», para el dron de esa alerta.
 */
export function AjusteDeSilencio({
  ajuste,
  puedeAjustar,
}: Readonly<{ ajuste: AjusteEnEdicion<'silencioAlRetomarS'>; puedeAjustar: boolean }>) {
  const idAyuda = useId();
  return (
    <>
      <DeslizadorDeAjuste
        etiqueta="Silencio al retomar"
        rango={RANGO_DE_SILENCIO}
        valor={ajuste.valor}
        texto={textoDeSilencio(ajuste.valor)}
        deFabrica={ajuste.esDeFabrica}
        puedeAjustar={puedeAjustar}
        idAyuda={idAyuda}
        testId="silencio-al-retomar"
        onCambiar={ajuste.cambiar}
      />
      <p className="ajuste-pista" id={idAyuda}>
        Después de descartar una alerta o retomar la ruta, el dron no se detiene por otra detección durante este
        tiempo; las cajas siguen en el video.
      </p>
      <PieDeAjuste ajuste={ajuste} puedeAjustar={puedeAjustar} deFabrica={textoDeSilencio(RANGO_DE_SILENCIO.porDefecto)} />
    </>
  );
}
