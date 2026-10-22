import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { posicionDelDron, rumbo, tipoDeObjetivo } from '../format';
import {
  GRADOS_POR_MUESCA,
  GRADOS_POR_PIXEL,
  INCLINACION_POR_DEFECTO,
  ZOOM_AL_APRETAR,
  ZOOM_POR_MUESCA,
  ZOOM_SIN_AUMENTO,
  acotarEje,
  acotarInclinacion,
  acotarZoom,
  giroDelMouse,
  muescasDeRueda,
  pasosDeRueda,
  recortarInclinacion,
  textoDeAltura,
  textoDeInclinacion,
  textoDeZoom,
} from '../pilotaje';
import type { Alert, DroneStatus } from '../types';
import AyudaDeControles from './AyudaDeControles';
import MandoVirtual, { EJES_EN_CERO, type Ejes } from './MandoVirtual';
import Minimapa from './Minimapa';
import Modal from './Modal';
import { useTecladoDeVuelo } from './useTecladoDeVuelo';

/**
 * Como mucho un `manual_gimbal` cada 100 ms (10 Hz, el contrato): la rueda
 * entrega una muesca por evento y el modo mouse decenas de movimientos por
 * segundo, y cada uno no puede ser un mensaje.
 */
const INTERVALO_CAMARA_MS = 100;

/**
 * Cuánto se espera después del último gesto antes de volver a creerle a la
 * inclinación que informa el dron. Mientras el operador mueve la cámara, el
 * dron informa la posición de hace un segundo: si se le creyera en el acto, el
 * número del HUD saltaría para atrás y la muesca siguiente partiría de ahí.
 */
const ESPERA_PARA_SINCRONIZAR_MS = 2000;

/** El giro del mouse se apaga en tres pasos de 50 ms: mitad, cuarto, cero. */
const PASO_DE_DECAIMIENTO_MS = 50;
const PASOS_DE_DECAIMIENTO = 3;

type Zoom = { escala: number; x: number; y: number };

/** Los manejadores de los eventos nativos que la vista escucha (ver `manejadores`). */
type Manejadores = {
  rueda: (ev: WheelEvent) => void;
  movimiento: (ev: MouseEvent) => void;
  tecla: (ev: KeyboardEvent) => void;
};
const SIN_ZOOM: Zoom = { escala: ZOOM_SIN_AUMENTO, x: 50, y: 50 };

/** La espera del lock, con las mismas palabras en el HUD y en los sticks. */
const ESPERANDO_EL_CONTROL = 'Esperando que el Comando Central confirme el control: el mando todavía no responde.';

/**
 * La Keyboard Lock API (sólo Chromium): con la pantalla completa, deja que la
 * página reciba Ctrl+W, Ctrl+D y Esc en vez de que el navegador cierre la
 * pestaña o salga de la pantalla completa. No está en los tipos de TypeScript
 * porque no es un estándar cerrado.
 */
type TecladoDelNavegador = { lock?: () => Promise<void>; unlock?: () => void };

function tecladoDelNavegador(): TecladoDelNavegador | undefined {
  return (navigator as Navigator & { keyboard?: TecladoDelNavegador }).keyboard;
}

/**
 * Llama a una API del navegador que puede no estar, tirar en el acto o
 * rechazar la promesa más tarde (pantalla completa, captura del puntero,
 * bloqueo del teclado), y se olvida del resultado. Ninguna de las tres es
 * imprescindible para volar: si faltan, la vista sigue andando sin ellas.
 */
function sinFallar(llamada: () => unknown) {
  try {
    const resultado = llamada();
    if (resultado instanceof Promise) resultado.catch(() => {});
  } catch {
    /* el navegador no la tiene o no la permite ahora: se sigue sin ella */
  }
}

/** Suelta todo lo que la vista le pidió al navegador. Se puede llamar de más. */
function liberarNavegador(elemento: HTMLElement | null) {
  if (elemento && document.pointerLockElement === elemento) sinFallar(() => document.exitPointerLock());
  if (elemento && document.fullscreenElement === elemento) sinFallar(() => document.exitFullscreen());
  sinFallar(() => tecladoDelNavegador()?.unlock?.());
}

/** El id más alto entre las alertas de este dron: lo que ya estaba al abrir la vista. */
function mayorIdDeAlertas(alertas: readonly Alert[], droneId: string): number {
  return alertas.reduce((mayor, a) => (a.drone_id === droneId && a.id > mayor ? a.id : mayor), 0);
}

