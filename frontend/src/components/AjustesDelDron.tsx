import { useEffect, useId, useState } from 'react';
import {
  AJUSTES_DE_FABRICA,
  AYUDA_DE_REACCION,
  RANGO_DE_ORBITA,
  REACCIONES_QUE_SIGUEN,
  ROTULO_DE_REACCION,
  textoDeVelocidad,
  type ReaccionADeteccion,
} from '../ajustesDelDron';
import type { Drone } from '../types';
import { IconoEngranaje } from './Iconos';
import { AjusteDeSilencio, DeslizadorDeAjuste, PieDeAjuste } from './PiezasDeAjuste';
import { useAjusteDelDron, type AjusteEnEdicion } from './useAjusteDelDron';

/**
 * «Ante una detección» (VUELO §5): un interruptor que apagado es `detenerse`
 * —el dron se queda donde está, vigila con la cámara y avisa— y prendido deja
 * elegir cómo va hacia el objetivo. Apagarlo no hace olvidar lo elegido: al
 * prenderlo de nuevo vuelve la forma de seguir de antes (o la de fábrica, si no
 * había ninguna fijada), sin obligar a elegirla otra vez.
 */
function AjusteDeReaccion({
  ajuste,
  puedeAjustar,
}: Readonly<{ ajuste: AjusteEnEdicion<'reaccionADeteccion'>; puedeAjustar: boolean }>) {
  const idPista = useId();
  const idOpciones = useId();
  const sigue = ajuste.valor !== 'detenerse';
  const [ultimaQueSigue, setUltimaQueSigue] = useState<ReaccionADeteccion | null>(() =>
    sigue && !ajuste.esDeFabrica ? ajuste.valor : null,
  );
  useEffect(() => {
    if (ajuste.valor !== 'detenerse') setUltimaQueSigue(ajuste.esDeFabrica ? null : ajuste.valor);
  }, [ajuste.valor, ajuste.esDeFabrica]);

  return (
    <>
      <div className="ajuste">
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={sigue}
            aria-describedby={idPista}
            disabled={!puedeAjustar}
            onChange={(ev) => ajuste.cambiar(ev.target.checked ? ultimaQueSigue : 'detenerse')}
          />
          <span className="switch-pista" />
          <span className="switch-texto">Seguir al objetivo tras una detección</span>
        </label>
        <p id={idPista} className="ajuste-pista">
          {sigue ? 'Apagado, se detiene donde está, lo vigila con la cámara y avisa.' : AYUDA_DE_REACCION.detenerse}
        </p>
      </div>
      {sigue && (
        <fieldset className="opciones-de-reaccion">
          <legend className="etiqueta">Cómo lo sigue</legend>
          {REACCIONES_QUE_SIGUEN.map((reaccion) => (
            <label key={reaccion} className="opcion">
              <input
                type="radio"
                name={idOpciones}
                value={reaccion}
                checked={ajuste.valor === reaccion}
                aria-label={ROTULO_DE_REACCION[reaccion]}
                aria-describedby={`${idOpciones}-${reaccion}`}
                disabled={!puedeAjustar}
                onChange={() => ajuste.cambiar(reaccion)}
              />
              <span className="opcion-texto">
                <span className="opcion-rotulo" aria-hidden="true">
                  {ROTULO_DE_REACCION[reaccion]}
                  {reaccion === AJUSTES_DE_FABRICA.reaccionADeteccion && <span className="muted"> · de fábrica</span>}
                </span>
                <span className="ajuste-pista" id={`${idOpciones}-${reaccion}`}>
                  {AYUDA_DE_REACCION[reaccion]}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <PieDeAjuste
        ajuste={ajuste}
        puedeAjustar={puedeAjustar}
        deFabrica={ROTULO_DE_REACCION[AJUSTES_DE_FABRICA.reaccionADeteccion]}
      />
    </>
  );
}

/**
 * Los tres ajustes del dron (VUELO §10), en la tarjeta de su vista: la velocidad
 * de la órbita, qué hace ante una detección y cuánto calla al retomar la ruta.
 * Son datos del dron y no de un vuelo: el Comando Central los guarda, se los
 * manda a la app en el acto y otra vez cada vez que se conecta, y un cambio con
 * un objetivo en curso se aplica en la evaluación siguiente.
 *
 * Cada control guarda sólo su campo, solo, cuando la mano se queda quieta (ver
 * useAjusteDelDron); «Volver a lo de fábrica» va por sección, con lo de fábrica
 * escrito, porque las tres cosas se deciden por separado.
 */
export default function AjustesDelDron({
  drone,
  puedeAjustar,
}: Readonly<{
  drone: Drone;
  /** Operador o más: el operador de campo ve los valores pero no los cambia. */
  puedeAjustar: boolean;
}>) {
  const orbita = useAjusteDelDron(drone, 'velocidadOrbitaMs');
  const reaccion = useAjusteDelDron(drone, 'reaccionADeteccion');
  const silencio = useAjusteDelDron(drone, 'silencioAlRetomarS');
  const idAyudaOrbita = useId();

  return (
    <div className="card ajustes-dron">
      <h2>
        <IconoEngranaje />
        Ajustes del dron
      </h2>
      <p className="muted">
        Son del dron y no de un vuelo: se guardan solos al cambiarlos, la app los recibe en el acto y en cada
        conexión, y valen también para el objetivo en curso.
      </p>

      <h3>Órbita</h3>
      <DeslizadorDeAjuste
        etiqueta="Velocidad de órbita"
        rango={RANGO_DE_ORBITA}
        valor={orbita.valor}
        texto={textoDeVelocidad(orbita.valor)}
        deFabrica={orbita.esDeFabrica}
        puedeAjustar={puedeAjustar}
        idAyuda={idAyudaOrbita}
        testId="velocidad-orbita"
        onCambiar={orbita.cambiar}
      />
      <p className="ajuste-pista" id={idAyudaOrbita}>
        Qué tan rápido gira alrededor del objetivo, a 30 m. Más lento, la cámara lo sigue mejor y la captura no sale
        barrida; más rápido, da la vuelta antes.
      </p>
      <PieDeAjuste ajuste={orbita} puedeAjustar={puedeAjustar} deFabrica={textoDeVelocidad(RANGO_DE_ORBITA.porDefecto)} />

      <hr className="regla" />
      <h3>Ante una detección</h3>
      <AjusteDeReaccion ajuste={reaccion} puedeAjustar={puedeAjustar} />

      <hr className="regla" />
      <h3>Al retomar la ruta</h3>
      <AjusteDeSilencio ajuste={silencio} puedeAjustar={puedeAjustar} />
    </div>
  );
}
