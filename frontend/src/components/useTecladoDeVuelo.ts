import { useEffect, useMemo, useRef, useState } from 'react';
import { acotarEje } from '../pilotaje';
import { EJES_EN_CERO, type Ejes } from './MandoVirtual';

/**
 * El teclado de la vista de pilotaje, como en un videojuego: W/S avanza y
 * retrocede, A/D se desplaza de costado, Q/E gira, Espacio sube y Ctrl (o C)
 * baja. No es el esquema del mando virtual (ahí W sube): el mando imita las dos
 * palancas de un control físico y la vista de pilotaje imita un juego en
 * primera persona, que es lo que la mano de cualquiera ya sabe hacer.
 *
 * La parte que decide qué eje vale cuánto es pura —recibe un estado y devuelve
 * otro— y está separada del hook a propósito: la regla de "manda la última
 * tecla apretada" tiene sus vueltas y se prueba sin montar nada.
 */

export type EjeDeVuelo = keyof Ejes;

/** Velocidad por defecto: la mitad del recorrido de la palanca. */
export const VELOCIDAD_NORMAL = 0.5;
/** Con Shift sostenido, a fondo. */
export const VELOCIDAD_RAPIDA = 1;

/**
 * 10 Hz, el mismo ritmo que el mando virtual: la app corta el vuelo sola si
 * pasa 1,5 s sin recibir nada, y más rápido sólo inunda el enlace.
 */
const INTERVALO_MS = 100;

type Tecla = { eje: EjeDeVuelo; sentido: 1 | -1 };

/**
 * Qué mueve cada tecla. Va por `KeyboardEvent.code`, que es la POSICIÓN de la
 * tecla y no la letra: en un teclado AZERTY la W física sigue siendo la de
 * avanzar, y Mayúsculas o Bloq Mayús no cambian nada.
 *
 * La C está porque Ctrl no siempre se puede usar: sin Keyboard Lock (Firefox,
 * Safari, o Chromium fuera de pantalla completa) el navegador se queda con
 * Ctrl+W y cierra la pestaña en pleno vuelo si se baja mientras se avanza.
 */
export const TECLAS_DE_VUELO: Readonly<Record<string, Tecla | undefined>> = {
  KeyW: { eje: 'pitch', sentido: 1 },
  KeyS: { eje: 'pitch', sentido: -1 },
  KeyA: { eje: 'roll', sentido: -1 },
  KeyD: { eje: 'roll', sentido: 1 },
  KeyQ: { eje: 'yaw', sentido: -1 },
  KeyE: { eje: 'yaw', sentido: 1 },
  Space: { eje: 'throttle', sentido: 1 },
  ControlLeft: { eje: 'throttle', sentido: -1 },
  ControlRight: { eje: 'throttle', sentido: -1 },
  KeyC: { eje: 'throttle', sentido: -1 },
};

/** Las dos Shift: mientras alguna esté sostenida se vuela a fondo. */
export const TECLAS_RAPIDAS: readonly string[] = ['ShiftLeft', 'ShiftRight'];

/**
 * Las teclas sostenidas. Cada eje guarda las suyas EN EL ORDEN en que se
 * apretaron, y manda la última: con A sostenida y D apretada encima el dron va
 * a la derecha, y al soltar D vuelve a la izquierda sin tener que levantar y
 * volver a apretar A. Sumarlas, como hace el mando virtual, anularía las dos y
 * el dron se quedaría quieto con el operador apretando dos teclas.
 */
export interface TeclasSostenidas {
  pilas: Readonly<Record<EjeDeVuelo, readonly string[]>>;
  rapidas: readonly string[];
}

export const NINGUNA_TECLA: TeclasSostenidas = {
  pilas: { pitch: [], roll: [], yaw: [], throttle: [] },
  rapidas: [],
};

/** Si la vista de pilotaje se queda con esta tecla (y le corta el efecto al navegador). */
export function esTeclaDeVuelo(code: string): boolean {
  return TECLAS_DE_VUELO[code] !== undefined || TECLAS_RAPIDAS.includes(code);
}

