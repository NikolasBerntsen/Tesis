import { useEffect, useId, useRef, type CSSProperties, type RefObject } from 'react';
import { RANGOS, textoDeAjuste, type ClaveNumerica, type ControlesDeVuelo } from '../preferenciasDeControl';
import { IconoCerrar, IconoEngranaje } from './Iconos';

type Ajuste = Readonly<{ clave: ClaveNumerica; etiqueta: string; pista?: string }>;

/**
 * Lo que mueve el mouse, en el orden en que se lo siente al volar: el giro, la
 * cámara y, después del interruptor del eje, la rueda.
 */
const DEL_MOUSE: readonly Ajuste[] = [
  { clave: 'sensibilidadHorizontal', etiqueta: 'Sensibilidad horizontal del mouse (giro)' },
  { clave: 'sensibilidadVertical', etiqueta: 'Sensibilidad vertical del mouse (cámara)' },
];
const DE_LA_RUEDA: Ajuste = { clave: 'pasoDeRueda', etiqueta: 'Paso de la rueda para la cámara' };

const DEL_TECLADO: readonly Ajuste[] = [
  { clave: 'velocidadNormal', etiqueta: 'Velocidad normal (W A S D)' },
  { clave: 'velocidadSubida', etiqueta: 'Velocidad de subida y bajada' },
  { clave: 'velocidadGiro', etiqueta: 'Velocidad de giro con Q/E' },
  {
    clave: 'multiplicadorShift',
    etiqueta: 'Multiplicador con Shift',
    pista: 'Con Shift sostenida, las tres velocidades se multiplican por esto, hasta el fondo de la palanca.',
  },
];

/** Un deslizador con su rótulo y el valor a la vista, como se lee en el HUD. */
function Deslizador({
  ajuste,
  valor,
  onCambiar,
}: Readonly<{ ajuste: Ajuste; valor: number; onCambiar: (clave: ClaveNumerica, valor: number) => void }>) {
  const id = useId();
  const idPista = useId();
  const { minimo, maximo, paso } = RANGOS[ajuste.clave];
  const texto = textoDeAjuste(ajuste.clave, valor);
  // Cuánto de la pista va en oro: Chromium no tiene un pseudo-elemento para la
  // parte recorrida, así que la hoja la pinta con este porcentaje.
  const relleno = ((valor - minimo) / (maximo - minimo)) * 100;
  return (
    <div className="ajuste">
      <div className="ajuste-rotulo">
        <label htmlFor={id}>{ajuste.etiqueta}</label>
        {/* El valor ya lo dice el deslizador (aria-valuetext): leído dos veces
            con cada flecha, el lector de pantalla no terminaría nunca. */}
        <span className="ajuste-valor" aria-hidden="true">
          {texto.visible}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={minimo}
        max={maximo}
        step={paso}
        value={valor}
        aria-valuetext={texto.leido}
        aria-describedby={ajuste.pista ? idPista : undefined}
        style={{ '--relleno': `${relleno}%` } as CSSProperties}
        onChange={(ev) => onCambiar(ajuste.clave, Number(ev.target.value))}
      />
      {ajuste.pista && (
        <p id={idPista} className="ajuste-pista">
          {ajuste.pista}
        </p>
      )}
    </div>
  );
}

/**
 * Los ajustes del control: el globo que abre el engranaje, al lado del "?" de
 * la ayuda y con su misma forma. Tampoco es modal: los cambios valen en el acto
 * y se pueden probar sin cerrarlo (con el modo mouse, o tocando la imagen para
 * volver a volar con el teclado).
 *
 * Lo que se escribe acá adentro es de los controles y no del vuelo (ver
 * `teclaAjena` en useTecladoDeVuelo): las flechas mueven un deslizador y
 * Espacio prende el interruptor, y ninguna de las dos puede mover el dron.
 * Por eso la vista necesita su caja (`raiz`), para saber de dónde viene cada
 * tecla.
 */
export default function AjustesDeControl({
  id,
  raiz,
  controles,
  onCambiar,
  onRestablecer,
  onCerrar,
}: Readonly<{
  id: string;
  raiz: RefObject<HTMLElement>;
  controles: ControlesDeVuelo;
  onCambiar: (cambios: Partial<ControlesDeVuelo>) => void;
  onRestablecer: () => void;
  onCerrar: () => void;
}>) {
  const idTitulo = useId();
  const idNota = useId();
  const idPistaInvertir = useId();
  const cerrar = useRef<HTMLButtonElement>(null);

  // El foco entra al abrirse, como en la ayuda: con el teclado, un panel al que
  // no se llega es un panel que no está.
  useEffect(() => {
    cerrar.current?.focus();
  }, []);

  const cambiarNumero = (clave: ClaveNumerica, valor: number) => onCambiar({ [clave]: valor });
  const deslizador = (ajuste: Ajuste) => (
    <Deslizador key={ajuste.clave} ajuste={ajuste} valor={controles[ajuste.clave]} onCambiar={cambiarNumero} />
  );

  return (
    <section
      ref={raiz}
      id={id}
      className="pilotaje-ajustes"
      role="dialog"
      aria-modal="false"
      aria-labelledby={idTitulo}
      aria-describedby={idNota}
    >
      <header className="pilotaje-ajustes-cabecera">
        <h2 id={idTitulo}>
          <IconoEngranaje tamano={18} />
          Ajustes del control
        </h2>
        {/* La cruz de los diálogos y no un "Cerrar" escrito: el título en
            versalitas anchas ya ocupa el renglón. */}
        <button ref={cerrar} type="button" className="modal-cerrar" aria-label="Cerrar los ajustes" onClick={onCerrar}>
          <IconoCerrar tamano={18} />
        </button>
      </header>
      <p id={idNota} className="pilotaje-ajustes-nota">
        Son tuyos, no del dron: te siguen a cualquier computadora y valen en el acto. Con el foco en este panel el
        teclado no vuela; tocá la imagen para seguir volando.
      </p>

      <fieldset className="ajustes-grupo">
        <legend>Mouse</legend>
        {DEL_MOUSE.map(deslizador)}
        <div className="ajuste">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={controles.invertirVertical}
              aria-describedby={idPistaInvertir}
              onChange={(ev) => onCambiar({ invertirVertical: ev.target.checked })}
            />
            <span className="switch-pista" />
            <span className="switch-texto">Invertir eje vertical</span>
          </label>
          <p id={idPistaInvertir} className="ajuste-pista">
            En el modo mouse, llevarlo hacia arriba mira más abajo, como la palanca de un avión.
          </p>
        </div>
        {deslizador(DE_LA_RUEDA)}
      </fieldset>

      <fieldset className="ajustes-grupo">
        <legend>Teclado</legend>
        {DEL_TECLADO.map(deslizador)}
      </fieldset>

      <footer className="pilotaje-ajustes-pie">
        <button type="button" className="ghost chico" onClick={onRestablecer}>
          Restablecer valores por defecto
        </button>
      </footer>
    </section>
  );
}
