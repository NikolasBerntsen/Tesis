import { createContext, useContext } from 'react';
import type { Emergencia, FotoDeEmergencia, Relevo } from './types';

/**
 * Lo que la consola sabe en vivo de los relevos y de los aterrizajes de
 * emergencia, al alcance de quien lo necesite sin pasarlo de mano en mano: el
 * aviso de arriba, la ficha de una emergencia y el detalle de un evento del
 * Registro (que no conoce nada de la operación) lo leen de acá. Es el mismo
 * camino que el de las alertas (alertasEnVivo.ts).
 */
export interface RelevosYEmergenciasEnVivo {
  /** Los relevos activos, más los últimos terminados que vio esta consola. */
  relevos: readonly Relevo[];
  /** Las emergencias abiertas, más las recuperadas que vio esta consola. */
  emergencias: readonly Emergencia[];
  /** Las fotos que llegaron por el WebSocket, por emergencia. */
  fotos: Readonly<Record<number, readonly FotoDeEmergencia[]>>;
  /**
   * Abre la ficha de una emergencia por encima de lo que se esté mirando.
   * `devolverFoco`, como en las alertas: adónde va el foco si lo que la abrió
   * ya no está al cerrarla.
   */
  abrirEmergencia: ((id: number, devolverFoco?: () => void) => void) | null;
  /**
   * Cierra la emergencia: el equipo ya tiene el dron. Si el backend la
   * rechaza, el error sube con el motivo ya dicho para el operador. `null` si
   * quien mira no puede (fuera de la consola).
   */
  marcarRecuperada: ((id: number) => Promise<Emergencia>) | null;
}

/**
 * Fuera de la consola (un componente montado suelto) no hay nada en vivo: la
 * ficha se trae del backend y no ofrece marcarla, porque no hay quién.
 */
export const SIN_OPERACION: RelevosYEmergenciasEnVivo = {
  relevos: [],
  emergencias: [],
  fotos: {},
  abrirEmergencia: null,
  marcarRecuperada: null,
};

export const ContextoDeRelevosYEmergencias = createContext<RelevosYEmergenciasEnVivo>(SIN_OPERACION);

export function useRelevosYEmergencias(): RelevosYEmergenciasEnVivo {
  return useContext(ContextoDeRelevosYEmergencias);
}
