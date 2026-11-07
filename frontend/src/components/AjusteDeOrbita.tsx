import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import type { Drone } from '../types';
import { IconoOperacion } from './Iconos';

/**
 * El rango de la velocidad de órbita que acepta el Comando Central (PROTOCOLS
 * §5, `PATCH /drones/:droneId/ajustes`), que es el de la app: menos de 1 m/s es
 * quedarse quieto sobre el círculo y más que el crucero no tiene sentido.
 */
export const VELOCIDAD_ORBITA_MINIMA_MS = 1;
export const VELOCIDAD_ORBITA_MAXIMA_MS = 8;
export const PASO_DE_ORBITA_MS = 0.5;

/** La de fábrica de la app (`Navegacion.VELOCIDAD_ORBITA_MS`): lo que vale `null`. */
export const VELOCIDAD_ORBITA_POR_DEFECTO_MS = 4;

/** Cuánto se espera con la mano quieta sobre el deslizador antes de guardar. */
export const ESPERA_PARA_GUARDAR_MS = 600;

function formatear(v: number): string {
  return `${v.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m/s`;
}

/**
 * La velocidad con la que el dron orbita a un objetivo detectado, para
 * cambiarla desde su vista. Es un dato del dron y no de un vuelo: el Comando
 * Central la guarda, se la manda a la app en el acto y otra vez cada vez que se
 * conecta, y orbitando el cambio se aplica sin cortar el giro.
 *
 * Se guarda sola cuando la mano se queda quieta sobre el deslizador: arrastrar
 * no manda un pedido por cada posición intermedia. Lo guardado vuelve por la
 * ficha del dron (`drone_updated`); mientras el pedido viaja, el deslizador
 * muestra lo que la persona eligió.
 */
export default function AjusteDeOrbita({
  drone,
  puedeAjustar,
}: Readonly<{
  drone: Drone;
  /** Operador o más: el operador de campo ve el valor pero no lo cambia. */
  puedeAjustar: boolean;
}>) {
  const guardada = drone.velocidadOrbitaMs ?? null;
  const [valor, setValor] = useState<number>(guardada ?? VELOCIDAD_ORBITA_POR_DEFECTO_MS);
  const [tocado, setTocado] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const idAyuda = useId();
  const temporizador = useRef<ReturnType<typeof setTimeout>>();

  // Cuando la ficha cambia, manda: es lo guardado (el valor redondeado, o lo
  // que otra consola fijó). Hasta que llegue, el deslizador muestra lo que la
  // persona eligió: volver al valor viejo mientras el pedido viaja hacía saltar
  // la cifra para atrás un instante.
  useEffect(() => {
    setValor(guardada ?? VELOCIDAD_ORBITA_POR_DEFECTO_MS);
    setTocado(false);
  }, [guardada]);

  useEffect(() => () => clearTimeout(temporizador.current), []);

  async function guardar(velocidadOrbitaMs: number | null) {
    setError('');
    setGuardando(true);
    try {
      await api(`/drones/${drone.droneId}/ajustes`, { method: 'PATCH', body: JSON.stringify({ velocidadOrbitaMs }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Lo rechazado no quedó: el deslizador vuelve a lo guardado.
      setValor(guardada ?? VELOCIDAD_ORBITA_POR_DEFECTO_MS);
      setTocado(false);
    } finally {
      setGuardando(false);
    }
  }

  function programarGuardado(v: number) {
    clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => void guardar(v), ESPERA_PARA_GUARDAR_MS);
  }

  function alMover(v: number) {
    setTocado(true);
    setValor(v);
    programarGuardado(v);
  }

  function restablecer() {
    clearTimeout(temporizador.current);
    setTocado(true);
    setValor(VELOCIDAD_ORBITA_POR_DEFECTO_MS);
    void guardar(null);
  }

  const esDeFabrica = guardada === null && !tocado;

  return (
    <div className="card ajuste-orbita">
      <h2>
        <IconoOperacion />
        Órbita
      </h2>
      <div className="hueco">
        <div className="etiqueta">Velocidad de órbita</div>
        <div className="cifra-chica accent" data-testid="velocidad-orbita">
          {formatear(valor)}
          {esDeFabrica && <span className="muted"> · la de fábrica</span>}
        </div>
      </div>
      <input
        type="range"
        className="ajuste-orbita-deslizador"
        min={VELOCIDAD_ORBITA_MINIMA_MS}
        max={VELOCIDAD_ORBITA_MAXIMA_MS}
        step={PASO_DE_ORBITA_MS}
        value={valor}
        aria-label="Velocidad de órbita"
        aria-valuetext={formatear(valor)}
        aria-describedby={idAyuda}
        disabled={!puedeAjustar}
        onChange={(e) => alMover(Number(e.target.value))}
      />
      <p className="muted" id={idAyuda}>
        Qué tan rápido gira alrededor del objetivo, a 30 m. Más lento, la cámara lo sigue mejor y la captura no
        sale barrida; más rápido, da la vuelta antes. Se guarda sola y vale también para la órbita en curso.
      </p>
      <div className="ajuste-orbita-pie">
        {puedeAjustar && (
          <button type="button" className="chico" onClick={restablecer} disabled={esDeFabrica || guardando}>
            Volver a la de fábrica ({formatear(VELOCIDAD_ORBITA_POR_DEFECTO_MS)})
          </button>
        )}
        {guardando && (
          <span className="muted" role="status">
            Guardando…
          </span>
        )}
      </div>
      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
