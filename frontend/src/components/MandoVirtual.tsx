import { useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * Los cuatro ejes del mando, cada uno en [-1, 1] como una palanca física y
 * relativos al cuerpo del dron (adelante = hacia donde mira la cámara), que es
 * lo que el operador ve en el video.
 */
export type Ejes = {
  /** +1 adelante (hacia la nariz), -1 atrás */
  pitch: number;
  /** +1 a la derecha, -1 a la izquierda */
  roll: number;
  /** +1 gira en sentido horario, -1 antihorario */
  yaw: number;
  /** +1 sube, -1 baja */
  throttle: number;
};

/** Vuelo estacionario: es lo último que se manda al soltar la palanca. */
export const EJES_EN_CERO: Ejes = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };

/**
 * 10 Hz. Es el ritmo acordado con el backend y con la app del celular: la app
 * corta el vuelo por su cuenta si pasa 1,5 s sin recibir nada, así que emitir
 * más lento la haría frenar sola; más rápido sólo inunda el enlace.
 */
const INTERVALO_MS = 100;

/** Cuánto se corre la perilla dentro del plato, en % del lado, para el eje ±1. */
const RECORRIDO_PCT = 34;

type Palanca = 'izquierda' | 'derecha';

/** Posición de una palanca dentro de su plato: x a la derecha, y hacia arriba. */
type Vector = { x: number; y: number };

/** Qué mueve una tecla: de qué palanca y en qué sentido sobre cada eje. */
type Movimiento = { palanca: Palanca; x: number; y: number };

/**
 * Una consola de operación se usa con teclado, y además tiene que poder
 * manejarse sin mouse. Se reparten como en un control físico: la mano
 * izquierda sobre W/A/S/D (altura y giro) y la derecha sobre las flechas
 * (avance y desplazamiento lateral). Las claves van en minúscula porque el
 * manejador normaliza con toLowerCase: así Mayúsculas o Bloq Mayús no dejan de
 * responder en medio de un vuelo.
 */
const TECLAS: Readonly<Record<string, Movimiento | undefined>> = {
  w: { palanca: 'izquierda', x: 0, y: 1 },
  s: { palanca: 'izquierda', x: 0, y: -1 },
  a: { palanca: 'izquierda', x: -1, y: 0 },
  d: { palanca: 'izquierda', x: 1, y: 0 },
  arrowup: { palanca: 'derecha', x: 0, y: 1 },
  arrowdown: { palanca: 'derecha', x: 0, y: -1 },
  arrowleft: { palanca: 'derecha', x: -1, y: 0 },
  arrowright: { palanca: 'derecha', x: 1, y: 0 },
};

/** Lo que se muestra de cada eje: sin esto el operador no sabe qué comandó. */
const LECTURAS: readonly { eje: keyof Ejes; etiqueta: string; mas: string; menos: string }[] = [
  { eje: 'throttle', etiqueta: 'Altura', mas: 'subiendo', menos: 'bajando' },
  { eje: 'yaw', etiqueta: 'Giro', mas: 'horario', menos: 'antihorario' },
  { eje: 'pitch', etiqueta: 'Avance', mas: 'adelante', menos: 'atrás' },
  { eje: 'roll', etiqueta: 'Lateral', mas: 'a la derecha', menos: 'a la izquierda' },
];

/** Deja el eje en [-1, 1] y con dos decimales: más precisión no la ve nadie. */
function acotar(valor: number): number {
  return Math.round(Math.max(-1, Math.min(1, valor)) * 100) / 100;
}

/**
 * Punto del puntero → eje. El centro del plato es el 0 y el borde el ±1; el eje
 * vertical se da vuelta porque en la pantalla la `y` crece hacia abajo y en un
 * mando, arriba es subir.
 */
function vectorDesdePunto(plato: DOMRect, clienteX: number, clienteY: number): Vector {
  const centroX = plato.left + plato.width / 2;
  const centroY = plato.top + plato.height / 2;
  // El mínimo de 1 px evita dividir por cero: en el navegador el plato siempre
  // mide más, pero una caja todavía sin medir daría NaN y el eje quedaría roto.
  const radioX = Math.max(plato.width, 1) / 2;
  const radioY = Math.max(plato.height, 1) / 2;
  return { x: acotar((clienteX - centroX) / radioX), y: acotar((centroY - clienteY) / radioY) };
}

/** Suma las teclas apretadas de una palanca: W y S a la vez se anulan. */
function vectorDeTeclado(apretadas: ReadonlySet<Movimiento>, palanca: Palanca): Vector {
  let x = 0;
  let y = 0;
  for (const mov of apretadas) {
    if (mov.palanca === palanca) {
      x += mov.x;
      y += mov.y;
    }
  }
  return { x: acotar(x), y: acotar(y) };
}

