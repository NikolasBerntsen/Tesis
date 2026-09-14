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

/**
 * Zona muerta del eje: por debajo de esto el eje va en cero. Es la MISMA que
 * aplica la app del celular (`MandoVirtual.ZONA_MUERTA` = 0,05 en el Android),
 * y tiene que seguir siéndolo: si la consola emitiera un eje que el dron se
 * come por zona muerta, el operador leería en pantalla un eje comandado que el
 * dron no ejecuta nunca, y además la consola no mandaría el mensaje de cierre
 * en cero porque creería que todavía hay comando.
 */
const ZONA_MUERTA = 0.05;

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

/**
 * Normaliza un eje: lo recorta a [-1, 1], lo deja con dos decimales —más
 * precisión no la ve nadie— y le aplica la zona muerta, en ese orden y con el
 * mismo criterio que `MandoVirtual.eje` del celular (el borde exacto, 0,05,
 * NO es zona muerta). Así la lectura en pantalla, lo que sale por el socket y
 * lo que el dron ejecuta dicen todos lo mismo.
 */
function acotar(valor: number): number {
  const recortado = Math.round(Math.max(-1, Math.min(1, valor)) * 100) / 100;
  return Math.abs(recortado) < ZONA_MUERTA ? 0 : recortado;
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

/**
 * El dedo de este arrastre entre los que trae el evento, o `undefined` si no
 * está. Se busca por `identifier` y no por posición en la lista porque
 * `touches[0]` es el PRIMER dedo de la pantalla, no el de este plato: con los
 * dos pulgares apoyados cada palanca leía la posición del dedo del otro.
 */
function buscarDedo(toques: React.TouchList, dedo: number | null): React.Touch | undefined {
  if (dedo === null) return undefined;
  return Array.from(toques).find((t) => t.identifier === dedo);
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
export default function MandoVirtual({
  onMando,
  impedimento = null,
}: {
  /** Emite los ejes y devuelve si el mensaje llegó a salir de la consola. */
  onMando: (ejes: Ejes) => boolean;
  /**
   * Por qué el mando no puede comandar ahora mismo, o `null` si puede. Con un
   * impedimento puesto las palancas quedan inertes y el motivo se muestra
   * escrito: esconder el mando de golpe le haría creer al operador que le
   * sacaron el control, y dejarlo vivo le haría creer que el dron le obedece.
   */
  impedimento?: string | null;
}) {
  // Arrastre en curso de cada palanca: `null` es "nadie la está tocando", y
  // entonces manda el teclado. No es lo mismo que "está en el centro".
  const [arrastres, setArrastres] = useState<Record<Palanca, Vector | null>>({
    izquierda: null,
    derecha: null,
  });
  // Se guardan los movimientos y no las teclas: son objetos constantes, así que
  // el Set los distingue por identidad y no hay que volver a buscarlos.
  const [apretadas, setApretadas] = useState<ReadonlySet<Movimiento>>(() => new Set());
  // ¿Salió el último mensaje? `onMando` devuelve false cuando el canal con el
  // Comando Central está cerrado y el mando no llega a ninguna parte. Hay que
  // decirlo: mientras eso pasa el dron se queda con la última velocidad que le
  // llegó hasta que corte por su cuenta (el watchdog de la app, 1,5 s).
  const [ultimoSalio, setUltimoSalio] = useState(true);

  const idAyuda = useId();
  const inerte = impedimento !== null;

  const ejes = useMemo<Ejes>(() => {
    // Sin poder comandar, los ejes van en cero y las lecturas también: mostrar
    // "100% adelante" cuando la orden no sale de la consola es mentirle al
    // operador justo cuando más caro sale.
    if (inerte) return EJES_EN_CERO;
    const izquierda = arrastres.izquierda ?? vectorDeTeclado(apretadas, 'izquierda');
    const derecha = arrastres.derecha ?? vectorDeTeclado(apretadas, 'derecha');
    return { throttle: izquierda.y, yaw: izquierda.x, pitch: derecha.y, roll: derecha.x };
  }, [arrastres, apretadas, inerte]);

  // Los ejes y el callback se leen del ref dentro del temporizador: si fueran
  // dependencias del efecto, mover la palanca lo reiniciaría y la consola
  // emitiría a la velocidad del mouse (60 Hz) en vez de a 10 Hz.
  const ejesRef = useRef(ejes);
  ejesRef.current = ejes;
  const onMandoRef = useRef(onMando);
  onMandoRef.current = onMando;

  const comandando = hayComando(ejes);

  // Levantado el impedimento, el aviso de "no salió" dejó de describir algo: el
  // watchdog de la app (1,5 s) ya frenó al dron mucho antes de que el socket
  // volviera. Se limpia acá para no dejar colgado un cartel que era cierto
  // cuando salió y dejó de serlo.
  useEffect(() => {
    if (!inerte) setUltimoSalio(true);
  }, [inerte]);

  useEffect(() => {
    if (!comandando) return;
    const emitir = (ejesAEmitir: Ejes) => setUltimoSalio(onMandoRef.current(ejesAEmitir));
    // El primero sale apenas se mueve la palanca: esperar al tick haría que el
    // dron arranque hasta 100 ms tarde, y eso se nota en el video.
    emitir(ejesRef.current);
    const id = setInterval(() => emitir(ejesRef.current), INTERVALO_MS);
    return () => {
      clearInterval(id);
      // UN último mensaje en cero y se corta. El dron queda en vuelo
      // estacionario: repetirle el cero 10 veces por segundo para siempre sería
      // inundar el enlace para no decir nada. También corre al desmontar,
      // porque salir de la vista no puede dejar al dron yéndose de largo.
      emitir(EJES_EN_CERO);
    };
  }, [comandando]);

  /**
   * Cómo desengancharse del arrastre con mouse de cada palanca. Va por palanca
   * y no en un único lugar porque un arrastre nuevo no puede quedarse con la
   * limpieza del otro: los listeners del primero quedarían pegados a la ventana.
   */
  const limpiarArrastre = useRef<Record<Palanca, () => void>>({
    izquierda: () => {},
    derecha: () => {},
  });

  // Un arrastre con el mouse se sigue en la ventana; si el componente se va del
  // DOM en el medio —un supervisor que le saca el control al operador—, sin
  // este cierre los handlers quedan pegados a `window` para siempre, tocando un
  // componente que ya no está.
  useEffect(() => {
    const limpiezas = limpiarArrastre.current;
    return () => {
      limpiezas.izquierda();
      limpiezas.derecha();
    };
  }, []);

  /** Dedo que arrastra cada palanca, por `identifier`; `null` si no hay ninguno. */
  const dedos = useRef<Record<Palanca, number | null>>({ izquierda: null, derecha: null });

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
      if (inerte) return;
      // Sin esto el navegador toma el arrastre como "seleccionar texto" y la
      // palanca se queda trabada a mitad de camino.
      ev.preventDefault();
      const plato = ev.currentTarget;
      // Por si quedó un arrastre vivo de esta misma palanca: el nuevo no puede
      // dejar los listeners del anterior sueltos en la ventana.
      limpiarArrastre.current[palanca]();
      mover(palanca, plato, ev.clientX, ev.clientY);

      const alSoltarse = () => {
        limpiarArrastre.current[palanca]();
        soltar(palanca);
      };
      const alMoverse = (e: MouseEvent) => {
        // Puntero moviéndose sin ningún botón apretado: el `mouseup` se perdió
        // (se soltó fuera de la ventana, lo comió un menú del sistema, Alt+Tab)
        // y el arrastre ya terminó. Sin esto la palanca queda trabada emitiendo
        // el último eje a 10 Hz para siempre —el watchdog de la app no salva
        // nada, porque los mensajes siguen llegando— y al volver el puntero a
        // la página el dron se pondría a seguir el cursor.
        if (e.buttons === 0) {
          alSoltarse();
          return;
        }
        mover(palanca, plato, e.clientX, e.clientY);
      };
      limpiarArrastre.current[palanca] = () => {
        window.removeEventListener('mousemove', alMoverse);
        window.removeEventListener('mouseup', alSoltarse);
        window.removeEventListener('blur', alSoltarse);
        window.removeEventListener('pointercancel', alSoltarse);
        limpiarArrastre.current[palanca] = () => {};
      };
      // El seguimiento va en la ventana y no en el plato: mientras se comanda,
      // el puntero se sale del círculo todo el tiempo, y con el listener en el
      // plato la palanca se congelaría en el último punto de adentro.
      window.addEventListener('mousemove', alMoverse);
      window.addEventListener('mouseup', alSoltarse);
      // La ventana que pierde el foco con el botón apretado (Alt+Tab, otra
      // aplicación, un diálogo del sistema) no va a entregar nunca el `mouseup`.
      window.addEventListener('blur', alSoltarse);
      // Y si el sistema le saca el puntero al navegador en pleno arrastre (un
      // gesto del sistema operativo, el mouse que se desenchufa), lo que llega
      // es `pointercancel` y NO un `mouseup`: sin esto la palanca se quedaría
      // emitiendo el último eje a 10 Hz. Con la captura puesta más todavía,
      // porque cancelar el puntero es justo lo que la suelta.
      window.addEventListener('pointercancel', alSoltarse);
    };
  }

  /**
   * El puntero que baja al plato. El arrastre lo sigue manejando el camino de
   * mouse —los eventos de mouse están en todos los navegadores y son los que ya
   * estaban probados—; acá se PIDE la captura del puntero, que es lo único que
   * garantiza que el `pointerup` (y con él el `mouseup` de compatibilidad) le
   * llegue a la página aunque el operador suelte el botón afuera de la ventana.
   * Sin captura ese caso no lo cierra nadie: soltar sobre otra aplicación sin
   * clickearla no le quita el foco a la ventana (no hay `blur`) y con el
   * puntero quieto afuera tampoco hay `mousemove`, así que la palanca seguiría
   * emitiendo el último eje a 10 Hz hasta que el puntero vuelva a entrar.
   *
   * El dedo no se captura a propósito: un toque ya le entrega todos sus eventos
   * al elemento donde empezó, y el camino táctil de este componente no pasa por
   * los eventos de puntero.
   */
  function alBajarPuntero(ev: React.PointerEvent<HTMLDivElement>) {
    if (inerte || ev.pointerType === 'touch') return;
    // El `?.` no es de adorno: jsdom no implementa la captura, y en un navegador
    // sin Pointer Events este manejador no corre siquiera. En los dos casos queda
    // el camino de mouse tal cual estaba.
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
  }

  /**
   * Dedo que baja al plato. El camino táctil NO pasa por los eventos de puntero
   * a propósito —la consola también corre en navegadores donde no están, y un
   * toque ya le entrega todos sus eventos al elemento donde empezó; lo único que
   * se les pide es la captura del mouse, en `alBajarPuntero`—, y el que la página
   * no se desplace al arrastrar lo resuelve el `touch-action: none` del plato,
   * porque React escucha touchmove en pasivo.
   */
  function alEmpezarToque(palanca: Palanca) {
    return (ev: React.TouchEvent<HTMLDivElement>) => {
      if (inerte) return;
      // Si la palanca ya la está arrastrando un dedo, el que caiga encima
      // después no se la pelea: manda el que llegó primero.
      if (dedos.current[palanca] !== null) return;
      const toque = ev.changedTouches[0];
      dedos.current[palanca] = toque.identifier;
      mover(palanca, ev.currentTarget, toque.clientX, toque.clientY);
    };
  }

  /** Arrastre del dedo: se mueve SU palanca, no la que tenga el otro pulgar. */
  function alMoverToque(palanca: Palanca) {
    return (ev: React.TouchEvent<HTMLDivElement>) => {
      const toque = buscarDedo(ev.touches, dedos.current[palanca]);
      if (!toque) return;
      mover(palanca, ev.currentTarget, toque.clientX, toque.clientY);
    };
  }

  /** Vale para el dedo que se levanta y para el toque que el sistema cancela. */
  function alTerminarToque(palanca: Palanca) {
    return (ev: React.TouchEvent<HTMLDivElement>) => {
      // El dedo que se levantó tiene que ser el que arrastraba: levantar el
      // otro pulgar no puede soltar esta palanca.
      if (!buscarDedo(ev.changedTouches, dedos.current[palanca])) return;
      dedos.current[palanca] = null;
      soltar(palanca);
    };
  }

  function alApretarTecla(ev: React.KeyboardEvent<HTMLDivElement>) {
    const mov = TECLAS[ev.key.toLowerCase()];
    // Sólo se atajan las teclas del mando: el resto sigue viaje, así que Tab
    // sale del bloque y los atajos del navegador siguen funcionando.
    if (!mov || inerte) return;
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
          onPointerDown={alBajarPuntero}
          onMouseDown={alApretarMouse(palanca)}
          onTouchStart={alEmpezarToque(palanca)}
          onTouchMove={alMoverToque(palanca)}
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
      className={`mando${inerte ? ' mando-impedido' : ''}`}
      role="group"
      tabIndex={0}
      aria-label="Mando virtual de vuelo continuo"
      aria-describedby={idAyuda}
      aria-disabled={inerte}
      onKeyDown={alApretarTecla}
      onKeyUp={alSoltarTecla}
      onBlur={alPerderFoco}
    >
      {/* El motivo va arriba de todo: es lo primero que hay que leer antes de
          empujar una palanca que no va a mover nada. */}
      {inerte && (
        <p className="aviso" role="status" data-testid="mando-impedimento">
          {impedimento}
        </p>
      )}
      {/* Los dos avisos NO son excluyentes, y justamente conviven en el caso que
          importa. `onMando` devuelve false por un solo motivo, el socket cerrado,
          que es el mismo que le pone al mando el impedimento de conexión (ver
          `impedimentoDelMando` en DroneDetail); colgado del `else` de ese
          impedimento, este aviso quedaba en una rama que la consola no alcanza a
          mostrar: el false y el impedimento llegan juntos. Con el enlace cortado
          en pleno vuelo manual, arriba se lee que el mando no responde y acá lo
          que hay que hacer algo al respecto: el dron se sigue moviendo con la
          última velocidad que alcanzó a recibir. */}
      {!ultimoSalio && (
        <p className="aviso malo" role="alert" data-testid="mando-no-salio">
          El último comando no salió de la consola: se cortó el enlace con el Comando Central. Hasta
          que la app corte sola (1,5 s), el dron sigue con la última velocidad que le llegó.
        </p>
      )}

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
