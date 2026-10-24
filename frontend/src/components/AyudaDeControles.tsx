import { Fragment, useEffect, useId, useRef, type ReactNode } from 'react';

type Fila = { teclas: ReactNode; accion: string };

/** Una tecla escrita como tecla: el operador busca la forma, no lee la palabra. */
const k = (texto: string) => <kbd>{texto}</kbd>;

type Seccion = { titulo: string; filas: readonly Fila[]; nota?: string };

/**
 * Los modos de manejo, cada uno con lo suyo. Van en el orden en que se aprenden:
 * el teclado vuela solo, el mouse mueve la cámara, el modo mouse junta las dos
 * cosas y los sticks son para cuando no hay teclado (una tableta, un táctil).
 *
 * Lo que la persona ajusta con el engranaje se lee de sus ajustes: una ayuda
 * que promete 5° por muesca con la rueda puesta en 2° es una ayuda que miente.
 */
function secciones(gradosPorMuesca: number): readonly Seccion[] {
  return [
    {
      titulo: 'Teclado',
      filas: [
        { teclas: <>{k('W')} {k('S')}</>, accion: 'Adelante y atrás' },
        { teclas: <>{k('A')} {k('D')}</>, accion: 'Izquierda y derecha, sin girar' },
        { teclas: <>{k('Q')} {k('E')}</>, accion: 'Girar a la izquierda y a la derecha' },
        { teclas: k('Espacio'), accion: 'Subir' },
        // Ctrl baja sólo con el teclado bloqueado, que sólo Chromium tiene y sólo
        // en pantalla completa (ver `TECLAS_CTRL`): prometerla sin esa aclaración
        // era invitar al Ctrl+W que cierra la pestaña en pleno vuelo.
        { teclas: <>{k('C')} (o {k('Ctrl')} en pantalla completa con Chrome o Edge)</>, accion: 'Bajar' },
        { teclas: k('Shift'), accion: 'Sostenida, vuela más rápido; las velocidades se ajustan con el engranaje' },
      ],
      nota: 'Con dos teclas opuestas apretadas manda la última; al soltarla vuelve a mandar la otra.',
    },
    {
      titulo: 'Cámara con el mouse',
      filas: [
        { teclas: 'Rueda', accion: `Inclina la cámara ${gradosPorMuesca}° por muesca: hacia arriba mira más alto` },
        { teclas: 'Botón derecho sostenido', accion: 'Zoom 2× sobre donde apunta el mouse' },
        { teclas: 'Rueda con el derecho apretado', accion: 'Más o menos zoom, de 1× a 8×' },
        { teclas: 'Soltar el derecho', accion: 'Vuelve a la imagen entera' },
      ],
      nota: 'El zoom es de la imagen en tu pantalla: la cámara del dron no cambia.',
    },
    {
      titulo: 'Modo mouse',
      filas: [
        { teclas: 'Botón «Modo mouse»', accion: 'Esconde el cursor y el mouse pasa a manejar' },
        { teclas: 'Mover a los costados', accion: 'Gira el dron: cuanto más rápido, más gira' },
        { teclas: 'Mover arriba y abajo', accion: 'Inclina la cámara' },
        { teclas: k('Esc'), accion: 'Sale del modo mouse' },
      ],
      nota:
        'El teclado sigue volando igual. La sensibilidad de cada eje y la inversión del vertical se ajustan con el engranaje.',
    },
    {
      titulo: 'Sticks virtuales',
      filas: [
        { teclas: 'Palanca izquierda', accion: 'Altura (arriba y abajo) y giro (a los costados)' },
        { teclas: 'Palanca derecha', accion: 'Avance (arriba y abajo) y desplazamiento lateral' },
      ],
      nota: 'Se arrastran con el mouse o con el dedo; al soltar, el dron queda en vuelo estacionario.',
    },
  ];
}

/**
 * La ayuda de la vista de pilotaje: el globo que abre el "?" de arriba a la
 * derecha. No es modal a propósito: se puede leer mientras se vuela, y por eso
 * no corta el teclado de vuelo.
 */
export default function AyudaDeControles({
  id,
  gradosPorMuesca,
  onCerrar,
}: Readonly<{ id: string; gradosPorMuesca: number; onCerrar: () => void }>) {
  const idTitulo = useId();
  const cerrar = useRef<HTMLButtonElement>(null);

  // El foco entra al globo al abrirse: con el teclado, abrir la ayuda y no
  // poder llegar a ella sería lo mismo que no tenerla.
  useEffect(() => {
    cerrar.current?.focus();
  }, []);

  return (
    <section id={id} className="pilotaje-ayuda" role="dialog" aria-modal="false" aria-labelledby={idTitulo}>
      <header className="pilotaje-ayuda-cabecera">
        <h2 id={idTitulo}>Controles del dron</h2>
        <button ref={cerrar} type="button" className="ghost chico" onClick={onCerrar}>
          Cerrar la ayuda
        </button>
      </header>
      {secciones(gradosPorMuesca).map((seccion) => (
        <Fragment key={seccion.titulo}>
          <h3>{seccion.titulo}</h3>
          <dl className="ayuda-controles">
            {seccion.filas.map((fila) => (
              <div key={fila.accion}>
                <dt>{fila.teclas}</dt>
                <dd>{fila.accion}</dd>
              </div>
            ))}
          </dl>
          {seccion.nota && <p className="muted">{seccion.nota}</p>}
        </Fragment>
      ))}
    </section>
  );
}
