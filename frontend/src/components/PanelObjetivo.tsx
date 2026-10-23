import { useEffect, useRef, useState } from 'react';
import {
  coordenadas,
  decisionDelObjetivo,
  haceCuanto,
  posicionValida,
  rumbo,
  situacionDelObjetivo,
  tipoDeObjetivo,
  velocidad,
} from '../format';
import type { ObjetivoEnSeguimiento } from '../types';
import { IconoOperacion } from './Iconos';

/**
 * Las coordenadas del objetivo con su botón de copiar. Es el dato que el
 * operador le pasa al equipo de tierra, y dictarlas o retiparlas de la pantalla
 * es la forma más rápida de mandar a alguien a la cuadra equivocada.
 */
export function CoordenadasCopiables({ lat, lon }: { lat: number; lon: number }) {
  const [resultado, setResultado] = useState<'copiado' | 'fallo' | null>(null);
  const temporizador = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(temporizador.current), []);
  const texto = coordenadas(lat, lon);

  async function copiar() {
    try {
      // Fuera de un contexto seguro `navigator.clipboard` no existe: el
      // TypeError cae en el mismo catch y el botón no miente.
      await navigator.clipboard.writeText(texto);
      setResultado('copiado');
    } catch {
      setResultado('fallo');
    }
    clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => setResultado(null), 2000);
  }

  return (
    <>
      <span className="hash">
        <span data-testid="coordenadas-objetivo">{texto}</span>
        <button type="button" onClick={copiar} aria-label="Copiar las coordenadas del objetivo">
          {resultado === 'copiado' ? 'Copiado' : 'Copiar'}
        </button>
      </span>
      {resultado === 'fallo' && (
        <span className="aviso malo" role="alert">
          No se pudieron copiar: seleccioná el texto y copialo a mano.
        </span>
      )}
    </>
  );
}

/**
 * El objetivo que el dron está orbitando o siguiendo, con todo lo que la app
 * estima de él (`status.target`). Vive aparte de la alerta porque dura más: la
 * alerta se decide una vez, y después de validarla el dron sigue sobre el
 * objetivo —y el equipo de tierra sigue necesitando dónde está— hasta que
 * alguien lo manda a patrullar.
 */
export default function PanelObjetivo({ objetivo }: { objetivo: ObjetivoEnSeguimiento }) {
  const situacion = situacionDelObjetivo(objetivo);
  const claseSituacion = objetivo.lost ? 'warn' : objetivo.moving ? 'accent' : '';

  return (
    <div className="card con-esquina">
      {/* La mira de "Operación": es lo que el dron tiene en la mira ahora. */}
      <h2>
        <IconoOperacion />
        Objetivo
      </h2>
      <dl className="datos">
        <dt>Tipo</dt>
        <dd>
          {tipoDeObjetivo(objetivo.type)}
          {objetivo.alertId !== null && <span className="muted"> · alerta #{objetivo.alertId}</span>}
        </dd>
        <dt>Situación</dt>
        <dd>
          <strong className={claseSituacion} data-testid="situacion-objetivo">
            {situacion}
          </strong>
        </dd>
        <dt>Velocidad</dt>
        <dd>{velocidad(objetivo.speedMs)}</dd>
        {/* Un objetivo quieto no tiene rumbo: el número que viene es ruido del
            filtro, y escrito al lado de "Quieto" haría pensar que se va. */}
        <dt>Rumbo</dt>
        <dd>{objetivo.moving ? rumbo(objetivo.courseDeg) : <span className="muted">—</span>}</dd>
        <dt>Visto</dt>
        <dd>{haceCuanto(objetivo.lastSeenMs)}</dd>
        <dt>Decisión</dt>
        <dd>
          <span className={objetivo.decision === 'VALIDATED' ? 'estado ok' : 'estado bad'}>
            {decisionDelObjetivo(objetivo)}
          </span>
        </dd>
        <dt>{objetivo.lost ? 'Última posición' : 'Posición'}</dt>
        <dd>
          {posicionValida(objetivo.lat, objetivo.lon) ? (
            <CoordenadasCopiables lat={objetivo.lat} lon={objetivo.lon} />
          ) : (
            <span className="muted">Sin posición estimada</span>
          )}
        </dd>
      </dl>
      {objetivo.lost && (
        <p className="aviso" role="status">
          Hace más de 10 s que la detección no lo ve: el dron orbita la última posición conocida, que es la que
          hay que pasarle al equipo de tierra.
        </p>
      )}
    </div>
  );
}
