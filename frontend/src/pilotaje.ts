/**
 * Las cuentas de la vista de pilotaje que no dependen de React: cuánto se
 * inclina la cámara con cada muesca de la rueda, cuánto zoom da el botón
 * derecho, cuánto gira el dron con el mouse. Viven acá y no adentro del
 * componente porque son las que hay que poder probar número por número: un
 * signo dado vuelta acá es una cámara que mira al cielo cuando el operador
 * quería mirar abajo.
 */

/**
 * El rango de la cámara que acepta el contrato (`manual_gimbal`, §2 de
 * docs/PROTOCOLS.md): 0 es el horizonte, negativo es mirar hacia abajo. El
 * backend y la app recortan igual, pero si la consola no recortara, el número
 * en pantalla seguiría subiendo con la rueda mientras la cámara ya hizo tope.
 */
export const INCLINACION_MINIMA = -90;
export const INCLINACION_MAXIMA = 30;

/**
 * Lo que se supone mientras el dron no informa la inclinación: una app vieja no
 * manda `gimbalPitch`, y -30° es la posición con la que la app deja la cámara
 * para patrullar (mirando al frente y un poco abajo).
 */
export const INCLINACION_POR_DEFECTO = -30;

/** Cuánto inclina la cámara cada muesca de la rueda del mouse. */
export const GRADOS_POR_MUESCA = 5;

/**
 * Cuánto inclina la cámara cada píxel de movimiento vertical en el modo mouse.
 * Con 0,15 °/px, cruzar media pantalla (unos 500 px) mueve la cámara 75°: se
 * puede ir del horizonte al suelo en un gesto, sin que un temblor de la mano
 * mueva la imagen.
 */
export const GRADOS_POR_PIXEL = 0.15;

/** El zoom digital del botón derecho: arranca en 2× y la rueda lo lleva de 1× a 8×. */
export const ZOOM_SIN_AUMENTO = 1;
export const ZOOM_AL_APRETAR = 2;
export const ZOOM_MAXIMO = 8;
export const ZOOM_POR_MUESCA = 0.5;

/**
 * Píxeles de movimiento horizontal, en un solo evento, que equivalen a girar a
 * fondo. Chromium entrega `mousemove` a ~60 Hz, así que 25 px por evento son
 * unos 1500 px/s: un gesto rápido pero cómodo. Más bajo, el dron giraría a
 * fondo con cualquier roce del mouse.
 */
export const PIXELES_PARA_GIRO_A_FONDO = 25;

/**
 * Zona muerta de los ejes: la MISMA que la del mando virtual y la de la app del
 * celular (0,05). Un eje por debajo de esto el dron no lo ejecuta, así que la
 * consola tampoco lo emite (ver `acotar` en MandoVirtual.tsx).
 */
const ZONA_MUERTA = 0.05;

/** Recorta un número a un rango. */
function recortar(valor: number, minimo: number, maximo: number): number {
  return Math.min(maximo, Math.max(minimo, valor));
}

/**
 * Normaliza un eje de vuelo: [-1, 1], dos decimales y zona muerta, en ese
 * orden y con el mismo criterio que el mando virtual.
 */
export function acotarEje(valor: number): number {
  const recortado = Math.round(recortar(valor, -1, 1) * 100) / 100;
  return Math.abs(recortado) < ZONA_MUERTA ? 0 : recortado;
}

/**
 * La inclinación dentro del rango del contrato, SIN redondear: es la cuenta
 * que lleva el modo mouse, que suma 0,15° por píxel. Redondear cada paso a
 * 0,1° hacía que un píxel para arriba sumara 0,2° y uno para abajo restara
 * 0,1° (`Math.round` lleva el ,5 siempre hacia arriba), y la cámara se iba
 * subiendo sola con el pulso de la mano.
 */
export function recortarInclinacion(grados: number): number {
  return recortar(grados, INCLINACION_MINIMA, INCLINACION_MAXIMA);
}

/**
 * La inclinación dentro del rango del contrato, con un decimal: la cámara no
 * distingue menos que eso, y un número con quince decimales en el HUD no le
 * dice nada a nadie. Es lo que se muestra y lo que se manda, nunca lo que se
 * acumula (ver `recortarInclinacion`).
 */
export function acotarInclinacion(grados: number): number {
  return Math.round(recortarInclinacion(grados) * 10) / 10;
}

export function acotarZoom(escala: number): number {
  return Math.round(recortar(escala, ZOOM_SIN_AUMENTO, ZOOM_MAXIMO) * 100) / 100;
}

/** Lo que mide una muesca en cada `deltaMode` del evento de rueda. */
const TAMANO_DE_MUESCA: Record<number, number> = {
  0: 100, // DOM_DELTA_PIXEL: Chromium y Firefox modernos, ~100 px por muesca
  1: 3, // DOM_DELTA_LINE: Firefox con mouse, 3 líneas por muesca
  2: 1, // DOM_DELTA_PAGE: una página entera ya es un gesto
};

/**
 * El evento de rueda llevado a muescas: positivo es la rueda hacia abajo (hacia
 * el operador), negativo hacia arriba, como `deltaY`.
 */
export function muescasDeRueda(ev: { deltaY: number; deltaMode: number }): number {
  return ev.deltaY / (TAMANO_DE_MUESCA[ev.deltaMode] ?? TAMANO_DE_MUESCA[0]);
}

/**
 * Cuántos pasos enteros dar con este evento de rueda, y lo que sobra para el
 * siguiente.
 *
 * Un mouse entrega una muesca por evento, pero su tamaño varía con el sistema
 * (100 px, 120 px con la pantalla escalada al 125 %): eso se redondea a una
 * muesca y no se arrastra resto, o cuatro muescas de 125 px darían cinco pasos.
 * Un touchpad, en cambio, manda decenas de eventos de pocos píxeles: esos se
 * acumulan hasta completar una muesca, o la cámara se iría a tope con apenas
 * apoyar los dedos.
 */
export function pasosDeRueda(resto: number, muescas: number): { pasos: number; resto: number } {
  if (Math.abs(muescas) >= 0.5) {
    return { pasos: Math.sign(muescas) * Math.max(1, Math.round(Math.abs(muescas))), resto: 0 };
  }
  const total = resto + muescas;
  const pasos = Math.trunc(total);
  return { pasos, resto: total - pasos };
}

/** El giro que pide el mouse en el modo mouse: proporcional a su velocidad. */
export function giroDelMouse(movimientoX: number): number {
  return acotarEje(movimientoX / PIXELES_PARA_GIRO_A_FONDO);
}

/** "-30°": la inclinación de la cámara como se lee en el HUD. */
export function textoDeInclinacion(grados: number): string {
  return `${Math.round(grados)}°`;
}

/** "2×", "2,5×": el zoom con coma decimal, como se escribe acá. */
export function textoDeZoom(escala: number): string {
  return `${String(Math.round(escala * 10) / 10).replace('.', ',')}×`;
}

/** "12.3 m", o "—" si la app no informa la altura (una app vieja no la manda). */
export function textoDeAltura(altura: number | undefined): string {
  return typeof altura === 'number' && Number.isFinite(altura) ? `${altura.toFixed(1)} m` : '—';
}
