import { createContext, useContext } from 'react';
import type { Alert, Drone, DroneStatus } from './types';
import type { DecidirAlerta } from './useDecisionDeAlerta';

/**
 * Lo que el pop-up de una alerta necesita saber de la consola en vivo.
 *
 * Una alerta se abre desde lugares que no tienen nada de esto a mano: la
 * campana no conoce la telemetría, el Registro no conoce ni los drones ni las
 * alertas, y la vista de un dron sólo conoce el suyo. Pasarlo de mano en mano
 * hasta cada uno era cablear cinco props por cinco componentes que no las
 * usan; con un contexto, la consola lo pone una vez y el pop-up lo lee.
 */
export interface AlertasEnVivo {
  /** Las alertas que la consola mantiene al día por el WebSocket. */
  alertas: readonly Alert[];
  drones: readonly Drone[];
  /** El último status de cada dron conectado, el que vuelca la consola en cada tick. */
  statuses: Readonly<Record<string, DroneStatus>>;
  /** Validar o descartar; `null` si quien mira no puede decidir alertas. */
  decidir: DecidirAlerta | null;
  /** Lleva a la vista del dron, donde está su video en vivo. */
  verDron: ((droneId: string) => void) | null;
  /** Abre el pop-up de una alerta, por encima de lo que se esté mirando. */
  abrirAlerta: ((alerta: Alert) => void) | null;
}

/**
 * Afuera de la consola (un componente montado suelto) no hay nada en vivo: el
 * pop-up trae la alerta del backend, y no ofrece ni decidir ni ir al dron,
 * porque no hay quién lo haga. Las piezas que abren alertas tampoco ofrecen
 * abrirlas: un botón que no hace nada es peor que no tenerlo.
 */
export const SIN_CONSOLA: AlertasEnVivo = {
  alertas: [],
  drones: [],
  statuses: {},
  decidir: null,
  verDron: null,
  abrirAlerta: null,
};

export const ContextoDeAlertas = createContext<AlertasEnVivo>(SIN_CONSOLA);

export function useAlertasEnVivo(): AlertasEnVivo {
  return useContext(ContextoDeAlertas);
}