/**
 * La vista de pilotaje: la cámara del dron a pantalla completa y, encima, lo
 * justo para volar como en un juego. Arriba a la izquierda la salida y el
 * minimapa; arriba al centro el HUD; arriba a la derecha la ayuda; abajo las
 * órdenes de vuelo y, si se piden, los sticks virtuales.
 *
 * Se pinta en un portal sobre el `body`: un `position: fixed` adentro de la
 * página queda atrapado por cualquier ancestro con `transform` o `filter`, y
 * esta vista tiene que tapar la pantalla entera aun cuando el navegador no
 * deje ponerla en pantalla completa.
 */
export default function PilotajePantallaCompleta({
  nombre,
  droneId,
  enLinea,
  status,
  frame,
  alertas,
  controlTomado,
  impedimento,
  camaraDisponible,
  esperandoConfirmacion,
  enElSuelo,
  enElAire,
  avisoDeOrden,
  error,
  hayObjetivo,
  suspendido,
  onMando,
  onCamara,
  onOrden,
  onCerrar,
  onSalir,
  onDevolverFoco,
}: {
  nombre: string;
  droneId: string;
  /** El dron está conectado al Comando Central. */
  enLinea: boolean;
  status: DroneStatus | null;
  frame: string | null;
  alertas: readonly Alert[];
  /**
   * Este operador tiene el lock. Recién tomado el control la vista se abre
   * antes de que llegue el `control_changed`, y ese segundo el teclado espera.
   */
  controlTomado: boolean;
  /** Por qué el mando no puede comandar, o `null` (ver `impedimentoDelMando` en DroneDetail). */
  impedimento: string | null;
  /**
   * Si la cámara puede recibir órdenes: lo mismo que el mando, salvo el suelo.
   * Inclinar la cámara con el dron apoyado no le hace nada a nadie, y sirve
   * para mirar alrededor antes de despegar.
   */
  camaraDisponible: boolean;
  esperandoConfirmacion: boolean;
  enElSuelo: boolean;
  enElAire: boolean;
  /** El aviso de una orden de despegue o aterrizaje que el dron todavía no cumplió. */
  avisoDeOrden: string | null;
  /**
   * Por qué el backend rechazó la última orden (despegar, aterrizar), o vacío.
   * Tiene que leerse acá: el detalle de atrás queda inerte y, en pantalla
   * completa, el navegador ni siquiera lo pinta.
   */
  error: string;
  /** Con un objetivo cargado, soltar el control devuelve el dron al objetivo. */
  hayObjetivo: boolean;
  /** Un diálogo del detalle está abierto encima (despegar, aterrizar): el teclado no vuela. */
  suspendido: boolean;
  onMando: (ejes: Ejes) => boolean;
  /** Inclinación absoluta de la cámara, en grados; devuelve si el mensaje salió. */
  onCamara: (pitch: number) => boolean;
  onOrden: (orden: 'despegar' | 'aterrizar') => void;
  /** Cierra la vista y el control sigue tomado. */
  onCerrar: () => void;
  /** Cierra la vista y suelta el control. */
  onSalir: () => void;
  /**
   * Al cerrarse la vista, si lo que tenía el foco antes de abrirla ya no está
   * en la página: casi siempre es "Tomar control manual", que se va en cuanto
   * el control queda tomado. El detalle sabe qué ofrece ahora en su lugar.
   */
  onDevolverFoco: () => void;
}) {
  const raiz = useRef<HTMLElement>(null);
  const video = useRef<HTMLDivElement>(null);
  const botonAyuda = useRef<HTMLButtonElement>(null);
  const idAyuda = useId();
  const idSticks = useId();
  const idSalida = useId();
  const idSalidaTexto = useId();

  const [pantallaCompleta, setPantallaCompleta] = useState(false);
  /**
   * El navegador cumplió el pedido de bloquear el teclado (Keyboard Lock).
   * Recién ahí le pasa a la página los atajos con Ctrl (ver `TECLAS_CTRL` en
   * useTecladoDeVuelo): pedirlo no alcanza, porque Firefox y Safari no lo
   * tienen y Chromium lo puede negar.
   */
  const [tecladoBloqueado, setTecladoBloqueado] = useState(false);
  // Lo que tenía el foco al abrir, leído en el primer render: los efectos de
  // abajo lo mueven adentro de la vista y dejan inerte lo de atrás, y después
  // ya no se sabe de dónde venía.
  const [focoPrevio] = useState(() => document.activeElement);
  const onDevolverFocoRef = useRef(onDevolverFoco);
  onDevolverFocoRef.current = onDevolverFoco;
  const [modoMouse, setModoMouse] = useState(false);
  const [ayudaAbierta, setAyudaAbierta] = useState(false);
  const [sticksVisibles, setSticksVisibles] = useState(false);
  const [confirmandoSalida, setConfirmandoSalida] = useState(false);
  const [zoom, setZoom] = useState<Zoom>(SIN_ZOOM);
  const [giroMouse, setGiroMouse] = useState(0);
  // Los sticks virtuales no emiten: informan sus ejes y salen sumados a los del
  // teclado por el único emisor de la vista (ver `useTecladoDeVuelo`).
  const [ejesDeSticks, setEjesDeSticks] = useState<Ejes>(EJES_EN_CERO);
  const [avisoDelNavegador, setAvisoDelNavegador] = useState('');
  // Las alertas que ya estaban al abrir la vista se decidían en el detalle; lo
  // que se avisa acá es lo que llega mientras se vuela.
  const [umbralDeAlertas, setUmbralDeAlertas] = useState(() => mayorIdDeAlertas(alertas, droneId));

  const reportada = status?.gimbalPitch;
  const [inclinacion, setInclinacion] = useState(() =>
    acotarInclinacion(typeof reportada === 'number' && Number.isFinite(reportada) ? reportada : INCLINACION_POR_DEFECTO),
  );
  // La inclinación se lee de la ref en los manejadores nativos (rueda, mouse):
  // dos muescas seguidas no pueden partir las dos del mismo valor viejo. Es la
  // redondeada, la que se muestra y se manda.
  const inclinacionRef = useRef(inclinacion);
  // La cuenta exacta, sin redondear, que es de donde parte cada gesto: el modo
  // mouse suma 0,15° por píxel, y redondear cada paso torcía la cuenta para
  // arriba (ver `recortarInclinacion`).
  const inclinacionExacta = useRef(inclinacion);
  const ultimoGestoDeCamara = useRef(Number.NEGATIVE_INFINITY);
  const derechoApretado = useRef(false);
  const restoDeRueda = useRef(0);
  const decaimiento = useRef<ReturnType<typeof setInterval> | null>(null);
  const envioDeCamara = useRef<{ ultimo: number; pendiente: number | null; temporizador: ReturnType<typeof setTimeout> | null }>({
    ultimo: Number.NEGATIVE_INFINITY,
    pendiente: null,
    temporizador: null,
  });
  const onCamaraRef = useRef(onCamara);
  onCamaraRef.current = onCamara;

  const hayDialogo = suspendido || confirmandoSalida;
  const { rapido, ultimoSalio } = useTecladoDeVuelo({
    activo: controlTomado && !hayDialogo,
    inerte: impedimento !== null,
    onMando,
    giroExtra: giroMouse,
    sticks: ejesDeSticks,
    ctrlBaja: pantallaCompleta && tecladoBloqueado,
  });
  const puedeMoverLaCamara = controlTomado && camaraDisponible;

  /**
   * Manda la inclinación respetando los 10 Hz: si el último salió hace menos
   * de 100 ms, éste espera el resto y sale el ÚLTIMO pedido en ese lapso. La
   * cámara tiene que terminar donde el operador la dejó, no donde estaba la
   * primera muesca.
   */
  function enviarCamara(pitch: number) {
    const envio = envioDeCamara.current;
    const espera = envio.ultimo + INTERVALO_CAMARA_MS - Date.now();
    if (espera <= 0 && envio.temporizador === null) {
      envio.ultimo = Date.now();
      onCamaraRef.current(pitch);
      return;
    }
    envio.pendiente = pitch;
    if (envio.temporizador !== null) return;
    envio.temporizador = setTimeout(() => {
      envio.temporizador = null;
      envio.ultimo = Date.now();
      onCamaraRef.current(envio.pendiente as number);
      envio.pendiente = null;
    }, Math.max(espera, 0));
  }

  function inclinar(delta: number) {
    if (!puedeMoverLaCamara || delta === 0) return;
    ultimoGestoDeCamara.current = Date.now();
    inclinacionExacta.current = recortarInclinacion(inclinacionExacta.current + delta);
    const nueva = acotarInclinacion(inclinacionExacta.current);
    // En el tope no hay nada que mandar: la cámara ya está ahí. Tampoco si el
    // gesto no alcanzó a mover la décima, pero queda sumado para el siguiente.
    if (nueva === inclinacionRef.current) return;
    inclinacionRef.current = nueva;
    setInclinacion(nueva);
    enviarCamara(nueva);
  }

  // Lo que informa el dron manda cuando el operador no está moviendo la cámara:
  // así la vista arranca donde la cámara realmente está y se entera si la
  // movió otro (la app al retomar la patrulla, por ejemplo). Se mira con CADA
  // status que llega, no sólo cuando cambia el número: si la cámara hace tope
  // antes que la consola —la Mini no mira arriba del horizonte sin la opción de
  // DJI Fly—, el dron informa siempre lo mismo, y esperando un cambio el HUD
  // se quedaba para siempre con lo que la consola había supuesto (y la muesca
  // siguiente partía de ahí). La consola crea un objeto por cada status que
  // llega, así que su identidad es la marca de "llegó otro".
  useEffect(() => {
    const informada = status?.gimbalPitch;
    if (typeof informada !== 'number' || !Number.isFinite(informada)) return;
    if (Date.now() - ultimoGestoDeCamara.current < ESPERA_PARA_SINCRONIZAR_MS) return;
    const valor = acotarInclinacion(informada);
    inclinacionRef.current = valor;
    inclinacionExacta.current = valor;
    setInclinacion(valor);
  }, [status]);

  useEffect(() => {
    const envio = envioDeCamara.current;
    return () => {
      if (envio.temporizador !== null) clearTimeout(envio.temporizador);
    };
  }, []);

  /** ¿El gesto cayó sobre la imagen, y no sobre un panel del HUD? */
  function sobreElVideo(destino: EventTarget | null): boolean {
    // Con el puntero capturado, todos los eventos le llegan a la raíz.
    if (destino === raiz.current) return true;
    return destino instanceof Node && !!video.current?.contains(destino);
  }

  function apagarGiroDelMouse() {
    if (decaimiento.current !== null) clearInterval(decaimiento.current);
    decaimiento.current = null;
    setGiroMouse(0);
  }

  /**
   * El giro sale de la VELOCIDAD del mouse, así que cuando el mouse se frena
   * tiene que apagarse solo: no llega ningún evento que diga "se quedó quieto".
   * Se apaga en 150 ms, a la mitad por paso, para que el dron no frene de golpe
   * entre un movimiento y el siguiente.
   */
  function armarDecaimiento() {
    if (decaimiento.current !== null) clearInterval(decaimiento.current);
    let pasos = 0;
    decaimiento.current = setInterval(() => {
      pasos += 1;
      if (pasos >= PASOS_DE_DECAIMIENTO) {
        apagarGiroDelMouse();
        return;
      }
      setGiroMouse((giro) => acotarEje(giro / 2));
    }, PASO_DE_DECAIMIENTO_MS);
  }

  useEffect(() => () => {
    if (decaimiento.current !== null) clearInterval(decaimiento.current);
  }, []);

  // Los manejadores nativos se registran una sola vez y llaman a la versión del
  // render vigente: si se volvieran a registrar con cada render, entre uno y
  // otro se perdería algún evento de la rueda.
  const manejadores = useRef<Manejadores | null>(null);
  manejadores.current = {
    rueda(ev) {
      if (!sobreElVideo(ev.target)) return;
      // Sin esto, la rueda sobre la vista desplaza la página de atrás (cuando
      // no hay pantalla completa) y Ctrl+rueda le cambia el zoom al navegador.
      ev.preventDefault();
      const { pasos, resto } = pasosDeRueda(restoDeRueda.current, muescasDeRueda(ev));
      restoDeRueda.current = resto;
      if (pasos === 0) return;
      // `deltaY` positivo es la rueda hacia el operador: aleja la imagen o baja
      // la cámara.
      if (derechoApretado.current || (ev.buttons & 2) !== 0) {
        setZoom((previo) => ({ ...previo, escala: acotarZoom(previo.escala - pasos * ZOOM_POR_MUESCA) }));
        return;
      }
      inclinar(-pasos * GRADOS_POR_MUESCA);
    },
    movimiento(ev) {
      if (!modoMouse) return;
      // jsdom y algún navegador viejo no traen `movementX`: sin él no hay giro.
      const dx = ev.movementX || 0;
      const dy = ev.movementY || 0;
      if (dx !== 0) {
        setGiroMouse(giroDelMouse(dx));
        armarDecaimiento();
      }
      // Mouse hacia arriba (dy negativo) es mirar más alto, como en un juego.
      if (dy !== 0) inclinar(-dy * GRADOS_POR_PIXEL);
    },
    tecla(ev) {
      if (ev.key !== 'Escape' || hayDialogo) return;
      // Con el teclado bloqueado (pantalla completa en Chromium) el Esc ya no
      // suelta solo la captura del puntero: llega a la página, y es acá donde
      // tiene que soltarla.
      if (document.pointerLockElement === raiz.current) {
        sinFallar(() => document.exitPointerLock());
        return;
      }
      if (ayudaAbierta) cerrarAyuda();
    },
  };

  useEffect(() => {
    const elemento = raiz.current!;
    const alRodar = (ev: WheelEvent) => manejadores.current!.rueda(ev);
    const alMover = (ev: MouseEvent) => manejadores.current!.movimiento(ev);
    const alTeclear = (ev: KeyboardEvent) => manejadores.current!.tecla(ev);
    // `passive: false` es lo que permite el preventDefault: React registra la
    // rueda como pasiva y desde un onWheel no se puede frenar el desplazamiento.
    elemento.addEventListener('wheel', alRodar, { passive: false });
    document.addEventListener('mousemove', alMover);
    window.addEventListener('keydown', alTeclear);

    // El botón derecho se suelta donde sea, incluso fuera de la vista: por eso
    // se lo espera en la ventana. Y si la ventana pierde el foco con el botón
    // apretado, el mouseup no llega nunca.
    const soltarZoom = () => {
      derechoApretado.current = false;
      restoDeRueda.current = 0;
      setZoom(SIN_ZOOM);
    };
    const alSoltarMouse = (ev: MouseEvent) => {
      if (ev.button === 2 && derechoApretado.current) soltarZoom();
    };
    window.addEventListener('mouseup', alSoltarMouse);
    window.addEventListener('blur', soltarZoom);

    const alCambiarCaptura = () => {
      const capturado = document.pointerLockElement === elemento;
      setModoMouse(capturado);
      if (!capturado) apagarGiroDelMouse();
    };
    document.addEventListener('pointerlockchange', alCambiarCaptura);

    const alCambiarPantalla = () => {
      const completa = document.fullscreenElement === elemento;
      setPantallaCompleta(completa);
      const teclado = tecladoDelNavegador();
      if (completa) {
        sinFallar(() =>
          teclado?.lock?.().then(() => {
            // Si mientras el navegador contestaba se salió de la pantalla
            // completa, el bloqueo ya no vale: Ctrl+W vuelve a ser suyo.
            if (document.fullscreenElement === elemento) setTecladoBloqueado(true);
          }),
        );
      } else {
        setTecladoBloqueado(false);
        sinFallar(() => teclado?.unlock?.());
      }
    };
    document.addEventListener('fullscreenchange', alCambiarPantalla);

    return () => {
      elemento.removeEventListener('wheel', alRodar);
      document.removeEventListener('mousemove', alMover);
      window.removeEventListener('keydown', alTeclear);
      window.removeEventListener('mouseup', alSoltarMouse);
      window.removeEventListener('blur', soltarZoom);
      document.removeEventListener('pointerlockchange', alCambiarCaptura);
      document.removeEventListener('fullscreenchange', alCambiarPantalla);
      liberarNavegador(elemento);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al abrir: pantalla completa y el foco adentro. La pantalla completa sale
  // del mismo clic que abrió la vista ("Tomar control manual"); si el navegador
  // la niega igual, la vista ya tapa la pantalla y ofrece el botón.
  useEffect(() => {
    pedirPantallaCompleta();
    raiz.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lo de atrás queda inerte mientras se vuela: el tabulador no puede ir a
  // parar a un botón de la página que no se ve, y un lector de pantalla tampoco.
  // Se apaga lo que había al abrir; los diálogos que se abran después se montan
  // al final del body y quedan vivos.
  useEffect(() => {
    const elemento = raiz.current!;
    const apagados = [...document.body.children].filter((hijo) => hijo !== elemento && !hijo.hasAttribute('inert'));
    for (const hijo of apagados) hijo.setAttribute('inert', '');
    return () => {
      for (const hijo of apagados) hijo.removeAttribute('inert');
    };
  }, []);

  // Al cerrarse, el foco vuelve a lo que lo tenía antes de abrir, como en los
  // diálogos (Modal.tsx): sin esto caía en el body, y con el teclado había que
  // empezar a tabular de nuevo desde arriba de la página. Si eso ya no está (o
  // no había nada enfocado), el detalle dice adónde. Va DESPUÉS del efecto de
  // `inert` a propósito: las limpiezas corren en el orden en que se declaran, y
  // mientras lo de atrás siga inerte el navegador no le da el foco a nada.
  useEffect(
    () => () => {
      if (focoPrevio instanceof HTMLElement && focoPrevio !== document.body && focoPrevio.isConnected) {
        focoPrevio.focus();
      } else {
        onDevolverFocoRef.current();
      }
    },
    [focoPrevio],
  );

  // Con un diálogo encima hace falta el cursor para contestarlo.
  useEffect(() => {
    if (hayDialogo && document.pointerLockElement === raiz.current) sinFallar(() => document.exitPointerLock());
  }, [hayDialogo]);

  function pedirPantallaCompleta() {
    const elemento = raiz.current;
    if (elemento && typeof elemento.requestFullscreen === 'function') sinFallar(() => elemento.requestFullscreen());
  }

  function entrarAlModoMouse() {
    setAvisoDelNavegador('');
    const elemento = raiz.current;
    if (!elemento || typeof elemento.requestPointerLock !== 'function') {
      setAvisoDelNavegador('Este navegador no permite esconder el cursor: el modo mouse no está disponible.');
      return;
    }
    try {
      const pedido: unknown = elemento.requestPointerLock();
      if (pedido instanceof Promise) {
        pedido.catch(() =>
          setAvisoDelNavegador('El navegador no dejó esconder el cursor. Probá de nuevo en un momento.'),
        );
      }
    } catch {
      setAvisoDelNavegador('El navegador no dejó esconder el cursor. Probá de nuevo en un momento.');
    }
  }

  function alApretarMouse(ev: React.MouseEvent) {
    if (ev.button !== 2 || !sobreElVideo(ev.target)) return;
    ev.preventDefault();
    derechoApretado.current = true;
    setZoom({ escala: ZOOM_AL_APRETAR, ...origenDelZoom(ev.clientX, ev.clientY) });
  }

  /**
   * Dónde se clava el zoom, en % de la imagen: el punto bajo el cursor queda
   * quieto y lo de alrededor se agranda. En el modo mouse no hay cursor, así
   * que va al centro, que es donde mira el operador.
   */
  function origenDelZoom(x: number, y: number): { x: number; y: number } {
    const caja = video.current?.getBoundingClientRect();
    if (document.pointerLockElement === raiz.current || !caja || caja.width === 0 || caja.height === 0) {
      return { x: 50, y: 50 };
    }
    const porcentaje = (valor: number) => Math.round(Math.min(100, Math.max(0, valor)) * 10) / 10;
    return {
      x: porcentaje(((x - caja.left) / caja.width) * 100),
      y: porcentaje(((y - caja.top) / caja.height) * 100),
    };
  }

  function cerrarAyuda() {
    setAyudaAbierta(false);
    botonAyuda.current?.focus();
  }

  function salir() {
    setConfirmandoSalida(false);
    liberarNavegador(raiz.current);
    onSalir();
  }

  function cerrarSinSoltar() {
    setConfirmandoSalida(false);
    liberarNavegador(raiz.current);
    onCerrar();
  }

  const nuevasAlertas = alertas.filter((a) => a.drone_id === droneId && a.status === 'PENDING' && a.id > umbralDeAlertas);
  const ultimaAlerta = nuevasAlertas.reduce<Alert | null>((ultima, a) => (!ultima || a.id > ultima.id ? a : ultima), null);

  const vista = (
    <section
      ref={raiz}
      className={`pilotaje${modoMouse ? ' pilotaje-modo-mouse' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Pilotaje de ${nombre}`}
      tabIndex={-1}
      onMouseDown={alApretarMouse}
      // El menú contextual taparía la imagen justo cuando el derecho pide zoom.
      onContextMenu={(ev) => ev.preventDefault()}
    >
      <div className="pilotaje-video" ref={video} data-testid="pilotaje-video">
        <div
          className="pilotaje-encuadre"
          data-testid="pilotaje-encuadre"
          style={{ transform: `scale(${zoom.escala})`, transformOrigin: `${zoom.x}% ${zoom.y}%` }}
        >
          {frame ? (
            <img
              className="pilotaje-imagen"
              src={`data:image/jpeg;base64,${frame}`}
              alt={`Cámara de ${nombre}`}
              draggable={false}
            />
          ) : (
            <div className="pilotaje-sin-senal">Sin señal de video</div>
          )}
        </div>
      </div>

      <div className="pilotaje-capa">
        <div className="pilotaje-izquierda">
          <button type="button" className="dismiss" onClick={() => setConfirmandoSalida(true)}>
            Salir del control manual
          </button>
          <Minimapa posicion={posicionDelDron(status)} rumbo={status?.heading} />
        </div>

        <div className="pilotaje-centro">
          <dl className="pilotaje-lecturas pilotaje-panel" aria-label="Lecturas del vuelo">
            <div>
              <dt className="etiqueta">Velocidad</dt>
              <dd data-testid="hud-velocidad">{rapido ? 'Rápido' : 'Normal'}</dd>
            </div>
            <div>
              <dt className="etiqueta">Altura</dt>
              <dd data-testid="hud-altura">{textoDeAltura(status?.alt)}</dd>
            </div>
            <div>
              <dt className="etiqueta">Batería</dt>
              <dd data-testid="hud-bateria">{status ? `${status.battery.toFixed(0)} %` : '—'}</dd>
            </div>
            <div>
              <dt className="etiqueta">Rumbo</dt>
              <dd data-testid="hud-rumbo">{rumbo(status?.heading)}</dd>
            </div>
            <div>
              <dt className="etiqueta">Cámara</dt>
              <dd data-testid="hud-camara">{textoDeInclinacion(inclinacion)}</dd>
            </div>
            <div>
              <dt className="etiqueta">Zoom</dt>
              <dd data-testid="hud-zoom">{textoDeZoom(zoom.escala)}</dd>
            </div>
          </dl>

          {/* Los avisos van en orden de gravedad: primero una orden que el
              backend rechazó, después lo que hace que el mando no responda y
              al final lo que es una espera. */}
          {error && (
            <p className="aviso malo" role="alert" data-testid="pilotaje-error">
              {error}
            </p>
          )}
          {!controlTomado && (
            <p className="aviso" role="status" data-testid="pilotaje-esperando-control">
              {ESPERANDO_EL_CONTROL}
            </p>
          )}
          {controlTomado && impedimento && (
            <p className="aviso" role="status" data-testid="pilotaje-impedimento">
              {impedimento}
            </p>
          )}
          {!ultimoSalio && (
            <p className="aviso malo" role="alert" data-testid="pilotaje-no-salio">
              El último comando no salió de la consola: se cortó el enlace con el Comando Central. Hasta que la app
              corte sola (1,5 s), el dron sigue con la última velocidad que le llegó.
            </p>
          )}
          {controlTomado && esperandoConfirmacion && (
            <p className="aviso" role="status" data-testid="pilotaje-esperando">
              El dron todavía no confirmó el vuelo manual (su telemetría llega cada ~1 s): el mando ya emite, pero
              hasta la confirmación puede descartar los ejes.
            </p>
          )}
          {avisoDeOrden && (
            <p className="aviso" role="status" data-testid="pilotaje-orden-en-curso">
              {avisoDeOrden}
            </p>
          )}
          {ultimaAlerta && (
            <p className="aviso pilotaje-alerta" role="status" data-testid="pilotaje-alerta-nueva">
              {nuevasAlertas.length === 1
                ? `Nueva alerta sin decidir: ${tipoDeObjetivo(ultimaAlerta.type)}.`
                : `${nuevasAlertas.length} alertas nuevas sin decidir; la última, ${tipoDeObjetivo(ultimaAlerta.type)}.`}{' '}
              Se deciden en el detalle del dron, al salir de esta vista.{' '}
              <button type="button" className="ghost chico" onClick={() => setUmbralDeAlertas(ultimaAlerta.id)}>
                Entendido
              </button>
            </p>
          )}
          {avisoDelNavegador && (
            <p className="aviso" role="status" data-testid="pilotaje-aviso-navegador">
              {avisoDelNavegador}
            </p>
          )}
          {modoMouse && (
            <p className="pilotaje-pista" data-testid="pilotaje-pista-mouse">
              <kbd>Esc</kbd> para salir del modo mouse
            </p>
          )}
        </div>

        <div className="pilotaje-derecha">
          {!pantallaCompleta && (
            <button type="button" onClick={pedirPantallaCompleta}>
              Pantalla completa
            </button>
          )}
          <button
            ref={botonAyuda}
            type="button"
            className="icono-boton pilotaje-boton-ayuda"
            aria-label="Ayuda de los controles"
            aria-expanded={ayudaAbierta}
            aria-controls={ayudaAbierta ? idAyuda : undefined}
            onClick={() => (ayudaAbierta ? cerrarAyuda() : setAyudaAbierta(true))}
          >
            ?
          </button>
          {ayudaAbierta && <AyudaDeControles id={idAyuda} onCerrar={cerrarAyuda} />}
        </div>

        <div className="pilotaje-pie">
          {sticksVisibles && (
            <div className="pilotaje-sticks pilotaje-panel" id={idSticks}>
              {/* Su propio teclado se apaga: acá el teclado vuela con el
                  esquema de la vista (W adelante), y el del mando (W sube)
                  mandaría el dron para otro lado con la misma tecla. Y no
                  emite: informa sus ejes, que salen sumados a los del teclado
                  y el mouse por el emisor de la vista. */}
              <MandoVirtual
                onEjes={setEjesDeSticks}
                impedimento={controlTomado ? impedimento : ESPERANDO_EL_CONTROL}
                teclado={false}
              />
            </div>
          )}
          <div className="pilotaje-acciones">
            {/* Despegar va acá adentro y no sólo en la tarjeta: en el suelo la
                app descarta las palancas, así que sin este botón la vista de
                pilotaje no podría hacer nada con el dron apoyado. */}
            {enElSuelo && (
              <button
                type="button"
                className="primario"
                onClick={() => onOrden('despegar')}
                disabled={!enLinea || !controlTomado}
              >
                Despegar
              </button>
            )}
            {enElAire && (
              <button
                type="button"
                className="dismiss"
                onClick={() => onOrden('aterrizar')}
                disabled={!enLinea || !controlTomado}
              >
                Aterrizar
              </button>
            )}
            <button type="button" onClick={entrarAlModoMouse} disabled={!controlTomado} aria-pressed={modoMouse}>
              Modo mouse
            </button>
            <button
              type="button"
              onClick={() => setSticksVisibles((visibles) => !visibles)}
              aria-expanded={sticksVisibles}
              aria-controls={sticksVisibles ? idSticks : undefined}
            >
              {sticksVisibles ? 'Ocultar sticks virtuales' : 'Mostrar sticks virtuales'}
            </button>
          </div>
        </div>
      </div>

      {confirmandoSalida && (
        <Modal etiquetadoPor={idSalida} descritoPor={idSalidaTexto} onCerrar={() => setConfirmandoSalida(false)}>
          <header className="modal-cabecera">
            <h2 className="modal-titulo" id={idSalida}>
              ¿Salir del control manual?
            </h2>
          </header>
          <div className="modal-cuerpo">
            <p id={idSalidaTexto}>
              {hayObjetivo
                ? 'Se suelta el control y el dron vuelve al objetivo que estaba siguiendo.'
                : 'Se suelta el control y el dron vuelve a patrullar, hacia el próximo nodo de su ruta.'}
            </p>
            <p className="muted">
              Si sólo querés mirar el resto del detalle, cerrá la vista: el control sigue siendo tuyo y el dron queda
              en vuelo estacionario.
            </p>
          </div>
          <footer className="modal-pie">
            <button type="button" className="ghost" onClick={() => setConfirmandoSalida(false)}>
              Seguir piloteando
            </button>
            <button type="button" onClick={cerrarSinSoltar}>
              Cerrar la vista sin soltar
            </button>
            <button type="button" className="resume" onClick={salir}>
              Salir del control manual
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );

  return createPortal(vista, document.body);
}
