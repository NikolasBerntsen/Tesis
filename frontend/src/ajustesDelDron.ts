import type { Drone } from './types';

/**
 * Los ajustes de un dron (VUELO §10): tres datos del dron y no de un vuelo, que
 * la consola fija desde la tarjeta «Ajustes del dron» y la app aplica. El hub
 * los guarda con el activo y la ficha los trae; `null` es «el de fábrica de la
 * app».
 *
 * Los rangos, los pasos, los valores de fábrica y los rótulos son los de
 * docs/contrato/ajustes.json, los mismos con que valida el backend y recorta la
 * app: ajustesDelDron.test.ts los compara con el archivo, así que si uno cambia
 * cambian juntos el documento, el archivo y las tres puntas. No se importa el
 * JSON desde acá a propósito: la imagen de producción se arma copiando sólo
 * `frontend/` (Dockerfile de la raíz), y un import de `../../docs` dejaría el
 * build sin el archivo.
 */

/** Qué hace el dron con un objetivo confirmado, y mientras lo tenga (VUELO §5). */
export type ReaccionADeteccion = 'seguir_y_orbitar' | 'orbitar' | 'seguir' | 'detenerse';

export const REACCIONES: readonly ReaccionADeteccion[] = ['seguir_y_orbitar', 'orbitar', 'seguir', 'detenerse'];

/** Las tres con las que el dron se mueve hacia el objetivo: las que ofrece el interruptor prendido. */
export const REACCIONES_QUE_SIGUEN: readonly ReaccionADeteccion[] = ['seguir_y_orbitar', 'orbitar', 'seguir'];

/** Los rótulos del contrato (`rotulos` en ajustes.json): se leen igual en el backend y en la app. */
export const ROTULO_DE_REACCION: Readonly<Record<ReaccionADeteccion, string>> = {
  seguir_y_orbitar: 'Seguimiento y órbita',
  orbitar: 'Órbita en el lugar',
  seguir: 'Seguimiento',
  detenerse: 'Detenerse y vigilar',
};

/** Una línea por reacción, de la tabla de VUELO §5: qué hace al confirmar y si el objetivo se mueve. */
export const AYUDA_DE_REACCION: Readonly<Record<ReaccionADeteccion, string>> = {
  seguir_y_orbitar: 'Orbita al objetivo a 30 m; si se mueve lo sigue a 25 m y, cuando se detiene, vuelve a orbitarlo.',
  orbitar: 'Orbita el lugar de la detección con el centro fijo: si el objetivo se va, no lo sigue.',
  seguir: 'Se pone a 25 m del objetivo y se queda ahí, quieto o siguiéndolo; nunca orbita.',
  detenerse: 'Se detiene donde está, lo vigila con la cámara y avisa.',
};

export type RangoDeAjuste = Readonly<{ minimo: number; maximo: number; paso: number; porDefecto: number }>;

/**
 * La velocidad tangencial de la órbita (ya existía): menos de 1 m/s es quedarse
 * quieto sobre el círculo y más que el crucero no tiene sentido.
 */
export const RANGO_DE_ORBITA: RangoDeAjuste = { minimo: 1, maximo: 8, paso: 0.5, porDefecto: 4 };

/**
 * El silencio al retomar (VUELO §6): cuánto no se detiene por otra detección
 * después de dejar un objetivo. De a 5 s; con 0 no hay silencio.
 */
export const RANGO_DE_SILENCIO: RangoDeAjuste = { minimo: 0, maximo: 30, paso: 5, porDefecto: 15 };

export interface AjustesDelDron {
  velocidadOrbitaMs: number;
  reaccionADeteccion: ReaccionADeteccion;
  silencioAlRetomarS: number;
}

export type ClaveDeAjuste = keyof AjustesDelDron;

/** Lo que vale `null` en cada campo: lo de fábrica de la app. */
export const AJUSTES_DE_FABRICA: Readonly<AjustesDelDron> = Object.freeze({
  velocidadOrbitaMs: RANGO_DE_ORBITA.porDefecto,
  reaccionADeteccion: 'seguir_y_orbitar',
  silencioAlRetomarS: RANGO_DE_SILENCIO.porDefecto,
});

