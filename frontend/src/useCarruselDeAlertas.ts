import { useMemo, useState } from 'react';
import type { Alert } from './types';

/**
 * Lo que el carrusel de alertas recuerda de una lista a la siguiente.
 *
 * La alerta que se mira se guarda por id y no por posición: la lista cambia
 * sola —llegan alertas nuevas, otro operador decide una desde su consola— y
 * con una posición, cada cambio movía al operador a otra alerta sin que él
 * tocara nada. Por id, la que tiene en pantalla es la que eligió hasta que
 * desaparece; recién ahí el carrusel elige otra, y la elige vecina.
 */
export interface EstadoCarrusel {
  /** Los ids de la última lista, de la más nueva a la más vieja. */
  ids: readonly number[];
  /** La alerta que el operador está mirando, o `null` si no queda ninguna. */
  seleccionada: number | null;
  /** Las que llegaron mientras el operador miraba otra y que todavía no abrió. */
  sinVer: readonly number[];
  /** Cuántas tandas de alertas nuevas llegaron: cada una vuelve a encender el pulso. */
  llegadas: number;
}

export function estadoInicial(ids: readonly number[]): EstadoCarrusel {
  return { ids, seleccionada: ids[0] ?? null, sinVer: [], llegadas: 0 };
}

/**
 * La alerta que queda en pantalla cuando la que se miraba ya no está: la que
 * le seguía en el orden, o la anterior si era la última. Volver a la primera
 * era hacerle perder el lugar al operador que estaba recorriendo la lista de
 * a una, que es justo cuando más decide: decidir la tercera lo devolvía arriba.
 * Si de la lista de antes no sobrevive ninguna, queda la más nueva.
 */
export function vecina(anteriores: readonly number[], actuales: readonly number[], perdida: number | null): number | null {
  const quedan = new Set(actuales);
  const i = perdida === null ? -1 : anteriores.indexOf(perdida);
  if (i >= 0) {
    const despues = anteriores.slice(i + 1).find((id) => quedan.has(id));
    if (despues !== undefined) return despues;
    const antes = anteriores.slice(0, i).reverse().find((id) => quedan.has(id));
    if (antes !== undefined) return antes;
  }
  return actuales[0] ?? null;
}

/** Lo que cambia cuando llega una lista nueva de pendientes (ordenada, la más nueva primero). */
export function actualizarLista(estado: EstadoCarrusel, ids: readonly number[]): EstadoCarrusel {
  const previas = new Set(estado.ids);
  const quedan = new Set(ids);
  // Una lista que estaba vacía no "recibe" alertas: es la primera carga, y no
  // hay ninguna otra que el operador estuviera mirando para avisarle.
  const nuevas = estado.ids.length === 0 ? [] : ids.filter((id) => !previas.has(id));
  const seleccionada =
    estado.seleccionada !== null && quedan.has(estado.seleccionada)
      ? estado.seleccionada
      : vecina(estado.ids, ids, estado.seleccionada);
  return {
    ids,
    seleccionada,
    sinVer: [...estado.sinVer.filter((id) => quedan.has(id)), ...nuevas].filter((id) => id !== seleccionada),
    llegadas: estado.llegadas + (nuevas.length > 0 ? 1 : 0),
  };
}

/** El operador eligió una alerta: queda en pantalla y deja de contar como sin ver. */
export function mirar(estado: EstadoCarrusel, id: number): EstadoCarrusel {
  if (!estado.ids.includes(id)) return estado;
  return { ...estado, seleccionada: id, sinVer: estado.sinVer.filter((otra) => otra !== id) };
}

/**
 * Un paso hacia la más nueva (-1) o hacia la más vieja (+1). En las puntas no
 * da la vuelta: la lista tiene un sentido —arriba lo último que pasó, al fondo
 * lo más viejo— y saltar del fondo a la primera hacía creer que habían llegado
 * más alertas. Las flechas se apagan en las puntas y el indicador lo dice.
 */
export function moverse(estado: EstadoCarrusel, paso: -1 | 1): EstadoCarrusel {
  const destino = estado.ids[(estado.seleccionada === null ? -1 : estado.ids.indexOf(estado.seleccionada)) + paso];
  return destino === undefined ? estado : mirar(estado, destino);
}

function mismaLista(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Carrusel de las alertas pendientes: cuál se mira, cuántas hay y cuáles
 * llegaron sin que el operador las viera. La vista del dron y el tablero lo
 * usan igual, así que lo que se decide al llegar o irse una alerta es lo mismo
 * en los dos lugares.
 */
export function useCarruselDeAlertas(alertas: readonly Alert[]) {
  // La más nueva primero: los ids crecen con cada alerta, así que ordenar por
  // id es ordenar por llegada, venga la lista en el orden que venga.
  const ordenadas = useMemo(() => [...alertas].sort((a, b) => b.id - a.id), [alertas]);
  const ids = useMemo(() => ordenadas.map((a) => a.id), [ordenadas]);
  const [guardado, setGuardado] = useState(() => estadoInicial(ids));

  // Se ajusta DURANTE el render y no en un efecto: con un efecto, el render en
  // que desaparece la alerta mirada se pintaba con otra antes de saltar a la
  // vecina, y ese parpadeo es lo que hace dudar de cuál se está decidiendo.
  let estado = guardado;
  if (!mismaLista(guardado.ids, ids)) {
    estado = actualizarLista(guardado, ids);
    setGuardado(estado);
  }

  const indice = estado.seleccionada === null ? -1 : estado.ids.indexOf(estado.seleccionada);
  const masNuevaSinVer = estado.ids.find((id) => estado.sinVer.includes(id));

  return {
    /** Las pendientes, la más nueva primero. */
    alertas: ordenadas,
    /** La que está en pantalla. */
    actual: ordenadas[indice] ?? null,
    /** Su lugar en la lista, contando desde 1 (0 sin alertas). */
    posicion: indice + 1,
    total: ordenadas.length,
    hayAnterior: indice > 0,
    haySiguiente: indice >= 0 && indice < ordenadas.length - 1,
    /** Cuántas llegaron mientras se miraba otra y todavía no se abrieron. */
    sinVer: estado.sinVer.length,
    /** Sube con cada tanda de alertas nuevas: sirve de `key` para repetir el pulso. */
    llegadas: estado.llegadas,
    anterior: () => setGuardado((e) => moverse(e, -1)),
    siguiente: () => setGuardado((e) => moverse(e, 1)),
    /** Lleva a la más nueva de las que llegaron sin que se las mirara. */
    irALaNueva: () => {
      if (masNuevaSinVer !== undefined) setGuardado((e) => mirar(e, masNuevaSinVer));
    },
  };
}