/**
 * Suma una tecla a las sostenidas. Devuelve el MISMO estado si no cambió nada
 * —una tecla que no es de vuelo, o la repetición automática de una que ya
 * estaba—: así React no vuelve a renderizar 30 veces por segundo mientras se
 * mantiene apretada una tecla, y la repetición no la manda al tope de la pila
 * por delante de otra que se apretó después.
 */
export function apretarTecla(estado: TeclasSostenidas, code: string): TeclasSostenidas {
  if (TECLAS_RAPIDAS.includes(code)) {
    return estado.rapidas.includes(code) ? estado : { ...estado, rapidas: [...estado.rapidas, code] };
  }
  const tecla = TECLAS_DE_VUELO[code];
  if (!tecla) return estado;
  const pila = estado.pilas[tecla.eje];
  if (pila.includes(code)) return estado;
  return { ...estado, pilas: { ...estado.pilas, [tecla.eje]: [...pila, code] } };
}

/** Saca una tecla de las sostenidas; si no estaba, devuelve el mismo estado. */
export function soltarTecla(estado: TeclasSostenidas, code: string): TeclasSostenidas {
  if (TECLAS_RAPIDAS.includes(code)) {
    return estado.rapidas.includes(code)
      ? { ...estado, rapidas: estado.rapidas.filter((c) => c !== code) }
      : estado;
  }
  const tecla = TECLAS_DE_VUELO[code];
  if (!tecla || !estado.pilas[tecla.eje].includes(code)) return estado;
  return {
    ...estado,
    pilas: { ...estado.pilas, [tecla.eje]: estado.pilas[tecla.eje].filter((c) => c !== code) },
  };
}

export function esRapido(estado: TeclasSostenidas): boolean {
  return estado.rapidas.length > 0;
}

/** Los ejes que piden las teclas sostenidas: la última de cada eje, a la velocidad elegida. */
export function ejesDeTeclas(estado: TeclasSostenidas): Ejes {
  const magnitud = esRapido(estado) ? VELOCIDAD_RAPIDA : VELOCIDAD_NORMAL;
  const valor = (eje: EjeDeVuelo): number => {
    const pila = estado.pilas[eje];
    const ultima = pila.length > 0 ? TECLAS_DE_VUELO[pila[pila.length - 1]] : undefined;
    return ultima ? ultima.sentido * magnitud : 0;
  };
  return { pitch: valor('pitch'), roll: valor('roll'), yaw: valor('yaw'), throttle: valor('throttle') };
}

/** ¿Hay algo comandado? */
function hayComando(ejes: Ejes): boolean {
  return ejes.pitch !== 0 || ejes.roll !== 0 || ejes.yaw !== 0 || ejes.throttle !== 0;
}

/**
 * El teclado de vuelo de la vista de pilotaje: escucha la ventana mientras
 * `activo`, y emite por `onMando` a 10 Hz mientras haya algún eje comandado,
 * con un último mensaje en cero al soltar (la misma semántica que el mando
 * virtual: el dron queda en vuelo estacionario).
 *
 * `giroExtra` es el giro que pide el mouse en el modo mouse. Se suma al de Q/E
 * y sale por el MISMO emisor: dos emisores a 10 Hz intercalando mensajes harían
 * que el dron reciba un giro sí y otro no.
 */