/** El cuerpo del `PATCH /api/drones/:droneId/ajustes`: cada campo que viene, o `null` para volver al de fábrica. */
export type CambioDeAjustes = { [C in ClaveDeAjuste]?: AjustesDelDron[C] | null };

export function esReaccion(valor: unknown): valor is ReaccionADeteccion {
  return typeof valor === 'string' && (REACCIONES as readonly string[]).includes(valor);
}

/** "4,0 m/s": con coma y un decimal, como se escribe acá. */
export function textoDeVelocidad(metrosPorSegundo: number): string {
  return `${metrosPorSegundo.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m/s`;
}

/** "15 s", o "Sin silencio" con cero: no hay un «0 s» que alguien tenga que interpretar. */
export function textoDeSilencio(segundos: number): string {
  return segundos <= 0 ? 'Sin silencio' : `${segundos} s`;
}

/**
 * Lo que guarda la ficha de un campo, con el valor de fábrica en lugar del
 * `null` y en lugar de lo que falta (la ficha de un hub viejo). Un valor que no
 * es del contrato se trata como de fábrica: nada de lo que muestre la consola
 * puede salir de un dato que la app no sabría aplicar.
 */
export function ajusteDelDron<C extends ClaveDeAjuste>(drone: Pick<Drone, ClaveDeAjuste> | null | undefined, clave: C): AjustesDelDron[C] {
  const crudo = drone?.[clave];
  if (clave === 'reaccionADeteccion') {
    return (esReaccion(crudo) ? crudo : AJUSTES_DE_FABRICA.reaccionADeteccion) as AjustesDelDron[C];
  }
  return (typeof crudo === 'number' && Number.isFinite(crudo) ? crudo : AJUSTES_DE_FABRICA[clave]) as AjustesDelDron[C];
}

/**
 * Si la ficha trae el campo (aunque sea `null`): un hub viejo no manda ni la
 * reacción ni el silencio, y ahí la consola no puede decir qué va a hacer el
 * dron ni cuánto va a callar.
 */
export function fichaConAjuste(drone: Pick<Drone, ClaveDeAjuste> | null | undefined, clave: ClaveDeAjuste): boolean {
  return drone !== null && drone !== undefined && drone[clave] !== undefined;
}

/** Cómo sigue el dron sobre el objetivo después de validar, según su reacción (VUELO §5). */
const AL_VALIDAR: Readonly<Record<ReaccionADeteccion, string>> = {
  seguir_y_orbitar: 'lo orbita y, si se mueve, lo sigue',
  orbitar: 'sigue orbitando el lugar',
  seguir: 'sigue a 25 m del objetivo',
  detenerse: 'lo sigue vigilando desde donde está',
};

/**
 * Lo que hace cada botón de la decisión con el dron (VUELO §6), dicho antes de
 * apretarlo. Con la ficha del dron a mano, cuenta cómo se queda sobre el
 * objetivo según su reacción y cuánto dura el silencio al retomar; sin la ficha
 * (la alerta de un dron que ya no está, un hub viejo) queda lo de siempre.
 */
export function consecuenciasDeDecidir(drone: Pick<Drone, ClaveDeAjuste> | null | undefined): { validar: string; descartar: string } {
  const validar = fichaConAjuste(drone, 'reaccionADeteccion')
    ? `Validar: el dron se queda sobre el objetivo hasta que lo mandes a patrullar: ${AL_VALIDAR[ajusteDelDron(drone, 'reaccionADeteccion')]}.`
    : 'Validar: el dron se queda sobre el objetivo hasta que lo mandes a patrullar.';
  let descartar = 'Descartar: retoma la ruta hacia el próximo nodo.';
  if (fichaConAjuste(drone, 'silencioAlRetomarS')) {
    const silencio = ajusteDelDron(drone, 'silencioAlRetomarS');
    descartar =
      silencio > 0
        ? `Descartar: retoma la ruta hacia el próximo nodo y no se detiene por otra detección durante ${silencio} s.`
        : 'Descartar: retoma la ruta hacia el próximo nodo, sin silencio: otra detección lo puede frenar enseguida.';
  }
  return { validar, descartar };
}