/** ¿Hay algo comandado? Sumar los módulos evita comparar eje por eje. */
function hayComando(ejes: Ejes): boolean {
  return Math.abs(ejes.pitch) + Math.abs(ejes.roll) + Math.abs(ejes.yaw) + Math.abs(ejes.throttle) > 0;
}

/** Lectura de un eje: cuánto y para dónde, que es lo que le importa al operador. */
function textoDeEje(valor: number, mas: string, menos: string): string {
  const porcentaje = Math.round(Math.abs(valor) * 100);
  if (porcentaje === 0) return 'sin comando';
  return `${porcentaje}% ${valor > 0 ? mas : menos}`;
}

/**
 * Las dos palancas del control, para volar el dron desde el navegador.
 *
 * Es vuelo CONTINUO: mientras el operador sostiene la palanca se emiten los
 * ejes a 10 Hz y el dron se mueve; al soltar sale un último mensaje en cero y
 * el dron queda en vuelo estacionario. No es el pad de flechas de al lado, que
 * ordena un salto puntual de 25 m y se olvida.
 */
export default function MandoVirtual({ onMando }: { onMando: (ejes: Ejes) => void }) {
  // Arrastre en curso de cada palanca: `null` es "nadie la está tocando", y
  // entonces manda el teclado. No es lo mismo que "está en el centro".
  const [arrastres, setArrastres] = useState<Record<Palanca, Vector | null>>({
    izquierda: null,
    derecha: null,
  });
  // Se guardan los movimientos y no las teclas: son objetos constantes, así que
  // el Set los distingue por identidad y no hay que volver a buscarlos.
  const [apretadas, setApretadas] = useState<ReadonlySet<Movimiento>>(() => new Set());

  const idAyuda = useId();

  const ejes = useMemo<Ejes>(() => {
    const izquierda = arrastres.izquierda ?? vectorDeTeclado(apretadas, 'izquierda');
    const derecha = arrastres.derecha ?? vectorDeTeclado(apretadas, 'derecha');
    return { throttle: izquierda.y, yaw: izquierda.x, pitch: derecha.y, roll: derecha.x };
  }, [arrastres, apretadas]);

  // Los ejes y el callback se leen del ref dentro del temporizador: si fueran
  // dependencias del efecto, mover la palanca lo reiniciaría y la consola
  // emitiría a la velocidad del mouse (60 Hz) en vez de a 10 Hz.
  const ejesRef = useRef(ejes);
  ejesRef.current = ejes;
  const onMandoRef = useRef(onMando);
  onMandoRef.current = onMando;

  const comandando = hayComando(ejes);

  useEffect(() => {
    if (!comandando) return;
    // El primero sale apenas se mueve la palanca: esperar al tick haría que el
    // dron arranque hasta 100 ms tarde, y eso se nota en el video.
    onMandoRef.current(ejesRef.current);
    const id = setInterval(() => onMandoRef.current(ejesRef.current), INTERVALO_MS);
    return () => {
      clearInterval(id);
      // UN último mensaje en cero y se corta. El dron queda en vuelo
      // estacionario: repetirle el cero 10 veces por segundo para siempre sería
      // inundar el enlace para no decir nada. También corre al desmontar,
      // porque salir de la vista no puede dejar al dron yéndose de largo.
      onMandoRef.current(EJES_EN_CERO);
    };
  }, [comandando]);

  // Un arrastre con el mouse se sigue en la ventana; si el componente se va del
  // DOM en el medio, los listeners quedarían colgados sin este cierre.
  const limpiarArrastre = useRef<() => void>(() => {});
  useEffect(() => () => limpiarArrastre.current(), []);

  function mover(palanca: Palanca, plato: HTMLElement, clienteX: number, clienteY: number) {
    const vector = vectorDesdePunto(plato.getBoundingClientRect(), clienteX, clienteY);
    setArrastres((previo) => ({ ...previo, [palanca]: vector }));
  }

  /** Soltar devuelve la palanca al centro, como el resorte de un control real. */
  function soltar(palanca: Palanca) {
    setArrastres((previo) => ({ ...previo, [palanca]: null }));
  }

  function alApretarMouse(palanca: Palanca) {
    return (ev: React.MouseEvent<HTMLDivElement>) => {
      // Sin esto el navegador toma el arrastre como "seleccionar texto" y la
      // palanca se queda trabada a mitad de camino.
      ev.preventDefault();
      const plato = ev.currentTarget;
      mover(palanca, plato, ev.clientX, ev.clientY);

      const alMoverse = (e: MouseEvent) => mover(palanca, plato, e.clientX, e.clientY);
      const alSoltarse = () => {
        limpiarArrastre.current();
        soltar(palanca);
      };
      limpiarArrastre.current = () => {
        window.removeEventListener('mousemove', alMoverse);
        window.removeEventListener('mouseup', alSoltarse);
        limpiarArrastre.current = () => {};
      };
      // El seguimiento va en la ventana y no en el plato: mientras se comanda,
      // el puntero se sale del círculo todo el tiempo, y con el listener en el
      // plato la palanca se congelaría en el último punto de adentro.
      window.addEventListener('mousemove', alMoverse);
      window.addEventListener('mouseup', alSoltarse);
    };
  }

  /**
   * Dedo: sirve para el toque inicial y para el arrastre. No se usan eventos de
   * puntero a propósito —la consola también corre en navegadores donde no
   * están— y el que la página no se desplace al arrastrar lo resuelve el
   * `touch-action: none` del plato, porque React escucha touchmove en pasivo.
   */
  function alTocar(palanca: Palanca) {
    return (ev: React.TouchEvent<HTMLDivElement>) => {
      const toque = ev.touches[0];
      mover(palanca, ev.currentTarget, toque.clientX, toque.clientY);
    };
  }

  /** Vale para el dedo que se levanta y para el toque que el sistema cancela. */
  function alTerminarToque(palanca: Palanca) {
    return () => soltar(palanca);
  }

  function alApretarTecla(ev: React.KeyboardEvent<HTMLDivElement>) {
    const mov = TECLAS[ev.key.toLowerCase()];
    // Sólo se atajan las teclas del mando: el resto sigue viaje, así que Tab
    // sale del bloque y los atajos del navegador siguen funcionando.
    if (!mov) return;
    ev.preventDefault();
    setApretadas((previas) => new Set(previas).add(mov));
  }

  function alSoltarTecla(ev: React.KeyboardEvent<HTMLDivElement>) {
    const mov = TECLAS[ev.key.toLowerCase()];
    if (!mov) return;
    setApretadas((previas) => {
      const restantes = new Set(previas);
      restantes.delete(mov);
      return restantes;
    });
  }

  /**
   * Si el foco se va con una tecla apretada, el keyup se lo lleva otro y el eje
   * queda clavado: el dron seguiría subiendo con el operador mirando otra cosa.
   */
  function alPerderFoco() {
    setApretadas(new Set());
  }

  function dibujarPalanca(palanca: Palanca, titulo: string, teclas: string, vector: Vector) {
    return (
      <div className="palanca">
        <span className="etiqueta">{titulo}</span>
        <div
          className="palanca-plato"
          data-testid={`palanca-${palanca}`}
          onMouseDown={alApretarMouse(palanca)}
          onTouchStart={alTocar(palanca)}
          onTouchMove={alTocar(palanca)}
          onTouchEnd={alTerminarToque(palanca)}
          onTouchCancel={alTerminarToque(palanca)}
        >
          <span className="palanca-cruz" aria-hidden="true" />
          <span
            className="palanca-perilla"
            data-testid={`perilla-${palanca}`}
            style={{
              left: `${50 + vector.x * RECORRIDO_PCT}%`,
              top: `${50 - vector.y * RECORRIDO_PCT}%`,
            }}
          />
        </div>
        <span className="muted mando-teclas">{teclas}</span>
      </div>
    );
  }

  return (
    <div
      className="mando"
      role="group"
      tabIndex={0}
      aria-label="Mando virtual de vuelo continuo"
      aria-describedby={idAyuda}
      onKeyDown={alApretarTecla}
      onKeyUp={alSoltarTecla}
      onBlur={alPerderFoco}
    >
      <div className="mando-palancas">
        {dibujarPalanca('izquierda', 'Altura y giro', 'W S · A D', {
          x: ejes.yaw,
          y: ejes.throttle,
        })}
        {dibujarPalanca('derecha', 'Avance y lateral', '↑ ↓ · ← →', { x: ejes.roll, y: ejes.pitch })}
      </div>

      {/* Las lecturas no se anuncian solas (nada de aria-live): a 10 Hz un
          lector de pantalla no diría otra cosa en toda la maniobra. */}
      <dl className="mando-lecturas">
        {LECTURAS.map((lectura) => (
          <div key={lectura.eje}>
            <dt className="etiqueta">{lectura.etiqueta}</dt>
            <dd data-testid={`eje-${lectura.eje}`}>
              {textoDeEje(ejes[lectura.eje], lectura.mas, lectura.menos)}
            </dd>
          </div>
        ))}
      </dl>

      <p className="muted mando-ayuda" id={idAyuda}>
        Arrastrá las palancas con el mouse o el dedo, o manejalas con el teclado (W, A, S, D y las
        flechas) después de enfocar el mando. Mientras sostengas, el dron se mueve; al soltar queda
        en vuelo estacionario.
      </p>
    </div>
  );
}