export function useTecladoDeVuelo({
  activo,
  inerte,
  onMando,
  giroExtra = 0,
}: {
  /** Si escucha el teclado: la vista abierta, el control tomado y ningún diálogo encima. */
  activo: boolean;
  /**
   * El mando no puede comandar (ver `impedimentoDelMando` en DroneDetail): los
   * ejes van en cero. Las teclas se siguen atajando igual, para que Espacio no
   * termine apretando el botón que tenga el foco.
   */
  inerte: boolean;
  onMando: (ejes: Ejes) => boolean;
  giroExtra?: number;
}) {
  const [teclas, setTeclas] = useState<TeclasSostenidas>(NINGUNA_TECLA);
  // Lo mismo que en el mando virtual: `onMando` devuelve false con el canal con
  // el Comando Central cerrado, y el operador tiene que saber que el dron sigue
  // con la última velocidad que le llegó.
  const [ultimoSalio, setUltimoSalio] = useState(true);

  useEffect(() => {
    if (!activo) return;
    const alApretar = (ev: KeyboardEvent) => {
      if (!esTeclaDeVuelo(ev.code)) return;
      // Sin esto Espacio desplaza la página o aprieta el botón enfocado, y
      // Ctrl+D abre el diálogo de favoritos en pleno vuelo.
      ev.preventDefault();
      setTeclas((previas) => apretarTecla(previas, ev.code));
    };
    const alSoltar = (ev: KeyboardEvent) => {
      if (!esTeclaDeVuelo(ev.code)) return;
      // Un botón se activa con Espacio al SOLTAR la tecla: si sólo se atajara
      // el keydown, cada subida terminaría apretando el botón con el foco.
      ev.preventDefault();
      setTeclas((previas) => soltarTecla(previas, ev.code));
    };
    // Si la ventana pierde el foco con una tecla apretada, el keyup se lo lleva
    // otra aplicación y el eje queda clavado: el dron seguiría subiendo con el
    // operador mirando otra cosa.
    const soltarTodas = () => setTeclas(NINGUNA_TECLA);
    const alCambiarVisibilidad = () => {
      if (document.visibilityState === 'hidden') soltarTodas();
    };
    window.addEventListener('keydown', alApretar);
    window.addEventListener('keyup', alSoltar);
    window.addEventListener('blur', soltarTodas);
    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    return () => {
      window.removeEventListener('keydown', alApretar);
      window.removeEventListener('keyup', alSoltar);
      window.removeEventListener('blur', soltarTodas);
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
      // Dejar de escuchar con teclas sostenidas las dejaría clavadas: nadie va
      // a recibir su keyup.
      soltarTodas();
    };
  }, [activo]);

  // Cuando aparece o se levanta un impedimento, lo sostenido se olvida: si el
  // dron termina de despegar con el operador apretando W "a ver si anda", no
  // puede salir disparado hacia adelante sin que nadie lo vuelva a pedir. Se
  // ajusta en el mismo render y no en un efecto: con un efecto, el render del
  // cambio alcanzaba a comprometerse con W adentro y el emisor mandaba un
  // mensaje de avance antes de que el reinicio llegara.
  const [inerteAnterior, setInerteAnterior] = useState(inerte);
  if (inerteAnterior !== inerte) {
    setInerteAnterior(inerte);
    setTeclas(NINGUNA_TECLA);
    // El aviso de "no salió" describía el corte que causó el impedimento; con
    // el impedimento levantado, el watchdog de la app ya frenó al dron.
    if (!inerte) setUltimoSalio(true);
  }

  const ejes = useMemo<Ejes>(() => {
    // Sin escuchar tampoco se comanda: el giro del mouse llega por `giroExtra`
    // y no puede seguir saliendo con un diálogo abierto encima del video.
    if (inerte || !activo) return EJES_EN_CERO;
    const delTeclado = ejesDeTeclas(teclas);
    return { ...delTeclado, yaw: acotarEje(delTeclado.yaw + giroExtra) };
  }, [teclas, inerte, activo, giroExtra]);

  // Los ejes y el callback se leen de refs dentro del temporizador: si fueran
  // dependencias del efecto, cada cambio lo reiniciaría y se emitiría al ritmo
  // del teclado o del mouse en vez de a 10 Hz.
  const ejesRef = useRef(ejes);
  ejesRef.current = ejes;
  const onMandoRef = useRef(onMando);
  onMandoRef.current = onMando;

  const comandando = hayComando(ejes);

  useEffect(() => {
    if (!comandando) return;
    const emitir = (aEmitir: Ejes) => setUltimoSalio(onMandoRef.current(aEmitir));
    // El primero sale en el acto: esperar al tick haría arrancar al dron hasta
    // 100 ms tarde.
    emitir(ejesRef.current);
    const id = setInterval(() => emitir(ejesRef.current), INTERVALO_MS);
    return () => {
      clearInterval(id);
      // Un único cero al soltar, también al cerrar la vista: salir no puede
      // dejar al dron yéndose de largo.
      emitir(EJES_EN_CERO);
    };
  }, [comandando]);

  return { ejes, rapido: esRapido(teclas), ultimoSalio };
}
